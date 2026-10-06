/**
 * The checkpoint module's public surface. Every consumer and every test
 * imports from here, not from `crypto.ts` or `channel.ts` directly.
 *
 * A checkpoint carries the whole of it: settings, configured sources (with
 * their credentials), every recorded event, and the transfers the user
 * confirmed by hand.
 *
 * Synced events used to stay out, on the reasoning that they reload from
 * their sources. They do - while the source still exists. An exchange
 * shutting down, an API losing its free tier, a provider dropping an
 * endpoint: after any of those the history is gone, and in a tax tool
 * history is the asset, because a disposal's cost basis comes from an
 * acquisition years earlier. So a checkpoint is a backup, not only a
 * handover, and the events travel with it.
 *
 * Authored events - bank movements, manual corrections - and confirmed
 * transfers are the same kind of thing for a stronger reason: no sync
 * reproduces them at all.
 *
 * Because the credentials travel with it, a checkpoint is always encrypted.
 */
import {
  assertValidEvent,
  getAllEvents,
  getSources,
  openLedger,
} from '@/ledger/db';
import {
  assertValidManualLink,
  getManualLinks,
  manualLinkRow,
  type ManualTransferLink,
} from '@/ledger/manualLinks';
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
import {
  generateTransferSecret,
  normalizeTransferSecret,
  seal,
  TRANSFER_SECRET_LENGTH,
  unseal,
} from './crypto';
import { chooseChannel, encodeQrPayload, QR_BYTE_LIMIT } from './channel';

export {
  generateTransferSecret,
  normalizeTransferSecret,
  TRANSFER_SECRET_LENGTH,
  chooseChannel,
  QR_BYTE_LIMIT,
  encodeQrPayload,
};
export { getSettings, putSettings, isOnboarded, setOnboarded };

const CURRENT_VERSION = 1;

/**
 * What a checkpoint is FOR, which decides how much of the ledger goes in.
 *
 * - `handover`: setting up another device that is in front of you. Carries
 *   everything no sync reproduces - settings, sources with their
 *   credentials, authored events, confirmed transfers - and leaves the
 *   synced history behind, because the sources fetch that again themselves.
 *   Small enough to travel as a single QR code, which is the whole point.
 * - `backup`: the ledger outliving its sources. Carries everything.
 *
 * The distinction is deliberately NOT a size heuristic. A handover that
 * happens to be too large for a QR is still a handover; it just has to
 * travel as a file like any other.
 */
export type CheckpointScope = 'handover' | 'backup';

export type Checkpoint = {
  v: 1;
  settings: Settings;
  sources: SourceRecord[];
  authoredEvents: LedgerEvent[];
  /**
   * Everything the sources recorded.
   *
   * Optional and separate from `authoredEvents` rather than one combined
   * list, so a build that predates this field still restores what it knows
   * and an older checkpoint still restores here. The two lists never
   * overlap: an event is authored or derived, never both.
   */
  derivedEvents?: LedgerEvent[];
  /**
   * How many recorded transactions this checkpoint deliberately left out.
   *
   * Only a handover sets it. It exists so the receiving device can say
   * what is missing in a number rather than in the abstract - "your other
   * device has 12,431 transactions" is something a person can act on,
   * where "the history is not included" invites them to wonder whether
   * something broke.
   */
  omittedEventCount?: number;
  /**
   * Optional, and the version stays 1 on purpose.
   *
   * A checkpoint written before this field existed simply has none, and a
   * build that predates it ignores one that does - losing a confirmation
   * costs the user one re-confirmation, while bumping the version would
   * make an older install refuse the whole checkpoint and lose the
   * settings and credentials with it.
   */
  transferLinks?: ManualTransferLink[];
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
export const buildCheckpoint = async (
  scope: CheckpointScope = 'backup',
): Promise<Checkpoint> => {
  const [settings, sources, events, transferLinks] = await Promise.all([
    getSettings(),
    getSources(),
    getAllEvents(),
    getManualLinks(),
  ]);
  if (settings === null) {
    throw new Error(
      'cannot build a checkpoint before onboarding: no settings configured yet',
    );
  }
  const derived = events.filter((event) => event.origin === 'derived');
  return {
    v: CURRENT_VERSION,
    settings,
    sources: sources.map(portableSource),
    authoredEvents: events.filter((event) => event.origin === 'authored'),
    // One of the two, never both and never neither: a handover states what
    // it left behind, a backup carries it. A payload with both fields set
    // would be claiming to omit what it also contains.
    ...(scope === 'backup'
      ? { derivedEvents: derived }
      : { omittedEventCount: derived.length }),
    transferLinks,
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
    !Array.isArray(checkpoint.authoredEvents) ||
    (checkpoint.derivedEvents !== undefined &&
      !Array.isArray(checkpoint.derivedEvents)) ||
    (checkpoint.omittedEventCount !== undefined &&
      typeof checkpoint.omittedEventCount !== 'number') ||
    // Absent is valid - see the field's comment on `Checkpoint`. Present
    // but not an array is not, and letting it through would reach the
    // restore's `for ... of` as a crash mid-transaction.
    (checkpoint.transferLinks !== undefined &&
      !Array.isArray(checkpoint.transferLinks))
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
  const events = [
    ...checkpoint.authoredEvents,
    ...(checkpoint.derivedEvents ?? []),
  ];
  for (const event of events) {
    assertValidEvent(event);
  }
  for (const link of checkpoint.transferLinks ?? []) {
    assertValidManualLink(link);
  }

  const db = await openLedger();
  const tx = db.transaction(
    ['settings', 'sources', 'events', 'transferLinks'],
    'readwrite',
  );

  try {
    await tx.objectStore('settings').put({
      key: SETTINGS_KEY,
      value: normalizeSettings(checkpoint.settings),
    });
    for (const source of checkpoint.sources) {
      await tx.objectStore('sources').put(source);
    }
    // Through the identity index, exactly as `putEvents` does, NOT a bare
    // put. The 'events' store has a UNIQUE index on
    // [sourceId, externalId], so restoring onto a device that already
    // synced the same source would collide - the two rows carry the same
    // identity under different ids - and a failed request aborts the whole
    // transaction. That turns an ordinary "restore my backup onto a device
    // I already set up" into a restore that fails entirely. Keeping the
    // existing id also means anything already referring to that row stays
    // valid.
    const eventStore = tx.objectStore('events');
    const identity = eventStore.index('identity');
    for (const event of events) {
      const existing = await identity.get([event.sourceId, event.externalId]);
      await eventStore.put(existing ? { ...event, id: existing.id } : event);
    }
    // Built through the store's own row builder rather than spread in
    // here, so the key cannot drift from the one `putManualLink` writes.
    for (const link of checkpoint.transferLinks ?? []) {
      await tx.objectStore('transferLinks').put(manualLinkRow(link));
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
