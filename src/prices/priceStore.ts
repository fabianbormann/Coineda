import { openLedger, type WriteOptions } from '@/ledger/db';
// Also configures Big.NE/Big.PE (the exponential-notation guard) as a side
// effect, process-wide: that is what keeps a Big's toString() - here, and
// inside ./scale's valueOf - from ever producing exponential form, even
// though nothing in this file sets them directly.
import { addAmounts } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import type { Holding } from '@/ledger/balances';
import { fetchSpotPrices } from './coingecko';
import { fetchRates } from './ecb';
import { valueOf } from './scale';
import { activeEndpoints } from '@/config/egress';
import type { Endpoints } from '@/config/endpoints';
import type { PriceKey } from './types';

export type { PriceKey };

/** The 'prices' store's primary key. Currency is part of it - see PriceKey. */
const cacheKey = ({ assetId, currency, date }: PriceKey): string =>
  `${assetId}|${currency}|${date}`;

/** A cached price and, when it was recorded, the source that priced it. A
 *  row written before sources were recorded has none. */
export const getCachedPrice = async (
  key: PriceKey,
): Promise<{ price: string; source?: string } | null> => {
  const db = await openLedger();
  const row = await db.get('prices', cacheKey(key));
  if (row === undefined) {
    return null;
  }
  return row.source === undefined
    ? { price: row.price }
    : { price: row.price, source: row.source };
};

export const putCachedPrice = async (
  key: PriceKey,
  price: string,
  source?: string,
  options?: WriteOptions,
): Promise<void> => {
  // A cache, not the client's data: written in a read-only review too
  // (the report there still has to price its events), but never into a
  // ledger the caller did not start in.
  const db = await openLedger(options?.ledger);
  await db.put('prices', {
    key: cacheKey(key),
    price,
    ...(source === undefined ? {} : { source }),
  });
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
 * total. A different fiat asset under this base currency (`fiat:usd` under a
 * eur base) is priced at the ECB's reference rate for today - carried back
 * over a weekend the way fetchRates does - and never asked of the crypto
 * provider. If the ECB cannot be reached it falls through to `missing` like
 * any other unpriced asset: the honest answer rather than a fabricated par.
 */
export const resolveSpotPrices = async (
  assetIds: string[],
  currency: string,
  /** The hosts to ask; defaults to the open client's own settings (its
   *  per-client overrides and egress mode - see activeEndpoints). */
  endpoints?: Endpoints,
): Promise<Map<string, string>> => {
  const date = todayUtc();
  const result = new Map<string, string>();
  const misses: string[] = [];
  const baseFiatAssetId = `fiat:${currency}`;

  const fiatMisses: string[] = [];

  for (const assetId of assetIds) {
    if (assetId === baseFiatAssetId) {
      result.set(assetId, '1');
      continue;
    }
    const cached = await getCachedPrice({ assetId, currency, date });
    if (cached !== null) {
      result.set(assetId, cached.price);
    } else if (isFiatAsset(assetId)) {
      fiatMisses.push(assetId);
    } else {
      misses.push(assetId);
    }
  }

  // Resolved only once a request is actually needed: a fully cached run
  // reads no settings at all.
  const hosts =
    fiatMisses.length > 0 || misses.length > 0
      ? (endpoints ?? activeEndpoints())
      : undefined;

  for (const assetId of fiatMisses) {
    try {
      const rates = await fetchRates(
        [date],
        assetId.slice('fiat:'.length),
        currency,
        undefined,
        hosts,
      );
      const rate = rates.get(date);
      if (rate !== undefined) {
        await putCachedPrice({ assetId, currency, date }, rate, 'ECB');
        result.set(assetId, rate);
      }
    } catch {
      // Same rule as the provider outage below: never throw into the UI.
    }
  }

  if (misses.length === 0) {
    return result;
  }

  let fetched: Map<string, string>;
  try {
    fetched = await fetchSpotPrices(misses, currency, hosts);
  } catch {
    // Provider outage: whatever was already cached is still valid and
    // usable. Nothing here should throw into the UI.
    return result;
  }

  for (const [assetId, price] of fetched) {
    await putCachedPrice({ assetId, currency, date }, price, 'CoinGecko');
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
