import { openDB } from 'idb';
import defaultAssets from './assets.json';

const setup = () => {
  const database = openDB('Coineda', 1, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const accountStorage = db.createObjectStore('accounts', {
          keyPath: 'id',
          autoIncrement: true,
        });
        accountStorage.createIndex('name', 'name', { unique: true });

        const assetStorage = db.createObjectStore('assets', { keyPath: 'id' });
        assetStorage.createIndex('symbol', 'symbol');
        assetStorage.createIndex('isFiat', 'isFiat');

        const transactionStore = db.createObjectStore('transactions', {
          keyPath: 'id',
          autoIncrement: true,
        });

        transactionStore.createIndex('account', 'account');
        transactionStore.createIndex('exchange', 'exchange');
        transactionStore.createIndex('date', 'date');

        const transferStore = db.createObjectStore('transfers', {
          keyPath: 'id',
          autoIncrement: true,
        });

        transferStore.createIndex('account', 'account');
        transferStore.createIndex('exchange', 'exchange');
        transferStore.createIndex('date', 'date');

        const exchangeStore = db.createObjectStore('exchanges', {
          keyPath: 'id',
          autoIncrement: true,
        });
        exchangeStore.createIndex('name', 'name', { unique: true });

        for (const asset of [
          ...defaultAssets.fiat,
          ...defaultAssets.cryptocurrencies,
        ]) {
          await transaction.objectStore('assets').add({
            ...asset,
            symbol: asset.symbol.toUpperCase(),
            isFiat: asset.hasOwnProperty('roughly_estimated_in_euro') ? 1 : 2,
          });
        }
      }
    },
  });

  const wrapObjectStore = (storeName, connection) => ({
    async get(key) {
      return (await connection).get(storeName, key);
    },
    async getAll() {
      return (await connection).getAll(storeName);
    },
    async set(key, val) {
      return (await connection).put(storeName, val, key);
    },
    async delete(key) {
      return (await connection).delete(storeName, key);
    },
    async clear() {
      return (await connection).clear(storeName);
    },
    async keys() {
      return (await connection).getAllKeys(storeName);
    },
    async add(val) {
      return (await connection).add(storeName, val);
    },
  });

  return {
    transfers: {
      ...wrapObjectStore('transfers', database),
      async put(transfer) {
        return (await database).put('transfers', transfer);
      },
      async getAllFromAccount(account) {
        return (await database).getAllFromIndex(
          'transfers',
          'account',
          IDBKeyRange.only(account)
        );
      },
    },
    exchanges: {
      async put(exchange) {
        return (await database).put('exchanges', exchange);
      },
      ...wrapObjectStore('exchanges', database),
    },
    transactions: {
      ...wrapObjectStore('transactions', database),
      async put(transaction) {
        return (await database).put('transactions', transaction);
      },
      async getAllFromAccount(account) {
        return (await database).getAllFromIndex(
          'transactions',
          'account',
          IDBKeyRange.only(account)
        );
      },
    },
    assets: {
      ...wrapObjectStore('assets', database),
      async getAllFiat() {
        return (await database).getAllFromIndex(
          'assets',
          'isFiat',
          IDBKeyRange.only(1)
        );
      },
      async getAllCrypto() {
        return (await database).getAllFromIndex(
          'assets',
          'isFiat',
          IDBKeyRange.only(2)
        );
      },
      async add(asset) {
        return (await database).add('assets', {
          ...asset,
          symbol: asset.symbol.toUpperCase(),
          id: asset.id.toLowerCase(),
          isFiat: asset.hasOwnProperty('roughly_estimated_in_euro') ? 1 : 2,
        });
      },
      async getBySymbol(symbol) {
        return (await database).getAllFromIndex(
          'assets',
          'symbol',
          IDBKeyRange.only(symbol)
        );
      },
    },
    accounts: {
      ...wrapObjectStore('accounts', database),
      async put(account) {
        return (await database).put('accounts', account);
      },
      async add(name, pattern) {
        return (await database).add('accounts', {
          name: name,
          pattern: pattern,
          created: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
      },
    },
  };
};

const storage = setup();
export default storage;
