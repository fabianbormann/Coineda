import type { Leg } from '@/ledger/types';
import { drainPagedRoute } from './http';
import { ACCOUNT_HISTORY_PAGE_SIZE } from './cursor';
import { amountString } from './utxo';

/**
 * The account's REWARD POT: where a staking reward accrues, and where a
 * withdrawal takes it from.
 *
 * Its own module because both leg builders need it and neither may import
 * the translator, which imports them.
 *
 * On Cardano a reward does not accrue into the account's UTxOs. It accrues
 * into the pot, and a withdrawal materialises in a transaction's OUTPUTS
 * with no matching input. With rewards booked at the account venue and no
 * withdrawal leg at all, the same ADA was counted once on accrual and again
 * on withdrawal: measured against the recorded Blockfrost account, three
 * transactions whose outputs exceed their inputs by
 * 23,740.96 + 3,834.49 + 2,241.20 = 29,816.65 ADA are exactly its three
 * recorded withdrawals, 29,817.21 ADA less fees. That inflated the balance
 * AND the FIFO lot pool, so a later disposal matched cost basis that never
 * existed.
 *
 * `#` cannot occur in a bech32 address, so the pot venue can never collide
 * with a real address the user holds.
 */
export const REWARDS_VENUE_SUFFIX = '#rewards';

export const rewardsVenueOf = (stakeAddress: string): string =>
  `${stakeAddress}${REWARDS_VENUE_SUFFIX}`;

/**
 * One row of `/accounts/{stake}/withdrawals`.
 *
 * MEASURED against the live Blockfrost route (`?page=1&count=100`, mainnet,
 * the account the fixtures were recorded from):
 *
 *     {"amount": "23741148775", "block_height": 10908729,
 *      "block_time": 1727839030, "tx_hash": "d9c807fe5b67…",
 *      "tx_slot": 136272739}
 *
 * So `block_time` IS present, correcting an earlier comment here that
 * claimed the documented row was `{tx_hash, amount}` only. It is
 * nevertheless not read: a withdrawal is now merged into its own
 * transaction's event (see `withdrawalLegFor`), and that event is dated from
 * the listing row the transaction already came with - so reading a second
 * date for the same moment could only ever introduce a disagreement.
 *
 * `amount` is a string on Blockfrost and may be a JSON number on Yaci, the
 * same disagreement the rewards route has, handled the same way.
 */
type AccountWithdrawal = {
  tx_hash: string;
  amount: number | string;
};

/** Withdrawn amount by transaction hash. One account withdraws at most once
 *  per transaction, so a hash maps to a single amount. */
export type WithdrawalMap = Map<string, string>;

/**
 * Every reward withdrawal of an account, by transaction hash.
 *
 * Fetched once per LISTING PAGE rather than once per drain, for exactly the
 * reason `fetchAddressSet` is: a withdrawal's transaction can appear on any
 * page of the listing, so a map built on page 1 alone could not be merged
 * into the transactions later pages return. It is one cheap paginated route
 * - 0.18s and 3 rows measured on Blockfrost for the fixture account - and it
 * needs no cursor state.
 *
 * Paged with the same loop and the same bound-and-throw guard as every other
 * account route: requested bare, it would truncate at the provider's default
 * page size and silently drop the rest.
 */
export const fetchWithdrawalMap = async (
  root: string,
  headers: Record<string, string>,
  account: string,
  signal?: AbortSignal,
): Promise<WithdrawalMap> => {
  const rows = await drainPagedRoute<AccountWithdrawal>(
    (page) =>
      `${root}/accounts/${account}/withdrawals?page=${page}&count=${ACCOUNT_HISTORY_PAGE_SIZE}`,
    'listing reward withdrawals',
    headers,
    signal,
  );
  const withdrawals: WithdrawalMap = new Map();
  for (const row of rows) {
    withdrawals.set(
      row.tx_hash,
      // Refuses a number JSON.parse has already rounded rather than record
      // it. Names no address - see the error-message rule on SourceModule.
      amountString(row.amount, 'a reward withdrawal'),
    );
  }
  return withdrawals;
};

/**
 * The pot leg to add to one transaction's event, if that transaction
 * withdrew rewards.
 *
 * Merged into the TRANSACTION'S OWN event rather than emitted as an event of
 * its own, and that is the whole point. A withdrawal is not a separate
 * occurrence - it IS that transaction - and `isInternalTransfer` needs owned
 * legs in both directions WITHIN one event. Emitted separately, a lone `out`
 * leg nets negative and classifies as a disposal, so a German report matched
 * it against the reward's own acquisition lot in FIFO and booked a realised
 * gain on a movement between two of the user's own pots. Measured:
 * separately, `internal=false` and one disposal; merged, `internal=true` and
 * none - with the holdings total identical either way, so nothing but the
 * phantom taxable event changes.
 */
export const withdrawalLegFor = (
  withdrawals: WithdrawalMap,
  txHash: string,
  account: string,
): Leg[] => {
  const amount = withdrawals.get(txHash);
  if (amount === undefined) {
    return [];
  }
  return [
    {
      assetId: 'cardano:lovelace',
      amount,
      direction: 'out',
      venue: rewardsVenueOf(account),
      role: 'principal',
    },
  ];
};
