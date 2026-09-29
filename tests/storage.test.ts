import { describe, it, expect, beforeAll, vi } from 'vitest';
import 'fake-indexeddb/auto';

// `src/persistence/storage.js` calls `setup()` at module load and caches the
// resulting `openDB()` promise module-globally, so re-reading through the
// same imported `storage` object only ever proves the cached connection
// still has the data — it can't tell us whether a *returning* user (a fresh
// page load, i.e. a fresh module instance) can actually read a pre-existing
// version-2 database back. To test that for real we need a second, genuine
// `openDB()` call, which means: (1) closing the connection the first module
// instance opened, so a stale connection can't quietly answer the second
// open, and (2) `vi.resetModules()` plus a dynamic `import()` to force
// `storage.js` to re-run `setup()` from scratch. Closing the connection
// requires a handle to it, which `storage.js` doesn't expose, so this file
// wraps `idb`'s `openDB` to capture every `IDBPDatabase` it creates.
const { openConnections } = vi.hoisted(() => ({
  openConnections: [] as Array<{ close: () => void }>,
}));

vi.mock('idb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb')>();
  return {
    ...actual,
    openDB: async (...args: Parameters<typeof actual.openDB>) => {
      const db = await actual.openDB(...args);
      openConnections.push(db);
      return db;
    },
  };
});

describe('IndexedDB persistence', () => {
  let storage: any;

  beforeAll(async () => {
    storage = (await import('../src/persistence/storage')).default;
  });

  it('seeds the assets store from assets.json on first open', async () => {
    const euro = await storage.assets.get('euro');
    expect(euro).toBeDefined();
    expect(euro.symbol).toBe('EUR');
    // isFiat is a number, not a boolean, because IndexedDB cannot index booleans.
    expect(euro.isFiat).toBe(1);

    const crypto = await storage.assets.getAllCrypto();
    expect(crypto.length).toBeGreaterThan(0);
  });

  it('round-trips a transaction through an account-scoped query', async () => {
    const accountId = 42;
    await storage.transactions.add({
      type: 'buy',
      exchange: 'Coineda',
      fromValue: 100,
      fromCurrency: 'EURO',
      toValue: 0.5,
      toCurrency: 'BITCOIN',
      feeValue: 0,
      feeCurrency: 'EURO',
      isComposed: false,
      date: Date.now(),
      account: accountId,
    });

    const read = await storage.transactions.getAllFromAccount(accountId);
    expect(read).toHaveLength(1);
    expect(read[0].toCurrency).toBe('BITCOIN');
    expect(read[0].account).toBe(accountId);
  });

  it('keeps the database at version 2 so existing users are not migrated', async () => {
    // fake-indexeddb has implemented databases() since v4, but guard anyway so
    // this cannot fail for the wrong reason and send someone debugging storage.
    if (typeof indexedDB.databases !== 'function') {
      return;
    }
    const databases = await indexedDB.databases();
    const coineda = databases.find((db) => db.name === 'Coineda');
    expect(coineda?.version).toBe(2);
  });

  it('survives a returning user: data written before a reopen is still readable through a genuine second connection', async () => {
    vi.resetModules();
    const firstStorage = (await import('../src/persistence/storage')).default;

    const accountId = 777;
    await firstStorage.transactions.add({
      type: 'buy',
      exchange: 'Coineda',
      fromValue: 250,
      fromCurrency: 'EURO',
      toValue: 1.5,
      toCurrency: 'ETHEREUM',
      feeValue: 0,
      feeCurrency: 'EURO',
      isComposed: false,
      date: Date.now(),
      account: accountId,
    });

    // Close the connection `firstStorage` opened, so the next `openDB()`
    // call below cannot be quietly satisfied by a still-open connection —
    // it has to actually reopen the (now pre-existing, version-2) database
    // from disk-backed storage, the same as a returning user's browser tab.
    expect(openConnections.length).toBeGreaterThan(0);
    const firstConnection = openConnections[openConnections.length - 1];
    firstConnection.close();

    vi.resetModules();
    const secondStorage = (await import('../src/persistence/storage')).default;

    const read = await secondStorage.transactions.getAllFromAccount(accountId);
    expect(read).toHaveLength(1);
    expect(read[0].toCurrency).toBe('ETHEREUM');
    expect(read[0].account).toBe(accountId);

    // The seeded assets store must also still be there — a returning user
    // must not have their portfolio silently dropped alongside a re-seed.
    const euro = await secondStorage.assets.get('euro');
    expect(euro).toBeDefined();
    expect(euro.symbol).toBe('EUR');
    expect(euro.isFiat).toBe(1);
  });
});
