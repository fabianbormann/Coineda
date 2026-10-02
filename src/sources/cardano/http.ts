import type { CardanoProvider } from './provider';
import { ACCOUNT_HISTORY_PAGE_SIZE, MAX_ACCOUNT_HISTORY_PAGES } from './cursor';

/**
 * Every provider request is given a deadline.
 *
 * Reported from real use, and the actual cause of a "sync that never
 * stops": a malformed host made the service accept the connection and
 * never answer. With no timeout anywhere, that one hanging fetch wedged the
 * whole sync - no error written to the source, no completion, the button
 * disabled forever. A provider that stops responding has to become a
 * visible error, not a permanent silence, and that is true of every module
 * rather than of one mistyped URL.
 *
 * Exported so tests/cardanoRequestDeadline.test.ts can assert the value
 * that reaches AbortSignal.timeout. Without that, removing the deadline
 * broke nothing in the suite.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The `name` of a thrown value, without assuming it is an `Error`.
 *
 * `instanceof Error` is not reliable here: under jsdom a `DOMException`
 * comes from a different realm and fails that check, so a timeout would
 * fall through to the generic path and surface as "The operation was
 * aborted" - a message that names no request and reads like a
 * cancellation the user never performed. The project hit the same realm
 * problem once already in the checkpoint code.
 */
export const errorName = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';

export const isTimeout = (error: unknown): boolean =>
  errorName(error) === 'TimeoutError';

/**
 * NEW. A caller's abort has to stay distinguishable from a provider
 * failure all the way up: src/sync/syncSource.ts reports `cancelled` for
 * one and writes `lastError` for the other, and a stop the user asked for
 * must not leave a red row.
 */
export const isAbortError = (error: unknown): boolean =>
  errorName(error) === 'AbortError';

/**
 * What one route answered, without throwing.
 *
 * `fetchJson` rejects on any non-ok status, which is right on the drain
 * path and wrong when the question IS the status: the tier procedure has to
 * tell "this instance does not serve this route" from "this address has no
 * history" from "the credential was refused", and all three arrive as
 * non-ok responses.
 */
export type RouteOutcome =
  | { outcome: 'ok'; body: unknown }
  | { outcome: 'status'; status: number }
  | { outcome: 'timeout' }
  | { outcome: 'unreachable' };

export const probeRoute = async (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<RouteOutcome> => {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: signalFor(signal) });
  } catch (error) {
    // A caller's abort is the one failure that must NOT be swallowed into
    // an outcome: src/sync/syncSource.ts reports `cancelled` for an
    // AbortError and writes lastError for everything else, so turning a
    // user's Stop into an outcome here would leave a red row behind.
    if (isAbortError(error)) {
      throw error;
    }
    if (isTimeout(error)) {
      return { outcome: 'timeout' };
    }
    return { outcome: 'unreachable' };
  }
  if (!response.ok) {
    return { outcome: 'status', status: response.status };
  }
  try {
    return { outcome: 'ok', body: await response.json() };
  } catch {
    // A 200 whose body is not JSON is a provider that answered with
    // something this module cannot use - not a route that exists.
    return { outcome: 'unreachable' };
  }
};

/**
 * The module's own deadline, combined with whatever the caller supplied.
 *
 * Both have to apply: the timeout ends a hang, and the caller's signal ends
 * a sync the user pressed stop on. Combining them here is what lets one
 * mechanism serve both, and keeps the two distinguishable afterwards - a
 * timeout aborts with `TimeoutError`, a caller with `AbortError`.
 */
export const signalFor = (external?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return external ? AbortSignal.any([external, timeout]) : timeout;
};

/**
 * NEW, replacing a regex match on a message.
 *
 * `probeCardano` used to recognise this failure with
 * `/the base URL|timed out/.test(error.message)`. A typed error is what the
 * project already chose for CoinGeckoHistoryError, for the stated reason
 * that branching on a status beats parsing prose - and it carries the
 * example host, which the probe needs to interpolate into a translated
 * message rather than ship an English sentence.
 */
export class HostShapeError extends Error {
  constructor(readonly exampleHost: string) {
    super(
      `cardano: the base URL should be the host only, without an API path - for example ${exampleHost}`,
    );
    this.name = 'HostShapeError';
  }
}

/**
 * Rejects a base URL that is already an API root.
 *
 * Nothing previously told the user whether this field wanted a host or a
 * full API root, and pasting the latter produced `host/api/v1/api/v1/...`
 * or, with a trailing slash, `host//api/v1/...` - which the live service
 * accepts and never answers. Saying what the field wants beats silently
 * building a path that hangs.
 */
export const assertHostOnly = (host: string, exampleHost: string): void => {
  if (/\/api(\/|$)/i.test(host)) {
    throw new HostShapeError(exampleHost);
  }
};

/**
 * The host, normalised.
 *
 * Trailing slashes are stripped because the API path is appended here: a
 * pasted `https://host/` would otherwise build `https://host//api/v1/...`,
 * and that URL hangs against the live service rather than failing. A
 * trailing slash on a pasted URL is completely ordinary, so tolerating it
 * is the module's job, not the user's.
 */
export const apiRoot = (
  provider: CardanoProvider,
  config: Record<string, string>,
): string => {
  const host = provider.host(config).trim().replace(/\/+$/, '');
  assertHostOnly(host, provider.exampleHost);
  return `${host}${provider.apiPath}`;
};

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

/**
 * A non-ok status from a drain request, as a TYPE rather than a sentence.
 *
 * The message is unchanged from the plain Error this replaces, because it
 * still reaches the user as `lastError`. What is new is that a caller can
 * branch on it: `fetchCardanoEvents` has to recognise "the account route
 * answered 404 while resuming a persisted cursor" in order to discard that
 * cursor and start over, and a regex over prose is exactly the fragility
 * `HostShapeError` and `probeMessage(status)` were both introduced to
 * replace.
 *
 * `what` is the caller's own label for the request - compared against the
 * shared constants in src/sources/cardano/account.ts, never parsed.
 */
export class RouteStatusError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
  ) {
    super(`cardano: ${what} failed with status ${status}`);
    this.name = 'RouteStatusError';
  }
}

/**
 * Names the request that failed and the status it returned - never the
 * credential it used, and never the config. See the error-message rule on
 * `SourceModule`: whatever this throws is stored verbatim as the source's
 * `lastError`, rendered on screen, and carried in the checkpoint.
 */
export const fetchJson = async <T>(
  url: string,
  what: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: signalFor(signal) });
  } catch (error) {
    // A timeout is the one failure worth renaming: the platform's own
    // message is "The operation was aborted", which tells a user nothing
    // about which request died or why, and reads like a cancellation they
    // did not perform.
    if (isTimeout(error)) {
      throw new Error(
        `cardano: ${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s - the instance accepted the connection but never answered`,
        // The original abort is kept as the cause: the message above is for
        // the user, and discarding what actually threw would leave nothing
        // to debug with if the rename ever hid a different failure.
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new RouteStatusError(what, response.status);
  }
  return (await response.json()) as T;
};
