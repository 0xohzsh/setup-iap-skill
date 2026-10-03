---
name: setup-iap
description: Plans and applies tiered regional (purchasing-power) pricing for App Store in-app purchases: auto-renewable subscriptions, consumables, non-consumables and non-renewing subscriptions, for any app. Produces per-country price tables (Markdown + JSON) or writes the prices to App Store Connect with the asc CLI, then verifies them. Use when the user runs /setup-iap or asks for regional, country, PPP or tiered pricing of subscriptions, one-time purchases, consumables or non-consumables.
---

# Setup IAP tiered pricing

Every country sits in one of five tiers (`assets/tiers.json`, from activationpal.com/country-pricing). A tier pays a fixed share of Apple's equalized local price for the US base price: 100%, 80%, 60%, 40% or 25%. The US price never changes.

All mechanics live in `scripts/iap-tiers.mjs` (Node 18+, no dependencies). It uses the `asc` CLI for every App Store Connect call, so `asc auth` must already work (`asc doctor` checks it).

## Pick the output

- **Pricing tables only** (no store access): `estimate` gives USD equivalents per country. With store access, `plan` gives exact local price points. Both write `.md` and `.json`.
- **Set prices in the store**: `plan`, show the table, get an explicit yes, then `apply` and `verify`.

Map the user's words to `--kind`:
- "subscription" or "auto-renewable": `subscription`
- "one time", "consumable", "non-consumable", "lifetime", "non-renewing": `iap`

## Workflow

1. **Find products.** Run `asc apps list` for the app ID, then `asc iap list --app APP --paginate` and `asc subscriptions list --app APP`. Show ID, product ID, type, state and current US price (`asc iap pricing summary --app APP`). Ask which products to include. Skip anything removed from sale unless asked.
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

- `--overrides overrides.json` moves territories between tiers, for example `{"LUX": 1, "ISL": 1}`. Use it when the user disagrees with a tier.
- `--tiers PATH` uses a different tier file of the same shape.
- `--concurrency N` sets the number of parallel ladder downloads (default 4). Lower it if App Store Connect rate-limits.
- `estimate --price 4.99 --out DIR` works offline from the tier file alone.

## Rules

- Never write prices without showing the plan and getting an explicit yes. Pricing is live for real customers.
- Never pick a 0.00 price point. The script excludes it.
- Paywalls must show the StoreKit or RevenueCat localized price string, never a hardcoded amount. Check this before applying.
- Introductory offers, promotional offers, offer codes and win-back offers have their own per-territory prices and are not changed by this workflow. Say so if the app uses them.

See [REFERENCE.md](REFERENCE.md) for the algorithm, App Store Connect details, tier-list caveats and troubleshooting.
