// Shared pricing rules for plan-all.mjs (App Store) and play-tiers.mjs (Google Play).
// No dependencies, no I/O.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// How "charm" a price looks. 2 = a preferred ending (default 99: 4.99, 699, 9,900),
// 1 = ends in 9 (0.59, 17.90, 139), 0 = anything else. With cents, only the cents count,
// so 9.90 is a 1, not a 2. `endings` are two-digit strings, for example ['99', '49'].
export function rank(value, { hasCents = true, endings = ['99'] } = {}) {
  const cents = Math.round(value * 100);
  if (hasCents && cents % 100 !== 0) {
    const c = String(cents % 100).padStart(2, '0');
    return endings.includes(c) ? 2 : c.endsWith('9') || c === '90' ? 1 : 0;
  }
  const d = String(Math.round(value)).replace(/0+$/, '');
  return endings.some((e) => d.endsWith(e)) ? 2 : d.endsWith('9') ? 1 : 0;
}

// From `values`, the one strictly inside (lo, hi): highest rank first, then nearest `target`,
// ties to the lower price. Null when none fits.
export function pickBest(values, target, { lo = -Infinity, hi = Infinity, hasCents = true, endings } = {}) {
  const xs = values.filter((v) => v > 0 && v > lo + 1e-9 && v < hi - 1e-9);
  if (!xs.length) return null;
  return xs.reduce((b, v) => {
    const rv = rank(v, { hasCents, endings }), rb = rank(b, { hasCents, endings });
    if (rv !== rb) return rv > rb ? v : b;
    const dv = Math.abs(v - target), db = Math.abs(b - target);
    return dv < db - 1e-9 || (Math.abs(dv - db) <= 1e-9 && v < b) ? v : b;
  });
}

// Every price a store could show between lo and hi, for stores with no price ladder (Play).
export function grid(lo, hi, hasCents) {
  const step = hasCents ? 0.01 : hi > 1e5 ? 100 : hi > 1e4 ? 10 : 1;
  const out = [];
  for (let n = Math.max(1, Math.ceil(lo / step - 1e-9)); n * step <= hi + 1e-9; n++) out.push(Number((n * step).toFixed(2)));
  return out;
}

// A charm price within `tolerance` of `value` on a ladder-free store, else `value` rounded.
export function charmFree(value, { hasCents, endings, tolerance = 0.12 } = {}) {
  const pick = pickBest(grid(value * (1 - tolerance), value * (1 + tolerance), hasCents), value, { hasCents, endings });
  if (pick != null && rank(pick, { hasCents, endings }) > 0) return pick;
  return hasCents ? Number(value.toFixed(2)) : Math.max(1, Math.round(value));
}

// Rules between products in one subscription group, from the config:
//   { "cheaper": "plus-monthly", "dearer": "pro-monthly" }                       plus < pro monthly
//   { "cheaper": "pro-annual", "dearer": "plus-monthly", "dearerTimes": 12 }     pro yearly < 12 x plus
// Meaning: cheaperTimes x price(cheaper) < dearerTimes x price(dearer). Times default to 1.
export function ruleHolds(rule, price) {
  const a = price(rule.cheaper), b = price(rule.dearer);
  if (a == null || b == null) return true;
  return (rule.cheaperTimes ?? 1) * a < (rule.dearerTimes ?? 1) * b - 1e-9;
}

// The open interval the `repair` product's price must sit in for every rule to hold,
// given the other products' prices.
export function repairBounds(rules, repairKey, price) {
  let lo = -Infinity, hi = Infinity;
  for (const r of rules) {
    const ca = r.cheaperTimes ?? 1, cb = r.dearerTimes ?? 1;
    if (r.cheaper === repairKey && price(r.dearer) != null) hi = Math.min(hi, (cb * price(r.dearer)) / ca);
    if (r.dearer === repairKey && price(r.cheaper) != null) lo = Math.max(lo, (ca * price(r.cheaper)) / cb);
  }
  return { lo, hi };
}

export function loadConfig(path) {
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg._dir = dirname(resolve(path));
  cfg.rules ??= [];
  cfg.endings ??= ['99'];
  return cfg;
}

// tiers.json, with one product's tier shares applied. Returns iso2 -> {tier, ratio, iso3} and back.
export function tiersFor(cfg, product) {
  const path = cfg.tiers ? resolve(cfg._dir, cfg.tiers) : join(HERE, '..', 'assets', 'tiers.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const ratioOf = Object.fromEntries(doc.tiers.map((t) => [t.tier, product.ratios?.[t.tier] ?? t.ratio]));
  const byIso2 = new Map(), iso3to2 = new Map();
  for (const t of doc.tiers) {
    for (const c of t.countries) {
      byIso2.set(c.iso2, { tier: t.tier, ratio: ratioOf[t.tier], iso3: c.iso3 });
      iso3to2.set(c.iso3, c.iso2);
    }
  }
  for (const [iso2, tier] of Object.entries(cfg.overrides ?? {})) {
    const prev = byIso2.get(iso2) ?? { iso3: null };
    byIso2.set(iso2, { ...prev, tier: Number(tier), ratio: ratioOf[tier] });
  }
  return { byIso2, iso3to2, ratioOf, version: doc.version };
}
