import type { Settings } from '@/settings/settingsStore';

/**
 * Every outbound host the app talks to, in one place.
 *
 * Each value is a BASE URL without a trailing slash; the module that calls
 * it appends its own route (DefiLlama `/batchHistorical`, CoinGecko
 * `/simple/price` and `/coins/...`, Frankfurter `/<start>..<end>`, the token
 * registry `/query`, each chain API's own paths). Keeping the routes in the
 * callers and only the base here is what lets an operator point a field at a
 * mirror or an in-house service that implements the same contract.
 *
 * Resolution, lowest to highest precedence:
 *   1. PUBLIC_ENDPOINTS - today's public hosts, verbatim;
 *   2. `import.meta.env.VITE_ENDPOINTS` - a JSON object fixed at build time;
 *   3. `Settings.endpoints` - per-client overrides at runtime.
 * With neither 2 nor 3 set, behaviour is byte-identical to the constants
 * this replaced.
 */
export type Endpoints = {
  priceHistory: string;
  spotPrices: string;
  fx: string;
  tokenRegistry: string;
  bitcoinEsplora: string;
  ethereumBlockscout: string;
  cardanoYaci: string;
  cardanoBlockfrost: string;
  /** Not self-hostable (a hosted exchange API), but its host still lives
   *  here so this file is the single list of outbound hosts. */
  bitpanda: string;
};

export type EgressMode = 'public' | 'restricted';

export const PUBLIC_ENDPOINTS: Endpoints = Object.freeze({
  priceHistory: 'https://coins.llama.fi',
  spotPrices: 'https://api.coingecko.com/api/v3',
  fx: 'https://api.frankfurter.dev/v1',
  tokenRegistry: 'https://tokens.cardano.org/metadata',
  bitcoinEsplora: 'https://blockstream.info/api',
  ethereumBlockscout: 'https://eth.blockscout.com',
  cardanoYaci: 'https://yaci-store.mainnet.colo2.cf-systems.org',
  cardanoBlockfrost: 'https://cardano-mainnet.blockfrost.io',
  bitpanda: 'https://api.bitpanda.com/v1',
});

const KEYS = Object.keys(PUBLIC_ENDPOINTS) as (keyof Endpoints)[];

/** Trimmed, trailing slashes stripped, so callers can own the leading `/`
 *  of their routes without producing `//`. */
const normalise = (value: string): string => value.trim().replace(/\/+$/, '');

/** Copies only known keys with string values, normalised. Anything else in
 *  the input is ignored rather than trusted - including a value that is
 *  empty after normalisation: `''` would turn every fetch into a relative
 *  request against the app's own origin, so a cleared field keeps the
 *  default instead. */
const overlay = (base: Endpoints, partial: unknown): Endpoints => {
  const result = { ...base };
  if (partial === null || typeof partial !== 'object') {
    return result;
  }
  const record = partial as Record<string, unknown>;
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const normalised = normalise(value);
    if (normalised !== '') {
      result[key] = normalised;
    }
  }
  return result;
};

const parseEnv = (raw: string | undefined): Endpoints => {
  if (raw === undefined || raw.trim() === '') {
    return { ...PUBLIC_ENDPOINTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      'VITE_ENDPOINTS is not valid JSON; using the public endpoints.',
      error,
    );
    return { ...PUBLIC_ENDPOINTS };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      'VITE_ENDPOINTS must be a JSON object; using the public endpoints.',
    );
    return { ...PUBLIC_ENDPOINTS };
  }
  return overlay(PUBLIC_ENDPOINTS, parsed);
};

/** The last parse, keyed by the raw env string: the value is fixed at build
 *  time, so it is parsed (and a malformed one warned about) once. Keyed
 *  rather than a plain flag so `vi.stubEnv` in tests still takes effect. */
let memo: { raw: string | undefined; endpoints: Endpoints } | null = null;

/** PUBLIC_ENDPOINTS overlaid by the build's VITE_ENDPOINTS. A malformed
 *  value warns once and falls back to the public set rather than breaking
 *  the app at boot. Returns a fresh copy each call. */
export const defaultEndpoints = (): Endpoints => {
  const raw = import.meta.env.VITE_ENDPOINTS;
  if (memo === null || memo.raw !== raw) {
    memo = { raw, endpoints: parseEnv(raw) };
  }
  return { ...memo.endpoints };
};

/** The defaults overlaid by the client's own `Settings.endpoints`. */
export const resolveEndpoints = (
  settings?: Pick<Settings, 'endpoints'> | null,
): Endpoints => overlay(defaultEndpoints(), settings?.endpoints);

/**
 * A build pinned `VITE_EGRESS=restricted` stays restricted whatever the
 * setting says - an operator's guarantee must not be loosened by a user.
 * Otherwise the setting applies, and the default is 'public'.
 */
export const egressMode = (
  settings?: Pick<Settings, 'egress'> | null,
): EgressMode => {
  if (import.meta.env.VITE_EGRESS?.trim() === 'restricted') {
    return 'restricted';
  }
  return settings?.egress === 'restricted' ? 'restricted' : 'public';
};

/**
 * Whether `key` points somewhere an operator chose, rather than at the
 * public default. In restricted mode a public default counts as "not
 * configured": the build (or the user) has not named a service for it.
 */
export const isConfigured = (
  endpoints: Endpoints,
  key: keyof Endpoints,
): boolean => {
  const value = normalise(endpoints[key] ?? '');
  return value !== '' && value !== PUBLIC_ENDPOINTS[key];
};

/** The hosts (`host`, port included) the endpoints point at. In restricted
 *  mode only configured (non-public) endpoints count; in public mode every
 *  one does. Empty or unparsable values contribute nothing. */
export const allowedHosts = (
  endpoints: Endpoints,
  mode: EgressMode = 'public',
): Set<string> => {
  const hosts = new Set<string>();
  for (const key of KEYS) {
    const value = endpoints[key];
    if (!value) {
      continue;
    }
    if (mode === 'restricted' && !isConfigured(endpoints, key)) {
      continue;
    }
    try {
      hosts.add(new URL(value).host);
    } catch {
      // Not a URL: nothing to allow.
    }
  }
  return hosts;
};
