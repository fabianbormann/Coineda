import { getCachedPrice, putCachedPrice } from '@/prices/priceStore';
import {
  fetchHistoricalPrice,
  CoinGeckoHistoryError,
} from '@/prices/coingecko';
import { valueOf } from '@/prices/scale';
import { getSettings } from '@/settings/settingsStore';
import { normaliseAmount } from '@/ledger/amount';
import type { TaxEvent, UnresolvedItem } from '@/tax/types';

/** CoinGecko's free tier only serves the last 365 days of history. */
const FREE_TIER_DAYS = 365;

/** The UTC calendar day a timestamp falls on, as YYYY-MM-DD - matches
 *  PriceKey.date. Local time is deliberately never used: a local reading
 *  can move an event across a day boundary and, at year end, across a tax
 *  year. */
const utcDay = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

const pairKey = (assetId: string, date: string): string => `${assetId}|${date}`;

/**
 * Turns a lookup failure into the reason text a user reads.
 *
 * A 401/403 for a day more than 365 days back is the free tier's own
 * boundary, so it gets a specific, actionable message rather than being
 * folded into "the provider's status". Any other failure (an outage, a
 * rate limit, a key that is simply wrong) reports the provider's status
 * as-is - and since that message is built in fetchHistoricalPrice without
 * ever including the API key, it is always safe to show.
 */
const describeFailure = (error: unknown, date: string): string => {
  if (error instanceof CoinGeckoHistoryError) {
    const cutoff = new Date(Date.now() - FREE_TIER_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const isBeforeFreeTier = date < cutoff;
    if ((error.status === 401 || error.status === 403) && isBeforeFreeTier) {
      return `historical prices before ${cutoff} need a CoinGecko API key: the free tier covers only the last 365 days`;
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

type DayResult = { price: string } | { reason: string };

/**
 * Values each event in the base currency, at the price its asset had on
 * the UTC calendar day the event happened - not today's price.
 *
 * `fiat:{currency}` is resolved to exactly 1 before the cache or the
 * provider are even consulted, the same rule resolveSpotPrices already
 * applies: reporting a euro balance as unpriced would silently drop it
 * from a total.
 *
 * Every other (assetId, day) pair is deduplicated first and resolved once
 * - cache, then provider - since a historical price for a past day never
 * changes. A failure on one pair is caught and recorded rather than
 * aborting the run, so one unpriceable asset cannot cost a user their
 * whole report.
 */
export const resolveValues = async (
  events: TaxEvent[],
  currency: string,
): Promise<{ valued: TaxEvent[]; unpriced: UnresolvedItem[] }> => {
  const baseFiatAssetId = `fiat:${currency}`;
  const valued: TaxEvent[] = [];
  const pending: TaxEvent[] = [];

  for (const taxEvent of events) {
    if (taxEvent.assetId === baseFiatAssetId) {
      valued.push({ ...taxEvent, value: normaliseAmount(taxEvent.amount) });
    } else {
      pending.push(taxEvent);
    }
  }

  const unpriced: UnresolvedItem[] = [];
  if (pending.length === 0) {
    return { valued, unpriced };
  }

  const settings = await getSettings();
  const apiKey = settings?.coingeckoApiKey;

  const pairs = new Map<string, { assetId: string; date: string }>();
  for (const taxEvent of pending) {
    const date = utcDay(taxEvent.timestamp);
    const key = pairKey(taxEvent.assetId, date);
    if (!pairs.has(key)) {
      pairs.set(key, { assetId: taxEvent.assetId, date });
    }
  }

  const results = new Map<string, DayResult>();
  for (const [key, { assetId, date }] of pairs) {
    try {
      const cached = await getCachedPrice({ assetId, currency, date });
      if (cached !== null) {
        results.set(key, { price: cached });
        continue;
      }

      const fetched = await fetchHistoricalPrice(
        assetId,
        currency,
        date,
        apiKey,
      );
      if (fetched === null) {
        results.set(key, {
          reason: `no price source is configured for ${assetId}`,
        });
        continue;
      }

      await putCachedPrice({ assetId, currency, date }, fetched);
      results.set(key, { price: fetched });
    } catch (error) {
      results.set(key, { reason: describeFailure(error, date) });
    }
  }

  for (const taxEvent of pending) {
    const date = utcDay(taxEvent.timestamp);
    const result = results.get(pairKey(taxEvent.assetId, date));

    if (result && 'price' in result) {
      // Through valueOf, never a bare multiplication: the price is quoted
      // per WHOLE unit and the amount is in the asset's base unit, so the
      // per-asset scale has to be applied here. See src/prices/scale.ts.
      const value = valueOf(taxEvent.amount, result.price, taxEvent.assetId);
      valued.push({ ...taxEvent, value });
      continue;
    }

    unpriced.push({
      kind: 'needs-price',
      // An unpriced acquisition is not a disposal missing from the gain
      // figure, and `omitted` must be able to tell them apart.
      taxEventKind: taxEvent.kind,
      sourceEventId: taxEvent.sourceEventId,
      assetId: taxEvent.assetId,
      amount: taxEvent.amount,
      venue: taxEvent.venue,
      timestamp: taxEvent.timestamp,
      reason:
        result?.reason ??
        `no price source is configured for ${taxEvent.assetId}`,
      resolutions: [{ kind: 'record-purchase', marketPriceAt: undefined }],
    });
  }

  return { valued, unpriced };
};
