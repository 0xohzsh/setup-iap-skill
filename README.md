# setup-iap: fair country pricing for your App Store in-app purchases

A skill for [Claude Code](https://claude.com/claude-code) that prices your in-app purchases fairly in every country. It works for subscriptions, one-time unlocks, consumables (like coins) and non-consumables (like "Remove ads"). People in countries where money goes less far pay less. You keep your US price exactly as it is.

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

The skill always snaps to a real Apple price in each country, so prices look natural (₹160, not ₹159.60). It never makes anything free, and never charges more than Apple's normal price.

---

## What you need

1. **[Claude Code](https://claude.com/claude-code)** installed.
2. **Node.js 18 or newer.** Check with `node --version`. Get it from [nodejs.org](https://nodejs.org).
3. **The `asc` command-line tool**, to talk to App Store Connect. Only needed if you want the skill to set prices for you:
   ```bash
   brew install asc
   ```
4. **An App Store Connect API key**, again only for setting prices:
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
git clone <this-repo-url> setup-iap-skill
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

## Change a country's tier

Create a small file, for example `overrides.json`:

```json
{ "LUX": 1, "ISL": 1, "EST": 2 }
```

Then ask Claude to use it ("use overrides.json"). The codes are three-letter country codes (USA, GBR, IND...). Some rich places sit in lower tiers in the bundled list, for example Luxembourg, Iceland, Bermuda and Macao, and the skill points these out before you approve anything.

---

## Run it without Claude (optional)

The skill is a single script, so you can run it yourself:

```bash
cd setup-iap
node scripts/iap-tiers.mjs estimate --price 4.99 --out ./prices                       # offline USD estimate
node scripts/iap-tiers.mjs plan --kind iap --product <IAP_ID> --app <APP_ID>          # exact local prices
node scripts/iap-tiers.mjs apply --plan iap-pricing/<IAP_ID>/plan.json                # shows what would change
node scripts/iap-tiers.mjs apply --plan iap-pricing/<IAP_ID>/plan.json --yes          # changes the prices
node scripts/iap-tiers.mjs verify --plan iap-pricing/<IAP_ID>/plan.json               # checks the result
```

Use `--kind subscription` for auto-renewing subscriptions and `--kind iap` for everything else.

## How it works (for the curious)

For each product the script reads your US price. It then asks Apple for that price's full equivalent in every country (the "anchor"), multiplies the anchor by the country's tier share, and picks the closest real Apple price at or below the anchor. Full details, App Store Connect endpoints and known caveats are in [`setup-iap/REFERENCE.md`](setup-iap/REFERENCE.md).

## Limits

- App Store only. Google Play is not covered.
- It only lowers prices relative to Apple's default. It never raises them above it.
- Prices with a future start date show up in App Store Connect only once that date arrives.

## Credits

Country tiers: [activationpal.com/country-pricing](https://activationpal.com/country-pricing). App Store Connect access: [asc](https://asccli.sh).
