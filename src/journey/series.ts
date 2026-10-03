import { addAmounts, isZeroAmount } from '@/ledger/amount';
import { foldHoldings, isFiatAsset, ownedVenuesOf } from '@/ledger/balances';
import type { Holding } from '@/ledger/balances';
import { resolveSpotPrices, totalValue } from '@/prices/priceStore';
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
  /** The other half of the story: what left, and when. Same shape as an
   *  acquisition, and subject to the same relative-mode rule - a quantity
   *  is an absolute figure whichever direction it moved in. */
  disposals: AcquisitionMarker[];
  /**
   * The assets to give a lane each, most valuable first.
   *
   * Amounts cannot be summed across assets - 0.5 BTC and 10,000 ADA share
   * no unit - so the journey draws one lane per asset rather than one
   * total, and this is the order they are drawn in.
   */
  assets: string[];
  /**
   * Today's total, in the base currency, for the CLOSING frame alone.
   *
   * The animation itself never touches a price: holdings come straight out
   * of the ledger, so the whole history plays offline, for any year, with no
   * rate limit and no 365-day window. This one figure costs a single spot
   * request, the same one the balance header makes. Null when it could not
   * be priced, and the journey still plays without it.
   */
  finalValue: string | null;
};

export type BuildJourneySeriesOptions = {
  /** Overridable only for tests; defaults to the real current time so the
   *  series always ends at "now". */
  now?: number;
};

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
    return {
      points: [],
      acquisitions: [],
      disposals: [],
      assets: [],
      finalValue: null,
    };
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const ownedVenues = ownedVenuesOf(sorted);
  const now = options.now ?? Date.now();
  const sampleTimestamps = monthlySampleTimestamps(sorted[0].timestamp, now);

  const holdingsPerSample: Holding[][] = sampleTimestamps.map((timestamp) => {
    const eventsUpTo = sorted.filter((event) => event.timestamp <= timestamp);
    return foldHoldings(eventsUpTo, ownedVenues);
  });

  const points: SeriesPoint[] = sampleTimestamps.map((timestamp, i) => ({
    timestamp,
    holdings: holdingsPerSample[i],
  }));

  // Every non-fiat asset that ever appeared, not only what is still held: an
  // asset bought and later sold in full has a story worth a lane, and
  // dropping it would make the journey disagree with the ledger.
  const seen = new Set<string>();
  for (const holdings of holdingsPerSample) {
    for (const holding of holdings) {
      if (!isFiatAsset(holding.assetId)) {
        seen.add(holding.assetId);
      }
    }
  }

  // ONE spot request, and it does two jobs: the closing figure, and the
  // order of the lanes. Ranking by today's value is the only ranking that
  // means anything across assets - a bigger NUMBER of units says nothing,
  // since 10,000 ADA and 0.5 BTC are not comparable quantities.
  const finalHoldings = holdingsPerSample[holdingsPerSample.length - 1] ?? [];
  let prices = new Map<string, string>();
  try {
    prices = await resolveSpotPrices(
      [...new Set([...seen, ...finalHoldings.map((h) => h.assetId)])],
      currency,
    );
  } catch {
    // The journey is about amounts and does not need this to play. Only the
    // closing figure and the lane order fall back.
    prices = new Map();
  }

  const priced = totalValue(finalHoldings, prices);
  const finalValue = priced.missing.length === 0 ? priced.total : null;

  const valueOfAsset = (assetId: string): number => {
    const holding = finalHoldings.find((h) => h.assetId === assetId);
    const price = prices.get(assetId);
    if (!holding || price === undefined) {
      return -1;
    }
    return Number(totalValue([holding], prices).total);
  };

  // Activity breaks the tie, so an unpriceable asset is ordered by how much
  // happened in it rather than arbitrarily.
  const activity = new Map<string, number>();
  for (const event of sorted) {
    for (const leg of event.legs) {
      if (!isFiatAsset(leg.assetId)) {
        activity.set(leg.assetId, (activity.get(leg.assetId) ?? 0) + 1);
      }
    }
  }

  const assets = [...seen].sort((a, b) => {
    const byValue = valueOfAsset(b) - valueOfAsset(a);
    if (byValue !== 0) {
      return byValue;
    }
    return (activity.get(b) ?? 0) - (activity.get(a) ?? 0);
  });

  const acquisitions: AcquisitionMarker[] = [];
  const disposals: AcquisitionMarker[] = [];
  for (const event of sorted) {
    // Markers follow the NET CHANGE in holdings, not the event's kind.
    //
    // The old rule took 'trade' and 'reward' and dropped 'transfer', which
    // was right when Cardano was the only source and wrong the moment a
    // second one existed: the Bitcoin module emits 'transfer' for
    // everything, so a Bitcoin wallet produced no markers at all and its
    // journey could only ever be a line chart. Netting says the same thing
    // the old rule was reaching for, without asking a module to classify
    // intent it does not know: coins arriving from outside are an
    // acquisition, coins leaving are a disposal, and a move between the
    // user's own venues nets to zero and is neither - which is exactly why
    // 'transfer' was excluded in the first place.
    //
    // Summed across every leg at an owned venue, fees included, so a marker
    // agrees with the curve it sits under: foldHoldings counts the same
    // legs.
    const net = new Map<string, string>();
    for (const leg of event.legs) {
      if (!ownedVenues.has(leg.venue) || isFiatAsset(leg.assetId)) {
        continue;
      }
      const signed = leg.direction === 'in' ? leg.amount : `-${leg.amount}`;
      net.set(leg.assetId, addAmounts(net.get(leg.assetId) ?? '0', signed));
    }

    for (const [assetId, change] of net) {
      if (isZeroAmount(change)) {
        continue;
      }
      const marker = {
        timestamp: event.timestamp,
        assetId,
        amount: change.startsWith('-') ? change.slice(1) : change,
      };
      if (change.startsWith('-')) {
        disposals.push(marker);
      } else {
        acquisitions.push(marker);
      }
    }
  }

  return { points, acquisitions, disposals, assets, finalValue };
};
