import { describe, it, expect, afterEach, vi } from 'vitest';
import bitcoinEsplora from '@/sources/bitcoin-esplora';
import { BITCOIN_ESPLORA_MESSAGES } from '@/sources/bitcoin-esplora/translator';
import type { DerivedEvent } from '@/sources/types';

/**
 * Synthetic Esplora fixtures, built by hand rather than recorded against a
 * live address - task 7 owns recorded fixtures and the conformance gate.
 * This file exercises the translation in isolation: ownership, the
 * unconfirmed filter, a coinbase input, cursor advance across addresses,
 * decimal-string amounts and venue assignment.
 */

const ROOT = 'https://esplora.test/api';
const ADDR_A = 'bc1qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_EXTERNAL = 'bc1qexternalnotconfiguredxxxxxxxxxxxxxxxxx';

type EsploraVin = {
  prevout?: { scriptpubkey_address?: string; value?: number } | null;
};
type EsploraVout = { scriptpubkey_address?: string; value: number };
type EsploraTx = {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee: number;
};

const config = { baseUrl: ROOT, address: `${ADDR_A}\n${ADDR_B}` };

const txFixture = (overrides: Partial<EsploraTx> = {}): EsploraTx => ({
  txid: 'defaulttx',
  status: { confirmed: true, block_height: 100, block_time: 1_700_000_000 },
  vin: [],
  vout: [],
  fee: 500,
  ...overrides,
});

/** Stubs `fetch` against an exact URL -> {status, body} map. Any URL not in
 *  the map throws, so a typo'd request surfaces immediately rather than
 *  quietly returning undefined. */
const stubFetch = (routes: Map<string, { status: number; body: unknown }>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const route = routes.get(String(url));
      if (!route) {
        throw new Error(`no stub for ${String(url)}`);
      }
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        json: async () => route.body,
      } as Response;
    }),
  );
};

const txsUrl = (address: string) => `${ROOT}/address/${address}/txs`;
const chainUrl = (address: string, lastSeenTxid: string) =>
  `${ROOT}/address/${address}/txs/chain/${lastSeenTxid}`;

/** Drains every page of every configured address, starting at cursor null,
 *  bounded so a cursor bug that never returns null fails the test instead
 *  of hanging it. */
const drainAll = async (): Promise<DerivedEvent[]> => {
  const events: DerivedEvent[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const page = await bitcoinEsplora.fetchEvents(config, cursor);
    events.push(...page.events);
    if (page.cursor === null) {
      return events;
    }
    cursor = page.cursor;
  }
  throw new Error('drain did not terminate within 50 pages');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bitcoin-esplora: ownership', () => {
  it('emits a transaction only once, under the first configured address that appears in it', async () => {
    const shared = txFixture({
      txid: 'shared-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_A, value: 100_000 } }],
      vout: [
        { scriptpubkey_address: ADDR_B, value: 90_000 },
        { scriptpubkey_address: ADDR_EXTERNAL, value: 9_000 },
      ],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [shared] }],
        // B is drained after A exhausts; B's own listing shows the same
        // transaction too (it is one of B's outputs), and the ownership
        // rule must suppress it there.
        [txsUrl(ADDR_B), { status: 200, body: [shared] }],
      ]),
    );

    const events = await drainAll();
    const matches = events.filter((event) => event.externalId === 'shared-tx');
    expect(matches).toHaveLength(1);
  });

  it('ignores an output with no address at all, keeping the rest of the transaction', async () => {
    // An OP_RETURN (or any non-standard "unspendable") output carries no
    // scriptpubkey_address. It must not throw, must not become a leg, and
    // must not take the real legs down with it - `value` is still a number
    // there, so a filter keying on value rather than address would turn a
    // data-carrying output into a phantom receipt.
    const withOpReturn = txFixture({
      txid: 'opreturn-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_A, value: 10_000 } }],
      vout: [
        { value: 0 },
        { scriptpubkey_address: ADDR_A, value: 9_400 },
      ] as EsploraVout[],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [withOpReturn] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    const event = events.find((e) => e.externalId === 'opreturn-tx');
    expect(event).toBeDefined();
    // Exactly the spend and the change, and nothing for the addressless
    // output - asserted as the full multiset so an extra phantom leg fails.
    expect(event!.legs.map((leg) => `${leg.direction}:${leg.amount}`)).toEqual([
      'out:10000',
      'in:9400',
    ]);
  });

  it('skips a transaction entirely when no configured address appears in it', async () => {
    const foreign = txFixture({
      txid: 'foreign-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_EXTERNAL, value: 1_000 } }],
      vout: [{ scriptpubkey_address: ADDR_EXTERNAL, value: 900 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [foreign] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    expect(events.map((e) => e.externalId)).not.toContain('foreign-tx');
  });
});

describe('bitcoin-esplora: unconfirmed transactions', () => {
  it('skips a transaction with status.confirmed === false', async () => {
    const pending = txFixture({
      txid: 'pending-tx',
      status: { confirmed: false },
      vout: [{ scriptpubkey_address: ADDR_A, value: 1_000 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [pending] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    expect(events).toHaveLength(0);
  });

  it('skips a confirmed-but-dateless transaction rather than stamping it "now" or NaN', async () => {
    // A test that only asserted the event was absent would pass just as
    // well if the module crashed instead of skipping - `drainAll` already
    // guards against that by letting a throw fail the test, but this also
    // pins the exact failure mode `conformance.ts` would reject on: a
    // non-finite or non-positive timestamp.
    const dateless = txFixture({
      txid: 'dateless-tx',
      status: { confirmed: true }, // no block_time
      vout: [{ scriptpubkey_address: ADDR_A, value: 1_000 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [dateless] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    expect(events.every((e) => e.externalId !== 'dateless-tx')).toBe(true);
    // Vacuous-pass guard: prove the fixture actually reached the module
    // rather than this assertion quantifying over an empty array for an
    // unrelated reason (e.g. a thrown error swallowed upstream).
    expect(events).toHaveLength(0);
  });
});

describe('bitcoin-esplora: coinbase input', () => {
  it('builds the receiving leg without throwing on a vin with no prevout', async () => {
    const coinbase = txFixture({
      txid: 'coinbase-tx',
      vin: [{}], // no `prevout` at all - a coinbase input
      vout: [{ scriptpubkey_address: ADDR_A, value: 625_000_000 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [coinbase] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    const event = events.find((e) => e.externalId === 'coinbase-tx');
    expect(event).toBeDefined();
    expect(event!.legs).toHaveLength(1);
    expect(event!.legs[0]).toMatchObject({
      direction: 'in',
      amount: '625000000',
      venue: ADDR_A,
    });
  });
});

describe('bitcoin-esplora: cursor advance', () => {
  it('stays on the same address, chaining off the last txid, while a page is full', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) =>
      txFixture({
        txid: `a-${i}`,
        vout: [{ scriptpubkey_address: ADDR_A, value: 1 }],
      }),
    );
    const page2 = [
      txFixture({
        txid: 'a-last',
        vout: [{ scriptpubkey_address: ADDR_A, value: 2 }],
      }),
    ];
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: page1 }],
        [chainUrl(ADDR_A, 'a-24'), { status: 200, body: page2 }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const first = await bitcoinEsplora.fetchEvents(config, null);
    // Stage 2 is the listed addresses; the empty first component is the
    // script type, which an addresses-only source has none of.
    expect(first.cursor).toBe('btc::2:0:0:a-24');

    const second = await bitcoinEsplora.fetchEvents(config, first.cursor);
    // A short page (1 < 25) ends address 0 and advances to address 1.
    expect(second.cursor).toBe('btc::2:1:0:');
  });

  it('advances the address index, not just the txid, once an address is exhausted', async () => {
    const short = [
      txFixture({
        txid: 'a-only',
        vout: [{ scriptpubkey_address: ADDR_A, value: 1 }],
      }),
    ];
    const bTx = [
      txFixture({
        txid: 'b-only',
        vout: [{ scriptpubkey_address: ADDR_B, value: 2 }],
      }),
    ];
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: short }],
        [txsUrl(ADDR_B), { status: 200, body: bTx }],
      ]),
    );

    const events = await drainAll();
    expect(events.map((e) => e.externalId).sort()).toEqual([
      'a-only',
      'b-only',
    ]);
  });

  it('returns null once every configured address is exhausted', async () => {
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const first = await bitcoinEsplora.fetchEvents(config, null);
    expect(first.cursor).toBe('btc::2:1:1:');
    const second = await bitcoinEsplora.fetchEvents(config, first.cursor);
    expect(second.cursor).toBeNull();
    expect(second.events).toHaveLength(0);
  });
});

describe('bitcoin-esplora: amount as string', () => {
  it('carries a satoshi value through as a decimal string, unscaled', async () => {
    const tx = txFixture({
      txid: 'amount-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_A, value: 150_000_000 } }],
      vout: [{ scriptpubkey_address: ADDR_A, value: 100_000_000 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [tx] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    const events = await drainAll();
    const event = events.find((e) => e.externalId === 'amount-tx')!;
    for (const leg of event.legs) {
      expect(typeof leg.amount).toBe('string');
    }
    const out = event.legs.find((l) => l.direction === 'out')!;
    const inLeg = event.legs.find((l) => l.direction === 'in')!;
    expect(out.amount).toBe('150000000');
    expect(inLeg.amount).toBe('100000000');
    // Never divided by 1e8 - satoshis stay satoshis; the pricing boundary
    // (src/prices/scale.ts, ASSET_DECIMALS['bitcoin:native'] = 8) scales.
    expect(out.assetId).toBe('bitcoin:native');
  });

  it('refuses a value JSON parsing has already rounded, chain-labelled as bitcoin', async () => {
    const tx = txFixture({
      txid: 'unsafe-tx',
      vout: [{ scriptpubkey_address: ADDR_A, value: 2 ** 53 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [tx] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );

    await expect(bitcoinEsplora.fetchEvents(config, null)).rejects.toThrow(
      /bitcoin: .*exceeds safe integer precision/,
    );
  });
});

describe('bitcoin-esplora: venue', () => {
  it('sets venue to addresses[0] even when a different configured address owns the transaction', async () => {
    // Only B appears (A is absent entirely), so B is "the first configured
    // address appearing in it" and is the one whose drain emits this
    // transaction - but the configured list is one wallet, and `venue` is
    // always addresses[0] (A), never the owning address. See the module
    // doc comment and the "multi-address rollup" tests below for why: using
    // the owning address as venue is the half-fix that drives a DIFFERENT
    // address's venue negative on a later spend.
    const bOnly = txFixture({
      txid: 'b-venue-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_B, value: 5_000 } }],
      vout: [{ scriptpubkey_address: ADDR_EXTERNAL, value: 4_500 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [] }],
        [txsUrl(ADDR_B), { status: 200, body: [bOnly] }],
      ]),
    );

    const events = await drainAll();
    const event = events.find((e) => e.externalId === 'b-venue-tx')!;
    expect(event.legs).toHaveLength(1);
    expect(event.legs.every((l) => l.venue === ADDR_A)).toBe(true);
  });
});

/** Sum of `in` legs minus `out` legs, in satoshis. Negative means value left
 *  the venue net of what arrived in the same event. */
const netSatoshis = (legs: { direction: string; amount: string }[]): number =>
  legs.reduce(
    (total, leg) =>
      total +
      (leg.direction === 'in' ? Number(leg.amount) : -Number(leg.amount)),
    0,
  );

describe('bitcoin-esplora: multi-address rollup', () => {
  it('nets a self-transfer between two configured addresses to the implicit fee, not a disposal plus a dropped receipt', async () => {
    // A sends 60,000 sats to B (also configured) with 39,000 change back to
    // A, on a 100,000 sat input. Fee = 1,000. Reported bug: the module used
    // to emit only out:100000 and in:39000 (both at venue A), treating the
    // 60,000 sent to B as a disposal that never happened, and B's receipt
    // was recorded nowhere - a silent loss of 60,000 sats of holdings.
    const selfTransfer = txFixture({
      txid: 'self-transfer-tx',
      vin: [{ prevout: { scriptpubkey_address: ADDR_A, value: 100_000 } }],
      vout: [
        { scriptpubkey_address: ADDR_B, value: 60_000 },
        { scriptpubkey_address: ADDR_A, value: 39_000 },
      ],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [selfTransfer] }],
        // B is a participant (one of the outputs), so Esplora's own listing
        // for B shows this transaction too; the ownership rule must still
        // suppress it there rather than emit it a second time.
        [txsUrl(ADDR_B), { status: 200, body: [selfTransfer] }],
      ]),
    );

    const events = await drainAll();
    const matches = events.filter(
      (event) => event.externalId === 'self-transfer-tx',
    );
    // Ownership is unaffected by this fix: still emitted exactly once.
    expect(matches).toHaveLength(1);

    const event = matches[0];
    expect(event.legs).toHaveLength(3);
    expect(event.legs.every((leg) => leg.venue === ADDR_A)).toBe(true);
    expect(
      [...event.legs]
        .map((leg) => ({ direction: leg.direction, amount: leg.amount }))
        .sort((a, b) => a.amount.localeCompare(b.amount)),
    ).toEqual([
      { direction: 'out', amount: '100000' },
      { direction: 'in', amount: '39000' },
      { direction: 'in', amount: '60000' },
    ]);
    // The true cost to this wallet is the 1,000 sat fee - not a 60,000 sat
    // disposal.
    expect(netSatoshis(event.legs)).toBe(-1_000);
  });

  it('never drives a configured address negative when a later transaction spends what an earlier one received at a different address', async () => {
    // Three events, in chronological order: an external deposit funds A,
    // the self-transfer above moves part of it to B, and B later spends
    // what it received. The half-fix (venue = the owning address) would
    // credit B's 60,000 sat receipt to venue A in the middle event, then
    // debit the same 60,000 from venue B in the last event - a withdrawal
    // from a venue that, on its own books, never received anything. With
    // `venue` always addresses[0], both the receipt and the later spend
    // land on the SAME venue, which is what keeps it solvent.
    const funding = txFixture({
      txid: 'funding-tx',
      status: { confirmed: true, block_time: 1_000 },
      vin: [
        { prevout: { scriptpubkey_address: ADDR_EXTERNAL, value: 100_000 } },
      ],
      vout: [{ scriptpubkey_address: ADDR_A, value: 100_000 }],
    });
    const selfTransfer = txFixture({
      txid: 'self-transfer-tx-2',
      status: { confirmed: true, block_time: 2_000 },
      vin: [{ prevout: { scriptpubkey_address: ADDR_A, value: 100_000 } }],
      vout: [
        { scriptpubkey_address: ADDR_B, value: 60_000 },
        { scriptpubkey_address: ADDR_A, value: 39_000 },
      ],
    });
    const spendFromB = txFixture({
      txid: 'spend-from-b-tx',
      status: { confirmed: true, block_time: 3_000 },
      vin: [{ prevout: { scriptpubkey_address: ADDR_B, value: 60_000 } }],
      vout: [{ scriptpubkey_address: ADDR_EXTERNAL, value: 59_000 }],
    });
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [funding, selfTransfer] }],
        // selfTransfer is also one of B's own transactions (B is an
        // output), and spendFromB is B's own (B is the input) - both
        // appear in B's listing, exactly as Esplora would report them.
        [txsUrl(ADDR_B), { status: 200, body: [spendFromB, selfTransfer] }],
      ]),
    );

    const events = await drainAll();
    const chronological = [...events].sort((a, b) => a.timestamp - b.timestamp);
    expect(chronological.map((e) => e.externalId)).toEqual([
      'funding-tx',
      'self-transfer-tx-2',
      'spend-from-b-tx',
    ]);

    // Every leg of every event lands on the single wallet venue - the
    // half-fix is exactly the case where `spend-from-b-tx`'s leg would
    // appear at venue B instead.
    const allVenues = new Set(
      chronological.flatMap((event) => event.legs.map((leg) => leg.venue)),
    );
    expect(allVenues).toEqual(new Set([ADDR_A]));

    let balance = 0;
    for (const event of chronological) {
      balance += netSatoshis(event.legs);
      expect(balance).toBeGreaterThanOrEqual(0);
    }
    // 100,000 in, net -1,000 on the self-transfer (the fee), then -60,000
    // spent from what was received: 100000 - 1000 - 60000 = 39000.
    expect(balance).toBe(39_000);
  });
});

describe('bitcoin-esplora: probe', () => {
  it('exercises the listing route the drain itself depends on, not a liveness route', async () => {
    // Stubbing ONLY this route is the assertion: stubFetch throws on any URL
    // it has no entry for, so a probe that reached for a liveness route - or
    // for the second configured address, which short-circuiting makes
    // unnecessary - would fail here rather than pass quietly.
    stubFetch(
      new Map([[txsUrl(ADDR_A), { status: 200, body: [txFixture()] }]]),
    );
    const result = await bitcoinEsplora.probe(config);
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('refuses an empty address list without naming any address', async () => {
    const result = await bitcoinEsplora.probe({ ...config, address: '  \n  ' });
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.message).not.toMatch(/bc1q/);
  });

  it('refuses a wallet whose every address is unused, rather than reporting success', async () => {
    // The reported bug, as a test. An unused address answers the listing
    // route with `200 []`, which the probe used to read as success - so
    // pasting a fresh receive address (what a wallet's UI shows by default)
    // gave a clean save and then a sync that finished having fetched
    // nothing, indistinguishable from a broken importer.
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [] }],
        [txsUrl(ADDR_B), { status: 200, body: [] }],
      ]),
    );
    const result = await bitcoinEsplora.probe(config);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITCOIN_ESPLORA_MESSAGES.noHistory);
    // Distinct from a transport failure: conflating the two would send the
    // user to check their base URL over a perfectly reachable instance.
    expect(result.message).not.toBe(
      BITCOIN_ESPLORA_MESSAGES.instanceUnreachable,
    );
    // Still no address in the message - it is stored as lastError and shown.
    expect(result.message).not.toMatch(/bc1q/);
  });

  it('accepts a list where only a LATER address has history', async () => {
    // A wallet accumulates unused addresses, and a list mixing used and
    // fresh ones is ordinary. Only an entirely empty wallet is refused, so
    // an empty FIRST address must not reject the whole list - which is the
    // behaviour a naive "check addresses[0]" fix would have produced.
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 200, body: [] }],
        [txsUrl(ADDR_B), { status: 200, body: [txFixture()] }],
      ]),
    );
    const result = await bitcoinEsplora.probe(config);
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('still reports an unreachable instance as unreachable, not as empty', async () => {
    stubFetch(
      new Map([
        [txsUrl(ADDR_A), { status: 500, body: null }],
        [txsUrl(ADDR_B), { status: 500, body: null }],
      ]),
    );
    const result = await bitcoinEsplora.probe(config);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITCOIN_ESPLORA_MESSAGES.instanceUnreachable);
  });
});
