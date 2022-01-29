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
    account,
  } = transaction;

  const sql =
    'INSERT INTO transactions (type, exchange, fromValue, fromCurrency, toValue, toCurrency, feeValue, feeCurrency, isComposed, composedKeys, date, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  const fromCurrencyIsFiat = await isFiat(fromCurrency);
  const toCurrencyIsFiat = await isFiat(toCurrency);

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

    try {
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
    } catch (error) {
      logger.warn(
        `Failed to fetch price in range ${fromTimestamp} - ${toTimestamp} for currency ${fromCurrency.toLowerCase()}`
      );
      throw error;
    }

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
      account,
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
    account,
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
      account,
    ]);

    for (const child of children) {
      await db.executeQuery('UPDATE transactions SET parent=? WHERE id=?', [
        parent.lastID,
        child.id,
      ]);
    }
  }
};

module.exports = {
  createTransaction: createTransaction,
};
