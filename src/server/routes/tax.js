const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const { TransactionType, fetchPrice } = require('../common');
const logger = bunyan.createLogger({ name: 'coineda-backend-tax' });
const moment = require('moment');

router.get('/:account', async (req, res) => {
  const sql = 'SELECT * FROM transactions WHERE account=? ORDER BY date';
  const transactions = await db.executeSelectQuery(sql, [req.params.account]);

  const coins = {};

  for (const transaction of transactions) {
    if (transaction.type === TransactionType.BUY) {
      if (typeof coins[transaction.toCurrency] === 'undefined') {
        coins[transaction.toCurrency] = [
          {
            value: transaction.toValue,
            date: transaction.date,
          },
        ];
      } else {
        coins[transaction.toCurrency].push({
          value: transaction.toValue,
          date: transaction.date,
        });
      }
    }
  }

  for (const coin of Object.keys(coins)) {
    coins[coin].sort((a, b) =>
      a.date < b.date ? -1 : Number(a.date > b.date)
    );
  }

  const tax = {
    realizedGains: [],
    unrealizedGains: [],
  };

  for (const transaction of transactions) {
    if (transaction.type === TransactionType.SELL) {
      let amount = transaction.fromValue;
      let target = coins[transaction.fromCurrency];

      for (let i = 0; i < target.length; i++) {
        target[i].value -= amount;

        const purchasePrice = await fetchPrice(
          transaction.fromCurrency,
          target[i].date
        );
        const sellingPrice = await fetchPrice(
          transaction.fromCurrency,
          transaction.date
        );

        const gainInEuro = sellingPrice - purchasePrice;

        if (target[i].value > 0) {
          tax.realizedGains.push({
            currency: transaction.fromCurrency,
            amount: amount,
            gain: amount * gainInEuro,
            daysFromPurchase: moment(transaction.date).diff(
              target[i].date,
              'days'
            ),
            date: transaction.date,
          });
          amount = 0;
        } else {
          tax.realizedGains.push({
            currency: transaction.fromCurrency,
            amount: amount + target[i].value,
            gain: (amount + target[i].value) * gainInEuro,
            daysFromPurchase: moment(transaction.date).diff(
              target[i].date,
              'days'
            ),
            date: transaction.date,
          });

          amount = Math.abs(target[i].value);
          target[i].value = 0;
        }

        if (amount === 0) {
          break;
        }
      }

      coins[transaction.fromCurrency] = coins[transaction.fromCurrency].filter(
        (coin) => coin.value > 0
      );
    }
  }

  const currentPrices = await fetchPrice(Object.keys(coins));

  for (const coin of Object.keys(coins)) {
    if (coins[coin].length > 0) {
      for (const transaction of coins[coin]) {
        const purchasePrice = await fetchPrice(coin, transaction.date);
        const sellingPrice = currentPrices[coin.toLowerCase()];

        const gainInEuro = sellingPrice - purchasePrice;

        tax.unrealizedGains.push({
          amount: transaction.value,
          gain: transaction.value * gainInEuro,
          date: transaction.date,
          currency: coin,
          daysFromPurchase: moment().diff(moment(transaction.date), 'days'),
        });
      }
    }
  }

  return res.json(tax);
});

module.exports = router;
