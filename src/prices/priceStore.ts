import { openLedger } from '@/ledger/db';
// Also configures Big.NE/Big.PE (the exponential-notation guard) as a side
// effect, process-wide: that is what keeps a Big's toString() - here, and
// inside ./scale's valueOf - from ever producing exponential form, even
// though nothing in this file sets them directly.
import { addAmounts } from '@/ledger/amount';
import type { Holding } from '@/ledger/balances';
import { fetchSpotPrices } from './coingecko';
import { valueOf } from './scale';
import type { PriceKey } from './types';

export type { PriceKey };

/** The 'prices' store's primary key. Currency is part of it - see PriceKey. */
const cacheKey = ({ assetId, currency, date }: PriceKey): string =>
  `${assetId}|${currency}|${date}`;

export const getCachedPrice = async (key: PriceKey): Promise<string | null> => {
  const db = await openLedger();
  const row = await db.get('prices', cacheKey(key));
  return row?.price ?? null;
};

export const putCachedPrice = async (
  key: PriceKey,
  price: string,
): Promise<void> => {
  const db = await openLedger();
  await db.put('prices', { key: cacheKey(key), price });
};

/** Today's calendar day in UTC, as YYYY-MM-DD - matches PriceKey.date. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Resolves spot prices for a set of assets, cache first.
 *
 * Reads the cache for every asset before touching the network, fetches only
 * the misses, writes back what the provider returns, and returns everything
 * it has - cached or freshly fetched. A provider failure (thrown by
 * fetchSpotPrices) degrades to whatever was already cached: it never
 * propagates, because ingestion and the UI that reads this must not break
 * just because CoinGecko is unreachable.
 *
 * An asset that stays unresolved - no cache entry and no provider price - is
 * simply absent from the returned map. Reporting that as "missing" rather
 * than zero is totalValue's job, not this function's.
 *
 * The base currency's own fiat asset (`fiat:eur` when currency is 'eur') is
 * priced at exactly 1 by definition and resolved directly, before cache or
 * provider are even consulted - a euro balance held at an exchange is worth
 * one euro, and reporting it in `missing` would silently exclude it from the
 * total. This does NOT extend to a different fiat asset under this base
 * currency (`fiat:usd` under a eur base): that needs an FX rate this
 * milestone does not have, so it is left to fall through to `missing`
 * exactly like any other unpriced asset - the honest answer rather than a
 * fabricated rate.
 */
export const resolveSpotPrices = async (
  assetIds: string[],
  currency: string,
): Promise<Map<string, string>> => {
  const date = todayUtc();
  const result = new Map<string, string>();
  const misses: string[] = [];
  const baseFiatAssetId = `fiat:${currency}`;

  for (const assetId of assetIds) {
    if (assetId === baseFiatAssetId) {
      result.set(assetId, '1');
      continue;
    }
    const cached = await getCachedPrice({ assetId, currency, date });
    if (cached !== null) {
      result.set(assetId, cached);
    } else {
      misses.push(assetId);
    }
  }

  if (misses.length === 0) {
    return result;
  }

  let fetched: Map<string, string>;
  try {
    fetched = await fetchSpotPrices(misses, currency);
  } catch {
    // Provider outage: whatever was already cached is still valid and
    // usable. Nothing here should throw into the UI.
    return result;
  }

  for (const [assetId, price] of fetched) {
    await putCachedPrice({ assetId, currency, date }, price);
    result.set(assetId, price);
  }

  return result;
};

/**
 * Multiplies each holding by its price and sums the results.
 *
 * Each holding's value goes through `valueOf` (src/prices/scale.ts) rather
 * than a bare multiplication: a CoinGecko price is quoted per WHOLE unit
 * while a holding is in the asset's base unit, so the per-asset scale is
 * part of the conversion, not an optional correction. Valuation lives
 * there rather than in a ledger helper because ledger amounts and fiat
 * valuations are different concepts, and src/ledger/amount.ts is
 * deliberately only the ledger's vocabulary. Summing the per-holding
 * values reuses addAmounts, which already owns float-free decimal
 * addition.
 *
 * An asset with no entry in `prices` is reported in `missing` and excluded
 * from the sum - never counted as zero, which would silently understate the
 * total with no way for the user to notice.
 */
export const totalValue = (
  holdings: Holding[],
  prices: Map<string, string>,
): { total: string; missing: string[] } => {
  const missing: string[] = [];
  let total = '0';

  for (const holding of holdings) {
    const price = prices.get(holding.assetId);
    if (price === undefined) {
      missing.push(holding.assetId);
      continue;
    }
    const value = valueOf(holding.amount, price, holding.assetId);
    total = addAmounts(total, value);
  }

  return { total, missing };
};
