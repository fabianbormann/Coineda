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
      return Promise.reject(new UnexpectedEgressError(url.host));
    }
    return original(input, init);
  };
