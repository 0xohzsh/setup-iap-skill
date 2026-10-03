# setup-iap: fair country pricing for your App Store and Google Play purchases

A skill for [Claude Code](https://claude.com/claude-code) that prices your in-app purchases fairly in every country, on the App Store and on Google Play. On the App Store it works for subscriptions, one-time unlocks, consumables (like coins) and non-consumables (like "Remove ads"). On Google Play it works for subscriptions. People in countries where money goes less far pay less. You keep your US price exactly as it is.

You don't need to know anything about pricing to use it. You type `/setup-iap`, answer a few questions, check a table, and say yes.

---

## Why bother?

Apple converts your US price into every local currency, so a $4.99 purchase costs roughly the same everywhere. But $4.99 is a coffee in New York and a day's food budget in many countries. In those places almost nobody buys, so you earn nothing there.

Regional pricing fixes that:

| Country | Apple's default | With regional pricing | What changes |
|---|---|---|---|
| United States | $3.99 | $3.99 | Nothing, your base price stays |
| Brazil | R$ 24.90 | R$ 14.90 | 60% of the default |
| India | ₹399 | ₹160 | 40% of the default |
| Pakistan | Rs 1,100 | Rs 279 | 25% of the default |

These numbers come from a real $3.99 purchase. Fairer prices usually mean more buyers in those countries, and more total income.

## How the countries are grouped

Every country is in one of five groups ("tiers"). Each group pays a share of Apple's normal local price:

| Tier | Pays | Examples |
|---|---|---|
| 1 | 100% (full price) | USA, UK, Germany, Japan, Australia |
| 2 | 80% | Poland, Portugal, Greece, Chile |
| 3 | 60% | Brazil, Mexico, Turkey, China |
| 4 | 40% | India, Indonesia, Egypt, Vietnam |
| 5 | 25% | Pakistan, Nepal, Ethiopia |

The full list of 250 countries is in [`setup-iap/assets/tiers.json`](setup-iap/assets/tiers.json). It comes from [activationpal.com/country-pricing](https://activationpal.com/country-pricing). Don't agree with a country's tier? You can move it (see "Change a country's tier" below).

The skill always snaps to a real store price that ends in 99 or .99 where one is close (₹149, $2.99), so prices look natural. It never makes anything free, and never charges more than Apple's normal price. Want a different share for one product, for example a cheaper yearly plan in tiers 4 and 5? That is one line in the pricing config (below).

---

## What you need

1. **[Claude Code](https://claude.com/claude-code)** installed.
2. **Node.js 18 or newer.** Check with `node --version`. Get it from [nodejs.org](https://nodejs.org).
3. **The `asc` command-line tool**, to talk to App Store Connect. Only needed if you want the skill to set prices for you:
   ```bash
   brew install asc
   ```
4. **A Google Play service account key**, only for Google Play. In Google Cloud, enable the *Google Play Android Developer API*, create a service account, and download its JSON key. In Play Console, invite the service account's email with **Manage orders and subscriptions** permission on your app.
5. **An App Store Connect API key**, again only for setting prices:
   1. Open [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
   2. Create a key with the **App Manager** role and download the `.p8` file. You can only download it once, so keep it safe.
   3. Note the **Key ID** and the **Issuer ID** shown on that page.
   4. Connect `asc` to your account:
      ```bash
      asc auth login --name "MyKey" --key-id "YOUR_KEY_ID" --issuer-id "YOUR_ISSUER_ID" --private-key /path/to/AuthKey_XXXX.p8
      asc auth doctor
      ```

## Install the skill

```bash
git clone https://github.com/0xohzsh/setup-iap-skill.git
mkdir -p ~/.claude/skills
cp -R setup-iap-skill/setup-iap ~/.claude/skills/setup-iap
```

Restart Claude Code. The skill is now available as `/setup-iap`.

---

## How to use it

Open Claude Code in any folder and type one of these:

```
/setup-iap show me regional prices for a $4.99 one-time purchase
/setup-iap set regional pricing for my subscriptions
/setup-iap regional pricing for all the non-consumables in my app
```

### Option 1: just give me the prices (nothing changes in your store)

You get two files for every product:
- `plan.md`, a table you can read: country, currency, current price, new price.
- `plan.json`, the same data for spreadsheets or other tools.

Without an App Store Connect key, you get an **estimate** in US dollars for all 250 countries. With a key, you get the **exact local prices** Apple will charge, for every country where the App Store sells.

### Option 2: set the prices in App Store Connect for me

1. Claude lists your app's products and asks which ones to change.
2. It builds the price table (about 2 to 5 minutes per product) and shows it to you.
3. **Nothing changes until you say yes.**
4. It updates App Store Connect and then reads the prices back to check every country.

You don't need a new app version or an App Review. Price changes go live on their own.

---

## Good to know

- **Set your US price first.** If you change the US price later, Apple recalculates every country and the regional prices are lost. Then run the skill again.
- **Your app must show Apple's price, not a typed-in one.** Your paywall should display the price that StoreKit (or RevenueCat, etc.) gives you, so each country sees its own price. If your app shows "$4.99" written into the design, fix that first.
- **Existing subscribers are protected.** Subscription changes keep current subscribers on the price they already pay.
- **Re-run it every few months.** Discounted prices are fixed amounts. Apple occasionally adjusts its normal prices for exchange rates and taxes, and re-running keeps your discounts in step.
- **Some countries are skipped.** The list has 250 countries, but the App Store sells in about 175. The rest (for example Cuba or Iran) can't buy apps anyway, and the skill tells you which were skipped.
- **Free trials, intro prices and offer codes are not changed.** They have their own prices in App Store Connect.

## Save your decisions in a pricing config

The first time, you decide the shares, maybe pin a price or two, and check the plans line up (for example "Plus must stay cheaper than Pro"). Save those decisions in `pricing.config.json` in your app's repo, and every later run is one command per store:

```json
{
  "rounding": "charm",
  "repair": "plus-monthly",
  "rules": [
    { "cheaper": "plus-monthly", "dearer": "pro-monthly" },
    { "cheaper": "pro-annual", "dearer": "plus-monthly", "dearerTimes": 12 }
  ],
  "products": {
    "plus-monthly": { "usd": 4.99, "ratios": { "4": 0.12, "5": 0.12 }, "pins": { "IN": 59 } },
    "pro-monthly":  { "usd": 5.99, "ratios": { "4": 0.165, "5": 0.165 } },
    "pro-annual":   { "usd": 39.99, "ratios": { "4": 0.175, "5": 0.175 } }
  },
  "appStore": { "app": "YOUR_APP_ID", "out": "iap-pricing",
                "products": { "plus-monthly": { "id": "SUBSCRIPTION_ID", "kind": "subscription" } } },
  "play": { "package": "com.example.app", "serviceAccount": "keys/play.json", "out": "iap-pricing",
            "products": { "plus-monthly": { "productId": "plus", "basePlanId": "monthly" } } }
}
```

- `ratios`: the share a tier pays for that product. Tiers you leave out use the defaults above.
- `pins`: an exact price for a country (two-letter code), in both stores.
- `rules`: read "cheaper < dearer". `dearerTimes: 12` means "a year of monthly". Rounding can break a rule in a few countries; the skill then moves the `repair` product to the nearest price that keeps every rule.

Then ask Claude to "re-run pricing from the config", or run the scripts yourself (below).

## Change a country's tier

Create a small file, for example `overrides.json`:

```json
{ "LUX": 1, "ISL": 1, "EST": 2 }
```

Then ask Claude to use it ("use overrides.json"). The codes are three-letter country codes (USA, GBR, IND...). Some rich places sit in lower tiers in the bundled list, for example Luxembourg, Iceland, Bermuda and Macao, and the skill points these out before you approve anything.

---

## Run it without Claude (optional)

The scripts need only Node.js, so you can run them yourself. One App Store product at a time:

```bash
cd setup-iap
node scripts/iap-tiers.mjs estimate --price 4.99 --out ./prices                       # offline USD estimate
node scripts/iap-tiers.mjs plan --kind iap --product <IAP_ID> --app <APP_ID>          # exact local prices
node scripts/iap-tiers.mjs apply --plan iap-pricing/<IAP_ID>/plan.json                # shows what would change
node scripts/iap-tiers.mjs apply --plan iap-pricing/<IAP_ID>/plan.json --yes          # changes the prices
node scripts/iap-tiers.mjs verify --plan iap-pricing/<IAP_ID>/plan.json               # checks the result
```

Use `--kind subscription` for auto-renewing subscriptions and `--kind iap` for everything else.

Everything at once, from a pricing config:

```bash
node scripts/plan-all.mjs --config pricing.config.json                    # App Store: every product, rules repaired
node scripts/iap-tiers.mjs apply --plan iap-pricing/<key>/plan.json --yes  # App Store: write one product
node scripts/play-tiers.mjs plan --config pricing.config.json             # Google Play: plan
node scripts/play-tiers.mjs apply --config pricing.config.json --yes      # Google Play: write
node scripts/play-tiers.mjs verify --config pricing.config.json           # Google Play: check
```

## How it works (for the curious)

For each product the script reads your US price. It then asks Apple for that price's full equivalent in every country (the "anchor"), multiplies the anchor by the country's tier share, and picks a real Apple price at or below the anchor: one ending in 99 if it is close, otherwise the closest. Google Play has no fixed price list, so `play-tiers.mjs` asks Google to convert each tier's share of the US price into local money, rounds it the same way, and keeps tier 1 countries at the price Play charges today. Full details, App Store Connect endpoints and known caveats are in [`setup-iap/REFERENCE.md`](setup-iap/REFERENCE.md).

## Limits

- Google Play: subscriptions only (not one-time products). Existing Play subscribers keep their old price until you run a price migration in Play Console.
- It only lowers prices relative to Apple's default. It never raises them above it.
- Prices with a future start date show up in App Store Connect only once that date arrives.

## Credits

Country tiers: [activationpal.com/country-pricing](https://activationpal.com/country-pricing). App Store Connect access: [asc](https://asccli.sh).

## License

MIT for the code (see [LICENSE](LICENSE)). The country tier list in `setup-iap/assets/tiers.json` comes from activationpal.com.
