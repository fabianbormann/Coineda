import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEDGER_NAME,
  activeLedgerName,
  closeLedger,
  deleteLedgerDatabase,
  getAllEvents,
  openLedger,
  putEvents,
  putSource,
  setActiveLedger,
} from '@/ledger/db';
import { ledgerEvent } from './helpers/ledger';

const source = { id: 'src-a', moduleId: 'manual', label: 'A', config: {} };

describe('switching the active ledger', () => {
  beforeEach(async () => {
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors', 'settings'] as const)
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

  it('refuses a write that started before a switch', async () => {
    await putSource(source);
    const pending = (async () => {
      const name = activeLedgerName();
      await new Promise((r) => setTimeout(r, 0));
      return openLedger(name);
    })();
    await setActiveLedger('coineda-client-c');
    await expect(pending).rejects.toThrow(/switched/);
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
