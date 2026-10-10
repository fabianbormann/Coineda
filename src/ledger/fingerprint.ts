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
 *
 * `note` IS included, on purpose: it is part of the recorded event, not of
 * how it is stored. The cost is that a re-derivation which only rewords
 * notes changes the fingerprint - the conservative reading, since a
 * fingerprint that stayed put while recorded text changed would claim two
 * different records were the same.
 */
import type { ManualTransferLink } from './manualLinks';
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

/**
 * Fingerprints everything a report depends on: the RAW events and the
 * manual transfer links that are overlaid on them.
 *
 * The links are hashed beside the events, not folded into them, so the
 * report (which reads both) and a checkpoint (which stores both) compute
 * the same value from the same two inputs.
 *
 * The order is a function of content only: events sort by
 * `(externalId, timestamp, kind)` and, since two sources may emit events
 * that agree on all three, finally by their canonical JSON.
 */
export const fingerprintLedger = async ({
  events,
  links,
}: {
  events: LedgerEvent[];
  links: ManualTransferLink[];
}): Promise<string> => {
  const sortedEvents = events
    .map((event) => canonicalEvent(event))
    .map((canonical) => ({ canonical, json: JSON.stringify(canonical) }))
    .sort(
      (a, b) =>
        compareText(
          String(a.canonical.externalId),
          String(b.canonical.externalId),
        ) ||
        Number(a.canonical.timestamp) - Number(b.canonical.timestamp) ||
        compareText(String(a.canonical.kind), String(b.canonical.kind)) ||
        compareText(a.json, b.json),
    )
    .map((entry) => entry.canonical);
  const sortedLinks = links
    .map((link) => sortKeys(link))
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ events: sortedEvents, links: sortedLinks }),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
};

export const shortFingerprint = (hex: string): string => hex.slice(0, 12);
