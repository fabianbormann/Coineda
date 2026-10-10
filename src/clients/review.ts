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

/** Longest label a review takes from its file name. */
const MAX_LABEL = 80;

/**
 * The file's bare name, as label and banner text: no directory part (a
 * browser may report `C:\fakepath\...`), and capped so a long name cannot
 * swamp the menu or the banner.
 */
const labelFromFileName = (fileName: string): string =>
  (fileName.split(/[\\/]/).pop() ?? '').slice(0, MAX_LABEL) || 'checkpoint';

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

  const label = labelFromFileName(fileName);
  const previous = activeClient();
  const record = createReviewClient(label, {
    fingerprint: checkpoint.fingerprint,
    omittedEventCount: 0,
    file: label,
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
      file: label,
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
