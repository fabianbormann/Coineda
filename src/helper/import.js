import * as XLSX from 'xlsx';
import storage from '../persistence/storage';
import axios from 'axios';

import {
  TransactionType,
  isFiat,
  getAssetId,
  createTransaction,
} from './common';

const ImportType = Object.freeze({
  COINEDA: 'coineda',
  BINANCE_SPOT_ORDER_HISTORY: 'binance_spot_order_history',
  KRAKEN_CSV_EXPORT: 'kraken_csv_export',
  COINTRACKING_CSV_EXPORT: 'cointracking_csv_export',
  UNKNOWN: 'unknown',
});

const inferInputType = (file) => {
  const filename = file.name.toLowerCase();

  if (filename.endsWith('.cnd')) {
    return ImportType.COINEDA;
  } else if (filename.endsWith('.xlsx')) {
    return ImportType.BINANCE_SPOT_ORDER_HISTORY;
  } else if (filename.endsWith('.csv')) {
    if (isCointrackingCSV(file.data)) {
      return ImportType.COINTRACKING_CSV_EXPORT;
    } else {
      return ImportType.KRAKEN_CSV_EXPORT;
    }
  } else {
    return ImportType.UNKNOWN;
  }
};

const getBinanceTokenPair = async (binanceSymbol) => {
  const pair = JSON.parse(
    localStorage.getItem(`binance-pair-${binanceSymbol.toLowerCase()}`)
  );

  if (pair && new Date().getTime() - pair.age < 365 * 24 * 60 * 60 * 1000) {
    try {
      const response = await axios.get(
        'https://api.binance.com/api/v3/exchangeInfo?symbol=' + binanceSymbol
      );

      const fromCurrency = response.data.symbols[0].baseAsset;
      const toCurrency = response.data.symbols[0].quoteAsset;

      localStorage.setItem(
        `binance-pair-${binanceSymbol.toLowerCase()}`,
        JSON.stringify({
          data: { fromCurrency, toCurrency },
          age: new Date().getTime(),
        })
      );

      return { fromCurrency, toCurrency };
    } catch (error) {
      console.error(error);
      return {
        fromCurrency: null,
        toCurrency: null,
      };
    }
  } else {
    return pair.data;
  }
};

const removeDuplicateObjects = async (values, objectStore) => {
  let rows = await storage[objectStore].getAll();

  rows = rows.map((row) => {
    return Object.values({ ...row, id: 0 }).reduce(
      (previous, current) => previous + current
    );
  });

  return values.filter((value) => {
    const vector = Object.values({ ...value, id: 0 }).reduce(
      (previous, current) => previous + current
    );
    return rows.findIndex((row) => row === vector) === -1;
  });
};

const textToObjects = (text, account = 0) => {
  if (text === '') {
    return [];
  }

  const rows = text.split('\n');
  const objects = [];

  let keys = [];

  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      keys = rows[0].split(';');
    } else {
      const item = {};
      const fields = rows[i].split(';');

      let key = 0;
      for (const field of fields) {
        if (keys[key] === 'id') {
          item[keys[key]] = Number(field);
        } else {
          item[keys[key]] = field;
        }
        key += 1;
      }
      objects.push({ ...item, account });
    }
  }

  return objects;
};

const readHeader = (text) => {
  const header = text.match(/<header>\n((.|\n)*?)\n<\/header>/);
  if (header) {
    const [formatString, versionString] = header[1].split('\n');
    const format = formatString.split(':')[1];
    const version = versionString.split(':')[1];

    if (format === ImportType.COINEDA) {
      return {
        format,
        version,
      };
    } else {
      return {
        format: ImportType.UNKNOWN,
        version: -1,
      };
    }
  } else {
    return {
      format: ImportType.UNKNOWN,
      version: -1,
    };
  }
};

const readFile = (text) => {
  const { format, version } = readHeader(text);
  if (format === ImportType.COINEDA) {
    const transactionsText = text.match(
      /<transactions>\n((.|\n)*?)\n<\/transactions>/
    );
    const transfersText = text.match(/<transfers>\n((.|\n)*?)\n<\/transfers>/);

    return {
      format,
      version,
      transfersText: transfersText ? transfersText[1] : '',
      transactionsText: transactionsText ? transactionsText[1] : '',
    };
  } else {
    return {
      format,
      version,
      transfersText: null,
      transactionsText: null,
    };
  }
};

const readCoinedaExport = (csvFile) => {
  const { format, transfersText, transactionsText } = readFile(
    csvFile.toString()
  );

  let importedTransactions = [];
  let importedTransfers = [];

  if (
    format !== ImportType.UNKNOWN &&
    transfersText != null &&
    transactionsText != null
  ) {
    importedTransactions = [
      ...importedTransactions,
      ...textToObjects(transactionsText),
    ];
    importedTransfers = [...importedTransfers, ...textToObjects(transfersText)];
  }

  return { importedTransactions, importedTransfers };
};

const readBinanceSpotOrderHistory = async (xlsxFile) => {
  const workbook = XLSX.read(new Uint8Array(xlsxFile), { type: 'array' });
  const sheetNameList = workbook.SheetNames;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetNameList[0]]);

  let transactions = [];
  let importErrors = 0;
  let skipFeeRows = false;

  for (const row of rows) {
    if (typeof row['Date(UTC)'] !== 'undefined') {
      let { fromCurrency, toCurrency } = await getBinanceTokenPair(row['Pair']);

      const estimateTransactionType = async (fromCurrency, toCurrency) => {
        let transactionType = TransactionType.BUY;
        const fromCurrencyIsFiat = await isFiat(fromCurrency);
        const toCurrencyIsFiat = await isFiat(toCurrency);

        if (!fromCurrencyIsFiat && toCurrencyIsFiat) {
          transactionType = TransactionType.SELL;
        } else if (!fromCurrencyIsFiat && !toCurrencyIsFiat) {
          transactionType = TransactionType.SWAP;
        }
        return transactionType;
      };

      try {
        fromCurrency = await getAssetId(fromCurrency);
        toCurrency = await getAssetId(toCurrency);
      } catch (error) {
        console.warn(error);
        fromCurrency = null;
        toCurrency = null;
      }

      if (fromCurrency && toCurrency) {
        transactions.push({
          fromCurrency: fromCurrency,
          toCurrency: toCurrency,
          exchange: 'Biannce',
          type: await estimateTransactionType(fromCurrency, toCurrency),
          toValue: Number(row['Order Amount']),
          fromValue:
            Number(row['AvgTrading Price']) * Number(row['Order Amount']),
          date: new Date(row['Date(UTC)']),
          feeValue: 0,
          isComposed: 0,
          feeCurrency: 'BTC',
        });
        skipFeeRows = false;
      } else {
        importErrors += 1;
        skipFeeRows = true;
      }
    } else if (
      typeof row['Date(UTC)'] === 'undefined' &&
      row['AvgTrading Price'] !== 'Fee' &&
      !skipFeeRows
    ) {
      const target = transactions.length - 1;
      let feeCurrency = null;
      let feeValue = null;

      if (row['AvgTrading Price'].endsWith(transactions[target].fromCurrency)) {
        feeValue = row['AvgTrading Price'].split(
          transactions[target].fromCurrency
        )[0];
        feeCurrency = transactions[target].fromCurrency;
      } else if (
        row['AvgTrading Price'].endsWith(transactions[target].toCurrency)
      ) {
        feeValue = row['AvgTrading Price'].split(
          transactions[target].toCurrency
        )[0];
        feeCurrency = transactions[target].toCurrency;
      } else if (row['AvgTrading Price'].endsWith('BNB')) {
        feeValue = row['AvgTrading Price'].split('BNB')[0];
        feeCurrency = 'BNB';
      }

      if (feeValue && feeCurrency) {
        transactions[target].feeValue += Number(feeValue);
        transactions[target].feeCurrency = feeCurrency;
      }
    }
  }

  const importedTransactions = [];
  for (const transaction of transactions) {
    try {
      importedTransactions.push({
        ...transaction,
        feeCurrency: await getAssetId(transaction.feeCurrency),
      });
    } catch (error) {
      importErrors += 1;
    }
  }

  return { importedTransactions, importErrors };
};

const getKrakenAssetId = async (symbol) => {
  if (symbol === 'XXBT') {
    return 'bitcoin';
  } else if (symbol === 'XXDG') {
    return 'dogecoin';
  } else if (symbol.startsWith('Z') || symbol.startsWith('X')) {
    return await getAssetId(symbol.substring(1));
  } else {
    return await getAssetId(symbol);
  }
};

const isCointrackingCSV = async (csvFile) => {
  const rows = csvFile.toString().split('\n');
  const header = rows[0];

  return header[2] === 'Cur.' && header[4] === 'Cur.' && header[6] === 'Cur.';
};

const readCointrackingCSVExport = async (csvFile) => {
  const rows = csvFile.toString().split('\n');
  rows.shift();
  let importedTransactions = [];
  let importErrors = 0;

  for (const row of rows) {
    if (row === '') {
      continue;
    }
    const columns = row.split('"').join('').split(',');
    let type = columns[0];

    let fromCurrency = null;
    let toCurrency = null;

    try {
      toCurrency = await getAssetId(columns[2]);
      fromCurrency = await getAssetId(columns[4]);
    } catch (error) {
      console.warn(error);
      importErrors += 1;
    }

    if (fromCurrency && toCurrency) {
      const feeValue = Number(columns[5]);
      let feeCurrency = 'bitcoin';

      if (columns[6] !== '') {
        try {
          feeCurrency = await getAssetId(columns[6]);
        } catch (error) {
          if (feeValue > 0) {
            importErrors += 1;
            console.warn(error);
            type = 'invalid';
          }
        }
      }

      if (type === 'Trade') {
        importedTransactions.push({
          exchange: columns[7],
          isComposed: 0,
          fromCurrency: fromCurrency,
          fromValue: Number(columns[3]),
          toCurrency: toCurrency,
          toValue: Number(columns[1]),
          feeCurrency: feeCurrency,
          feeValue: feeValue,
          date: new Date(columns[10]).getTime(),
        });
      }
    }
  }

  return { importedTransactions, importErrors };
};

const readKrakenCSVExport = async (csvFile) => {
  const rows = csvFile.toString().split('\n');
  rows.shift();
  let transactionReferences = {};
  let importedTransactions = [];
  let importErrors = 0;

  for (const row of rows) {
    if (row === '') {
      continue;
    }
    const columns = row.split('"').join('').split(',');
    const type = columns[3];

    let currency = null;

    try {
      currency = await getKrakenAssetId(columns[6]);
    } catch (error) {
      console.warn(error);
      importErrors += 1;
    }

    if (currency) {
      if (type === 'spend') {
        transactionReferences[columns[1]] = {
          exchange: 'Kraken',
          isComposed: 0,
          fromCurrency: currency,
          fromValue: Math.abs(Number(columns[7])),
          feeCurrency: currency,
          feeValue: columns[8],
          date: new Date(columns[2]),
        };
      } else if (type === 'receive') {
        transactionReferences[columns[1]] = {
          ...transactionReferences[columns[1]],
          exchange: 'Kraken',
          isComposed: 0,
          toCurrency: currency,
          toValue: columns[7],
        };
      }
    }
  }

  for (const reference of Object.keys(transactionReferences)) {
    if (
      typeof transactionReferences[reference].fromCurrency !== 'undefined' &&
      typeof transactionReferences[reference].toCurrency !== 'undefined'
    ) {
      importedTransactions.push(transactionReferences[reference]);
    }
  }

  return { importedTransactions, importErrors };
};

const readFileContent = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      return resolve(event.target.result);
    };
    reader.onerror = (error) => {
      return reject(error);
    };

    reader.readAsText(file);
  });

const importFiles = async (files, account) => {
  let errors = 0;
  let transactions = [];
  let transfers = [];

  for (const file of files) {
    file.data = await readFileContent(file);
    const importType = inferInputType(file);

    if (importType === ImportType.BINANCE_SPOT_ORDER_HISTORY) {
      try {
        let { importedTransactions, importErrors } =
          await readBinanceSpotOrderHistory(file.data);
        transactions = [...transactions, ...importedTransactions];
        errors += importErrors;
      } catch {
        errors += 1;
      }
    } else if (importType === ImportType.KRAKEN_CSV_EXPORT) {
      try {
        let { importedTransactions, importErrors } = await readKrakenCSVExport(
          file.data
        );
        transactions = [...transactions, ...importedTransactions];
        errors += importErrors;
      } catch (error) {
        console.warn(error);
        errors += 1;
      }
    } else if (importType === ImportType.COINTRACKING_CSV_EXPORT) {
      try {
        let { importedTransactions, importErrors } =
          await readCointrackingCSVExport(file.data);
        transactions = [...transactions, ...importedTransactions];
        console.log(transactions);
        errors += importErrors;
      } catch (error) {
        console.warn(error);
        errors += 1;
      }
    } else {
      let { importedTransactions, importedTransfers } = readCoinedaExport(
        file.data
      );
      if (importedTransactions.length === 0 && importedTransfers.length === 0) {
        errors += 1;
      } else {
        transactions = [...transactions, ...importedTransactions];
        transfers = [...transfers, ...importedTransfers];
      }
    }
  }

  let totalTransfers = transfers.length;
  transfers = await removeDuplicateObjects(transfers, 'transfers');
  let duplicates = totalTransfers - transfers.length;

  let totalTransactions = transactions.length;
  transactions = await removeDuplicateObjects(transactions, 'transactions');
  duplicates += totalTransactions - transactions.length;
  totalTransactions += errors;

  transactions = transactions.filter(
    (transaction) => transaction.isComposed !== '1'
  );

  let exchanges = await storage.exchanges.getAll();

  const addExchangeIfNotExists = async (name) => {
    if (exchanges.findIndex((exchange) => exchange.name === name) === -1) {
      await storage.exchanges.add({ name: name });
      exchanges.push({ name: name });
    }
  };

  for (const transaction of transactions) {
    try {
      await createTransaction(transaction, account);
      await addExchangeIfNotExists(transaction.exchange);
    } catch (error) {
      console.error(error);
      if (transaction.type === TransactionType.SWAP) {
        errors += 3;
      } else {
        errors += 1;
      }
    }
  }

  for (const transfer of transfers) {
    try {
      await storage.transfers.add({ ...transfer, account: account });

      await addExchangeIfNotExists(transfer.fromExchange);
      await addExchangeIfNotExists(transfer.toExchange);
    } catch (error) {
      console.error(error);
      errors += 1;
    }
  }

  return {
    inserts: Math.max(
      0,
      totalTransactions + totalTransfers - duplicates - errors
    ),
    duplicates: duplicates,
    errors: errors,
  };
};

export { importFiles };
