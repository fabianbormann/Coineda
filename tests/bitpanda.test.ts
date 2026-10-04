import { describe, it, expect, afterEach, vi } from 'vitest';
import bitpanda from '@/sources/bitpanda';
import {
  BITPANDA_MESSAGES,
  decodeCursor,
  encodeCursor,
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
      return rest();
    }),
  );
  return seen;
};

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
  /** Narrows the three-way result to the event, failing the test rather
   *  than the type checker when a row was passed over. */
  const eventOf = (result: ReturnType<typeof tradeToEvent>) => {
    if ('unsupported' in result || 'skipped' in result) {
      throw new Error(`expected an event, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  const row = (attributes: Record<string, unknown>) => ({
    id: 'trade-1',
    attributes: {
      status: 'finished',
      type: 'buy',
      amount_cryptocoin: '0.5',
      amount_fiat: '100.25',
      cryptocoin_symbol: 'BTC',
      fiat_to_eur_rate: '1.00000000',
      time: { unix: '1700000000' },
      ...attributes,
    },
  });

  it('converts whole units to base units on the way in', () => {
    const event = eventOf(tradeToEvent(row({})));
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
    const event = eventOf(tradeToEvent(row({ type: 'sell' })));
    expect(event.legs[0].direction).toBe('out');
    expect(event.legs[1].direction).toBe('in');
  });

  it('reports an asset it cannot name rather than guessing one', () => {
    // Bitpanda sells gold, silver, platinum and palladium alongside 880
    // symbols of crypto. Guessing an asset id merges two different
    // positions into one, silently.
    // Measured against the owner's own account: of twelve trades, one is
    // NIGHT, which this app cannot scale or price. Gold is the other shape
    // of the same problem - Bitpanda sells it alongside 880 crypto symbols.
    expect(tradeToEvent(row({ cryptocoin_symbol: 'XAU' }))).toEqual({
      unsupported: 'XAU',
    });
    expect(tradeToEvent(row({ cryptocoin_symbol: 'NIGHT' }))).toEqual({
      unsupported: 'NIGHT',
    });
  });

  it('passes over a trade that never settled', () => {
    // Only a settled trade is a movement. Recording a pending or cancelled
    // row gives the user a holding they do not have, and a disposal they
    // never made. Every row in the owner's account reads 'finished', so
    // this is exactly the case real data could not have caught.
    expect(tradeToEvent(row({ status: 'pending' }))).toEqual({
      skipped: 'trade-1 is pending',
    });
    expect(tradeToEvent(row({ status: 'cancelled' }))).toEqual({
      skipped: 'trade-1 is cancelled',
    });
  });

  it('records the fiat leg only when the rate says it is euro', () => {
    // The row carries no fiat SYMBOL, only a numeric fiat_id that needs
    // masterdata - which a read-scoped key cannot read. fiat_to_eur_rate of
    // exactly 1 identifies euro without resolving anything; any other rate
    // is some other currency, and naming it anyway would put a figure in
    // the wrong denomination into a tax report.
    const euro = eventOf(tradeToEvent(row({})));
    expect(euro.legs).toHaveLength(2);

    const other = eventOf(tradeToEvent(row({ fiat_to_eur_rate: '0.92' })));
    expect(other.legs).toHaveLength(1);
    expect(other.legs[0].assetId).toBe('bitcoin:native');
  });

  it('names the fields it actually received when the shape surprises it', () => {
    // The payload shape is unverified. This is the difference between a
    // first run that tells us what Bitpanda really sends and one that says
    // "undefined is not an object".
    let message = '';
    try {
      tradeToEvent({ id: 'x', attributes: { foo: 1, bar: 2 } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('foo');
    expect(message).toContain('bar');
  });

  it('reads a time given only as an ISO string', () => {
    const event = eventOf(
      tradeToEvent(row({ time: { date_iso8601: '2026-01-15T12:00:00Z' } })),
    );
    expect(event.timestamp).toBe(Date.parse('2026-01-15T12:00:00Z'));
  });

  it('stamps milliseconds from a unix second', () => {
    const event = eventOf(tradeToEvent(row({})));
    expect(event.timestamp).toBe(1_700_000_000_000);
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
