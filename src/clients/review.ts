import { openCheckpoint, restoreCheckpoint } from '@/checkpoint/format';
import { getAllEvents, setActiveLedger } from '@/ledger/db';
import { fingerprintLedger } from '@/ledger/fingerprint';
import { getManualLinks } from '@/ledger/manualLinks';
import {
  activeClient,
  createReviewClient,
  removeClient,
  setActiveClient,
  updateReviewMeta,
  listClients,
  type ClientRecord,
} from './registry';

/** A handover leaves the derived events behind, so there is nothing to review. */
export class HandoverNotReviewableError extends Error {
  constructor() {
    super('A handover checkpoint cannot be opened for review');
    this.name = 'HandoverNotReviewableError';
  }
}

/**
 * Restores a checkpoint into its own throwaway database and registers it as
 * a read-only review client. Credentials are stripped on the way in, and the
 * fingerprint is recomputed from what actually landed rather than trusted
 * from the file, so the verdict reflects the stored data.
 */
export const openForReview = async (
  sealed: Uint8Array,
  secret: string,
  fileName: string,
): Promise<ClientRecord> => {
  const checkpoint = await openCheckpoint(sealed, secret);
  if ((checkpoint.omittedEventCount ?? 0) > 0)
    throw new HandoverNotReviewableError();

  const previous = activeClient();
  const record = createReviewClient(fileName, {
    fingerprint: checkpoint.fingerprint,
    omittedEventCount: 0,
    file: fileName,
    verdict: 'none',
  });
  try {
    await setActiveLedger(record.dbName);
    await restoreCheckpoint(checkpoint, { stripCredentials: true });
    const recomputed = await fingerprintLedger({
      events: await getAllEvents(),
      links: await getManualLinks(),
    });
    const verdict =
      checkpoint.fingerprint === undefined
        ? 'none'
        : checkpoint.fingerprint === recomputed
          ? 'match'
          : 'mismatch';
    updateReviewMeta(record.id, {
      fingerprint: recomputed,
      omittedEventCount: 0,
      file: fileName,
      verdict,
    });
    await setActiveClient(record.id);
    return listClients().find((c) => c.id === record.id) ?? record;
  } catch (error) {
    // Leave the half-built database before deleting it.
    await setActiveClient(previous.id).catch(() => {});
    await removeClient(record.id).catch(() => {});
    throw error;
  }
};
