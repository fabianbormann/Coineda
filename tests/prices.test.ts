import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { openLedger } from '@/ledger/db';
import {
  getCachedPrice,
  putCachedPrice,
  resolveSpotPrices,
  totalValue,
} from '@/prices/priceStore';

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('prices');
  vi.unstubAllGlobals();
});

describe('the price cache', () => {
  it('keys on currency, so switching base currency does not reuse the old number', async () => {
    await putCachedPrice(
      { assetId: 'cardano:lovelace', currency: 'eur', date: '2026-01-01' },
      '0.42',
    );
    expect(
      await getCachedPrice({
        assetId: 'cardano:lovelace',
        currency: 'usd',
        date: '2026-01-01',
      }),
    ).toBeNull();
  });

  it('does not call the provider for a price it already has', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await putCachedPrice(
      { assetId: 'cardano:lovelace', currency: 'eur', date: today },
      '0.42',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const prices = await resolveSpotPrices(['cardano:lovelace'], 'eur');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prices.get('cardano:lovelace')).toBe('0.42');
  });

  it('keeps serving cached prices when the provider fails', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await putCachedPrice(
      { assetId: 'cardano:lovelace', currency: 'eur', date: today },
      '0.42',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    const prices = await resolveSpotPrices(
      ['cardano:lovelace', 'eth:native'],
      'eur',
    );

    expect(prices.get('cardano:lovelace')).toBe('0.42');
    expect(prices.has('eth:native')).toBe(false);
  });

  it('prices the base currency fiat asset at 1, never missing', async () => {
    // A euro balance under a eur base is worth exactly one euro per unit by
    // definition - no cache lookup or provider call should be needed.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const prices = await resolveSpotPrices(['fiat:eur'], 'eur');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prices.get('fiat:eur')).toBe('1');

    const { missing } = totalValue(
      [{ assetId: 'fiat:eur', amount: '100' }],
      prices,
    );
    expect(missing).toEqual([]);
  });

  it('does not price a different fiat asset at 1 under a different base currency', async () => {
    // fiat:usd under a eur base needs an FX rate this milestone does not
    // have - it must fall through to missing, not be fabricated as par.
    const prices = await resolveSpotPrices(['fiat:usd'], 'eur');

    expect(prices.has('fiat:usd')).toBe(false);

    const { missing } = totalValue(
      [{ assetId: 'fiat:usd', amount: '100' }],
      prices,
    );
    expect(missing).toEqual(['fiat:usd']);
  });

  it('does not throw when the provider returns a malformed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => null,
      })),
    );

    const prices = await resolveSpotPrices(['cardano:lovelace'], 'eur');

    expect(prices.has('cardano:lovelace')).toBe(false);
  });
});

describe('totalling', () => {
  it('multiplies decimal strings without floats', () => {
    const { total, missing } = totalValue(
      [{ assetId: 'cardano:lovelace', amount: '3' }],
      new Map([['cardano:lovelace', '0.1']]),
    );
    // 3 * 0.1 is 0.30000000000000004 in floating point
    expect(total).toBe('0.3');
    expect(missing).toEqual([]);
  });

  it('reports an unpriced asset instead of counting it as zero', () => {
    // Silently treating a missing price as zero understates the balance and
    // the user has no way to know.
    const { total, missing } = totalValue(
      [
        { assetId: 'cardano:lovelace', amount: '10' },
        { assetId: 'eth:mystery', amount: '5' },
      ],
      new Map([['cardano:lovelace', '2']]),
    );
    expect(total).toBe('20');
    expect(missing).toEqual(['eth:mystery']);
  });

  it('totals an empty holdings list to zero with nothing missing', () => {
    const { total, missing } = totalValue([], new Map());
    expect(total).toBe('0');
    expect(missing).toEqual([]);
  });

  it('multiplies a negative amount correctly', () => {
    // foldHoldings only filters exact zero, so a negative holding (e.g. a
    // momentarily over-sold balance before a later leg lands) is reachable.
    const { total, missing } = totalValue(
      [{ assetId: 'cardano:lovelace', amount: '-5' }],
      new Map([['cardano:lovelace', '2']]),
    );
    expect(total).toBe('-10');
    expect(missing).toEqual([]);
  });
});

describe('the v1 to current schema upgrade', () => {
  // Deliberately the LAST tests in this file: proving a genuine multi-phase
  // upgrade means closing and deleting the 'coineda-v2' database that every
  // earlier test's beforeEach already opened at the current DB_VERSION via
  // the statically-imported openLedger, then rebuilding it from a v1-only
  // schema and reopening through a freshly re-imported db module (so its
  // memoised `connection` is genuinely unset, not reused). That leaves the
  // ORIGINAL openLedger import's cached connection pointing at a closed
  // database, which would break any test running after this one in this
  // file - hence last, and in its own describe block.
  it('upgrades a real v1 database in place, keeping v1 data and adding prices and settings', async () => {
    const dbName = 'coineda-v2';

    // Tear down what the top-level beforeEach already opened for this test,
    // so this test can start from nothing rather than an already-v2 database
    // IndexedDB has no way to downgrade.
    const alreadyOpen = await openLedger();
    alreadyOpen.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });

    // Hand-build the pre-Task-8 (v1) schema: events/sources/cursors only,
    // no prices store - mirroring src/ledger/db.ts before this task.
    const v1 = await openDB(dbName, 1, {
      upgrade(db) {
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('identity', ['sourceId', 'externalId'], {
          unique: true,
        });
        events.createIndex('sourceId', 'sourceId');
        events.createIndex('timestamp', 'timestamp');
        db.createObjectStore('sources', { keyPath: 'id' });
        db.createObjectStore('cursors', { keyPath: 'sourceId' });
      },
    });
    await v1.put('sources', {
      id: 'src-a',
      moduleId: 'cardano-blockfrost',
      label: 'My wallet',
      config: {},
    });
    v1.close();

    // Reset the module registry so the next import of db.ts starts with a
    // genuinely unset `connection`, forcing a real openDB call against the
    // v1 database above rather than reusing any cached handle.
    vi.resetModules();
    const fresh = await import('@/ledger/db');
    const upgraded = await fresh.openLedger();

    expect([...upgraded.objectStoreNames].sort()).toEqual([
      'cursors',
      'events',
      'prices',
      'settings',
      'sources',
    ]);
    const source = await upgraded.get('sources', 'src-a');
    expect(source?.label).toBe('My wallet');
  });
});
