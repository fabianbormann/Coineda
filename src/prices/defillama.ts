import Big from 'big.js';
import { COINGECKO_IDS } from './coingecko';

/**
 * DefiLlama's coins API (https://coins.llama.fi), as the historical price
 * source for days CoinGecko's free tier refuses.
 *
 * Measured live on 2026-10-05, and four facts chose it over the
 * alternatives:
 *
 * - **Keyless, and a browser may call it.** It answers with an
 *   `access-control-allow-origin` header and asks for no credential at all.
 *   CryptoCompare now returns 401 without a key, CoinCap no longer resolves,
 *   CoinPaprika answers 402 for history, and Kraken's OHLC serves only its
 *   last ~720 candles.
 * - **It goes back to at least 2015.** BTC on 2015-06-01 comes back as
 *   223.32, which is right. CoinGecko's free tier stops at 365 days.
 * - **It speaks CoinGecko's own ids**, as `coingecko:<id>`, so this module
 *   reuses COINGECKO_IDS rather than introducing a second asset mapping
 *   that could drift from the first.
 * - **One request covers many assets AND many days.** `batchHistorical`
 *   takes a map of coin to timestamps. The CoinGecko path already had to be
 *   rewritten once because one-request-per-day drew a 429 with no CORS
 *   header, which the browser could only report as "Failed to fetch"; this
 *   takes the whole report in a single call.
 *
 * What it does NOT do is quote anything but USD, which is why src/prices/ecb.ts
 * exists beside it.
 */
const BATCH_URL = 'https://coins.llama.fi/batchHistorical';

const TIMEOUT_MS = 20_000;

/** The DefiLlama key for a ledger asset, or null when this app has no id
 *  for it. Deliberately derived from COINGECKO_IDS - one asset map, not two. */
export const defillamaCoin = (assetId: string): string | null => {
  const coinId = COINGECKO_IDS[assetId];
  return coinId ? `coingecko:${coinId}` : null;
};

/**
 * How far a returned point may sit from the day it is meant to represent.
 *
 * Twelve hours, the same rule the CoinGecko path applies, and for the same
 * reason: this endpoint returns the NEAREST observation rather than a daily
 * close, so a day the provider has no data for comes back as a neighbouring
 * day's price instead of as a gap. Measured drift across 2016-2024 was
 * under an hour, so this rejects nothing real - it is there for the
 * illiquid asset where the nearest point is a week away, which would
 * otherwise be a confidently wrong number in a tax report.
 */
export const NEAREST_LIMIT_MS = 12 * 3_600_000;

export const utcMidnight = (isoDate: string): number => {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`expected an ISO date (YYYY-MM-DD) but got '${isoDate}'`);
  }
  return parsed;
};

export class DefiLlamaError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`DefiLlama answered with status ${status}`);
    this.name = 'DefiLlamaError';
    this.status = status;
  }
}

type Point = { timestamp?: unknown; price?: unknown };

/** `assetId|YYYY-MM-DD`, the same pair key resolveValues uses. */
export const pairKey = (assetId: string, date: string): string =>
  `${assetId}|${date}`;

/**
 * USD prices for every (asset, day) asked for, in ONE request.
 *
 * Assets this app has no id for are left out of the request entirely and
 * are simply absent from the result - the caller reports them, the same
 * rule fetchSpotPrices and fetchHistoricalPrices already follow.
 *
 * Throws DefiLlamaError on a non-ok response so a caller can fall back
 * rather than treat an outage as "no price exists".
 */
export const fetchUsdHistory = async (
  wanted: Map<string, string[]>,
  signal?: AbortSignal,
): Promise<Map<string, string>> => {
  const prices = new Map<string, string>();

  // Timestamps are requested in seconds, and the day each one belongs to is
  // remembered here so the response can be matched back without re-deriving
  // it from a timestamp the provider may have moved.
  const coins: Record<string, number[]> = {};
  const dayOf = new Map<string, string>(); // `coin|seconds` -> isoDate
  const assetOf = new Map<string, string>(); // coin -> assetId

  for (const [assetId, dates] of wanted) {
    const coin = defillamaCoin(assetId);
    if (coin === null) {
      continue;
    }
    assetOf.set(coin, assetId);
    const seconds = coins[coin] ?? [];
    for (const date of [...new Set(dates)]) {
      const at = Math.floor(utcMidnight(date) / 1000);
      seconds.push(at);
      dayOf.set(`${coin}|${at}`, date);
    }
    coins[coin] = seconds;
  }

  if (Object.keys(coins).length === 0) {
    return prices;
  }

  const url = `${BATCH_URL}?coins=${encodeURIComponent(JSON.stringify(coins))}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new DefiLlamaError(response.status);
  }

  const body = (await response.json()) as {
    coins?: Record<string, { prices?: Point[] }>;
  };

  for (const [coin, entry] of Object.entries(body.coins ?? {})) {
    const assetId = assetOf.get(coin);
    if (assetId === undefined) {
      continue;
    }
    for (const point of entry.prices ?? []) {
      if (
        typeof point.timestamp !== 'number' ||
        typeof point.price !== 'number'
      ) {
        continue;
      }
      // Matched back to the NEAREST timestamp that was asked for, not to
      // the one returned: the provider moves it to its nearest observation,
      // so the returned value is not a key into anything. Nearest rather
      // than first-within-range, because two requested days could both sit
      // inside the window and the closer one is the right owner.
      const at = point.timestamp;
      let best: number | null = null;
      for (const requested of coins[coin] ?? []) {
        const gap = Math.abs(at - requested);
        if (gap > NEAREST_LIMIT_MS / 1000) {
          continue;
        }
        if (best === null || gap < Math.abs(at - best)) {
          best = requested;
        }
      }
      if (best === null) {
        continue;
      }
      const date = dayOf.get(`${coin}|${best}`);
      if (date === undefined) {
        continue;
      }
      // Through Big and via the number's own string form. The value arrived
      // as a JSON number and is already a float; this keeps it from picking
      // up any FURTHER error on the way into the ledger's decimal strings.
      prices.set(
        pairKey(assetId, date),
        new Big(String(point.price)).toString(),
      );
    }
  }

  return prices;
};
