#!/usr/bin/env node
// Plan every App Store product in a pricing config at once, then repair rule breaks.
//
//   node plan-all.mjs --config pricing.config.json [--concurrency 2]
//
// For each product in `appStore.products` it runs `iap-tiers.mjs plan` with that product's
// tier shares (`products.<key>.ratios`), pins (`products.<key>.pins`, ISO2 codes) and the
// config's rounding. Then, territory by territory, it checks `rules` (for example Plus below
// Pro monthly, 12 x Plus above Pro yearly) and moves the `repair` product to the best price
// on its own ladder that satisfies every rule. Rounding to charm prices breaks such rules in
// a few dozen territories; this is the step that used to be done by hand.
//
// Writes each product's plan.{json,md} and prices.csv as `iap-tiers.mjs plan` does, plus
// <out>/summary.md with every product side by side. Exit 2 if a rule still fails.
// Apply each product afterwards with `iap-tiers.mjs apply --plan <out>/<key>/plan.json --yes`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, tiersFor, ruleHolds, repairBounds, pickBest } from './pricing-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const die = (m) => { console.error(`plan-all: ${m}`); process.exit(1); };

const cfgPath = flag('--config') ?? die('usage: plan-all.mjs --config pricing.config.json');
const cfg = loadConfig(cfgPath);
const store = cfg.appStore ?? die('config has no "appStore" section');
const out = resolve(cfg._dir, store.out ?? 'iap-pricing');
mkdirSync(out, { recursive: true });

const keys = Object.keys(store.products);
for (const key of keys) {
  const sp = store.products[key];
  const product = cfg.products[key] ?? die(`products.${key} missing`);
  const tiers = tiersFor(cfg, product);
  const args = [join(HERE, 'iap-tiers.mjs'), 'plan', '--kind', sp.kind ?? 'subscription', '--product', String(sp.id),
    '--out', join(out, key), '--concurrency', flag('--concurrency') ?? '2', '--rounding', cfg.rounding ?? 'charm',
    '--charm-endings', cfg.endings.join(',')];
  if (store.app) args.push('--app', String(store.app));
  if (cfg.tiers) args.push('--tiers', resolve(cfg._dir, cfg.tiers));
  const ratios = Object.entries(product.ratios ?? {}).map(([t, r]) => `${t}=${r}`).join(',');
  if (ratios) args.push('--ratios', ratios);
  const pins = Object.fromEntries(Object.entries(product.pins ?? {}).map(([iso2, v]) => [tiers.byIso2.get(iso2)?.iso3 ?? iso2, v]));
  if (Object.keys(pins).length) {
    const pinFile = join(out, `${key}.pins.json`);
    writeFileSync(pinFile, JSON.stringify(pins, null, 1) + '\n');
    args.push('--pins', pinFile);
  }
  console.log(`plan ${key} (${sp.id})`);
  execFileSync('node', args, { stdio: 'inherit' });
}

const plans = Object.fromEntries(keys.map((k) => [k, JSON.parse(readFileSync(join(out, k, 'plan.json'), 'utf8'))]));
const rowOf = (k, t) => plans[k].rows.find((r) => r.territory === t);
const territories = plans[keys[0]].rows.map((r) => r.territory);
const repairKey = cfg.repair;
const repaired = [];

for (const t of territories) {
  const price = (k) => (plans[k] ? rowOf(k, t)?.chosen ?? null : null);
  if (cfg.rules.every((r) => ruleHolds(r, price))) continue;
  if (!repairKey || !plans[repairKey]) continue;
  const row = rowOf(repairKey, t);
  if (!row || row.note === 'pinned' || t === 'USA') continue;
  const { lo, hi } = repairBounds(cfg.rules, repairKey, price);
  const ladderFile = join(out, repairKey, 'cache', `ladder-${t}.json`);
  if (!existsSync(ladderFile)) continue;
  const ladder = JSON.parse(readFileSync(ladderFile, 'utf8'));
  const pick = pickBest(ladder.map((p) => p.price), row.target, { lo, hi, endings: cfg.endings });
  if (pick == null) continue;
  const point = ladder.find((p) => p.price === pick);
  repaired.push(`${t}: ${row.chosen} -> ${pick}`);
  Object.assign(row, { chosen: pick, pointId: point.id, mode: 'manual', note: 'repaired', effective: Math.round((pick / row.anchor) * 100) / 100 });
}

if (repaired.length) {
  const doc = plans[repairKey];
  doc.counts.manual = doc.rows.filter((r) => r.mode === 'manual').length;
  doc.counts.automatic = doc.rows.filter((r) => r.mode === 'automatic').length;
  doc.repaired = repaired;
  writeFileSync(join(out, repairKey, 'plan.json'), JSON.stringify(doc, null, 2) + '\n');
  if (doc.kind === 'subscription') {
    const csv = ['territory,price,price_point_id,preserve_current_price']
      .concat(doc.rows.filter((r) => r.mode === 'manual').map((r) => `${r.territory},${r.chosen},${r.pointId},true`));
    writeFileSync(join(out, repairKey, 'prices.csv'), csv.join('\n') + '\n');
  }
  const md = join(out, repairKey, 'plan.md');
  writeFileSync(md, readFileSync(md, 'utf8') + `\n## Repaired by plan-all (${repaired.length})\n\nMoved so every rule in the config holds:\n\n${repaired.map((x) => `- ${x}`).join('\n')}\n`);
}

const failing = territories.filter((t) => !cfg.rules.every((r) => ruleHolds(r, (k) => rowOf(k, t)?.chosen ?? null)));
const head = `| Territory | Currency | Tier | ${keys.map((k) => `${k} now -> new`).join(' | ')} | Rules |\n|${'---|'.repeat(keys.length + 4)}\n`;
const lines = territories.map((t) => {
  const first = rowOf(keys[0], t);
  const cells = keys.map((k) => { const r = rowOf(k, t); return r ? `${r.current ?? ''} -> ${r.chosen}${r.note === 'repaired' ? ' (repaired)' : ''}` : ''; });
  return `| ${t} | ${first?.currency ?? ''} | ${first?.tier ?? ''} | ${cells.join(' | ')} | ${failing.includes(t) ? 'FAIL' : 'ok'} |`;
});
writeFileSync(join(out, 'summary.md'), `# App Store pricing summary\n\nRules: ${cfg.rules.map((r) => `${r.cheaperTimes ?? 1}x ${r.cheaper} < ${r.dearerTimes ?? 1}x ${r.dearer}`).join('; ') || 'none'}. Repaired: ${repaired.length}. Failing: ${failing.length}.\n\n${head}${lines.join('\n')}\n`);
console.log(`plan-all: ${keys.length} products, ${repaired.length} repaired, ${failing.length} failing -> ${out}/summary.md`);
if (failing.length) { console.log(`still failing: ${failing.join(', ')}`); process.exitCode = 2; }
