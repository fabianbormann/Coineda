import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Big from 'big.js';
import ethereum from '@/sources/ethereum-blockscout';
import {
  ETHEREUM_MESSAGES,
  baseUrlOf,
  decodeCursor,
  encodeCursor,
  internalToEvent,
  transactionToEvent,
} from '@/sources/ethereum-blockscout/translator';
import {
  isAddress,
  normaliseAddress,
} from '@/sources/ethereum-blockscout/address';
import { runConformance } from '@/sources/conformance';
import type { DerivedEvent } from '@/sources/types';

/**
 * Ethereum through Blockscout.
 *
 * Three things decide whether this module reports a real balance, and all
 * three were measured against the live API before any of it was written:
 *
 * - A FAILED transaction keeps its `value` populated. Booking it invents
 *   ether that never moved.
 * - Gas is paid by the sender whether the transaction succeeded or not, and
 *   on a zero-value contract call it is the only thing that moved.
 * - Ether moved BY A CONTRACT appears only under /internal-transactions.
 *   Reading just /transactions is the same silent hole that had Bitpanda
 *   reporting EUR 3,900 of bitcoin that was not there.
 */
const OURS = '0x1111111111111111111111111111111111111111';
const THEM = '0x2222222222222222222222222222222222222222';
const config = { address: OURS };

const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('addresses', () => {
  it('accepts an address and refuses anything else', () => {
    expect(isAddress(OURS)).toBe(true);
    expect(isAddress('0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045')).toBe(true);
    for (const bad of [
      '',
      '0x',
      OURS.slice(0, -1), // 39 hex digits
      `${OURS}0`, // 41
      OURS.replace('0x', ''), // no prefix
      '0xzzzz111111111111111111111111111111111111',
      'addr1qxy',
    ]) {
      expect(isAddress(bad)).toBe(false);
    }
  });

  it('lowercases, because the API answers in checksummed mixed case', () => {
    // Every direction test is "is this leg's counterparty us?". Comparing a
    // pasted lowercase address against a checksummed one answers no for an
    // address that IS the user's, which would file every one of their own
    // transactions as somebody else's.
    expect(normaliseAddress('0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(
      '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    );
  });
});

describe('the base URL', () => {
  it('defaults to the public instance', () => {
    expect(baseUrlOf({})).toBe('https://eth.blockscout.com');
    expect(baseUrlOf({ baseUrl: '  ' })).toBe('https://eth.blockscout.com');
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(baseUrlOf({ baseUrl: 'https://my.node/' })).toBe('https://my.node');
    expect(baseUrlOf({ baseUrl: 'https://my.node///' })).toBe(
      'https://my.node',
    );
  });
});

describe('probing', () => {
  it('refuses a missing or malformed address without asking anybody', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return respond(200, { hash: OURS });
      }),
    );
    const bads: Record<string, string>[] = [{}, { address: 'nonsense' }];
    for (const bad of bads) {
      const result = await ethereum.probe(bad);
      expect(result.ok).toBe(false);
      expect(result.message).toBe(ETHEREUM_MESSAGES.missingAddress);
    }
    expect(seen).toEqual([]);
  });

  it('accepts an address with no history at all', async () => {
    // A freshly funded wallet is a valid thing to add. Refusing it here
    // would make the common "I just created this" case unaddable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { hash: OURS })),
    );
    await expect(ethereum.probe(config)).resolves.toMatchObject({ ok: true });
  });

  it('says so when the URL answers but is not a Blockscout', async () => {
    // Pointing at the web interface rather than the API is the mistake this
    // catches, and it needs its own message: "unreachable" would send
    // someone looking for a network problem that is not there.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { something: 1 })),
    );
    const result = await ethereum.probe(config);
    expect(result.message).toBe(ETHEREUM_MESSAGES.notBlockscout);
  });

  it('reports an unreachable instance as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await ethereum.probe(config);
    expect(result.message).toBe(ETHEREUM_MESSAGES.unreachable);
  });

  it('claims no readOnly, because there is no credential to judge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { hash: OURS })),
    );
    const result = await ethereum.probe(config);
    expect(result.readOnly).toBeUndefined();
  });
});

describe('reading a transaction', () => {
  const tx = (overrides: Record<string, unknown> = {}) => ({
    hash: '0xabc',
    timestamp: '2026-02-01T10:00:00.000000Z',
    value: '1000000000000000000',
    fee: { value: '100000000000000' },
    status: 'ok',
    from: { hash: THEM },
    to: { hash: OURS },
    ...overrides,
  });

  const eventOf = (result: ReturnType<typeof transactionToEvent>) => {
    if ('skipped' in result) {
      throw new Error(`expected an event, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  it('stores wei exactly as the chain reports it', () => {
    // No conversion at all, unlike an exchange module: a chain already
    // reports base units, so there is no place here for the scale error
    // baseUnits exists to catch on the Bitpanda side.
    const event = eventOf(transactionToEvent(tx(), OURS));
    expect(event.legs).toEqual([
      {
        assetId: 'eth:native',
        amount: '1000000000000000000',
        direction: 'in',
        venue: OURS,
        role: 'principal',
      },
    ]);
  });

  it('charges no gas on an incoming transfer', () => {
    // The sender paid it. Charging it here would shrink the balance by
    // every fee anybody ever paid to send us something.
    const event = eventOf(transactionToEvent(tx(), OURS));
    expect(event.legs.some((leg) => leg.role === 'fee')).toBe(false);
  });

  it('charges gas on an outgoing transfer, beside the value', () => {
    const event = eventOf(
      transactionToEvent(
        tx({ from: { hash: OURS }, to: { hash: THEM } }),
        OURS,
      ),
    );
    expect(event.legs).toEqual([
      {
        assetId: 'eth:native',
        amount: '1000000000000000000',
        direction: 'out',
        venue: OURS,
        role: 'principal',
      },
      {
        assetId: 'eth:native',
        amount: '100000000000000',
        direction: 'out',
        venue: OURS,
        role: 'fee',
      },
    ]);
  });

  it('books the gas of a FAILED transaction but not its value', () => {
    // Measured live: a reverted transaction answers status "error" and
    // still carries value 100000000000000 and a real fee. The ether did not
    // move; the gas did. Booking the value invents a holding, and dropping
    // the row entirely loses a fee the user really paid.
    const event = eventOf(
      transactionToEvent(
        tx({ from: { hash: OURS }, to: { hash: THEM }, status: 'error' }),
        OURS,
      ),
    );
    expect(event.legs).toHaveLength(1);
    expect(event.legs[0]).toMatchObject({ role: 'fee', direction: 'out' });
    expect(event.legs.some((leg) => leg.role === 'principal')).toBe(false);
  });

  it('books gas alone on a zero-value contract call', () => {
    const event = eventOf(
      transactionToEvent(
        tx({ from: { hash: OURS }, to: { hash: THEM }, value: '0' }),
        OURS,
      ),
    );
    expect(event.legs).toHaveLength(1);
    expect(event.legs[0].role).toBe('fee');
  });

  it('emits both legs of a self-send, which nets to the fee', () => {
    const event = eventOf(
      transactionToEvent(
        tx({ from: { hash: OURS }, to: { hash: OURS } }),
        OURS,
      ),
    );
    const net = event.legs.reduce(
      (total, leg) =>
        leg.direction === 'in'
          ? total.plus(leg.amount)
          : total.minus(leg.amount),
      new Big(0),
    );
    expect(net.toString()).toBe('-100000000000000');
  });

  it('passes over a transaction nothing of ours moved in', () => {
    expect(
      transactionToEvent(
        tx({ from: { hash: THEM }, to: { hash: '0x9'.padEnd(42, '9') } }),
        OURS,
      ),
    ).toEqual({ skipped: '0xabc' });
  });

  it('matches our address regardless of the case the API returns', () => {
    // An address of hex LETTERS, because case is the whole point: OURS is
    // all 1s, and uppercasing digits changes nothing - an earlier version
    // of this test did exactly that and could not fail.
    //
    // Blockscout answers in EIP-55 checksummed mixed case while a user is
    // as likely to paste lowercase. Comparing those directly answers "not
    // ours" for an address that is.
    const lower = '0xaabbccddeeff00112233445566778899aabbccdd';
    const checksummed = '0xAaBbCcDdEeFf00112233445566778899aAbBcCdD';
    expect(checksummed.toLowerCase()).toBe(lower);

    const event = eventOf(
      transactionToEvent(
        {
          hash: '0xabc',
          timestamp: '2026-02-01T10:00:00.000000Z',
          value: '1000000000000000000',
          fee: { value: '100000000000000' },
          status: 'ok',
          from: { hash: THEM },
          to: { hash: checksummed },
        },
        lower,
      ),
    );
    expect(event.legs[0].direction).toBe('in');
    expect(event.legs[0].venue).toBe(lower);
  });

  it('emits legs only at our own address, never the counterparty', () => {
    // ownedVenuesOf trusts every venue it finds in the ledger, so a
    // counterparty leg would silently assert the user owns that address -
    // and every outbound payment would then read as an internal transfer
    // and disappear from the tax report.
    const event = eventOf(
      transactionToEvent(
        tx({ from: { hash: OURS }, to: { hash: THEM } }),
        OURS,
      ),
    );
    expect(event.legs.every((leg) => leg.venue === OURS)).toBe(true);
  });

  it('names what it received when the shape surprises it', () => {
    let message = '';
    try {
      transactionToEvent({ value: '1', from: { hash: OURS } }, OURS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('value');
    expect(message).toContain('from');
  });
});

describe('reading an internal transaction', () => {
  const internal = (overrides: Record<string, unknown> = {}) => ({
    transaction_hash: '0xdef',
    index: 2,
    timestamp: '2026-02-06T10:00:00.000000Z',
    value: '250000000000000000',
    success: true,
    from: { hash: THEM },
    to: { hash: OURS },
    ...overrides,
  });

  const eventOf = (result: ReturnType<typeof internalToEvent>) => {
    if ('skipped' in result) {
      throw new Error(`expected an event, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  it('keys on the parent hash AND the call index', () => {
    // One transaction can hold many internal calls - measured 50 distinct
    // keys across 50 rows. Keying on the hash alone would have each call
    // overwrite the last, since events upsert on (sourceId, externalId).
    expect(eventOf(internalToEvent(internal(), OURS)).externalId).toBe(
      '0xdef#i2',
    );
    expect(
      eventOf(internalToEvent(internal({ index: 3 }), OURS)).externalId,
    ).toBe('0xdef#i3');
  });

  it('charges no gas, because the parent transaction already did', () => {
    // Gas belongs to the transaction, not to each call inside it. A fee leg
    // here would subtract the same gas once per internal call.
    const event = eventOf(internalToEvent(internal(), OURS));
    expect(event.legs).toHaveLength(1);
    expect(event.legs.some((leg) => leg.role === 'fee')).toBe(false);
  });

  it('passes over a failed call, which moved nothing', () => {
    expect(internalToEvent(internal({ success: false }), OURS)).toEqual({
      skipped: '0xdef#i2',
    });
  });

  it('passes over a zero-value call', () => {
    expect(internalToEvent(internal({ value: '0' }), OURS)).toEqual({
      skipped: '0xdef#i2',
    });
  });

  it('passes over a call between two other parties', () => {
    expect(internalToEvent(internal({ to: { hash: THEM } }), OURS)).toEqual({
      skipped: '0xdef#i2',
    });
  });
});

describe('the cursor', () => {
  it('round-trips a phase and its opaque page params', () => {
    const params = {
      index: 242,
      hash: '0x960b',
      inserted_at: '2026-08-08T17:05:46.778851Z',
    };
    expect(decodeCursor(encodeCursor('transactions', params))).toEqual({
      phase: 'transactions',
      params,
    });
    expect(decodeCursor(encodeCursor('internal', null))).toEqual({
      phase: 'internal',
      params: null,
    });
  });

  it('survives the colons inside a timestamp', () => {
    // The page params carry ISO timestamps, and the cursor format is
    // colon-delimited. Encoding is what keeps a naive split from cutting a
    // timestamp in half.
    const params = { inserted_at: '2026-08-08T17:05:46.778851Z' };
    const decoded = decodeCursor(encodeCursor('internal', params));
    expect(decoded.params).toEqual(params);
  });

  it('starts over on anything it does not recognise', () => {
    for (const cursor of [
      null,
      'nonsense',
      'eth:',
      'eth:other:xx',
      'btc:0:0',
    ]) {
      expect(decodeCursor(cursor)).toEqual({
        phase: 'transactions',
        params: null,
      });
    }
  });

  it('starts that phase over on undecodable params rather than throwing', () => {
    expect(decodeCursor('eth:internal:!!!not-base64!!!')).toEqual({
      phase: 'internal',
      params: null,
    });
  });
});

describe('against the recorded response shape', () => {
  type Recorded = { url: string; status: number; body: unknown };
  let transactions: Recorded;
  let internals: Recorded;

  beforeAll(async () => {
    const read = async (name: string) =>
      JSON.parse(
        await readFile(
          path.join(
            __dirname,
            `../src/sources/ethereum-blockscout/fixtures/${name}`,
          ),
          'utf8',
        ),
      );
    transactions = await read('000.json');
    internals = await read('001.json');
  });

  const serve = () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(String(url));
        const which = String(url).includes('/internal-transactions')
          ? internals
          : transactions;
        return respond(which.status, which.body);
      }),
    );
    return asked;
  };

  const drainAll = async () => {
    const asked = serve();
    const events: DerivedEvent[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await ethereum.fetchEvents(config, cursor);
      events.push(...page.events);
      cursor = page.cursor;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor).toBeNull();
    return { events, asked };
  };

  const net = (events: DerivedEvent[]): string => {
    let total = new Big(0);
    for (const event of events) {
      for (const leg of event.legs) {
        total =
          leg.direction === 'in'
            ? total.plus(leg.amount)
            : total.minus(leg.amount);
      }
    }
    return total.toString();
  };

  it('drains both routes and only then finishes', async () => {
    const { asked } = await drainAll();
    expect(asked.some((url) => url.endsWith('/transactions'))).toBe(true);
    expect(asked.some((url) => url.includes('/internal-transactions'))).toBe(
      true,
    );
  });

  it('nets the wallet to what actually moved', async () => {
    // In:  1.0 received, 0.25 and 0.125 from two internal calls = 1.375
    // Out: 0.5 sent, plus gas of 0.0001 + 0.00007 + 0.00003 = 0.5002
    // Net: 0.8748 ETH, in wei.
    const { events } = await drainAll();
    expect(net(events)).toBe(
      new Big('0.8748').times(new Big('1e18')).toFixed(0),
    );
  });

  it('sees the ether a contract moved, which the tx list cannot show', async () => {
    // The regression this second route exists for. Both internal credits
    // share one parent transaction and differ only by index.
    const { events } = await drainAll();
    const fromContract = events.filter((event) =>
      event.externalId.startsWith('0xff#i'),
    );
    expect(fromContract.map((event) => event.externalId).sort()).toEqual([
      '0xff#i0',
      '0xff#i1',
    ]);
  });

  it('keeps the gas of the reverted transaction and drops its value', async () => {
    const { events } = await drainAll();
    const reverted = events.find((event) => event.externalId === '0xcc');
    expect(reverted?.legs).toEqual([
      {
        assetId: 'eth:native',
        amount: '70000000000000',
        direction: 'out',
        venue: OURS,
        role: 'fee',
      },
    ]);
  });

  it('leaves out what never touched us', async () => {
    const { events } = await drainAll();
    const ids = events.map((event) => event.externalId);
    expect(ids).not.toContain('0xee'); // between two other parties
    expect(ids).not.toContain('0x99#i0'); // a failed internal call
    expect(ids).not.toContain('0x88#i0'); // a zero-value call
    expect(ids).not.toContain('0x77#i0'); // not ours
  });

  it('gives every event a distinct id', async () => {
    const { events } = await drainAll();
    expect(new Set(events.map((event) => event.externalId)).size).toBe(
      events.length,
    );
  });

  it('passes the module conformance gate', async () => {
    serve();
    await expect(runConformance(ethereum, { config })).resolves.not.toThrow();
  });

  it('is a synthetic fixture, not a recording of a real wallet', () => {
    for (const recorded of [transactions, internals]) {
      expect(JSON.stringify(recorded)).toContain('_synthetic');
    }
  });
});
