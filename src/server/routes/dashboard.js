const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-exchange' });

const common = require('../common.js');
const { isFiat, TransactionType, fetchAssets } = common;

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

router.get('/summary', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await db.executeSelectQuery(sql);

  const coins = { cryptocurrencies: {}, fiat: {} };

  const calculateBalance = async (currency, value, add) => {
    currency = currency.toLowerCase();
    const target = (await isFiat(currency)) ? 'fiat' : 'cryptocurrencies';

    coins[target][currency] = coins[target][currency] || {};

    if (coins[target][currency].hasOwnProperty('value')) {
      if (add) {
        coins[target][currency].value += value;
      } else {
        coins[target][currency].value -= value;
      }
    } else {
      if (add) {
        coins[target][currency].value = value;
      } else {
        coins[target][currency].value = -value;
      }
    }
  };

  const assets = await fetchAssets();

  const calculatePurchasePrice = (transaction) => {
    const targetCurrency = transaction.toCurrency.toLowerCase();
    if (transaction.type === TransactionType.BUY) {
      let purchasePrice = transaction.fromValue / transaction.toValue;
      if (transaction.fromCurrency.toLowerCase() !== 'euro') {
        const fiat = assets.fiat.find(
          (currency) => currency.id === transaction.fromCurrency.toLowerCase()
        );
        purchasePrice =
          (transaction.fromValue * fiat['roughlyEstimatedInEuro']) /
          transaction.toValue;
      }

      if (
        coins.cryptocurrencies[targetCurrency].hasOwnProperty('purchase_price')
      ) {
        coins.cryptocurrencies[targetCurrency].purchase_price.push(
          purchasePrice
        );
      } else {
        coins.cryptocurrencies[targetCurrency].purchase_price = [purchasePrice];
      }
    }
  };

  for (const transaction of transactions) {
    const {
      fromValue,
      fromCurrency,
      toValue,
      toCurrency,
      feeValue,
      feeCurrency,
    } = transaction;

    if (
      transaction.type === TransactionType.BUY ||
      transaction.type === TransactionType.SELL
    ) {
      await calculateBalance(toCurrency, toValue, true);
      await calculateBalance(fromCurrency, fromValue, false);
      await calculateBalance(feeCurrency, feeValue, false);
      calculatePurchasePrice(transaction);
    }
  }

  coins['inconsistency'] = { negativeValue: [] };

  for (const coin of Object.keys(coins.cryptocurrencies)) {
    if (coins.cryptocurrencies[coin].value === 0) {
      delete coins.cryptocurrencies[coin];
    } else if (coins.cryptocurrencies[coin].value < 0) {
      coins.inconsistency.negativeValue.push({
        ...coins.cryptocurrencies[coin],
        name: coin,
      });
      delete coins.cryptocurrencies[coin];
    } else {
      coins.cryptocurrencies[coin].purchase_price =
        coins.cryptocurrencies[coin].purchase_price.reduce(
          (previous, current) => current + previous,
          0
        ) / coins.cryptocurrencies[coin].purchase_price.length;
    }
  }

  let data = {};

  try {
    data = (
      await CoinGeckoClient.simple.price({
        ids: Object.keys(coins.cryptocurrencies),
        vs_currencies: 'eur',
      })
    ).data;
  } catch (error) {
    logger.error(error);
    return res.status(500).send('Unable to fetch meta data from coingecko.');
  }

  for (const coin in data) {
    coins.cryptocurrencies[coin].price_in_euro =
      data[coin].eur * coins.cryptocurrencies[coin].value;
    coins.cryptocurrencies[coin].current_price = data[coin].eur;
    coins['crypto_total_in_euro'] = coins['crypto_total_in_euro'] || 0;
    coins['crypto_total_in_euro'] += coins.cryptocurrencies[coin].price_in_euro;
  }

  res.json(coins);
});

module.exports = router;
