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
const COINGECKO_IDS: Record<string, string> = {
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
