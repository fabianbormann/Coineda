import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import {
  deleteSourceCascade,
  getAllEvents,
  getCursor,
  getSources,
  openLedger,
  putEvents,
  putCursor,
  putSource,
} from '@/ledger/db';
import { registry } from '@/sources/registry';
import { syncAll, syncSource } from '@/sync/syncSource';

const source: SourceRecord = {
  id: 'cfg-1',
  moduleId: 'fake-chain',
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

let pages: Map<string | null, { events: LedgerEvent[]; cursor: string | null }>;
let seenCursors: Array<string | null>;

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('events');
  await db.clear('cursors');
  await db.clear('sources');

  seenCursors = [];
  // Keyed on the cursor, not on a call counter. With a counter the
  // "re-syncing from scratch leaves the ledger unchanged" test below would
  // pass without replaying the full run - the counter would have moved on, so
  // only the last page would be re-ingested, and the test would also pass
  // against an implementation that duplicated the earlier pages. That test is
  // Review Focus 1, so it has to fail for the right reason.
  pages = new Map([
    [null, { events: [event('a'), event('b')], cursor: 'p2' }],
    ['p2', { events: [event('c')], cursor: null }],
  ]);

  registry.length = 0;
  registry.push({
    manifest: {
      id: 'fake-chain',
      kind: 'chain',
      label: 'Fake',
      fields: [],
      needsRelay: false,
      emits: ['reward'],
      docsUrl: 'https://example.invalid',
    },
    probe: async () => ({ ok: true }),
    fetchEvents: async (_config, cursor) => {
      seenCursors.push(cursor);
      const page = pages.get(cursor);
      if (!page) {
        throw new Error(`no page for cursor ${String(cursor)}`);
      }
      return page;
    },
  });
});

describe('syncing a source', () => {
  it('drains every page and reports what it wrote', async () => {
    const report = await syncSource(source);
    expect(report).toMatchObject({
      sourceId: 'cfg-1',
      inserted: 3,
      updated: 0,
      pages: 2,
    });
    expect(await getAllEvents()).toHaveLength(3);
  });

  it('persists the cursor it finished on and resumes from it', async () => {
    pages = new Map([
      [null, { events: [event('a')], cursor: 'resume-here' }],
      ['resume-here', { events: [], cursor: null }],
    ]);
    await syncSource(source);
    expect(await getCursor('cfg-1')).toBe(null); // drained to completion

    await putCursor('cfg-1', 'resume-here');
    seenCursors = [];
    await syncSource(source);
    expect(seenCursors[0]).toBe('resume-here');
  });

  it('re-syncing from scratch leaves the ledger unchanged', async () => {
    // Review Focus 1, end to end: this is the promise that lets the log be
    // thrown away and rebuilt from its sources.
    await syncSource(source);
    const before = (await getAllEvents())
      .map((e) => `${e.id}:${e.externalId}`)
      .sort();

    await putCursor('cfg-1', null);
    await syncSource(source);
    const after = (await getAllEvents())
      .map((e) => `${e.id}:${e.externalId}`)
      .sort();

    expect(after).toEqual(before);
  });

  it('a full re-sync discards derived rows but keeps authored ones', async () => {
    await syncSource(source);
    await putEvents([{ ...event('typed-by-hand'), origin: 'authored' }]);

    await syncSource(source, { full: true });

    // The full set, not just the authored count: a resync whose first page
    // failed outright would leave zero derived rows and still pass a check
    // that only counts the authored one.
    const externalIds = (await getAllEvents()).map((e) => e.externalId).sort();
    expect(externalIds).toEqual(['a', 'b', 'c', 'typed-by-hand']);
  });

  it('a failed full resync does not leave a stale cursor pointing past deleted events', async () => {
    // A successful ordinary sync first, so there is real history on disk.
    await syncSource(source);
    expect(await getCursor('cfg-1')).toBe(null);

    // Simulate a stale, mid-history cursor left behind by some earlier,
    // unrelated interrupted run, then attempt a full resync whose very first
    // page throws - the ordinary, transient failure this driver exists to
    // tolerate.
    await putCursor('cfg-1', 'p2');
    registry[0].fetchEvents = async () => {
      throw new Error('transient failure');
    };

    const report = await syncSource(source, { full: true });
    expect(report.error).toBeTruthy();

    // The reset to null must be persisted even though the first page failed:
    // deleteDerivedEvents already ran, so this source has zero events on
    // disk, and a stale non-null cursor here would make an ordinary sync
    // resume mid-history instead of refetching from the start.
    expect(await getCursor('cfg-1')).toBe(null);
    expect(await getAllEvents()).toHaveLength(0);

    // Prove the consequence, not just the stored value: restore a working
    // module and confirm the next ORDINARY sync actually refetches from the
    // beginning rather than resuming from the stale 'p2'.
    registry[0].fetchEvents = async (_config, cursor) => {
      seenCursors.push(cursor);
      const page = pages.get(cursor);
      if (!page) {
        throw new Error(`no page for cursor ${String(cursor)}`);
      }
      return page;
    };
    seenCursors = [];
    await syncSource(source);
    expect(seenCursors[0]).toBe(null);
  });

  it('records the error on the source and does not throw', async () => {
    registry[0].fetchEvents = async () => {
      throw new Error('provider exploded');
    };
    const report = await syncSource(source);
    expect(report.error).toMatch(/provider exploded/);
    expect(report.inserted).toBe(0);
  });

  it('leaves the cursor untouched when a page fails midway', async () => {
    // Advancing a cursor past a page that failed would skip those events
    // forever on the next sync.
    let call = 0;
    registry[0].fetchEvents = async () => {
      if (call++ === 0) return { events: [event('a')], cursor: 'p2' };
      throw new Error('second page failed');
    };
    await syncSource(source);
    expect(await getCursor('cfg-1')).toBe('p2');
    expect(await getAllEvents()).toHaveLength(1);
  });

  it('does not advance the cursor when persisting a page fails', async () => {
    // fetchEvents succeeds and hands back a new cursor, but the event it
    // returns has no legs, so assertValidEvent rejects it inside putEvents's
    // real validation pass - this exercises the genuine write-failure path,
    // not a simulated one. Advancing the cursor here would make those events
    // unreachable forever: the next sync would resume past them, and they
    // were never actually written.
    registry[0].fetchEvents = async () => ({
      events: [{ ...event('bad'), legs: [] }],
      cursor: 'p2',
    });

    const before = await getCursor('cfg-1');
    const report = await syncSource(source);

    expect(report.error).toBeTruthy();
    expect(await getCursor('cfg-1')).toBe(before);
    expect(await getAllEvents()).toHaveLength(0);
  });

  it('reports an unknown module instead of throwing', async () => {
    const report = await syncSource({ ...source, moduleId: 'does-not-exist' });
    expect(report.error).toMatch(/unknown module/i);
  });

  it('reports a stuck cursor immediately instead of exhausting the page budget', async () => {
    // A module that keeps handing back the cursor it was just given would
    // otherwise burn the whole MAX_PAGES budget before being reported as a
    // generic "exceeded max pages" - up to 50 pointless round trips against
    // what may be a rate-limited provider.
    let calls = 0;
    registry[0].fetchEvents = async (_config, cursor) => {
      calls += 1;
      return { events: [], cursor: cursor === null ? 'stuck' : cursor };
    };

    const report = await syncSource(source);

    expect(report.error).toMatch(/fake-chain/);
    expect(report.error).toMatch(/cursor/i);
    expect(calls).toBeLessThan(3);
  });

  it('reports updated rather than inserted on a re-sync over the same identities', async () => {
    const first = await syncSource(source);
    expect(first.inserted).toBe(3);
    expect(first.updated).toBe(0);

    await putCursor('cfg-1', null);
    const second = await syncSource(source);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBeGreaterThan(0);
  });
});

describe('a source removed while a sync still holds a stale reference to it', () => {
  it('does not resurrect the source when its removal and a stale sync run concurrently', async () => {
    // Genuinely concurrent, not sequential: neither promise below is
    // awaited before the other starts, so IndexedDB itself - not this
    // test - decides which of the two transactions touching 'sources'
    // (deleteSourceCascade's three-store transaction, or syncSource's
    // final putSourceIfExists write-back) actually commits first. Both
    // orderings have to land on the same outcome for this to pass: if the
    // removal commits first, the stale write-back's own get-then-put finds
    // nothing and no-ops; if the write-back commits first (the source
    // still genuinely existed at that instant), the removal then runs
    // after it and deletes everything regardless. Either way nothing
    // should be left standing - which is the actual property this test
    // exists to pin, not just the write-after-delete ordering.
    await putSource(source);
    await syncSource(source);
    expect(await getAllEvents()).toHaveLength(3);

    // A snapshot taken as if by a closure before the removal below - the
    // object itself is unaffected by what happens to the stored record.
    const staleSource = { ...source };
    // Returns nothing new - there is nothing for a resurrection to even
    // carry here. An unconditional `putSource` write-back alone, with zero
    // new events, is already enough to bring the bare record back from
    // nothing, so this isolates the assertion to that write-back.
    registry[0].fetchEvents = async () => ({ events: [], cursor: null });

    const cascade = deleteSourceCascade(source.id);
    const sync = syncSource(staleSource);
    const [, report] = await Promise.all([cascade, sync]);

    expect(report.error).toBeUndefined();
    expect(await getSources()).toEqual([]);
    expect(await getAllEvents()).toHaveLength(0);
  });
});

describe('syncing everything', () => {
  it('reports per source and keeps going after one fails', async () => {
    const reports = await syncAll([
      source,
      { ...source, id: 'cfg-2', moduleId: 'does-not-exist' },
    ]);
    expect(reports).toHaveLength(2);
    expect(reports[0].error).toBeUndefined();
    expect(reports[1].error).toMatch(/unknown module/i);
  });
});
