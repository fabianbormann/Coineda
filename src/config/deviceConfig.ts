import type { EgressMode, Endpoints } from './endpoints';

/**
 * The egress mode and endpoint overrides, stored per DEVICE rather than per
 * client.
 *
 * They used to live in each client's settings row, which let two things
 * reopen egress that an operator had closed: a review client (whose
 * settings come from somebody else's checkpoint) carried its own mode, and
 * a settings read that failed fell back to the public default. Which hosts
 * this installation may contact is a property of the installation, so it
 * lives in localStorage beside the client registry, read synchronously and
 * the same for every client.
 *
 * Precedence is applied by src/config/endpoints.ts: a build's
 * `VITE_EGRESS=restricted` beats the device mode, and a build's
 * `VITE_ENDPOINTS` beats the device endpoints, which beat the public
 * defaults.
 */
export const EGRESS_KEY = 'coineda.egress';
export const ENDPOINTS_KEY = 'coineda.endpoints';

// In-memory fallback for when localStorage throws (private mode), the same
// arrangement as the client registry (src/clients/registry.ts).
const memory = new Map<string, string>();

const readRaw = (key: string): string | null => {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) memory.set(key, value);
    return value;
  } catch {
    return memory.get(key) ?? null;
  }
};

const writeRaw = (key: string, value: string): void => {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // kept in memory only
  }
};

const parse = (raw: string | null): unknown => {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The device's own mode: 'restricted' only when exactly that is stored. */
export const readDeviceEgress = (): EgressMode =>
  parse(readRaw(EGRESS_KEY)) === 'restricted' ? 'restricted' : 'public';

export const writeDeviceEgress = (mode: EgressMode): void =>
  writeRaw(EGRESS_KEY, JSON.stringify(mode));

/**
 * The device's endpoint overrides: string values only, unknown keys kept
 * out by `resolveEndpoints`, which also trims them and ignores blanks.
 */
export const readDeviceEndpoints = (): Partial<Endpoints> => {
  const value = parse(readRaw(ENDPOINTS_KEY));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result as Partial<Endpoints>;
};

/**
 * REPLACES the stored overrides with `partial`: a field left out returns
 * to its default. A settings form writes its whole set of fields at once,
 * so clearing one is simply not including it.
 */
export const writeDeviceEndpoints = (partial: Partial<Endpoints>): void =>
  writeRaw(ENDPOINTS_KEY, JSON.stringify(partial));
