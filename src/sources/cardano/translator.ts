import type { Leg } from '@/ledger/types';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import type { CardanoProvider } from './provider';
import {
  apiRoot,
  drainPagedRoute,
  fetchJson,
  HostShapeError,
  RouteStatusError,
} from './http';
import { amountString, assetIdOf, type TxUtxos, type UtxoEntry } from './utxo';
import { CARDANO_MESSAGES } from './messages';
import { configuredAddress, resolveTarget } from './tier';
import {
  ACCOUNT_HISTORY_PAGE_SIZE,
  PAGE_SIZE,
  decodeCursor,
  encodeAddressCursor,
} from './cursor';
import { ACCOUNT_ROUTE_LABELS, fetchAccountPage } from './account';
import { fetchWithdrawalMap, rewardsVenueOf, withdrawalLegFor } from './pot';

// Re-exported because it was exported from here before the split.
export { isStakeAddress } from './tier';

// Re-exported because the reward pot moved to its own module (pot.ts) so
// that both leg builders could reach it without importing this file, which
// imports them. Kept importable from here so no caller changes for a move.
export { REWARDS_VENUE_SUFFIX, rewardsVenueOf } from './pot';

// Re-exported because src/sources/cardano-{yaci,blockfrost}/index.ts import
// this type from here. Moved to provider.ts to break the cycle with tier.ts;
// kept importable from here so no module file changes for a file move.
export type { CardanoProvider } from './provider';

/**
 * The Cardano translation shared by every Cardano provider module.
 *
 * Yaci Store deliberately mirrors Blockfrost's API, so the two differ only
 * in their host, their API path segment and their authentication - not in
 * how a transaction becomes ledger events. That translation is the part
 * worth getting right once: it decides disposal classification, tax-year
 * membership and dedupe identity, and a second hand-written copy is a
 * second place for those to drift.
 *
 * A provider supplies the differences. Everything below is identical for
 * all of them.
 */

type AddressTransaction = {
  tx_hash: string;
  /** Seconds, not milliseconds - see fetchCardanoEvents. */
  block_time: number;
};

type EpochReward = {
  epoch: number;
  /** A JSON NUMBER here, unlike the utxo endpoints' strings - see
   *  amountString for why that has to be checked rather than trusted. */
  amount: number | string;
  type: string;
};

/**
 * The account the configured payment address belongs to, read off the
 * transaction we were already fetching.
 *
 * Resolved per transaction rather than cached across the page: it costs no
 * extra request either way, and a transaction that somehow does not reveal
 * it simply falls back to exact-address matching for itself instead of
 * poisoning the rest of the page.
 */
const accountOf = (utxos: TxUtxos, address: string): string | null => {
  for (const entry of [...utxos.inputs, ...utxos.outputs]) {
    if (entry.address === address && entry.stake_address) {
      return entry.stake_address;
    }
  }
  return null;
};

/**
 * Legs for one side (inputs or outputs) of a transaction's utxos,
 * filtered to the account being watched.
 *
 * This filter is the module's half of the contract documented on
 * `SourceModule` in src/sources/types.ts: emit legs only for the account
 * this source was configured to watch, never the counterparty. An input
 * entry belonging to the account is value leaving it (direction 'out'); a
 * matching output entry is value arriving (direction 'in').
 *
 * `account` is the stake address when one could be resolved, and the venue
 * becomes that account - so every payment address of the wallet reports
 * under one venue, and movement between them nets to zero. When it is null
 * (an enterprise or Byron address, which has no staking part) this falls
 * back to exact payment-address matching, which is an account of one
 * address rather than an error.
 */
const legsFor = (
  entries: UtxoEntry[],
  direction: Leg['direction'],
  address: string,
  account: string | null,
): Leg[] =>
  entries
    .filter((entry) =>
      // A collateral entry is a guarantee, not a movement: a successful
      // script transaction lists it and never spends it. Counting it as a
      // spend subtracted money that never left - a real wallet reported a
      // balance of -727 ADA against a true +25 ADA for exactly this reason.
      //
      // A reference input is the same mistake in a different costume: a
      // dApp READS it to see its datum and never consumes it. Blockfrost
      // flags it per entry, and every one of the 30 recorded input entries
      // carries `reference: false`, so the field is live and simply never
      // true in that recording - it goes true the moment a script
      // references one of this wallet's own UTxOs, and the symptom is the
      // same phantom disposal and negative balance.
      entry.collateral || entry.reference
        ? false
        : account === null
          ? entry.address === address
          : entry.stake_address === account,
    )
    .flatMap((entry) =>
      entry.amount.map((amount) => ({
        assetId: assetIdOf(amount.unit),
        amount: amount.quantity,
        direction,
        venue: account ?? entry.address,
        role: 'principal' as const,
      })),
    );

/**
 * Staking rewards as ledger events.
 *
 * These are invisible in transaction history: a reward accrues to the
 * account at an epoch boundary and never appears as a transaction until it
 * is withdrawn, so a delegating user's staking income would otherwise be
 * absent from the ledger entirely. Missing income is worse than an
 * unresolved cost basis, because an unresolved item announces itself and
 * this would not.
 *
 * Two things this deliberately does not decide. Whether a reward is taxable
 * on accrual or on withdrawal is a contested jurisdiction question, so this
 * emits the accrual date and says nothing about taxability - the tax module
 * decides. Emitting the accrual here at a venue of its own, and the
 * withdrawal as an `out` leg at that venue on the withdrawing transaction's
 * own event (see pot.ts), is what makes either timing representable; it does
 * not pick one. And member
 * versus leader is preserved in `note` rather than flattened, because a pool
 * operator's leader rewards may be business income rather than capital
 * income depending on the country.
 */
export const fetchRewardEvents = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  stakeAddress: string,
  signal?: AbortSignal,
): Promise<DerivedEvent[]> => {
  const root = apiRoot(provider, config);
  const headers = provider.headers(config);

  const rewards = await drainPagedRoute<EpochReward>(
    (page) =>
      `${root}/accounts/${stakeAddress}/rewards?page=${page}&count=${ACCOUNT_HISTORY_PAGE_SIZE}`,
    'listing staking rewards',
    headers,
    signal,
  );

  // A reward carries only an epoch number, and an epoch's end is when the
  // reward became the user's. Without this an event would be undated or
  // stamped "now", landing in the wrong tax year - which is the only thing
  // the date is for. Epochs are immutable once past, so one lookup each is
  // enough however many rewards reference them.
  const epochEnds = new Map<number, number>();
  const endMsOf = async (epoch: number): Promise<number> => {
    const cached = epochEnds.get(epoch);
    if (cached !== undefined) {
      return cached;
    }
    const details = await fetchJson<{ end_time: number }>(
      `${root}/epochs/${epoch}`,
      `fetching epoch ${epoch}`,
      headers,
      signal,
    );
    const ms = details.end_time * 1000;
    epochEnds.set(epoch, ms);
    return ms;
  };

  const events: DerivedEvent[] = [];
  for (const reward of rewards) {
    events.push({
      // Stable across replays, which is what the host's dedupe on
      // (sourceId, externalId) depends on: one reward per account per epoch
      // is a fact that never changes.
      externalId: `reward:${stakeAddress}:${reward.epoch}`,
      timestamp: await endMsOf(reward.epoch),
      kind: 'reward',
      origin: 'derived',
      note: `staking reward (${reward.type}), epoch ${reward.epoch}`,
      // The provider record verbatim, so member-versus-leader survives as
      // data rather than only as prose in `note` - a jurisdiction that taxes
      // a pool operator's leader rewards as business income needs to branch
      // on it, and branching on a sentence is not a contract.
      raw: reward,
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: amountString(
            reward.amount,
            `staking reward for epoch ${reward.epoch}`,
          ),
          direction: 'in',
          // The reward pot, not the account's UTxO venue. See
          // rewardsVenueOf.
          venue: rewardsVenueOf(stakeAddress),
          role: 'principal',
        },
      ],
    });
  }
  return events;
};

export const probeCardano = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  try {
    // apiRoot validates the host shape and can throw, which is why it is
    // inside the try: a base URL that is already an API root must come back
    // as an actionable message on this row, not as an unhandled rejection.
    const root = apiRoot(provider, config);

    // `resolveTarget` is the whole probe, for every shape of address. It
    // asks the one question that matters - can this instance serve what
    // this source would drain - by requesting the routes the drain itself
    // requests. `/blocks/latest` is deliberately no longer probed: it
    // reported an instance alive without saying whether it could serve
    // THIS source, which is how a never-seen address reached the drain and
    // surfaced as "listing transactions failed with status 404".
    const target = await resolveTarget(provider, config, root, signal);
    if (target.tier === 'refused') {
      return {
        ok: false,
        message: target.message,
        messageParams: target.messageParams,
      };
    }
    // An address confers no spending power at all - probing it can only
    // ever confirm read access, never anything more - so a Cardano source
    // can state readOnly with certainty rather than leaving it undefined.
    // This stays true for a credential-bearing provider: a Blockfrost
    // project id reads the chain, it cannot move anyone's funds.
    return { ok: true, readOnly: true };
  } catch (error) {
    // A typed error, not a regex over a message. The project already chose
    // this shape for CoinGeckoHistoryError, on the stated grounds that
    // branching on a status beats parsing prose - and here it also carries
    // the example host the translated message has to interpolate.
    if (error instanceof HostShapeError) {
      return {
        ok: false,
        message: CARDANO_MESSAGES.hostShape,
        messageParams: { example: error.exampleHost },
      };
    }
    // No timeout branch here any more, and none is reachable: every request
    // the probe makes now goes through probeRoute, which turns a timeout
    // into a Target rather than an exception. What still lands here is a
    // malformed host (above) or a caller's abort.
    return { ok: false, message: provider.probeMessage(0) };
  }
};

/**
 * Today's behaviour: one payment address, unchanged.
 *
 * Kept as the private body `fetchCardanoEvents` had before the account tier
 * existed - only its cursor handling moved out, since the tier is now
 * decided (and read back) by its caller rather than here.
 */
const fetchAddressPage = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  root: string,
  page: number,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const address = configuredAddress(config);
  const headers = provider.headers(config);

  const transactions = await fetchJson<AddressTransaction[]>(
    `${root}/addresses/${address}/transactions?page=${page}&count=${PAGE_SIZE}&order=asc`,
    'listing transactions',
    headers,
    signal,
  );

  // Two passes, because a reward withdrawal has to be merged into the event
  // of the transaction that performed it, and the account - which is what
  // the withdrawals route is keyed on - is only known once a transaction has
  // revealed it. The utxos are fetched once, in pass one, and reused.
  const fetched: { tx: AddressTransaction; utxos: TxUtxos }[] = [];
  let account: string | null = null;
  for (const tx of transactions) {
    const utxos = await fetchJson<TxUtxos>(
      `${root}/txs/${tx.tx_hash}/utxos`,
      'fetching transaction utxos',
      headers,
      signal,
    );
    fetched.push({ tx, utxos });
    account = account ?? accountOf(utxos, address);
  }

  // Only when an account was resolved: without one there is no pot to
  // withdraw from, and nothing to key the route on.
  const withdrawals =
    account === null
      ? new Map<string, string>()
      : await fetchWithdrawalMap(root, headers, account, signal);

  const events: DerivedEvent[] = [];
  for (const { tx, utxos } of fetched) {
    const resolved = accountOf(utxos, address);

    const legs = [
      ...legsFor(utxos.inputs, 'out', address, resolved),
      ...legsFor(utxos.outputs, 'in', address, resolved),
      // The withdrawn reward leaving the pot, on the event of the
      // transaction that withdrew it - never an event of its own. See
      // withdrawalLegFor for why a lone `out` leg became a phantom disposal.
      ...(resolved === null
        ? []
        : withdrawalLegFor(withdrawals, tx.tx_hash, resolved)),
    ];

    // A transaction this address merely appears in without actually moving
    // value for it produces no legs - skip it rather than handing the
    // conformance gate an empty event, which it rejects outright.
    if (legs.length === 0) {
      continue;
    }

    events.push({
      externalId: tx.tx_hash,
      // The API returns seconds; the ledger stores epoch milliseconds.
      // Storing these unconverted would date every event to 1970 and put
      // it in the wrong tax year.
      timestamp: tx.block_time * 1000,
      kind: 'transfer',
      origin: 'derived',
      legs,
    });
  }

  // Rewards are account-level, not paginated alongside transactions, so
  // they are fetched once per drain rather than once per page. A drain
  // always starts at cursor null, so this runs exactly once each time and
  // produces the same events - which is what keeps the conformance
  // harness's double-drain comparison happy.
  //
  // KNOWN GAP, and it belongs to this path only. `account` is read off the
  // transactions this page returned, so a payment address with no
  // transaction history resolves no account and its staking income is
  // absent - a freshly derived address of a delegating wallet is exactly
  // that case. The account tier does not have this gap: it knows the
  // account before the first listing request, and a payment address now
  // reaches that tier whenever the instance serves it, so what is left
  // here is an instance that cannot. An instance serving
  // /accounts/{stake}/transactions and /accounts/{stake}/addresses is what
  // reaches that tier - for Yaci Store, the `blockfrost` Spring profile.
  if (page === 1 && account !== null) {
    events.push(
      ...(await fetchRewardEvents(provider, config, account, signal)),
    );
  }

  return {
    // Ascending order is what makes this cursor stable: page 1 is always
    // the oldest transactions, so new activity appends to the end and never
    // shifts a page the host has already consumed. Descending would
    // renumber every page on each new transaction and break resumption.
    events,
    cursor:
      transactions.length < PAGE_SIZE ? null : encodeAddressCursor(page + 1),
  };
};

/**
 * Does this failure mean the instance no longer serves the account tier?
 *
 * A typed status and a shared label, never a regex over the message. The
 * addresses route counts as well as the transactions one: that route is how
 * the account's own utxo entries are recognised at all on Blockfrost, so an
 * instance that lost it cannot serve this tier either.
 */
const isAccountRouteAbsent = (error: unknown): boolean =>
  error instanceof RouteStatusError &&
  error.status === 404 &&
  (Object.values(ACCOUNT_ROUTE_LABELS) as string[]).includes(error.what);

export const fetchCardanoEvents = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const root = apiRoot(provider, config);
  const decoded = decodeCursor(cursor);

  // The tier is decided ONCE per drain. Later pages read it back out of the
  // cursor, so the one or two extra requests the decision costs are paid
  // once rather than per page.
  if (decoded?.tier === 'account') {
    try {
      return await fetchAccountPage({
        provider,
        config,
        root,
        account: decoded.account,
        page: decoded.page,
        carriedTxHash: decoded.lastTxHash,
        signal,
        rewardsFor: (account) =>
          fetchRewardEvents(provider, config, account, signal),
      });
    } catch (error) {
      // Spec section 8: a cursor whose tier does not match the tier now
      // selected is treated as null - start over. A persisted cursor was
      // trusted unconditionally before this, and that is reachable: point a
      // configured source at an instance that no longer serves the account
      // routes and the drain threw the raw `cardano: listing account
      // transactions failed with status 404` - the exact raw status this
      // module exists to retire - where the same source at cursor null
      // correctly refuses with a keyed, translated message. Worse, it never
      // recovered: `syncSource` does not advance a cursor past a page that
      // threw, so the dead page was re-issued forever.
      //
      // Only a 404 from an ACCOUNT route means that. Any other status is the
      // provider saying something specific - a refused credential, a rate
      // limit - and discarding a good cursor over a transient 429 would
      // re-drain a whole history for nothing.
      if (!isAccountRouteAbsent(error)) {
        throw error;
      }
      // Falls through to the tier resolution below, which starts at page 1
      // and either re-selects a tier or refuses with a message the user can
      // act on.
    }
  }
  if (decoded?.tier === 'address') {
    return fetchAddressPage(provider, config, root, decoded.page, signal);
  }

  // Every address shape resolves through here now, the payment-address
  // path included. It was briefly gated on isStakeAddress, because
  // resolveTarget probes two routes the recorded fixtures did not hold, and
  // the stubs throw on an unrecorded URL; both routes are recorded against
  // the live providers now, so the gate is gone. What it was holding back
  // is the half that matters most to a user: pasting a PAYMENT address of
  // an account-capable instance upgrades to full account tracking, and
  // pasting one the provider has never seen says so (addressNeverSeen)
  // instead of failing the drain with a bare status 404.
  const target = await resolveTarget(provider, config, root, signal);
  // Throwing beats returning an empty page, which would look like a wallet
  // with no history. The message is already a translation key; syncSource
  // stores it as lastError and SourceRow renders it.
  if (target.tier === 'refused') {
    throw new Error(target.message);
  }
  if (target.tier === 'account') {
    return fetchAccountPage({
      provider,
      config,
      root,
      account: target.account,
      page: 1,
      carriedTxHash: '',
      signal,
      rewardsFor: (account) =>
        fetchRewardEvents(provider, config, account, signal),
    });
  }
  // The address tier: a payment address on an instance that cannot serve
  // the account routes, or one with no staking part at all. resolveTarget
  // never returns it for a stake address - that is refused outright, see
  // its own branch.
  return fetchAddressPage(provider, config, root, 1, signal);
};
