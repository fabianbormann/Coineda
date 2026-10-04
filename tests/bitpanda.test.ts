import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bitpanda from '@/sources/bitpanda';
import {
  BITPANDA_MESSAGES,
  clearMasterdataCache,
  decodeCursor,
  encodeCursor,
  fetchSymbols,
  isCloudflareBlock,
  tradeToEvent,
} from '@/sources/bitpanda/translator';

/**
 * Bitpanda, written against a measured 401 and the provider's documentation
 * - never against a real response, because an exchange has no public data
 * and recording one means recording somebody's account.
 *
 * So these tests pin the two things that do not depend on the payload being
 * what I think it is: that each failure is reported as its own cause, and
 * that an unrecognised payload says what it actually received. The second is
 * the point - the first run against a real key should produce a precise bug
 * report rather than "undefined is not an object".
 */
const KEY = 'test-key';

const masterdata = {
  data: {
    attributes: {
      cryptocoins: [
        { id: '1', attributes: { symbol: 'BTC' } },
        { id: '5', attributes: { symbol: 'ADA' } },
        { id: '9', attributes: { symbol: 'XAU' } },
      ],
    },
  },
};

const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

/** Serves masterdata for the masterdata route and `rest` for anything else. */
const stub = (rest: () => Response) => {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('/masterdata')) {
        return respond(200, masterdata);
      }
      return rest();
    }),
  );
  return seen;
};

beforeEach(() => clearMasterdataCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('telling the failures apart', () => {
  it('knows Cloudflare from a bad key', () => {
    // Different causes, different actions: one means check your key, the
    // other means wait. Bitpanda sits behind bot protection that answers
    // 403 with `error code: 1010` BEFORE auth is considered, which is what
    // a non-browser client sees - including the fixture recorder.
    expect(isCloudflareBlock(403, 'error code: 1010')).toBe(true);
    expect(isCloudflareBlock(403, '<html>error code: 1020</html>')).toBe(true);
    expect(isCloudflareBlock(403, '{"errors":[{"code":"unauthorized"}]}')).toBe(
      false,
    );
    expect(isCloudflareBlock(401, 'error code: 1010')).toBe(false);
  });

  it('refuses to probe without a key, without asking anybody', async () => {
    const seen = stub(() => respond(200, { data: [] }));
    const result = await bitpanda.probe({});
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITPANDA_MESSAGES.missingKey);
    expect(seen).toEqual([]);
  });

  it('reports a rejected key as a key problem', async () => {
    stub(() => respond(401, { errors: [{ code: 'unauthorized' }] }));
    const result = await bitpanda.probe({ apiKey: KEY });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITPANDA_MESSAGES.rejectedKey);
  });

  it('reports a Cloudflare block as bot protection, not a key problem', async () => {
    stub(() => respond(403, 'error code: 1010'));
    const result = await bitpanda.probe({ apiKey: KEY });
    expect(result.message).toBe(BITPANDA_MESSAGES.cloudflare);
    expect(result.message).not.toBe(BITPANDA_MESSAGES.rejectedKey);
  });

  it('probes the route the drain depends on, not a liveness route', async () => {
    const seen = stub(() => respond(200, { data: [] }));
    await bitpanda.probe({ apiKey: KEY });
    expect(seen.some((url) => url.includes('/trades'))).toBe(true);
  });

  it('leaves readOnly undefined, because Bitpanda does not say', async () => {
    // The "provider gives no way to tell" case, which the Add dialog
    // already handles and already has a test for. Claiming readOnly true
    // here would be a guess about somebody's key permissions.
    stub(() => respond(200, { data: [] }));
    const result = await bitpanda.probe({ apiKey: KEY });
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBeUndefined();
  });

  it('never puts the key in a message', async () => {
    for (const status of [401, 403, 500]) {
      stub(() => respond(status, 'error code: 1010'));
      const result = await bitpanda.probe({ apiKey: 'super-secret-key' });
      expect(result.message ?? '').not.toContain('super-secret-key');
    }
  });
});

describe('reading a trade', () => {
  const symbols = new Map([
    ['1', 'BTC'],
    ['9', 'XAU'],
  ]);

  const row = (attributes: Record<string, unknown>) => ({
    id: 'trade-1',
    attributes: {
      type: 'buy',
      amount_cryptocoin: '0.5',
      amount_fiat: '100.25',
      cryptocoin_id: '1',
      time: { unix: '1700000000' },
      ...attributes,
    },
  });

  it('converts whole units to base units on the way in', () => {
    const event = tradeToEvent(row({}), symbols);
    expect('unsupported' in event).toBe(false);
    if ('unsupported' in event) return;
    // 0.5 BTC is 50000000 satoshis. Storing 0.5 understates the position a
    // hundred million fold, which is the whole reason this module has a
    // separate unit boundary.
    expect(event.legs[0]).toMatchObject({
      assetId: 'bitcoin:native',
      amount: '50000000',
      direction: 'in',
      venue: 'bitpanda',
    });
    // The fiat side is what makes it a trade rather than a transfer, and
    // keeps its cents.
    expect(event.legs[1]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '100.25',
      direction: 'out',
    });
  });

  it('turns a sell around', () => {
    const event = tradeToEvent(row({ type: 'sell' }), symbols);
    if ('unsupported' in event) throw new Error('expected an event');
    expect(event.legs[0].direction).toBe('out');
    expect(event.legs[1].direction).toBe('in');
  });

  it('reports an asset it cannot name rather than guessing one', () => {
    // Bitpanda sells gold, silver, platinum and palladium alongside 880
    // symbols of crypto. Guessing an asset id merges two different
    // positions into one, silently.
    expect(tradeToEvent(row({ cryptocoin_id: '9' }), symbols)).toEqual({
      unsupported: 'XAU',
    });
    expect(tradeToEvent(row({ cryptocoin_id: '404' }), symbols)).toEqual({
      unsupported: 'cryptocoin_id 404',
    });
  });

  it('names the fields it actually received when the shape surprises it', () => {
    // The payload shape is unverified. This is the difference between a
    // first run that tells us what Bitpanda really sends and one that says
    // "undefined is not an object".
    let message = '';
    try {
      tradeToEvent({ id: 'x', attributes: { foo: 1, bar: 2 } }, symbols);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('foo');
    expect(message).toContain('bar');
  });

  it('reads a time given only as an ISO string', () => {
    const event = tradeToEvent(
      row({ time: { date_iso8601: '2026-01-15T12:00:00Z' } }),
      symbols,
    );
    if ('unsupported' in event) throw new Error('expected an event');
    expect(event.timestamp).toBe(Date.parse('2026-01-15T12:00:00Z'));
  });

  it('stamps milliseconds from a unix second', () => {
    const event = tradeToEvent(row({}), symbols);
    if ('unsupported' in event) throw new Error('expected an event');
    expect(event.timestamp).toBe(1_700_000_000_000);
  });
});

describe('masterdata', () => {
  it('builds the id to symbol map the trade rows need', async () => {
    stub(() => respond(200, { data: [] }));
    const symbols = await fetchSymbols(KEY);
    expect(symbols.get('1')).toBe('BTC');
    expect(symbols.get('5')).toBe('ADA');
  });

  it('is fetched once per key, not once per page', async () => {
    const seen = stub(() => respond(200, { data: [] }));
    await fetchSymbols(KEY);
    await fetchSymbols(KEY);
    expect(seen.filter((url) => url.includes('/masterdata'))).toHaveLength(1);
  });

  it('says so loudly when it cannot read any symbols', async () => {
    // An empty map would make every row "unsupported asset", which reads as
    // "Bitpanda has nothing importable" when the truth is that this parser
    // did not understand the response.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { data: { attributes: { odd: [] } } })),
    );
    await expect(fetchSymbols(KEY)).rejects.toThrow(/odd/);
  });
});

describe('the cursor', () => {
  it('round-trips a page', () => {
    expect(decodeCursor(encodeCursor(4))).toBe(4);
  });

  it('starts over on anything it does not recognise', () => {
    for (const cursor of [null, 'nonsense', 'bitpanda:', 'btc:0:0:0:']) {
      expect(decodeCursor(cursor)).toBe(1);
    }
  });
});
