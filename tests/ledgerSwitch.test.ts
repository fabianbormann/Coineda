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
    // putEvents captures the name, then validates, then opens. Switching
    // from inside validation lands the switch exactly between the two.
    const events = [
      ledgerEvent({ id: 'e9', sourceId: 'src-a', externalId: 'x9' }),
    ];
    const racing = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) void setActiveLedger('coineda-client-c');
        return Reflect.get(target, prop, receiver);
      },
    });
    const pending = putEvents(racing);
    await expect(pending).rejects.toThrow(/switched/);
    expect(await getAllEvents()).toEqual([]);
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    expect(await getAllEvents()).toEqual([]);
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
