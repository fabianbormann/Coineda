import { MAX_PAGES } from '@/sources/conformance';
import { findModule } from '@/sources/registry';
import type { DerivedEvent } from '@/sources/types';
import {
  deleteDerivedEvents,
  getCursor,
  putCursor,
  putEvents,
  putSourceIfExists,
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
};

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
  options?: { full?: boolean },
): Promise<SyncReport> => {
  const report: SyncReport = {
    sourceId: source.id,
    inserted: 0,
    updated: 0,
    pages: 0,
  };

  const module = findModule(source.moduleId);
  if (!module) {
    report.error = `unknown module '${source.moduleId}'`;
    // Every status write-back in this function goes through
    // putSourceIfExists, never the unconditional putSource: a sync that
    // finishes after its source was removed - by the UI, or by anything
    // else - must not recreate the record. See putSourceIfExists's own doc
    // comment in src/ledger/db.ts for why the check has to live there and
    // not just in a caller's "is this busy" guard.
    await putSourceIfExists({ ...source, lastError: report.error });
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
    try {
      const requestedCursor = cursor;
      const result = await module.fetchEvents(source.config, cursor);

      // A module that keeps handing back the cursor it was just given is
      // making no progress. Dedupe means this can't duplicate rows, but left
      // unchecked it would burn the full MAX_PAGES budget - up to 50 pointless
      // round trips against a provider that may well be rate-limited - before
      // being reported as merely "exceeded max pages". Catching it the moment
      // it repeats fails fast and names the module responsible.
      if (result.cursor !== null && result.cursor === requestedCursor) {
        report.error = `${module.manifest.id}: fetchEvents returned the same cursor '${result.cursor}' it was given - the module is not making progress`;
        await putSourceIfExists({ ...source, lastError: report.error });
        return report;
      }

      const stamped = result.events.map((event) => stamp(event, source.id));
      const { inserted, updated } = await putEvents(stamped);
      report.inserted += inserted;
      report.updated += updated;
      report.pages += 1;

      // Persist the cursor only after this page's events have actually
      // landed, and do it before looping again. If the next page throws, the
      // cursor on disk is still the one we just wrote here - the last page
      // that truly committed - never one that points past a page that failed.
      cursor = result.cursor;
      await putCursor(source.id, cursor);

      if (cursor === null) {
        await putSourceIfExists({
          ...source,
          lastSyncedAt: Date.now(),
          lastError: undefined,
        });
        return report;
      }
    } catch (error) {
      // Deliberately no putCursor here: the cursor already on disk is the
      // last one a successful page persisted above, so a page that throws
      // never advances past itself and its events are retried, not skipped.
      report.error = messageOf(error);
      await putSourceIfExists({ ...source, lastError: report.error });
      return report;
    }
  }

  report.error = `exceeded the maximum of ${MAX_PAGES} pages while syncing`;
  await putSourceIfExists({ ...source, lastError: report.error });
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
