const express = require('express');
const router = express.Router();

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-transactions' });

const db = require('../database/helper.js');
const common = require('../common.js');
const { TransactionType, isFiat } = common;

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

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

  let transactionType = TransactionType.BUY;
  if (!isFiat(fromCurrency) && isFiat(toCurrency)) {
    transactionType = TransactionType.SELL;
  } else if (!isFiat(fromCurrency) && !isFiat(toCurrency)) {
    isComposed = 1;
    transactionType = TransactionType.SELL;
    let price = 0;
    const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
    const fromTimestamp = Math.floor(
      (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
    );

    price = (
      await CoinGeckoClient.coins.fetchMarketChartRange(fromCurrency, {
        from: fromTimestamp,
        to: toTimestamp,
        vs_currency: 'eur',
      })
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

module.exports = router;
