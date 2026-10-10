import {
  deleteDerivedEvents,
  deleteEventsByIdentity,
  getSources,
  putSource,
  putEventsIfSourceExists,
} from '@/ledger/db';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import type { ImportOutcome } from '@/sources/csv/importFile';
import mappedCsv from './index';
import { parseMapped } from './parse';
import type { CsvMapping } from './types';

/**
 * Imports a CSV through a user-supplied mapping.
 *
 * Mirrors `importFile`, with one difference: the source is matched by module
 * AND label, because the label is the venue the person named. Two venues
 * mapped through the same module are two sources; a later file from the same
 * venue converges onto the first one's events. The mapping is saved on the
 * source so the next file needs no re-mapping.
 */
export const importMappedFile = async (
  text: string,
  mapping: CsvMapping,
  fileName: string,
  now: number = Date.now(),
): Promise<ImportOutcome> => {
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

  await putSource({ ...source, lastSyncedAt: now, lastError: undefined });

  // A corrected mapping changes every row's identity, so an upsert would
  // keep the wrong events beside the right ones. Replace the venue's derived
  // events instead. The same mapping upserts as before.
  const mappingChanged =
    existing !== undefined &&
    existing.config?.mapping !== undefined &&
    existing.config.mapping !== source.config.mapping;
  const superseded = mappingChanged
    ? await deleteDerivedEvents(source.id)
    : supersedes.length === 0
      ? 0
      : await deleteEventsByIdentity(source.id, supersedes);

  const rows: LedgerEvent[] = events.map((event) => ({
    ...event,
    id: crypto.randomUUID(),
    sourceId: source.id,
  }));

  const { inserted, updated } = await putEventsIfSourceExists(source.id, rows);

  return { module: mappedCsv, source, inserted, updated, superseded, skipped };
};
