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
import { SCRIPT_TYPES, addressFor, type SupportedScriptType } from './script';
import { GAP_LIMIT, buildWallet, type Wallet } from './wallet';

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
 * The cursor: `btc:<scriptType>:<stage>:<index>:<gap>:<lastSeenTxid>`.
 *
 * Three stages, in ownership order: 0 the receive chain, 1 the change chain,
 * 2 the listed addresses. One uniform shape covers both halves of a source
 * rather than two formats that could disagree, and `gap` is unused in stage
 * 2, where the address set is finite and known.
 *
 * `scriptType` travels here rather than in config because `probe` has no way
 * to write config back and `ProbeResult` has no field for it - and
 * re-detecting on every page would spend requests per page instead of once
 * per drain. Empty means nothing is derived: no xpub, or an xpub whose type
 * could not be detected because the wallet is empty.
 *
 * `gap` has to be IN the cursor: it is state the scan needs and nothing else
 * persists, so a resume that lost it would restart the gap and rescan, or
 * stop early. `lastSeenTxid` stays last because a txid is hex and cannot
 * contain the separator.
 *
 * Any other shape restarts rather than guessing, which is also what retires
 * the two-component format this replaced: an old stored cursor reads as
 * unrecognised and the drain begins again, which dedupe on
 * (sourceId, externalId) makes lossless.
 */
export const encodeCursor = (
  scriptType: SupportedScriptType | '',
  stage: number,
  index: number,
  gap: number,
  lastSeenTxid: string,
): string => `btc:${scriptType}:${stage}:${index}:${gap}:${lastSeenTxid}`;

export type DecodedCursor = {
  scriptType: SupportedScriptType | '';
  stage: number;
  index: number;
  gap: number;
  lastSeenTxid: string;
};

const START: DecodedCursor = {
  scriptType: '',
  stage: 0,
  index: 0,
  gap: 0,
  lastSeenTxid: '',
};

export const decodeCursor = (cursor: string | null): DecodedCursor => {
  if (cursor === null) {
    return START;
  }
  const parts = cursor.split(':');
  if (parts.length !== 6 || parts[0] !== 'btc') {
    return START;
  }
  const [, type, stage, index, gap, lastSeenTxid] = parts;
  if (![stage, index, gap].every((value) => /^\d+$/.test(value))) {
    return START;
  }
  if (type !== '' && !SCRIPT_TYPES.includes(type as SupportedScriptType)) {
    return START;
  }
  return {
    scriptType: type as SupportedScriptType | '',
    stage: Number.parseInt(stage, 10),
    index: Number.parseInt(index, 10),
    gap: Number.parseInt(gap, 10),
    lastSeenTxid,
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
 * Legs for one side of a transaction, filtered to the addresses this source
 * covers.
 *
 * Filtered to the WHOLE wallet, not to the address being scanned. That is
 * what makes a transfer between two of the wallet's own addresses net to the
 * fee rather than look like a disposal of everything that left, and it is
 * also what keeps the drain idempotent: the leg set does not depend on which
 * address surfaced the transaction, so a replayed drain produces identical
 * content. A coinbase input contributes nothing, having no prevout and so no
 * address to match.
 */
const legsFrom = (
  entries: { address?: string; value?: number }[],
  direction: Leg['direction'],
  wallet: Wallet,
  venue: string,
  what: string,
): Leg[] =>
  entries
    .filter(
      (entry): entry is { address: string; value?: number } =>
        typeof entry.address === 'string' &&
        wallet.rankOf(entry.address) !== undefined,
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

const legsForTransaction = (tx: EsploraTransaction, wallet: Wallet): Leg[] => {
  const venue = wallet.ordered[0];
  return [
    ...legsFrom(
      tx.vin.map((vin) => ({
        address: vin.prevout?.scriptpubkey_address,
        value: vin.prevout?.value,
      })),
      'out',
      wallet,
      venue,
      'a spent input amount',
    ),
    ...legsFrom(
      tx.vout.map((vout) => ({
        address: vout.scriptpubkey_address,
        value: vout.value,
      })),
      'in',
      wallet,
      venue,
      'a paid output amount',
    ),
  ];
};

/**
 * The address that owns this transaction: the earliest of the wallet's own
 * addresses appearing anywhere in it, or null if none does.
 *
 * "Earliest" is by the wallet's own total order - receive chain, then change
 * chain, then the listed addresses. A total order is what makes this a rule
 * rather than a preference: every pair of the source's addresses is
 * comparable, so exactly one of them owns any given transaction however many
 * of them it touches, and the answer does not depend on which address's page
 * the transaction was drained from. Nothing is persisted to decide it, which
 * is what lets a resume mid-drain reach the same conclusion.
 */
export const ownerOf = (
  tx: EsploraTransaction,
  wallet: Wallet,
): string | null => {
  let best: { address: string; rank: number } | null = null;
  const consider = (address?: string) => {
    if (address === undefined) {
      return;
    }
    const rank = wallet.rankOf(address);
    if (rank === undefined) {
      return;
    }
    if (best === null || rank < best.rank) {
      best = { address, rank };
    }
  };
  for (const vin of tx.vin) {
    consider(vin.prevout?.scriptpubkey_address);
  }
  for (const vout of tx.vout) {
    consider(vout.scriptpubkey_address);
  }
  return best === null ? null : (best as { address: string }).address;
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

/** Stage 0 receive chain, 1 change chain, 2 the listed addresses. */
const LAST_STAGE = 2;

/** The address a stage/index pair points at, or null when that stage has
 *  nothing there - no xpub for the derived stages, or past the end of the
 *  list for stage 2. */
const addressAt = (
  wallet: Wallet,
  stage: number,
  index: number,
): string | null => {
  if (stage === 0 || stage === 1) {
    return wallet.derivedAt(stage, index);
  }
  return index < wallet.listed.length ? wallet.listed[index] : null;
};

/** The next stage that has anything to scan, or null when none does. An
 *  empty stage is skipped rather than walked, which is how an addresses-only
 *  source is the same drain with its derived stages empty instead of a
 *  second code path. */
const nextStageWithWork = (wallet: Wallet, from: number): number | null => {
  for (let stage = from; stage <= LAST_STAGE; stage += 1) {
    if (addressAt(wallet, stage, 0) !== null) {
      return stage;
    }
  }
  return null;
};

export const fetchEvents = async (
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const root = baseUrlOf(config);
  const listed = configuredAddresses(config);
  const xpub = configuredXpub(config);

  let key: AccountKey | null = null;
  if (xpub !== '') {
    const parsed = parseAccountKey(xpub);
    if ('problem' in parsed) {
      // The same refusal the probe gives, by the same message - a config
      // that cannot be parsed must fail the sync loudly rather than drain
      // the listed addresses and quietly report a partial wallet.
      throw new Error(KEY_PROBLEM_MESSAGES[parsed.problem]);
    }
    key = parsed.key;
  }

  const decoded = decodeCursor(cursor);

  // Resolve the script type once per drain, not once per page: a fresh
  // cursor carries none, every later page carries what this resolved.
  let scriptType: SupportedScriptType | '' = decoded.scriptType;
  if (key !== null && scriptType === '' && cursor === null) {
    scriptType = (await detectScriptType(key, root, signal)) ?? '';
  }

  const wallet = buildWallet(
    key,
    scriptType === '' ? null : scriptType,
    listed,
  );
  if (wallet.ordered.length === 0) {
    return { events: [], cursor: null };
  }

  const stage = nextStageWithWork(wallet, decoded.stage);
  if (stage === null) {
    return { events: [], cursor: null };
  }
  // A skipped stage resets the position: index and gap belong to the stage
  // they were counted in.
  const index = stage === decoded.stage ? decoded.index : 0;
  const gap = stage === decoded.stage ? decoded.gap : 0;
  const lastSeenTxid = stage === decoded.stage ? decoded.lastSeenTxid : '';

  const address = addressAt(wallet, stage, index);
  if (address === null) {
    const after = nextStageWithWork(wallet, stage + 1);
    return {
      events: [],
      cursor: after === null ? null : encodeCursor(scriptType, after, 0, 0, ''),
    };
  }

  const url =
    lastSeenTxid === ''
      ? `${root}/address/${address}/txs`
      : `${root}/address/${address}/txs/chain/${lastSeenTxid}`;

  const page = await fetchJson<EsploraTransaction[]>(
    // Named by POSITION, never by the address or the key itself - whatever
    // this throws is stored verbatim as the source's lastError and rendered
    // on screen.
    url,
    `listing transactions for address ${index + 1} of set ${stage + 1}`,
    {},
    signal,
    'bitcoin',
  );

  const events: DerivedEvent[] = [];
  for (const tx of page) {
    if (!isConfirmedWithDate(tx)) {
      continue;
    }
    if (ownerOf(tx, wallet) !== address) {
      // Owned by an earlier address of this same wallet, which will emit it
      // during its own turn - or by none of them at all.
      continue;
    }
    const legs = legsForTransaction(tx, wallet);
    if (legs.length === 0) {
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

  // Paging is decided from the RAW page length, before the confirmed filter:
  // Esplora's contract is "a page shorter than PAGE_SIZE is the last", which
  // is a fact about what the provider returned rather than about which rows
  // this module chose to emit. Filtering first would see a short page in a
  // burst of mempool activity and declare the address finished.
  if (page.length === PAGE_SIZE) {
    return {
      events,
      cursor: encodeCursor(
        scriptType,
        stage,
        index,
        gap,
        page[page.length - 1].txid,
      ),
    };
  }

  // The address is finished. An address with no history at all widens the
  // gap; one that had any resets it, including when we were paging through
  // it, which is what `lastSeenTxid` distinguishes.
  const untouched = page.length === 0 && lastSeenTxid === '';
  const nextGap = untouched ? gap + 1 : 0;

  if (stage !== LAST_STAGE && nextGap >= GAP_LIMIT) {
    const after = nextStageWithWork(wallet, stage + 1);
    return {
      events,
      cursor: after === null ? null : encodeCursor(scriptType, after, 0, 0, ''),
    };
  }

  const nextIndex = index + 1;
  if (addressAt(wallet, stage, nextIndex) === null) {
    const after = nextStageWithWork(wallet, stage + 1);
    return {
      events,
      cursor: after === null ? null : encodeCursor(scriptType, after, 0, 0, ''),
    };
  }

  return {
    events,
    cursor: encodeCursor(scriptType, stage, nextIndex, nextGap, ''),
  };
};
