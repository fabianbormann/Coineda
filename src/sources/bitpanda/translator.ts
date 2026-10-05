import Big from 'big.js';
import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import type { Leg } from '@/ledger/types';
import { REQUEST_TIMEOUT_MS, errorName, signalFor } from '@/sources/http';
import { assetIdForSymbol, baseUnits } from './assets';

/**
 * Bitpanda's REST API, v1.
 *
 * Measured live on 2026-10-05, and these are the facts that shape
 * everything below:
 *
 * - Auth is ONE header, `x-api-key`. No signature, no timestamp, no
 *   passphrase - which is why this is the exchange Coineda can reach first.
 *   A CORS preflight against a private endpoint returns 200 with
 *   `x-api-key` explicitly allowed, so a browser can call it, unlike
 *   Binance, Coinbase or Kraken.
 * - **Bitpanda is behind Cloudflare.** A request without a browser-like
 *   User-Agent is refused with `error code: 1010` BEFORE auth is
 *   considered. The app is a browser and sends its own, so this does not
 *   affect a sync - but anything under Node hits it, and the failure reads
 *   like a credential problem when it is not. isCloudflareBlock says so.
 *
 * **The drain reads /wallets/transactions, NOT /trades.** That choice is
 * the whole correctness story of this module, so it is worth stating why.
 *
 * /trades lists only trades. Reconstructing a balance from trades alone is
 * correct only for an account nobody ever withdraws from, and it fails
 * silently rather than loudly: against the owner's own account, 7 BTC buys
 * totalling 0.05068845 BTC were all visible while the five withdrawals that
 * moved every satoshi of it out were not, so Coineda reported a phantom
 * 0.0507 BTC - about EUR 3,900 - at an exchange whose real BTC balance is
 * 0.00000000.
 *
 * /wallets/transactions is a strict superset. Measured on that same
 * account: 20 rows, being the same 12 trades (each row EMBEDDING its whole
 * trade object, so nothing is lost) plus the 8 standalone withdrawals. With
 * the per-row `fee` charged as its own leg, `in - out - fee` lands on the
 * balance Bitpanda itself reports, exactly, to all 8 decimals, for every one
 * of BTC, ETH, ADA and NIGHT.
 *
 * It also needs no extra permission: the owner's read key returns 401 for
 * /transactions and /masterdata but 200 for /wallets/transactions, so this
 * route is reachable with the narrower scope set a user is likely to grant.
 *
 * One measured residual, so it is not later mistaken for a defect. BTC, ETH
 * and NIGHT reconcile to the digit; ADA lands 1 lovelace (0.000001 ADA,
 * about EUR 0.00000024) above what Bitpanda reports. The cause is that
 * Bitpanda quotes ADA to 8 decimals while Cardano has 6, so `baseUnits`
 * rounds each row to the nearest lovelace and three buys each rounded up by
 * a fraction. Nothing on chain can hold a fraction of a lovelace, so some
 * rounding is unavoidable here; the choice worth knowing is that it is
 * round-half-up per row rather than truncation, which would bias the other
 * way and never over-report.
 */
const API_ROOT = 'https://api.bitpanda.com/v1';

/** Bitpanda's own page size cap; the drain asks for the largest page it
 *  allows, because an exchange history is long and each page is a request. */
const PAGE_SIZE = 500;

export const BITPANDA_MESSAGES = {
  missingKey: 'Add your Bitpanda API key.',
  rejectedKey:
    'Bitpanda rejected this API key. Check that it is correct and that it has not expired.',
  cloudflare:
    'Bitpanda refused the request before checking the key. This is its bot protection rather than anything wrong with your key - trying again later usually works.',
  unreachable: 'Could not reach Bitpanda. It may be unavailable right now.',
} as const;

export const configuredKey = (config: Record<string, string>): string =>
  (config.apiKey ?? '').trim();

const headersFor = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  Accept: 'application/json',
});

/**
 * Cloudflare's block is an HTML-ish body carrying `error code: 1010`, on a
 * 403 - not Bitpanda's own JSON error envelope. Telling them apart matters
 * because the user's action is completely different: one means check your
 * key, the other means wait.
 */
export const isCloudflareBlock = (status: number, body: string): boolean =>
  status === 403 && /error code:\s*10\d\d/i.test(body);

type Fetched = { status: number; body: string };

const request = async (
  path: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Fetched> => {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: headersFor(apiKey),
    signal: signalFor(signal),
  });
  return { status: response.status, body: await response.text() };
};

/** Parses a response body, naming what arrived when it is not JSON at all -
 *  which is what a Cloudflare interstitial looks like. */
const asJson = (fetched: Fetched, what: string): unknown => {
  try {
    return JSON.parse(fetched.body);
  } catch {
    throw new Error(
      `bitpanda: ${what} did not return JSON (HTTP ${fetched.status}): ${fetched.body.slice(0, 120)}`,
    );
  }
};

/** The one route the drain depends on, so the one route the probe tests. */
const MOVEMENTS = '/wallets/transactions';

export const probe = async (
  config: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResult> => {
  const apiKey = configuredKey(config);
  if (apiKey === '') {
    return { ok: false, message: BITPANDA_MESSAGES.missingKey };
  }

  let fetched: Fetched;
  try {
    // The route the drain itself depends on, never a liveness route: an
    // endpoint that merely answers says nothing about whether this key can
    // read what the sync reads. This matters more here than anywhere else
    // in this module - the previous version probed /trades while the key
    // that mattered was the one for movements, and a key that could see
    // buys but not withdrawals would have probed perfectly green while
    // reporting holdings that were not there.
    fetched = await request(`${MOVEMENTS}?page_size=1`, apiKey, signal);
  } catch (error) {
    if (errorName(error) === 'TimeoutError') {
      return { ok: false, message: BITPANDA_MESSAGES.unreachable };
    }
    return { ok: false, message: BITPANDA_MESSAGES.unreachable };
  }

  if (isCloudflareBlock(fetched.status, fetched.body)) {
    return { ok: false, message: BITPANDA_MESSAGES.cloudflare };
  }
  if (fetched.status === 401 || fetched.status === 403) {
    // Takes the status only, never the key - whatever this returns is
    // stored as the source's lastError and rendered on screen.
    return { ok: false, message: BITPANDA_MESSAGES.rejectedKey };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return { ok: false, message: BITPANDA_MESSAGES.unreachable };
  }

  // `readOnly` is deliberately left undefined. Bitpanda states a key's
  // scopes at creation and this response does not report them back, so the
  // honest answer is "no way to tell" - which the Add dialog already
  // handles, and already has a test for.
  return { ok: true };
};

type TradeAttributes = {
  amount_fiat?: unknown;
  fiat_to_eur_rate?: unknown;
};

type MovementRow = {
  id?: unknown;
  attributes?: Record<string, unknown>;
};

const str = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

/** True for an amount that is present and greater than zero. Bitpanda sends
 *  '0.00000000' for the fee on every row that has none, so this is what
 *  keeps a zero-amount fee leg - a tax event with nothing in it - out of
 *  the ledger. */
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

/**
 * One wallet-transaction row to one ledger event.
 *
 * A row is one of two things, and the embedded `trade` object is what tells
 * them apart:
 *
 * - **Trade-linked** - the crypto side of a buy or sell. Emitted as a
 *   `trade` with its fiat counter-leg, which is what the tax engine matches
 *   a disposal against. The euro figure comes from the embedded trade's
 *   `amount_fiat`, which is HISTORICAL: measured against the owner's NIGHT
 *   buy, it reads 200.00 - the euro that actually left the fiat wallet in
 *   December 2025 - and not the roughly 86 that quantity is worth now. A
 *   current-value field here would have put today's mark into a cost basis.
 * - **Standalone** - a deposit or a withdrawal. Emitted as a `transfer`,
 *   with the network fee as its own `fee` leg.
 *
 * Every field is read defensively and, when something is missing, the error
 * names the keys the row actually carried.
 */
export const movementToEvent = (
  row: MovementRow,
): DerivedEvent | { unsupported: string } | { skipped: string } => {
  const attributes = row.attributes ?? {};
  const seen = Object.keys(attributes).join(', ') || '(none)';

  const externalId = str(row.id);
  const direction = str(attributes.in_or_out); // 'incoming' | 'outgoing'
  const amount = str(attributes.amount);
  const symbol = str(attributes.cryptocoin_symbol);
  const time = attributes.time as { unix?: unknown; date_iso8601?: unknown };
  const unix = str(time?.unix);
  const iso = str(time?.date_iso8601);

  if (
    externalId === null ||
    direction === null ||
    amount === null ||
    symbol === null ||
    (unix === null && iso === null)
  ) {
    throw new Error(
      `bitpanda: a wallet transaction is missing fields this parser needs. It carried: ${seen}`,
    );
  }

  // Only a settled movement is a movement. A pending or cancelled row would
  // otherwise be recorded as though it had happened, which is a holding the
  // user does not have or a disposal they never made.
  const status = str(attributes.status);
  if (status !== null && status.toLowerCase() !== 'finished') {
    return { skipped: `${externalId} is ${status}` };
  }

  const assetId = assetIdForSymbol(symbol);
  if (assetId === null) {
    // Bitpanda sells gold, silver and a long tail of coins. Reporting the
    // holding as unsupported is the honest answer; guessing an asset id
    // merges two different positions into one.
    return { unsupported: symbol };
  }

  const timestamp = unix !== null ? Number(unix) * 1000 : Date.parse(iso!);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `bitpanda: a wallet transaction carried an unreadable time: ${JSON.stringify(attributes.time)}`,
    );
  }

  const incoming = direction.toLowerCase() === 'incoming';
  const legs: Leg[] = [
    {
      assetId,
      amount: baseUnits(amount, assetId),
      direction: incoming ? 'in' : 'out',
      venue: 'bitpanda',
      role: 'principal',
    },
  ];

  const trade = attributes.trade as
    { attributes?: TradeAttributes } | undefined;
  const tradeAttributes = trade?.attributes;

  if (tradeAttributes !== undefined) {
    // The fiat side is what makes this a trade rather than a transfer.
    //
    // The row carries no fiat SYMBOL, only a numeric `fiat_id` that would
    // need masterdata to resolve - which a read-scoped key cannot read; it
    // answers 401. What it does carry is `fiat_to_eur_rate`, so a rate of
    // exactly 1 identifies the fiat as euro without resolving anything. Any
    // other rate means some other currency, and inventing a name for it
    // would put a figure in the wrong denomination into a tax report, so
    // the leg is left off and the crypto side still recorded.
    //
    // No separate fee leg for a trade. Bitpanda's trade fee is already
    // inside `amount_fiat`: on the owner's NIGHT buy, amount_fiat is 200.00
    // and the fiat wallet shows exactly 200.00 leaving, while the quoted
    // price times the quantity comes to 199.94. The disclosed
    // `fee_amount_in_fiat` of 5.09 is the spread markup described
    // after the fact, not an additional charge - adding it as a leg would
    // overstate the cost basis by its whole value.
    const fiatAmount = str(tradeAttributes.amount_fiat);
    const eurRate = str(tradeAttributes.fiat_to_eur_rate);
    const isEuro = eurRate !== null && Number(eurRate) === 1;
    if (fiatAmount !== null && isEuro) {
      legs.push({
        assetId: 'fiat:eur',
        amount: baseUnits(fiatAmount, 'fiat:eur'),
        direction: incoming ? 'out' : 'in',
        venue: 'bitpanda',
        role: 'principal',
      });
    }

    return { externalId, timestamp, kind: 'trade', origin: 'derived', legs };
  }

  // A standalone movement. The network fee is charged as its own leg rather
  // than folded into the principal: it is what reconciles this module's
  // arithmetic to Bitpanda's own reported balance (the five BTC withdrawals
  // carry 0.000039 each, which is the whole 0.000195 that otherwise went
  // missing), and the tax engine deliberately keeps fee legs out of its
  // internal-transfer test while still charging them to holdings.
  const fee = str(attributes.fee);
  if (isPositive(fee)) {
    legs.push({
      assetId,
      amount: baseUnits(fee!, assetId),
      direction: 'out',
      venue: 'bitpanda',
      role: 'fee',
    });
  }

  // Provenance only, never parsed: `tx_id` is the on-chain hash of this
  // withdrawal, which is how a later pass can recognise that a withdrawal
  // and an arrival in the user's own wallet are two sides of one move
  // rather than a disposal followed by an acquisition.
  const txId = str(attributes.tx_id);
  const recipient = str(attributes.recipient);
  const note =
    txId !== null && txId !== ''
      ? `${incoming ? 'Deposit' : 'Withdrawal'} ${txId}${
          recipient !== null && recipient !== '' ? ` to ${recipient}` : ''
        }`
      : undefined;

  return {
    externalId,
    timestamp,
    kind: 'transfer',
    origin: 'derived',
    legs,
    ...(note === undefined ? {} : { note }),
  };
};

export const encodeCursor = (page: number): string => `bitpanda:${page}`;

export const decodeCursor = (cursor: string | null): number => {
  if (cursor === null) {
    return 1;
  }
  const match = /^bitpanda:(\d+)$/.exec(cursor);
  // Anything unrecognised starts over rather than guessing, the same choice
  // every other module here makes.
  return match ? Number.parseInt(match[1], 10) : 1;
};

export const fetchEvents = async (
  config: Record<string, string>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<FetchPage> => {
  const apiKey = configuredKey(config);
  if (apiKey === '') {
    throw new Error(BITPANDA_MESSAGES.missingKey);
  }

  const page = decodeCursor(cursor);

  const fetched = await request(
    `${MOVEMENTS}?page=${page}&page_size=${PAGE_SIZE}`,
    apiKey,
    signal,
  );
  if (isCloudflareBlock(fetched.status, fetched.body)) {
    throw new Error(BITPANDA_MESSAGES.cloudflare);
  }
  if (fetched.status === 401 || fetched.status === 403) {
    throw new Error(BITPANDA_MESSAGES.rejectedKey);
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new Error(
      `bitpanda: listing wallet transactions failed with status ${fetched.status}`,
    );
  }

  const body = asJson(fetched, 'the wallet transaction list') as {
    data?: unknown;
    links?: { next?: unknown };
  };
  if (!Array.isArray(body.data)) {
    throw new Error(
      `bitpanda: expected a list of wallet transactions under "data" but the response carried: ${Object.keys(
        body ?? {},
      ).join(', ')}`,
    );
  }

  const events: DerivedEvent[] = [];
  for (const row of body.data as MovementRow[]) {
    const result = movementToEvent(row);
    // An asset this app cannot name, or a movement that never settled, is
    // passed over rather than failed: one of either must not cost the user
    // every other row in the account.
    if ('unsupported' in result || 'skipped' in result) {
      continue;
    }
    events.push(result);
  }

  // Paging stops on the provider's own say-so where it offers one, and on a
  // short page otherwise.
  const hasNext =
    typeof body.links?.next === 'string' && body.links.next !== '';
  const more = hasNext || body.data.length === PAGE_SIZE;

  return { events, cursor: more ? encodeCursor(page + 1) : null };
};

export { REQUEST_TIMEOUT_MS };
