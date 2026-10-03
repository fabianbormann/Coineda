/**
 * Chain-agnostic HTTP plumbing shared by every source module.
 *
 * Originally lived entirely in src/sources/cardano/http.ts. Of its twelve
 * exports, eleven have nothing Cardano-specific about them - a deadline, an
 * abort/timeout distinction, a generic "probe a route without throwing" and
 * "fetch JSON or throw a typed status error" pair - and the Esplora module
 * needs exactly that plumbing, not a second hand-written copy of it. Only
 * `drainPagedRoute` stayed behind: it encodes Blockfrost/Yaci's
 * `page`/`count`/`order` paging convention, which Esplora's cursor-based
 * paging does not use at all.
 *
 * src/sources/cardano/http.ts re-exports everything below, so no Cardano
 * import line changes and no Cardano test is affected by the move.
 */

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
 * A caller's abort has to stay distinguishable from a provider failure all
 * the way up: src/sync/syncSource.ts reports `cancelled` for one and writes
 * `lastError` for the other, and a stop the user asked for must not leave a
 * red row.
 */
export const isAbortError = (error: unknown): boolean =>
  errorName(error) === 'AbortError';

/**
 * What one route answered, without throwing.
 *
 * `fetchJson` rejects on any non-ok status, which is right on the drain
 * path and wrong when the question IS the status: a probe has to tell
 * "this instance/route does not serve this" from "this address has no
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
 * Rejects a base URL that is already an API root.
 *
 * Nothing previously told the user whether a host field wanted a bare host
 * or a full API root, and pasting the latter produced `host/api/v1/api/v1/...`
 * or, with a trailing slash, `host//api/v1/...` - which a live service
 * accepts and never answers. Saying what the field wants beats silently
 * building a path that hangs.
 *
 * `label` names the calling chain ('cardano', 'bitcoin', ...) and is
 * folded into the message, the same way `amountString` (src/sources/amount.ts)
 * takes a chain name rather than hardcoding one. Cardano's own
 * src/sources/cardano/http.ts binds this to 'cardano' so every existing
 * message - and the tests that assert on it verbatim - stays byte-identical.
 */
export class HostShapeError extends Error {
  constructor(
    readonly exampleHost: string,
    label: string,
  ) {
    super(
      `${label}: the base URL should be the host only, without an API path - for example ${exampleHost}`,
    );
    this.name = 'HostShapeError';
  }
}

export const assertHostOnly = (
  host: string,
  exampleHost: string,
  label: string,
): void => {
  if (/\/api(\/|$)/i.test(host)) {
    throw new HostShapeError(exampleHost, label);
  }
};

/** The minimal shape `apiRoot` needs from a provider description: a host
 *  resolver, the API path segment to append, and an example host for the
 *  host-shape complaint. A chain's own provider type (e.g. CardanoProvider)
 *  satisfies this structurally - it just carries more fields besides. */
export type ApiRootProvider = {
  /** Host only, no trailing slash - the API path is added here. */
  host: (config: Record<string, string>) => string;
  /** The provider's API root segment, e.g. '/api/v1' or '/api/v0'. */
  apiPath: string;
  /** A valid host for this provider, named in the "the base URL should be
   *  the host only" complaint. */
  exampleHost: string;
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
  provider: ApiRootProvider,
  config: Record<string, string>,
  label: string,
): string => {
  const host = provider.host(config).trim().replace(/\/+$/, '');
  assertHostOnly(host, provider.exampleHost, label);
  return `${host}${provider.apiPath}`;
};

/**
 * A non-ok status from a drain request, as a TYPE rather than a sentence.
 *
 * What is new over a plain Error is that a caller can branch on it: Cardano's
 * `fetchCardanoEvents` has to recognise "the account route answered 404
 * while resuming a persisted cursor" in order to discard that cursor and
 * start over, and a regex over prose is exactly the fragility this and
 * `HostShapeError` both exist to replace.
 *
 * `what` is the caller's own label for the request - compared against
 * shared constants, never parsed. `label` is the calling chain, folded into
 * the message the same way `HostShapeError` takes one - see its doc comment.
 */
export class RouteStatusError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    label: string,
  ) {
    super(`${label}: ${what} failed with status ${status}`);
    this.name = 'RouteStatusError';
  }
}

/**
 * Names the request that failed and the status it returned - never the
 * credential it used, and never the config. See the error-message rule on
 * `SourceModule` (src/sources/types.ts): whatever this throws is stored
 * verbatim as the source's `lastError`, rendered on screen, and carried in
 * the checkpoint.
 *
 * `label` is the calling chain, folded into both messages below - see
 * `HostShapeError`'s doc comment for why this takes a parameter rather than
 * hardcoding one.
 */
export const fetchJson = async <T>(
  url: string,
  what: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
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
        `${label}: ${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s - the instance accepted the connection but never answered`,
        // The original abort is kept as the cause: the message above is for
        // the user, and discarding what actually threw would leave nothing
        // to debug with if the rename ever hid a different failure.
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new RouteStatusError(what, response.status, label);
  }
  return (await response.json()) as T;
};
