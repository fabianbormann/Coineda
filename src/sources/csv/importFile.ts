import { getSources, putSource, putEventsIfSourceExists } from '@/ledger/db';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { detectFileModule } from './registry';
import type { FileSourceModule } from './types';

export type ImportOutcome = {
  module: FileSourceModule;
  source: SourceRecord;
  inserted: number;
  updated: number;
  skipped: string[];
};

export class UnknownFileFormatError extends Error {
  constructor(readonly known: string[]) {
    super('unknown file format');
    this.name = 'UnknownFileFormatError';
  }
}

/**
 * Imports one exported file into the ledger.
 *
 * The host half of a file source: the module stays a pure translator and
 * this does the reading and the writing, exactly as `syncSource` does for a
 * pull source.
 *
 * ONE source per importer, reused on every later import rather than a fresh
 * one per file. That is what makes re-importing converge instead of
 * duplicating: events upsert on (sourceId, externalId), so a longer export
 * covering the same history rewrites the rows it already wrote and adds
 * only what is new. A new source per file would give the same movement two
 * identities and double every balance.
 *
 * The cost is that two accounts at the SAME exchange merge into one source.
 * Their venues come from the file (Kraken's own wallet column), which is
 * identical across accounts, so they would merge in the fold regardless;
 * splitting them needs a per-import label, which is its own change.
 */
export const importFile = async (
  text: string,
  now: number = Date.now(),
): Promise<ImportOutcome> => {
  const module = detectFileModule(text);
  if (module === null) {
    throw new UnknownFileFormatError(
      // Named so the message can say which formats ARE understood, rather
      // than leaving the user to guess what went wrong with their file.
      [],
    );
  }

  const { events, skipped } = module.parse(text);

  const existing = (await getSources()).find(
    (candidate) => candidate.moduleId === module.manifest.id,
  );
  const source: SourceRecord = existing ?? {
    id: crypto.randomUUID(),
    moduleId: module.manifest.id,
    label: module.manifest.label,
    config: {},
  };

  // Written before the events, so `putEventsIfSourceExists` finds it. That
  // guard exists because a sync racing a removal must not resurrect a
  // deleted source's rows; here the source is deliberately being created.
  await putSource({ ...source, lastSyncedAt: now, lastError: undefined });

  const rows: LedgerEvent[] = events.map((event) => ({
    ...event,
    id: crypto.randomUUID(),
    sourceId: source.id,
  }));

  const { inserted, updated } = await putEventsIfSourceExists(source.id, rows);

  return { module, source, inserted, updated, skipped };
};
