import type { DerivedEvent, FetchPage, ProbeResult } from '@/sources/types';
import type { Leg } from '@/ledger/types';
import { REQUEST_TIMEOUT_MS, errorName, signalFor } from '@/sources/http';
import { assetIdForSymbol, baseUnits } from './assets';

/**
 * Bitpanda's REST API, v1.
 *
 * Measured live on 2026-10-04, and these are the two facts that shape
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
 *   affect a sync - but anything under Node hits it, including
 *   scripts/record-fixtures.ts, and the failure reads like a credential
 *   problem when it is not. isCloudflareBlock below exists to say so.
 *
 * What is NOT verified: the payload shape. Everything here was written
 * against a 401 and Bitpanda's documentation, never against a real
 * response, so the parsers below report what they actually received rather
 * than failing vaguely - the first run against a real key is meant to
 * produce a precise bug report, not a shrug.
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
    // read what the sync reads. Same rule the Cardano probe was rewritten
    // for.
    fetched = await request(`/trades?page_size=1`, apiKey, signal);
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

type TradeRow = {
  id?: unknown;
  attributes?: Record<string, unknown>;
};

const str = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

/**
 * One trade row to one ledger event.
 *
 * Every field it needs is read defensively and, when something is missing,
 * the error names the keys the row actually carried. The payload shape was
 * never verified against a real response, so this is the difference between
 * a first run that tells us exactly what Bitpanda sends and one that says
 * "undefined is not an object".
 */
export const tradeToEvent = (
  row: TradeRow,
): DerivedEvent | { unsupported: string } | { skipped: string } => {
  const attributes = row.attributes ?? {};
  const seen = Object.keys(attributes).join(', ') || '(none)';

  const externalId = str(row.id);
  const direction = str(attributes.type); // 'buy' | 'sell'
  const cryptoAmount = str(attributes.amount_cryptocoin);
  const fiatAmount = str(attributes.amount_fiat);
  // The row names its own asset, so there is no id to resolve. An earlier
  // version looked this up through /v1/masterdata, which a read-scoped key
  // cannot reach - it answers 401 - so that version could not have drained
  // anything at all.
  const symbol = str(attributes.cryptocoin_symbol);
  const time = attributes.time as { unix?: unknown; date_iso8601?: unknown };
  const unix = str(time?.unix);
  const iso = str(time?.date_iso8601);

  if (
    externalId === null ||
    direction === null ||
    cryptoAmount === null ||
    symbol === null ||
    (unix === null && iso === null)
  ) {
    throw new Error(
      `bitpanda: a trade row is missing fields this parser needs. It carried: ${seen}`,
    );
  }

  // Only a settled trade is a movement. A pending or cancelled row would
  // otherwise be recorded as though it had happened, which is a holding the
  // user does not have and a disposal they never made.
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
      `bitpanda: a trade row carried an unreadable time: ${JSON.stringify(attributes.time)}`,
    );
  }

  const bought = direction.toLowerCase() === 'buy';
  const legs: Leg[] = [
    {
      assetId,
      amount: baseUnits(cryptoAmount, assetId),
      direction: bought ? 'in' : 'out',
      venue: 'bitpanda',
      role: 'principal',
    },
  ];

  // The fiat side is what makes this a trade rather than a transfer, and
  // what the tax engine matches a disposal against.
  //
  // The row carries no fiat SYMBOL, only a numeric `fiat_id` that would need
  // masterdata to resolve - which a read-scoped key cannot read. What it does
  // carry is `fiat_to_eur_rate`, so a rate of exactly 1 identifies the fiat
  // as euro without resolving anything. Any other rate means some other
  // currency, and inventing a name for it would put a figure in the wrong
  // denomination into a tax report, so the leg is left off and the crypto
  // side still recorded.
  const eurRate = str(attributes.fiat_to_eur_rate);
  const isEuro = eurRate !== null && Number(eurRate) === 1;
  if (fiatAmount !== null && isEuro) {
    legs.push({
      assetId: 'fiat:eur',
      amount: baseUnits(fiatAmount, 'fiat:eur'),
      direction: bought ? 'out' : 'in',
      venue: 'bitpanda',
      role: 'principal',
    });
  }

  return {
    externalId,
    timestamp,
    kind: 'trade',
    origin: 'derived',
    legs,
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
    `/trades?page=${page}&page_size=${PAGE_SIZE}`,
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
      `bitpanda: listing trades failed with status ${fetched.status}`,
    );
  }

  const body = asJson(fetched, 'the trade list') as {
    data?: unknown;
    links?: { next?: unknown };
  };
  if (!Array.isArray(body.data)) {
    throw new Error(
      `bitpanda: expected a list of trades under "data" but the response carried: ${Object.keys(
        body ?? {},
      ).join(', ')}`,
    );
  }

  const events: DerivedEvent[] = [];
  for (const row of body.data as TradeRow[]) {
    const result = tradeToEvent(row);
    // An asset this app cannot name, or a trade that never settled, is
    // passed over rather than failed: one of either must not cost the user
    // every other trade in the account.
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
