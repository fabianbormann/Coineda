import storage from '../persistence/storage';
import { TransactionType, getAssetSymbol, fetchPrice } from './common';
import dayjs from 'dayjs';

const calculateTax = async (account) => {
  const transactions = await storage.transactions.getAllFromAccount(account);
  for (const transaction of transactions) {
    transaction.date = new Date(transaction.date);
  }

  transactions.sort((a, b) => a.date - b.date);

  const coins = {};

  for (const transaction of transactions) {
    if (transaction.type === TransactionType.BUY) {
      if (typeof coins[transaction.toCurrency] === 'undefined') {
        coins[transaction.toCurrency] = [
          {
            value: transaction.toValue,
            gain: 0,
            symbol: await getAssetSymbol(transaction.toCurrency),
            ...transaction,
          },
        ];
      } else {
        coins[transaction.toCurrency].push({
          value: transaction.toValue,
          gain: 0,
          symbol: await getAssetSymbol(transaction.toCurrency),
          ...transaction,
        });
      }
    }
  }

  const tax = {
    realizedGains: {},
    unrealizedGains: {},
  };

  for (const coin of Object.keys(coins)) {
    coins[coin].sort((a, b) =>
      a.date < b.date ? -1 : Number(a.date > b.date)
    );

    tax.realizedGains[coin] = [...coins[coin]];
    tax.unrealizedGains[coin] = [];
  }

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
          tax.realizedGains[transaction.fromCurrency].push({
            ...transaction,
            currency: transaction.fromCurrency,
            symbol: await getAssetSymbol(transaction.fromCurrency),
            amount: amount,
            gain: amount * gainInEuro,
            daysFromPurchase: dayjs(transaction.date).diff(
              target[i].date,
              'days'
            ),
          });
          amount = 0;
        } else {
          tax.realizedGains[transaction.fromCurrency].push({
            ...transaction,
            currency: transaction.fromCurrency,
            symbol: await getAssetSymbol(transaction.fromCurrency),
            amount: amount + target[i].value,
            gain: (amount + target[i].value) * gainInEuro,
            daysFromPurchase: dayjs(transaction.date).diff(
              target[i].date,
              'days'
            ),
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
        const purchasePrice = transaction.fromValue / transaction.toValue;
        const sellingPrice = currentPrices[coin.toLowerCase()];

        const gainInEuro = sellingPrice - purchasePrice;

        tax.unrealizedGains[coin].push({
          ...transaction,
          amount: transaction.value,
          gain: transaction.value * gainInEuro,
          daysFromPurchase: dayjs().diff(dayjs(transaction.date), 'days'),
        });
      }
    }
  }

  return tax;
};

export { calculateTax };
