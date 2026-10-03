import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runConformance } from '@/sources/conformance';
import bitcoinEsplora from '@/sources/bitcoin-esplora';
import type { DerivedEvent } from '@/sources/types';

/**
 * The first Esplora-recorded fixtures, and the gate that makes the Bitcoin
 * module mergeable.
 *
 * Recorded from two PUBLIC mainnet addresses, never the owner's, against
 * blockstream.info. Esplora needs no credential, so no fixture holds one.
 *
 * What the recordings contain, measured from the fixtures rather than
 * assumed: 48 distinct transactions for the primary address over two pages
 * (25 then a short 23, which is what ends that address and advances the
 * cursor's address index), and a single transaction for the second address -
 * which is the SAME transaction as one of the primary's. That overlap is the
 * point: the drain genuinely encounters it twice, once under each configured
 * address, so the ownership rule has to emit it exactly once.
 *
 * The one thing these fixtures CANNOT express is an unconfirmed transaction.
 * Esplora reports a transaction as unconfirmed only while it sits in the
 * mempool, so by the time a recording is committed it has confirmed - all 48
 * here are confirmed, and no amount of re-recording changes that. The skip
 * rule is therefore covered by a synthetic transaction in
 * tests/bitcoinEsplora.test.ts and deliberately not re-tested here; faking
 * `confirmed: false` in a recorded body would defeat the purpose of
 * recording, which is that nobody hand-writes provider JSON.
 */
const PRIMARY = 'bc1qvszzhppfy5r206kyy6rfncn4mzyt6mtg2ax8qu';
const SECOND = 'bc1qctu93ppcegfwh2fqfgzsf3jsqu23x7wkacxw7s';

/**
 * The transaction both configured addresses appear in: it spends 6014990
 * satoshis from PRIMARY and pays 615932 to SECOND, 5397873 to a stranger,
 * with a 1185 fee. Recorded under both addresses (fixtures 001 and 003).
 */
const SHARED_TXID =
  'fa5fe3f68eef7e95e45c55d8776b27083af8e661257ec28b69608871c627b17d';
const SHARED_SPENT = '6014990';
const SHARED_RECEIVED = '615932';
/** Seconds on the wire; the module multiplies by 1000. */
const SHARED_BLOCK_TIME_MS = 1790976894000;

// Order is semantic: PRIMARY before SECOND means the shared transaction is
// PRIMARY's, and `venue` is PRIMARY for every leg this source emits.
const config = { address: `${PRIMARY}\n${SECOND}` };

const RECORDED_TRANSACTIONS = 48;

/**
 * Legs across the whole drain: 46 transactions contribute one each, the
 * two-address transaction contributes two (one per side), and the
 * consolidation below contributes three (all on the same side).
 */
const RECORDED_LEGS = 51;

/**
 * A real UTXO consolidation: this transaction spends THREE separate outputs
 * all belonging to PRIMARY, in one transaction, on the same side.
 *
 * It is the case a per-address leg filter cannot express, and the reason the
 * leg count above is asserted exactly rather than as a lower bound.
 */
const CONSOLIDATION_TXID =
  '0eb569f5565d11ed49545f0b4b77c0f62eb8e6592ce13a9358e502fa3711586d';
const CONSOLIDATION_INPUTS = ['4404743', '6227894', '4646671'];

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/bitcoin-esplora/fixtures',
);

type Recorded = { url: string; status: number; body: unknown };

const loadFixtures = async (): Promise<Map<string, Recorded>> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<string, Recorded>();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const recorded = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, file), 'utf8'),
    ) as Recorded;
    fixtures.set(recorded.url, recorded);
  }
  return fixtures;
};

// Keyed on the requested URL, not a call counter: runConformance drains
// twice to check idempotence, so a counter would have advanced by the second
// drain and this module would look non-idempotent for the harness's reason
// rather than its own. The same choice, for the same reason, that
// tests/cardanoBlockfrostFixtures.test.ts makes.
const stubFetch = (fixtures: Map<string, Recorded>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const recorded = fixtures.get(String(url));
      if (!recorded) {
        // A throw, not a blanket 404: a 404 reads as a route the provider
        // does not serve, which would hide a typo'd URL in the module.
        throw new Error(`no recorded fixture for ${String(url)}`);
      }
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
      });
    }),
  );
};

const drainAll = async (): Promise<DerivedEvent[]> => {
  const all: DerivedEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await bitcoinEsplora.fetchEvents(config, cursor);
    all.push(...page.events);
    cursor = page.cursor;
  } while (cursor !== null);
  return all;
};

let fixtures: Map<string, Recorded>;

beforeEach(async () => {
  fixtures = await loadFixtures();
  stubFetch(fixtures);
});

describe('bitcoin-esplora, against recorded Esplora responses', () => {
  it('recorded only confirmed transactions, so the skip rule stays synthetic', () => {
    // Pins the reasoning in this file's header rather than leaving it as a
    // comment: if a recording ever DOES carry an unconfirmed transaction,
    // this says so instead of letting the claim rot.
    const bodies = [...fixtures.values()].filter((f) =>
      f.url.includes('/address/'),
    );
    expect(bodies.length).toBeGreaterThan(0);
    let counted = 0;
    for (const recorded of bodies) {
      for (const tx of recorded.body as { status: { confirmed: boolean } }[]) {
        counted += 1;
        expect(tx.status.confirmed).toBe(true);
      }
    }
    // Without this the loop above could pass over empty bodies.
    expect(counted).toBeGreaterThan(RECORDED_TRANSACTIONS);
  });

  it('passes the conformance suite', async () => {
    await expect(
      runConformance(bitcoinEsplora, { config }),
    ).resolves.toBeUndefined();
  });

  it('emits one event per transaction over two real pages', async () => {
    const all = await drainAll();
    // Every recorded transaction touches PRIMARY, and the one the second
    // address also appears in must not be emitted twice.
    expect(all).toHaveLength(RECORDED_TRANSACTIONS);
    expect(new Set(all.map((event) => event.externalId)).size).toBe(
      RECORDED_TRANSACTIONS,
    );
  });

  it('emits the two-address transaction exactly once, with both addresses legs', async () => {
    const all = await drainAll();
    const shared = all.filter((event) => event.externalId === SHARED_TXID);
    expect(shared).toHaveLength(1);

    // The whole rollup fix in one assertion: the spent input from PRIMARY
    // AND the 615932 received by SECOND, both attributed to the one venue.
    // Filtering legs to the owning address alone - the defect this replaced
    // - drops the second leg and reports a disposal that never happened.
    expect(shared[0].legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: SHARED_SPENT,
        direction: 'out',
        venue: PRIMARY,
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: SHARED_RECEIVED,
        direction: 'in',
        venue: PRIMARY,
        role: 'principal',
      },
    ]);
  });

  it('nets the two-address transaction to what truly left the wallet', async () => {
    const all = await drainAll();
    const shared = all.find((event) => event.externalId === SHARED_TXID);
    expect(shared).toBeDefined();

    const net = shared!.legs.reduce(
      (total, leg) =>
        total + (leg.direction === 'in' ? 1 : -1) * Number(leg.amount),
      0,
    );
    // 5397873 to a stranger plus an 1185 fee. Asserted as the sum rather
    // than a bare constant so a wrong leg set cannot coincidentally match:
    // the 615932 paid to the user's own second address is NOT a disposal,
    // and a module that dropped that leg would report -6014990 here.
    expect(net).toBe(-(5397873 + 1185));
  });

  it('keeps all three legs when one transaction spends three of the same address own outputs', async () => {
    // A UTXO consolidation, from the recordings rather than invented: three
    // separate outputs belonging to PRIMARY, spent in one transaction, all on
    // the input side. This is the shape a per-address leg filter cannot
    // express - one leg per address would keep 4404743 and silently discard
    // 6227894 + 4646671, i.e. 10874565 satoshis of disposal, on a wallet
    // doing the single most ordinary thing a wallet does.
    const all = await drainAll();
    const consolidation = all.find(
      (event) => event.externalId === CONSOLIDATION_TXID,
    );
    expect(consolidation).toBeDefined();

    const outs = consolidation!.legs.filter((leg) => leg.direction === 'out');
    // The exact multiset, so neither a dropped leg nor a summed-into-one leg
    // can pass: a module that collapsed them into a single 15279308 leg
    // would also be wrong, because the provider reported three.
    expect(outs.map((leg) => leg.amount)).toEqual(CONSOLIDATION_INPUTS);
    // The sole output pays a stranger, so the whole input is a disposal.
    expect(consolidation!.legs).toHaveLength(CONSOLIDATION_INPUTS.length);
  });

  it('keeps every amount a decimal string of satoshis', async () => {
    const all = await drainAll();
    const legs = all.flatMap((event) => event.legs);
    // The EXACT count, not `> 48`. A loose lower bound let a real defect
    // pass: deduping legsFrom by address - which drops every repeated UTXO
    // belonging to the same address - leaves 49 legs, and 49 > 48 held, so
    // the whole suite stayed green while 10,874,565 satoshis of disposal
    // vanished from one transaction. See the consolidation test below.
    expect(legs).toHaveLength(RECORDED_LEGS);
    for (const leg of legs) {
      expect(typeof leg.amount).toBe('string');
      // Satoshis are integers. A module that divided by 1e8 to "normalise"
      // to whole bitcoin would produce a fractional string here, and every
      // fiat figure downstream would be 100,000,000x wrong - the exact
      // defect ASSET_DECIMALS exists to prevent.
      expect(leg.amount).toMatch(/^\d+$/);
      expect(leg.assetId).toBe('bitcoin:native');
      expect(leg.venue).toBe(PRIMARY);
    }
    // The largest recorded amount, unscaled, proving the point positively
    // rather than only by the regex above.
    expect(legs.some((leg) => leg.amount === SHARED_SPENT)).toBe(true);
  });

  it('stamps timestamps in milliseconds', async () => {
    const all = await drainAll();
    const shared = all.find((event) => event.externalId === SHARED_TXID);
    // A known transaction's exact value, not merely "a large number": the
    // seconds-to-milliseconds multiply has to happen exactly once, and
    // `> 1e12` would pass for a value multiplied twice.
    expect(shared?.timestamp).toBe(SHARED_BLOCK_TIME_MS);
  });
});
