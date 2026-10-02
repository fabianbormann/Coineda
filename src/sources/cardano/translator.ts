import type { Leg } from '@/ledger/types';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';

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
export type CardanoProvider = {
  /** Host only, no trailing slash - the API path is added here. */
  host: (config: Record<string, string>) => string;
  /** The provider's API root segment, e.g. '/api/v1' or '/api/v0'. */
  apiPath: string;
  /**
   * Request headers. Returns an empty object for a keyless provider, which
   * is why a Yaci-configured source still sends no credential at all.
   */
  headers: (config: Record<string, string>) => Record<string, string>;
  /**
   * A valid host for this provider, named in the "the base URL should be
   * the host only" complaint. Per provider because suggesting a Yaci Store
   * URL on a Blockfrost row - which is what a single hardcoded example
   * did - sends the user to fix their configuration with an address that
   * cannot work for the module they are configuring.
   */
  exampleHost: string;
  /**
   * Maps a non-ok HTTP status from `probe` to a translation key. Separate
   * per provider because a keyless one can never see a 403, and a
   * credential-bearing one must distinguish "your key was refused" from
   * "try again later" - collapsing those leaves the user guessing which.
   *
   * It receives only a status code, never the config, so a credential
   * cannot reach a message by this route.
   */
  probeMessage: (status: number) => string;
};

// Comfortably under both providers' documented maximum of 100 per page.
const PAGE_SIZE = 20;

type AddressTransaction = {
  tx_hash: string;
  /** Seconds, not milliseconds - see fetchCardanoEvents. */
  block_time: number;
};

type UtxoAmount = {
  unit: string;
  /** Already a decimal string - never parse this to a number and back. */
  quantity: string;
};

type UtxoEntry = {
  address: string;
  /**
   * The account this payment address belongs to, or null for an enterprise
   * or Byron-era address that has no staking part. This is what makes an
   * account-level view possible without a second request: the provider
   * already tells us, on every entry, which wallet the address is part of.
   */
  stake_address: string | null;
  amount: UtxoAmount[];
};

type TxUtxos = {
  inputs: UtxoEntry[];
  outputs: UtxoEntry[];
};

type EpochReward = {
  epoch: number;
  /** A JSON NUMBER here, unlike the utxo endpoints' strings - see
   *  amountString for why that has to be checked rather than trusted. */
  amount: number | string;
  type: string;
};

/**
 * A Cardano wallet is an account - one stake address - spread across many
 * rotating payment addresses. Tracking a single payment address means change
 * returning to a DIFFERENT address of the same wallet is invisible, so an
 * ordinary outbound payment looks like a disposal of everything that left.
 * Filtering on the account fixes that: the change comes back as an `in` leg,
 * nets against the spend, and classifies as internal.
 */
const STAKE_PREFIXES = ['stake1', 'stake_test1'];

export const isStakeAddress = (address: string): boolean =>
  STAKE_PREFIXES.some((prefix) => address?.startsWith(prefix));

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
 * Turns a provider amount into a decimal string, refusing one that JSON
 * parsing has already destroyed.
 *
 * The utxo endpoints return `quantity` as a string, which passes through
 * untouched. The rewards endpoint returns `amount` as a JSON number, and by
 * the time this function runs `JSON.parse` has already rounded anything
 * above Number.MAX_SAFE_INTEGER - the true value is simply gone and no
 * amount of care here can recover it. Failing the sync is the only honest
 * response, because the alternative is a silently wrong number in a tax
 * report.
 */
const amountString = (value: number | string, what: string): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `cardano: ${what} exceeds safe integer precision - JSON parsing has already rounded it, so the true value cannot be recovered`,
    );
  }
  return String(value);
};

/** Chain-qualified so 'lovelace' here can never collide with the same
 *  symbol on another chain, and the native lovelace unit gets its own
 *  readable id instead of inheriting the raw provider unit string. */
const assetIdOf = (unit: string): string =>
  unit === 'lovelace' ? 'cardano:lovelace' : `cardano:${unit}`;

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
      account === null
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
 * Every provider request is given a deadline.
 *
 * Reported from real use, and the actual cause of a "sync that never
 * stops": a malformed host made the service accept the connection and
 * never answer. With no timeout anywhere, that one hanging fetch wedged the
 * whole sync - no error written to the source, no completion, the button
 * disabled forever. A provider that stops responding has to become a
 * visible error, not a permanent silence, and that is true of every module
 * rather than of one mistyped URL.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The `name` of a thrown value, without assuming it is an `Error`.
 *
 * `instanceof Error` is not reliable here: under jsdom a `DOMException`
 * comes from a different realm and fails that check, so a timeout would
 * fall through to the generic path and surface as "The operation was
 * aborted" - a message that names no request and reads like a
 * cancellation the user never performed. The project hit the same realm
 * problem once already in the checkpoint code.
 */
const errorName = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';

/**
 * The module's own deadline, combined with whatever the caller supplied.
 *
 * Both have to apply: the timeout ends a hang, and the caller's signal ends
 * a sync the user pressed stop on. Combining them here is what lets one
 * mechanism serve both, and keeps the two distinguishable afterwards - a
 * timeout aborts with `TimeoutError`, a caller with `AbortError`.
 */
const signalFor = (external?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return external ? AbortSignal.any([external, timeout]) : timeout;
};

/**
 * Rejects a base URL that is already an API root.
 *
 * Nothing previously told the user whether this field wanted a host or a
 * full API root, and pasting the latter produced `host/api/v1/api/v1/...`
 * or, with a trailing slash, `host//api/v1/...` - which the live service
 * accepts and never answers. Saying what the field wants beats silently
 * building a path that hangs.
 */
const assertHostOnly = (host: string, exampleHost: string): void => {
  if (/\/api(\/|$)/i.test(host)) {
    throw new Error(
      `cardano: the base URL should be the host only, without an API path - for example ${exampleHost}`,
    );
  }
};

/**
 * The host, normalised.
 *
 * Trailing slashes are stripped because the API path is appended here: a
 * pasted `https://host/` would otherwise build `https://host//api/v1/...`,
 * and that URL hangs against the live service rather than failing. A
 * trailing slash on a pasted URL is completely ordinary, so tolerating it
 * is the module's job, not the user's.
 */
const apiRoot = (
  provider: CardanoProvider,
  config: Record<string, string>,
): string => {
  const host = provider.host(config).trim().replace(/\/+$/, '');
  assertHostOnly(host, provider.exampleHost);
  return `${host}${provider.apiPath}`;
};

/**
 * Names the request that failed and the status it returned - never the
 * credential it used, and never the config. See the error-message rule on
 * `SourceModule`: whatever this throws is stored verbatim as the source's
 * `lastError`, rendered on screen, and carried in the checkpoint.
 */
const fetchJson = async <T>(
  url: string,
  what: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: signalFor(signal) });
  } catch (error) {
    // A timeout is the one failure worth renaming: the platform's own
    // message is "The operation was aborted", which tells a user nothing
    // about which request died or why, and reads like a cancellation they
    // did not perform.
    if (errorName(error) === 'TimeoutError') {
      throw new Error(
        `cardano: ${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s - the instance accepted the connection but never answered`,
        // The original abort is kept as the cause: the message above is for
        // the user, and discarding what actually threw would leave nothing
        // to debug with if the rename ever hid a different failure.
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`cardano: ${what} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
};

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
 * decides. And member versus leader is preserved in `note` rather than
 * flattened, because a pool operator's leader rewards may be business
 * income rather than capital income depending on the country.
 */
export const fetchRewardEvents = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  stakeAddress: string,
  signal?: AbortSignal,
): Promise<DerivedEvent[]> => {
  const root = apiRoot(provider, config);
  const headers = provider.headers(config);

  const rewards = await fetchJson<EpochReward[]>(
    `${root}/accounts/${stakeAddress}/rewards`,
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
          venue: stakeAddress,
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
  // Yaci answers 200 with an empty array when a stake address is passed to
  // the address endpoint, so without this the user gets a SUCCESSFUL sync
  // reporting zero transactions and nothing at all to indicate their input
  // was the wrong kind of address. Resolving an account's payment addresses
  // needs an endpoint Yaci does not have.
  if (isStakeAddress(config.address ?? '')) {
    return {
      ok: false,
      message:
        'That looks like a stake address. Enter one of the wallet’s payment addresses instead - Coineda finds the rest of the account from it.',
    };
  }
  try {
    // apiRoot validates the host shape and can throw, which is why it is
    // inside the try: a base URL that is already an API root must come back
    // as an actionable message on this row, not as an unhandled rejection.
    const root = apiRoot(provider, config);
    const response = await fetch(`${root}/blocks/latest`, {
      headers: provider.headers(config),
      signal: signalFor(signal),
    });
    if (!response.ok) {
      return { ok: false, message: provider.probeMessage(response.status) };
    }
    // An address confers no spending power at all - probing it can only
    // ever confirm read access, never anything more - so a Cardano source
    // can state readOnly with certainty rather than leaving it undefined.
    // This stays true for a credential-bearing provider: a Blockfrost
    // project id reads the chain, it cannot move anyone's funds.
    return { ok: true, readOnly: true };
  } catch (error) {
    // A host-shape complaint and a timeout both say something specific and
    // useful; anything else falls back to the provider's own wording.
    if (
      error instanceof Error &&
      /the base URL|timed out/.test(error.message)
    ) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: provider.probeMessage(0) };
  }
};

export const fetchCardanoEvents = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const root = apiRoot(provider, config);
  const address = config.address;
  const headers = provider.headers(config);

  // Same guard as probeCardano, because fetchEvents is reachable without a
  // probe: syncSource calls it directly on every refresh. Throwing beats
  // returning an empty page, which would look like a wallet with no history.
  if (isStakeAddress(address ?? '')) {
    throw new Error(
      'cardano: a stake address was configured, but this module needs one of the account’s payment addresses',
    );
  }

  // Both providers document `page` as 1-based, and Yaci Store's live
  // behaviour confirms it despite its own OpenAPI document declaring
  // minimum 0: page=0 and page=1 return the identical first page, and
  // page=2 is the real second page - verified directly against the live
  // preprod instance. Starting at 1 is correct under either reading, and
  // starting at 0 would re-fetch the first page as its own "next" page,
  // emitting the same transactions twice in one drain and tripping the
  // conformance harness's duplicate-externalId check on any address with
  // more transactions than fit on one page.
  const page = cursor === null ? 1 : Number.parseInt(cursor, 10);

  const transactions = await fetchJson<AddressTransaction[]>(
    `${root}/addresses/${address}/transactions?page=${page}&count=${PAGE_SIZE}&order=asc`,
    'listing transactions',
    headers,
    signal,
  );

  const events: DerivedEvent[] = [];
  let account: string | null = null;
  for (const tx of transactions) {
    const utxos = await fetchJson<TxUtxos>(
      `${root}/txs/${tx.tx_hash}/utxos`,
      'fetching transaction utxos',
      headers,
      signal,
    );

    const resolved = accountOf(utxos, address);
    account = account ?? resolved;

    const legs = [
      ...legsFor(utxos.inputs, 'out', address, resolved),
      ...legsFor(utxos.outputs, 'in', address, resolved),
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
  // KNOWN GAP, stated rather than silently accepted. `account` is read off
  // the transactions this page returned (see accountOf), so a payment
  // address with no transaction history resolves no account and its
  // staking income is absent from the ledger - and a freshly derived
  // address of a delegating wallet is exactly that case: no transactions,
  // real rewards. The user sees a successful sync and no staking income,
  // with nothing saying why.
  //
  // Resolving the account independently needs an endpoint that maps a
  // payment address to its stake address. Blockfrost documents
  // `GET /addresses/{address}` with a `stake_address` field; Yaci Store's
  // equivalent is unverified, there are no recorded fixtures for it on
  // either provider, and this project does not hand-write provider
  // fixtures. Calling it unconditionally would turn an unknown route into
  // a thrown error - fetchJson rejects any non-ok status - and so break
  // syncing for every user of whichever provider lacks it, to fix a case
  // that only affects a wallet with no transactions. A best-effort call
  // swallowing every failure would be worse still: it would make the
  // request's success part of what a sync silently depends on, and the
  // conformance harness could not tell the two outcomes apart.
  //
  // What to do when a Blockfrost key and recorded fixtures are available:
  // add the lookup as a per-provider capability (a provider that has the
  // route supplies it, one that does not stays on the transaction-derived
  // account), with its own fixture, rather than a shared unverified call.
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
    cursor: transactions.length < PAGE_SIZE ? null : String(page + 1),
  };
};
