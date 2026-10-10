/**
 * A short, stable name for "exactly these ledger events".
 *
 * A printed report and a checkpoint are both derived from the ledger. The
 * fingerprint is what lets a reader tie one to the other: a checkpoint
 * exported from the same ledger carries the same value as the report.
 *
 * It is taken over the facts of each event, not over how this install
 * happens to store it. `id` is a random local row id, `sourceId` names a
 * configured source on THIS device, and `raw` is the provider's payload -
 * none of which change what happened. A restored checkpoint rewrites the
 * first two, so including them would make a faithful restore look like a
 * different ledger.
 */
import type { LedgerEvent } from './types';

const EXCLUDED = new Set(['id', 'sourceId', 'raw']);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, sortKeys(source[key])]),
    );
  }
  return value;
};

export const canonicalEvent = (event: LedgerEvent): Record<string, unknown> => {
  const kept = Object.fromEntries(
    Object.entries(event).filter(([key]) => !EXCLUDED.has(key)),
  );
  return sortKeys(kept) as Record<string, unknown>;
};

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export const fingerprintEvents = async (
  events: LedgerEvent[],
): Promise<string> => {
  const list = events
    .map((event) => canonicalEvent(event))
    .sort(
      (a, b) =>
        compareText(String(a.externalId), String(b.externalId)) ||
        Number(a.timestamp) - Number(b.timestamp) ||
        compareText(String(a.kind), String(b.kind)),
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(list)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
};

export const shortFingerprint = (hex: string): string => hex.slice(0, 12);
