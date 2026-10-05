import Big from 'big.js';
import { fetchHistoricalPrices } from './coingecko';
import { fetchUsdHistory, pairKey } from './defillama';
import { fetchUsdRates } from './ecb';

export { pairKey };

/**
 * Historical prices, from DefiLlama and the ECB first and CoinGecko second.
 *
 * The order is not a preference, it is the whole point. CoinGecko's free
 * tier refuses anything older than 365 days, which for a tax report is most
 * of it: a disposal in March is routinely matched against an acquisition
 * three years earlier, and that acquisition's cost basis is exactly the
 * figure the free tier will not serve. DefiLlama reaches back to at least
 * 2015 without a credential.
 *
 * CoinGecko stays as the fallback rather than being removed, for two
 * reasons. It quotes the base currency directly, so a day DefiLlama has but
 * the ECB does not - a long holiday gap - can still resolve. And a user who
 * has paid for a key should get what they paid for; this path uses it
 * exactly as before.
 *
 * Every failure is reported per asset, never swallowed: a provider outage
 * has to read as "could not be computed", not as "this is worth nothing".
 */
export type HistoryResult = {
  /** Keyed `assetId|YYYY-MM-DD`, in the requested currency. */
  prices: Map<string, string>;
  /** Per asset, the error from the LAST source that was tried for it, so a
   *  caller can explain why a day is missing. Absent when a source simply
   *  had no data, which is a different thing from a source that failed. */
  failures: Map<string, unknown>;
};

/**
 * Converts a USD quote into `currency` at that day's rate.
 *
 * Decimal multiplication through Big. Both inputs arrived as JSON numbers
 * and are already floats; this keeps the product from compounding that on
 * its way into the ledger's decimal strings.
 */
export const inCurrency = (usdPrice: string, rate: string): string =>
  new Big(usdPrice).times(new Big(rate)).toString();

export const fetchHistory = async (
  wanted: Map<string, string[]>,
  currency: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<HistoryResult> => {
  const prices = new Map<string, string>();
  const failures = new Map<string, unknown>();

  if (wanted.size === 0) {
    return { prices, failures };
  }

  const everyDay = [...new Set([...wanted.values()].flat())];

  // ONE request for every asset and every day, and ONE for the whole FX
  // span. A report that needed eighty days priced used to issue eighty
  // sequential requests.
  let usd = new Map<string, string>();
  let rates = new Map<string, string>();
  try {
    [usd, rates] = await Promise.all([
      fetchUsdHistory(wanted, signal),
      fetchUsdRates(everyDay, currency, signal),
    ]);
  } catch {
    // Either leg failing drops the whole primary path to the fallback, and
    // the error itself is deliberately dropped with it. A price without its
    // rate is not a price in the base currency - reporting a dollar figure
    // under a euro heading is the kind of wrong number nobody catches by
    // looking at it - and the fallback's own refusal is the explanation
    // worth showing. See the note in the fallback loop below.
  }

  for (const [assetId, dates] of wanted) {
    for (const date of dates) {
      const key = pairKey(assetId, date);
      const quote = usd.get(key);
      const rate = rates.get(date);
      if (quote !== undefined && rate !== undefined) {
        prices.set(key, inCurrency(quote, rate));
      }
    }
  }

  // Whatever is still missing goes to CoinGecko, per asset, exactly as
  // before. On a recent report this list is usually empty and no request is
  // made at all.
  for (const [assetId, dates] of wanted) {
    const outstanding = dates.filter(
      (date) => !prices.has(pairKey(assetId, date)),
    );
    if (outstanding.length === 0) {
      continue;
    }
    try {
      const fetched = await fetchHistoricalPrices(
        assetId,
        currency,
        outstanding,
        apiKey,
      );
      for (const [date, price] of fetched) {
        prices.set(pairKey(assetId, date), price);
      }
      // Deliberately NOT recording `primaryFailed` here when the fallback
      // merely came back short. CoinGecko declines a day older than its
      // free tier locally, without a request and without throwing, and the
      // caller turns that into "this needs an API key" - which is something
      // a person can act on. Reporting the deep source's HTTP status
      // instead, as an earlier version did, replaced that with
      // "DefiLlama answered with status 401" and told them nothing.
    } catch (error) {
      failures.set(assetId, error);
    }
  }

  return { prices, failures };
};
