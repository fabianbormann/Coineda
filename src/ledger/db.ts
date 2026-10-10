import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isValidAmount } from './amount';
import type { Cursor, LedgerEvent, SourceRecord } from './types';
import type { TokenMeta } from '@/assets/tokenRegistry';

/**
 * The v2 ledger: append-only events, configured sources, one sync cursor per
 * source, plus caches for prices, settings and Cardano token metadata.
 *
 * Events are keyed on their own uuid but carry a UNIQUE index on
 * [sourceId, externalId]. That index is what makes a re-sync converge
 * instead of accumulating: putEvents looks an incoming event up by it and
 * updates the existing row, keeping the original id so anything referencing
 * it stays valid.
 *
 * Database name is deliberately 'coineda-v2': the v1 'Coineda' database has
 * an incompatible schema, and leaving it untouched means a user who still
 * has it loses nothing by opening this build.
 */
interface LedgerSchema extends DBSchema {
  events: {
    key: string;
    value: LedgerEvent;
    indexes: {
      identity: [string, string];
      sourceId: string;
      timestamp: number;
    };
  };
  sources: { key: string; value: SourceRecord };
  cursors: { key: string; value: { sourceId: string; cursor: Cursor } };
  /** Cached spot prices, keyed on `${assetId}|${currency}|${date}` so a base
   *  currency switch can never return the previous currency's number under
   *  the new label. See src/prices/priceStore.ts. */
  prices: {
    key: string;
    value: { key: string; price: string; source?: string };
  };
  /** Freeform app settings (language, base currency, onboarded flag, ...),
   *  keyed by name. See src/settings/settingsStore.ts. */
  settings: { key: string; value: { key: string; value: unknown } };
  /**
   * Cardano token registry metadata, keyed on the registry subject.
   *
   * Cached in IndexedDB rather than localStorage because a single logo is a
   * base64 PNG of roughly 19KB - NIGHT's is 25,100 characters - and a wallet
   * with a few dozen native tokens would crowd a 5MB localStorage quota
   * that prices and settings also live in.
   *
   * `found: false` rows are the point of the store as much as the hits are:
   * the registry omits an unknown subject from its response rather than
   * answering "no", so without a recorded miss every page load would ask
   * again about every token it will never know. See
   * src/assets/tokenMetaStore.ts.
   */
  /**
   * Transfers the user confirmed by hand, because no source reported a
   * common on-chain hash for them.
   *
   * Keyed on `${sourceId}|${externalId}` - the event's IDENTITY, not its
   * id. A full resync deletes and re-derives rows, and `putEvents` only
   * preserves an id for a row it still finds by that same identity, so a
   * link keyed on the id would survive a resync in some cases and not
   * others. The identity is what the source itself reproduces.
   *
   * See src/ledger/manualLinks.ts.
   */
  transferLinks: {
    key: string;
    value: {
      key: string;
      sourceId: string;
      externalId: string;
      /** The chain transaction this row is part of. Overlaid onto the
       *  event as `txHash` on load, which is all the ordinary exact
       *  linker needs. */
      txHash: string;
      confirmedAt: number;
    };
    indexes: { sourceId: string };
  };
  tokenMeta: {
    key: string;
    value: { subject: string; fetchedAt: number } & (
      { found: true; meta: TokenMeta } | { found: false }
    );
  };
}

export const DEFAULT_LEDGER_NAME = 'coineda-v2';
const DB_VERSION = 6;

let activeName = DEFAULT_LEDGER_NAME;
let connection: Promise<IDBPDatabase<LedgerSchema>> | null = null;

export class LedgerSwitchedError extends Error {
  constructor(expected: string, active: string) {
    super(
      `ledger switched from ${expected} to ${active}; the write was dropped`,
    );
    this.name = 'LedgerSwitchedError';
  }
}

export class LedgerReadOnlyError extends Error {
  constructor(name: string) {
    super(`ledger ${name} is read-only; the write was refused`);
    this.name = 'LedgerReadOnlyError';
  }
}

export const activeLedgerName = (): string => activeName;

/**
 * Whether the active ledger refuses writes. Set by `setActiveClient` for a
 * review client and cleared by every `setActiveLedger`, so the store itself
 * - not just the screens that hide their buttons - keeps a review copy as
 * it was restored.
 */
let readOnly = false;

export const setLedgerReadOnly = (flag: boolean): void => {
  readOnly = flag;
};

export const isLedgerReadOnly = (): boolean => readOnly;

/**
 * Options every write helper takes. A long-running flow (a sync drain, the
 * tax run) captures `activeLedgerName()` ONCE when it starts and passes it
 * as `ledger` to each write, so a write that resolves after the user
 * switched clients is refused instead of landing in the other client's
 * database. A helper capturing the name itself could never notice: nothing
 * can switch between its own read and its own open.
 */
export type WriteOptions = { ledger?: string };

/** The connection for a write: refused when read-only or switched. */
export const openLedgerForWrite = (
  options?: WriteOptions,
): Promise<IDBPDatabase<LedgerSchema>> => {
  if (readOnly) return Promise.reject(new LedgerReadOnlyError(activeName));
  return openLedger(options?.ledger);
};

/**
 * The connection for the active database. A write that captured
 * `activeLedgerName()` before a long await passes it as `expected`, so it
 * is refused rather than landing in whichever database is active by then.
 */
export const openLedger = (
  expected?: string,
): Promise<IDBPDatabase<LedgerSchema>> => {
  if (expected !== undefined && expected !== activeName) {
    return Promise.reject(new LedgerSwitchedError(expected, activeName));
  }
  if (!connection) {
    const opening = openPromise(activeName);
    connection = opening;
    // A rejected open is not memoised: the next call tries again rather
    // than replaying the same failure until the next switch.
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
  }
  return connection;
};

const openPromise = (name: string): Promise<IDBPDatabase<LedgerSchema>> => {
  try {
    return openDatabase(name);
  } catch (error) {
    return Promise.reject(error);
  }
};

const openDatabase = (name: string): Promise<IDBPDatabase<LedgerSchema>> =>
  openDB<LedgerSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Guarded on oldVersion: a user who installed after Task 3 already
      // has version 1 and must upgrade in place rather than hit "object
      // store already exists" or start over.
      if (oldVersion < 1) {
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('identity', ['sourceId', 'externalId'], {
          unique: true,
        });
        events.createIndex('sourceId', 'sourceId');
        events.createIndex('timestamp', 'timestamp');
        db.createObjectStore('sources', { keyPath: 'id' });
        db.createObjectStore('cursors', { keyPath: 'sourceId' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('prices', { keyPath: 'key' });
      }
      if (oldVersion < 3) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (oldVersion < 4) {
        db.createObjectStore('tokenMeta', { keyPath: 'subject' });
      }
      if (oldVersion < 5) {
        // Rebuilt rather than migrated. TokenMeta gained a measured
        // `logoLuminance`, and rows cached without it would render a
        // dark logo untreated until their 30-day TTL ran out. This store
        // is a cache of something re-fetchable, so dropping it costs one
        // request per token and nothing else.
        db.deleteObjectStore('tokenMeta');
        db.createObjectStore('tokenMeta', { keyPath: 'subject' });
      }
      if (oldVersion < 6) {
        const links = db.createObjectStore('transferLinks', {
          keyPath: 'key',
        });
        // Indexed by source so removing a source can drop its links in
        // the same transaction - a link to an event that no longer
        // exists would quietly re-apply itself if that source were
        // added back with different data.
        links.createIndex('sourceId', 'sourceId');
      }
    },
  });

const closeConnection = async (
  open: Promise<IDBPDatabase<LedgerSchema>> | null,
): Promise<void> => {
  if (!open) return;
  try {
    (await open).close();
  } catch {
    // A rejected open has nothing to close.
  }
};

export const closeLedger = async (): Promise<void> => {
  const open = connection;
  connection = null;
  await closeConnection(open);
};

export const setActiveLedger = async (dbName: string): Promise<void> => {
  // Cleared on every switch, even to the same name: whoever activates a
  // ledger decides afresh whether it is read-only (setActiveClient, the
  // Gate), and a restore into a fresh review database runs before that.
  readOnly = false;
  if (dbName === activeName && connection) return;
  // Swap synchronously: an openLedger() during the close below must see the
  // new name and open the new database, not re-memoise the old one.
  const old = connection;
  connection = null;
  activeName = dbName;
  await closeConnection(old);
};

export const deleteLedgerDatabase = async (dbName: string): Promise<void> => {
  if (dbName === activeName) await closeLedger();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Closed above; a block means another tab holds it, and the deletion
    // completes when it closes.
    req.onblocked = () => resolve();
  });
};

/** Exported because Task 9's restoreCheckpoint writes authored events inside
 *  its own transaction and must apply exactly these rules, not a second copy
 *  of them that could drift. */
export const assertValidEvent = (event: LedgerEvent): void => {
  if (event.legs.length === 0) {
    throw new Error(`event ${event.externalId} must have at least one leg`);
  }
  for (const leg of event.legs) {
    if (!isValidAmount(leg.amount)) {
      throw new Error(
        `invalid amount ${JSON.stringify(leg.amount)} on ${event.externalId}`,
      );
    }
  }
};

/**
 * Upserts by [sourceId, externalId]. Validates every event BEFORE opening the
 * write transaction, so a bad batch is rejected whole rather than half-applied.
 */
export const putEvents = async (
  events: LedgerEvent[],
  options?: WriteOptions,
): Promise<{ inserted: number; updated: number }> => {
  for (const event of events) {
    assertValidEvent(event);
  }

  const db = await openLedgerForWrite(options);
  const tx = db.transaction('events', 'readwrite');
  const index = tx.store.index('identity');
  // Operation counts, not distinct-row counts: if a batch carries two events
  // for the same (sourceId, externalId), the first is an insert and the
  // second an update of the row the first just wrote, so inserted + updated
  // can exceed the number of rows actually left behind.
  let inserted = 0;
  let updated = 0;

  for (const event of events) {
    // Relies on IndexedDB's read-after-write visibility within one
    // transaction: a put() earlier in this loop is visible to an index.get()
    // later in the same loop, which is how two events sharing an identity
    // within a single batch still converge to one row instead of racing.
    // Reading all identities up front - a Promise.all, or a Map built in a
    // pre-pass before any put() runs - would not see each other's writes and
    // would silently start duplicating rows for that case.
    const existing = await index.get([event.sourceId, event.externalId]);
    if (existing) {
      // Keep the original id: a re-sync must not renumber rows.
      await tx.store.put({ ...event, id: existing.id });
      updated += 1;
    } else {
      await tx.store.put(event);
      inserted += 1;
    }
  }

  await tx.done;
  return { inserted, updated };
};

/**
 * `putEvents`, but only if the source these events belong to still exists.
 *
 * The same shape, and the same reason, as `putSourceStatus`: the check
 * and the writes happen in ONE readwrite transaction spanning 'sources'
 * and 'events', so a `deleteSourceCascade` that commits first makes this a
 * no-op rather than leaving derived rows behind for a sourceId with no
 * `sources` row. Those orphans would be invisible - nothing in the UI
 * lists them, so nothing can delete them - while still feeding
 * `ownedVenuesOf`, `foldHoldings` and `runTaxReport`.
 *
 * Returns `written: false` when the source was already gone, so a caller
 * mid-drain can stop rather than keep paging for something that no longer
 * exists.
 */
export const putEventsIfSourceExists = async (
  sourceId: string,
  events: LedgerEvent[],
  options?: WriteOptions,
): Promise<{ written: boolean; inserted: number; updated: number }> => {
  for (const event of events) {
    assertValidEvent(event);
  }

  const db = await openLedgerForWrite(options);
  const tx = db.transaction(['sources', 'events'], 'readwrite');
  const existing = await tx.objectStore('sources').get(sourceId);
  if (!existing) {
    await tx.done;
    return { written: false, inserted: 0, updated: 0 };
  }

  const store = tx.objectStore('events');
  const index = store.index('identity');
  let inserted = 0;
  let updated = 0;
  // Same read-after-write reliance as putEvents: a put() earlier in this
  // loop is visible to an index.get() later in the same transaction, which
  // is how two events sharing an identity in one batch converge to one row.
  for (const event of events) {
    const row = await index.get([event.sourceId, event.externalId]);
    if (row) {
      await store.put({ ...event, id: row.id });
      updated += 1;
    } else {
      await store.put(event);
      inserted += 1;
    }
  }

  await tx.done;
  return { written: true, inserted, updated };
};

export const getAllEvents = async (): Promise<LedgerEvent[]> =>
  (await openLedger()).getAll('events');

export const getEventsBySource = async (
  sourceId: string,
): Promise<LedgerEvent[]> =>
  (await openLedger()).getAllFromIndex('events', 'sourceId', sourceId);

/** Discards a source's derived rows ahead of a full refetch. Authored rows
 *  survive: they have no source to reload them from. */
export const deleteDerivedEvents = async (
  sourceId: string,
  options?: WriteOptions,
): Promise<number> => {
  const db = await openLedgerForWrite(options);
  const tx = db.transaction('events', 'readwrite');
  const rows = await tx.store.index('sourceId').getAll(sourceId);
  let removed = 0;
  for (const row of rows) {
    if (row.origin === 'derived') {
      await tx.store.delete(row.id);
      removed += 1;
    }
  }
  await tx.done;
  return removed;
};

/**
 * Replaces one source's derived rows with `events`, all or nothing.
 *
 * The delete and the writes share ONE readwrite transaction over 'sources'
 * and 'events': if any write fails the transaction is aborted and the old
 * rows are all still there, so a failed replacement can never leave the
 * venue empty or half-replaced. Strictly scoped: only rows indexed under
 * `sourceId` are removed, authored rows survive (as in
 * `deleteDerivedEvents`), and an event belonging to another source is
 * refused before anything is touched. Like `putEventsIfSourceExists`, a
 * source that is already gone makes this a no-op (`written: false`).
 */
export const replaceSourceEvents = async (
  sourceId: string,
  events: LedgerEvent[],
  options?: WriteOptions,
): Promise<{ written: boolean; removed: number; inserted: number }> => {
  for (const event of events) {
    if (event.sourceId !== sourceId) {
      throw new Error(
        `event ${event.externalId} belongs to ${event.sourceId}, not ${sourceId}`,
      );
    }
    assertValidEvent(event);
  }

  const db = await openLedgerForWrite(options);
  const tx = db.transaction(['sources', 'events'], 'readwrite');
  try {
    const source = await tx.objectStore('sources').get(sourceId);
    if (!source) {
      await tx.done;
      return { written: false, removed: 0, inserted: 0 };
    }
    const store = tx.objectStore('events');
    const rows = await store.index('sourceId').getAll(sourceId);
    let removed = 0;
    for (const row of rows) {
      if (row.origin === 'derived') {
        await store.delete(row.id);
        removed += 1;
      }
    }
    const index = store.index('identity');
    let inserted = 0;
    for (const event of events) {
      // An authored row of the same identity keeps its id, as in putEvents.
      const row = await index.get([event.sourceId, event.externalId]);
      await store.put(row ? { ...event, id: row.id } : event);
      if (!row) inserted += 1;
    }
    await tx.done;
    return { written: true, removed, inserted };
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already aborted by the failing request.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
};

/**
 * Removes the rows a source once wrote under these external ids - the
 * per-row shape an earlier parser emitted for what is now one grouped
 * event - so a re-import converges instead of keeping both. An id with no
 * row is ignored. Returns how many rows were removed.
 */
export const deleteEventsByIdentity = async (
  sourceId: string,
  externalIds: string[],
  options?: WriteOptions,
): Promise<number> => {
  const db = await openLedgerForWrite(options);
  const tx = db.transaction('events', 'readwrite');
  const index = tx.store.index('identity');
  let removed = 0;
  for (const externalId of externalIds) {
    const row = await index.get([sourceId, externalId]);
    if (row) {
      await tx.store.delete(row.id);
      removed += 1;
    }
  }
  await tx.done;
  return removed;
};

export const putSource = async (
  source: SourceRecord,
  options?: WriteOptions,
): Promise<void> => {
  await (await openLedgerForWrite(options)).put('sources', source);
};

export const getSources = async (): Promise<SourceRecord[]> =>
  (await openLedger()).getAll('sources');

/**
 * Writes only `lastSyncedAt`/`lastError` onto the stored record, merging
 * onto whatever is there now rather than overwriting the whole row.
 *
 * `syncSource` (src/sync/syncSource.ts) captures the `SourceRecord` it was
 * handed at the start of a drain that can run for seconds to minutes. If the
 * user edits that source while the drain is in flight, spreading the
 * captured snapshot back (`{ ...source, lastSyncedAt }`) would silently
 * restore the pre-edit config and discard the user's correction with no
 * error. Reading the current row and patching just the status fields onto
 * it, in the same transaction as the read, avoids that - and keeps the same
 * guarantee `putSourceIfExists` used to provide: a sync that finishes after
 * the user removed its source must not recreate it. Get and put happen in
 * ONE readwrite transaction, so a delete that commits first makes this a
 * no-op rather than a resurrection. A plain get-then-put in two transactions
 * would still lose that race - IndexedDB only serializes overlapping
 * transactions against EACH OTHER as a whole, not against two separate
 * transactions issued from two separate calls in between which anything
 * could happen. The check has to live where the write happens - a
 * caller-side "is this source still busy" guard is a UI affordance, not a
 * guarantee, and cannot be won by whichever caller is racing it.
 *
 * Returns `false` when the source was already gone, so a caller mid-drain
 * can stop rather than keep paging for something that no longer exists.
 */
export const putSourceStatus = async (
  sourceId: string,
  status: { lastSyncedAt?: number; lastError?: string | undefined },
  options?: WriteOptions,
): Promise<boolean> => {
  const db = await openLedgerForWrite(options);
  const tx = db.transaction('sources', 'readwrite');
  const existing = await tx.store.get(sourceId);
  if (!existing) {
    await tx.done;
    return false;
  }
  await tx.store.put({ ...existing, ...status });
  await tx.done;
  return true;
};

export const deleteSource = async (
  id: string,
  options?: WriteOptions,
): Promise<void> => {
  await (await openLedgerForWrite(options)).delete('sources', id);
};

/**
 * Removes a source completely: its derived events, its cursor row, and the
 * source record itself, all in ONE `readwrite` transaction spanning
 * 'events', 'cursors' and 'sources'.
 *
 * `deleteSource` alone only ever touched the 'sources' store - it left the
 * cursor row behind forever (there was no `deleteCursor` at all), and a
 * caller that wanted the events gone too had to run `deleteDerivedEvents`
 * and `deleteSource` as two separate transactions, so a failure in between
 * left the events gone and the record still present. This follows the same
 * try/catch-plus-`tx.abort()` shape as `restoreCheckpoint`
 * (src/checkpoint/format.ts) for exactly the same reason: a plain throw
 * after an awaited request has already resolved does not abort the
 * transaction on its own, so without the explicit `tx.abort()` IndexedDB
 * would auto-commit whatever was already queued once control returns to
 * the event loop.
 *
 * Authored rows survive, exactly as `deleteDerivedEvents` already
 * guarantees - they have no source to reload them from.
 */
export const deleteSourceCascade = async (
  sourceId: string,
  options?: WriteOptions,
): Promise<void> => {
  const db = await openLedgerForWrite(options);
  const tx = db.transaction(
    ['events', 'cursors', 'sources', 'transferLinks'],
    'readwrite',
  );

  try {
    const eventsStore = tx.objectStore('events');
    const rows = await eventsStore.index('sourceId').getAll(sourceId);
    for (const row of rows) {
      if (row.origin === 'derived') {
        await eventsStore.delete(row.id);
      }
    }
    // A source that was added but never synced has no cursor row yet -
    // deleting a key IndexedDB doesn't have is a no-op, not an error.
    await tx.objectStore('cursors').delete(sourceId);

    const links = tx.objectStore('transferLinks');
    for (const key of await links.index('sourceId').getAllKeys(sourceId)) {
      await links.delete(key);
    }

    await tx.objectStore('sources').delete(sourceId);

    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished (committed or aborted) - nothing left to abort.
    }
    await tx.done.catch(() => {});
    throw error;
  }
};

export const getCursor = async (
  sourceId: string,
  options?: WriteOptions,
): Promise<Cursor> =>
  (await (await openLedger(options?.ledger)).get('cursors', sourceId))
    ?.cursor ?? null;

export const putCursor = async (
  sourceId: string,
  cursor: Cursor,
  options?: WriteOptions,
): Promise<void> => {
  await (
    await openLedgerForWrite(options)
  ).put('cursors', {
    sourceId,
    cursor,
  });
};

/**
 * `putCursor`, guarded the same way `putEventsIfSourceExists` is.
 *
 * `deleteSourceCascade` removes the cursor row inside its own transaction;
 * an unconditional write from a sync still draining would recreate it, and
 * the next sync of a source the user re-added under the same id would
 * resume from a cursor belonging to a configuration that no longer exists.
 */
export const putCursorIfSourceExists = async (
  sourceId: string,
  cursor: Cursor,
  options?: WriteOptions,
): Promise<boolean> => {
  const db = await openLedgerForWrite(options);
  const tx = db.transaction(['sources', 'cursors'], 'readwrite');
  const existing = await tx.objectStore('sources').get(sourceId);
  if (existing) {
    await tx.objectStore('cursors').put({ sourceId, cursor });
  }
  await tx.done;
  return existing !== undefined;
};
