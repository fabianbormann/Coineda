import { describe, it, expect, vi, afterEach } from 'vitest';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { runConformance } from '@/sources/conformance';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';
import { rewardsVenueOf } from '@/sources/cardano/translator';

const HOST = 'https://cardano-mainnet.blockfrost.io';
const ROOT = `${HOST}/api/v0`;
const STAKE = 'stake1_account_fixture';
const A1 = 'addr1_mine_one';
const A2 = 'addr1_mine_two';

const config = { baseUrl: HOST, projectId: 'k', address: STAKE };

/** Two listing pages: 'tx1' under both addresses, then 'tx2'. */
const listing = (page: number) =>
  page === 1
    ? [
        { address: A1, tx_hash: 'tx1', block_time: 1_667_587_468 },
        { address: A2, tx_hash: 'tx1', block_time: 1_667_587_468 },
        { address: A1, tx_hash: 'tx2', block_time: 1_667_595_248 },
      ]
    : [];

const utxos = (hash: string) => ({
  hash,
  inputs: [
    { address: A1, amount: [{ unit: 'lovelace', quantity: '1000' }] },
    { address: 'addr1_theirs', amount: [{ unit: 'lovelace', quantity: '77' }] },
  ],
  outputs: [{ address: A2, amount: [{ unit: 'lovelace', quantity: '900' }] }],
});

// No separate `count=1` probe entries any more: the tier check requests the
// drain's own first-page URLs, so the routes below serve the probe and the
// drain alike - see 'probes nothing the drain does not request itself'.
const routes = (overrides: Record<string, unknown> = {}) => ({
  [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
    listing(1),
  [`${ROOT}/accounts/${STAKE}/addresses?page=1&count=100`]: [
    { address: A1 },
    { address: A2 },
  ],
  // Paged, like every other account route. Page 1 is short, so no page 2 is
  // requested - see drainPagedRoute.
  [`${ROOT}/accounts/${STAKE}/rewards?page=1&count=100`]: [
    { epoch: 500, amount: 123456, type: 'member' },
  ],
  // No withdrawals on this synthetic account; the withdrawal legs have
  // their own file, tests/cardanoRewardPot.test.ts.
  [`${ROOT}/accounts/${STAKE}/withdrawals?page=1&count=100`]: [],
  [`${ROOT}/epochs/500`]: { end_time: 1_700_000_000 },
  [`${ROOT}/txs/tx1/utxos`]: utxos('tx1'),
  [`${ROOT}/txs/tx2/utxos`]: utxos('tx2'),
  ...overrides,
});

let seen: string[] = [];

const stub = (table: Record<string, unknown>) => {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      if (!(key in table)) {
        return new Response('{}', { status: 404 });
      }
      return new Response(JSON.stringify(table[key]), { status: 200 });
    }),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the account tier', () => {
  it('drains the account listing, not the address listing', async () => {
    stub(routes());
    await cardanoBlockfrost.fetchEvents(config, null);
    expect(
      seen.some((url) =>
        url.includes(`/accounts/${STAKE}/transactions?page=1&count=20`),
      ),
    ).toBe(true);
    expect(seen.some((url) => url.includes('/addresses/addr'))).toBe(false);
  });

  it('emits one event per transaction, not one per listing row', async () => {
    stub(routes());
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    const transfers = events.filter((event) => event.kind === 'transfer');
    expect(transfers.map((event) => event.externalId)).toEqual(['tx1', 'tx2']);
  });

  it('reports every leg under the account and drops the counterparty', async () => {
    stub(routes());
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    const tx1 = events.find((event) => event.externalId === 'tx1');
    expect(tx1?.legs.map((leg) => leg.venue)).toEqual([STAKE, STAKE]);
    expect(tx1?.legs.map((leg) => leg.amount)).toEqual(['1000', '900']);
  });

  it('fetches staking rewards without needing any transaction first', async () => {
    // The gap this tier closes. On the address path the account is read off
    // the transactions page 1 happened to return, so a freshly derived
    // address resolved no account and its staking income was absent with
    // nothing saying why. Here the account is known before the first
    // listing request.
    stub({
      ...routes(),
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: [],
    });
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    expect(events.map((event) => event.kind)).toEqual(['reward']);
    expect(events[0].legs[0].amount).toBe('123456');
    // The reward pot, not the account's utxo venue.
    expect(events[0].legs[0].venue).toBe(rewardsVenueOf(STAKE));
  });

  it('skips a transaction the account moved no value in', async () => {
    // Review Focus 4: a collateral- or reference-input-only row. Zero legs
    // is correct, and an event with no legs is rejected by conformance.
    stub({
      ...routes(),
      [`${ROOT}/txs/tx2/utxos`]: {
        hash: 'tx2',
        inputs: [
          {
            address: 'addr1_theirs',
            amount: [{ unit: 'lovelace', quantity: '5' }],
          },
        ],
        outputs: [],
      },
    });
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    expect(events.map((event) => event.externalId)).toEqual([
      'tx1',
      'reward:' + STAKE + ':500',
    ]);
  });

  it('converts block_time from seconds to epoch milliseconds', async () => {
    stub(routes());
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    const tx1 = events.find((event) => event.externalId === 'tx1');
    expect(tx1?.timestamp).toBe(1_667_587_468_000);
  });

  it('terminates on a short page', async () => {
    stub(routes());
    const { cursor } = await cardanoBlockfrost.fetchEvents(config, null);
    expect(cursor).toBeNull();
  });

  it('carries the page, the boundary hash and the account in a full page’s cursor', async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({
      address: A1,
      tx_hash: `t${i}`,
      block_time: 1_667_587_468,
    }));
    stub({
      ...routes({
        [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
          full,
      }),
      ...Object.fromEntries(
        full.map((r) => [`${ROOT}/txs/${r.tx_hash}/utxos`, utxos(r.tx_hash)]),
      ),
    });
    const { cursor } = await cardanoBlockfrost.fetchEvents(config, null);
    expect(cursor).toBe(`acct:2:t19:${STAKE}`);
  });

  it('resumes from that cursor without resolving the tier again', async () => {
    stub({
      ...routes({
        [`${ROOT}/accounts/${STAKE}/transactions?page=2&count=20&order=asc`]: [
          { address: A1, tx_hash: 'tx9', block_time: 1_667_600_000 },
        ],
        [`${ROOT}/txs/tx9/utxos`]: utxos('tx9'),
      }),
    });
    const { events } = await cardanoBlockfrost.fetchEvents(
      config,
      `acct:2:t19:${STAKE}`,
    );
    expect(events.map((event) => event.externalId)).toEqual(['tx9']);
    // No tier check and no reward fetch on a later page. The tier check is
    // no longer identifiable by a 'count=1' suffix - it requests the
    // drain's own URLs now - so what isolates it is the PAGE: resolving the
    // tier would list transactions at page=1, and this drain is on page 2.
    // (The address-set fetch is at page=1 on every page by design, hence
    // matching the transactions route specifically.)
    expect(seen.some((url) => url.includes('/transactions?page=1'))).toBe(
      false,
    );
    expect(seen.some((url) => url.includes('/rewards'))).toBe(false);
  });

  it('passes the conformance gate, including idempotence across two drains', async () => {
    stub(routes());
    await expect(
      runConformance(cardanoBlockfrost, { config }),
    ).resolves.toBeUndefined();
  });

  it('declares the reward kind it now reliably emits', () => {
    expect([...cardanoBlockfrost.manifest.emits].sort()).toEqual([
      'reward',
      'transfer',
    ]);
  });

  it('probes as ok on an instance that serves the account routes', async () => {
    stub(routes());
    await expect(cardanoBlockfrost.probe(config)).resolves.toEqual({
      ok: true,
      readOnly: true,
    });
  });

  it('probes nothing the drain does not request itself', async () => {
    // Spec section 7 as a property rather than a URL spelling. Probing a
    // cheaper variant - `count=1`, say - is a weaker check than the sync it
    // is a check for: an instance could answer the probe's request and fail
    // the drain's. It also meant a recorded probe response could never
    // serve the drain, which is why the payment-address path could not be
    // wired up until these URLs converged.
    stub(routes());
    await cardanoBlockfrost.probe(config);
    const probed = [...seen];

    stub(routes());
    await cardanoBlockfrost.fetchEvents(config, null);
    const drained = new Set(seen);

    expect(probed.length).toBeGreaterThan(0);
    for (const url of probed) {
      expect([...drained]).toContain(url);
    }
  });

  it('refuses a stake address on an instance without the account routes', async () => {
    stub({});
    await expect(cardanoBlockfrost.probe(config)).resolves.toEqual({
      ok: false,
      message: CARDANO_MESSAGES.stakeAddressNeedsAccountApi,
    });
  });

  it('refuses to sync what it refused to probe', async () => {
    // probe is not on syncSource's path, so a guard that lives only there
    // protects nothing on a refresh.
    stub({});
    await expect(cardanoBlockfrost.fetchEvents(config, null)).rejects.toThrow();
  });

  it('discards a cursor whose tier the instance can no longer serve', async () => {
    // Spec section 8: a cursor whose tier does not match the tier now
    // selected is treated as null - start over. It was not implemented: the
    // persisted `decoded.tier`/`decoded.account` were trusted on every page
    // past the first, so a configured stake-address source pointed at an
    // instance that now 404s the account routes threw the raw `cardano:
    // listing account transactions failed with status 404` - the exact raw
    // status this module exists to retire - where the SAME source at cursor
    // null correctly refuses with a keyed message. And it never recovered:
    // syncSource does not advance a cursor past a page that threw, so the
    // dead page was re-issued forever.
    stub({});
    await expect(
      cardanoBlockfrost.fetchEvents(config, `acct:7:deadbeef:${STAKE}`),
    ).rejects.toThrow(CARDANO_MESSAGES.stakeAddressNeedsAccountApi);
  });

  it('starts the drain over rather than resume a cursor the instance refuses', async () => {
    // The recovery half. The instance serves the account routes again (a
    // self-hosted Yaci with the blockfrost profile turned back on, say), so
    // discarding the stale cursor has to produce a working page 1 - not
    // merely a different error.
    // `routes()` has page 1 and no page 7, and the stub 404s what it has no
    // entry for - so the stale cursor's page is exactly the 404 the
    // recovery is for.
    stub(routes());
    const { events } = await cardanoBlockfrost.fetchEvents(
      config,
      `acct:7:deadbeef:${STAKE}`,
    );
    expect(events.map((event) => event.externalId)).toEqual([
      'tx1',
      'tx2',
      `reward:${STAKE}:500`,
    ]);
  });

  it('keeps a cursor when the account route fails for any other reason', async () => {
    // Only a 404 means "this instance does not serve the account tier".
    // Discarding a good cursor over a transient 429 would re-drain a whole
    // history against a provider that just said to slow down.
    seen = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response('{}', { status: 429 });
      }),
    );
    await expect(
      cardanoBlockfrost.fetchEvents(config, `acct:7:deadbeef:${STAKE}`),
    ).rejects.toThrow(/status 429/);
    // And it did not fall through to re-resolve the tier, which would have
    // listed transactions at page 1.
    expect(seen.some((url) => url.includes('/transactions?page=1'))).toBe(
      false,
    );
  });

  it('does not re-emit a transaction that straddled the page boundary', async () => {
    stub({
      ...routes({
        [`${ROOT}/accounts/${STAKE}/transactions?page=2&count=20&order=asc`]: [
          { address: A2, tx_hash: 'tx1', block_time: 1_667_587_468 },
          { address: A1, tx_hash: 'tx9', block_time: 1_667_600_000 },
        ],
        [`${ROOT}/txs/tx9/utxos`]: utxos('tx9'),
      }),
    });
    const { events } = await cardanoBlockfrost.fetchEvents(
      config,
      `acct:2:tx1:${STAKE}`,
    );
    expect(events.map((event) => event.externalId)).toEqual(['tx9']);
  });
});
