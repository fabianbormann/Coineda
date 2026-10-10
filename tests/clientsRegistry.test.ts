import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_CLIENT_KEY,
  CLIENTS_KEY,
  LastClientError,
  activeClient,
  createClient,
  createReviewClient,
  listClients,
  newClientId,
  removeClient,
  renameClient,
  setActiveClient,
  updateReviewMeta,
} from '@/clients/registry';
import { putManualLink } from '@/ledger/manualLinks';
import {
  DEFAULT_LEDGER_NAME,
  LedgerReadOnlyError,
  activeLedgerName,
  isLedgerReadOnly,
  openLedger,
  putSource,
  setActiveLedger,
} from '@/ledger/db';

const source = { id: 'src-a', moduleId: 'manual', label: 'A', config: {} };
const review = {
  omittedEventCount: 0,
  file: 'f.json',
  verdict: 'none' as const,
};

describe('client registry', () => {
  beforeEach(async () => {
    localStorage.clear();
    await setActiveLedger(DEFAULT_LEDGER_NAME);
  });

  it('seeds the default client from an empty registry', () => {
    const clients = listClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].dbName).toBe('coineda-v2');
    expect(clients[0].label).toBe('My portfolio');
    expect(clients[0].kind).toBe('client');
    expect(listClients()[0].id).toBe(clients[0].id);
  });

  it('newClientId is 12 hex chars', () => {
    expect(newClientId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('falls back to the first client when the stored id is unknown', () => {
    const first = listClients()[0];
    localStorage.setItem(ACTIVE_CLIENT_KEY, 'nope');
    expect(activeClient().id).toBe(first.id);
  });

  it('repairs corrupt JSON and non-arrays', () => {
    localStorage.setItem(CLIENTS_KEY, '{nope');
    expect(listClients()).toHaveLength(1);
    localStorage.setItem(CLIENTS_KEY, '{"a":1}');
    expect(listClients()).toHaveLength(1);
  });

  it('creates and renames clients', () => {
    listClients();
    const c = createClient('Acme');
    expect(listClients()).toHaveLength(2);
    expect(c.dbName.startsWith('coineda-client-')).toBe(true);
    renameClient(c.id, 'Acme GmbH');
    expect(listClients().find((x) => x.id === c.id)?.label).toBe('Acme GmbH');
  });

  it('creates review clients and updates their review meta', () => {
    const r = createReviewClient('Rev', review);
    expect(r.kind).toBe('review');
    expect(r.dbName.startsWith('coineda-review-')).toBe(true);
    updateReviewMeta(r.id, { ...review, verdict: 'match', fingerprint: 'ab' });
    expect(listClients().find((x) => x.id === r.id)?.review?.verdict).toBe(
      'match',
    );
    const before = JSON.stringify(listClients());
    updateReviewMeta('unknown', review);
    expect(JSON.stringify(listClients())).toBe(before);
  });

  it('refuses to remove the last client', async () => {
    const only = listClients()[0];
    await expect(removeClient(only.id)).rejects.toBeInstanceOf(LastClientError);
  });

  it('deletes the database of a removed non-active client', async () => {
    const c = createClient('B');
    await setActiveClient(c.id);
    await putSource(source);
    await setActiveClient(listClients()[0].id);
    await removeClient(c.id);
    expect(listClients().some((x) => x.id === c.id)).toBe(false);
    await setActiveLedger(c.dbName);
    expect(await (await openLedger()).getAll('sources')).toEqual([]);
  });

  it('activates the first remaining client when the active one is removed', async () => {
    const first = listClients()[0];
    const c = createClient('B');
    await setActiveClient(c.id);
    expect(activeLedgerName()).toBe(c.dbName);
    await putSource(source);
    await removeClient(c.id);
    expect(activeClient().id).toBe(first.id);
    expect(activeLedgerName()).toBe(first.dbName);
    await setActiveLedger(c.dbName);
    expect(await (await openLedger()).getAll('sources')).toEqual([]);
    await setActiveLedger(first.dbName);
  });

  it('seeds a client next to a registry holding only review records', async () => {
    const r = createReviewClient('Rev', review);
    const clients = listClients();
    expect(clients).toHaveLength(2);
    const seeded = clients.find((x) => x.kind === 'client');
    expect(seeded?.dbName).toBe('coineda-v2');
    expect(listClients()).toHaveLength(2);
    await setActiveClient(r.id);
    await removeClient(r.id);
    expect(activeClient().id).toBe(seeded?.id);
    expect(activeLedgerName()).toBe('coineda-v2');
  });

  it('setActiveClient switches the ledger', async () => {
    const c = createClient('B');
    await setActiveClient(c.id);
    expect(activeLedgerName()).toBe(c.dbName);
    expect(activeClient().id).toBe(c.id);
  });

  it('makes a review client read-only at the store, and a client writable again', async () => {
    const r = createReviewClient('r.coineda', review);
    await setActiveClient(r.id);
    expect(isLedgerReadOnly()).toBe(true);
    await expect(
      putManualLink({ sourceId: 's', externalId: 'x', txHash: 'ab' }),
    ).rejects.toBeInstanceOf(LedgerReadOnlyError);
    const c = listClients().find((x) => x.kind === 'client')!;
    await setActiveClient(c.id);
    expect(isLedgerReadOnly()).toBe(false);
    await removeClient(r.id);
  });
});
