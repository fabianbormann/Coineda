const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-import' });

const { createTransaction } = require('./transactions.js');
const { TransactionType } = require('../common.js');

const fileUpload = require('express-fileupload');

const ImportType = Object.freeze({
  COINEDA: 'coineda',
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

router.post('/', fileUpload(), async (req, res) => {
  if (typeof req.files.files === 'undefined') {
    return res.status(400).send('No files provided');
  }

  let account = 0;
  if (typeof req.body.account !== 'undefined') {
    account = req.body.account;
  }
  let errors = 0;

  let transactions = [];
  let transfers = [];
  if (req.files.files instanceof Array) {
    for (const file of req.files.files) {
      const { format, transfersText, transactionsText } = readFile(
        file.data.toString()
      );
      if (
        format !== ImportType.UNKNOWN &&
        transfersText != null &&
        transactionsText != null
      ) {
        transactions = [
          transactions,
          ...textToObjects(transactionsText, account),
        ];
        transfers = [transfers, ...textToObjects(transfersText, account)];
      } else {
        errors += 1;
      }
    }
  } else {
    const { format, transfersText, transactionsText } = readFile(
      req.files.files.data.toString()
    );
    if (
      format !== ImportType.UNKNOWN &&
      transfersText != null &&
      transactionsText != null
    ) {
      transactions = textToObjects(transactionsText, account);
      transfers = textToObjects(transfersText, account);
    } else {
      errors += 1;
    }
  }

  let totalTransfers = transfers.length;
  transfers = await removeDuplicateObjects(transfers, 'transfers');
  let duplicates = totalTransfers - transfers.length;

  let totalTransactions = transactions.length;
  transactions = await removeDuplicateObjects(transactions, 'transactions');
  duplicates += totalTransactions - transactions.length;

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
      await createTransaction(transaction);
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
        typeof transfer.account !== 'undefined' ? transfer.account : 0,
      ]);

      await addExchangeIfNotExists(transfer.fromExchange);
      await addExchangeIfNotExists(transfer.toExchange);
    } catch (error) {
      logger.error(error);
      errors += 1;
    }
  }

  return res.json({
    inserts: totalTransactions + totalTransfers - duplicates - errors,
    duplicates: duplicates,
    errors: errors,
  });
});

module.exports = router;
