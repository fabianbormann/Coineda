export type LegDirection = 'in' | 'out';
export type LegRole = 'principal' | 'fee';

export type Leg = {
  /** Chain-qualified so the same symbol on two chains is two assets:
   *  'cardano:lovelace', 'eth:0xa0b86991c…'. */
  assetId: string;
  /** Decimal string. Never a JS number. See src/ledger/amount.ts. */
  amount: string;
  direction: LegDirection;
  /** Which wallet or exchange the value moved through. */
  venue: string;
  role: LegRole;
};

export type EventKind =
  'trade' | 'transfer' | 'reward' | 'fee' | 'fiat-in' | 'fiat-out';

export type LedgerEvent = {
  id: string;
  /** The configured source that produced this. */
  sourceId: string;
  /** Stable id from that source: a tx hash plus output index, a trade id.
   *  Together with sourceId this is the event's identity. */
  externalId: string;
  /** Epoch milliseconds, UTC. Displayed through one local formatter. */
  timestamp: number;
  kind: EventKind;
  legs: Leg[];
  /** 'derived' rows are discarded and refetched on a re-sync; 'authored'
   *  rows are the user's own and travel in the checkpoint. */
  origin: 'derived' | 'authored';
  /** The source's own payload, kept so an event can be re-derived or
   *  debugged without another network round trip. */
  raw?: unknown;
};

/** Opaque to the host: only the module that issued it may interpret it. */
export type Cursor = string | null;

export type SourceRecord = {
  id: string;
  moduleId: string;
  label: string;
  /** May contain secrets, so this is never logged and never leaves the
   *  device unencrypted. */
  config: Record<string, string>;
  lastSyncedAt?: number;
  lastError?: string;
};
