---
name: setup-iap
description: Plans and applies tiered regional (purchasing-power) pricing for App Store in-app purchases (auto-renewable subscriptions, consumables, non-consumables, non-renewing subscriptions) and Google Play subscriptions, for any app. Produces per-country price tables (Markdown + JSON) or writes the prices to App Store Connect (asc CLI) and Google Play (Play Developer API), then verifies them. A per-app pricing config makes later runs one command per store. Use when the user runs /setup-iap or asks for regional, country, PPP or tiered pricing of subscriptions, one-time purchases, consumables or non-consumables.
---

# Setup IAP tiered pricing

Every country sits in one of five tiers (`assets/tiers.json`, from activationpal.com/country-pricing). A tier pays a fixed share of Apple's equalized local price for the US base price: 100%, 80%, 60%, 40% or 25%. The US price never changes.

All mechanics are Node 18+ scripts with no dependencies:
- `scripts/iap-tiers.mjs`: one App Store product. Uses the `asc` CLI, so `asc auth` must work (`asc doctor` checks it).
- `scripts/plan-all.mjs`: every App Store product in a pricing config, with rule repair.
- `scripts/play-tiers.mjs`: Google Play subscriptions from the same config (plan, apply, verify). Needs a Play service account JSON with "Manage orders and subscriptions".
- `scripts/pricing-lib.mjs`: the shared rounding and rule logic.

## Fast path: the app already has a pricing config

Look for `pricing.config.json` in the app repo (for example `aso/pricing.config.json`). If it exists, the decisions are already made. Do not re-derive shares, pins or rules; run:

```bash
node scripts/plan-all.mjs --config <app>/pricing.config.json                  # App Store plans + repair
node scripts/play-tiers.mjs plan --config <app>/pricing.config.json           # Play plan + repair
```

Show `<out>/summary.md` and `<out>/play-plan.md`. After an explicit yes:

```bash
node scripts/iap-tiers.mjs apply --plan <out>/<key>/plan.json --yes            # each App Store product
node scripts/play-tiers.mjs apply --config <app>/pricing.config.json --yes
node scripts/play-tiers.mjs verify --config <app>/pricing.config.json         # App Store: verify after the start date
```

If the user changes a price decision, change the config (shares, pins, rules), commit it, and re-plan. Never fix prices by hand outside the config.

## The pricing config

```json
{
  "rounding": "charm", "endings": ["99"],
  "repair": "plus-monthly",
  "rules": [
    { "cheaper": "plus-monthly", "dearer": "pro-monthly" },
    { "cheaper": "pro-annual", "dearer": "plus-monthly", "dearerTimes": 12 }
  ],
  "products": {
    "plus-monthly": { "usd": 4.99, "ratios": { "4": 0.118, "5": 0.118 }, "pins": { "IN": 59 } },
    "pro-monthly":  { "usd": 5.99, "ratios": { "4": 0.165, "5": 0.165 } },
    "pro-annual":   { "usd": 39.99, "ratios": { "4": 0.175, "5": 0.175 } }
  },
  "appStore": { "app": "APP_ID", "out": "iap-pricing", "products": { "plus-monthly": { "id": "SUB_ID", "kind": "subscription" } } },
  "play": { "package": "com.example", "serviceAccount": "keys/play.json", "out": "iap-pricing",
            "products": { "plus-monthly": { "productId": "plus", "basePlanId": "monthly" } } }
}
```

- `ratios` change a tier's share per product. Tiers not listed keep the tier file's share.
- `pins` are ISO2 codes and set an exact local price in both stores (the App Store side maps them to ISO3).
- `rules` read as `cheaperTimes x cheaper < dearerTimes x dearer`. After rounding, any territory that breaks a rule gets the `repair` product moved to the best charm price that satisfies every rule. Pick the plan that exists to be compared (usually the cheapest) as `repair`, never the anchor plan.
- Paths are relative to the config file. Keep the service account path out of git if the key is.

Build a config the first time, after the user has agreed the prices, so the next run is the fast path.

## Pick the output

- **Pricing tables only** (no store access): `estimate` gives USD equivalents per country. With store access, `plan` gives exact local price points. Both write `.md` and `.json`.
- **Set prices in the store**: `plan`, show the table, get an explicit yes, then `apply` and `verify`.

Map the user's words to `--kind`:
- "subscription" or "auto-renewable": `subscription`
- "one time", "consumable", "non-consumable", "lifetime", "non-renewing": `iap`

## Workflow

1. **Find products.** Run `asc apps list` for the app ID, then `asc iap list --app APP --paginate` and `asc subscriptions list --app APP`. Show ID, product ID, type, state and current US price (`asc iap pricing summary --app APP`; it is slow and can time out, so retry or rely on the plan's USA row). Use the numeric ID as `--product`. Ask which products to include. Skip anything removed from sale unless asked.
2. **Check the US price is final.** A later US price change re-equalizes every territory and wipes the tiers. If the user wants a new US price, set it first (`asc iap pricing schedules create ... --price X`, or `asc subscriptions pricing prices set --territory USA --price X`), then plan.
3. **Plan (dry run, read-only):**
   ```bash
   node scripts/iap-tiers.mjs plan --kind iap --product <ID> --app <APP_ID> --out iap-pricing/<slug>
   ```
   This takes about 2 to 5 minutes per product (one price ladder per territory, cached in `<out>/cache`). Show the user `plan.md`: totals, untiered territories, skipped countries and a sample of rows. Flag the tier-list caveats in REFERENCE.md before they approve.
4. **Apply only after an explicit yes for each product:**
   ```bash
   node scripts/iap-tiers.mjs apply --plan iap-pricing/<slug>/plan.json            # prints commands
   node scripts/iap-tiers.mjs apply --plan iap-pricing/<slug>/plan.json --yes      # writes
   ```
   - `iap`: one new price schedule with USA plus every discounted territory. It **replaces** the existing schedule, so any manual prices not in the plan are lost. Tier 1 stays automatic and keeps following Apple's exchange-rate updates.
   - `subscription`: a CSV import, starting tomorrow by default, with `preserve_current_price` set. It runs as a dry run first.
5. **Verify:** `node scripts/iap-tiers.mjs verify --plan .../plan.json`. Any mismatch exits with code 2. Subscription prices with a future start date only show after that date, so verify again then.
6. **Report:** territories changed, territories skipped (no storefront), untiered territories, and anything that failed. No app update or App Review is needed for a price-only change.

## Options

- `--rounding charm` (default) picks the price closest to the target that ends in 99 or .99 (`4.99`, `699`, `99000`), within 20% of the target (`--charm-tolerance 0.2`). If none exists, it takes a 9 or .90 ending, then the plain closest point. `--rounding closest` picks the closest point to the target, whatever it ends in. `--charm-endings 99,49` also accepts .49 and ...49 endings as best (default `99`).
- `--ratios 4=0.4,5=0.4` changes a tier's share for this run only. Use it when one product needs different shares from another, for example a yearly plan priced lower in tiers 4 and 5.
- `--pins pins.json` sets an exact price for a territory, for example `{"NZL": 8.99}`. A pin wins over the tier and is written even in Tier 1. Use it to keep a cheaper plan below a dearer one where the rounding makes them equal.
- `--overrides overrides.json` moves territories between tiers, for example `{"LUX": 1, "ISL": 1}`. Use it when the user disagrees with a tier.
- `--tiers PATH` uses a different tier file of the same shape.
- `--concurrency N` sets the number of parallel ladder downloads (default 4). Lower it if App Store Connect rate-limits.
- `estimate --price 4.99 --out DIR` works offline from the tier file alone.

## Rules

- Never write prices without showing the plan and getting an explicit yes. Pricing is live for real customers.
- Never pick a 0.00 price point. The script excludes it.
- With several products in one subscription group, put the ordering in the config's `rules`. plan-all and play-tiers repair breaks and exit 2 if any remain; treat that as a blocker.
- Google Play: Tier 1 regions keep what Play charges today. Prices are converted by Google (`pricing:convertRegionPrices`) and written with the regions version Google used; an older version rejects changed currencies (Argentina is ARS from 2026/01). Existing Play subscribers keep their price unless you run a price migration.
- Paywalls must show the StoreKit or RevenueCat localized price string, never a hardcoded amount. Check this before applying.
- Introductory offers, promotional offers, offer codes and win-back offers have their own per-territory prices and are not changed by this workflow. Say so if the app uses them.

See [REFERENCE.md](REFERENCE.md) for the algorithm, App Store Connect details, tier-list caveats and troubleshooting.
