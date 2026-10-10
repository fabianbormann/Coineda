import { readDeviceEgress, readDeviceEndpoints } from './deviceConfig';

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
 *   2. the device's overrides (src/config/deviceConfig.ts), at runtime;
 *   3. `import.meta.env.VITE_ENDPOINTS` - a JSON object fixed at build time,
 *      which wins: an operator's build is not loosened from a settings card.
 * A build pinned `VITE_EGRESS=restricted` drops layer 2 entirely: only the
 * operator's VITE_ENDPOINTS and the public defaults (which restricted mode
 * treats as unconfigured) remain, so nothing stored on the device can add a
 * host the operator did not name.
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

/** The build's VITE_ENDPOINTS, parsed but not yet overlaid. Unset gives
 *  `{}`; malformed warns and gives `{}` too, so the public set (and the
 *  device's overrides) stay in force rather than the app breaking at boot. */
const parseEnv = (raw: string | undefined): object => {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      'VITE_ENDPOINTS is not valid JSON; using the public endpoints.',
      error,
    );
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      'VITE_ENDPOINTS must be a JSON object; using the public endpoints.',
    );
    return {};
  }
  return parsed;
};

/** The last parse, keyed by the raw env string: the value is fixed at build
 *  time, so it is parsed (and a malformed one warned about) once. Keyed
 *  rather than a plain flag so `vi.stubEnv` in tests still takes effect. */
let memo: { raw: string | undefined; parsed: object } | null = null;

/** The build's VITE_ENDPOINTS as an object (`{}` when unset or invalid). */
const envOverrides = (): object => {
  const raw = import.meta.env.VITE_ENDPOINTS;
  if (memo === null || memo.raw !== raw) {
    memo = { raw, parsed: parseEnv(raw) };
  }
  return memo.parsed;
};

/** PUBLIC_ENDPOINTS overlaid by the build's VITE_ENDPOINTS. A malformed
 *  value warns once and falls back to the public set rather than breaking
 *  the app at boot. Returns a fresh copy each call. */
export const defaultEndpoints = (): Endpoints =>
  overlay(PUBLIC_ENDPOINTS, envOverrides());

/** Whether the build pins `VITE_EGRESS=restricted` (vite.config.ts refuses
 *  any value but `public`, `restricted` or unset, so no case variant ships). */
export const buildPinsRestricted = (): boolean =>
  import.meta.env.VITE_EGRESS?.trim() === 'restricted';

/**
 * The endpoints in force: the public defaults, overlaid by the device's
 * overrides, overlaid by the build's VITE_ENDPOINTS. `device` defaults to
 * what this device stores; tests pass it explicitly. In a build pinned
 * restricted the device layer is ignored entirely (whatever is passed or
 * stored): an operator's build names every host it may contact.
 */
export const resolveEndpoints = (device?: Partial<Endpoints>): Endpoints => {
  if (buildPinsRestricted()) {
    return defaultEndpoints();
  }
  return overlay(
    overlay(PUBLIC_ENDPOINTS, device ?? readDeviceEndpoints()),
    envOverrides(),
  );
};

/**
 * A build pinned `VITE_EGRESS=restricted` stays restricted whatever the
 * device says - an operator's guarantee must not be loosened by a user.
 * Otherwise the device's mode applies (src/config/deviceConfig.ts), and the
 * default is 'public'. It is the same for every client on the device, a
 * review client included. `device` defaults to the stored mode; tests pass
 * it explicitly.
 */
export const egressMode = (
  device: EgressMode = readDeviceEgress(),
): EgressMode => {
  if (buildPinsRestricted()) {
    return 'restricted';
  }
  return device === 'restricted' ? 'restricted' : 'public';
};

/** A base URL in comparable form: scheme and host lower-cased and a
 *  default port dropped (both by `URL`), trailing slashes stripped. An
 *  unparsable value is only trimmed and stripped. */
const canonical = (value: string): string => {
  const trimmed = normalise(value);
  try {
    const url = new URL(trimmed);
    return normalise(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return trimmed;
  }
};

/**
 * Whether `key` points somewhere an operator chose, rather than at the
 * public default. In restricted mode a public default counts as "not
 * configured": the build (or the user) has not named a service for it.
 * Compared in canonical form, so an upper-case host, a default port or a
 * trailing slash on a public default is still the public default, not an
 * operator's choice.
 */
export const isConfigured = (
  endpoints: Endpoints,
  key: keyof Endpoints,
): boolean => {
  const value = normalise(endpoints[key] ?? '');
  return value !== '' && canonical(value) !== canonical(PUBLIC_ENDPOINTS[key]);
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
