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
  prices: { key: string; value: { key: string; price: string } };
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

const DB_NAME = 'coineda-v2';
const DB_VERSION = 6;

let connection: Promise<IDBPDatabase<LedgerSchema>> | null = null;

export const openLedger = (): Promise<IDBPDatabase<LedgerSchema>> => {
  if (!connection) {
    connection = openDB<LedgerSchema>(DB_NAME, DB_VERSION, {
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
  }
  return connection;
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
): Promise<{ inserted: number; updated: number }> => {
  for (const event of events) {
    assertValidEvent(event);
  }

  const db = await openLedger();
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
): Promise<{ written: boolean; inserted: number; updated: number }> => {
  for (const event of events) {
    assertValidEvent(event);
  }

  const db = await openLedger();
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
): Promise<number> => {
  const db = await openLedger();
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

export const putSource = async (source: SourceRecord): Promise<void> => {
  await (await openLedger()).put('sources', source);
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
): Promise<boolean> => {
  const db = await openLedger();
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

export const deleteSource = async (id: string): Promise<void> => {
  await (await openLedger()).delete('sources', id);
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
export const deleteSourceCascade = async (sourceId: string): Promise<void> => {
  const db = await openLedger();
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

export const getCursor = async (sourceId: string): Promise<Cursor> =>
  (await (await openLedger()).get('cursors', sourceId))?.cursor ?? null;

export const putCursor = async (
  sourceId: string,
  cursor: Cursor,
): Promise<void> => {
  await (await openLedger()).put('cursors', { sourceId, cursor });
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
): Promise<boolean> => {
  const db = await openLedger();
  const tx = db.transaction(['sources', 'cursors'], 'readwrite');
  const existing = await tx.objectStore('sources').get(sourceId);
  if (existing) {
    await tx.objectStore('cursors').put({ sourceId, cursor });
  }
  await tx.done;
  return existing !== undefined;
};
