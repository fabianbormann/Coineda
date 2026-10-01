import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import {
  deleteDerivedEvents,
  deleteSource,
  deleteSourceCascade,
  getAllEvents,
  getCursor,
  getEventsBySource,
  getSources,
  openLedger,
  putCursor,
  putEvents,
  putSource,
} from '@/ledger/db';

const event = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'src-a',
  externalId: 'tx1#0',
  timestamp: 1_700_000_000_000,
  kind: 'reward',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '1000000',
      direction: 'in',
      venue: 'wallet-1',
      role: 'principal',
    },
  ],
  ...over,
});

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('events');
  await db.clear('sources');
  await db.clear('cursors');
});

describe('upsert identity', () => {
  it('re-ingesting the same (sourceId, externalId) updates instead of duplicating', async () => {
    // This is the whole "the log reloads from its sources" promise: a re-sync
    // must converge, not accumulate.
    const first = await putEvents([event()]);
    expect(first).toEqual({ inserted: 1, updated: 0 });

    const second = await putEvents([event({ id: crypto.randomUUID() })]);
    expect(second).toEqual({ inserted: 0, updated: 1 });

    expect(await getAllEvents()).toHaveLength(1);
  });

  it('treats the same externalId from a different source as a different event', async () => {
    await putEvents([event({ sourceId: 'src-a' })]);
    await putEvents([event({ sourceId: 'src-b' })]);
    expect(await getAllEvents()).toHaveLength(2);
  });

  it('keeps the stored id stable across a re-ingest', async () => {
    await putEvents([event({ id: 'stable-id' })]);
    await putEvents([event({ id: 'a-different-id' })]);
    const [stored] = await getAllEvents();
    expect(stored.id).toBe('stable-id');
  });

  it('is idempotent for a whole batch replayed with fresh row ids', async () => {
    // Replaying with fresh ids is what a real re-sync does: the module builds
    // new event objects each run. Replaying the SAME objects would upsert by
    // primary key and pass even with the identity index removed, which is why
    // this test is written this way.
    const batch = [
      event({ externalId: 'tx1#0' }),
      event({ externalId: 'tx1#1' }),
      event({ externalId: 'tx2#0' }),
    ];
    await putEvents(batch);
    const before = await getAllEvents();

    const replay = batch.map((row) => ({ ...row, id: crypto.randomUUID() }));
    const second = await putEvents(replay);

    expect(second).toEqual({ inserted: 0, updated: 3 });
    const after = await getAllEvents();
    expect(after).toHaveLength(3);
    expect(after.map((e) => e.id).sort()).toEqual(
      before.map((e) => e.id).sort(),
    );
  });

  it('converges two events sharing an identity within a single batch', async () => {
    // The exact scenario the unique index exists to survive: a buggy or
    // retrying source module emits the same (sourceId, externalId) twice in
    // one call. This only converges because putEvents' loop sees its own
    // earlier put() before the later index.get() - see the comment on that
    // read in src/ledger/db.ts.
    const first = event({
      id: 'first-id',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '1',
          direction: 'in',
          venue: 'wallet-1',
          role: 'principal',
        },
      ],
    });
    const second = event({
      id: 'second-id',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '2',
          direction: 'in',
          venue: 'wallet-2',
          role: 'principal',
        },
      ],
    });

    const result = await putEvents([first, second]);

    expect(result).toEqual({ inserted: 1, updated: 1 });
    const all = await getAllEvents();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('first-id');
    expect(all[0].legs[0].amount).toBe('2');
  });
});

describe('validation at the boundary', () => {
  it('refuses an event whose leg amount is not a decimal string', async () => {
    await expect(
      putEvents([
        event({
          legs: [
            {
              assetId: 'cardano:lovelace',
              amount: '1e6',
              direction: 'in',
              venue: 'wallet-1',
              role: 'principal',
            },
          ],
        }),
      ]),
    ).rejects.toThrow(/invalid amount/i);
    expect(await getAllEvents()).toHaveLength(0);
  });

  it('refuses an event with no legs', async () => {
    await expect(putEvents([event({ legs: [] })])).rejects.toThrow(
      /at least one leg/i,
    );
  });

  it('rejects a batch mixing a valid and an invalid event, applying neither', async () => {
    const valid = event({ externalId: 'tx1#0' });
    const invalid = event({
      externalId: 'tx2#0',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '1e6',
          direction: 'in',
          venue: 'wallet-1',
          role: 'principal',
        },
      ],
    });

    await expect(putEvents([valid, invalid])).rejects.toThrow(
      /invalid amount/i,
    );
    expect(await getAllEvents()).toHaveLength(0);
  });
});

describe('derived vs authored', () => {
  it("deleting a source's derived events leaves its authored ones alone", async () => {
    // A re-sync discards derived rows and refetches. Authored rows - the bank
    // movements and manual corrections - have no source to reload from.
    await putEvents([
      event({ externalId: 'derived-1', origin: 'derived' }),
      event({ externalId: 'authored-1', origin: 'authored' }),
    ]);

    const removed = await deleteDerivedEvents('src-a');

    expect(removed).toBe(1);
    const remaining = await getEventsBySource('src-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].origin).toBe('authored');
  });
});

describe('sources', () => {
  it('round-trips a source record through put, get and delete', async () => {
    const source: SourceRecord = {
      id: 'source-1',
      moduleId: 'cardano-wallet',
      label: 'My wallet',
      config: { address: 'addr1…' },
    };

    await putSource(source);
    expect(await getSources()).toEqual([source]);

    await deleteSource('source-1');
    expect(await getSources()).toEqual([]);
  });
});

describe('cursors', () => {
  it('returns null for a source that has never synced', async () => {
    expect(await getCursor('never-synced')).toBeNull();
  });

  it('round-trips a cursor through put and get', async () => {
    await putCursor('source-1', 'block:12345');
    expect(await getCursor('source-1')).toBe('block:12345');
  });
});

describe('deleteSourceCascade', () => {
  it('removes the derived events, the cursor and the source record in one go, leaving authored events alone', async () => {
    await putSource({
      id: 'src-a',
      moduleId: 'cardano-wallet',
      label: 'My wallet',
      config: { address: 'addr1' },
    });
    await putCursor('src-a', 'block:999');
    await putEvents([
      event({ externalId: 'derived-1', origin: 'derived' }),
      event({ externalId: 'authored-1', origin: 'authored' }),
    ]);

    await deleteSourceCascade('src-a');

    expect(await getSources()).toEqual([]);
    expect(await getCursor('src-a')).toBeNull();
    const remaining = await getEventsBySource('src-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].origin).toBe('authored');
  });

  it('is a no-op, not a throw, for a source that was never synced', async () => {
    // No cursor row was ever written for this source - deleting a key
    // IndexedDB doesn't have must not reject the whole cascade.
    await putSource({
      id: 'src-b',
      moduleId: 'cardano-wallet',
      label: 'Never synced',
      config: { address: 'addr2' },
    });

    await expect(deleteSourceCascade('src-b')).resolves.toBeUndefined();
    expect(await getSources()).toEqual([]);
  });

  it('rolls back a mid-transaction failure, leaving the derived event, the cursor and the source record all untouched', async () => {
    // The two tests above only prove the happy path - neither would catch
    // a regression that broke the `tx.abort()` rollback specifically.
    // Forces a throw AFTER the derived event's own delete has already been
    // queued and awaited inside the transaction, by making the 'cursors'
    // store's own `delete` throw a plain synchronous error rather than
    // fail as an IDBRequest. That distinction is the whole point: a failed
    // IDBRequest aborts its transaction on its own, but restoreCheckpoint's
    // own tests (tests/checkpoint.test.ts, "rolls back a plain JS throw
    // after an awaited put, not just a failed IDB request") already
    // established that a plain throw does NOT - without deleteSourceCascade's
    // own explicit `tx.abort()` in its catch block, IndexedDB would
    // auto-commit the derived event's deletion that already went through.
    await putSource({
      id: 'src-a',
      moduleId: 'cardano-wallet',
      label: 'Mine',
      config: { address: 'addr1' },
    });
    await putCursor('src-a', 'block:1');
    await putEvents([event({ externalId: 'derived-1', origin: 'derived' })]);

    const originalDelete = IDBObjectStore.prototype.delete;
    const deleteSpy = vi
      .spyOn(IDBObjectStore.prototype, 'delete')
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['delete']>
      ) {
        if (this.name === 'cursors') {
          throw new Error('simulated mid-transaction failure');
        }
        return originalDelete.apply(this, args);
      });

    try {
      await expect(deleteSourceCascade('src-a')).rejects.toThrow(
        'simulated mid-transaction failure',
      );
    } finally {
      deleteSpy.mockRestore();
    }

    expect(await getSources()).toHaveLength(1);
    expect(await getCursor('src-a')).toBe('block:1');
    const remaining = await getEventsBySource('src-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].origin).toBe('derived');
  });
});
