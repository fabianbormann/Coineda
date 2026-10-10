import type { Leg } from '@/ledger/types';
import type { DerivedEvent, FetchPage, SourceNote } from '@/sources/types';
import { ADDRESS_NO_TRANSACTIONS_YET } from '@/sources/addresses';
import type { CardanoProvider } from './provider';
import {
  fetchJson,
  mapConcurrent,
  RouteStatusError,
  UTXO_CONCURRENCY,
} from './http';
import { assetIdOf, type TxUtxos, type UtxoEntry } from './utxo';
import { CARDANO_MESSAGES } from './messages';
import { isStakeAddress, resolveTarget } from './tier';
import { stakeAddressOf } from './shelley';
import {
  PAGE_SIZE,
  decodeCursor,
  encodeAccountCursor,
  encodeAddressCursor,
} from './cursor';
import {
  ACCOUNT_ROUTE_LABELS,
  fetchAddressSet,
  lastTxHashOf,
  uniqueTransactions,
  type AccountRow,
} from './account';
import {
  fetchWithdrawalMap,
  withdrawalLegFor,
  type WithdrawalMap,
} from './pot';

/**
 * Draining a LIST of Cardano addresses.
 *
 * A source with one address never reaches this file: it keeps the exact
 * single-address path in translator.ts, cursors included, so a source that
 * was mid-sync when lists arrived resumes where it stopped.
 *
 * With several, each address is resolved to a tier once, at the start of a
 * drain, the same way a single address is (`resolveTarget`):
 *
 * - the FIRST address's account is resolved first; a later address whose
 *   staking credential names an account already resolved is covered by that
 *   account's drain and costs no request at all;
 * - any other address is probed on its own, and a different account is
 *   drained as an account of its own;
 * - an address the account routes cannot serve drains on the address tier.
 *
 * Then one unit - an account or an address - is drained at a time, in list
 * order, each with its own position in the cursor.
 *
 * **One event per transaction, whichever unit lists it.** A transfer
 * between two of the listed accounts appears in both accounts' listings,
 * and events upsert on (sourceId, externalId) - so if each drain built only
 * its own legs, the second would overwrite the first's and lose half the
 * transfer. Instead every page builds legs for EVERY listed account and
 * address (`legsOwned`), so both listings produce the identical event and
 * the second write changes nothing. Venues stay per account (or per address
 * for one without a staking part), as on the single-address path.
 */

const LIST_PREFIX = 'list:';

export type ListState = {
  /** Account-tier accounts, in the order their first address is listed. */
  accounts: string[];
  /** Address-tier addresses, in list order. */
  addresses: string[];
  /**
   * Each listed address's own position, as a single-address cursor
   * (`acct:…` or `addr:…`); null once drained, or for an address covered
   * by an earlier one's account, or with no transactions yet.
   */
  positions: Record<string, string | null>;
};

export const encodeListCursor = (state: ListState): string =>
  `${LIST_PREFIX}${btoa(JSON.stringify(state))}`;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string');

/**
 * Reads a list cursor back, or null to start over - for anything
 * unrecognised, and for a cursor whose addresses are not exactly the ones
 * configured now: resuming one wallet's position against another's list
 * would skip history.
 */
export const decodeListCursor = (
  cursor: string | null,
  configured: string[],
): ListState | null => {
  if (cursor === null || !cursor.startsWith(LIST_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(atob(cursor.slice(LIST_PREFIX.length))) as {
      accounts?: unknown;
      addresses?: unknown;
      positions?: unknown;
    };
    if (
      !isStringArray(parsed.accounts) ||
      !isStringArray(parsed.addresses) ||
      typeof parsed.positions !== 'object' ||
      parsed.positions === null
    ) {
      return null;
    }
    const positions = parsed.positions as Record<string, unknown>;
    const keys = Object.keys(positions);
    if (
      keys.length !== configured.length ||
      !configured.every((address) => address in positions) ||
      !keys.every(
        (key) => positions[key] === null || typeof positions[key] === 'string',
      )
    ) {
      return null;
    }
    return {
      accounts: parsed.accounts,
      addresses: parsed.addresses,
      positions: positions as Record<string, string | null>,
    };
  } catch {
    return null;
  }
};

/**
 * Every listed address resolved to its unit. Runs once per drain, at
 * cursor null.
 *
 * A refusal is thrown with its keyed message, exactly as for one address -
 * except "this provider has never seen that address", which in a list is
 * the deferred 404 rule: that address has no transactions yet, the others
 * carry on, and a note says so.
 */
const resolveList = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  root: string,
  configured: string[],
  signal?: AbortSignal,
): Promise<{ state: ListState; notes: SourceNote[] }> => {
  const state: ListState = { accounts: [], addresses: [], positions: {} };
  const notes: SourceNote[] = [];
  for (const [index, address] of configured.entries()) {
    const derived = isStakeAddress(address) ? address : stakeAddressOf(address);
    if (derived !== null && state.accounts.includes(derived)) {
      state.positions[address] = null;
      continue;
    }
    const target = await resolveTarget(provider, config, root, signal, address);
    if (target.tier === 'refused') {
      if (target.message === CARDANO_MESSAGES.addressNeverSeen) {
        state.positions[address] = null;
        notes.push({
          message: ADDRESS_NO_TRANSACTIONS_YET,
          params: { line: String(index + 1) },
        });
        continue;
      }
      throw new Error(target.message);
    }
    if (target.tier === 'account') {
      if (state.accounts.includes(target.account)) {
        state.positions[address] = null;
      } else {
        state.accounts.push(target.account);
        state.positions[address] = encodeAccountCursor(1, '', target.account);
      }
      continue;
    }
    state.addresses.push(address);
    state.positions[address] = encodeAddressCursor(1);
  }
  return { state, notes };
};

type Ownership = {
  /** Each listed account's own payment addresses, in `accounts` order. */
  accountSets: { account: string; addresses: Set<string> }[];
  /** The address-tier addresses. */
  addresses: Set<string>;
  /** Withdrawal maps, fetched once per account per page. */
  withdrawals: Map<string, WithdrawalMap>;
};

/**
 * The accounts an address-tier address reveals in one transaction - read
 * off `stake_address`, which only Yaci sends - so change returning to
 * another address of the same wallet counts as the wallet's, as on the
 * single-address path.
 */
const revealedAccounts = (utxos: TxUtxos, ownership: Ownership): string[] => {
  const found: string[] = [];
  for (const entry of [...utxos.inputs, ...utxos.outputs]) {
    if (
      ownership.addresses.has(entry.address) &&
      entry.stake_address &&
      !found.includes(entry.stake_address)
    ) {
      found.push(entry.stake_address);
    }
  }
  return found;
};

/** The venue an entry belongs to, or null for a counterparty's entry. */
const venueOf = (
  entry: UtxoEntry,
  ownership: Ownership,
  revealed: string[],
): string | null => {
  // Neither a collateral nor a reference entry is a movement - see
  // legsForAccount for the -727 ADA wallet this cost.
  if (entry.collateral || entry.reference) {
    return null;
  }
  for (const { account, addresses } of ownership.accountSets) {
    if (addresses.has(entry.address)) {
      return account;
    }
  }
  if (
    entry.stake_address &&
    (revealed.includes(entry.stake_address) ||
      ownership.accountSets.some(
        ({ account }) => account === entry.stake_address,
      ))
  ) {
    return entry.stake_address;
  }
  return ownership.addresses.has(entry.address) ? entry.address : null;
};

/**
 * Every leg of one transaction that belongs to ANY listed account or
 * address. Depends only on the transaction and the list - never on which
 * unit's listing returned it - which is what makes the event identical
 * from either side.
 */
const legsOwned = (
  hash: string,
  utxos: TxUtxos,
  ownership: Ownership,
): Leg[] => {
  const revealed = revealedAccounts(utxos, ownership);
  const side = (entries: UtxoEntry[], direction: Leg['direction']): Leg[] =>
    entries.flatMap((entry) => {
      const venue = venueOf(entry, ownership, revealed);
      return venue === null
        ? []
        : entry.amount.map((amount) => ({
            assetId: assetIdOf(amount.unit),
            amount: amount.quantity,
            direction,
            venue,
            role: 'principal' as const,
          }));
    });
  const withdrawing = [
    ...ownership.accountSets.map(({ account }) => account),
    ...revealed.filter(
      (account) =>
        !ownership.accountSets.some((each) => each.account === account),
    ),
  ];
  return [
    ...side(utxos.inputs, 'out'),
    ...side(utxos.outputs, 'in'),
    // The withdrawn reward leaving the pot, on the withdrawing
    // transaction's own event - see withdrawalLegFor.
    ...withdrawing.flatMap((account) =>
      withdrawalLegFor(
        ownership.withdrawals.get(account) ?? new Map(),
        hash,
        account,
      ),
    ),
  ];
};

const ownershipOf = async (
  root: string,
  headers: Record<string, string>,
  state: ListState,
  signal?: AbortSignal,
): Promise<Ownership> => {
  const accountSets: Ownership['accountSets'] = [];
  const withdrawals = new Map<string, WithdrawalMap>();
  for (const account of state.accounts) {
    accountSets.push({
      account,
      addresses: await fetchAddressSet(root, headers, account, signal),
    });
    withdrawals.set(
      account,
      await fetchWithdrawalMap(root, headers, account, signal),
    );
  }
  return { accountSets, addresses: new Set(state.addresses), withdrawals };
};

/** Events for one page of transactions, oldest first, one per hash. */
const eventsFor = async (
  root: string,
  headers: Record<string, string>,
  transactions: AccountRow[],
  ownership: Ownership,
  signal?: AbortSignal,
): Promise<{ events: DerivedEvent[]; revealed: string[] }> => {
  const allUtxos = await mapConcurrent(transactions, UTXO_CONCURRENCY, (tx) =>
    fetchJson<TxUtxos>(
      `${root}/txs/${tx.tx_hash}/utxos`,
      'fetching transaction utxos',
      headers,
      signal,
    ),
  );
  // Accounts revealed only by an address-tier address need their
  // withdrawal maps before the legs can be built.
  const revealed: string[] = [];
  for (const utxos of allUtxos) {
    for (const account of revealedAccounts(utxos, ownership)) {
      if (!ownership.withdrawals.has(account) && !revealed.includes(account)) {
        revealed.push(account);
      }
    }
  }
  for (const account of revealed) {
    ownership.withdrawals.set(
      account,
      await fetchWithdrawalMap(root, headers, account, signal),
    );
  }

  const events: DerivedEvent[] = [];
  const seen = new Set<string>();
  for (const [index, tx] of transactions.entries()) {
    if (seen.has(tx.tx_hash)) {
      continue;
    }
    seen.add(tx.tx_hash);
    const legs = legsOwned(tx.tx_hash, allUtxos[index], ownership);
    if (legs.length === 0) {
      continue;
    }
    events.push({
      externalId: tx.tx_hash,
      txHash: tx.tx_hash,
      // Seconds from the API, milliseconds in the ledger.
      timestamp: tx.block_time * 1000,
      kind: 'transfer',
      origin: 'derived',
      legs,
    });
  }
  return { events, revealed };
};

const isAddressListing404 = (error: unknown): boolean =>
  error instanceof RouteStatusError &&
  error.status === 404 &&
  error.what === 'listing transactions';

/**
 * One page of a list drain. `rewardsFor` is injected for the same reason
 * fetchAccountPage takes it: this file must not import the translator,
 * which imports it.
 */
export const fetchListPage = async ({
  provider,
  config,
  root,
  configured,
  cursor,
  signal,
  rewardsFor,
}: {
  provider: CardanoProvider;
  config: Record<string, string>;
  root: string;
  configured: string[];
  cursor: string | null;
  signal?: AbortSignal;
  rewardsFor: (account: string) => Promise<DerivedEvent[]>;
}): Promise<FetchPage> => {
  const headers = provider.headers(config);
  const notes: SourceNote[] = [];

  let state = decodeListCursor(cursor, configured);
  if (state === null) {
    const resolved = await resolveList(
      provider,
      config,
      root,
      configured,
      signal,
    );
    state = resolved.state;
    notes.push(...resolved.notes);
  }

  const withNotes = (page: FetchPage): FetchPage =>
    notes.length === 0 ? page : { ...page, notes };

  const index = configured.findIndex(
    (address) => state.positions[address] !== null,
  );
  if (index < 0) {
    return withNotes({ events: [], cursor: null });
  }
  const address = configured[index];
  const position = decodeCursor(state.positions[address]);
  if (position === null) {
    // A position this module did not write: start the drain over.
    return withNotes({ events: [], cursor: null });
  }

  const ownership = await ownershipOf(root, headers, state, signal);
  const events: DerivedEvent[] = [];
  let next: string | null;

  if (position.tier === 'account') {
    const rows = await fetchJson<AccountRow[]>(
      `${root}/accounts/${position.account}/transactions?page=${position.page}&count=${PAGE_SIZE}&order=asc`,
      ACCOUNT_ROUTE_LABELS.transactions,
      headers,
      signal,
    );
    const unique = uniqueTransactions(rows, position.lastTxHash);
    events.push(
      ...(await eventsFor(root, headers, unique, ownership, signal)).events,
    );
    if (position.page === 1) {
      events.push(...(await rewardsFor(position.account)));
    }
    next =
      rows.length < PAGE_SIZE
        ? null
        : encodeAccountCursor(
            position.page + 1,
            lastTxHashOf(rows, position.lastTxHash),
            position.account,
          );
  } else {
    let transactions: AccountRow[];
    try {
      transactions = await fetchJson<AccountRow[]>(
        `${root}/addresses/${address}/transactions?page=${position.page}&count=${PAGE_SIZE}&order=asc`,
        'listing transactions',
        headers,
        signal,
      );
    } catch (error) {
      // The deferred 404 rule, on the drain's side: a listed address the
      // provider has no record of is an empty history for that address
      // alone. Only on its first page - a 404 halfway through is not "no
      // transactions yet", and stays an error.
      if (!isAddressListing404(error) || position.page !== 1) {
        throw error;
      }
      transactions = [];
      notes.push({
        message: ADDRESS_NO_TRANSACTIONS_YET,
        params: { line: String(index + 1) },
      });
    }
    const built = await eventsFor(
      root,
      headers,
      transactions,
      ownership,
      signal,
    );
    events.push(...built.events);
    // Staking income of an account only an address-tier address revealed,
    // once per drain - the single-address path's rule.
    if (position.page === 1) {
      for (const account of built.revealed) {
        events.push(...(await rewardsFor(account)));
      }
    }
    next =
      transactions.length < PAGE_SIZE
        ? null
        : encodeAddressCursor(position.page + 1);
  }

  const positions = { ...state.positions, [address]: next };
  const done = configured.every((each) => positions[each] === null);
  return withNotes({
    events,
    cursor: done ? null : encodeListCursor({ ...state, positions }),
  });
};
