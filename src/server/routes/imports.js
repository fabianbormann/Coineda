const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-import' });

const { createTransaction } = require('./transactions.js');
const {
  TransactionType,
  getBinanceTokenPair,
  getAssetId,
  isFiat,
} = require('../common.js');

const xlsx = require('xlsx');

const fileUpload = require('express-fileupload');

const ImportType = Object.freeze({
  COINEDA: 'coineda',
  BINANCE_SPOT_ORDER_HISTORY: 'binance_spot_order_history',
  KRAKEN_CSV_EXPORT: 'kraken_csv_export',
  UNKNOWN: 'unknown',
});

const removeDuplicateObjects = async (values, table) => {
  const sql = 'SELECT * FROM ' + table;
  let rows = await db.executeSelectQuery(sql);

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
  const workbook = xlsx.read(new Uint8Array(xlsxFile), { type: 'array' });
  const sheetNameList = workbook.SheetNames;
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetNameList[0]]);

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
        logger.warn(error);
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
      logger.warn(error);
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

router.post('/', fileUpload(), async (req, res) => {
  if (typeof req.files.files === 'undefined') {
    return res.status(400).send('No files provided');
  }

  if (typeof req.body.account === 'undefined') {
    return res.status(400).send('No account provided');
  }
  const account = req.body.account;

  let errors = 0;
  let transactions = [];
  let transfers = [];

  const files =
    req.files.files instanceof Array ? req.files.files : [req.files.files];

  for (const file of files) {
    if (req.body.type === ImportType.BINANCE_SPOT_ORDER_HISTORY) {
      try {
        let { importedTransactions, importErrors } =
          await readBinanceSpotOrderHistory(file.data);
        transactions = [...transactions, ...importedTransactions];
        errors += importErrors;
      } catch {
        errors += 1;
      }
    } else if (req.body.type === ImportType.KRAKEN_CSV_EXPORT) {
      try {
        let { importedTransactions, importErrors } = await readKrakenCSVExport(
          file.data
        );
        transactions = [...transactions, ...importedTransactions];
        errors += importErrors;
      } catch (error) {
        logger.warn(error);
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

  let exchanges = await db.executeSelectQuery('SELECT * FROM exchanges');

  const addExchangeIfNotExists = async (name) => {
    if (exchanges.findIndex((exchange) => exchange.name === name) === -1) {
      await db.executeQuery('INSERT INTO exchanges (name) VALUES (?)', name);
      exchanges.push({ name: name });
    }
  };

  for (const transaction of transactions) {
    try {
      await createTransaction({ ...transaction, account: account });
      await addExchangeIfNotExists(transaction.exchange);
    } catch (error) {
      logger.error(error);
      if (transaction.type === TransactionType.SWAP) {
        errors += 3;
      } else {
        errors += 1;
      }
    }
  }

  for (const transfer of transfers) {
    try {
      const sql =
        'INSERT INTO transfers (fromExchange, toExchange, value, currency, feeValue, feeCurrency, date, account) VALUES (?, ?, ?, ?, ?, ?, ?)';
      await db.executeQuery(sql, [
        transfer.fromExchange,
        transfer.toExchange,
        transfer.value,
        transfer.currency,
        transfer.feeValue,
        transfer.feeCurrency,
        transfer.date,
        account,
      ]);

      await addExchangeIfNotExists(transfer.fromExchange);
      await addExchangeIfNotExists(transfer.toExchange);
    } catch (error) {
      logger.error(error);
      errors += 1;
    }
  }

  return res.json({
    inserts: Math.max(
      0,
      totalTransactions + totalTransfers - duplicates - errors
    ),
    duplicates: duplicates,
    errors: errors,
  });
});

module.exports = router;
