import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LEDGER_NAME,
  LedgerReadOnlyError,
  LedgerSwitchedError,
  activeLedgerName,
  closeLedger,
  deleteLedgerDatabase,
  getAllEvents,
  getSources,
  isLedgerReadOnly,
  openLedger,
  putEvents,
  putSource,
  setActiveLedger,
  setLedgerReadOnly,
} from '@/ledger/db';
import { getManualLinks, putManualLink } from '@/ledger/manualLinks';
import { putSettings } from '@/settings/settingsStore';
import { registry } from '@/sources/registry';
import { syncSource } from '@/sync/syncSource';
import { ledgerEvent } from './helpers/ledger';

const source = { id: 'src-a', moduleId: 'manual', label: 'A', config: {} };
const slowSource = {
  id: 'src-slow',
  moduleId: 'slow-switch',
  label: 'Slow',
  config: {},
};

describe('switching the active ledger', () => {
  beforeEach(async () => {
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    const db = await openLedger();
    for (const store of [
      'events',
      'sources',
      'cursors',
      'settings',
      'transferLinks',
    ] as const)
      await db.clear(store);
  });

  it('defaults to coineda-v2', () => {
    expect(activeLedgerName()).toBe('coineda-v2');
  });

  it('keeps client A events out of client B and brings them back', async () => {
    await putSource(source);
    await putEvents([
      ledgerEvent({ id: 'e1', sourceId: 'src-a', externalId: 'x1' }),
    ]);
    await setActiveLedger('coineda-client-b');
    expect(activeLedgerName()).toBe('coineda-client-b');
    expect(await getAllEvents()).toEqual([]);
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    expect((await getAllEvents()).map((e) => e.id)).toEqual(['e1']);
  });

  it('drops the rest of a sync that started before a switch', async () => {
    // Client B holds a source with the same id - as a client set up from
    // A's checkpoint, or A's own backup opened for review, would - so only
    // the ledger guard can keep A's next page out of it.
    await setActiveLedger('coineda-client-b');
    await putSource(slowSource);
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    await putSource(slowSource);
    const before = await getAllEvents();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.push({
      manifest: {
        id: 'slow-switch',
        kind: 'chain',
        label: 'Slow',
        fields: [],
        needsRelay: false,
        selfHostable: true,
        emits: ['reward'],
        docsUrl: 'https://example.org',
      },
      probe: async () => ({ ok: true }),
      fetchEvents: async () => {
        await gate;
        return {
          events: [
            {
              externalId: 'late',
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
            },
          ],
          cursor: null,
        };
      },
    });
    try {
      const running = syncSource(slowSource);
      await setActiveLedger('coineda-client-b');
      release();
      const report = await running;
      expect(report.cancelled).toBe(true);
      expect(report.inserted).toBe(0);
      expect(await getAllEvents()).toEqual([]);
      expect((await getSources())[0].lastSyncedAt).toBeUndefined();
      await setActiveLedger(DEFAULT_LEDGER_NAME);
      expect(await getAllEvents()).toEqual(before);
    } finally {
      registry.splice(
        registry.findIndex((m) => m.manifest.id === 'slow-switch'),
        1,
      );
      await deleteLedgerDatabase('coineda-client-b');
    }
  });

  it('refuses a write that names a ledger that is no longer active', async () => {
    await setActiveLedger('coineda-client-c');
    await expect(
      putEvents(
        [ledgerEvent({ id: 'e9', sourceId: 'src-a', externalId: 'x9' })],
        { ledger: DEFAULT_LEDGER_NAME },
      ),
    ).rejects.toBeInstanceOf(LedgerSwitchedError);
    expect(await getAllEvents()).toEqual([]);
    await deleteLedgerDatabase('coineda-client-c');
  });

  it('refuses every write while the ledger is read-only', async () => {
    await putSource(source);
    setLedgerReadOnly(true);
    expect(isLedgerReadOnly()).toBe(true);
    await expect(
      putManualLink({ sourceId: 'src-a', externalId: 'x', txHash: 'ab' }),
    ).rejects.toBeInstanceOf(LedgerReadOnlyError);
    await expect(putSource({ ...source, label: 'B' })).rejects.toBeInstanceOf(
      LedgerReadOnlyError,
    );
    await expect(
      putEvents([
        ledgerEvent({ id: 'e2', sourceId: 'src-a', externalId: 'y' }),
      ]),
    ).rejects.toBeInstanceOf(LedgerReadOnlyError);
    await expect(putSettings({ language: 'de' })).rejects.toBeInstanceOf(
      LedgerReadOnlyError,
    );
    expect(await getManualLinks()).toEqual([]);
    expect(await getAllEvents()).toEqual([]);
    expect((await getSources())[0].label).toBe('A');
    // A switch clears the flag; the next client decides afresh.
    await setActiveLedger('coineda-client-e');
    expect(isLedgerReadOnly()).toBe(false);
    await deleteLedgerDatabase('coineda-client-e');
  });

  it('retries an open that failed instead of keeping the rejection', async () => {
    const real = indexedDB.open.bind(indexedDB);
    const spy = vi
      .spyOn(indexedDB, 'open')
      .mockImplementationOnce(() => {
        throw new Error('open failed');
      })
      .mockImplementation(real);
    await setActiveLedger('coineda-client-f');
    await expect(openLedger()).rejects.toThrow('open failed');
    const db = await openLedger();
    expect(db.name).toBe('coineda-client-f');
    spy.mockRestore();
    await deleteLedgerDatabase('coineda-client-f');
  });

  it('does not reopen the old database when opened during a switch', async () => {
    await putSource(source);
    await putEvents([
      ledgerEvent({ id: 'e1', sourceId: 'src-a', externalId: 'x1' }),
    ]);
    const first = openLedger();
    const switching = setActiveLedger('coineda-client-x');
    const second = openLedger();
    await first;
    const db = await second;
    await switching;
    expect(db.name).toBe('coineda-client-x');
    expect(await getAllEvents()).toEqual([]);
  });

  it('deletes a database and forgets its connection', async () => {
    await setActiveLedger('coineda-client-d');
    await putSource(source);
    await deleteLedgerDatabase('coineda-client-d');
    await setActiveLedger('coineda-client-d');
    expect(await (await openLedger()).getAll('sources')).toEqual([]);
    await closeLedger();
  });
});
