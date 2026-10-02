import type { Leg } from '@/ledger/types';
import { fetchJson } from './http';
import { ADDRESS_PAGE_SIZE, MAX_ADDRESS_PAGES } from './cursor';
import { assetIdOf, type UtxoEntry } from './utxo';
import type { DerivedEvent, FetchPage } from '@/sources/types';
import type { CardanoProvider } from './provider';
import { PAGE_SIZE, encodeAccountCursor } from './cursor';
import { type TxUtxos } from './utxo';
import { fetchWithdrawalMap, withdrawalLegFor } from './pot';

/**
 * Tier 1: draining a whole Cardano account rather than one payment address.
 *
 * Two things make this different from the address path, and both come from
 * the provider rather than from choice.
 *
 * 1. `/accounts/{stake}/transactions` returns one row per (address,
 *    transaction) PAIR, so one transaction arrives as several adjacent
 *    rows - see `uniqueTransactions`.
 * 2. `/txs/{hash}/utxos` does not carry `stake_address` on Blockfrost at
 *    all, so there is no way to recognise the account's own utxo entries
 *    from the transaction alone. The account's enumerated address set is
 *    what does it - see `fetchAddressSet` and `legsForAccount`.
 */

/**
 * The `what` labels this module passes to `fetchJson`, as constants.
 *
 * `fetchCardanoEvents` has to recognise "the account routes answered 404 on
 * a resumed cursor" to discard that cursor and start over (spec section 8),
 * and recognising it by matching prose against the thrown message is the
 * fragility `probeMessage(status)` and `HostShapeError` both exist to avoid.
 * A shared constant compared against `RouteStatusError.what` is a contract;
 * a regex over a sentence is not.
 */
export const ACCOUNT_ROUTE_LABELS = {
  transactions: 'listing account transactions',
  addresses: 'listing account addresses',
} as const;

// `/withdrawals` is deliberately NOT in there, although the account tier
// requests it too. These two are the routes `accountTier` probes to DECIDE
// the tier, so a 404 from either really does mean "this instance no longer
// serves the tier" and restarting at null can pick a different one. A 404 on
// withdrawals means something else - an instance that can list the account
// but not its reward history, which no other tier fixes - so restarting
// would only re-issue the same request from page 1. It surfaces as an error
// instead, which is the refuse-rather-than-degrade rule `resolveTarget`
// already follows: both providers serve the route (Blockfrost measured at
// 0.18s, and Yaci's own OpenAPI document lists it), so an absence is a real
// problem rather than a shape to tolerate - and tolerating it would silently
// restore the double count.

/** The two fields this module reads from a listing row. Rows also carry
 *  `address`, `tx_index` and `block_height`, which nothing here needs. */
export type AccountRow = {
  tx_hash: string;
  /** Seconds, not milliseconds - converted by the caller. */
  block_time: number;
};

/**
 * Every payment address of the account.
 *
 * Fetched once per listing page rather than once per drain. Per page costs
 * one cheap request - 0.06s measured on Blockfrost, 0.5s on a
 * compat-enabled Yaci - and needs no cursor state, where carrying a set of
 * up to a thousand bech32 addresses in the cursor would be kilobytes of
 * duplicated state. Always-current also means a wallet that derives a new
 * address mid-drain is not half-tracked.
 */
export const fetchAddressSet = async (
  root: string,
  headers: Record<string, string>,
  account: string,
  signal?: AbortSignal,
): Promise<Set<string>> => {
  const addresses = new Set<string>();
  for (let page = 1; page <= MAX_ADDRESS_PAGES; page += 1) {
    const batch = await fetchJson<{ address: string }[]>(
      `${root}/accounts/${account}/addresses?page=${page}&count=${ADDRESS_PAGE_SIZE}`,
      ACCOUNT_ROUTE_LABELS.addresses,
      headers,
      signal,
    );
    for (const entry of batch) {
      addresses.add(entry.address);
    }
    if (batch.length < ADDRESS_PAGE_SIZE) {
      return addresses;
    }
  }
  // Names the bound, never the account - see the error-message rule on
  // SourceModule. A thousand addresses is far beyond any real wallet, so
  // reaching this means a provider paging without end, and looping on that
  // would burn the request budget silently.
  throw new Error(
    `cardano: account has more than ${MAX_ADDRESS_PAGES * ADDRESS_PAGE_SIZE} addresses, which is beyond what this module will enumerate`,
  );
};

/**
 * The distinct transactions in one listing page.
 *
 * Rows of one transaction share `block_time` and `tx_index`, and `tx_index`
 * is unique within a block, so they are necessarily ADJACENT in an ordered
 * listing. That is what makes a stateless rule sufficient: keep a row only
 * when its hash differs from the row before it.
 *
 * `carriedTxHash` is the previous page's final hash, read out of the cursor.
 * A transaction whose rows straddle a page boundary is emitted from the
 * first page and must not be emitted again from the second - and because a
 * drain resumes from a PERSISTED cursor after a stop or a failed page, an
 * in-memory set of seen ids would be gone exactly when it was needed.
 */
export const uniqueTransactions = (
  rows: AccountRow[],
  carriedTxHash: string,
): AccountRow[] => {
  const unique: AccountRow[] = [];
  let previous = carriedTxHash;
  for (const row of rows) {
    if (row.tx_hash === previous) {
      continue;
    }
    previous = row.tx_hash;
    unique.push(row);
  }
  return unique;
};

/**
 * The hash to carry into the next page.
 *
 * An empty page keeps the carried value rather than clearing it: clearing
 * would let a straddling transaction through a second time.
 */
export const lastTxHashOf = (
  rows: AccountRow[],
  carriedTxHash: string,
): string =>
  rows.length === 0 ? carriedTxHash : rows[rows.length - 1].tx_hash;

/**
 * Legs for one side of a transaction, filtered to the account's own
 * addresses.
 *
 * This is the module's half of the contract documented on `SourceModule`:
 * emit legs only for the account this source was configured to watch, never
 * the counterparty. An input entry belonging to the account is value
 * leaving it; a matching output entry is value arriving.
 *
 * The venue is the ACCOUNT for every leg, so every payment address of the
 * wallet reports under one venue and movement between them nets to zero.
 *
 * Deliberately does not read `entry.stake_address`: Blockfrost omits that
 * field entirely, which is why the shared address-path filter has silently
 * matched nothing there since the module shipped.
 */
export const legsForAccount = (
  entries: UtxoEntry[],
  direction: Leg['direction'],
  addresses: Set<string>,
  account: string,
): Leg[] =>
  entries
    // Neither a collateral nor a reference entry is a movement. Collateral
    // is pledged and returned by a successful script; a reference input is
    // READ by a script and never consumed. Counting either as a spend
    // subtracts money that never left, which is how a real wallet came to
    // report -727 ADA against a true +25 ADA.
    .filter(
      (entry) =>
        !entry.collateral && !entry.reference && addresses.has(entry.address),
    )
    .flatMap((entry) =>
      entry.amount.map((amount) => ({
        assetId: assetIdOf(amount.unit),
        amount: amount.quantity,
        direction,
        venue: account,
        role: 'principal' as const,
      })),
    );

/**
 * One page of an account's history.
 *
 * Reward ACCRUALS are fetched on page 1 only: they are account-level rather
 * than paginated alongside transactions, and a drain always starts at cursor
 * null, so this runs exactly once per drain and produces the same events -
 * which is what keeps the conformance harness's double-drain comparison
 * happy.
 *
 * Reward WITHDRAWALS are different, and are fetched on every page: a
 * withdrawal belongs on the event of the transaction that performed it (see
 * withdrawalLegFor), and that transaction can appear on any page of the
 * listing - so a map built on page 1 alone could never reach it.
 */
export const fetchAccountPage = async ({
  provider,
  config,
  root,
  account,
  page,
  carriedTxHash,
  signal,
  rewardsFor,
}: {
  provider: CardanoProvider;
  config: Record<string, string>;
  root: string;
  account: string;
  page: number;
  carriedTxHash: string;
  signal?: AbortSignal;
  /** The account's staking-reward accruals. Injected so this module does
   *  not import the translator, which imports it. Called on page 1 only.
   *  Reward WITHDRAWALS are not here: they are merged into the event of the
   *  transaction that performed them, below. */
  rewardsFor: (account: string) => Promise<DerivedEvent[]>;
}): Promise<FetchPage> => {
  const headers = provider.headers(config);

  const rows = await fetchJson<AccountRow[]>(
    // Ascending order is what makes this cursor stable: page 1 is always
    // the oldest, so new activity appends to the end and never shifts a
    // page already consumed. Both providers' account route is strictly
    // 1-based - Blockfrost answers page=0 with 400 - so there is no
    // aliasing to rely on here, unlike the address route.
    `${root}/accounts/${account}/transactions?page=${page}&count=${PAGE_SIZE}&order=asc`,
    ACCOUNT_ROUTE_LABELS.transactions,
    headers,
    signal,
  );

  const addresses = await fetchAddressSet(root, headers, account, signal);
  // Per page, for the same reason the address set is - see this function's
  // doc comment.
  const withdrawals = await fetchWithdrawalMap(root, headers, account, signal);

  const events: DerivedEvent[] = [];
  for (const row of uniqueTransactions(rows, carriedTxHash)) {
    const utxos = await fetchJson<TxUtxos>(
      `${root}/txs/${row.tx_hash}/utxos`,
      'fetching transaction utxos',
      headers,
      signal,
    );
    const legs = [
      ...legsForAccount(utxos.inputs, 'out', addresses, account),
      ...legsForAccount(utxos.outputs, 'in', addresses, account),
      // The withdrawn reward leaving the pot, on THIS transaction's event.
      // The arriving side is already above: it is why a withdrawing
      // transaction's outputs exceed its inputs. Merging rather than
      // emitting separately is what keeps the pair an internal transfer
      // instead of a phantom disposal - see withdrawalLegFor.
      ...withdrawalLegFor(withdrawals, row.tx_hash, account),
    ];
    // A transaction the account only appears in without moving value for it
    // - a collateral or reference input - produces no legs. Skip it rather
    // than hand the conformance gate an empty event, which it rejects.
    if (legs.length === 0) {
      continue;
    }
    events.push({
      externalId: row.tx_hash,
      // The API returns seconds; the ledger stores epoch milliseconds.
      // Unconverted, every event dates to 1970 and lands in the wrong tax
      // year.
      timestamp: row.block_time * 1000,
      kind: 'transfer',
      origin: 'derived',
      legs,
    });
  }

  if (page === 1) {
    events.push(...(await rewardsFor(account)));
  }

  return {
    events,
    cursor:
      rows.length < PAGE_SIZE
        ? null
        : encodeAccountCursor(
            page + 1,
            lastTxHashOf(rows, carriedTxHash),
            account,
          ),
  };
};
