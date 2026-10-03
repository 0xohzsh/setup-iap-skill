#!/usr/bin/env node
// Tiered regional subscription prices for Google Play, from the same pricing config as plan-all.mjs.
//
//   node play-tiers.mjs plan   --config pricing.config.json     dry run: <out>/play-plan.{json,md}
//   node play-tiers.mjs apply  --config pricing.config.json --yes   write the plan to Play
//   node play-tiers.mjs verify --config pricing.config.json     read Play back, compare to the plan
//
// Play has no price ladder. For each tier the script asks Google to convert that tier's share
// of the USD price (`pricing:convertRegionPrices`, which applies local price patterns), snaps
// the result to a charm price, applies pins, keeps Tier 1 at what Play charges today, then
// repairs rule breaks on the config's `repair` product, exactly as plan-all.mjs does.
//
// apply reads each subscription live, changes only regionalConfigs[].price, and PATCHes the
// base plans with the regions version Google used for the conversion (an older version rejects
// currencies Google has since changed, for example Argentina USD -> ARS in 2026/01). Existing
// subscribers keep their price: Play moves them only through a separate price migration.
//
// Config: "play": { "package": "...", "serviceAccount": "path/to/key.json", "out": "dir",
//   "products": { "<key>": { "productId": "pro", "basePlanId": "monthly" } } }

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, tiersFor, ruleHolds, repairBounds, pickBest, grid, charmFree } from './pricing-lib.mjs';

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const die = (m) => { console.error(`play-tiers: ${m}`); process.exit(1); };

const cfgPath = flag('--config') ?? die('usage: play-tiers.mjs <plan|apply|verify> --config pricing.config.json [--yes]');
const cfg = loadConfig(cfgPath);
const play = cfg.play ?? die('config has no "play" section');
const out = resolve(cfg._dir, play.out ?? 'iap-pricing');
mkdirSync(out, { recursive: true });
const planFile = join(out, 'play-plan.json');

async function token() {
  const key = JSON.parse(readFileSync(resolve(cfg._dir, play.serviceAccount), 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), key.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const body = await res.json();
  if (!body.access_token) die(`Play auth failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.access_token;
}

async function api(tok, method, suffix, body) {
  const res = await fetch(`${BASE}/${play.package}${suffix}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) die(`Play ${res.status} ${method} ${suffix}\n${text.slice(0, 500)}`);
  return text.trim() ? JSON.parse(text) : {};
}

const num = (p) => Number(p.units ?? 0) + Number(p.nanos ?? 0) / 1e9;
const money = (currencyCode, v) => {
  const units = Math.floor(v + 1e-9);
  return { currencyCode, units: String(units), nanos: Math.round((v - units) * 1e9) };
};

async function convert(tok, usd) {
  const body = await api(tok, 'POST', '/pricing:convertRegionPrices', { price: money('USD', usd) });
  return { prices: body.convertedRegionPrices ?? {}, version: body.regionVersion?.version };
}

async function livePrices(tok) {
  const live = {};
  for (const [key, p] of Object.entries(play.products)) {
    const sub = await api(tok, 'GET', `/subscriptions/${p.productId}`);
    const bp = (sub.basePlans ?? []).find((b) => b.basePlanId === p.basePlanId) ?? die(`${p.productId}/${p.basePlanId} not found on Play`);
    live[key] = Object.fromEntries((bp.regionalConfigs ?? []).map((r) => [r.regionCode, { currency: r.price.currencyCode, amount: num(r.price) }]));
  }
  return live;
}

async function plan() {
  const tok = await token();
  const live = await livePrices(tok);
  const conv = {};
  let version;
  for (const key of Object.keys(play.products)) {
    const product = cfg.products[key] ?? die(`products.${key} missing`);
    const tiers = tiersFor(cfg, product);
    conv[key] = { full: await convert(tok, product.usd) };
    for (const tier of [2, 3, 4, 5]) conv[key][tier] = await convert(tok, product.usd * tiers.ratioOf[tier]);
    version = conv[key].full.version;
  }
  // A region uses cents if any conversion for it does, so every product agrees.
  const cents = new Set();
  for (const byTier of Object.values(conv)) for (const c of Object.values(byTier)) for (const [r, v] of Object.entries(c.prices)) if (Number(v.price.nanos ?? 0) !== 0) cents.add(r);

  const rows = {};
  for (const key of Object.keys(play.products)) {
    const product = cfg.products[key];
    const tiers = tiersFor(cfg, product);
    rows[key] = {};
    for (const [region, full] of Object.entries(conv[key].full.prices)) {
      const tier = region === 'US' ? 1 : tiers.byIso2.get(region)?.tier ?? 1;
      const src = tier === 1 ? full : conv[key][tier].prices[region] ?? full;
      const currency = src.price.currencyCode;
      const target = num(src.price);
      const hasCents = cents.has(region);
      const now = live[key][region];
      let amount, note = '';
      if (product.pins?.[region] != null) { amount = Number(product.pins[region]); note = 'pinned'; }
      else if (region === 'US') amount = product.usd;
      else if (tier === 1) amount = now && now.currency === currency ? now.amount : target; // Tier 1 keeps today's price
      else amount = charmFree(target, { hasCents, endings: cfg.endings });
      rows[key][region] = { currency, tier, target, hasCents, current: now?.currency === currency ? now.amount : null, amount: Number(amount.toFixed(2)), note };
    }
  }

  const regions = Object.keys(rows[Object.keys(rows)[0]]);
  const price = (region) => (k) => rows[k]?.[region]?.amount ?? null;
  const repaired = [];
  for (const region of regions) {
    if (cfg.rules.every((r) => ruleHolds(r, price(region)))) continue;
    const row = cfg.repair && rows[cfg.repair]?.[region];
    if (!row || row.tier === 1 || row.note === 'pinned') continue;
    const { lo, hi } = repairBounds(cfg.rules, cfg.repair, price(region));
    if (!(hi > lo)) continue;
    const pick = pickBest(grid(Math.max(lo, 0), hi, row.hasCents), row.target, { lo, hi, hasCents: row.hasCents, endings: cfg.endings });
    if (pick == null) continue;
    repaired.push(`${region}: ${row.amount} -> ${pick}`);
    Object.assign(row, { amount: pick, note: 'repaired' });
  }
  const failing = regions.filter((region) => !cfg.rules.every((r) => ruleHolds(r, price(region))));

  writeFileSync(planFile, JSON.stringify({ regionsVersion: version, generatedAt: new Date().toISOString(), repaired, failing, rows }, null, 2) + '\n');
  const keys = Object.keys(rows);
  const md = `# Google Play pricing plan\n\nRegions version ${version}. ${regions.length} regions. Repaired ${repaired.length}. Failing ${failing.length}.\n\n` +
    `| Region | Currency | Tier | ${keys.map((k) => `${k} now -> new`).join(' | ')} |\n|${'---|'.repeat(keys.length + 3)}\n` +
    regions.sort().map((r) => `| ${r} | ${rows[keys[0]][r].currency} | ${rows[keys[0]][r].tier} | ${keys.map((k) => `${rows[k][r].current ?? ''} -> ${rows[k][r].amount}${rows[k][r].note ? ` (${rows[k][r].note})` : ''}`).join(' | ')} |`).join('\n') + '\n';
  writeFileSync(join(out, 'play-plan.md'), md);
  console.log(`play plan: ${regions.length} regions, ${repaired.length} repaired, ${failing.length} failing, regions version ${version} -> ${out}/play-plan.{md,json}`);
  if (failing.length) { console.log(`still failing: ${failing.join(', ')}`); process.exitCode = 2; }
}

async function apply() {
  const doc = JSON.parse(readFileSync(planFile, 'utf8'));
  if (doc.failing?.length) die(`plan has failing regions (${doc.failing.join(', ')}); fix the config and re-plan`);
  const byProduct = {};
  for (const [key, p] of Object.entries(play.products)) (byProduct[p.productId] ??= []).push([key, p.basePlanId]);
  if (!argv.includes('--yes')) {
    for (const [productId, plans] of Object.entries(byProduct)) console.log(`would PATCH ${productId} base plans ${plans.map((x) => x[1]).join(', ')} (${Object.keys(doc.rows[plans[0][0]]).length} regions each, regions version ${doc.regionsVersion})`);
    console.log('Dry run. Re-run with --yes to write.');
    return;
  }
  const tok = await token();
  for (const [productId, plans] of Object.entries(byProduct)) {
    const sub = await api(tok, 'GET', `/subscriptions/${productId}`);
    for (const [key, basePlanId] of plans) {
      const bp = sub.basePlans.find((b) => b.basePlanId === basePlanId);
      const existing = new Map((bp.regionalConfigs ?? []).map((r) => [r.regionCode, r]));
      bp.regionalConfigs = Object.entries(doc.rows[key]).sort().map(([region, row]) => ({
        regionCode: region,
        newSubscriberAvailability: existing.get(region)?.newSubscriberAvailability ?? true,
        price: money(row.currency, row.amount),
      }));
    }
    const q = `updateMask=basePlans&regionsVersion.version=${encodeURIComponent(doc.regionsVersion)}`;
    await api(tok, 'PATCH', `/subscriptions/${productId}?${q}`, sub);
    console.log(`play apply: ${productId} updated (${plans.map((x) => x[1]).join(', ')})`);
  }
  console.log('Run verify next.');
}

async function verify() {
  const doc = JSON.parse(readFileSync(planFile, 'utf8'));
  const live = await livePrices(await token());
  const bad = [];
  for (const [key, rows] of Object.entries(doc.rows)) {
    for (const [region, row] of Object.entries(rows)) {
      const l = live[key][region];
      if (!l || l.currency !== row.currency || Math.abs(l.amount - row.amount) > 0.005) bad.push(`${key} ${region}: planned ${row.amount} ${row.currency}, live ${l ? `${l.amount} ${l.currency}` : 'missing'}`);
    }
  }
  console.log(bad.length ? `play verify: ${bad.length} mismatches\n${bad.join('\n')}` : 'play verify: every planned price is live');
  process.exitCode = bad.length ? 2 : 0;
}

const cmds = { plan, apply, verify };
if (!cmds[cmd]) die('usage: play-tiers.mjs <plan|apply|verify> --config pricing.config.json [--yes]');
await cmds[cmd]();
