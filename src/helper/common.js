import storage from '../persistence/storage';
import axios from 'axios';

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
});

const isFiat = async (assetId) => {
  const currency = await storage.assets.get(assetId.toLowerCase());
  return currency.isFiat === 1;
};

const createTransaction = async (transaction, account, message) => {
  let {
    exchange,
    fromValue,
    fromCurrency,
    toValue,
    toCurrency,
    feeValue,
    feeCurrency,
    date,
  } = transaction;

  fromValue = Number(fromValue);
  toValue = Number(toValue);
  feeValue = Number(feeValue);

  if (typeof date === 'string') {
    date = Number(date);
  }

  const fromCurrencyIsFiat = await isFiat(fromCurrency);
  const toCurrencyIsFiat = await isFiat(toCurrency);
  const children = [];
  let isSwap = false;

  let transactionType = TransactionType.BUY;
  if (!fromCurrencyIsFiat && toCurrencyIsFiat) {
    transactionType = TransactionType.SELL;
  } else if (!fromCurrencyIsFiat && !toCurrencyIsFiat) {
    isSwap = true;
    transactionType = TransactionType.SELL;
    let price = 0;
    const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
    const fromTimestamp = Math.floor(
      (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
    );

    try {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${fromCurrency.toLowerCase()}/market_chart/range?vs_currency=eur&from=${fromTimestamp}&to=${toTimestamp}`
      );
      price = response.data.prices[0][1];
    } catch (error) {
      console.log(error);
      if (typeof message !== 'undefined') {
        message.error(
          'Failed to fetch price from CoinGeckoApi. Please try again later.'
        );
      }
      return;
    }

    console.log(date);

    const sellTransaction = {
      type: transactionType,
      exchange: exchange,
      fromValue: fromValue,
      fromCurrency: fromCurrency.toUpperCase(),
      toValue: price * fromValue,
      toCurrency: 'euro',
      feeValue: feeValue,
      feeCurrency: feeCurrency.toUpperCase(),
      isComposed: false,
      parent: undefined,
      composedKeys: undefined,
      date:
        typeof date === 'object'
          ? date.unix() * 1000
          : new Date(date).getTime(),
      account: account,
    };

    const key = await storage.transactions.add(sellTransaction);
    children.push({
      id: key,
      ...sellTransaction,
    });

    transactionType = TransactionType.BUY;

    fromCurrency = 'euro';
    fromValue = Math.round(price * fromValue * 100) / 100;
  }

  const buyTransaction = {
    type: transactionType,
    exchange: exchange,
    fromValue: fromValue,
    fromCurrency: fromCurrency.toUpperCase(),
    toValue: toValue,
    toCurrency: toCurrency.toUpperCase(),
    feeValue: feeValue,
    feeCurrency: feeCurrency.toUpperCase(),
    isComposed: false,
    parent: undefined,
    composedKeys: undefined,
    date:
      typeof date === 'object' ? date.unix() * 1000 : new Date(date).getTime(),
    account: account,
  };

  const key = await storage.transactions.add(buyTransaction);

  children.push({
    id: key,
    ...buyTransaction,
  });

  if (isSwap) {
    transactionType = TransactionType.SWAP;

    const parent = await storage.transactions.add({
      type: transactionType,
      exchange: exchange,
      fromValue: children[0].fromValue,
      fromCurrency: children[0].fromCurrency,
      toValue: children[1].toValue,
      toCurrency: children[1].toCurrency,
      feeValue: feeValue,
      feeCurrency: feeCurrency.toUpperCase(),
      isComposed: true,
      parent: undefined,
      composedKeys: `${children[0].id},${children[1].id}`,
      date:
        typeof date === 'object'
          ? date.unix() * 1000
          : new Date(date).getTime(),
      account: account,
    });

    for (const child of children) {
      storage.transactions.put({
        ...child,
        parent: parent,
      });
    }
  }
};

const getAssetId = async (symbol) => {
  const result = await storage.assets.getBySymbol(symbol.toUpperCase().trim());

  if (result.length > 0) {
    return result[0].id;
  } else {
    return null;
  }
};

const getAssetSymbol = async (id) => {
  const result = await storage.assets.get(id.toLowerCase());
  if (result) {
    return result.symbol;
  } else {
    return null;
  }
};

const getPurchaseValue = async (currency, account) => {
  let transactions = await storage.transactions.getAllFromAccount(account);
  transactions = transactions.filter(
    (transaction) =>
      (transaction.fromCurrency === currency.toUpperCase() ||
        transaction.toCurrency === currency.toUpperCase()) &&
      transaction.type !== TransactionType.SWAP
  );

  let buyTransactions = transactions.filter(
    (transaction) => transaction.type === TransactionType.BUY
  );
  let sellTransactions = transactions.filter(
    (transaction) => transaction.type === TransactionType.SELL
  );

  buyTransactions = buyTransactions.map((transaction) => ({
    ...transaction,
    value: transaction.toValue,
  }));
  buyTransactions.sort((a, b) => new Date(a.date) - new Date(b.date));
  sellTransactions.sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const sellTransaction of sellTransactions) {
    let amount = Number(sellTransaction.fromValue);

    while (amount > 0 && buyTransactions.length > 0) {
      let value = Number(buyTransactions[0].value) - amount;

      if (value > 0) {
        buyTransactions[0].value = value;
        amount = 0;
      } else {
        amount -= Number(buyTransactions[0].value);
        buyTransactions.shift();
      }
    }
  }

  if (buyTransactions.length > 0) {
    let purchaseValue = 0;
    for (const buyTransaction of buyTransactions) {
      purchaseValue +=
        (Number(buyTransaction.fromValue) / Number(buyTransaction.toValue)) *
        Number(buyTransaction.value);
    }

    return purchaseValue;
  } else {
    return 0;
  }
};

const getCoinCount = async (currency, date, account) => {
  let transactions = await storage.transactions.getAllFromAccount(account);

  transactions = transactions.filter(
    (transaction) =>
      (transaction.fromCurrency === currency.toUpperCase() ||
        transaction.toCurrency === currency.toUpperCase()) &&
      transaction.type !== TransactionType.SWAP &&
      transaction.date <= date.getTime()
  );

  let count = 0;
  for (const transaction of transactions) {
    if (transaction.type === TransactionType.BUY) {
      count += transaction.toValue;
    } else if (transaction.type === TransactionType.SELL) {
      count += transaction.fromValue;
    }
  }

  return count;
};

const fetchPrice = async (currency, date = null) => {
  let fetchSingle = true;
  if (typeof currency !== 'string') {
    currency = currency.join(',');
    fetchSingle = false;
  }
  currency = currency.toLowerCase();

  if (date) {
    const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
    const fromTimestamp = Math.floor(
      (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
    );

    let price = JSON.parse(
      localStorage.getItem(`${fromTimestamp}-${toTimestamp}-${currency}`)
    );

    if (price && new Date().getTime() - price.age < 15 * 60 * 1000) {
      return price.data;
    } else {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${currency}/market_chart/range?vs_currency=eur&from=${fromTimestamp}&to=${toTimestamp}`
      );
      price = response.data.prices[0][1];

      localStorage.setItem(
        `${fromTimestamp}-${toTimestamp}-${currency}`,
        JSON.stringify({
          data: price,
          age: new Date().getTime(),
        })
      );

      return price;
    }
  } else {
    let price = JSON.parse(localStorage.getItem(`simple-price-${currency}`));

    if (price && new Date().getTime() - price.age < 15 * 60 * 1000) {
      return price.data;
    } else {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${currency}&vs_currencies=eur`
      );

      if (fetchSingle) {
        price = Number(response.data[currency].eur);

        localStorage.setItem(
          `simple-price-${currency}`,
          JSON.stringify({
            data: price,
            age: new Date().getTime(),
          })
        );
        return price;
      } else {
        const prices = {};
        for (const coin of Object.keys(response.data)) {
          prices[coin] = Number(response.data[coin].eur);
        }

        localStorage.setItem(
          `simple-price-${currency}`,
          JSON.stringify({
            data: prices,
            age: new Date().getTime(),
          })
        );
        return prices;
      }
    }
  }
};

const colors = [
  '#03A678',
  '#4C75A9',
  '#7D73AF',
  '#AA6FA6',
  '#CB6E91',
  '#009482',
  '#008183',
  '#006E7C',
  '#1E5A6D',
  '#2F4858',
  '#BE76B8',
  '#F980A4',
  '#FF9C84',
  '#FFC86B',
  '#F9F871',
  '#0084BC',
  '#0089AA',
  '#008D8B',
  '#2DAC8D',
  '#6BC985',
  '#AEE379',
  '#F9F871',
  '#197396',
];

export {
  TransactionType,
  isFiat,
  getAssetId,
  getAssetSymbol,
  createTransaction,
  fetchPrice,
  getCoinCount,
  colors,
  getPurchaseValue,
};
