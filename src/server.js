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
  SWAP: 'swap',
});

const executeQuery = (query, params) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve(this);
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

    await executeQuery(sql, [
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

  await executeQuery(sql, [
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

    const children = await executeSelectQuery(
      'SELECT * FROM transactions ORDER BY id DESC LIMIT 2'
    );

    const parent = await executeQuery(sql, [
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
      await executeQuery('UPDATE transactions SET parent=? WHERE id=?', [
        parent.lastID,
        child.id,
      ]);
    }
  }
};

app.get('/transactions', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await executeSelectQuery(sql);
  return res.json(transactions);
});

app.delete('/transactions', async (req, res) => {
  const sql = `DELETE FROM transactions WHERE id IN (
    ${req.body.transactions.join(', ')})`;

  try {
    await executeSelectQuery(sql);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).json(error);
  }
});

app.put('/transaction', async (req, res) => {
  let { updateKey } = req.body;

  const rows = await executeSelectQuery(
    'SELECT * FROM transactions WHERE id=?',
    [updateKey]
  );

  if (rows.length < 1) {
    return res.status(404).send('There is no transaction with id ' + updateKey);
  }

  const transaction = rows[0];

  if (transaction.isComposed === 0) {
    try {
      await executeQuery('DELETE FROM transactions WHERE id=?', [updateKey]);

      if (transaction.composedKeys.length > 0) {
        const children = transaction.composedKeys.split(',');
        for (const child of children) {
          await executeQuery('DELETE FROM transactions WHERE id=?', [child]);
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

app.post('/transaction', async (req, res) => {
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

app.get('/transactions', async (req, res) => {
  const sql = 'SELECT * FROM transactions';
  const transactions = await executeSelectQuery(sql);
  return res.json(transactions);
});

app.delete('/transactions', async (req, res) => {
  const sql = `DELETE FROM transactions WHERE id IN (
    ${req.body.transactions.join(', ')})`;

  try {
    await executeSelectQuery(sql);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).json(error);
  }
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
       isComposed INTEGER NOT NULL DEFAULT 0,
       parent INTEGER,
       composedKeys TEXT,
       created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
  );
});

exports.server = server;
