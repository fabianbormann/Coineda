import { getCachedPrice, putCachedPrice } from '@/prices/priceStore';
import {
  COINGECKO_IDS,
  FREE_TIER_DAYS,
  freeTierCutoff,
  CoinGeckoHistoryError,
} from '@/prices/coingecko';
import { fetchHistory } from '@/prices/history';
import { valueOf } from '@/prices/scale';
import { getSettings } from '@/settings/settingsStore';
import { isFiatAsset } from '@/ledger/balances';
import { isZeroAmount, normaliseAmount } from '@/ledger/amount';
import type { TaxCost, TaxEvent, TaxReason, UnresolvedItem } from '@/tax/types';

/**
 * The reason keys this module can emit.
 *
 * A provider's own message is never a key - it is an outage, a rate limit
 * or a status line, and nobody can enumerate those in advance - so it rides
 * as `params.detail` inside a wrapper that IS keyed. That is the same split
 * the rest of the app already applies to `source.lastError`, made
 * structural here rather than left to whoever renders it.
 */
export const PRICE_REASON_KEYS = [
  'Historical prices before {{cutoff}} need a CoinGecko API key: the free tier covers only the last {{days}} days.',
  'No price source is configured for {{asset}}.',
  'No price for {{asset}} on {{date}}.',
  'The price provider could not answer: {{detail}}',
] as const;

/** The UTC calendar day a timestamp falls on, as YYYY-MM-DD - matches
 *  PriceKey.date. Local time is deliberately never used: a local reading
 *  can move an event across a day boundary and, at year end, across a tax
 *  year. */
const utcDay = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

const BASE_SOURCE = 'base currency';

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
/**
 * The free tier's own boundary, as one message shared by both paths that can
 * hit it: a provider 401 for an old day, and a day this code declined to
 * request at all because it already knew the answer.
 */
const freeTierReason = (): TaxReason => ({
  key: PRICE_REASON_KEYS[0],
  params: {
    cutoff: new Date(freeTierCutoff()).toISOString().slice(0, 10),
    days: FREE_TIER_DAYS,
  },
});

const describeFailure = (error: unknown, date: string): TaxReason => {
  if (error instanceof CoinGeckoHistoryError) {
    const cutoff = new Date(freeTierCutoff()).toISOString().slice(0, 10);
    const isBeforeFreeTier = date < cutoff;
    if ((error.status === 401 || error.status === 403) && isBeforeFreeTier) {
      return freeTierReason();
    }
  }
  // The provider's own words, wrapped rather than reproduced bare. Built in
  // fetchHistoricalPrice without ever including the API key, so it stays
  // safe to show - see the credential note on the key input.
  return {
    key: PRICE_REASON_KEYS[3],
    params: {
      detail: error instanceof Error ? error.message : String(error),
    },
  };
};

type DayResult = { price: string; source: string } | { reason: TaxReason };

/**
 * Resolves every (asset, day) pair once: cache first, then one batched
 * provider request for whatever is missing. Extracted so the valuation
 * loop below can value an event's costs through the same table as the
 * event itself.
 */
const lookUp = async (
  pairs: Map<string, { assetId: string; date: string }>,
  currency: string,
): Promise<Map<string, DayResult>> => {
  const settings = await getSettings();
  const apiKey = settings?.coingeckoApiKey;

  const results = new Map<string, DayResult>();

  // Everything already cached, first and without a request. A second run of
  // the same report asks the provider for nothing at all.
  const missing = new Map<string, string[]>();
  for (const [key, { assetId, date }] of pairs) {
    const cached = await getCachedPrice({ assetId, currency, date });
    if (cached !== null) {
      results.set(key, {
        price: cached.price,
        source: cached.source ?? 'cache (source not recorded)',
      });
      continue;
    }
    // A fiat asset has no CoinGecko id and needs none: fetchHistory prices
    // it by the ECB rate.
    if (!COINGECKO_IDS[assetId] && !isFiatAsset(assetId)) {
      results.set(key, {
        reason: {
          key: PRICE_REASON_KEYS[1],
          params: { asset: assetId },
        },
      });
      continue;
    }
    const days = missing.get(assetId);
    if (days) {
      days.push(date);
    } else {
      missing.set(assetId, [date]);
    }
  }

  // ONE request for every asset and every day, plus one for the whole FX
  // span - not one per asset, and certainly not one per day. A report
  // needing 80 days priced used to issue 80 sequential requests; the
  // keyless free tier answers 429 after about four, and that 429 carries no
  // CORS header, so the browser reported `TypeError: Failed to fetch`
  // against most of the user's events with nothing explaining it.
  //
  // fetchHistory tries DefiLlama plus the ECB's rates first and falls back
  // to CoinGecko for whatever is left. That ordering is what makes a report
  // over more than a year possible at all without a paid key: CoinGecko's
  // free tier refuses anything older than 365 days, and an acquisition
  // three years before its disposal is exactly the figure a cost basis
  // needs.
  const {
    prices: fetched,
    sources,
    failures,
  } = await fetchHistory(missing, currency, apiKey);

  // Still matches the CoinGecko path: with a key, no day is refused locally.
  const cutoff = apiKey ? Number.NEGATIVE_INFINITY : freeTierCutoff();
  for (const [assetId, days] of missing) {
    const failure = failures.get(assetId) ?? null;
    for (const date of days) {
      const key = pairKey(assetId, date);
      const price = fetched.get(key);
      if (price !== undefined) {
        const source = sources.get(key) ?? 'CoinGecko';
        await putCachedPrice({ assetId, currency, date }, price, source);
        results.set(key, { price, source });
        continue;
      }
      if (failure !== null) {
        results.set(key, { reason: describeFailure(failure, date) });
        continue;
      }
      // No failure, just no price for this day. A day older than the free
      // tier is never even requested of CoinGecko, so if the deeper source
      // had nothing either it gets the boundary's own message rather than a
      // vague "not covered".
      results.set(key, {
        reason:
          !isFiatAsset(assetId) && Date.parse(`${date}T00:00:00Z`) < cutoff
            ? freeTierReason()
            : {
                key: PRICE_REASON_KEYS[2],
                params: { asset: assetId, date },
              },
      });
    }
  }

  return results;
};

/**
 * Values each event in the base currency, at the price its asset had on
 * the UTC calendar day the event happened - not today's price. A trade
 * against fiat is valued at its `consideration`, the fiat amount actually
 * paid or received, converted at the ECB rate when it is not the base
 * currency.
 *
 * `fiat:{currency}` is resolved to exactly 1 before the cache or the
 * provider are even consulted, the same rule resolveSpotPrices already
 * applies: reporting a euro balance as unpriced would silently drop it
 * from a total.
 *
 * Every other (assetId, day) pair - the event's own asset and the asset
 * each of its costs was paid in - is deduplicated first and resolved once
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

  // Every (asset, day) pair the run needs, deduplicated: each event's own
  // asset and the asset each of its costs was paid in. Base fiat is 1 by
  // definition and is never requested - the same rule resolveSpotPrices
  // applies, because reporting a euro figure as unpriced would silently
  // drop it from a total.
  const pairs = new Map<string, { assetId: string; date: string }>();
  const need = (assetId: string, amount: string, timestamp: number): void => {
    if (assetId === baseFiatAssetId || isZeroAmount(amount)) {
      return;
    }
    const date = utcDay(timestamp);
    const key = pairKey(assetId, date);
    if (!pairs.has(key)) {
      pairs.set(key, { assetId, date });
    }
  };
  /** The asset and amount an event is valued BY: its consideration when
   *  the trade had a fiat side, otherwise its own leg. */
  const basisOf = (taxEvent: TaxEvent): { assetId: string; amount: string } =>
    taxEvent.consideration ?? {
      assetId: taxEvent.assetId,
      amount: taxEvent.amount,
    };

  for (const taxEvent of events) {
    const basis = basisOf(taxEvent);
    need(basis.assetId, basis.amount, taxEvent.timestamp);
    for (const cost of taxEvent.costs ?? []) {
      need(cost.assetId, cost.amount, taxEvent.timestamp);
    }
  }

  const results =
    pairs.size === 0
      ? new Map<string, DayResult>()
      : await lookUp(pairs, currency);

  /** The base-currency value of `amount` of `assetId` on the event's day,
   *  or the reason there is none. */
  const valueAt = (
    assetId: string,
    amount: string,
    timestamp: number,
  ): { value: string; source: string } | { reason: TaxReason } => {
    // Nothing is worth nothing on any day: a hard fork's zero cost basis
    // must not need a price source.
    if (isZeroAmount(amount)) {
      return { value: '0', source: BASE_SOURCE };
    }
    if (assetId === baseFiatAssetId) {
      return { value: normaliseAmount(amount), source: BASE_SOURCE };
    }
    const result = results.get(pairKey(assetId, utcDay(timestamp)));
    if (result && 'price' in result) {
      // Through valueOf, never a bare multiplication: the price is quoted
      // per WHOLE unit and the amount is in the asset's base unit, so the
      // per-asset scale has to be applied here. See src/prices/scale.ts.
      return {
        value: valueOf(amount, result.price, assetId),
        source: result.source,
      };
    }
    return {
      reason: result?.reason ?? {
        key: PRICE_REASON_KEYS[1],
        params: { asset: assetId },
      },
    };
  };

  const valued: TaxEvent[] = [];
  const unpriced: UnresolvedItem[] = [];

  for (const taxEvent of events) {
    // Valued at the consideration when there is one - the euro actually
    // paid or received - and never at the leg's market price in its place:
    // a consideration that cannot be priced is listed, because quietly
    // substituting the market value would bring back the spread the
    // consideration exists to remove.
    const basis = basisOf(taxEvent);
    const own = valueAt(basis.assetId, basis.amount, taxEvent.timestamp);
    if ('reason' in own) {
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
        reason: own.reason,
        resolutions: [{ kind: 'record-purchase', marketPriceAt: undefined }],
      });
      continue;
    }

    const priceSource =
      taxEvent.consideration === undefined
        ? own.source
        : `consideration · ${own.source}`;

    if (taxEvent.costs === undefined) {
      valued.push({ ...taxEvent, value: own.value, priceSource });
      continue;
    }

    const costs: TaxCost[] = taxEvent.costs.map((cost) => {
      const priced = valueAt(cost.assetId, cost.amount, taxEvent.timestamp);
      if ('value' in priced) {
        return { ...cost, value: priced.value };
      }
      // The event is still valued and returned; only the deduction is
      // missing. No `taxEventKind`, because a fee is not a disposal missing
      // from the gain figure, and no resolution, because recording a
      // purchase cannot price a fee. `subject` tells the reader it is the
      // deduction that is missing, not a second failed disposal.
      unpriced.push({
        kind: 'needs-price',
        subject: 'cost',
        sourceEventId: taxEvent.sourceEventId,
        assetId: cost.assetId,
        amount: cost.amount,
        venue: taxEvent.venue,
        timestamp: taxEvent.timestamp,
        reason: priced.reason,
        resolutions: [],
      });
      return cost;
    });

    valued.push({ ...taxEvent, value: own.value, priceSource, costs });
  }

  return { valued, unpriced };
};
