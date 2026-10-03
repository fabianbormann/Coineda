import type { Leg } from '@/ledger/types';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import { fetchJson, probeRoute } from '@/sources/http';
import { amountString as genericAmountString } from '@/sources/amount';
import {
  MAX_ADDRESSES,
  addressListProblem,
  parseAddressList,
} from '@/sources/addressList';
import { parseAccountKey, type AccountKey, type KeyProblem } from './xpub';
import { SCRIPT_TYPES, addressFor } from './script';

/**
 * The Esplora translation (Blockstream.info and mempool.space both serve the
 * identical API shape, see the manifest's `baseUrl` field).
 *
 * Bitcoin has no account view the way a Cardano stake address does: there is
 * no route that lists "everything this wallet owns" given one key, only
 * per-address listings. A wallet with several of its own addresses is
 * therefore represented as several independently configured addresses, and
 * the one thing that needs active handling is a transaction that touches
 * MORE THAN ONE of them (an ordinary send from one of your own addresses to
 * another) - without a rule, it would be drained and emitted once per
 * address it appears under, double- or triple-counting it.
 *
 * Two separate rules handle this, and they answer two separate questions.
 *
 * WHICH address's drain emits the transaction - the ownership rule: the
 * first configured address (in the user's own list order) that appears
 * anywhere in it. Stateless, so it survives a resume, and it prevents the
 * same transaction being emitted twice as the address list is drained one
 * address at a time.
 *
 * WHAT the transaction's legs and venue are, once it is emitted - every
 * configured address is one wallet, and every leg belonging to ANY of them
 * is built, with `venue` always `addresses[0]` - the direct analogue of
 * Cardano's stake-address account rollup, and for the same reason. A self
 * transfer from one configured address to another (A sends 60,000 sats to B,
 * with 39,000 change back to A, on a 100,000 sat input) is not a disposal of
 * 60,000 sats and a silently dropped receipt at B: it is three legs - out
 * 100,000, in 60,000, in 39,000 - all at venue `addresses[0]`, netting to the
 * 1,000 sat fee. Attributing B's inbound leg to venue A while a later spend
 * FROM B still uses venue B (the half-fix: venue = the owning address) drives
 * venue B negative the moment it spends something it was never recorded as
 * having received - the same negative-balance symptom the Cardano account
 * tier exists to fix. `addresses[0]` is deterministic because
 * `parseAddressList` preserves first-seen order, and editing the list forces
 * a full re-drain.
 *
 * The field help states plainly that only the addresses listed are tracked;
 * the rollup above is about venue IDENTITY among the addresses that ARE
 * configured, not about coverage beyond them.
 */

const amountString = (value: number | string, what: string): string =>
  genericAmountString(value, what, 'bitcoin');

const DEFAULT_BASE_URL = 'https://blockstream.info/api';

/** Esplora's own page size for `/address/{addr}/txs` and
 *  `/address/{addr}/txs/chain/{last_seen_txid}` - both return at most this
 *  many, newest first. A page shorter than this is the last page for that
 *  address. */
const PAGE_SIZE = 25;

export const BITCOIN_ESPLORA_MESSAGES = {
  noAddress: 'Add at least one address to track.',
  tooManyAddresses:
    'You can track at most {{max}} addresses - remove some before saving.',
  instanceUnreachable: 'Could not reach the Esplora instance.',
  noHistory:
    'None of these addresses has any transactions. Wallets show a fresh receive address by default - check this is an address you have actually used, on the right network. Bitcoin has no account view, so Coineda can only see the addresses you list here.',
  nothingToTrack:
    'Add an account xpub, or one or more addresses under advanced options.',
  xpubPrivateKey:
    'That is a PRIVATE key. Coineda only ever needs the public one - paste the account xpub (it starts with xpub, ypub or zpub), and keep the private key on your device.',
  xpubWrongDepth:
    'That is an extended public key, but not an account one. Coineda needs the key for a single account, as Ledger Live, Sparrow and Electrum export it - not the wallet master key.',
  xpubNotAKey:
    'That does not look like an extended public key. Copy the account xpub from your wallet - it is a long string starting with xpub, ypub or zpub, and it is case-sensitive.',
} as const;

/** The base URL, normalised. Unlike Cardano's providers this is the full API
 *  root already (e.g. `https://blockstream.info/api`) - Esplora has no
 *  separate host/API-path split to validate, so there is no `apiRoot`/
 *  `HostShapeError` use here. */
export const baseUrlOf = (config: Record<string, string>): string =>
  (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

export const configuredAddresses = (config: Record<string, string>): string[] =>
  parseAddressList(config.address);

/**
 * The cursor: `btc:<addressIndex>:<lastSeenTxid>`.
 *
 * `addressIndex` is which configured address (0-based, in the user's own
 * list order) is currently being drained; `lastSeenTxid` is empty when that
 * address's drain has not yet requested a page, and otherwise the oldest
 * txid seen so far for it - exactly the `last_seen_txid` Esplora's `/chain/`
 * route expects, so the next page continues further into the past rather
 * than re-requesting the newest 25 again.
 *
 * Stateless by construction: the whole position is recoverable from the
 * string alone, which is what lets a resume pick up an exhausted address and
 * move on to the next one instead of restarting address 0.
 */
export const encodeCursor = (
  addressIndex: number,
  lastSeenTxid: string,
): string => `btc:${addressIndex}:${lastSeenTxid}`;

export const decodeCursor = (
  cursor: string | null,
): { addressIndex: number; lastSeenTxid: string } => {
  const start = { addressIndex: 0, lastSeenTxid: '' };
  if (cursor === null || !cursor.startsWith('btc:')) {
    // null starts at index 0; anything unrecognised starts over rather than
    // guess, the same choice Cardano's own decodeCursor makes.
    return start;
  }
  const rest = cursor.slice('btc:'.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) {
    return start;
  }
  const indexPart = rest.slice(0, firstColon);
  if (!/^\d+$/.test(indexPart)) {
    return start;
  }
  return {
    addressIndex: Number.parseInt(indexPart, 10),
    lastSeenTxid: rest.slice(firstColon + 1),
  };
};

type EsploraVin = {
  /** Absent entirely for a coinbase input - there is no previous output to
   *  spend, so there is no address and no value to attribute to anyone. */
  prevout?: { scriptpubkey_address?: string; value?: number } | null;
};

type EsploraVout = {
  /** Absent for a non-standard ("unspendable"/OP_RETURN-style) output. */
  scriptpubkey_address?: string;
  value: number;
};

export type EsploraTransaction = {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    /** Seconds, not milliseconds. Absent on an unconfirmed transaction. */
    block_time?: number;
  };
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee: number;
};

/**
 * Whether this page is the live tip of this address's history, i.e. a
 * mempool/unconfirmed transaction with no accrual date a tax report could
 * use, or a confirmed one Esplora has not yet timestamped. Either way there
 * is nothing honest to stamp it with, so it is skipped rather than dated
 * "now" (wrong) or left as NaN (worse - `conformance.ts` rejects a
 * non-finite timestamp outright). The gate does now run against this module
 * (tests/bitcoinEsploraFixtures.test.ts), but it cannot cover this case:
 * Esplora reports a transaction as unconfirmed only while it is in the
 * mempool, so by the time a recording is committed it has confirmed. Every
 * recorded transaction is confirmed, necessarily, which is why the skip rule
 * is pinned synthetically instead.
 */
const isConfirmedWithDate = (
  tx: EsploraTransaction,
): tx is EsploraTransaction & { status: { block_time: number } } =>
  tx.status.confirmed === true && typeof tx.status.block_time === 'number';

/**
 * The first configured address (in the user's own list order) that appears
 * anywhere in this transaction - as a spent input or a paid output - or
 * `null` when none of them do.
 *
 * Order is semantic, exactly as it is in `parseAddressList`: configuring A
 * before B means a transaction touching both is A's, not B's. That is the
 * entire ownership rule, and it needs no state beyond the transaction
 * itself and the user's own address list, which is why it survives a
 * resume with nothing persisted but the cursor.
 */
export const ownerOf = (
  tx: EsploraTransaction,
  addresses: string[],
): string | null => {
  const participants = new Set<string>();
  for (const vin of tx.vin) {
    const address = vin.prevout?.scriptpubkey_address;
    if (address) {
      participants.add(address);
    }
  }
  for (const vout of tx.vout) {
    if (vout.scriptpubkey_address) {
      participants.add(vout.scriptpubkey_address);
    }
  }
  return addresses.find((address) => participants.has(address)) ?? null;
};

/**
 * Legs for one side of a transaction (spent inputs or paid outputs),
 * filtered to ANY configured address - the whole wallet, not just the one
 * address whose drain happened to emit this transaction.
 *
 * `venue` is always `addresses[0]`, never the entry's own address: that is
 * what makes a self-transfer between two configured addresses net to the
 * fee instead of looking like a disposal at one address and an un-tracked
 * receipt at the other. See the module doc comment above for the full
 * reasoning and the negative-balance failure mode this guards against.
 *
 * A coinbase input contributes nothing (no `prevout`, so no address and no
 * value to read), which is why this never throws on one; it simply filters
 * it out like any other entry whose address is not in the configured set.
 */
const legsFrom = (
  entries: { address?: string; value?: number }[],
  direction: Leg['direction'],
  addressSet: Set<string>,
  venue: string,
  what: string,
): Leg[] =>
  entries
    .filter(
      (entry): entry is { address: string; value?: number } =>
        typeof entry.address === 'string' && addressSet.has(entry.address),
    )
    .map((entry) => ({
      assetId: 'bitcoin:native',
      // Satoshis stay satoshis - never divided by 1e8 here. The pricing
      // boundary (src/prices/scale.ts, ASSET_DECIMALS) does that scaling.
      amount: amountString(entry.value as number, what),
      direction,
      venue,
      role: 'principal' as const,
    }));

const legsForTransaction = (
  tx: EsploraTransaction,
  addresses: string[],
): Leg[] => {
  const addressSet = new Set(addresses);
  const venue = addresses[0];
  return [
    ...legsFrom(
      tx.vin.map((vin) => ({
        address: vin.prevout?.scriptpubkey_address,
        value: vin.prevout?.value,
      })),
      'out',
      addressSet,
      venue,
      'a spent input amount',
    ),
    ...legsFrom(
      tx.vout.map((vout) => ({
        address: vout.scriptpubkey_address,
        value: vout.value,
      })),
      'in',
      addressSet,
      venue,
      'a paid output amount',
    ),
  ];
};

/** How many receive-chain indices the detector tries per candidate type. */
const DETECT_INDICES = 5;

/**
 * Decides which address encoding a wallet uses by asking the chain, because
 * the key itself does not say.
 *
 * xpub, ypub and zpub differ only in four version bytes, and Ledger Live
 * exports a native-SegWit account labelled `xpub` regardless - so inferring
 * BIP44 from an `xpub` would derive legacy addresses for a bech32 wallet,
 * find nothing, and report an empty history. A valid, silent, wrong answer.
 *
 * Walks SCRIPT_TYPES in order and stops at the first address with history,
 * so a native-SegWit wallet whose first address is used costs ONE request.
 * Five indices per type rather than one: a wallet whose address 0 was never
 * used but whose later ones were is a real wallet, and probing index 0 alone
 * would refuse it as empty. Five is inside the gap limit, so the probe and
 * the drain agree about what "empty" means.
 *
 * Null means no encoding had history, i.e. the wallet is empty - which the
 * caller reports as such rather than falling back to a guess.
 */
export const detectScriptType = async (
  key: AccountKey,
  root: string,
  signal?: AbortSignal,
): Promise<(typeof SCRIPT_TYPES)[number] | null> => {
  for (const type of SCRIPT_TYPES) {
    for (let index = 0; index < DETECT_INDICES; index += 1) {
      const address = addressFor(type, key.publicKeyAt(0, index), key.network);
      const result = await probeRoute(
        `${root}/address/${address}/txs`,
        {},
        signal,
      );
      if (
        result.outcome === 'ok' &&
        Array.isArray(result.body) &&
        result.body.length > 0
      ) {
        return type;
      }
    }
  }
  return null;
};

/** The key problems, each with its own message: "invalid key" would leave a
 *  user with nothing to act on, and the three causes need three different
 *  actions. */
const KEY_PROBLEM_MESSAGES: Record<KeyProblem, string> = {
  privateKey: BITCOIN_ESPLORA_MESSAGES.xpubPrivateKey,
  wrongDepth: BITCOIN_ESPLORA_MESSAGES.xpubWrongDepth,
  notAKey: BITCOIN_ESPLORA_MESSAGES.xpubNotAKey,
  unknownVersion: BITCOIN_ESPLORA_MESSAGES.xpubNotAKey,
};

export const configuredXpub = (config: Record<string, string>): string =>
  (config.xpub ?? '').trim();

export const probe = async (
  config: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  const xpub = configuredXpub(config);
  const listed = configuredAddresses(config);

  // Both fields are optional individually; the real rule is that at least
  // one must be given, and it has to live here because the manifest's
  // `optional` flag is per-field and cannot express "one of these two".
  if (xpub === '' && listed.length === 0) {
    return { ok: false, message: BITCOIN_ESPLORA_MESSAGES.nothingToTrack };
  }

  if (xpub !== '') {
    const parsed = parseAccountKey(xpub);
    if ('problem' in parsed) {
      // Takes the problem KIND only - never the key - so nothing that
      // reveals the wallet can reach a message that gets stored as
      // lastError and rendered on screen.
      return { ok: false, message: KEY_PROBLEM_MESSAGES[parsed.problem] };
    }
    const detected = await detectScriptType(
      parsed.key,
      baseUrlOf(config),
      signal,
    );
    if (detected !== null) {
      // An extended PUBLIC key confers no spending power, so readOnly can be
      // stated with certainty rather than left undefined.
      return { ok: true, readOnly: true };
    }
    if (listed.length === 0) {
      return { ok: false, message: BITCOIN_ESPLORA_MESSAGES.noHistory };
    }
    // An unused xpub alongside listed addresses falls through to the address
    // check below, which may still find history there.
  }

  return probeListedAddresses(config, signal);
};

const probeListedAddresses = async (
  config: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  // Only the cap is checked here now. "Empty" is no longer this function's
  // business: the list became optional when the xpub field arrived, and
  // `probe` has already established that at least one of the two was given.
  const problem = addressListProblem(config.address);
  if (problem?.reason === 'tooMany') {
    return {
      ok: false,
      message: BITCOIN_ESPLORA_MESSAGES.tooManyAddresses,
      messageParams: { max: String(MAX_ADDRESSES) },
    };
  }

  const addresses = configuredAddresses(config);
  const root = baseUrlOf(config);

  // Walks the configured addresses and stops at the FIRST one with any
  // history, rather than probing addresses[0] alone.
  //
  // Two reasons, and the second came from a real report. The route is the
  // drain's OWN first-page request, never a liveness route - a route that
  // merely confirms the instance is up says nothing about whether it can
  // serve what the sync depends on, the gap Cardano's probe was rewritten to
  // close. And an UNUSED address answers that route with `200 []`, which the
  // old check read as success: a user who pasted a fresh receive address -
  // which is what a wallet's UI shows by default, while the history lives on
  // other derived addresses - got a clean "ok" on save and then a sync that
  // finished having fetched nothing, with no way to tell a wrong address from
  // a broken importer. Bitcoin has no account view, so Coineda cannot find
  // those other addresses for them; the least it can do is say so instead of
  // reporting success.
  //
  // Only an entirely empty wallet is rejected, not any empty address: a list
  // mixing used and fresh addresses is perfectly ordinary, and a real wallet
  // accumulates unused ones. Short-circuiting means the common case still
  // costs ONE request, and the 50-request worst case is reached only by a
  // configuration that is about to be rejected anyway.
  let reachable = false;
  for (const address of addresses) {
    const result = await probeRoute(
      `${root}/address/${address}/txs`,
      {},
      signal,
    );
    if (result.outcome !== 'ok') {
      continue;
    }
    reachable = true;
    if (!Array.isArray(result.body) || result.body.length > 0) {
      // Found history - or a body this module cannot interpret, which is the
      // drain's problem to report rather than the probe's to guess at.
      // An address confers no spending power at all, so a Bitcoin source can
      // state readOnly with certainty, the same as Cardano's.
      return { ok: true, readOnly: true };
    }
  }

  if (!reachable) {
    return { ok: false, message: BITCOIN_ESPLORA_MESSAGES.instanceUnreachable };
  }
  return { ok: false, message: BITCOIN_ESPLORA_MESSAGES.noHistory };
};

export const fetchEvents = async (
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const addresses = configuredAddresses(config);
  const { addressIndex, lastSeenTxid } = decodeCursor(cursor);

  if (addressIndex >= addresses.length) {
    // Defensive: a cursor outliving a shrunk address list. Nothing left to
    // drain.
    return { events: [], cursor: null };
  }

  const address = addresses[addressIndex];
  const root = baseUrlOf(config);
  const url =
    lastSeenTxid === ''
      ? `${root}/address/${address}/txs`
      : `${root}/address/${address}/txs/chain/${lastSeenTxid}`;

  const page = await fetchJson<EsploraTransaction[]>(
    // Named by POSITION, never by the address itself - see the error-message
    // rule on SourceModule: whatever this throws is stored verbatim as the
    // source's lastError and rendered on screen.
    url,
    `listing transactions for configured address ${addressIndex + 1}`,
    {},
    signal,
    'bitcoin',
  );

  const events: DerivedEvent[] = [];
  for (const tx of page) {
    if (!isConfirmedWithDate(tx)) {
      continue;
    }
    const owner = ownerOf(tx, addresses);
    if (owner !== address) {
      // Either owned by an earlier-configured address (already emitted
      // during that address's own drain) or, in principle, no configured
      // address at all - either way not this address's event to emit. Which
      // address emits it is still decided by ownership; what its legs and
      // venue are is decided across the WHOLE configured list, below.
      continue;
    }
    const legs = legsForTransaction(tx, addresses);
    if (legs.length === 0) {
      // Belt and braces, and deliberately kept as such rather than described
      // as a reachable path: `owner === address` above means this address is
      // among the transaction's participants, and legsFrom filters on nothing
      // but address membership, so at least one leg always follows. This
      // guard only fires if that reasoning stops holding - which is exactly
      // when an event with no legs would otherwise reach the ledger and be
      // counted as a transfer of nothing.
      continue;
    }
    events.push({
      externalId: tx.txid,
      // Esplora reports seconds; the ledger stores epoch milliseconds.
      timestamp: tx.status.block_time * 1000,
      kind: 'transfer',
      origin: 'derived',
      legs,
    });
  }

  // Pagination is decided from the RAW page length, independent of the
  // confirmed-status filter above: Esplora's own paging contract is "a page
  // shorter than PAGE_SIZE is the last page", and that is a fact about what
  // the provider returned, not about which of those rows this module chose
  // to emit.
  if (page.length < PAGE_SIZE) {
    const nextIndex = addressIndex + 1;
    return {
      events,
      cursor: nextIndex < addresses.length ? encodeCursor(nextIndex, '') : null,
    };
  }
  return {
    events,
    cursor: encodeCursor(addressIndex, page[page.length - 1].txid),
  };
};
