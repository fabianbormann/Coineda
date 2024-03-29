import storage from '../persistence/storage';
import { createTransaction } from '../helper/common';
import {
  CoinedaFile,
  Exchange,
  ImportError,
  Transaction,
} from '../global/types';
import { CoinedaFileInput } from './source/CoinedaFileInput';
import { BinanceFileInput } from './source/BinanceFileInput';
import { KrakenFileInput } from './source/KrakenFileInput';
import { CointrackingFileInput } from './source/CointrackingFileInput';

const removeDuplicateObjects = async (
  transactions: Array<Transaction>,
  objectStore: string
) => {
  const filteredTransactions: Array<Transaction> = [];
  const savedTransactions: Array<Transaction> = await (storage as any)[
    objectStore
  ].getAll();

  const comparableTransactions = savedTransactions.map((transaction) =>
    JSON.stringify({ ...transaction, id: 0 })
  );

  for (const transaction of transactions) {
    if (
      !comparableTransactions.includes(
        JSON.stringify({ ...transaction, id: 0 })
      )
    ) {
      filteredTransactions.push(transaction);
    }
  }

  return filteredTransactions;
};

const readFileContent = (file: File): Promise<string | ArrayBuffer | null> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      return resolve(event?.target?.result || null);
    };
    reader.onerror = (error) => {
      return reject(error);
    };

    if (file.name.endsWith('.csv') || file.name.endsWith('.cnd')) {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  });

const importFiles = async (files: Array<CoinedaFile>, account: number) => {
  let errors: Array<ImportError> = [];
  let transactions: Array<Transaction> = [];
  let transfers: Array<Transaction> = [];

  const importSources = [
    BinanceFileInput,
    KrakenFileInput,
    CointrackingFileInput,
    CoinedaFileInput,
  ];

  for (const file of files) {
    try {
      file.data = await readFileContent(file);

      for (const importSource of importSources) {
        if (importSource.canImport(file)) {
          const source = new importSource();
          await source.deserialize(file);
          transactions = [...transactions, ...source.transactions];
          transfers = [...transfers, ...source.transfers];
          errors = [...errors, ...source.errors];
          break;
        }
      }
    } catch (error) {
      console.warn(error);
      errors.push({
        type: 'DeserializationFailed',
        filename: file.name,
        source: 'MainImport',
      });
    }
  }

  let totalTransfers = transfers.length;
  transfers = await removeDuplicateObjects(transfers, 'transfers');
  let duplicates = totalTransfers - transfers.length;

  let totalTransactions = transactions.length;
  transactions = await removeDuplicateObjects(transactions, 'transactions');
  duplicates += totalTransactions - transactions.length;
  totalTransactions += errors.length;

  transactions = transactions.filter(
    (transaction) => transaction.isComposed !== '1'
  );

  let exchanges = await storage.exchanges.getAll();

  const addExchangeIfNotExists = async (name: string) => {
    if (!exchanges.find((exchange: Exchange) => exchange.name === name)) {
      await storage.exchanges.add({ name: name });
      exchanges.push({ name: name });
    }
  };

  for (const transaction of transactions) {
    try {
      await addExchangeIfNotExists(transaction.exchange);
      await createTransaction(transaction, account);
    } catch (error) {
      console.error(error);
      errors.push({
        type: 'DatabaseError',
        transaction: transaction,
        source: 'MainImport',
      });
    }
  }

  for (const transfer of transfers) {
    try {
      await addExchangeIfNotExists(transfer.fromExchange);
      await addExchangeIfNotExists(transfer.toExchange);

      await storage.transfers.add({ ...transfer, account: account });
    } catch (error) {
      console.error(error);
      errors.push({
        type: 'DatabaseError',
        transaction: transfer,
        source: 'MainImport',
      });
    }
  }

  return {
    inserts: Math.max(
      0,
      totalTransactions + totalTransfers - duplicates - errors.length
    ),
    duplicates: duplicates,
    errors: errors,
  };
};

export { importFiles };
