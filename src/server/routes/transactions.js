const express = require('express');
const router = express.Router();

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-transactions' });

const db = require('../database/helper.js');
const common = require('../common.js');
const { TransactionType, isFiat } = common;

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

const fileUpload = require('express-fileupload');

const createTransaction = async (transaction) => {
  let {
    exchange,
    fromValue,
    fromCurrency,
    toValue,
    toCurrency,
    feeValue,
    feeCurrency,
    date,
    composedKeys,
    isComposed,
  } = transaction;

  const sql =
    'INSERT INTO transactions (type, exchange, fromValue, fromCurrency, toValue, toCurrency, feeValue, feeCurrency, isComposed, composedKeys, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  const fromCurrencyIsFiat = await isFiat(fromCurrency);
  const toCurrencyIsFiat = await isFiat(toCurrency);

  console.log(transaction);
  console.log(fromCurrencyIsFiat, toCurrencyIsFiat);

  let transactionType = TransactionType.BUY;
  if (!fromCurrencyIsFiat && toCurrencyIsFiat) {
    transactionType = TransactionType.SELL;
  } else if (!fromCurrencyIsFiat && !toCurrencyIsFiat) {
    isComposed = 1;
    transactionType = TransactionType.SELL;
    let price = 0;
    const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
    const fromTimestamp = Math.floor(
      (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
    );

    price = (
      await CoinGeckoClient.coins.fetchMarketChartRange(
        fromCurrency.toLowerCase(),
        {
          from: fromTimestamp,
          to: toTimestamp,
          vs_currency: 'eur',
        }
      )
    ).data.prices[0][1];

    await db.executeQuery(sql, [
      transactionType,
      exchange,
      fromValue,
      fromCurrency.toUpperCase(),
      price * fromValue,
      'euro',
      feeValue,
      feeCurrency.toUpperCase(),
      isComposed,
      composedKeys,
      date,
    ]);

    transactionType = TransactionType.BUY;

    fromCurrency = 'euro';
    fromValue = Math.round(price * fromValue * 100) / 100;
  }

  await db.executeQuery(sql, [
    transactionType,
    exchange,
    fromValue,
    fromCurrency.toUpperCase(),
    toValue,
    toCurrency.toUpperCase(),
    feeValue,
    feeCurrency.toUpperCase(),
    isComposed,
    composedKeys,
    date,
  ]);

  if (isComposed === 1) {
    transactionType = TransactionType.SWAP;

    const children = await db.executeSelectQuery(
      'SELECT * FROM transactions ORDER BY id DESC LIMIT 2'
    );

    const parent = await db.executeQuery(sql, [
      transactionType,
      exchange,
      children[1].fromValue,
      children[1].fromCurrency,
      children[0].toValue,
      children[0].toCurrency,
      feeValue,
      feeCurrency.toUpperCase(),
      0,
      `${children[0].id},${children[1].id}`,
      date,
    ]);

    for (const child of children) {
      await db.executeQuery('UPDATE transactions SET parent=? WHERE id=?', [
        parent.lastID,
        child.id,
      ]);
    }
  }
};

router.get('/', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await db.executeSelectQuery(sql);
  return res.json(transactions);
});

router.post('/', async (req, res) => {
  try {
    await createTransaction({
      isComposed: 0,
      composedKeys: '',
      ...req.body,
    });
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res
      .status(500)
      .send(
        'There was an error while writing the transaction into the database'
      );
  }
});

router.delete('/', async (req, res) => {
  const sql = `DELETE FROM transactions WHERE id IN (
      ${req.body.transactions.join(', ')})`;

  try {
    await db.executeSelectQuery(sql);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).json(error);
  }
});

router.put('/', async (req, res) => {
  let { updateKey } = req.body;

  const rows = await db.executeSelectQuery(
    'SELECT * FROM transactions WHERE id=?',
    [updateKey]
  );

  if (rows.length < 1) {
    return res.status(404).send('There is no transaction with id ' + updateKey);
  }

  const transaction = rows[0];

  if (transaction.isComposed === 0) {
    try {
      await db.executeQuery('DELETE FROM transactions WHERE id=?', [updateKey]);

      if (transaction.composedKeys.length > 0) {
        const children = transaction.composedKeys.split(',');
        for (const child of children) {
          await db.executeQuery('DELETE FROM transactions WHERE id=?', [child]);
        }
      }
    } catch (error) {
      logger.error(error);
      res
        .status(500)
        .send(
          'There was an error while deleting the transactions from the database'
        );
    }

    try {
      await createTransaction({
        isComposed: 0,
        composedKeys: '',
        ...req.body,
      });
      res.status(200).end();
    } catch (error) {
      logger.error(error);
      res
        .status(500)
        .send(
          'There was an error while writing the transaction into the database'
        );
    }
  }
  res.send();
});

router.delete('/records', async (req, res) => {
  await db.executeSelectQuery('DELETE FROM transactions');
  res.status(200).end();
});

router.get('/export', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await db.executeSelectQuery(sql);

  if (transactions.length > 0) {
    let data = Object.keys(transactions[0]).join(';');

    for (const transaction of transactions) {
      data += '\n' + Object.values(transaction).join(';');
    }

    const buffer = Buffer.from(data);
    const filename =
      'coineda-export-' + new Date().toISOString().split('T')[0] + '.csv';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-disposition': 'attachment; filename=' + filename,
    });
    res.write(buffer);
    res.end();
  } else {
    res.status(404).end();
  }
});

const removeDuplicates = async (transactions) => {
  const sql = 'SELECT * FROM transactions';
  let rows = await db.executeSelectQuery(sql);

  rows = rows.map((row) => {
    let {
      exchange,
      fromValue,
      fromCurrency,
      toValue,
      toCurrency,
      feeValue,
      feeCurrency,
      date,
      isComposed,
    } = row;
    return `${exchange}${fromValue}${fromCurrency}${toValue}${toCurrency}${feeValue}${feeCurrency}${date}${isComposed}`;
  });

  return transactions.filter((transaction) => {
    const {
      exchange,
      fromValue,
      fromCurrency,
      toValue,
      toCurrency,
      feeValue,
      feeCurrency,
      date,
      isComposed,
    } = transaction;
    const vector = `${exchange}${fromValue}${fromCurrency}${toValue}${toCurrency}${feeValue}${feeCurrency}${date}${isComposed}`;

    return rows.findIndex((row) => row === vector) === -1;
  });
};

router.post('/import', fileUpload(), async (req, res) => {
  if (typeof req.files.files === undefined) {
    return res.status(400).send('No files provided');
  }

  const textToTransactions = (text) => {
    const rows = text.split('\n');
    const transactions = [];

    let keys = [];

    for (let i = 0; i < rows.length; i++) {
      if (i === 0) {
        keys = rows[0].split(';');
      } else {
        const transaction = {};
        const fields = rows[i].split(';');

        let key = 0;
        for (const field of fields) {
          if (keys[key] === 'id') {
            transaction[keys[key]] = Number(field);
          } else {
            transaction[keys[key]] = field;
          }
          key += 1;
        }
        transactions.push(transaction);
      }
    }

    return transactions;
  };

  let transactions = [];
  if (req.files.files instanceof Array) {
    for (const file of req.files.files) {
      const data = file.data.toString();
      transactions = [transactions, ...textToTransactions(data)];
    }
  } else {
    const data = req.files.files.data.toString();
    transactions = textToTransactions(data);
  }

  let totalTransactions = transactions.length;
  transactions = await removeDuplicates(transactions);
  let duplicates = totalTransactions - transactions.length;

  transactions = transactions.filter(
    (transaction) => transaction.isComposed !== '1'
  );

  const exchanges = await db.executeSelectQuery('SELECT * FROM exchanges');

  let errors = 0;
  for (const transaction of transactions) {
    try {
      await createTransaction(transaction);

      if (
        exchanges.findIndex(
          (exchange) => exchange.name === transaction.exchange
        ) === -1
      ) {
        await db.executeQuery(
          'INSERT INTO exchanges (name) VALUES (?)',
          transaction.exchange
        );
        exchanges.push({ name: transaction.exchange });
      }
    } catch (error) {
      logger.error(error);
      if (transaction.type === TransactionType.SWAP) {
        errors += 3;
      } else {
        errors += 1;
      }
    }
  }

  return res.json({
    inserts: totalTransactions - duplicates - errors,
    duplicates: duplicates,
    errors: errors,
  });
});

module.exports = router;
