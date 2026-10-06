import type { LedgerEvent, SourceRecord } from '@/ledger/types';

/**
 * One line of the printed report's source directory.
 *
 * `sourceId` and `moduleId` are nullable for exactly one case: events whose
 * configured source no longer exists. That is not hypothetical -
 * `deleteSourceCascade` removes the record, and a restored checkpoint can
 * carry events ahead of the sources that produced them. The figures in the
 * report were computed FROM those events either way, so dropping them from
 * the directory would understate what the report was built on, which is a
 * worse answer than naming an orphan.
 */
export type SourceDirectoryEntry = {
  sourceId: string | null;
  label: string;
  moduleId: string | null;
  /** Distinct venues, sorted, as the events themselves spell them. For a
   *  chain source this is the wallet identity: the Cardano translator uses
   *  the account or address as the venue. */
  venues: string[];
  eventCount: number;
  firstAt?: number;
  lastAt?: number;
};

/** The label the orphan group prints under. A translation key, resolved by
 *  the renderer, like every other string a report shows. */
export const ORPHAN_SOURCE_LABEL = 'No configured source';

type Accumulated = {
  venues: Set<string>;
  eventCount: number;
  firstAt?: number;
  lastAt?: number;
};

const empty = (): Accumulated => ({ venues: new Set(), eventCount: 0 });

const absorb = (into: Accumulated, event: LedgerEvent): void => {
  into.eventCount += 1;
  for (const leg of event.legs) {
    into.venues.add(leg.venue);
  }
  into.firstAt =
    into.firstAt === undefined
      ? event.timestamp
      : Math.min(into.firstAt, event.timestamp);
  into.lastAt =
    into.lastAt === undefined
      ? event.timestamp
      : Math.max(into.lastAt, event.timestamp);
};

/**
 * Names the wallets and exchanges every figure in the report came from.
 *
 * Built by joining configured sources to the events they produced, and
 * deliberately NOT from `SourceRecord.config`: that field is documented as
 * possibly holding secrets, and this directory is printed and handed to a
 * tax office. The venue names carry the wallet identity anyway, so nothing
 * is lost by never reading it.
 *
 * Pure, and takes both lists as arguments rather than reading the database,
 * so it can be tested without one - the same shape the tax modules follow.
 */
export const buildSourceDirectory = (
  sources: SourceRecord[],
  events: LedgerEvent[],
): SourceDirectoryEntry[] => {
  const bySource = new Map<string, Accumulated>();
  const orphans = empty();

  const known = new Set(sources.map((source) => source.id));
  for (const event of events) {
    if (!known.has(event.sourceId)) {
      absorb(orphans, event);
      continue;
    }
    let accumulated = bySource.get(event.sourceId);
    if (!accumulated) {
      accumulated = empty();
      bySource.set(event.sourceId, accumulated);
    }
    absorb(accumulated, event);
  }

  // Configured sources first, in the order they are configured, so the
  // directory reads the way the sources screen does. A source that has
  // produced nothing yet still gets a line: its absence would read as
  // "this wallet was not included", a different and more alarming claim
  // than "this wallet contributed nothing".
  const entries: SourceDirectoryEntry[] = sources.map((source) => {
    const accumulated = bySource.get(source.id) ?? empty();
    return {
      sourceId: source.id,
      label: source.label,
      moduleId: source.moduleId,
      venues: [...accumulated.venues].sort(),
      eventCount: accumulated.eventCount,
      firstAt: accumulated.firstAt,
      lastAt: accumulated.lastAt,
    };
  });

  if (orphans.eventCount > 0) {
    entries.push({
      sourceId: null,
      label: ORPHAN_SOURCE_LABEL,
      moduleId: null,
      venues: [...orphans.venues].sort(),
      eventCount: orphans.eventCount,
      firstAt: orphans.firstAt,
      lastAt: orphans.lastAt,
    });
  }

  return entries;
};
