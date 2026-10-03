# Setup IAP reference

## Algorithm

1. Read the product's current US price (the base). Base territory must be USA.
2. Find the USA price point with that customer price.
3. Fetch its equalizations: Apple's full local price in every storefront. That price is the territory's **anchor**.
4. For each territory:
   - Tier 1, or not in the tier list: keep the anchor and leave the territory automatic.
   - Otherwise: `target = anchor x ratio`. From the territory's own price ladder, pick the point closest to the target that is above 0.00 and not above the anchor. A tie goes to the lower price.
5. Always compute from the anchor. Never apply a ratio to a price that is already discounted.

## App Store Connect mapping

| Step | asc command | API behind it |
|---|---|---|
| Current price | `iap pricing summary` / `subscriptions pricing summary` | price schedule / subscription prices |
| Territory ladder | `... price-points list --territory T --paginate` | `GET /v2/inAppPurchases/{id}/pricePoints`, `GET /v1/subscriptions/{id}/pricePoints` |
| Anchors | `iap pricing price-points equalizations --id P` / `subscriptions pricing price-points equalizations --price-point-id P` | `GET /v1/{inAppPurchase,subscription}PricePoints/{id}/equalizations` |
| Write IAP | `iap pricing schedules create --base-territory USA --prices ID,ID,...` | `POST /v1/inAppPurchasePriceSchedules` |
| Write subscription | `subscriptions pricing prices import --input prices.csv --preserved` | `POST /v1/subscriptionPrices` per territory |
| Read back | `iap pricing schedules manual-prices --resolved` / `subscriptions pricing prices list --resolved` | |

Notes:
- **Territory codes.** Equalization results do not carry a territory attribute. The territory is inside the price-point ID, which is base64url JSON such as `{"s":"<product>","t":"FRA","p":"10049"}`. The script decodes it.
- **Ladders differ per territory.** Ladder sizes vary, for example 658 points in USA and 690 in India, so the equalized points alone are not enough to find the closest price. Each territory's ladder is fetched once and cached.
- **Consumables and non-renewing subscriptions.** These, like non-consumables, use in-app purchase price schedules (`--kind iap`). Only auto-renewable subscriptions use subscription prices.
- **One-time purchase schedules.** A schedule replaces the previous one. Territories left out of `manualPrices` become automatic, and that is deliberate for Tier 1.
- **Subscription price changes.** `preserveCurrentPrice` only matters for increases. Tiering only lowers or keeps prices, and Apple moves existing subscribers to a lower price automatically. The flag is kept as a safety net.

## Review of the original procedure

Corrections and optimizations relative to the source write-up this skill was built from:

1. **Free price point.** Every ladder includes 0.00. "Closest to target" can pick it for cheap items in 25% territories. The script excludes 0.00.
2. **"Not above the anchor" is almost never the binding rule.** Since `target <= anchor` always, the real edge case is a target below the territory's lowest paid point. The script then picks the lowest paid point, which is still at or below the anchor.
3. **Read the US price; don't ask for it.** The script reads it, and refuses a different `--base-price` so the base is never changed by accident.
4. **Fewer writes.** Tier 1 territories are not written as manual prices. They stay automatic and keep following Apple's tax and exchange-rate updates.
5. **Manual prices freeze.** Discounted territories no longer follow Apple's exchange-rate or tax re-equalizations. Re-run plan and apply when Apple announces price or tax updates, or every few months.
6. **Storefront coverage.** The tier list covers 250 countries; App Store Connect sells in about 175. The rest (for example Cuba, Iran, North Korea, Syria, Antarctica) have no storefront and are reported as skipped. Storefronts missing from the tier list stay at full price and are reported.
7. **One request per territory is unavoidable.** Ladders cannot be shared across products because price-point IDs are product-specific. Caching makes plan re-runs cheap. Lower `--concurrency` if App Store Connect returns 429.
8. **Offers are separate.** Introductory, promotional, win-back offers and offer codes keep their own prices.

## Tier-list caveats to show the user

The bundled tiers are a starting point, not truth. Review these before applying, and move any you disagree with via `--overrides`:
- **High-income storefronts in Tier 3 (60%):** Luxembourg, Iceland, Bermuda, Cayman Islands, Macao, British Virgin Islands, Turks and Caicos, Brunei, Bahrain. (Liechtenstein, Monaco, Andorra and others are also Tier 3 but have no App Store storefront.)
- **Baltics and Croatia in Tier 3:** Estonia, Latvia, Lithuania and Croatia sit below Poland, Czechia and Slovakia (Tier 2).
- **Mid-income territories in Tier 5 (25%):** Montenegro, Namibia, Fiji, Maldives, Dominica, Grenada, Saint Lucia and Saint Vincent sit below neighbours in Tier 4.
- **China in Tier 3 and Hong Kong in Tier 1.** This is consistent with local pricing, but call it out.

## Troubleshooting

- **`no USA price point equals X`:** the base is not a valid price point. Set a valid US price first.
- **`uses base territory ...`:** the product's base is not USA. Change the base in App Store Connect, or adapt the anchor.
- **Subscription territory errors on import:** the subscription is not available in that territory. Check `asc subscriptions pricing availability`.
- **Verify mismatches right after a subscription import:** the prices start on the start date. Verify again after it.
