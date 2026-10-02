import { describe, it, expect, vi, afterEach } from 'vitest';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { runConformance } from '@/sources/conformance';
import { rewardsVenueOf } from '@/sources/cardano/translator';
import { fetchWithdrawalMap } from '@/sources/cardano/pot';
import {
  ACCOUNT_HISTORY_PAGE_SIZE,
  MAX_ACCOUNT_HISTORY_PAGES,
} from '@/sources/cardano/cursor';
import {
  foldDisposals,
  foldHoldings,
  isInternalTransfer,
  netPrincipalLegs,
  ownedVenuesOf,
} from '@/ledger/balances';
import { addAmounts, isZeroAmount, subtractAmounts } from '@/ledger/amount';
import type { LedgerEvent } from '@/ledger/types';

/**
 * The reward pot: where a staking reward accrues, and where a withdrawal
 * takes it from.
 *
 * On Cardano a reward does not accrue into the account's UTxOs. It accrues
 * into the account's REWARD POT, and a withdrawal materialises in a
 * transaction's OUTPUTS with no matching input - which is why the three
 * withdrawing transactions in src/sources/cardano-blockfrost/fixtures have
 * outputs exceeding their inputs (by 23,740.96 + 3,834.49 + 2,241.20 ADA,
 * the account's three real withdrawals less their fees). With accruals
 * booked at the account venue and no withdrawal leg at all, the same ADA was
 * counted once on accrual and again on withdrawal: the balance was inflated,
 * and so was the FIFO lot pool, so a later disposal matched cost basis that
 * never existed.
 *
 * A withdrawal is MERGED INTO THE EVENT OF ITS OWN TRANSACTION rather than
 * emitted as an event of its own. That is both the truthful model - the
 * withdrawal IS that transaction - and what keeps it out of a tax report:
 * `isInternalTransfer` needs owned legs in both directions WITHIN one event,
 * so a lone `out` leg nets negative, classifies as a disposal, and matches
 * the reward's own acquisition lot in FIFO. Measured: separately,
 * `internal=false` and one disposal; merged, `internal=true` and none, with
 * the same holdings total either way.
 *
 * The row shape is no longer a guess. Measured against the live Blockfrost
 * route with the owner's key:
 *
 *     {"amount": "23741148775", "block_height": 10908729,
 *      "block_time": 1727839030, "tx_hash": "d9c807fe5b67…",
 *      "tx_slot": 136272739}
 *
 * `block_time` is present, correcting an earlier assumption here - and is
 * nevertheless not read, because the merged event takes its date from the
 * transaction's own listing row. The rows below are still synthetic, so what
 * is exercised is OUR merging and OUR arithmetic, not a claim about the
 * provider.
 */
const HOST = 'https://cardano-mainnet.blockfrost.io';
const ROOT = `${HOST}/api/v0`;
const STAKE = 'stake1_pot_fixture';
const MINE = 'addr1_pot_mine';

const config = { baseUrl: HOST, projectId: 'k', address: STAKE };

const PAGED = `page=1&count=${ACCOUNT_HISTORY_PAGE_SIZE}`;

/**
 * One withdrawal, told three ways, and they have to agree.
 *
 * - the rewards route says 10 ADA accrued in epoch 500
 * - the withdrawals route says 10 ADA was withdrawn in 'wtx'
 * - 'wtx' itself has 2 ADA in and 11.8 ADA out: the 10 ADA arriving, less
 *   a 0.2 ADA fee
 *
 * The honest total is 9.8 ADA. Counting the accrual and the arrival without
 * the withdrawal in between gives 19.8.
 */
const ACCRUED = '10000000';
const SPENT = '2000000';
const RETURNED = '11800000';
const TRUE_TOTAL = '9800000';

const routes = (overrides: Record<string, unknown> = {}) => ({
  [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: [
    { address: MINE, tx_hash: 'wtx', block_time: 1_700_000_400 },
  ],
  [`${ROOT}/accounts/${STAKE}/addresses?page=1&count=100`]: [{ address: MINE }],
  [`${ROOT}/accounts/${STAKE}/rewards?${PAGED}`]: [
    { epoch: 500, amount: ACCRUED, type: 'member' },
  ],
  [`${ROOT}/accounts/${STAKE}/withdrawals?${PAGED}`]: [
    { tx_hash: 'wtx', amount: ACCRUED },
  ],
  [`${ROOT}/epochs/500`]: { end_time: 1_699_000_000 },
  [`${ROOT}/txs/wtx/utxos`]: {
    inputs: [
      { address: MINE, amount: [{ unit: 'lovelace', quantity: SPENT }] },
    ],
    outputs: [
      { address: MINE, amount: [{ unit: 'lovelace', quantity: RETURNED }] },
    ],
  },
  ...overrides,
});

/**
 * The same withdrawal with NO transaction fee: 2 in, 10 withdrawn, 12 out.
 *
 * Needed to state the internal-transfer property cleanly. With a fee, a
 * Cardano transaction's owned principal legs never net to exactly zero, and
 * src/ledger/balances.ts deliberately reports that residue as a disposal OF
 * THE FEE - documented there, and pinned by tests/balances.test.ts. That is
 * a different claim from the one this fix is about, so both are asserted
 * separately below: fee-free, internal with no disposal at all; with a fee,
 * a disposal whose size is the fee and NOT the reward.
 */
const feeFreeRoutes = (overrides: Record<string, unknown> = {}) =>
  routes({
    [`${ROOT}/txs/wtx/utxos`]: {
      inputs: [
        { address: MINE, amount: [{ unit: 'lovelace', quantity: SPENT }] },
      ],
      outputs: [
        { address: MINE, amount: [{ unit: 'lovelace', quantity: '12000000' }] },
      ],
    },
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

const drainAll = async () => {
  const events = [];
  let cursor: string | null = null;
  do {
    const page = await cardanoBlockfrost.fetchEvents(config, cursor);
    events.push(...page.events);
    cursor = page.cursor;
  } while (cursor !== null);
  return events;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a staking reward accrues to the reward pot', () => {
  it('books the accrual at the pot, not at the account’s utxo venue', async () => {
    stub(routes());
    const events = await drainAll();
    const reward = events.find((event) => event.kind === 'reward');
    expect(reward).toBeDefined();
    expect(reward!.legs).toHaveLength(1);
    expect(reward!.legs[0].venue).toBe(rewardsVenueOf(STAKE));
    // And specifically NOT the account venue, which is where the
    // transaction legs sit. Sharing one venue is what made the withdrawal
    // double count.
    expect(reward!.legs[0].venue).not.toBe(STAKE);
  });

  it('keeps the accrual date and the provider record', async () => {
    stub(routes());
    const events = await drainAll();
    const reward = events.find((event) => event.kind === 'reward')!;
    expect(reward.timestamp).toBe(1_699_000_000 * 1000);
    expect(reward.raw).toEqual({
      epoch: 500,
      amount: ACCRUED,
      type: 'member',
    });
  });
});

describe('a reward withdrawal', () => {
  it('rides on the event of the transaction that performed it', async () => {
    // Not an event of its own. The withdrawal IS that transaction, and the
    // arriving side is already there - it is why the transaction's outputs
    // exceed its inputs.
    stub(routes());
    const events = await drainAll();
    expect(
      events.filter((event) => event.externalId.startsWith('withdrawal:')),
    ).toEqual([]);

    const tx = events.find((event) => event.externalId === 'wtx');
    expect(tx).toBeDefined();
    expect(tx!.legs).toEqual([
      {
        assetId: 'cardano:lovelace',
        amount: SPENT,
        direction: 'out',
        venue: STAKE,
        role: 'principal',
      },
      {
        assetId: 'cardano:lovelace',
        amount: RETURNED,
        direction: 'in',
        venue: STAKE,
        role: 'principal',
      },
      {
        assetId: 'cardano:lovelace',
        amount: ACCRUED,
        direction: 'out',
        venue: rewardsVenueOf(STAKE),
        role: 'principal',
      },
    ]);
  });

  it('is an INTERNAL transfer, and disposes of nothing', async () => {
    // The assertion that would have caught the separate-event version. A
    // lone `out` leg at the pot nets negative, so isInternalTransfer said
    // false and foldDisposals returned one disposal - which a German report
    // then matched against the reward's own acquisition lot in FIFO and
    // booked a realised gain on. A phantom taxable event on every
    // withdrawal. Measured: separate, internal=false and 1 disposal;
    // merged, internal=true and 0.
    stub(feeFreeRoutes());
    const stamped = (await drainAll()).map((event, index) => ({
      ...event,
      id: `id-${index}`,
      sourceId: 'source-1',
    })) as LedgerEvent[];
    const owned = ownedVenuesOf(stamped);

    const tx = stamped.find((event) => event.externalId === 'wtx')!;
    expect(isInternalTransfer(tx, owned)).toBe(true);

    // Folded over the WHOLE log - the accrual included - because that is
    // the input a tax run actually gets, and the accrual is the lot a
    // phantom disposal would have matched against.
    expect(stamped.some((event) => event.kind === 'reward')).toBe(true);
    expect(foldDisposals(stamped, owned)).toHaveLength(0);
  });

  it('disposes of the FEE, never of the withdrawn reward', async () => {
    // With a fee the owned legs cannot net to zero, and balances.ts
    // deliberately reports that residue as a disposal - of the fee. What
    // must never happen is a disposal the size of the REWARD, which is
    // exactly what the separate lone-`out` event produced. So the magnitude
    // is asserted, not merely the count.
    stub(routes());
    const stamped = (await drainAll()).map((event, index) => ({
      ...event,
      id: `id-${index}`,
      sourceId: 'source-1',
    })) as LedgerEvent[];
    const owned = ownedVenuesOf(stamped);

    const disposals = foldDisposals(stamped, owned);
    expect(disposals.map((event) => event.externalId)).toEqual(['wtx']);

    const netted = netPrincipalLegs(disposals[0], owned);
    expect(netted.legs).toEqual([
      {
        assetId: 'cardano:lovelace',
        // 10 accrued + 2 spent - 11.8 returned = 0.2, the fee.
        amount: '200000',
        direction: 'out',
        venue: STAKE,
        role: 'principal',
      },
    ]);
    // And emphatically not the reward.
    expect(netted.legs[0].amount).not.toBe(ACCRUED);
  });

  it('dates itself from the transaction, which is the only date it has', async () => {
    // The withdrawals row does carry block_time (measured - see the header),
    // but it is not read: the merged event is the transaction's own, dated
    // from the listing row it already came with, so there is no second date
    // to disagree with.
    stub(routes());
    const events = await drainAll();
    const tx = events.find((event) => event.externalId === 'wtx')!;
    expect(tx.timestamp).toBe(1_700_000_400 * 1000);
  });

  it('asks for no extra request per withdrawal', async () => {
    // An earlier version looked up /txs/{hash} for a date the row was
    // assumed not to carry. It does carry one, and the merged event needs
    // neither - so the request is gone.
    stub(routes());
    await drainAll();
    expect(seen).not.toContain(`${ROOT}/txs/wtx`);
    expect(seen).toContain(`${ROOT}/txs/wtx/utxos`);
  });

  it('replays to the same events, so a re-sync upserts rather than doubles', async () => {
    stub(routes());
    const first = await drainAll();
    stub(routes());
    const second = await drainAll();
    expect(first).toEqual(second);
    expect(first.map((event) => event.externalId)).toContain('wtx');
  });

  it('refuses an amount JSON parsing has already rounded', async () => {
    // The same guard the rewards route has, for the same reason: on a
    // provider that sends this as a JSON number, anything above
    // Number.MAX_SAFE_INTEGER is already gone by the time this code runs,
    // and a silently wrong number would reach a tax report.
    stub(
      routes({
        [`${ROOT}/accounts/${STAKE}/withdrawals?${PAGED}`]: [
          { tx_hash: 'wtx', amount: 2 ** 53 },
        ],
      }),
    );
    await expect(drainAll()).rejects.toThrow(/safe integer precision/);
  });

  it('names no address in the amount it refuses', async () => {
    stub(
      routes({
        [`${ROOT}/accounts/${STAKE}/withdrawals?${PAGED}`]: [
          { tx_hash: 'wtx', amount: 2 ** 53 },
        ],
      }),
    );
    await expect(drainAll()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(STAKE),
      }),
    );
  });

  it('counts the withdrawn reward exactly ONCE in the balance', async () => {
    // The finding, as the number a user would see. 10 ADA accrued, 10 ADA
    // withdrawn, and the withdrawing transaction returns 11.8 against 2
    // spent. The honest holding is 9.8 ADA - the reward less the fee.
    // Booking the accrual at the account venue with no withdrawal leg gives
    // 19.8, which is the inflated balance and the phantom cost basis.
    stub(routes());
    const events = await drainAll();
    const stamped = events.map((event, index) => ({
      ...event,
      id: `id-${index}`,
      sourceId: 'source-1',
    })) as LedgerEvent[];
    const holdings = foldHoldings(stamped, ownedVenuesOf(stamped));
    expect(holdings).toEqual([
      { assetId: 'cardano:lovelace', amount: TRUE_TOTAL },
    ]);
  });

  it('leaves the reward pot empty once everything accrued is withdrawn', async () => {
    stub(routes());
    const events = await drainAll();
    const potLegs = events
      .flatMap((event) => event.legs)
      .filter((leg) => leg.venue === rewardsVenueOf(STAKE));
    // NEW-3: counted first. A net of zero is also what no legs at all
    // produces, so without this the test passed if the pot were never
    // touched - the same vacuity this wave standardised a guard against,
    // and the twelfth weak test found on this branch.
    expect(potLegs.length).toBeGreaterThan(0);
    // Netted with the project's decimal-string helpers, never floats.
    const net = potLegs.reduce(
      (total, leg) =>
        leg.direction === 'in'
          ? addAmounts(total, leg.amount)
          : subtractAmounts(total, leg.amount),
      '0',
    );
    expect(isZeroAmount(net)).toBe(true);
  });

  it('still passes the conformance gate, withdrawals included', async () => {
    stub(routes());
    await expect(
      runConformance(cardanoBlockfrost, { config }),
    ).resolves.toBeUndefined();
  });

  it('emits legs only for the account it was configured to watch', async () => {
    stub(routes());
    const events = await drainAll();
    const venues = new Set(
      events.flatMap((event) => event.legs.map((leg) => leg.venue)),
    );
    expect([...venues].sort()).toEqual([STAKE, rewardsVenueOf(STAKE)].sort());
  });
});

describe('the account-level routes are paged', () => {
  const fullRewardPage = (from: number) =>
    Array.from({ length: ACCOUNT_HISTORY_PAGE_SIZE }, (_, i) => ({
      epoch: from + i,
      amount: '1',
      type: 'member',
    }));

  /** Every /epochs/{n} answered from one rule, so a 200-reward account does
   *  not need 200 hand-written entries. */
  const stubWithEpochs = (table: Record<string, unknown>) => {
    seen = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const key = String(url);
        seen.push(key);
        if (key in table) {
          return new Response(JSON.stringify(table[key]), { status: 200 });
        }
        if (/\/epochs\/\d+$/.test(key)) {
          return new Response(JSON.stringify({ end_time: 1_699_000_000 }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  };

  it('drains every reward page past the first full one', async () => {
    // The truncation this fixes, measured: an account with at least 200
    // reward epochs answers the bare /accounts/{stake}/rewards with 100 rows
    // and ?page=2&count=100 with another 100. Unpaged, a wallet staking
    // beyond ~100 epochs silently lost the rest - and the lost ones are the
    // most recent, which is the span a tax report covers.
    stubWithEpochs(
      routes({
        [`${ROOT}/accounts/${STAKE}/rewards?${PAGED}`]: fullRewardPage(300),
        [`${ROOT}/accounts/${STAKE}/rewards?page=2&count=${ACCOUNT_HISTORY_PAGE_SIZE}`]:
          fullRewardPage(400),
        [`${ROOT}/accounts/${STAKE}/rewards?page=3&count=${ACCOUNT_HISTORY_PAGE_SIZE}`]:
          [{ epoch: 500, amount: '1', type: 'member' }],
      }),
    );
    const events = await drainAll();
    const rewards = events.filter((event) => event.kind === 'reward');
    expect(rewards).toHaveLength(ACCOUNT_HISTORY_PAGE_SIZE * 2 + 1);
    expect(rewards.map((event) => event.externalId)).toContain(
      `reward:${STAKE}:500`,
    );
    expect(
      seen.filter((url) => url.includes('/rewards?page=')).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('stops asking for reward pages once one comes back short', async () => {
    stub(routes());
    await drainAll();
    expect(seen.filter((url) => url.includes('/rewards?page='))).toEqual([
      `${ROOT}/accounts/${STAKE}/rewards?${PAGED}`,
    ]);
  });

  it('drains every withdrawal page past the first full one', async () => {
    // A withdrawal beyond page 1 of the withdrawals route still has to
    // reach the transaction it belongs to - here `wtx`, which is on the
    // listing's only page.
    const fullWithdrawalPage = Array.from(
      { length: ACCOUNT_HISTORY_PAGE_SIZE },
      (_, i) => ({ tx_hash: `other${i}`, amount: '1' }),
    );
    stubWithEpochs(
      routes({
        [`${ROOT}/accounts/${STAKE}/withdrawals?${PAGED}`]: fullWithdrawalPage,
        [`${ROOT}/accounts/${STAKE}/withdrawals?page=2&count=${ACCOUNT_HISTORY_PAGE_SIZE}`]:
          [{ tx_hash: 'wtx', amount: ACCRUED }],
      }),
    );
    const events = await drainAll();
    const tx = events.find((event) => event.externalId === 'wtx')!;
    expect(
      tx.legs.filter((leg) => leg.venue === rewardsVenueOf(STAKE)),
    ).toEqual([
      {
        assetId: 'cardano:lovelace',
        amount: ACCRUED,
        direction: 'out',
        venue: rewardsVenueOf(STAKE),
        role: 'principal',
      },
    ]);
    expect(
      seen.filter((url) => url.includes('/withdrawals?page=')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('fetches the withdrawals map on EVERY page, not only the first', async () => {
    // A withdrawal's transaction can appear on any page of the listing, so
    // a map built on page 1 alone could never be merged into the
    // transactions a later page returns - the reason fetchAddressSet is
    // fetched per page too.
    const full = Array.from({ length: 20 }, (_, i) => ({
      address: MINE,
      tx_hash: `t${i}`,
      block_time: 1_700_000_400,
    }));
    stubWithEpochs(
      routes({
        [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
          full,
        [`${ROOT}/accounts/${STAKE}/transactions?page=2&count=20&order=asc`]: [
          { address: MINE, tx_hash: 'wtx', block_time: 1_700_000_500 },
        ],
        ...Object.fromEntries(
          full.map((row) => [
            `${ROOT}/txs/${row.tx_hash}/utxos`,
            {
              inputs: [
                {
                  address: MINE,
                  amount: [{ unit: 'lovelace', quantity: '1' }],
                },
              ],
              outputs: [],
            },
          ]),
        ),
      }),
    );
    const events = await drainAll();
    // The withdrawal landed on the page-2 transaction, which a page-1-only
    // map could not have reached.
    const tx = events.find((event) => event.externalId === 'wtx')!;
    expect(tx.legs.some((leg) => leg.venue === rewardsVenueOf(STAKE))).toBe(
      true,
    );
    expect(seen.filter((url) => url.includes('/withdrawals?')).length).toBe(2);
  });

  it('fails loudly rather than page without end', async () => {
    // The same bound-and-throw guard fetchAddressSet has. A provider that
    // keeps answering with a full page would otherwise loop until the
    // request budget was gone, silently.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              Array.from({ length: ACCOUNT_HISTORY_PAGE_SIZE }, (_, i) => ({
                tx_hash: `w${i}`,
                amount: '1',
              })),
            ),
            { status: 200 },
          ),
      ),
    );
    await expect(fetchWithdrawalMap(ROOT, {}, STAKE)).rejects.toThrow(
      new RegExp(
        `more than ${MAX_ACCOUNT_HISTORY_PAGES * ACCOUNT_HISTORY_PAGE_SIZE} rows`,
      ),
    );
  });

  it('names no account in the bound it refuses at', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              Array.from({ length: ACCOUNT_HISTORY_PAGE_SIZE }, (_, i) => ({
                tx_hash: `w${i}`,
                amount: '1',
              })),
            ),
            { status: 200 },
          ),
      ),
    );
    await expect(fetchWithdrawalMap(ROOT, {}, STAKE)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(STAKE),
      }),
    );
  });
});
