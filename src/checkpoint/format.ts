/**
 * The checkpoint module's public surface. Every consumer and every test
 * imports from here, not from `crypto.ts` or `channel.ts` directly.
 *
 * A checkpoint carries what cannot be re-derived: settings, configured
 * sources (with their credentials), and authored events. Derived events
 * stay out and reload from their sources on the next sync. Authored events
 * - bank movements, manual corrections - have no source to reload from, so
 * leaving them out would lose them on every restore.
 *
 * Because the credentials travel with it, a checkpoint is always encrypted.
 */
import {
  assertValidEvent,
  getAllEvents,
  getSources,
  openLedger,
} from '@/ledger/db';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import {
  getSettings,
  isOnboarded,
  normalizeSettings,
  putSettings,
  setOnboarded,
  SETTINGS_KEY,
  ONBOARDED_KEY,
  type Settings,
} from '@/settings/settingsStore';
import { generateTransferSecret, seal, unseal } from './crypto';
import { chooseChannel, encodeQrPayload, QR_BYTE_LIMIT } from './channel';

export {
  generateTransferSecret,
  chooseChannel,
  QR_BYTE_LIMIT,
  encodeQrPayload,
};
export { getSettings, putSettings, isOnboarded, setOnboarded };

const CURRENT_VERSION = 1;

export type Checkpoint = {
  v: 1;
  settings: Settings;
  sources: SourceRecord[];
  authoredEvents: LedgerEvent[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strips the fields of a `SourceRecord` that describe THIS device's sync
 * history rather than the portable configuration.
 *
 * `lastSyncedAt` and `lastError` are written by src/sync/syncSource.ts and
 * mean "what happened the last time this install talked to the provider".
 * Carried into a checkpoint they would make a freshly restored device with
 * zero synced events claim it last synced yesterday, and resurrect an error
 * the other device may have long since cleared.
 *
 * Written as an allowlist, not as an omission of those two fields, so a
 * field added to `SourceRecord` later cannot start travelling in a
 * checkpoint by default. The flip side: a genuinely portable new field has
 * to be added HERE too, or it will not be restored. The key set is asserted
 * in tests/checkpointExport.test.ts.
 */
const portableSource = ({
  id,
  moduleId,
  label,
  config,
}: SourceRecord): SourceRecord => ({ id, moduleId, label, config });

/**
 * `getSettings()` returning `null` means onboarding has never run. Building
 * a checkpoint anyway would have to invent a `baseCurrency`, producing an
 * asset id (`fiat:`) that matches nothing - and there is nothing to export
 * before onboarding in the first place.
 */
export const buildCheckpoint = async (): Promise<Checkpoint> => {
  const [settings, sources, events] = await Promise.all([
    getSettings(),
    getSources(),
    getAllEvents(),
  ]);
  if (settings === null) {
    throw new Error(
      'cannot build a checkpoint before onboarding: no settings configured yet',
    );
  }
  return {
    v: CURRENT_VERSION,
    settings,
    sources: sources.map(portableSource),
    authoredEvents: events.filter((event) => event.origin === 'authored'),
  };
};

export const sealCheckpoint = (
  checkpoint: Checkpoint,
  secret: string,
): Promise<Uint8Array> => seal(checkpoint, secret);

/**
 * Decrypting with the right secret proves the bytes are AUTHENTICATED -
 * AES-GCM would have thrown otherwise - but authenticated is not the same
 * as well-formed. Nothing upstream of this point checks that the decrypted
 * JSON actually looks like a `Checkpoint`, so the shape is validated here
 * before the `as Checkpoint` cast is trusted by any caller, most
 * importantly `restoreCheckpoint`.
 */
export const openCheckpoint = async (
  sealed: Uint8Array,
  secret: string,
): Promise<Checkpoint> => {
  const checkpoint = (await unseal(sealed, secret)) as Checkpoint;
  if (typeof checkpoint?.v === 'number' && checkpoint.v > CURRENT_VERSION) {
    throw new Error(
      `this checkpoint was created by a newer version of Coineda (format v${checkpoint.v}); update the app before restoring it`,
    );
  }
  if (
    !isPlainObject(checkpoint) ||
    checkpoint.v !== CURRENT_VERSION ||
    !isPlainObject(checkpoint.settings) ||
    !Array.isArray(checkpoint.sources) ||
    !Array.isArray(checkpoint.authoredEvents)
  ) {
    throw new Error('malformed checkpoint: unexpected shape after decrypting');
  }
  return checkpoint;
};

/**
 * Atomic: everything lands in one `readwrite` transaction spanning
 * 'settings', 'sources' and 'events', or nothing does. A half-restored
 * install - settings applied, sources missing, onboarded already true - is
 * worse than a failed restore, so `setOnboarded` is applied last, inside
 * the same transaction, only once the rest has already been queued.
 *
 * Deliberately does not call `putEvents`: that function opens its own
 * transaction, which would mean two transactions and no rollback across
 * them. Writing directly into the 'events' store here keeps everything
 * inside the one transaction IndexedDB can abort as a unit.
 *
 * Every authored event is validated with the ledger's own
 * `assertValidEvent` BEFORE the transaction opens, so a bad payload is
 * rejected whole, before anything is written - the same rule `putEvents`
 * enforces, applied here rather than duplicated, so the two cannot drift.
 *
 * A failed IDB request (e.g. a unique-index collision on a direct
 * store.put) aborts the transaction on its own. A plain JS throw does
 * NOT: if it happens after an awaited put has already resolved and before
 * any further request is queued, there is no pending request for
 * IndexedDB to notice, so it auto-commits whatever was already queued
 * once control returns to the event loop - leaving exactly the
 * half-restored install this function exists to prevent. The try/catch
 * below is what makes EITHER kind of failure roll back: on any throw it
 * calls `tx.abort()` synchronously, in the same tick, before any
 * auto-commit can finish. `tx.abort()` itself throws if the transaction
 * has already finished (committed or aborted by IndexedDB itself); that
 * one case is swallowed since there is nothing left to abort.
 *
 * `tx.done` is read in exactly one place on each path: the trailing
 * `await tx.done` on success, or the `.catch` in the error branch below
 * when a failure skipped straight past that line. Either way, whichever
 * triggered the abort - a request failure that already aborted the
 * transaction on its own, or our own explicit `tx.abort()` call above -
 * `tx.done` is guaranteed to have a handler attached before this function
 * returns, so its rejection is never left unhandled.
 */
export const restoreCheckpoint = async (
  checkpoint: Checkpoint,
): Promise<void> => {
  for (const event of checkpoint.authoredEvents) {
    assertValidEvent(event);
  }

  const db = await openLedger();
  const tx = db.transaction(['settings', 'sources', 'events'], 'readwrite');

  try {
    await tx.objectStore('settings').put({
      key: SETTINGS_KEY,
      value: normalizeSettings(checkpoint.settings),
    });
    for (const source of checkpoint.sources) {
      await tx.objectStore('sources').put(source);
    }
    for (const event of checkpoint.authoredEvents) {
      await tx.objectStore('events').put(event);
    }
    // Last, in this same transaction: see the doc comment above.
    await tx.objectStore('settings').put({ key: ONBOARDED_KEY, value: true });

    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished (committed or aborted) - nothing left to abort.
    }
    // The abort just triggered (or the request failure that triggered it
    // before we got here) makes `tx.done` reject too. Consume that
    // rejection here - the real error is `error`, already caught above.
    await tx.done.catch(() => {});
    throw error;
  }
};
