import {
  deleteEventsByIdentity,
  getSources,
  putSource,
  putEventsIfSourceExists,
  replaceSourceEvents,
} from '@/ledger/db';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import type { ImportOutcome } from '@/sources/csv/importFile';
import mappedCsv from './index';
import { parseMapped } from './parse';
import type { CsvMapping } from './types';

export type ImportMappedOptions = {
  /** Delete the venue's existing events and write this file's instead, in
   *  one transaction. Only ever on the person's explicit request. */
  replaceExisting?: boolean;
  now?: number;
};

/**
 * Imports a CSV through a user-supplied mapping.
 *
 * Mirrors `importFile`, with one difference: the source is matched by module
 * AND label, because the label is the venue the person named. Two venues
 * mapped through the same module are two sources; a later file from the same
 * venue upserts into the first one's source. The mapping is saved on the
 * source so the next file needs no re-mapping.
 *
 * Nothing is ever deleted unless `replaceExisting` is set. A later file
 * usually covers another period, and a mapping that merely differs (a type
 * value this file lacks, another order) says nothing about whether the
 * earlier events are wrong. When the person does ask, the old events go and
 * the new ones arrive in ONE transaction, and the mapping is saved only once
 * that has committed, so a failure leaves the venue exactly as it was.
 */
export const importMappedFile = async (
  text: string,
  mapping: CsvMapping,
  fileName: string,
  options: ImportMappedOptions = {},
): Promise<ImportOutcome> => {
  const { replaceExisting = false, now = Date.now() } = options;
  const { events, skipped, supersedes = [] } = parseMapped(text, mapping);

  const existing = (await getSources()).find(
    (candidate) =>
      candidate.moduleId === mappedCsv.manifest.id &&
      candidate.label === mapping.venueLabel,
  );
  const source: SourceRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    moduleId: mappedCsv.manifest.id,
    label: mapping.venueLabel,
    config: { mapping: JSON.stringify(mapping), fileName },
  };

  const rows: LedgerEvent[] = events.map((event) => ({
    ...event,
    id: crypto.randomUUID(),
    sourceId: source.id,
  }));

  if (replaceExisting && existing !== undefined) {
    const { written, removed, inserted } = await replaceSourceEvents(
      source.id,
      rows,
    );
    if (written) {
      await putSource({ ...source, lastSyncedAt: now, lastError: undefined });
    }
    return {
      module: mappedCsv,
      source,
      inserted,
      updated: rows.length - inserted,
      superseded: removed,
      skipped,
    };
  }

  await putSource({ ...source, lastSyncedAt: now, lastError: undefined });

  const superseded =
    supersedes.length === 0
      ? 0
      : await deleteEventsByIdentity(source.id, supersedes);

  const { inserted, updated } = await putEventsIfSourceExists(source.id, rows);

  return { module: mappedCsv, source, inserted, updated, superseded, skipped };
};
