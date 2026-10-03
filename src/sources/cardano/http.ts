import type { CardanoProvider } from './provider';
import { ACCOUNT_HISTORY_PAGE_SIZE, MAX_ACCOUNT_HISTORY_PAGES } from './cursor';
import {
  apiRoot as genericApiRoot,
  assertHostOnly as genericAssertHostOnly,
  fetchJson as genericFetchJson,
} from '@/sources/http';

/**
 * Cardano's binding onto the chain-agnostic HTTP plumbing in
 * src/sources/http.ts.
 *
 * Eleven of the twelve exports this file used to hold moved there outright -
 * a deadline, the realm-safe abort/timeout distinction, `probeRoute`,
 * `fetchJson`, the host-shape guard and friends - because none of them have
 * anything Cardano-specific about them and the Esplora module needs the same
 * plumbing rather than a second hand-written copy of it. Only
 * `drainPagedRoute` stayed: it encodes Blockfrost/Yaci's
 * `page`/`count`/`order` paging convention, which no other provider in this
 * codebase uses.
 *
 * Every re-export below keeps the exact name AND the exact call signature
 * Cardano's own files already use, so not one import line in translator.ts,
 * tier.ts, account.ts or pot.ts changes. The three that carry a 'cardano:'
 * prefix in their thrown message (`fetchJson`, `apiRoot`/`assertHostOnly`'s
 * `HostShapeError`) are thin wrappers binding that label, the same pattern
 * `amountString` uses in ./utxo.ts - so a message like
 * "cardano: listing transactions failed with status 404", which
 * tests/mainScreen.test.tsx asserts on verbatim, is unchanged.
 */
export {
  REQUEST_TIMEOUT_MS,
  errorName,
  isTimeout,
  isAbortError,
  probeRoute,
  signalFor,
  HostShapeError,
  RouteStatusError,
} from '@/sources/http';
export type { RouteOutcome } from '@/sources/http';

export const assertHostOnly = (host: string, exampleHost: string): void =>
  genericAssertHostOnly(host, exampleHost, 'cardano');

export const apiRoot = (
  provider: CardanoProvider,
  config: Record<string, string>,
): string => genericApiRoot(provider, config, 'cardano');

export const fetchJson = <T>(
  url: string,
  what: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> => genericFetchJson<T>(url, what, headers, signal, 'cardano');

/**
 * Every row of a paginated account-level route.
 *
 * The same loop shape `fetchAddressSet` uses, with the same
 * bound-and-throw guard, and for the same reason: `/rewards` and
 * `/withdrawals` were requested with no paging at all, which truncated at
 * the provider's default page size and dropped the most recent rows - the
 * ones a tax report is about.
 *
 * Lives here rather than in the translator so the two callers that need it
 * (the translator's rewards fetch and the reward pot's withdrawals fetch)
 * do not have to import each other.
 */
export const drainPagedRoute = async <T>(
  urlFor: (page: number) => string,
  what: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T[]> => {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_ACCOUNT_HISTORY_PAGES; page += 1) {
    const batch = await fetchJson<T[]>(urlFor(page), what, headers, signal);
    rows.push(...batch);
    // A short page is the last page. Both providers page this way, and it
    // is what `fetchAddressSet` already relies on.
    if (batch.length < ACCOUNT_HISTORY_PAGE_SIZE) {
      return rows;
    }
  }
  // Names the bound, never the account - see the error-message rule on
  // SourceModule.
  throw new Error(
    `cardano: ${what} returned more than ${MAX_ACCOUNT_HISTORY_PAGES * ACCOUNT_HISTORY_PAGE_SIZE} rows, which is beyond what this module will enumerate`,
  );
};
