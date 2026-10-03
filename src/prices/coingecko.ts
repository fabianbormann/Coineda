/**
 * CoinGecko is the only price provider. Native `fetch` only - `axios` was
 * removed from the project in Task 1.
 *
 * CoinGecko's "simple price" endpoint is keyed by its OWN coin ids
 * ('cardano', 'ethereum', ...), not by the ledger's chain-qualified asset
 * ids ('cardano:lovelace', 'eth:native', ...). This map is the single place
 * that translation happens. An asset absent from it is left out of the
 * request entirely, so the provider is never asked about it and it simply
 * never appears in the returned map - which is how an asset Coineda has no
 * mapping for flows through to `totalValue`'s `missing` list instead of
 * silently being priced at nothing.
 */
export const COINGECKO_IDS: Record<string, string> = {
  'cardano:lovelace': 'cardano',
  'bitcoin:native': 'bitcoin',
  'eth:native': 'ethereum',
};

const SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const HISTORY_URL = 'https://api.coingecko.com/api/v3/coins';

/**
 * Fetches spot prices for the given ledger asset ids, in the given
 * currency. Returns only the assets it could both map AND price - an
 * unmapped asset, or one CoinGecko did not return a price for, is simply
 * absent from the result rather than present with a placeholder value.
 *
 * Throws on a network or HTTP failure. Callers that must degrade to cached
 * data on a provider outage (see resolveSpotPrices) are responsible for
 * catching that, not this function - this function's only job is the HTTP
 * call and the id translation.
 */
export const fetchSpotPrices = async (
  assetIds: string[],
  currency: string,
): Promise<Map<string, string>> => {
  const assetsByCoinId = new Map<string, string>();
  for (const assetId of assetIds) {
    const coinId = COINGECKO_IDS[assetId];
    if (coinId) {
      assetsByCoinId.set(coinId, assetId);
    }
  }

  const result = new Map<string, string>();
  if (assetsByCoinId.size === 0) {
    return result;
  }

  const vsCurrency = currency.toLowerCase();
  const url =
    `${SIMPLE_PRICE_URL}?ids=${encodeURIComponent([...assetsByCoinId.keys()].join(','))}` +
    `&vs_currencies=${encodeURIComponent(vsCurrency)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko responded with ${response.status}`);
  }

  const body = (await response.json()) as Record<
    string,
    Record<string, number> | undefined
  >;

  for (const [coinId, assetId] of assetsByCoinId) {
    const price = body[coinId]?.[vsCurrency];
    if (price !== undefined) {
      result.set(assetId, String(price));
    }
  }

  return result;
};

/**
 * CoinGecko's history endpoint takes the date DAY-FIRST (dd-mm-yyyy) while
 * every date inside Coineda is ISO (YYYY-MM-DD). Converting these by hand
 * at each call site is how you eventually fetch 6 May for 5 June: the
 * response contains no date, so a swapped conversion returns a perfectly
 * valid price for the wrong day and nothing anywhere says so. One exported,
 * tested function, and a hard rejection of anything not ISO.
 */
export const toCoinGeckoDate = (isoDate: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    throw new Error(`expected an ISO date (YYYY-MM-DD) but got '${isoDate}'`);
  }
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
};

/**
 * Thrown by fetchHistoricalPrice on a non-ok response. Carries the HTTP
 * status as a field (not just in the message) so a caller like
 * resolveValues can tell a 401/403 - the free tier's "needs a paid key for
 * dates this old" answer - apart from every other failure without parsing
 * prose back out of an Error message.
 */
export class CoinGeckoHistoryError extends Error {
  readonly status: number;
  constructor(status: number, isoDate: string) {
    super(`CoinGecko history responded with ${status} for ${isoDate}`);
    this.name = 'CoinGeckoHistoryError';
    this.status = status;
  }
}

/**
 * How far back CoinGecko's keyless and demo tiers serve historical data.
 * Measured against the live API: a date inside the window answers 200, one
 * outside answers 401 with error_code 10012, "Public API users are limited
 * to querying historical data within the past 365 days".
 */
export const FREE_TIER_DAYS = 365;

const DAY_MS = 86_400_000;

/** The oldest instant the free tier will price, as epoch milliseconds. */
export const freeTierCutoff = (): number =>
  Date.now() - FREE_TIER_DAYS * DAY_MS;

/** A day is represented by its 00:00:00 UTC snapshot, which is what the
 *  per-day endpoint returned and therefore what every already-cached price
 *  means. */
const utcMidnight = (isoDate: string): number => {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`expected an ISO date (YYYY-MM-DD) but got '${isoDate}'`);
  }
  return parsed;
};

/**
 * How far from midnight a point may sit and still represent that day.
 *
 * Twelve hours, i.e. the nearest point wins but never one from a
 * neighbouring day. A gap in the series has to read as "no price for this
 * day" rather than as the nearest neighbour: quietly valuing Tuesday at
 * Friday's price is the kind of wrong number nobody would catch by looking
 * at it.
 */
const NEAREST_LIMIT_MS = 12 * 3_600_000;

/**
 * Fetches a price per day for one asset, for a whole set of days, in ONE
 * request.
 *
 * This replaces a loop over the per-day `/history` endpoint, and the reason
 * is not elegance. A real report needed 80 days priced, which meant 80
 * sequential requests; the keyless free tier answers 429 after about four,
 * and that 429 carries no `access-control-allow-origin` header - so the
 * browser cannot read the response and surfaces `TypeError: Failed to
 * fetch`. The user saw "Konnte nicht berechnet werden: Failed to fetch"
 * against most of their events and no explanation anywhere. One request
 * cannot be rate-limited into that.
 *
 * `market_chart/range` picks its own granularity - five-minutely within a
 * day, hourly up to 90 days, daily beyond - so one request covers any span
 * this app asks for, and each requested day takes the point nearest its UTC
 * midnight.
 *
 * Days older than the free tier are dropped from the request rather than
 * attempted: a span that starts before the cutoff fails ENTIRELY, which
 * would lose the recent days too. They are simply absent from the result,
 * and the caller says why.
 *
 * Returns an empty map, with no request made, for an asset absent from
 * COINGECKO_IDS - same rule as fetchSpotPrices and fetchHistoricalPrice.
 *
 * Throws CoinGeckoHistoryError on a non-ok response, carrying the status so
 * a caller can tell a rate limit from a missing key. The key travels only as
 * a header, never in the URL.
 */
export const fetchHistoricalPrices = async (
  assetId: string,
  currency: string,
  isoDates: string[],
  apiKey?: string,
): Promise<Map<string, string>> => {
  const prices = new Map<string, string>();
  const coinId = COINGECKO_IDS[assetId];
  if (!coinId || isoDates.length === 0) {
    return prices;
  }

  // The cutoff is applied only WITHOUT a key, and that asymmetry is the
  // point. A paid key serves full history, so filtering unconditionally
  // would deny a paying user data they are entitled to. Keyless, the span
  // is clamped instead - because a request starting before the cutoff fails
  // entirely and would lose the recent days with it.
  const cutoff = apiKey ? Number.NEGATIVE_INFINITY : freeTierCutoff();
  const wanted = [...new Set(isoDates)]
    .map((isoDate) => ({ isoDate, at: utcMidnight(isoDate) }))
    .filter((day) => day.at >= cutoff)
    .sort((a, b) => a.at - b.at);

  if (wanted.length === 0) {
    return prices;
  }

  // Padded by a day either side so the midnight points at both ends of the
  // span are inside the window the provider returns, rather than on its
  // boundary.
  const from = Math.floor(Math.max(wanted[0].at - DAY_MS, cutoff) / 1000);
  const to = Math.ceil((wanted[wanted.length - 1].at + DAY_MS) / 1000);

  const url = `${HISTORY_URL}/${coinId}/market_chart/range?vs_currency=${encodeURIComponent(
    currency.toLowerCase(),
  )}&from=${from}&to=${to}`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new CoinGeckoHistoryError(response.status, wanted[0].isoDate);
  }

  const body = (await response.json()) as { prices?: [number, number][] };
  const points = body.prices ?? [];
  if (points.length === 0) {
    return prices;
  }

  for (const day of wanted) {
    let best: { distance: number; price: number } | null = null;
    for (const [at, price] of points) {
      const distance = Math.abs(at - day.at);
      if (distance > NEAREST_LIMIT_MS) {
        continue;
      }
      if (best === null || distance < best.distance) {
        best = { distance, price };
      }
    }
    if (best !== null) {
      prices.set(day.isoDate, String(best.price));
    }
  }

  return prices;
};

/**
 * Fetches the price of one asset, in one currency, as CoinGecko recorded it
 * at 00:00:00 UTC on the given (ISO) day.
 *
 * Returns `null` immediately for an asset absent from COINGECKO_IDS - that
 * asset is never asked about and never priced, same rule as fetchSpotPrices.
 * Returns `null` when the response has no price for this currency, rather
 * than throwing, since that is a normal "not covered" answer.
 *
 * Throws on a non-ok response, naming the status and the date but NEVER the
 * API key - the key travels only as the x-cg-demo-api-key header, never in
 * the URL, so it cannot end up in provider logs or a proxy in between.
 */
export const fetchHistoricalPrice = async (
  assetId: string,
  currency: string,
  isoDate: string,
  apiKey?: string,
): Promise<string | null> => {
  const coinId = COINGECKO_IDS[assetId];
  if (!coinId) {
    return null;
  }

  const url = `${HISTORY_URL}/${coinId}/history?date=${toCoinGeckoDate(isoDate)}&localization=false`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new CoinGeckoHistoryError(response.status, isoDate);
  }

  const body = (await response.json()) as {
    market_data?: { current_price?: Record<string, number> };
  };
  const price = body.market_data?.current_price?.[currency.toLowerCase()];
  return price === undefined ? null : String(price);
};
