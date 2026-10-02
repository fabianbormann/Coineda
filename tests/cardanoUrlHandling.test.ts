import { describe, it, expect, beforeEach, vi } from 'vitest';
import cardanoYaci from '@/sources/cardano-yaci';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';

const ADDRESS = 'addr_test1_fixture';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];

const stubOk = (body: unknown = []) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Behave like real fetch: reject when the signal is already aborted.
      // A stub that ignores the signal makes any cancellation test pass
      // whether or not the signal was ever wired up.
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
};

beforeEach(() => {
  stubOk();
});

describe('base URL handling', () => {
  it('does not double the slash when the pasted URL ends in one', async () => {
    // Reported from real use: pasting the host with a trailing slash built
    // `host//api/v1/...`, and that URL does not 404 against the live
    // service - it HANGS. A silent hang is the worst possible response to
    // a perfectly reasonable paste.
    await cardanoYaci.fetchEvents(
      { baseUrl: 'https://yaci.example.org/', address: ADDRESS },
      null,
    );
    expect(calls[0].url).toContain('/api/v1/addresses/');
    expect(calls[0].url).not.toContain('//api/');
  });

  it('tolerates several trailing slashes', async () => {
    await cardanoYaci.fetchEvents(
      { baseUrl: 'https://yaci.example.org///', address: ADDRESS },
      null,
    );
    expect(calls[0].url).not.toContain('//api/');
  });

  it('tolerates surrounding whitespace from a paste', async () => {
    await cardanoYaci.fetchEvents(
      { baseUrl: '  https://yaci.example.org/  ', address: ADDRESS },
      null,
    );
    expect(calls[0].url.startsWith('https://yaci.example.org/api/v1/')).toBe(
      true,
    );
  });

  it('strips the trailing slash for Blockfrost too', async () => {
    await cardanoBlockfrost.fetchEvents(
      {
        baseUrl: 'https://cardano-preprod.blockfrost.io/',
        projectId: 'k',
        address: ADDRESS,
      },
      null,
    );
    expect(calls[0].url).not.toContain('//api/');
    expect(calls[0].url).toContain('/api/v0/addresses/');
  });

  it('refuses a URL that already contains the API path, with a message saying what it wants', async () => {
    // The other half of the same report: nothing told the user whether the
    // field wanted a host or a full API root. Rather than silently build a
    // doubled path, say so.
    const result = await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org/api/v1',
      address: ADDRESS,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/api/i);
  });

  it('names a host the user is actually configuring, not the other provider’s', async () => {
    // The message suggested a Yaci Store URL on every row, including a
    // Blockfrost one - sending the user to fix their configuration with an
    // address that cannot work for the module they are configuring. The
    // example host now travels in messageParams, because a per-provider
    // English sentence built by concatenation is a sentence no locale file
    // can translate.
    const blockfrost = await cardanoBlockfrost.probe({
      baseUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      projectId: 'k',
      address: ADDRESS,
    });
    expect(blockfrost.ok).toBe(false);
    expect(blockfrost.message).toBe(CARDANO_MESSAGES.hostShape);
    expect(blockfrost.messageParams?.example).toContain('blockfrost.io');
    expect(blockfrost.messageParams?.example).not.toContain('yaci');

    const yaci = await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org/api/v1',
      address: ADDRESS,
    });
    expect(yaci.ok).toBe(false);
    expect(yaci.message).toBe(CARDANO_MESSAGES.hostShape);
    expect(yaci.messageParams?.example).toContain('yaci-store');
  });

  it('refuses an API path with a trailing slash as well', async () => {
    const result = await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org/api/v1/',
      address: ADDRESS,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses to sync a URL it would refuse to probe', async () => {
    // probe is not on the path syncSource takes, so a guard that only
    // lives there protects nothing on a refresh.
    await expect(
      cardanoYaci.fetchEvents(
        { baseUrl: 'https://yaci.example.org/api/v1', address: ADDRESS },
        null,
      ),
    ).rejects.toThrow(/api/i);
  });

  it('accepts a bare host unchanged', async () => {
    // Re-pointed at /addresses/{addr}, which is the first request the probe
    // now makes. /blocks/latest is deliberately gone: it reported an
    // instance alive without saying whether it could serve THIS source,
    // which is how a never-seen address got past the probe and failed the
    // drain with a bare "status 404". The host assembly this test exists
    // for is unchanged - it is still the probe's very first URL.
    await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org',
      address: ADDRESS,
    });
    expect(calls[0].url).toBe(
      `https://yaci.example.org/api/v1/addresses/${ADDRESS}`,
    );
  });
});

describe('request timeouts', () => {
  it('gives every request a signal, so nothing can hang forever', async () => {
    // The actual cause of the reported silent failure: no provider request
    // had any timeout, so one hanging fetch wedged the whole sync with no
    // error written and no completion. That is a defect in every module,
    // not just a mistyped URL.
    await cardanoYaci.fetchEvents(
      { baseUrl: 'https://yaci.example.org', address: ADDRESS },
      null,
    );
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('gives probe a signal too', async () => {
    await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org',
      address: ADDRESS,
    });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports an instance that times out before it can be resolved, not an unknown failure', async () => {
    // A timeout on the FIRST request now arrives while the tier is still
    // being resolved, and probeRoute turns it into an outcome rather than
    // an exception - so the sync fails with the translated "this instance
    // cannot serve you" key instead of the raw rename. Asserted as the
    // exact key, because an untranslated English sentence reaching
    // lastError is what CARDANO_MESSAGES exists to prevent.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'TimeoutError');
      }),
    );

    await expect(
      cardanoYaci.fetchEvents(
        { baseUrl: 'https://yaci.example.org', address: ADDRESS },
        null,
      ),
    ).rejects.toThrow(CARDANO_MESSAGES.instanceCannotServe);
  });

  it('still renames a timeout that strikes after the instance passed the tier check', async () => {
    // The other half, and the one the reported hang actually was: an
    // instance that answers, is accepted, and then stops answering
    // mid-drain. That timeout reaches fetchJson, which names the request
    // and the deadline. Without this the rename has no test left at all -
    // every other timeout test now fails during tier resolution instead,
    // where probeRoute swallows the error by design.
    let answered = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        answered += 1;
        // 1: the plain lookup native Yaci has no route for. 2: the listing
        // the tier check makes, which is the drain's own first URL. 3: the
        // drain re-requesting it - and that is where the instance dies.
        if (answered > 2) {
          throw new DOMException('The operation was aborted.', 'TimeoutError');
        }
        return new Response(JSON.stringify([]), {
          status: answered === 1 ? 404 : 200,
        });
      }),
    );

    await expect(
      cardanoYaci.fetchEvents(
        { baseUrl: 'https://yaci.example.org', address: ADDRESS },
        null,
      ),
    ).rejects.toThrow(/listing transactions timed out after 20s/);
  });

  it('reports a timed-out probe in a form the user can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'TimeoutError');
      }),
    );

    const result = await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org',
      address: ADDRESS,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('honours a caller-supplied signal alongside its own timeout', async () => {
    // Both must apply: the timeout stops a hang, the caller's signal stops
    // a sync the user asked to stop. Combining them is what lets one
    // mechanism serve both.
    const controller = new AbortController();
    controller.abort();

    await expect(
      cardanoYaci.fetchEvents(
        { baseUrl: 'https://yaci.example.org', address: ADDRESS },
        null,
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
