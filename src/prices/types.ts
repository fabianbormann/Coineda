/**
 * Identifies one cached price: which asset, priced in which currency, as of
 * which UTC calendar day.
 *
 * `currency` is part of the key, not metadata alongside it - a currency-blind
 * key would hand back the previous base currency's number under a new label
 * the moment the user switched base currencies. `date` is `YYYY-MM-DD` in
 * UTC so the key is stable regardless of the viewer's local timezone.
 */
export type PriceKey = {
  assetId: string;
  currency: string;
  date: string;
};
