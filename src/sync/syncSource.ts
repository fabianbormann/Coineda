import { MAX_PAGES } from '@/sources/conformance';
import { findModule } from '@/sources/registry';
import type { DerivedEvent } from '@/sources/types';
import {
  deleteDerivedEvents,
  getCursor,
  putCursor,
  putCursorIfSourceExists,
  putEventsIfSourceExists,
  putSourceStatus,
} from '@/ledger/db';
import type { Cursor, LedgerEvent, SourceRecord } from '@/ledger/types';

export type SyncReport = {
  sourceId: string;
  inserted: number;
  updated: number;
  pages: number;
  /** A raw diagnostic string (a provider's own message, or one we construct),
   *  never a translation key. Translation happens at the call site, the same
   *  rule src/lib/notify.ts follows - this module has no useTranslation to
   *  interpolate with, and a provider's own failure text cannot be mapped to
   *  a static key anyway. Task 11's UI translates its own wrapper text and
   *  shows this value as the untranslated detail. */
  error?: string;
  /**
   * True when the caller's signal aborted this run. Deliberately separate
   * from `error`: a stop the user asked for is not a failure, and writing
   * it to `lastError` would leave a red row demanding attention for doing
   * exactly what was intended. A provider that genuinely broke still sets
   * `error`.
   */
  cancelled?: boolean;
};

/**
 * Was this thrown because the caller's signal aborted?
 *
 * Reads `name` rather than using `instanceof DOMException`: under jsdom a
 * DOMException comes from a different realm and fails that check, so a
 * cancellation would be misreported as a provider failure. The checkpoint
 * code hit the same realm problem.
 */
const isAbort = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  String((error as { name: unknown }).name) === 'AbortError';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Stamps a module's output with the identity fields only the host may set.
 *
 * `fetchEvents` is typed to return `DerivedEvent`, which omits `id` and
 * `sourceId` - but `Omit` only erases those fields at compile time. A module
 * that builds its event through a variable, a spread, or an `as DerivedEvent`
 * cast can still carry both at runtime, and nothing strips them before they
 * reach us. A module that hardcoded one sourceId across two of the user's
 * configured wallets would collide both wallets' events onto one
 * (sourceId, externalId) identity and corrupt dedupe, so this overwrite is
 * unconditional and deliberate, not a default for a missing value.
 */
const stamp = (event: DerivedEvent, sourceId: string): LedgerEvent => ({
  ...event,
  id: crypto.randomUUID(),
  sourceId,
});

export const syncSource = async (
  source: SourceRecord,
  options?: { full?: boolean; signal?: AbortSignal },
): Promise<SyncReport> => {
  const report: SyncReport = {
    sourceId: source.id,
    inserted: 0,
    updated: 0,
    pages: 0,
  };

  // Checked before anything is read or written: a stop pressed while a
  // previous sync was still finishing must not kick off a fresh drain.
  if (options?.signal?.aborted) {
    report.cancelled = true;
    return report;
  }

  const module = findModule(source.moduleId);
  if (!module) {
    report.error = `unknown module '${source.moduleId}'`;
    // Every status write-back in this function goes through
    // putSourceStatus, never the unconditional putSource (and never a
    // spread of the captured `source` snapshot, which can be stale by the
    // time a drain ends): a sync that finishes after its source was
    // removed - by the UI, or by anything else - must not recreate the
    // record, and a sync that finishes after its source was edited must not
    // clobber the edit. See putSourceStatus's own doc comment in
    // src/ledger/db.ts for why the check has to live there and not just in
    // a caller's "is this busy" guard.
    await putSourceStatus(source.id, { lastError: report.error });
    return report;
  }

  if (options?.full) {
    await deleteDerivedEvents(source.id);
    // Persist the reset, not just the local variable below: if the first
    // page then throws, an un-persisted reset leaves this source with no
    // events on disk and a stale mid-history cursor that an ordinary sync
    // afterward would resume from, silently never looking behind it again.
    // Stored state has to be coherent at every point in between, not only
    // once the whole resync has succeeded.
    await putCursor(source.id, null);
  }

  // getCursor cannot distinguish "never synced" from "explicitly reset" -
  // both return null - so a full resync and a first sync both simply start
  // at null; there is no third state to branch on.
  let cursor: Cursor = options?.full ? null : await getCursor(source.id);

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Between pages as well as inside a request: a stop arriving just after
    // a page committed should end the run here rather than spend another
    // round trip to discover the same thing.
    if (options?.signal?.aborted) {
      report.cancelled = true;
      return report;
    }
    try {
      const requestedCursor = cursor;
      const result = await module.fetchEvents(
        source.config,
        cursor,
        options?.signal,
      );

      // A module that keeps handing back the cursor it was just given is
      // making no progress. Dedupe means this can't duplicate rows, but left
      // unchecked it would burn the full MAX_PAGES budget - a thousand
      // pointless round trips against a provider that may well be
      // rate-limited - before being reported as merely "exceeded max pages".
      // Catching it the moment it repeats fails fast, names the module
      // responsible, and is why that budget can afford to be generous.
      if (result.cursor !== null && result.cursor === requestedCursor) {
        report.error = `${module.manifest.id}: fetchEvents returned the same cursor '${result.cursor}' it was given - the module is not making progress`;
        await putSourceStatus(source.id, { lastError: report.error });
        return report;
      }

      const stamped = result.events.map((event) => stamp(event, source.id));
      // Existence-guarded, like every status write-back in this function:
      // a removal that commits mid-drain must not leave derived events
      // behind for a sourceId with no `sources` row. Those rows are
      // invisible to the UI - nothing lists them, so nothing can delete
      // them - and they would still feed ownedVenuesOf, foldHoldings and
      // runTaxReport.
      const { written, inserted, updated } = await putEventsIfSourceExists(
        source.id,
        stamped,
      );
      if (!written) {
        // The source is gone. Not an error - nobody is left to show one to,
        // and putSourceStatus would discard it anyway - and no point paging
        // on for something that no longer exists.
        return report;
      }
      report.inserted += inserted;
      report.updated += updated;
      report.pages += 1;

      // Persist the cursor only after this page's events have actually
      // landed, and do it before looping again. If the next page throws, the
      // cursor on disk is still the one we just wrote here - the last page
      // that truly committed - never one that points past a page that failed.
      cursor = result.cursor;
      if (!(await putCursorIfSourceExists(source.id, cursor))) {
        // Same race, same answer: a recreated cursor row for a deleted
        // source would be resumed from by whatever is next configured
        // under that id.
        return report;
      }

      if (cursor === null) {
        await putSourceStatus(source.id, {
          lastSyncedAt: Date.now(),
          lastError: undefined,
        });
        return report;
      }
    } catch (error) {
      // Deliberately no putCursor here: the cursor already on disk is the
      // last one a successful page persisted above, so a page that throws
      // never advances past itself and its events are retried, not skipped.
      // That is also what makes a stop lossless: whatever committed stays
      // committed, and the next run resumes from it.
      if (isAbort(error) || options?.signal?.aborted) {
        report.cancelled = true;
        return report;
      }
      report.error = messageOf(error);
      await putSourceStatus(source.id, { lastError: report.error });
      return report;
    }
  }

  report.error = `exceeded the maximum of ${MAX_PAGES} pages while syncing`;
  await putSourceStatus(source.id, { lastError: report.error });
  return report;
};

/**
 * Sequential, not Promise.all: concurrent writers into one IndexedDB
 * transaction scope is a race nobody needs, and providers rate-limit anyway.
 * One source's error is captured in its own report, so a broken source never
 * stops the rest of the list from syncing.
 */
export const syncAll = async (
  sources: SourceRecord[],
): Promise<SyncReport[]> => {
  const reports: SyncReport[] = [];
  for (const source of sources) {
    reports.push(await syncSource(source));
  }
  return reports;
};
