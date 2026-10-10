/**
 * The test-time egress guard.
 *
 * `tests/setup.ts` replaces `globalThis.fetch` with `guardFetch(original)`,
 * which refuses any `http:`/`https:` request whose host a test has not named
 * via `allowHosts(...)`. A test that reaches a real host by accident - a
 * forgotten stub, a new code path that fetches - fails loudly with the host
 * in the message instead of quietly depending on the network.
 *
 * Tests that stub fetch themselves (`vi.stubGlobal('fetch', ...)` or a
 * direct assignment) never reach the guard, and `vi.unstubAllGlobals()`
 * restores the guard, not the platform fetch, because the guard is what was
 * installed when they stubbed. Non-http(s) schemes (`data:`, `blob:`) pass
 * through to the original fetch: they never leave the process.
 *
 * Rejecting is not enough on its own: the price store, the token-meta store
 * and the history fetcher all swallow a failed fetch, so a refused request
 * inside one of them would leave the test green. The guard therefore also
 * RECORDS every refused URL, and the `afterEach` in `tests/setup.ts` calls
 * `checkEgressRefusals()`, which fails the test while the list is non-empty
 * (naming the URLs) and then clears it. A test that provokes a refusal on
 * purpose calls `expectEgressRefusals()` first. A late fetch left over from
 * a previous test is recorded too, and fails the test it lands in.
 */

export class UnexpectedEgressError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(
      `Unexpected egress to ${host}: stub fetch or call allowHosts('${host}') in the test.`,
    );
    this.name = 'UnexpectedEgressError';
    this.host = host;
  }
}

const allowed = new Set<string>();
const refused: string[] = [];
let refusalsExpected = false;

/** Lets the current test reach these hosts (`host`, port included). Cleared
 *  after every test by `resetAllowedHosts`. */
export const allowHosts = (...hosts: string[]): void => {
  for (const host of hosts) {
    allowed.add(host);
  }
};

export const resetAllowedHosts = (): void => {
  allowed.clear();
};

/** The current test provokes refusals on purpose: `checkEgressRefusals`
 *  then clears them without failing. Reset by that check. */
export const expectEgressRefusals = (): void => {
  refusalsExpected = true;
};

/** Throws, listing every URL the guard refused since the last check, unless
 *  the test called `expectEgressRefusals()`. Always clears the list and the
 *  expectation, so one failure does not cascade into the next test. */
export const checkEgressRefusals = (): void => {
  const urls = refused.splice(0);
  const expected = refusalsExpected;
  refusalsExpected = false;
  if (urls.length > 0 && !expected) {
    throw new Error(
      `The egress guard refused ${urls.length} request(s) during this test, ` +
        `even if the code under test caught the error: ${urls.join(', ')}. ` +
        'Stub fetch, call allowHosts(...), or expectEgressRefusals() if the refusal is the point.',
    );
  }
};

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

/** Wraps `original` so that unregistered http(s) hosts reject. */
export const guardFetch =
  (original: typeof fetch): typeof fetch =>
  (input, init) => {
    let url: URL | null = null;
    try {
      url = new URL(urlOf(input), globalThis.location?.href);
    } catch {
      // Unparsable: let the original fetch reject it as it would.
    }
    if (
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !allowed.has(url.host)
    ) {
      refused.push(url.href);
      return Promise.reject(new UnexpectedEgressError(url.host));
    }
    return original(input, init);
  };
