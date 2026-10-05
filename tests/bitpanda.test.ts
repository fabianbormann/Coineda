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
import type { DerivedEvent } from '@/sources/types';

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
  it('round-trips a phase and a page', () => {
    expect(decodeCursor(encodeCursor('movements', 4))).toEqual({
      phase: 'movements',
      page: 4,
    });
    expect(decodeCursor(encodeCursor('fiat', 2))).toEqual({
      phase: 'fiat',
      page: 2,
    });
  });

  it('starts over on anything it does not recognise', () => {
    // Including the old single-phase `bitpanda:<n>` form, which named a
    // page in a drain that no longer exists. Restarting is cheap and
    // converges, because events upsert on (sourceId, externalId).
    for (const cursor of [
      null,
      'nonsense',
      'bitpanda:',
      'bitpanda:3',
      'btc:0:0:0:',
    ]) {
      expect(decodeCursor(cursor)).toEqual({ phase: 'movements', page: 1 });
    }
  });
});

describe('against the recorded response shape', () => {
  type Recorded = { url: string; status: number; body: unknown };
  let crypto: Recorded;
  let fiat: Recorded;

  beforeAll(async () => {
    const read = async (name: string) =>
      JSON.parse(
        await readFile(
          path.join(__dirname, `../src/sources/bitpanda/fixtures/${name}`),
          'utf8',
        ),
      );
    crypto = await read('000.json');
    fiat = await read('001.json');
  });

  /** Serves whichever route the module asks for, and drains to exhaustion
   *  so BOTH phases run - a drain that stopped after the crypto phase is
   *  the exact bug this route pair exists to fix. */
  const drainAll = async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(String(url));
        const which = String(url).includes('/fiatwallets/') ? fiat : crypto;
        return respond(which.status, which.body);
      }),
    );
    const events = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const result: { events: DerivedEvent[]; cursor: string | null } =
        await bitpanda.fetchEvents({ apiKey: KEY }, cursor);
      events.push(...result.events);
      cursor = result.cursor;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor).toBeNull();
    return { events, asked };
  };

  const fold = (
    events: {
      legs: { assetId: string; amount: string; direction: string }[];
    }[],
  ) => {
    const totals = new Map<string, Big>();
    for (const event of events) {
      for (const leg of event.legs) {
        const current = totals.get(leg.assetId) ?? new Big(0);
        totals.set(
          leg.assetId,
          leg.direction === 'in'
            ? current.plus(leg.amount)
            : current.minus(leg.amount),
        );
      }
    }
    return totals;
  };

  it('drains both routes and only then finishes', async () => {
    const { asked } = await drainAll();
    expect(asked.some((url) => url.includes('/wallets/transactions'))).toBe(
      true,
    );
    expect(asked.some((url) => url.includes('/fiatwallets/transactions'))).toBe(
      true,
    );
  });

  it('ingests the deposits that make the euro balance real', async () => {
    // THE regression. Without the fiat phase the ledger sees every euro
    // leave and none arrive, so the balance is understated by exactly
    // everything ever spent - EUR 3,770.00 on the owner's own account.
    //
    // These fixtures: a 5,000 deposit, a 5,000 trade (whose euro leg comes
    // from the crypto route), a 100 withdrawal with a 1.50 fee, plus a
    // non-euro deposit and a pending one that are both passed over.
    // 5000 - 5000 - 100 - 1.50 = -101.50.
    const { events } = await drainAll();
    expect(fold(events).get('fiat:eur')?.toString()).toBe('-101.5');
  });

  it('does not count a trade twice through its own fiat row', async () => {
    // The fiat route lists the euro side of every trade as well. That leg
    // is already on the trade event, so ingesting the row again would
    // subtract the same 5,000 twice - and on the owner's account twelve
    // such rows sit beside thirteen genuine deposits.
    const { events } = await drainAll();
    const fiatIn = events.filter((event) => event.kind === 'fiat-in');
    const fiatOut = events.filter((event) => event.kind === 'fiat-out');
    expect(fiatIn).toHaveLength(1);
    expect(fiatOut).toHaveLength(1);
    expect(fiatOut[0].legs.some((leg) => leg.amount === '5000')).toBe(false);
  });

  it('charges a withdrawal fee on the fiat side too', async () => {
    const { events } = await drainAll();
    const withdrawal = events.find((event) => event.kind === 'fiat-out');
    expect(withdrawal?.legs).toEqual([
      {
        assetId: 'fiat:eur',
        amount: '100',
        direction: 'out',
        venue: 'bitpanda',
        role: 'principal',
      },
      {
        assetId: 'fiat:eur',
        amount: '1.5',
        direction: 'out',
        venue: 'bitpanda',
        role: 'fee',
      },
    ]);
  });

  it('passes over a fiat wallet that is not euro', async () => {
    // Recording a dollar deposit as euro would put a figure in the wrong
    // denomination into a tax report. The rate decides, because the row
    // carries no currency name.
    const { events } = await drainAll();
    const amounts = events
      .flatMap((event) => event.legs)
      .map((leg) => leg.amount);
    expect(amounts).not.toContain('77');
  });

  it('passes over a fiat movement that never settled', async () => {
    const { events } = await drainAll();
    const amounts = events
      .flatMap((event) => event.legs)
      .map((leg) => leg.amount);
    expect(amounts).not.toContain('999');
  });

  it('gives fiat rows their own id space', async () => {
    // Different providers' id spaces, and events upsert on
    // (sourceId, externalId) - an unnamespaced collision would have one
    // movement silently overwrite another.
    const { events } = await drainAll();
    for (const event of events) {
      if (event.kind === 'fiat-in' || event.kind === 'fiat-out') {
        expect(event.externalId.startsWith('fiat:')).toBe(true);
      }
    }
    expect(new Set(events.map((e) => e.externalId)).size).toBe(events.length);
  });

  it('reconciles the crypto side to the balance the exchange reports', async () => {
    // `in - out - fee`, per asset, against what Bitpanda itself says the
    // wallet holds. Against the owner's real account this holds exactly to
    // all eight decimals for BTC, ETH, ADA and NIGHT.
    //
    // The fixture's figures: 0.25 BTC bought, 0.1 BTC withdrawn with a
    // 0.000039 fee, and a non-euro buy of 0.01 BTC that still moves BTC.
    // 0.25 - 0.1 - 0.000039 + 0.01 = 0.159961 BTC, and 12 NIGHT deposited.
    const { events } = await drainAll();
    const totals = fold(events);
    expect(totals.get('bitcoin:native')?.toFixed(0)).toBe(
      new Big('0.159961').times(1e8).toFixed(0),
    );
    expect(totals.get(NIGHT_ASSET_ID)?.toString()).toBe('12000000');
  });

  it('records the withdrawal the trades route cannot see', async () => {
    const { events } = await drainAll();
    const outgoing = events.flatMap((event) =>
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

  it('is a synthetic fixture, not a recording of a real account', () => {
    // Guards the rule rather than the shape: a real recording of these
    // routes is somebody's account history and their own wallet addresses.
    for (const recorded of [crypto, fiat]) {
      expect(JSON.stringify(recorded)).toContain('_synthetic');
    }
  });
});
