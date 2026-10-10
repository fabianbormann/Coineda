import { describe, it, expect, vi, afterEach } from 'vitest';
import cardanoYaci from '@/sources/cardano-yaci';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';
import { ADDRESS_NO_TRANSACTIONS_YET } from '@/sources/addresses';
import type { FetchPage, SourceModule } from '@/sources/types';

/**
 * A Cardano source with SEVERAL addresses.
 *
 * Each listed address is resolved to its tier once per drain, then drained
 * on its own, with its own position in the cursor. A transaction between two
 * listed addresses is listed under both, and has to come out as the same
 * event from either side - events upsert on (sourceId, externalId), so two
 * different events for one hash would have the second overwrite the first.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

let seen: string[] = [];

const stub = (table: Record<string, unknown>) => {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      return key in table
        ? new Response(JSON.stringify(table[key]), { status: 200 })
        : new Response('{}', { status: 404 });
    }),
  );
};

const drain = async (
  module: SourceModule,
  config: Record<string, string>,
): Promise<FetchPage[]> => {
  const pages: FetchPage[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page: FetchPage = await module.fetchEvents(config, cursor);
    pages.push(page);
    cursor = page.cursor;
    if (cursor === null) break;
  }
  return pages;
};

const lovelace = (quantity: string) => [{ unit: 'lovelace', quantity }];

describe('the address tier with two addresses (Yaci)', () => {
  const HOST = 'https://yaci-store.preprod.colo2.cf-systems.org';
  const ROOT = `${HOST}/api/v1`;
  const ONE = 'addr1_listed_one';
  const TWO = 'addr1_listed_two';
  const config = { baseUrl: HOST, addressList: `${ONE}\n${TWO}` };
  const listing = (address: string) =>
    `${ROOT}/addresses/${address}/transactions?page=1&count=20&order=asc`;

  const routes = (): Record<string, unknown> => ({
    // An address with no staking part: the address tier, no account probe.
    [`${ROOT}/addresses/${ONE}`]: { stake_address: null },
    [`${ROOT}/addresses/${TWO}`]: { stake_address: null },
    [listing(ONE)]: [
      { tx_hash: 't1', block_time: 1_700_000_000 },
      { tx_hash: 'shared', block_time: 1_700_000_100 },
    ],
    [listing(TWO)]: [
      { tx_hash: 'shared', block_time: 1_700_000_100 },
      { tx_hash: 't2', block_time: 1_700_000_200 },
    ],
    [`${ROOT}/txs/t1/utxos`]: {
      inputs: [{ address: 'addr1_theirs', amount: lovelace('600') }],
      outputs: [{ address: ONE, amount: lovelace('500') }],
    },
    [`${ROOT}/txs/shared/utxos`]: {
      inputs: [{ address: ONE, amount: lovelace('300') }],
      outputs: [
        { address: TWO, amount: lovelace('250') },
        { address: 'addr1_theirs', amount: lovelace('40') },
      ],
    },
    [`${ROOT}/txs/t2/utxos`]: {
      inputs: [{ address: TWO, amount: lovelace('100') }],
      outputs: [{ address: 'addr1_theirs', amount: lovelace('90') }],
    },
  });

  it('drains both addresses, one position per address in the cursor', async () => {
    stub(routes());
    const pages = await drain(cardanoYaci, config);
    expect(pages).toHaveLength(2);
    const state = JSON.parse(atob(pages[0].cursor!.slice('list:'.length)));
    expect(state.positions).toEqual({ [ONE]: null, [TWO]: 'addr:1' });
    expect(pages[1].cursor).toBeNull();
    expect(seen.filter((url) => url.includes('/transactions?'))).toEqual([
      listing(ONE),
      listing(TWO),
    ]);
  });

  it('emits events from both addresses, venues per address, one event per hash', async () => {
    stub(routes());
    const events = (await drain(cardanoYaci, config)).flatMap(
      (page) => page.events,
    );
    expect(events.map((event) => event.externalId)).toEqual([
      't1',
      'shared',
      'shared',
      't2',
    ]);
    const [, fromOne, fromTwo] = events;
    // Listed under both: the same event either way.
    expect(fromOne).toEqual(fromTwo);
    expect(
      fromOne.legs.map((leg) => [leg.direction, leg.venue, leg.amount]),
    ).toEqual([
      ['out', ONE, '300'],
      ['in', TWO, '250'],
    ]);
    expect(events[3].legs.map((leg) => leg.venue)).toEqual([TWO]);
  });

  it('reads a never-seen second address as no transactions yet: events of the first, a note, no error', async () => {
    const table = routes();
    delete table[`${ROOT}/addresses/${TWO}`];
    delete table[listing(TWO)];
    stub(table);
    const pages = await drain(cardanoYaci, config);
    expect(
      pages.flatMap((page) => page.events).map((event) => event.externalId),
    ).toEqual(['t1', 'shared']);
    expect(pages.flatMap((page) => page.notes ?? [])).toEqual([
      { message: ADDRESS_NO_TRANSACTIONS_YET, params: { line: '2' } },
    ]);
    expect(pages.at(-1)?.cursor).toBeNull();
  });

  it('reads a 404 on the second address listing mid-drain the same way', async () => {
    const table = routes();
    // The lookup still answers, so the address resolves to the address
    // tier and the 404 first surfaces on the drain's own listing request.
    delete table[listing(TWO)];
    stub(table);
    const pages = await drain(cardanoYaci, config);
    expect(
      pages.flatMap((page) => page.events).map((event) => event.externalId),
    ).toEqual(['t1', 'shared']);
    expect(pages.flatMap((page) => page.notes ?? [])).toEqual([
      { message: ADDRESS_NO_TRANSACTIONS_YET, params: { line: '2' } },
    ]);
  });

  it('keeps the "address never seen" error for a single configured address', async () => {
    stub({});
    await expect(
      cardanoYaci.fetchEvents({ baseUrl: HOST, addressList: TWO }, null),
    ).rejects.toThrow(CARDANO_MESSAGES.addressNeverSeen);
    // The legacy single-address config reads the same way.
    await expect(
      cardanoYaci.fetchEvents({ baseUrl: HOST, address: TWO }, null),
    ).rejects.toThrow(CARDANO_MESSAGES.addressNeverSeen);
  });

  it('the probe reports the first failing address by its line', async () => {
    stub(routes());
    // A stake address on an instance without the account routes.
    expect(
      await cardanoYaci.probe({
        baseUrl: HOST,
        addressList: `${ONE}\nstake1_listed_account`,
      }),
    ).toEqual({
      ok: false,
      message: CARDANO_MESSAGES.listedStakeAddressNeedsAccountApi,
      messageParams: { line: '2' },
    });
    expect(await cardanoYaci.probe(config)).toEqual({
      ok: true,
      readOnly: true,
    });
  });
});

describe('the account tier with two accounts (Blockfrost)', () => {
  const HOST = 'https://cardano-mainnet.blockfrost.io';
  const ROOT = `${HOST}/api/v0`;
  const STAKE_A = 'stake1_listed_a';
  const STAKE_B = 'stake1_listed_b';
  const A1 = 'addr1_of_a';
  const B1 = 'addr1_of_b';
  const config = {
    baseUrl: HOST,
    projectId: 'k',
    addressList: `${STAKE_A}\n${STAKE_B}`,
  };

  const account = (stake: string, address: string, txs: string[]) => ({
    [`${ROOT}/accounts/${stake}/transactions?page=1&count=20&order=asc`]:
      txs.map((tx_hash) => ({
        address,
        tx_hash,
        block_time: tx_hash === 'between' ? 1_700_000_100 : 1_700_000_000,
      })),
    [`${ROOT}/accounts/${stake}/addresses?page=1&count=100`]: [{ address }],
    [`${ROOT}/accounts/${stake}/rewards?page=1&count=100`]: [],
    [`${ROOT}/accounts/${stake}/withdrawals?page=1&count=100`]: [],
  });

  const routes = (): Record<string, unknown> => ({
    ...account(STAKE_A, A1, ['a-only', 'between']),
    ...account(STAKE_B, B1, ['between']),
    [`${ROOT}/txs/a-only/utxos`]: {
      inputs: [{ address: 'addr1_theirs', amount: lovelace('900') }],
      outputs: [{ address: A1, amount: lovelace('800') }],
    },
    [`${ROOT}/txs/between/utxos`]: {
      inputs: [{ address: A1, amount: lovelace('500') }],
      outputs: [{ address: B1, amount: lovelace('480') }],
    },
  });

  it('drains each account and builds a transfer between them identically from both', async () => {
    stub(routes());
    const pages = await drain(cardanoBlockfrost, config);
    expect(pages).toHaveLength(2);
    const events = pages.flatMap((page) => page.events);
    expect(events.map((event) => event.externalId)).toEqual([
      'a-only',
      'between',
      'between',
    ]);
    expect(events[1]).toEqual(events[2]);
    expect(
      events[1].legs.map((leg) => [leg.direction, leg.venue, leg.amount]),
    ).toEqual([
      ['out', STAKE_A, '500'],
      ['in', STAKE_B, '480'],
    ]);
  });

  it('treats the same address listed twice, in either case, as one', async () => {
    stub(routes());
    const pages = await drain(cardanoBlockfrost, {
      ...config,
      addressList: `${STAKE_A}\n${STAKE_A.toUpperCase()}`,
    });
    // Deduped after normalising, so this is one address: the single path.
    expect(
      pages.flatMap((page) => page.events).map((e) => e.externalId),
    ).toEqual(['a-only', 'between']);
  });
});
