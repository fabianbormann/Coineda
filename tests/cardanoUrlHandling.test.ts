import { describe, it, expect, beforeEach, vi } from 'vitest';
import cardanoYaci from '@/sources/cardano-yaci';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';

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
    // address that cannot work for the module they are configuring.
    const blockfrost = await cardanoBlockfrost.probe({
      baseUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      projectId: 'k',
      address: ADDRESS,
    });
    expect(blockfrost.ok).toBe(false);
    expect(blockfrost.message).toContain('blockfrost.io');
    expect(blockfrost.message).not.toContain('yaci');

    const yaci = await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org/api/v1',
      address: ADDRESS,
    });
    expect(yaci.ok).toBe(false);
    expect(yaci.message).toContain('yaci-store');
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
    await cardanoYaci.probe({
      baseUrl: 'https://yaci.example.org',
      address: ADDRESS,
    });
    expect(calls[0].url).toBe('https://yaci.example.org/api/v1/blocks/latest');
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

  it('reports a timed-out request as a timeout, not as an unknown failure', async () => {
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
    ).rejects.toThrow(/timed out|timeout/i);
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
