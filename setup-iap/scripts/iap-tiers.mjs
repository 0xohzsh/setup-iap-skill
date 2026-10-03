#!/usr/bin/env node
// Tiered regional pricing for App Store in-app purchases and subscriptions.
// Node 18+, no dependencies. Talks to App Store Connect through the `asc` CLI.
//
//   estimate  --price 4.99 [--out DIR]                          offline USD estimate per country
//   plan      --kind iap|subscription --product ID [--app ID]   exact local prices, dry run (md + json)
//   apply     --plan DIR/plan.json [--start-date YYYY-MM-DD] --yes
//   verify    --plan DIR/plan.json
//
// Common flags: --tiers PATH (default ../assets/tiers.json), --overrides PATH ({"LUX": 1}),
// --concurrency N (default 4), --cache DIR (default <out>/cache).
// Plan flags: --rounding charm|closest (default charm: prefer prices ending in 99 / .99),
// --ratios 4=0.4,5=0.4 (change a tier's share for this run), --pins PATH ({"NZL": 8.99}: exact
// price for a territory, written as manual even in Tier 1).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const CURRENCIES = (() => {
  try { return JSON.parse(readFileSync(join(HERE, '..', 'assets', 'territory-currencies.json'), 'utf8')).currencies; } catch { return {}; }
})();

const die = (msg) => { console.error(`iap-tiers: ${msg}`); process.exit(1); };
const money = (n) => Math.round(n * 100) / 100;

function loadTiers(path, overridesPath, ratiosArg) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (ratiosArg) {
    // "4=0.4,5=0.25": a per-run share for a tier, so one product can price differently from another.
    for (const pair of String(ratiosArg).split(',')) {
      const [tier, ratio] = pair.split('=').map((x) => x.trim());
      const t = data.tiers.find((x) => String(x.tier) === tier);
      const r = Number(ratio);
      if (!t || !(r > 0 && r <= 1)) die(`--ratios: bad entry "${pair}" (want TIER=SHARE, share in (0, 1])`);
      t.ratio = r;
    }
  }
  const byIso3 = new Map();
  for (const t of data.tiers) {
    for (const c of t.countries) byIso3.set(c.iso3, { tier: t.tier, ratio: t.ratio, name: c.name, iso2: c.iso2 });
  }
  const ratioOf = Object.fromEntries(data.tiers.map((t) => [t.tier, t.ratio]));
  if (overridesPath) {
    for (const [iso3, tier] of Object.entries(JSON.parse(readFileSync(overridesPath, 'utf8')))) {
      if (!ratioOf[tier]) die(`override ${iso3}: unknown tier ${tier}`);
      const prev = byIso3.get(iso3) ?? { name: iso3, iso2: '' };
      byIso3.set(iso3, { ...prev, tier: Number(tier), ratio: ratioOf[tier], overridden: true });
    }
  }
  return { version: data.version, source: data.source, byIso3 };
}

async function asc(args, { retries = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const env = { ...process.env, ASC_TIMEOUT: process.env.ASC_TIMEOUT ?? '120s' };
      const { stdout } = await run('asc', [...args, '--output', 'json'], { maxBuffer: 256 * 1024 * 1024, env });
      return JSON.parse(stdout);
    } catch (err) {
      if (attempt >= retries) throw new Error(`asc ${args.join(' ')} failed: ${(err.stderr || err.message).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt)); // App Store Connect often times out under load
    }
  }
}

// Price point IDs are base64url JSON like {"s":"<product>","t":"FRA","p":"10049"}.
function decodePoint(id) {
  try { return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { return {}; }
}

function kindArgs(kind, product, app) {
  // --app is only needed to resolve a product ID or name. With a numeric App Store Connect ID,
  // passing it makes asc resolve every price point first, which can time out.
  const appArgs = app && !/^\d+$/.test(String(product)) ? ['--app', app] : [];
  if (kind === 'iap') {
    return {
      view: ['iap', 'view', '--id', product],
      ladder: (t) => ['iap', 'pricing', 'price-points', 'list', '--iap-id', product, '--territory', t, '--paginate', ...appArgs],
      equalize: (pt) => ['iap', 'pricing', 'price-points', 'equalizations', '--id', pt, '--limit', '8000'],
    };
  }
  if (kind === 'subscription') {
    return {
      view: ['subscriptions', 'view', '--id', product],
      ladder: (t) => ['subscriptions', 'pricing', 'price-points', 'list', '--subscription-id', product, '--territory', t, '--paginate', ...appArgs],
      equalize: (pt) => ['subscriptions', 'pricing', 'price-points', 'equalizations', '--price-point-id', pt, '--limit', '8000'],
    };
  }
  die('--kind must be iap or subscription (consumables, non-consumables and non-renewing subscriptions are all "iap")');
}

async function ladderFor(k, territory, cacheDir) {
  const file = join(cacheDir, `ladder-${territory}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await asc(k.ladder(territory));
  const points = (res.data ?? []).map((p) => ({ id: p.id, price: Number(p.attributes.customerPrice) }));
  writeFileSync(file, JSON.stringify(points));
  return points;
}

// 2 = a 99 ending (4.99, 699, 99000), 1 = a 9 ending (17.90, 59, 4900), 0 = anything else (12.49).
// With cents, only the cents count, so 9.90 is a 9 ending, not 99.
export function charmRank(price) {
  const cents = Math.round(price * 100);
  if (cents % 100 !== 0) {
    const c = cents % 100;
    return c === 99 ? 2 : c === 90 ? 1 : 0;
  }
  const d = String(cents / 100).replace(/0+$/, '');
  return d.endsWith('99') ? 2 : d.endsWith('9') ? 1 : 0;
}

function closest(points, target) {
  return points.reduce((best, p) => {
    const d = Math.abs(p.price - target), bd = Math.abs(best.price - target);
    return d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && p.price < best.price) ? p : best;
  });
}

// A point above zero and not above the anchor. rounding 'closest': the point nearest the target.
// rounding 'charm' (default): the nearest point ending in 99, else in 9, within `tolerance` of the
// target (a share of it, default 0.2); if neither exists that close, the nearest point. Ties go lower.
export function choosePoint(points, target, anchor, { rounding = 'charm', tolerance = 0.2 } = {}) {
  const candidates = points.filter((p) => p.price > 0 && p.price <= anchor + 1e-9);
  if (!candidates.length) return null;
  if (rounding === 'charm') {
    const near = candidates.filter((p) => Math.abs(p.price - target) <= target * tolerance + 1e-9);
    for (const rank of [2, 1]) {
      const hits = near.filter((p) => charmRank(p.price) === rank);
      if (hits.length) return closest(hits, target);
    }
  }
  return closest(candidates, target);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

function table(rows, cols) {
  const head = `| ${cols.map((c) => c[0]).join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
  return head + rows.map((r) => `| ${cols.map((c) => c[1](r)).join(' | ')} |`).join('\n') + '\n';
}

async function estimate(a, tiers) {
  const price = Number(a.price);
  if (!(price > 0)) die('estimate needs --price (the US price, for example 4.99)');
  const rows = [...tiers.byIso3.entries()].map(([iso3, t]) => ({ iso3, iso2: t.iso2, name: t.name, tier: t.tier, ratio: t.ratio, usdTarget: money(price * t.ratio) }))
    .sort((x, y) => x.tier - y.tier || x.iso3.localeCompare(y.iso3));
  const out = resolve(a.out ?? 'iap-pricing');
  mkdirSync(out, { recursive: true });
  const doc = { mode: 'estimate', basePriceUSD: price, tiersVersion: tiers.version, note: 'USD equivalents only. Local prices, currencies and taxes come from App Store Connect in plan mode.', rows };
  writeFileSync(join(out, 'estimate.json'), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(out, 'estimate.md'), `# Tiered price estimate (US $${price})\n\n${doc.note}\n\n` +
    table(rows, [['ISO3', (r) => r.iso3], ['Country', (r) => r.name], ['Tier', (r) => r.tier], ['Pays', (r) => `${Math.round(r.ratio * 100)}%`], ['USD target', (r) => r.usdTarget.toFixed(2)]]));
  console.log(`estimate: ${rows.length} countries -> ${out}/estimate.{md,json}`);
}

async function plan(a, tiers) {
  const kind = a.kind, product = a.product;
  if (!product) die('plan needs --product (App Store Connect ID, product ID or exact name)');
  const k = kindArgs(kind, product, a.app);
  const out = resolve(a.out ?? join('iap-pricing', String(product).replace(/[^\w.-]/g, '_')));
  const cacheDir = resolve(a.cache ?? join(out, 'cache'));
  mkdirSync(cacheDir, { recursive: true });

  // Product identity (a light call; pricing summaries are slow and can time out).
  if (!/^\d+$/.test(String(product))) die('--product must be the numeric App Store Connect ID (see `asc iap list` or `asc subscriptions list`)');
  const view = (await asc(k.view)).data ?? {};
  const item = { id: view.id ?? product, productId: view.attributes?.productId, name: view.attributes?.name };

  // Current live price and currency per territory (also the read-back used by verify).
  const live = await readLive(kind, item.id, a.app);
  if (kind === 'iap') {
    const base = await asc(['iap', 'pricing', 'schedules', 'base-territory', '--schedule-id', item.id]).catch(() => null);
    const baseId = base?.data?.id;
    if (baseId && baseId !== 'USA') die(`${item.productId} uses base territory ${baseId}; this workflow anchors on USA. Change the base first or adapt the anchor.`);
  }
  const usaLadderForBase = await ladderFor(k, 'USA', cacheDir);
  const current = live.get('USA') ? priceAt(usaLadderForBase, live.get('USA').p) : null;
  const base = a['base-price'] ? Number(a['base-price']) : current;
  if (!(base > 0)) die('no current US price found; set the US price in App Store Connect first');
  if (current && Math.abs(base - current) > 1e-9) die(`--base-price ${base} differs from the current US price ${current}. Set the US price first, then run the tiers (a base change re-equalizes every territory).`);

  const usa = await ladderFor(k, 'USA', cacheDir);
  const usaPoint = usa.find((p) => Math.abs(p.price - base) < 1e-9);
  if (!usaPoint) die(`no USA price point equals ${base}`);

  const eq = await asc(k.equalize(usaPoint.id));
  const anchors = new Map([['USA', { price: base, id: usaPoint.id }]]);
  for (const p of eq.data ?? []) {
    const t = decodePoint(p.id).t;
    if (t) anchors.set(t, { price: Number(p.attributes.customerPrice), id: p.id });
  }

  const rounding = a.rounding ?? 'charm';
  if (!['charm', 'closest'].includes(rounding)) die('--rounding must be charm or closest');
  const tolerance = a['charm-tolerance'] ? Number(a['charm-tolerance']) : 0.2;
  const pins = a.pins ? JSON.parse(readFileSync(a.pins, 'utf8')) : {};
  const territories = [...anchors.keys()].sort();
  const untiered = [];
  const rows = await pool(territories, Number(a.concurrency ?? 4), async (t) => {
    const anchor = anchors.get(t);
    const info = tiers.byIso3.get(t);
    if (!info) untiered.push(t);
    const tier = t === 'USA' ? 1 : info?.tier ?? 1;
    const ratio = t === 'USA' ? 1 : info?.ratio ?? 1;
    const now = live.get(t);
    const ladder = await ladderFor(k, t, cacheDir);
    const current = now ? priceAt(ladder, now.p) : anchor.price;
    const row = { territory: t, name: info?.name ?? t, currency: CURRENCIES[t] ?? null, current, tier, ratio, overridden: !!info?.overridden, anchor: anchor.price, target: money(anchor.price * ratio) };
    if (t !== 'USA' && pins[t] != null) {
      // An explicit price wins over the tier, even in Tier 1. Exact point if the ladder has it.
      const pinned = closest(ladder.filter((p) => p.price > 0), Number(pins[t]));
      return { ...row, target: Number(pins[t]), chosen: pinned.price, pointId: pinned.id, mode: 'manual', note: 'pinned', effective: money(pinned.price / anchor.price) };
    }
    if (tier === 1) return { ...row, chosen: anchor.price, pointId: anchor.id, mode: t === 'USA' ? 'base' : 'automatic' };
    const pick = choosePoint(ladder, anchor.price * ratio, anchor.price, { rounding, tolerance });
    if (!pick) return { ...row, chosen: anchor.price, pointId: anchor.id, mode: 'automatic', note: 'no paid price point at or below the anchor' };
    return { ...row, chosen: pick.price, pointId: pick.id, mode: 'manual', effective: money(pick.price / anchor.price) };
  });

  const notInStore = [...tiers.byIso3.keys()].filter((t) => !anchors.has(t)).sort();
  const doc = {
    mode: 'plan', kind, product: item.productId ?? product, productRef: item.id ?? product, name: item.name, app: a.app ?? null,
    basePriceUSD: base, tiersVersion: tiers.version, rounding, ratios: a.ratios ?? null, pins, generatedAt: new Date().toISOString(),
    counts: { territories: rows.length, manual: rows.filter((r) => r.mode === 'manual').length, automatic: rows.filter((r) => r.mode === 'automatic').length },
    untiered: untiered.sort(), notInStore, rows,
  };
  writeFileSync(join(out, 'plan.json'), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(out, 'plan.md'),
    `# ${doc.name ?? doc.product} (${kind}) tiered prices\n\nUS base $${base}. ${doc.counts.manual} discounted territories, ${doc.counts.automatic} at Apple's equalized price. Prices are in each territory's local currency. Rounding: ${rounding}${a.ratios ? `. Tier shares changed: ${a.ratios}` : ''}.\n\n` +
    (doc.untiered.length ? `Not in the tier list (kept at full price): ${doc.untiered.join(', ')}\n\n` : '') +
    table(rows, [['Territory', (r) => r.territory], ['Name', (r) => r.name], ['Currency', (r) => r.currency ?? ''], ['Tier', (r) => r.tier + (r.overridden ? '*' : '')], ['Current', (r) => r.current ?? ''], ['Anchor', (r) => r.anchor], ['Target', (r) => r.target], ['New', (r) => r.chosen], ['Mode', (r) => r.mode + (r.note ? ` (${r.note})` : '')]]) +
    `\n${notInStore.length} tier-list countries have no App Store storefront and were skipped: ${notInStore.join(', ')}\n`);
  if (kind === 'subscription') {
    const csv = ['territory,price,price_point_id,preserve_current_price']
      .concat(rows.filter((r) => r.mode === 'manual').map((r) => `${r.territory},${r.chosen},${r.pointId},true`));
    writeFileSync(join(out, 'prices.csv'), csv.join('\n') + '\n');
  }
  console.log(`plan: ${rows.length} territories (${doc.counts.manual} manual) -> ${out}/plan.{md,json}`);
}

function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return d.toISOString().slice(0, 10);
}

async function apply(a) {
  if (!a.plan) die('apply needs --plan PATH/plan.json');
  const doc = JSON.parse(readFileSync(a.plan, 'utf8'));
  const manual = doc.rows.filter((r) => r.mode === 'manual');
  const base = doc.rows.find((r) => r.territory === 'USA');
  const appArgs = doc.app ? ['--app', doc.app] : [];
  let steps;
  if (doc.kind === 'iap') {
    // One schedule replaces the previous one: USA plus every discounted territory. Tier 1 stays automatic.
    const date = a['start-date'];
    const prices = [base, ...manual].map((r) => (date ? `${r.pointId}:${date}` : r.pointId)).join(',');
    steps = [['iap', 'pricing', 'schedules', 'create', '--iap-id', doc.productRef, '--base-territory', 'USA', '--prices', prices, ...appArgs]];
  } else {
    const csv = join(dirname(a.plan), 'prices.csv');
    const date = a['start-date'] ?? tomorrow();
    const common = ['subscriptions', 'pricing', 'prices', 'import', '--subscription-id', doc.productRef, '--input', csv, '--start-date', date, '--preserved', ...appArgs];
    steps = [[...common, '--dry-run'], common];
  }
  if (!a.yes) {
    console.log('Dry run. These commands would run (re-run with --yes):');
    for (const s of steps) console.log(`  asc ${s.map((x) => (x.length > 80 ? x.slice(0, 77) + '...' : x)).join(' ')}`);
    return;
  }
  for (const s of steps) {
    const res = await asc(s, { retries: 1 });
    console.log(JSON.stringify(res).slice(0, 600));
  }
  console.log(`apply: wrote ${manual.length} discounted territories for ${doc.product}. Run verify next.`);
}

// Live price per territory: Map(territory -> { p, manual }). Reads the raw schedule and decodes the
// price index; asc's --resolved mode maps indices to prices across the wrong territory, so the price
// itself is looked up later in that territory's own ladder.
async function readLive(kind, id, app) {
  const appArgs = app ? ['--app', app] : [];
  const res = kind === 'iap'
    ? await asc(['iap', 'pricing', 'schedules', 'manual-prices', '--schedule-id', id, '--paginate'])
    : await asc(['subscriptions', 'pricing', 'prices', 'list', '--subscription-id', id, '--resolved', '--paginate', ...appArgs]);
  const live = new Map();
  if (kind === 'iap') {
    for (const row of res.data ?? []) {
      const d = decodePoint(row.id);
      if (d.t) live.set(d.t, { p: d.p, manual: true });
    }
  } else {
    // Resolved rows carry the full price-point ID (correct); their customerPrice is not trusted.
    for (const row of res.prices ?? []) {
      const d = decodePoint(row.pricePointId ?? '');
      if (row.territory && d.p) live.set(row.territory, { p: d.p, manual: true });
    }
  }
  return live;
}

function priceAt(ladder, p) {
  const hit = ladder.find((x) => decodePoint(x.id).p === p);
  return hit ? hit.price : null;
}

async function verify(a) {
  if (!a.plan) die('verify needs --plan PATH/plan.json');
  const doc = JSON.parse(readFileSync(a.plan, 'utf8'));
  const live = await readLive(doc.kind, doc.productRef, doc.app);
  // Compare price indices: the planned point ID carries the same index as the live price.
  const bad = doc.rows.filter((r) => r.mode === 'manual' && live.get(r.territory)?.p !== decodePoint(r.pointId).p)
    .map((r) => `${r.territory}: planned ${r.chosen} (index ${decodePoint(r.pointId).p}), live index ${live.get(r.territory)?.p ?? 'missing'}`);
  console.log(bad.length ? `verify: ${bad.length} mismatches\n${bad.join('\n')}` : `verify: all ${doc.counts.manual} discounted territories match`);
  if (bad.length && doc.kind === 'subscription') console.log('Subscription prices with a future start date show here only after that date.');
  process.exitCode = bad.length ? 2 : 0;
}

// realpath on both sides: the skill folder is often a symlink.
const real = (f) => { try { return realpathSync(f); } catch { return resolve(f); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
const a = parseArgs(isMain ? process.argv.slice(2) : ['--noop']);
const cmd = isMain ? a._[0] : null;
const tiers = loadTiers(a.tiers ?? join(HERE, '..', 'assets', 'tiers.json'), a.overrides, a.ratios);
const cmds = { estimate: () => estimate(a, tiers), plan: () => plan(a, tiers), apply: () => apply(a), verify: () => verify(a) };
if (isMain) {
  if (!cmds[cmd]) die('usage: iap-tiers.mjs <estimate|plan|apply|verify> [flags]  (see SKILL.md)');
  cmds[cmd]().catch((e) => die(e.message));
}
