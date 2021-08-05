const express = require('express');
const app = express();
const PORT = 5208;

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('coineda.db');
const cors = require('cors');

app.use(express.json());

const bunyan = require('bunyan');
const { default: axios } = require('axios');
const logger = bunyan.createLogger({ name: 'coineda-backend' });

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

const fs = require('fs');
const path = require('path');

const fetchAssets = () =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'settings', 'assets.json'))
  );

const executeSelectQuery = (query, params) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
};

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
});

const executeQuery = (query, params) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

const isFiat = (asset) => {
  const settings = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'settings', 'assets.json'))
  );

  return settings.fiat.map((currency) => currency.id).includes(asset);
};

app.use(cors());

app.get('/alive', (req, res) => {
  return res.status(200).end();
});

app.get('/coins', async (req, res) => {
  let data = {};

  try {
    data = (await CoinGeckoClient.coins.markets()).data;
  } catch (error) {
    logger.error(error);
    return res.status(500).send('Unable to fetch meta data from coingecko.');
  }

  data = data.map((asset) => {
    const { id, symbol, name } = asset;
    return {
      id: id,
      symbol: symbol,
      name: name,
    };
  });

  if (req.query.override === 'assets') {
    let assets = fetchAssets();
    assets['cryptocurrencies'] = data;

    try {
      fs.writeFileSync(
        path.resolve(__dirname, 'settings', 'assets-override.json'),
        JSON.stringify(assets, undefined, 2)
      );
    } catch (error) {
      logger.error(error);
      return res
        .status(500)
        .send('Unable to write assets-override.json into settings folder.');
    }
  }

  res.json(data);
});

app.get('/summary', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await executeSelectQuery(sql);

  const coins = { cryptocurrencies: {}, fiat: {} };
  const calculateBalance = (currency, value, add) => {
    currency = currency.toLowerCase();
    const target = isFiat(currency) ? 'fiat' : 'cryptocurrencies';

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

  const assets = fetchAssets();

  const calculatePurchasePrice = (transaction) => {
    const targetCurrency = transaction.toCurrency.toLowerCase();
    if (transaction.type === TransactionType.BUY) {
      let purchasePrice = transaction.fromValue / transaction.toValue;
      if (transaction.fromCurrency.toLowerCase() !== 'euro') {
        const fiat = assets.fiat.find(
          (currency) => currency.id === transaction.fromCurrency.toLowerCase()
        );
        purchasePrice =
          (transaction.fromValue * fiat['roughly_estimated_in_euro']) /
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

    calculateBalance(toCurrency, toValue, true);
    calculateBalance(fromCurrency, fromValue, false);
    calculateBalance(feeCurrency, feeValue, false);
    calculatePurchasePrice(transaction);
  }

  for (const coin of Object.keys(coins.cryptocurrencies)) {
    if (coins.cryptocurrencies[coin].value === 0) {
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

app.post('/exchange', async (req, res) => {
  try {
    await executeQuery(
      'INSERT INTO exchanges (name) VALUES (?)',
      req.body.name
    );
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Error while trying to persist the new exchange');
  }
});

app.get('/assets', (req, res) => {
  axios
    .get('https://api.coincap.io/v2/assets')
    .then((response) => {
      return res.json(
        response.data.data.map((asset) => `${asset.name} (${asset.symbol}`)
      );
    })
    .catch((error) => {
      logger.error(error);
      return res.json([]);
    });
});

app.post('/transaction', async (req, res) => {
  let {
    exchange,
    fromValue,
    fromCurrency,
    toValue,
    toCurrency,
    feeValue,
    feeCurrency,
    date,
  } = req.body;
  const sql =
    'INSERT INTO transactions (type, exchange, fromValue, fromCurrency, toValue, toCurrency, feeValue, feeCurrency, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

  let transactionType = TransactionType.BUY;
  if (!isFiat(fromCurrency) && isFiat(toCurrency)) {
    transactionType = TransactionType.SELL;
  } else if (!isFiat(fromCurrency) && !isFiat(toCurrency)) {
    transactionType = TransactionType.SELL;

    let price = await CoinGeckoClient.coins.fetchMarketChartRange(
      fromCurrency,
      {
        from: new Date(date).getTime(),
        to: new Date(date).getTime(),
        vs_currency: 'eur',
      }
    );

    await executeQuery(sql, [
      transactionType,
      exchange,
      fromValue,
      fromCurrency.toUpperCase(),
      price * fromValue,
      'EUR',
      feeValue,
      feeCurrency.toUpperCase(),
      date,
    ]);

    transactionType = TransactionType.BUY;
    price = await CoinGeckoClient.coins.fetchMarketChartRange(toCurrency, {
      from: new Date(date).getTime(),
      to: new Date(date).getTime(),
      vs_currency: 'eur',
    });

    fromCurrency = 'EUR';
    fromValue = price * toValue;
  }

  try {
    await executeQuery(sql, [
      transactionType,
      exchange,
      fromValue,
      fromCurrency.toUpperCase(),
      toValue,
      toCurrency.toUpperCase(),
      feeValue,
      feeCurrency.toUpperCase(),
      date,
    ]);
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

app.get('/transactions', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await executeSelectQuery(sql);
  return res.json(transactions);
});

app.get('/exchange', async (req, res) => {
  const sql = 'SELECT * FROM exchanges';
  const exchanges = await executeSelectQuery(sql);
  return res.json(exchanges);
});

const server = app.listen(PORT, async () => {
  logger.info('Coineda backend listening on localhost port ' + PORT);

  await executeQuery(
    'CREATE TABLE IF NOT EXISTS exchanges (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)'
  );
  await executeQuery(
    `CREATE TABLE IF NOT EXISTS transactions 
      (id INTEGER PRIMARY KEY, 
       type TEXT NOT NULL,
       exchange TEXT NOT NULL, 
       fromValue REAL NOT NULL, 
       fromCurrency TEXT NOT NULL, 
       toValue REAL NOT NULL, 
       toCurrency TEXT NOT NULL, 
       feeValue REAL NOT NULL, 
       feeCurrency TEXT NOT NULL,
       comment TEXT,
       date TIMESTAMP NOT NULL,
       created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
  );
});

exports.server = server;
