import { openLedger } from '@/ledger/db';

/**
 * Every store the ledger has. Named explicitly rather than read off
 * `db.objectStoreNames`: a store added later should make someone decide
 * whether a reset is supposed to empty it, and a list that silently grows
 * makes that decision for them.
 */
const ALL_STORES = [
  'events',
  'sources',
  'cursors',
  'prices',
  'settings',
  'tokenMeta',
  'transferLinks',
] as const;

/**
 * Puts this device back to the state of a fresh install.
 *
 * There is no backend, so this is the only copy of any of it: once this
 * runs, the only way back is a checkpoint the user made first. Which is
 * why the call site confirms, and why the confirmation has to say so.
 *
 * ONE transaction over every store, for the same reason `restoreCheckpoint`
 * uses one: the `onboarded` flag lives in `settings` alongside the data it
 * describes. Clearing store by store could leave a ledger with no sources
 * and no events but still marked onboarded - an app that boots into an
 * empty overview with no way to set itself up again, which is worse than
 * either end state.
 *
 * The theme choice is deliberately NOT cleared. It lives in localStorage
 * because it is a property of this device and this screen, not of the
 * portfolio - someone resetting their data has not asked to be put back
 * into light mode.
 */
export const resetDevice = async (): Promise<void> => {
  const db = await openLedger();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  await Promise.all([
    ...ALL_STORES.map((store) => tx.objectStore(store).clear()),
    tx.done,
  ]);
};
