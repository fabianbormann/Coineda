import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import {
  deleteSourceCascade,
  getAllEvents,
  getCursor,
  getEventsBySource,
  getSources,
  openLedger,
  putSource,
} from '@/ledger/db';
import { registry } from '@/sources/registry';
import { syncSource } from '@/sync/syncSource';
import type { ModuleSignal } from '@/sources/types';

const source: SourceRecord = {
  id: 'cfg-1',
  moduleId: 'cancellable',
  label: 'My wallet',
  config: { address: 'addr1' },
};

const event = (externalId: string): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'cfg-1',
  externalId,
  timestamp: 1_700_000_000_000,
  kind: 'reward',
  origin: 'derived',
  legs: [
    {
      assetId: 'c:l',
      amount: '1',
      direction: 'in',
      venue: 'addr1',
      role: 'principal',
    },
  ],
});

let seenSignals: ModuleSignal[];
let controller: AbortController;
/** The stop happens once. Aborting on every visit to page 2 would make the
 *  resume test cancel again and prove nothing about resuming. */
let stopOnce: boolean;

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('events');
  await db.clear('cursors');
  await db.clear('sources');
  await putSource(source);

  seenSignals = [];
  controller = new AbortController();
  stopOnce = true;

  registry.push({
    manifest: {
      id: 'cancellable',
      kind: 'chain',
      label: 'Cancellable',
      fields: [],
      needsRelay: false,
      emits: ['reward'],
      docsUrl: 'https://example.org',
    },
    probe: async () => ({ ok: true }),
    // Three pages. The second one aborts the caller's controller the way a
    // user pressing Stop would, then throws the way fetch does - so the
    // test exercises a cancellation arriving mid-drain rather than before
    // it starts, which is the only case that can lose committed work.
    fetchEvents: async (_config, cursor, signal) => {
      seenSignals.push(signal);
      if (cursor === null) {
        return { events: [event('a')], cursor: 'p2' };
      }
      if (cursor === 'p2' && stopOnce) {
        stopOnce = false;
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return { events: [event('c')], cursor: null };
    },
  });
});

afterEach(() => {
  const index = registry.findIndex(
    (module) => module.manifest.id === 'cancellable',
  );
  if (index >= 0) {
    registry.splice(index, 1);
  }
});

describe('sync cancellation', () => {
  it('hands the module the caller&apos;s signal', async () => {
    // Without this the Stop button has nothing to stop: syncSource would
    // abort its own loop but the in-flight request would run to completion.
    await syncSource(source, { signal: controller.signal });
    expect(seenSignals.length).toBeGreaterThan(0);
    for (const signal of seenSignals) {
      expect(signal).toBe(controller.signal);
    }
  });

  it('keeps the pages that already committed', async () => {
    // The cursor is persisted per page, so stopping is not losing. A stop
    // that discarded the work already done would make the button something
    // a user learns to avoid.
    await syncSource(source, { signal: controller.signal });

    const events = await getAllEvents();
    expect(events.map((e) => e.externalId)).toEqual(['a']);
    expect(await getCursor('cfg-1')).toBe('p2');
  });

  it('does not record a user-requested stop as a sync failure', async () => {
    // A stop is not an error. Writing lastError would leave a red row the
    // user has to dismiss for doing exactly what they intended.
    const report = await syncSource(source, { signal: controller.signal });

    expect(report.cancelled).toBe(true);
    expect(report.error).toBeUndefined();

    const [stored] = await getSources();
    expect(stored.lastError).toBeUndefined();
  });

  it('resumes from where a stop left off', async () => {
    await syncSource(source, { signal: controller.signal });

    // A fresh controller: the second attempt is not cancelled, and it must
    // start at p2 rather than replaying from the beginning.
    controller = new AbortController();
    const report = await syncSource(source, { signal: controller.signal });

    expect(report.cancelled).toBeFalsy();
    const events = await getAllEvents();
    expect(events.map((e) => e.externalId).sort()).toEqual(['a', 'c']);
    expect(await getCursor('cfg-1')).toBeNull();
  });

  it('still records a genuine provider failure as an error', async () => {
    // The distinction that matters: an abort the user asked for is not an
    // error, and a provider that broke is. Collapsing the two either hides
    // real failures or cries wolf on every stop.
    const index = registry.findIndex((m) => m.manifest.id === 'cancellable');
    registry[index] = {
      ...registry[index],
      fetchEvents: async () => {
        throw new Error('provider exploded');
      },
    };

    const report = await syncSource(source, { signal: controller.signal });

    expect(report.cancelled).toBeFalsy();
    expect(report.error).toContain('provider exploded');
    const [stored] = await getSources();
    expect(stored.lastError).toContain('provider exploded');
  });

  it('writes no events and no cursor for a source removed mid-drain', async () => {
    // Every STATUS write-back in syncSource goes through
    // putSourceIfExists, but putEvents and putCursor were unconditional.
    // A removal committing between two pages therefore left derived events
    // behind for a sourceId with no `sources` row, and recreated the
    // cursor - and those events still feed ownedVenuesOf, foldHoldings and
    // runTaxReport, with no row in the UI to delete them by. The existing
    // tests in this file cover a stop, not a stop racing a removal.
    const index = registry.findIndex((m) => m.manifest.id === 'cancellable');
    registry[index] = {
      ...registry[index],
      // The removal commits WHILE the second page is being fetched, which
      // is the window the UI's "Remove is disabled during a sync" guard is
      // an affordance against rather than a guarantee of.
      fetchEvents: async (_config, cursor) => {
        if (cursor === null) {
          return { events: [event('a')], cursor: 'p2' };
        }
        await deleteSourceCascade('cfg-1');
        return { events: [event('b')], cursor: null };
      },
    };

    const report = await syncSource(source);

    // A removal is not a provider failure, so it is not reported as one.
    expect(report.error).toBeUndefined();
    expect(await getSources()).toEqual([]);
    expect(await getEventsBySource('cfg-1')).toEqual([]);
    expect(await getCursor('cfg-1')).toBeNull();
  });

  it('does not start at all when the signal is already aborted', async () => {
    controller.abort();
    const report = await syncSource(source, { signal: controller.signal });

    expect(report.cancelled).toBe(true);
    expect(report.pages).toBe(0);
    expect(await getAllEvents()).toHaveLength(0);
  });
});
