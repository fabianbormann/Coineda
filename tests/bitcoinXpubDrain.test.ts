import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  fetchEvents,
} from '@/sources/bitcoin-esplora/translator';
import { parseAccountKey } from '@/sources/bitcoin-esplora/xpub';
import { addressFor } from '@/sources/bitcoin-esplora/script';
import { GAP_LIMIT, clearWalletCache } from '@/sources/bitcoin-esplora/wallet';
import type { DerivedEvent } from '@/sources/types';

const ROOT = 'https://blockstream.info/api';
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const account = () => {
  const parsed = parseAccountKey(ZPUB);
  if ('problem' in parsed) throw new Error('fixture key must parse');
  return parsed.key;
};

/** The native-SegWit address at a derived position, as the drain derives it. */
const at = (chain: 0 | 1, index: number) =>
  addressFor('p2wpkh', account().publicKeyAt(chain, index), 'mainnet');

const txsUrl = (address: string) => `${ROOT}/address/${address}/txs`;

let nextTxid = 0;
const txBetween = (
  inputs: { address: string; value: number }[],
  outputs: { address: string; value: number }[],
  fee = 1000,
) => ({
  txid: `tx${(nextTxid += 1)}`.padEnd(64, '0'),
  status: { confirmed: true, block_height: 1, block_time: 1_700_000_000 },
  vin: inputs.map((i) => ({
    prevout: { scriptpubkey_address: i.address, value: i.value },
  })),
  vout: outputs.map((o) => ({
    scriptpubkey_address: o.address,
    value: o.value,
  })),
  fee,
});

/** Serves a body per address, `[]` for anything else, recording every URL. */
const stub = (bodies: Map<string, unknown[]>) => {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      const match = [...bodies.entries()].find(([a]) => key === txsUrl(a));
      return new Response(JSON.stringify(match ? match[1] : []), {
        status: 200,
      });
    }),
  );
  return seen;
};

/** Drains to completion, bounded so a cursor that never ends fails the test
 *  rather than hanging it. */
const drain = async (config: Record<string, string>) => {
  const events: DerivedEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1500; page += 1) {
    const result = await fetchEvents(config, cursor);
    events.push(...result.events);
    cursor = result.cursor;
    if (cursor === null) {
      return events;
    }
  }
  throw new Error('drain did not terminate');
};

beforeEach(() => {
  clearWalletCache();
  nextTxid = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the cursor', () => {
  it('round-trips every stage', () => {
    for (const stage of [0, 1, 2]) {
      const encoded = encodeCursor('p2wpkh', stage, 7, 3, 'abc');
      expect(decodeCursor(encoded)).toEqual({
        scriptType: 'p2wpkh',
        stage,
        index: 7,
        gap: 3,
        lastSeenTxid: 'abc',
      });
    }
  });

  it('restarts on anything it does not recognise, including the old format', () => {
    const start = {
      scriptType: '',
      stage: 0,
      index: 0,
      gap: 0,
      lastSeenTxid: '',
    };
    // The two-component cursor this replaced. An existing source carrying one
    // must restart rather than be misread - dedupe on (sourceId, externalId)
    // makes that lossless.
    expect(decodeCursor('btc:3:abc')).toEqual(start);
    expect(decodeCursor('btc::0:0:0')).toEqual(start);
    expect(decodeCursor('nonsense')).toEqual(start);
    expect(decodeCursor('btc::x:0:0:')).toEqual(start);
    expect(decodeCursor('btc:p2tr:0:0:0:')).toEqual(start);
    expect(decodeCursor(null)).toEqual(start);
  });
});

describe('the derived drain', () => {
  it('scans the receive chain, then the change chain, then the listed addresses', async () => {
    const listedOnly = 'bc1qlistedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    // The wallet needs history for its script type to be detectable at all:
    // an xpub whose addresses are all unused has no detectable type, and the
    // derived stages are then skipped by design rather than walked blindly.
    const seen = stub(
      new Map<string, unknown[]>([
        [at(0, 0), [txBetween([], [{ address: at(0, 0), value: 1000 }])]],
      ]),
    );
    await drain({ xpub: ZPUB, address: listedOnly });

    const firstIndexOf = (address: string) => seen.indexOf(txsUrl(address));
    // Order is the ownership order, and it has to be this order because the
    // first address in it is the venue and the owner of a shared transaction.
    expect(firstIndexOf(at(0, 0))).toBeGreaterThanOrEqual(0);
    expect(firstIndexOf(at(0, 0))).toBeLessThan(firstIndexOf(at(1, 0)));
    expect(firstIndexOf(at(1, 0))).toBeLessThan(firstIndexOf(listedOnly));
  });

  it('continues past a gap of one short of the limit', async () => {
    // Review Focus 5. GAP_LIMIT - 1 consecutive unused addresses is a hole in
    // a live wallet, not its end.
    const far = GAP_LIMIT; // indices 1..GAP_LIMIT-1 empty, then this one
    const bodies = new Map<string, unknown[]>([
      [at(0, 0), [txBetween([], [{ address: at(0, 0), value: 1000 }])]],
      [at(0, far), [txBetween([], [{ address: at(0, far), value: 2000 }])]],
    ]);
    const seen = stub(bodies);
    const events = await drain({ xpub: ZPUB });

    expect(seen).toContain(txsUrl(at(0, far)));
    expect(events).toHaveLength(2);
  });

  it('stops a chain at exactly the gap limit', async () => {
    // The other half of Review Focus 5: one more empty address than above and
    // the chain is finished, so an address beyond it is never requested.
    const beyond = GAP_LIMIT + 1;
    const bodies = new Map<string, unknown[]>([
      [at(0, 0), [txBetween([], [{ address: at(0, 0), value: 1000 }])]],
      [at(0, beyond), [txBetween([], [{ address: at(0, beyond), value: 1 }])]],
    ]);
    const seen = stub(bodies);
    const events = await drain({ xpub: ZPUB });

    expect(seen).not.toContain(txsUrl(at(0, beyond)));
    expect(events).toHaveLength(1);
  });

  it('nets a transfer between its own two chains to the fee, emitted once', async () => {
    // The rollup rule, on a derived wallet: spending from a receive address
    // to a change address of the same wallet moves nothing but the fee.
    const spend = txBetween(
      [{ address: at(0, 0), value: 100_000 }],
      [{ address: at(1, 0), value: 99_000 }],
      1000,
    );
    stub(
      new Map<string, unknown[]>([
        [at(0, 0), [spend]],
        [at(1, 0), [spend]],
      ]),
    );
    const events = await drain({ xpub: ZPUB });

    expect(events).toHaveLength(1);
    const net = events[0].legs.reduce(
      (total, leg) =>
        total + (leg.direction === 'in' ? 1 : -1) * Number(leg.amount),
      0,
    );
    expect(net).toBe(-1000);
    // One venue for the whole wallet: the first derived receive address.
    expect(new Set(events[0].legs.map((leg) => leg.venue))).toEqual(
      new Set([at(0, 0)]),
    );
  });

  it('counts a listed address the xpub also derives exactly once', async () => {
    // Review Focus 4. Pasting an address the key already covers is an
    // ordinary thing to do, and counting that output twice would inflate the
    // balance silently.
    const duplicated = at(0, 0);
    const received = txBetween([], [{ address: duplicated, value: 50_000 }]);
    stub(new Map<string, unknown[]>([[duplicated, [received]]]));

    const events = await drain({ xpub: ZPUB, address: duplicated });
    expect(events).toHaveLength(1);
    expect(events[0].legs).toHaveLength(1);
    expect(events[0].legs[0].amount).toBe('50000');
  });

  it('never reaches for a listed address when none is configured', async () => {
    const seen = stub(new Map());
    await drain({ xpub: ZPUB });
    // Every URL requested is a derived one. A stage-2 request with an empty
    // list would be a request for `undefined`.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((url) => url.includes('undefined'))).toBe(false);
  });

  it('never derives when only addresses are configured', async () => {
    const listed = 'bc1qonlylistedxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const seen = stub(new Map());
    await drain({ address: listed });
    // Exactly the listed address, nothing derived - the addresses-only path
    // is this same drain with its derived stages empty.
    expect(seen).toEqual([txsUrl(listed)]);
  });

  it('fails the sync loudly when the key cannot be parsed', async () => {
    stub(new Map());
    await expect(fetchEvents({ xpub: 'not a key' }, null)).rejects.toThrow();
  });
});
