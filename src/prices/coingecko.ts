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
