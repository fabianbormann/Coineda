import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Big from 'big.js';
import bitpanda from '@/sources/bitpanda';
import {
  BITPANDA_MESSAGES,
  decodeCursor,
  encodeCursor,
  isCloudflareBlock,
  movementToEvent,
} from '@/sources/bitpanda/translator';
import { NIGHT_ASSET_ID, decimalsOf } from '@/prices/scale';
import { foldHoldings, ownedVenuesOf } from '@/ledger/balances';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Bitpanda, draining /wallets/transactions.
 *
 * The route matters more than anything else in this file. An earlier
 * version read /trades, which lists only trades - and reconstructing a
 * balance from trades alone is correct only for an account nobody ever
 * withdraws from. Measured against the owner's real account it reported a
 * phantom 0.05068845 BTC, about EUR 3,900, at an exchange whose actual BTC
 * balance is zero, because the five withdrawals that emptied it are not
 * trades. `reconciles to the balance the exchange reports` below is the
 * test that would have caught that, so it is the one to protect.
 */
const KEY = 'test-key';

const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

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
    // a non-browser client sees.
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

  it('probes the movements route the drain depends on, not /trades', async () => {
    // The specific failure this pins: a key that can read /trades but not
    // the movements route would have probed green while reporting holdings
    // that are not there. The probe has to exercise the route whose absence
    // breaks the numbers.
    const seen = stub(() => respond(200, { data: [] }));
    await bitpanda.probe({ apiKey: KEY });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/wallets/transactions');
    expect(seen.some((url) => /\/trades\b/.test(url))).toBe(false);
  });

  it('leaves readOnly undefined, because Bitpanda does not say', async () => {
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

describe('reading a movement', () => {
  /** Narrows the three-way result, failing the test rather than the type
   *  checker when a row was passed over. */
  const eventOf = (result: ReturnType<typeof movementToEvent>) => {
    if ('unsupported' in result || 'skipped' in result) {
      throw new Error(`expected an event, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  const trade = (overrides: Record<string, unknown> = {}) => ({
    status: 'finished',
    type: 'buy',
    cryptocoin_symbol: 'BTC',
    amount_fiat: '100.25',
    amount_cryptocoin: '0.5',
    fiat_to_eur_rate: '1.00000000',
    price: '200.50',
    ...overrides,
  });

  const row = (
    attributes: Record<string, unknown> = {},
    tradeAttributes: Record<string, unknown> | null = {},
  ) => ({
    id: 'movement-1',
    attributes: {
      status: 'finished',
      type: 'buy',
      in_or_out: 'incoming',
      amount: '0.5',
      fee: '0.00000000',
      cryptocoin_symbol: 'BTC',
      tx_id: '',
      recipient: '',
      time: { unix: '1700000000' },
      ...(tradeAttributes === null
        ? {}
        : { trade: { type: 'trade', attributes: trade(tradeAttributes) } }),
      ...attributes,
    },
  });

  it('converts whole units to base units on the way in', () => {
    const event = eventOf(movementToEvent(row()));
    // 0.5 BTC is 50000000 satoshis. Storing 0.5 understates the position a
    // hundred million fold, which is the whole reason this module has a
    // separate unit boundary.
    expect(event.legs[0]).toMatchObject({
      assetId: 'bitcoin:native',
      amount: '50000000',
      direction: 'in',
      venue: 'bitpanda',
      role: 'principal',
    });
    // The fiat side is what makes it a trade rather than a transfer, and
    // keeps its cents.
    expect(event.legs[1]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '100.25',
      direction: 'out',
      role: 'principal',
    });
    expect(event.kind).toBe('trade');
  });

  it('is a trade when a trade is attached and a transfer when none is', () => {
    // The embedded trade object is the ONLY thing that distinguishes the
    // crypto side of a buy from a deposit of the same asset in the same
    // direction, so this is the discriminator the whole route rests on.
    expect(eventOf(movementToEvent(row())).kind).toBe('trade');
    expect(eventOf(movementToEvent(row({}, null))).kind).toBe('transfer');
  });

  it('charges the network fee on a withdrawal as its own leg', () => {
    // The 0.000195 BTC that went missing. Five withdrawals at 0.000039 each
    // is exactly the gap between what the trades implied and what Bitpanda
    // reported, so a fee folded into the principal - or dropped - puts the
    // balance back out by that much.
    const event = eventOf(
      movementToEvent(
        row(
          {
            in_or_out: 'outgoing',
            type: 'withdrawal',
            amount: '0.1',
            fee: '0.0000390',
          },
          null,
        ),
      ),
    );
    expect(event.kind).toBe('transfer');
    expect(event.legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: '10000000',
        direction: 'out',
        venue: 'bitpanda',
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: '3900',
        direction: 'out',
        venue: 'bitpanda',
        role: 'fee',
      },
    ]);
  });

  it('emits no fee leg when the fee is zero', () => {
    // Bitpanda sends '0.00000000' on every row that has no fee. A
    // zero-amount leg is a tax event with nothing in it.
    const event = eventOf(movementToEvent(row({ fee: '0.00000000' }, null)));
    expect(event.legs).toHaveLength(1);
    expect(event.legs.some((leg) => leg.role === 'fee')).toBe(false);
  });

  it('turns a sell around', () => {
    const event = eventOf(
      movementToEvent(row({ in_or_out: 'outgoing', type: 'sell' })),
    );
    expect(event.legs[0].direction).toBe('out');
    expect(event.legs[1].direction).toBe('in');
  });

  it('reports an asset it cannot name rather than guessing one', () => {
    // Bitpanda sells gold, silver, platinum and palladium alongside 880
    // symbols of crypto. Guessing an asset id merges two different
    // positions into one, silently.
    expect(movementToEvent(row({ cryptocoin_symbol: 'XAU' }))).toEqual({
      unsupported: 'XAU',
    });
  });

  it('passes over a movement that never settled', () => {
    // Only a settled movement is a movement. Recording a pending or
    // cancelled row gives the user a holding they do not have, or a
    // disposal they never made.
    expect(movementToEvent(row({ status: 'pending' }))).toEqual({
      skipped: 'movement-1 is pending',
    });
    expect(movementToEvent(row({ status: 'cancelled' }))).toEqual({
      skipped: 'movement-1 is cancelled',
    });
  });

  it('records the fiat leg only when the rate says it is euro', () => {
    // The row carries no fiat SYMBOL, only a numeric fiat_id that needs
    // masterdata - which a read-scoped key cannot read. fiat_to_eur_rate of
    // exactly 1 identifies euro without resolving anything; any other rate
    // is some other currency, and naming it anyway would put a figure in
    // the wrong denomination into a tax report.
    expect(eventOf(movementToEvent(row())).legs).toHaveLength(2);

    const other = eventOf(
      movementToEvent(row({}, { fiat_to_eur_rate: '0.92' })),
    );
    expect(other.legs).toHaveLength(1);
    expect(other.legs[0].assetId).toBe('bitcoin:native');
  });

  it('takes the euro figure from the trade, which is historical', () => {
    // Measured on the owner's NIGHT buy: the embedded trade's amount_fiat
    // reads 200.00, the euro that actually left the fiat wallet in December
    // 2025, while that quantity is worth about 86 today. A current-value
    // field here would have written today's mark into a cost basis.
    const event = eventOf(
      movementToEvent(row({ amount_eur: '86.00' }, { amount_fiat: '200.00' })),
    );
    const fiat = event.legs.find((leg) => leg.assetId === 'fiat:eur');
    // '200', not '200.00' - normaliseAmount drops trailing zeros.
    expect(fiat?.amount).toBe('200');
    expect(fiat?.amount).not.toBe('86');
  });

  it('keeps the on-chain hash as provenance for a withdrawal', () => {
    // Not parsed and nothing branches on it. It is there so a later pass
    // can recognise a withdrawal and an arrival in the user's own wallet as
    // two sides of one move rather than a disposal plus an acquisition.
    const hash = 'a'.repeat(64);
    const event = eventOf(
      movementToEvent(
        row(
          {
            in_or_out: 'outgoing',
            type: 'withdrawal',
            tx_id: hash,
            recipient: 'bc1qexample',
          },
          null,
        ),
      ),
    );
    expect(event.note).toContain(hash);
    expect(event.note).toContain('bc1qexample');
  });

  it('names the fields it actually received when the shape surprises it', () => {
    let message = '';
    try {
      movementToEvent({ id: 'x', attributes: { foo: 1, bar: 2 } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('foo');
    expect(message).toContain('bar');
  });

  it('reads a time given only as an ISO string', () => {
    const event = eventOf(
      movementToEvent(row({ time: { date_iso8601: '2026-01-15T12:00:00Z' } })),
    );
    expect(event.timestamp).toBe(Date.parse('2026-01-15T12:00:00Z'));
  });

  it('stamps milliseconds from a unix second', () => {
    expect(eventOf(movementToEvent(row())).timestamp).toBe(1_700_000_000_000);
  });
});

describe('NIGHT', () => {
  it('is identified by its policy, never by its ticker', () => {
    // CoinGecko lists TWO coins with the symbol NIGHT. The other one trades
    // around EUR 0.0000089 against this one's EUR 0.040, so resolving by
    // ticker would have priced the owner's holding about 4,500x wrong with
    // nothing downstream able to notice.
    expect(NIGHT_ASSET_ID.startsWith('cardano:')).toBe(true);
    expect(NIGHT_ASSET_ID).not.toMatch(/night/i);
  });

  it('can be scaled, which is what lets it be stored at all', () => {
    // A missing decimals entry is a 10^n error, so the asset map and this
    // map have to move together; baseUnits throws rather than defaulting.
    expect(decimalsOf(NIGHT_ASSET_ID)).toBe(6);
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

describe('against the recorded response shape', () => {
  let fixture: { url: string; status: number; body: unknown };

  beforeAll(async () => {
    fixture = JSON.parse(
      await readFile(
        path.join(__dirname, '../src/sources/bitpanda/fixtures/000.json'),
        'utf8',
      ),
    );
  });

  const drain = async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(fixture.status, fixture.body)),
    );
    return bitpanda.fetchEvents({ apiKey: KEY }, null);
  };

  it('drains the whole page and stops when the provider offers no next', async () => {
    const page = await drain();
    // Six rows in, four events out: one pending, one gold, both passed over.
    expect(page.events).toHaveLength(4);
    expect(page.cursor).toBeNull();
  });

  it('reconciles to the balance the exchange reports', async () => {
    // THE test. `in - out - fee`, per asset, against what Bitpanda itself
    // says the wallet holds. Against the owner's real account this holds
    // exactly to all eight decimals for BTC, ETH, ADA and NIGHT - and it is
    // the arithmetic the /trades route could not satisfy, because the
    // withdrawals that balance it are not trades.
    //
    // The fixture's own figures: 0.25 BTC bought, 0.1 BTC withdrawn with a
    // 0.000039 fee, and a non-euro buy of 0.01 BTC that still moves BTC.
    // 0.25 - 0.1 - 0.000039 + 0.01 = 0.159961 BTC, and 12 NIGHT deposited.
    const page = await drain();
    const events = page.events.map((event, index): LedgerEvent => ({
      ...event,
      id: `e${index}`,
      sourceId: 'bitpanda-1',
    }));
    const held = foldHoldings(events, ownedVenuesOf(events));
    const byAsset = new Map(held.map((h) => [h.assetId, h.amount]));

    expect(new Big(byAsset.get('bitcoin:native') ?? '0').toFixed(0)).toBe(
      new Big('0.159961').times(1e8).toFixed(0),
    );
    expect(byAsset.get(NIGHT_ASSET_ID)).toBe('12000000');
  });

  it('records the withdrawal the trades route cannot see', async () => {
    // The regression this whole route exists for. If the drain ever goes
    // back to a trades-only source, there is no outgoing principal leg
    // anywhere in the page and this fails.
    const page = await drain();
    const outgoing = page.events.flatMap((event) =>
      event.legs.filter(
        (leg) => leg.direction === 'out' && leg.assetId === 'bitcoin:native',
      ),
    );
    expect(outgoing).toHaveLength(2); // the withdrawal and its fee
    expect(outgoing.map((leg) => leg.role).sort()).toEqual([
      'fee',
      'principal',
    ]);
  });

  it('asks for the movements route, with paging', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return respond(fixture.status, fixture.body);
      }),
    );
    await bitpanda.fetchEvents({ apiKey: KEY }, null);
    expect(seen[0]).toContain('/wallets/transactions');
    expect(seen[0]).toContain('page=1');
  });

  it('is a synthetic fixture, not a recording of a real account', () => {
    // Guards the rule rather than the shape: a real recording of this route
    // is somebody's account history and their own wallet addresses, so if
    // this file is ever replaced by a genuine capture the marker goes and
    // this fails. The addresses below are the invented ones.
    const raw = JSON.stringify(fixture);
    expect(raw).toContain('_synthetic');
    expect(raw).toContain('bc1qexampleaddress');
  });
});
