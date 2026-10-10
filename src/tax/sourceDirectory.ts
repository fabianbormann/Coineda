import type { ManifestField } from '@/sources/types';
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
  /** Public wallet identities (addresses, an xpub) from the source's
   *  config; see `publicIdentities`. Empty for orphans and file sources. */
  identities: string[];
  /** One of `identities` is an extended public key, which reveals every
   *  address of the wallet; the report says so beside it. */
  hasXpub: boolean;
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
 * The public wallet identities in a source's config, and nothing else.
 * An allow-list by field type: an unknown or missing manifest yields none.
 * Each identity once, in field order, however often it was entered; and
 * whether one of them was an xpub, which discloses far more than an address.
 */
export const publicIdentities = (
  config: Record<string, string>,
  fields: ManifestField[] | undefined,
): { identities: string[]; hasXpub: boolean } => {
  if (!fields) {
    return { identities: [], hasXpub: false };
  }
  const found: string[] = [];
  let hasXpub = false;
  for (const field of fields) {
    const value = config[field.name];
    if (typeof value !== 'string') {
      continue;
    }
    if (field.type === 'address') {
      if (value.trim()) found.push(value.trim());
    } else if (field.type === 'addressList') {
      for (const line of value.split('\n')) {
        if (line.trim()) found.push(line.trim());
      }
    } else if (field.type === 'text' && field.name === 'xpub') {
      if (value.trim()) {
        found.push(value.trim());
        hasXpub = true;
      }
    }
  }
  return { identities: [...new Set(found)], hasXpub };
};

/**
 * Names the wallets and exchanges every figure in the report came from.
 *
 * Built by joining configured sources to the events they produced.
 * `SourceRecord.config` is documented as possibly holding secrets and this
 * directory is printed and handed to a tax office, so config is never
 * copied wholesale: only the fields the module manifest types as `address`
 * or `addressList`, plus a text field named `xpub`, are read (see
 * `publicIdentities`). Those are public on-chain identities a reader needs
 * to look the wallet up; API keys, secrets, URLs and project ids never
 * reach the page.
 *
 * Pure, and takes both lists as arguments rather than reading the database,
 * so it can be tested without one - the same shape the tax modules follow.
 */
export const buildSourceDirectory = (
  sources: SourceRecord[],
  events: LedgerEvent[],
  fieldsOf: (moduleId: string) => ManifestField[] | undefined,
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
      ...publicIdentities(source.config, fieldsOf(source.moduleId)),
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
      identities: [],
      hasXpub: false,
      eventCount: orphans.eventCount,
      firstAt: orphans.firstAt,
      lastAt: orphans.lastAt,
    });
  }

  return entries;
};
