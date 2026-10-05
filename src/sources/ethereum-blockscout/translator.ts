import Big from 'big.js';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import type { Leg } from '@/ledger/types';
import { REQUEST_TIMEOUT_MS, errorName, signalFor } from '@/sources/http';
import { configuredAddress, normaliseAddress } from './address';

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
const DEFAULT_BASE_URL = 'https://eth.blockscout.com';

export const ETHEREUM_MESSAGES = {
  missingAddress:
    'Add the Ethereum address to track, as 0x followed by 40 hex characters.',
  unreachable:
    'Could not reach this Blockscout instance. Check the URL, or try again later.',
  notBlockscout:
    'That URL answered, but not like a Blockscout API. Check that it is the API host rather than the web interface.',
} as const;

export const baseUrlOf = (config: Record<string, string>): string => {
  const configured = (config.baseUrl ?? '').trim();
  // Trailing slashes are stripped so the paths below can own the leading
  // one, rather than producing `//api/v2/...` for anyone who pasted a URL
  // the way a browser shows it.
  return (configured === '' ? DEFAULT_BASE_URL : configured).replace(
    /\/+$/,
    '',
  );
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
  ours: string,
): DerivedEvent | { skipped: string } => {
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
  if (succeeded && isPositive(value)) {
    if (from === ours) {
      legs.push({
        assetId: 'eth:native',
        amount: value,
        direction: 'out',
        venue: ours,
        role: 'principal',
      });
    }
    if (to === ours) {
      legs.push({
        assetId: 'eth:native',
        amount: value,
        direction: 'in',
        venue: ours,
        role: 'principal',
      });
    }
  }

  // Gas is paid by the sender whether the transaction succeeded or not,
  // and on a zero-value contract call it is the ONLY thing that moved. Omit
  // it and a wallet's balance drifts upward by every fee it ever paid.
  if (from === ours && isPositive(fee)) {
    legs.push({
      assetId: 'eth:native',
      amount: fee!,
      direction: 'out',
      venue: ours,
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
  ours: string,
): DerivedEvent | { skipped: string } => {
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
  if (from === ours) {
    legs.push({
      assetId: 'eth:native',
      amount: value,
      direction: 'out',
      venue: ours,
      role: 'principal',
    });
  }
  if (to === ours) {
    legs.push({
      assetId: 'eth:native',
      amount: value,
      direction: 'in',
      venue: ours,
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

export const fetchEvents = async (
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const address = configuredAddress(config);
  if (address === null) {
    throw new Error(ETHEREUM_MESSAGES.missingAddress);
  }

  const { phase, params } = decodeCursor(cursor);
  const fetched = await request(
    config,
    `/api/v2/addresses/${address}/${ROUTES[phase]}${queryOf(params)}`,
    signal,
  );
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new Error(
      `ethereum-blockscout: listing ${ROUTES[phase]} failed with status ${fetched.status}`,
    );
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
        ? transactionToEvent(row as TransactionRow, address)
        : internalToEvent(row as InternalRow, address);
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

export { REQUEST_TIMEOUT_MS };
