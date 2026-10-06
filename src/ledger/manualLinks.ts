// Imported by alias, like every other consumer of this module. The
// relative path resolves to a SECOND module instance under Vite's
// resolution, each with its own memoised `openLedger` promise - so two
// connections race the same `openDB` upgrade, and one of them blocks.
import { getAllEvents, openLedger } from '@/ledger/db';
import type { LedgerEvent } from './types';

/**
 * Transfers the user confirmed by hand.
 *
 * Some sources simply do not report the chain transaction behind a
 * movement. Kraken's ledger export is the clearest case: its columns are
 * its own ids, a time, a type and an amount - no hash and no address - so a
 * withdrawal to the user's own wallet cannot be paired with the arrival
 * that the Bitcoin module records, and the tax engine correctly treats an
 * unpaired outflow as a disposal.
 *
 * Rather than soften that rule, a confirmation RECORDS THE MISSING FACT:
 * the hash of the transaction the exchange would have told us about. From
 * then on `linkInternalTransfers` pairs the two on an exact hash like any
 * other transfer, and nothing downstream - matching, lot moves, the report
 * - needs to know a person was involved.
 *
 * The store is keyed on `${sourceId}|${externalId}` rather than the event
 * id, so a full resync (which deletes and re-derives rows) keeps the link
 * attached to the same ledger row.
 */
export type ManualTransferLink = {
  sourceId: string;
  externalId: string;
  txHash: string;
  confirmedAt: number;
};

const keyOf = (sourceId: string, externalId: string) =>
  `${sourceId}|${externalId}`;

/**
 * A stored row from a link.
 *
 * Exported because `restoreCheckpoint` writes links directly into the
 * store inside its own transaction, and has to derive the key exactly the
 * way `putManualLink` does - a second copy of that formula is a key that
 * could drift and silently stop matching.
 */
export const manualLinkRow = (link: ManualTransferLink) => ({
  key: keyOf(link.sourceId, link.externalId),
  sourceId: link.sourceId,
  externalId: link.externalId,
  txHash: link.txHash,
  confirmedAt: link.confirmedAt,
});

/**
 * Rejects a link that would store cleanly and then never apply.
 *
 * The same shape and the same reason as `assertValidEvent`: a restore
 * validates before opening its transaction, so a bad payload is refused
 * whole rather than half-written. An empty `externalId` or `txHash` is the
 * case that matters - it stores without complaint, matches nothing, and
 * leaves the user re-confirming a pair they already confirmed with no way
 * to see why.
 */
export const assertValidManualLink = (link: ManualTransferLink): void => {
  for (const field of ['sourceId', 'externalId', 'txHash'] as const) {
    if (typeof link[field] !== 'string' || link[field] === '') {
      throw new Error(`manual transfer link has no ${field}`);
    }
  }
};

export const getManualLinks = async (): Promise<ManualTransferLink[]> =>
  (await (await openLedger()).getAll('transferLinks')).map(
    ({ sourceId, externalId, txHash, confirmedAt }) => ({
      sourceId,
      externalId,
      txHash,
      confirmedAt,
    }),
  );

export const putManualLink = async (
  link: Omit<ManualTransferLink, 'confirmedAt'> &
    Partial<Pick<ManualTransferLink, 'confirmedAt'>>,
): Promise<void> => {
  await (
    await openLedger()
  ).put(
    'transferLinks',
    manualLinkRow({ ...link, confirmedAt: link.confirmedAt ?? Date.now() }),
  );
};

export const deleteManualLink = async (
  sourceId: string,
  externalId: string,
): Promise<void> => {
  await (
    await openLedger()
  ).delete('transferLinks', keyOf(sourceId, externalId));
};

/**
 * Puts the confirmed hashes onto the events they belong to.
 *
 * Run on the way OUT of the database, before anything reads the log: the
 * stored rows are not modified, so withdrawing a confirmation is a delete
 * and a reload rather than a migration.
 *
 * A link NEVER overwrites a hash the source itself reported. If a source
 * starts reporting one - Kraken adds a column, or the user re-imports from
 * an export that has it - the source's own fact wins, and a stale
 * confirmation cannot redirect a real transaction to the wrong partner.
 */
export const applyManualLinks = (
  events: LedgerEvent[],
  links: ManualTransferLink[],
): LedgerEvent[] => {
  if (links.length === 0) {
    return events;
  }
  const byIdentity = new Map(
    links.map((link) => [keyOf(link.sourceId, link.externalId), link.txHash]),
  );
  return events.map((event) => {
    if (event.txHash !== undefined && event.txHash !== '') {
      return event;
    }
    const txHash = byIdentity.get(keyOf(event.sourceId, event.externalId));
    return txHash === undefined ? event : { ...event, txHash };
  });
};

/**
 * The whole log, with confirmed hashes already applied.
 *
 * Every reader that interprets transfers goes through this rather than
 * `getAllEvents`, so the overlay cannot be applied in one place and
 * forgotten in another - a tax report that saw the link while the event
 * list did not would be the worst of both.
 *
 * `getAllEvents` itself stays raw, and the checkpoint writer uses it: a
 * backup records what each source said, with the confirmations beside it as
 * their own rows.
 */
export const getLinkedEvents = async (): Promise<LedgerEvent[]> => {
  const [events, links] = await Promise.all([getAllEvents(), getManualLinks()]);
  return applyManualLinks(events, links);
};
