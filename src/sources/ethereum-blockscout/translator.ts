import { fallbackBaseUrl } from '@/sources/egress';
import Big from 'big.js';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import type { Leg } from '@/ledger/types';
import { REQUEST_TIMEOUT_MS, errorName, signalFor } from '@/sources/http';
import {
  configuredAddress,
  configuredAddresses,
  normaliseAddress,
} from './address';
import {
  ADDRESS_NO_TRANSACTIONS_YET,
  TOO_MANY_ADDRESSES,
  readAddresses,
} from '@/sources/addresses';
import { MAX_ADDRESSES } from '@/sources/addressList';

/**
 * Blockscout's v2 API (https://github.com/blockscout/blockscout).
 *
 * Measured live on 2026-10-05, and these facts shape everything below:
 *
 * - **A browser may call it, with no credential at all.** The public
 *   instance answers `access-control-allow-origin: *` and needs no key,
 *   which is why it is the default here - the same shape as Esplora for
 *   Bitcoin. It is also open source and self-hostable, so `baseUrl` points
 *   at your own instance, or at the deployments for Base, Arbitrum and the
 *   other EVM chains that serve this identical API.
 * - **A plain node is not an alternative.** Standard JSON-RPC has no
 *   "transactions for an address" method at all - measured:
 *   `eth_getBalance` answers, `eth_getTransactionsByAddress` does not
 *   exist. Infura, Alchemy or a self-run Geth cannot replace this; an
 *   indexer is required, not a preference.
 * - **Two routes, both needed.** `/transactions` carries ordinary
 *   transfers; ETH moved BY A CONTRACT - an exchange withdrawal routed
 *   through one, a DEX payout, a multisig - appears only under
 *   `/internal-transactions`. Reading just the first is the same silent
 *   hole as reading Bitpanda's `/trades` without its withdrawals.
 * - **They do not overlap.** Checked across 50 rows of each: exactly one
 *   internal row shared a parent transaction with the list, and it carried
 *   a different value - a genuinely separate movement inside the same
 *   transaction. Nothing reproduces the top-level transfer, so draining
 *   both double-counts nothing.
 * - **A failed transaction still costs gas.** Measured a row with
 *   `status: "error"`, `value: "100000000000000"` and a real fee: the ether
 *   did NOT move, the gas did. Booking that value would invent a holding.
 */

export const ETHEREUM_MESSAGES = {
  missingAddress:
    'Add the Ethereum address to track, as 0x followed by 40 hex characters.',
  unreachable:
    'Could not reach this Blockscout instance. Check the URL, or try again later.',
  notBlockscout:
    'That URL answered, but not like a Blockscout API. Check that it is the API host rather than the web interface.',
  invalidListedAddress:
    'Line {{line}} of the address list is not an Ethereum address - each line needs 0x followed by 40 hex characters.',
  listedAddressUnreachable:
    'This Blockscout instance did not answer for address {{line}} in the list. Check the URL, or try again later.',
} as const;

/**
 * The tracked addresses as a set, for the "is this party us?" test.
 *
 * A single string is still accepted: the row translators are exported and
 * called with one address directly, and one address is a set of one.
 */
export type Ours = string | ReadonlySet<string>;

const asSet = (ours: Ours): ReadonlySet<string> =>
  typeof ours === 'string' ? new Set([ours]) : ours;

export const baseUrlOf = (config: Record<string, string>): string => {
  const configured = (config.baseUrl ?? '').trim();
  // Trailing slashes are stripped so the paths below can own the leading
  // one, rather than producing `//api/v2/...` for anyone who pasted a URL
  // the way a browser shows it.
  return (
    configured === '' ? fallbackBaseUrl('ethereumBlockscout') : configured
  ).replace(/\/+$/, '');
};

type Fetched = { status: number; body: string };

const request = async (
  config: Record<string, string>,
  path: string,
  signal?: AbortSignal,
): Promise<Fetched> => {
  const response = await fetch(`${baseUrlOf(config)}${path}`, {
    headers: { Accept: 'application/json' },
    signal: signalFor(signal),
  });
  return { status: response.status, body: await response.text() };
};

const asJson = (fetched: Fetched, what: string): unknown => {
  try {
    return JSON.parse(fetched.body);
  } catch {
    throw new Error(
      `ethereum-blockscout: ${what} did not return JSON (HTTP ${fetched.status}): ${fetched.body.slice(0, 120)}`,
    );
  }
};

export const probe = async (
  config: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  const { addresses, invalidLine } = configuredAddresses(config);
  if (addresses.length > MAX_ADDRESSES) {
    return {
      ok: false,
      message: TOO_MANY_ADDRESSES,
      messageParams: { max: String(MAX_ADDRESSES) },
    };
  }
  if (readAddresses(config).length > 1) {
    return probeList(config, addresses, invalidLine, signal);
  }
  const address = configuredAddress(config);
  if (address === null) {
    return { ok: false, message: ETHEREUM_MESSAGES.missingAddress };
  }

  let fetched: Fetched;
  try {
    // The address endpoint rather than a liveness route: it proves the
    // instance is a Blockscout AND that it will answer about this address.
    // A wallet with no history is still a valid answer here, so an empty
    // result is NOT treated as a failure - a newly funded address would
    // otherwise be refused at setup.
    fetched = await request(config, `/api/v2/addresses/${address}`, signal);
  } catch (error) {
    if (errorName(error) === 'TimeoutError') {
      return { ok: false, message: ETHEREUM_MESSAGES.unreachable };
    }
    return { ok: false, message: ETHEREUM_MESSAGES.unreachable };
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    // 404 included: Blockscout answers 404 for an address it has never
    // seen, which is an empty wallet rather than a broken instance - but it
    // is also what a wrong base URL returns, and the two cannot be told
    // apart from here, so the honest message names both.
    return { ok: false, message: ETHEREUM_MESSAGES.unreachable };
  }

  const body = asJson(fetched, 'the address lookup') as Record<string, unknown>;
  if (typeof body !== 'object' || body === null || !('hash' in body)) {
    return { ok: false, message: ETHEREUM_MESSAGES.notBlockscout };
  }

  // No credential exists to be read-only or otherwise, so `readOnly` is
  // left undefined rather than claimed - the same choice the other
  // keyless chain modules make.
  return { ok: true };
};

/**
 * The probe for a list of addresses: every line has to be an address, and
 * the instance has to answer like a Blockscout for each of them.
 *
 * A 404 for one listed address is an address Blockscout has never seen - a
 * fresh one, no history yet - and is accepted, the same way the drain reads
 * it as an empty page. A 404 for EVERY one of them is far more likely a
 * wrong base URL than a list of unused addresses, and is refused as such.
 * Any other failure names the line it happened on.
 */
const probeList = async (
  config: Record<string, string>,
  addresses: string[],
  invalidLine: number | null,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  if (invalidLine !== null) {
    return {
      ok: false,
      message: ETHEREUM_MESSAGES.invalidListedAddress,
      messageParams: { line: String(invalidLine) },
    };
  }
  let unseen = 0;
  for (const [index, address] of addresses.entries()) {
    const line = String(index + 1);
    let fetched: Fetched;
    try {
      fetched = await request(config, `/api/v2/addresses/${address}`, signal);
    } catch {
      return {
        ok: false,
        message: ETHEREUM_MESSAGES.listedAddressUnreachable,
        messageParams: { line },
      };
    }
    if (fetched.status === 404) {
      unseen += 1;
      continue;
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      return {
        ok: false,
        message: ETHEREUM_MESSAGES.listedAddressUnreachable,
        messageParams: { line },
      };
    }
    const body = asJson(fetched, 'the address lookup') as Record<
      string,
      unknown
    >;
    if (typeof body !== 'object' || body === null || !('hash' in body)) {
      return { ok: false, message: ETHEREUM_MESSAGES.notBlockscout };
    }
  }
  if (unseen === addresses.length) {
    return { ok: false, message: ETHEREUM_MESSAGES.unreachable };
  }
  return { ok: true };
};

type Party = { hash?: unknown } | null | undefined;

const hashOf = (party: Party): string | null =>
  party !== null && party !== undefined && typeof party.hash === 'string'
    ? normaliseAddress(party.hash)
    : null;

const str = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

const isPositive = (amount: string | null): boolean => {
  if (amount === null) {
    return false;
  }
  try {
    return new Big(amount).gt(0);
  } catch {
    return false;
  }
};

const timestampOf = (value: unknown, what: string): number => {
  const iso = str(value);
  const parsed = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `ethereum-blockscout: ${what} carried an unreadable timestamp: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
};

export type TransactionRow = {
  hash?: unknown;
  timestamp?: unknown;
  value?: unknown;
  fee?: { value?: unknown } | null;
  status?: unknown;
  from?: Party;
  to?: Party;
};

/**
 * One ordinary transaction to one ledger event, from the point of view of
 * the tracked address.
 *
 * Amounts arrive in WEI and are stored as they arrive. Unlike an exchange,
 * a chain reports base units already, so there is no conversion here and
 * therefore no place for the scale error that `baseUnits` exists to catch
 * on the Bitpanda side.
 *
 * Only legs at the tracked address are emitted, never the counterparty's.
 * `ownedVenuesOf` trusts every venue it finds in the ledger, so emitting
 * the other side would silently assert that the user owns it, and every
 * outbound payment would then classify as an internal transfer.
 */
export const transactionToEvent = (
  row: TransactionRow,
  ours: Ours,
): DerivedEvent | { skipped: string } => {
  const owned = asSet(ours);
  const hash = str(row.hash);
  if (hash === null) {
    throw new Error(
      `ethereum-blockscout: a transaction is missing its hash. It carried: ${
        Object.keys(row).join(', ') || '(none)'
      }`,
    );
  }

  const from = hashOf(row.from);
  const to = hashOf(row.to);
  const value = str(row.value) ?? '0';
  const fee = str(row.fee?.value);
  const succeeded = str(row.status) === 'ok';
  const legs: Leg[] = [];

  // The value moves only on success. A reverted transaction keeps its
  // `value` field populated - measured: status "error" with value
  // 100000000000000 - and booking it would invent ether the user never
  // received or spent.
  //
  // Each leg's venue is ITS address - venues stay per address when several
  // are tracked - and both sides of a transfer between two tracked
  // addresses are built, so the event is the same whichever address's
  // drain lists it, and the upsert on (sourceId, externalId) is a no-op
  // rather than one address's view overwriting the other's.
  if (succeeded && isPositive(value)) {
    if (from !== null && owned.has(from)) {
      legs.push({
        assetId: 'eth:native',
        amount: value,
        direction: 'out',
        venue: from,
        role: 'principal',
      });
    }
    if (to !== null && owned.has(to)) {
      legs.push({
        assetId: 'eth:native',
        amount: value,
        direction: 'in',
        venue: to,
        role: 'principal',
      });
    }
  }

  // Gas is paid by the sender whether the transaction succeeded or not,
  // and on a zero-value contract call it is the ONLY thing that moved. Omit
  // it and a wallet's balance drifts upward by every fee it ever paid.
  if (from !== null && owned.has(from) && isPositive(fee)) {
    legs.push({
      assetId: 'eth:native',
      amount: fee!,
      direction: 'out',
      venue: from,
      role: 'fee',
    });
  }

  if (legs.length === 0) {
    // Nothing of ours moved: a contract call we merely appear in, or a
    // failed transaction somebody else paid for.
    return { skipped: hash };
  }

  return {
    externalId: hash,
    txHash: hash,
    timestamp: timestampOf(row.timestamp, 'a transaction'),
    kind: 'transfer',
    origin: 'derived',
    legs,
  };
};

export type InternalRow = {
  transaction_hash?: unknown;
  index?: unknown;
  timestamp?: unknown;
  value?: unknown;
  success?: unknown;
  from?: Party;
  to?: Party;
};

/**
 * One internal transaction - ether moved by a contract rather than by an
 * ordinary transfer.
 *
 * No fee leg: the gas for the whole transaction belongs to its top-level
 * row, which the other phase already charged. Charging it again here would
 * subtract the same gas once per internal call.
 */
export const internalToEvent = (
  row: InternalRow,
  ours: Ours,
): DerivedEvent | { skipped: string } => {
  const owned = asSet(ours);
  const hash = str(row.transaction_hash);
  const index = str(row.index);
  if (hash === null || index === null) {
    throw new Error(
      `ethereum-blockscout: an internal transaction is missing its identity. It carried: ${
        Object.keys(row).join(', ') || '(none)'
      }`,
    );
  }

  // The id is the parent hash PLUS the call index, because one transaction
  // can hold many internal calls - measured 50 distinct keys across 50
  // rows. Keying on the hash alone would have each call overwrite the last,
  // since events upsert on (sourceId, externalId).
  const externalId = `${hash}#i${index}`;

  if (row.success !== true) {
    return { skipped: externalId };
  }

  const value = str(row.value) ?? '0';
  if (!isPositive(value)) {
    // A contract call that moved no ether. Common, and not a movement.
    return { skipped: externalId };
  }

  const from = hashOf(row.from);
  const to = hashOf(row.to);
  const legs: Leg[] = [];
  if (from !== null && owned.has(from)) {
    legs.push({
      assetId: 'eth:native',
      amount: value,
      direction: 'out',
      venue: from,
      role: 'principal',
    });
  }
  if (to !== null && owned.has(to)) {
    legs.push({
      assetId: 'eth:native',
      amount: value,
      direction: 'in',
      venue: to,
      role: 'principal',
    });
  }

  if (legs.length === 0) {
    return { skipped: externalId };
  }

  return {
    externalId,
    // The PARENT transaction's hash, not the per-call id: the hash is what
    // an exchange reports for the withdrawal that produced this call, and
    // matching on the call id would never find it.
    txHash: hash,
    timestamp: timestampOf(row.timestamp, 'an internal transaction'),
    kind: 'transfer',
    origin: 'derived',
    legs,
  };
};

/**
 * The drain runs ordinary transactions first, then internal ones.
 *
 * Blockscout pages by keyset: a response carries `next_page_params`, an
 * opaque object fed straight back as query parameters. Verified to produce
 * no overlap between consecutive pages, which an offset-based scheme cannot
 * promise on a chain that keeps growing underneath the drain.
 *
 * The object is carried through the cursor base64-encoded. It contains
 * colons inside its ISO timestamps, and the cursor format is
 * colon-delimited - encoding sidesteps a parser that would otherwise split
 * a timestamp in half.
 */
export type Phase = 'transactions' | 'internal';

const ROUTES: Record<Phase, string> = {
  transactions: 'transactions',
  internal: 'internal-transactions',
};

export const encodeCursor = (
  phase: Phase,
  nextPageParams: Record<string, unknown> | null,
): string =>
  `eth:${phase}:${
    nextPageParams === null ? '' : btoa(JSON.stringify(nextPageParams))
  }`;

export const decodeCursor = (
  cursor: string | null,
): { phase: Phase; params: Record<string, unknown> | null } => {
  if (cursor === null) {
    return { phase: 'transactions', params: null };
  }
  const match = /^eth:(transactions|internal):(.*)$/.exec(cursor);
  if (match === null) {
    // Anything unrecognised starts over rather than guessing, the same
    // choice every other module here makes. A restart converges, because
    // events upsert on (sourceId, externalId).
    return { phase: 'transactions', params: null };
  }
  if (match[2] === '') {
    return { phase: match[1] as Phase, params: null };
  }
  try {
    return {
      phase: match[1] as Phase,
      params: JSON.parse(atob(match[2])) as Record<string, unknown>,
    };
  } catch {
    return { phase: match[1] as Phase, params: null };
  }
};

const queryOf = (params: Record<string, unknown> | null): string => {
  if (params === null) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
};

/** A listing that answered a non-2xx status, kept typed so a list can read
 *  a 404 as "no transactions yet" for that one address. */
class ListingStatusError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
  ) {
    super(`ethereum-blockscout: listing ${route} failed with status ${status}`);
  }
}

/** One page of one address's drain - the whole of `fetchEvents` before
 *  address lists, with the tracked set passed in. */
const fetchAddressPage = async (
  config: Record<string, string>,
  address: string,
  owned: ReadonlySet<string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const { phase, params } = decodeCursor(cursor);
  const fetched = await request(
    config,
    `/api/v2/addresses/${address}/${ROUTES[phase]}${queryOf(params)}`,
    signal,
  );
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new ListingStatusError(ROUTES[phase], fetched.status);
  }

  const body = asJson(fetched, `the ${ROUTES[phase]} list`) as {
    items?: unknown;
    next_page_params?: unknown;
  };
  if (!Array.isArray(body.items)) {
    throw new Error(
      `ethereum-blockscout: expected a list under "items" but the response carried: ${Object.keys(
        body ?? {},
      ).join(', ')}`,
    );
  }

  const events: DerivedEvent[] = [];
  for (const row of body.items) {
    const result =
      phase === 'transactions'
        ? transactionToEvent(row as TransactionRow, owned)
        : internalToEvent(row as InternalRow, owned);
    if ('skipped' in result) {
      continue;
    }
    events.push(result);
  }

  const next =
    typeof body.next_page_params === 'object' && body.next_page_params !== null
      ? (body.next_page_params as Record<string, unknown>)
      : null;

  if (phase === 'transactions') {
    // Ordinary transactions exhausted, so hand over to the internal phase
    // rather than finishing: contract-moved ether lives only there, and
    // stopping here is exactly the hole this second phase exists to close.
    return {
      events,
      cursor:
        next === null
          ? encodeCursor('internal', null)
          : encodeCursor('transactions', next),
    };
  }

  return {
    events,
    cursor: next === null ? null : encodeCursor('internal', next),
  };
};

/**
 * The cursor for a LIST of addresses: `ethm:` plus a base64 JSON map from
 * each address to its own single-address cursor - absent for not started,
 * `null` for drained. One address is drained at a time, in list order, so
 * the map is what lets a resumed drain pick up the right address at the
 * right page.
 *
 * A single address keeps the plain `eth:` cursor, so a source that was
 * mid-sync when lists arrived resumes where it stopped.
 */
export type ListCursor = Record<string, string | null>;

export const encodeListCursor = (state: ListCursor): string =>
  `ethm:${btoa(JSON.stringify(state))}`;

export const decodeListCursor = (
  cursor: string | null,
  addresses: string[],
): ListCursor => {
  if (cursor === null || !cursor.startsWith('ethm:')) {
    return {};
  }
  try {
    const parsed = JSON.parse(atob(cursor.slice('ethm:'.length))) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const state: ListCursor = {};
    for (const [key, value] of Object.entries(parsed)) {
      // An address no longer in the list means the list changed under a
      // stored cursor - start over rather than resume a different wallet.
      if (!addresses.includes(key)) {
        return {};
      }
      if (value === null || typeof value === 'string') {
        state[key] = value;
      }
    }
    return state;
  } catch {
    return {};
  }
};

const fetchListPage = async (
  config: Record<string, string>,
  addresses: string[],
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const state = decodeListCursor(cursor, addresses);
  const owned = new Set(addresses);
  const index = addresses.findIndex((address) => state[address] !== null);
  if (index < 0) {
    return { events: [], cursor: null };
  }
  const address = addresses[index];
  const inner = state[address] ?? null;

  let page: FetchPage;
  try {
    page = await fetchAddressPage(config, address, owned, inner, signal);
  } catch (error) {
    // The deferred 404 rule: in a list, an address Blockscout has never
    // seen is an empty history for THAT address, and the others carry on.
    // Only on its first request - a 404 halfway through a drain is not "no
    // transactions yet", and stays an error.
    if (
      !(error instanceof ListingStatusError) ||
      error.status !== 404 ||
      inner !== null
    ) {
      throw error;
    }
    page = {
      events: [],
      cursor: null,
      notes: [
        {
          message: ADDRESS_NO_TRANSACTIONS_YET,
          params: { line: String(index + 1) },
        },
      ],
    };
  }

  const next: ListCursor = { ...state, [address]: page.cursor };
  const done = addresses.every((each) => next[each] === null);
  return {
    events: page.events,
    cursor: done ? null : encodeListCursor(next),
    ...(page.notes === undefined ? {} : { notes: page.notes }),
  };
};

export const fetchEvents = async (
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const { addresses, invalidLine } = configuredAddresses(config);
  if (readAddresses(config).length > 1) {
    if (invalidLine !== null) {
      // Names the line, never the address - see the error-message rule on
      // SourceModule.
      throw new Error(
        `ethereum-blockscout: line ${invalidLine} of the address list is not an Ethereum address`,
      );
    }
    return fetchListPage(config, addresses, cursor, signal);
  }

  const address = configuredAddress(config);
  if (address === null) {
    throw new Error(ETHEREUM_MESSAGES.missingAddress);
  }
  return fetchAddressPage(config, address, new Set([address]), cursor, signal);
};

export { REQUEST_TIMEOUT_MS };
