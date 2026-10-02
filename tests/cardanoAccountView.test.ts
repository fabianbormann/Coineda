import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import cardanoYaci from '@/sources/cardano-yaci';
import { foldDisposals, isInternalTransfer } from '@/ledger/balances';
import type { LedgerEvent } from '@/ledger/types';
import { fetchRewardEvents } from '@/sources/cardano/translator';

const HOST = 'https://yaci-store.preprod.colo2.cf-systems.org';

/** The payment address the transaction fixtures were recorded against. */
const RECORDED_ADDRESS =
  'addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm';

/** The stake address that payment address belongs to, as recorded. */
const RECORDED_STAKE =
  'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk';

/** A different preprod account, recorded because it has real epoch rewards. */
const DELEGATED_STAKE =
  'stake_test1uqfzskazkqhtph40s82g93n4srh3x463lazy0n2gkv9rnyq7acw3c';

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/cardano-yaci/fixtures',
);

const config = { baseUrl: HOST, address: RECORDED_ADDRESS };

const loadFixtures = async (): Promise<Map<string, unknown>> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<string, unknown>();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const raw = await readFile(path.join(FIXTURES_DIR, file), 'utf8');
    const { url, body } = JSON.parse(raw) as { url: string; body: unknown };
    fixtures.set(url, body);
  }
  return fixtures;
};

const stubFetch = (fixtures: Map<string, unknown>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = fixtures.get(String(url));
      if (!body) {
        throw new Error(`no recorded fixture for ${String(url)}`);
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
};

beforeEach(async () => {
  stubFetch(await loadFixtures());
});

const provider = {
  host: () => HOST,
  apiPath: '/api/v1',
  headers: () => ({}),
  exampleHost: HOST,
  probeMessage: () => 'unreachable',
};

describe('cardano account view', () => {
  it('uses the stake address as the venue, not the payment address', async () => {
    // A Cardano wallet rotates payment addresses. Tracking one address makes
    // change sent to a DIFFERENT address of the same wallet look like a real
    // disposal - a false taxable event that nets no better, because the
    // change leg is absent rather than wrong. The stake address is the
    // account, which is the granularity the user actually owns.
    const { events } = await cardanoYaci.fetchEvents(config, null);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const leg of event.legs) {
        expect(leg.venue).toBe(RECORDED_STAKE);
      }
    }
  });

  it('still emits legs only for the tracked account, never a counterparty', async () => {
    // The milestone-1 contract, restated at the new granularity: filtering by
    // stake address must not start admitting other people's legs.
    const { events } = await cardanoYaci.fetchEvents(config, null);
    const venues = new Set(
      events.flatMap((event) => event.legs.map((leg) => leg.venue)),
    );
    expect([...venues]).toEqual([RECORDED_STAKE]);
  });

  it('falls back to the payment address when an entry has no stake address', async () => {
    // Enterprise and Byron addresses have stake_address: null. They are not
    // an error - they are an account of one address.
    stubFetch(
      new Map<string, unknown>([
        [
          `${HOST}/api/v1/addresses/addr_test1_enterprise/transactions?page=1&count=20&order=asc`,
          [{ tx_hash: 'tx1', block_time: 1700000000 }],
        ],
        [
          `${HOST}/api/v1/txs/tx1/utxos`,
          {
            inputs: [],
            outputs: [
              {
                address: 'addr_test1_enterprise',
                stake_address: null,
                amount: [{ unit: 'lovelace', quantity: '1000000' }],
              },
            ],
          },
        ],
      ]),
    );

    const { events } = await cardanoYaci.fetchEvents(
      { baseUrl: HOST, address: 'addr_test1_enterprise' },
      null,
    );
    expect(events[0].legs[0].venue).toBe('addr_test1_enterprise');
  });

  it('makes a send between two addresses of one wallet an internal transfer', async () => {
    // THE reason for account view, stated as the behaviour a user would
    // feel. Moving 500 from one of your addresses to another of your own
    // addresses is not a disposal - but under per-address tracking the
    // receiving leg sits at an address the module was not watching, so it is
    // dropped and what remains is `out 500`, which reads as a real disposal
    // of everything that left. A fabricated taxable event, on a movement
    // that never left the user's control.
    //
    // Both addresses share one stake address, so with account view the
    // receiving leg is kept, the two legs net to zero, and the event
    // classifies as internal.
    const account = 'stake_test1_mine';
    stubFetch(
      new Map<string, unknown>([
        [
          `${HOST}/api/v1/addresses/addr_test1_a/transactions?page=1&count=20&order=asc`,
          [{ tx_hash: 'selfsend', block_time: 1700000000 }],
        ],
        [
          `${HOST}/api/v1/txs/selfsend/utxos`,
          {
            inputs: [
              {
                address: 'addr_test1_a',
                stake_address: account,
                amount: [{ unit: 'lovelace', quantity: '500' }],
              },
            ],
            outputs: [
              {
                address: 'addr_test1_b',
                stake_address: account,
                amount: [{ unit: 'lovelace', quantity: '500' }],
              },
            ],
          },
        ],
        [`${HOST}/api/v1/accounts/${account}/rewards`, []],
      ]),
    );

    const { events } = await cardanoYaci.fetchEvents(
      { baseUrl: HOST, address: 'addr_test1_a' },
      null,
    );
    const transfer = events.find((event) => event.kind === 'transfer');
    expect(transfer).toBeDefined();

    const owned = new Set([account]);
    const asLedgerEvent = {
      ...transfer!,
      id: 'e1',
      sourceId: 's1',
    } as LedgerEvent;

    expect(isInternalTransfer(asLedgerEvent, owned)).toBe(true);
    expect(foldDisposals([asLedgerEvent], owned)).toEqual([]);
  });

  it('refuses a stake address instead of syncing nothing', async () => {
    // Yaci answers 200 [] for a stake address on the address endpoint, so
    // without this guard the user gets a SUCCESSFUL sync with zero
    // transactions and no indication anything is wrong.
    const stakeConfig = { baseUrl: HOST, address: RECORDED_STAKE };

    const probed = await cardanoYaci.probe(stakeConfig);
    expect(probed.ok).toBe(false);
    expect(probed.message).toBeTruthy();

    await expect(cardanoYaci.fetchEvents(stakeConfig, null)).rejects.toThrow();
  });
});

describe('cardano staking rewards', () => {
  it('builds a reward event per epoch reward', async () => {
    const events = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    expect(events).toHaveLength(10);
    for (const event of events) {
      expect(event.kind).toBe('reward');
      expect(event.origin).toBe('derived');
      expect(event.legs).toHaveLength(1);
      expect(event.legs[0]).toMatchObject({
        assetId: 'cardano:lovelace',
        direction: 'in',
        venue: DELEGATED_STAKE,
        role: 'principal',
      });
    }
  });

  it('dates a reward from its epoch end, not from today', async () => {
    // A reward carries only an epoch number. Without the epoch lookup every
    // reward would be undated or stamped "now", landing in the wrong tax
    // year - and a tax year is the whole point of the number.
    const events = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    const epoch273 = events.find((event) => event.externalId.endsWith(':273'));
    expect(epoch273).toBeDefined();
    // Recorded: /api/v1/epochs/273 -> end_time 1772408266 (seconds).
    expect(epoch273?.timestamp).toBe(1772408266 * 1000);
  });

  it('keeps amounts as decimal strings', async () => {
    const events = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    for (const event of events) {
      expect(typeof event.legs[0].amount).toBe('string');
      expect(event.legs[0].amount).toMatch(/^\d+$/);
    }
  });

  it('gives each reward a replay-stable externalId', async () => {
    const first = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    const second = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    expect(first.map((e) => e.externalId)).toEqual(
      second.map((e) => e.externalId),
    );
    expect(new Set(first.map((e) => e.externalId)).size).toBe(first.length);
    expect(first[0].externalId).toContain(DELEGATED_STAKE);
  });

  it('records whether a reward was earned as member or leader', async () => {
    // Pool-operator (leader) rewards may be business income rather than
    // capital income in some jurisdictions, so the distinction must survive
    // ingestion for a tax module to be able to use it.
    const events = await fetchRewardEvents(
      provider,
      { baseUrl: HOST },
      DELEGATED_STAKE,
    );
    expect(events[0].note).toContain('member');
  });

  it('throws rather than silently accept a reward amount JSON already rounded', async () => {
    // The provider returns `amount` as a JSON NUMBER, unlike the utxo
    // endpoints' strings, so JSON.parse has already rounded anything above
    // Number.MAX_SAFE_INTEGER by the time this code sees it. There is no way
    // to recover the true value here, so failing the sync is the only honest
    // option - a wrong amount would reach a tax report.
    stubFetch(
      new Map<string, unknown>([
        [
          `${HOST}/api/v1/accounts/${DELEGATED_STAKE}/rewards`,
          // 2**53, the first integer Number.isSafeInteger rejects. Written
          // as an expression because the literal form is itself flagged by
          // eslint's no-loss-of-precision - the lint rule and this guard are
          // protecting against the same thing at different layers.
          [{ epoch: 273, amount: 2 ** 53, type: 'member' }],
        ],
        [
          `${HOST}/api/v1/epochs/273`,
          { number: 273, start_time: 1771978996, end_time: 1772408266 },
        ],
      ]),
    );

    await expect(
      fetchRewardEvents(provider, { baseUrl: HOST }, DELEGATED_STAKE),
    ).rejects.toThrow(/precision|safe integer/i);
  });

  it('looks up each epoch once however many rewards reference it', async () => {
    // Ten rewards across ten epochs is ten lookups; a naive implementation
    // that refetched per reward would multiply requests against a
    // rate-limited provider for no new information.
    await fetchRewardEvents(provider, { baseUrl: HOST }, DELEGATED_STAKE);
    const epochCalls = (
      fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter(([url]) => String(url).includes('/epochs/'));
    expect(epochCalls).toHaveLength(new Set(epochCalls.map(String)).size);
  });
});
