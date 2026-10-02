import { addAmounts } from '@/ledger/amount';
import { foldHoldings, isFiatAsset, ownedVenuesOf } from '@/ledger/balances';
import type { Holding } from '@/ledger/balances';
import { fetchHistoricalPrice } from '@/prices/coingecko';
import { getCachedPrice, putCachedPrice } from '@/prices/priceStore';
import { valueOf } from '@/prices/scale';
import type { LedgerEvent } from '@/ledger/types';

/**
 * One frame of the journey: the holdings as they stood at `timestamp`, and
 * their combined value in the base currency.
 *
 * `totalValue` is a decimal string or `null` - never a fabricated `'0'`.
 * `null` means "could not be priced", which happens whenever any held,
 * non-fiat asset has no cached or fetchable price for this point's UTC day
 * (CoinGecko's free tier only covers the last 365 days of history). Folding
 * that case into zero would draw a cliff in the rendered chart that never
 * happened in the user's actual holdings - see render.ts, which treats
 * `null` as a gap to skip, not a value to plot.
 */
export type SeriesPoint = {
  timestamp: number;
  totalValue: string | null;
  holdings: Holding[];
};

/** One "you bought this" annotation: which asset, when, and how much - a
 *  quantity, never a fiat value, so it is safe to draw in relative mode. */
export type AcquisitionMarker = {
  timestamp: number;
  assetId: string;
  amount: string;
};

export type JourneySeries = {
  points: SeriesPoint[];
  acquisitions: AcquisitionMarker[];
};

export type BuildJourneySeriesOptions = {
  /** Forwarded to fetchHistoricalPrice for dates older than the free
   *  tier's 365-day window. */
  apiKey?: string;
  /** Overridable only for tests; defaults to the real current time so the
   *  series always ends at "now". */
  now?: number;
};

/** The UTC calendar day a timestamp falls on, as YYYY-MM-DD - matches
 *  PriceKey.date and src/tax/resolveValues.ts's own `utcDay`. Local time is
 *  deliberately never used here. */
const utcDay = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

/** The number of days in `year`-`month` (0-indexed month), used to clamp a
 *  day-of-month that would otherwise overflow into a later month than
 *  intended (31 July + 1 month must land in August, not slide into
 *  September via an overflowed "31 August"). */
const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Adds whole calendar months to a UTC instant, clamping the day-of-month
 *  so e.g. 31 January + 1 month is 28/29 February, not 3 March. */
const addMonthsUtc = (base: Date, months: number): number => {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + months;
  const day = Math.min(base.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(
    year,
    month,
    day,
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  );
};

// A hard safety cap on sample count, not a target. Monthly sampling between
// a real first event and "now" naturally lands around 24-60 points for a
// multi-year portfolio - this cap only guards against a corrupt or
// artificial timestamp producing an effectively unbounded loop below.
const MAX_SAMPLES = 600;

/**
 * Monthly sample timestamps from `firstTimestamp` to `now`, inclusive of
 * both ends. Sampling monthly rather than daily is what keeps the number of
 * (asset, day) price lookups bounded - daily sampling over a multi-year
 * portfolio would be thousands of lookups against a provider that
 * rate-limits hard; monthly keeps it in the dozens.
 *
 * Exported for direct testing of the calendar-month arithmetic, which is
 * easy to get subtly wrong (month-end overflow, a history shorter than one
 * month) independently of any pricing concern.
 */
export const monthlySampleTimestamps = (
  firstTimestamp: number,
  now: number,
): number[] => {
  if (now <= firstTimestamp) {
    return [firstTimestamp];
  }
  const first = new Date(firstTimestamp);
  const timestamps: number[] = [];
  let month = 0;
  while (timestamps.length < MAX_SAMPLES - 1) {
    const candidate = addMonthsUtc(first, month);
    if (candidate >= now) {
      break;
    }
    timestamps.push(candidate);
    month += 1;
  }
  timestamps.push(now);
  return timestamps;
};

/**
 * Builds the journey series: one point per monthly sample between the
 * oldest event and now, plus every acquisition worth annotating.
 *
 * Holdings at each sample are folded from every event up to and including
 * that sample's timestamp - `ownedVenuesOf` is computed once over the
 * whole log, since which venues are "ours" is a property of the configured
 * sources, not of time.
 *
 * Prices are looked up per (assetId, UTC day) pair, deduplicated across the
 * whole series before any lookup happens - the same shape
 * src/tax/resolveValues.ts uses, for the same reason: a historical price
 * for a past day never changes, and the provider rate-limits hard. A
 * lookup failure for one pair (no cache entry, provider has no data this
 * far back, or a network error) leaves that one pair unpriced; it never
 * aborts the whole series.
 */
export const buildJourneySeries = async (
  events: LedgerEvent[],
  currency: string,
  options: BuildJourneySeriesOptions = {},
): Promise<JourneySeries> => {
  if (events.length === 0) {
    return { points: [], acquisitions: [] };
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const ownedVenues = ownedVenuesOf(sorted);
  const now = options.now ?? Date.now();
  const sampleTimestamps = monthlySampleTimestamps(sorted[0].timestamp, now);

  const holdingsPerSample: Holding[][] = sampleTimestamps.map((timestamp) => {
    const eventsUpTo = sorted.filter((event) => event.timestamp <= timestamp);
    return foldHoldings(eventsUpTo, ownedVenues);
  });

  const baseFiatAssetId = `fiat:${currency}`;

  // Every distinct (assetId, day) pair this series needs a price for,
  // deduplicated before any lookup. The base currency's own fiat holding
  // never needs a lookup - it is worth exactly 1 by definition, the same
  // rule src/prices/priceStore.ts applies.
  const pairs = new Map<string, { assetId: string; date: string }>();
  for (let i = 0; i < sampleTimestamps.length; i += 1) {
    const date = utcDay(sampleTimestamps[i]);
    for (const holding of holdingsPerSample[i]) {
      if (isFiatAsset(holding.assetId)) {
        continue;
      }
      const key = `${holding.assetId}|${date}`;
      if (!pairs.has(key)) {
        pairs.set(key, { assetId: holding.assetId, date });
      }
    }
  }

  const prices = new Map<string, string>();
  for (const [key, { assetId, date }] of pairs) {
    try {
      const cached = await getCachedPrice({ assetId, currency, date });
      if (cached !== null) {
        prices.set(key, cached);
        continue;
      }
      const fetched = await fetchHistoricalPrice(
        assetId,
        currency,
        date,
        options.apiKey,
      );
      if (fetched === null) {
        // Not mapped, or the provider has nothing for this day - leave it
        // out of `prices`, which is exactly what makes the point below
        // unpriced rather than zero.
        continue;
      }
      await putCachedPrice({ assetId, currency, date }, fetched);
      prices.set(key, fetched);
    } catch {
      // A provider outage or a free-tier 401/403 for a day too old to
      // cover: one unpriceable (asset, day) pair must not cost the user
      // their whole journey. Leave it unpriced and move on.
      continue;
    }
  }

  const points: SeriesPoint[] = sampleTimestamps.map((timestamp, index) => {
    const holdings = holdingsPerSample[index];
    const date = utcDay(timestamp);
    let total = '0';
    let allPriced = true;

    for (const holding of holdings) {
      if (holding.assetId === baseFiatAssetId) {
        total = addAmounts(total, holding.amount);
        continue;
      }
      if (isFiatAsset(holding.assetId)) {
        // A non-base fiat balance: no FX rate is available (the same gap
        // resolveSpotPrices leaves to `missing`), so this point cannot be
        // fully priced either.
        allPriced = false;
        continue;
      }
      const price = prices.get(`${holding.assetId}|${date}`);
      if (price === undefined) {
        allPriced = false;
        continue;
      }
      // Decimal string x decimal string -> decimal string, through the
      // same per-asset scale src/prices/priceStore.ts's totalValue uses -
      // a price is per whole unit, a holding is in base units. Converted to
      // a number only at render.ts's final pixel-coordinate boundary,
      // never here.
      const value = valueOf(holding.amount, price, holding.assetId);
      total = addAmounts(total, value);
    }

    return {
      timestamp,
      totalValue: allPriced ? total : null,
      holdings,
    };
  });

  const acquisitions: AcquisitionMarker[] = [];
  for (const event of sorted) {
    // 'trade' (a buy) and 'reward' are acquisitions in the sense this
    // feature cares about - "what did they buy, and when". 'transfer' is
    // deliberately excluded: moving an asset between the user's own venues,
    // or receiving it from outside, is not "buying" it.
    if (event.kind !== 'trade' && event.kind !== 'reward') {
      continue;
    }
    for (const leg of event.legs) {
      if (
        leg.direction === 'in' &&
        leg.role === 'principal' &&
        ownedVenues.has(leg.venue) &&
        !isFiatAsset(leg.assetId)
      ) {
        acquisitions.push({
          timestamp: event.timestamp,
          assetId: leg.assetId,
          amount: leg.amount,
        });
      }
    }
  }

  return { points, acquisitions };
};
