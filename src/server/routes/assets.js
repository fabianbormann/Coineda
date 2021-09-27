const { default: axios } = require('axios');
const express = require('express');
const router = express.Router();
const common = require('../common.js');
const db = require('../database/helper.js');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-assets' });

const NodeCache = require('node-cache');
const TIMEOUT = 24 * 60 * 60;
const CoinedaCache = new NodeCache({
  stdTTL: TIMEOUT,
  checkperiod: 2 * TIMEOUT,
});

router.get('/', async (req, res) => {
  const assets = await common.fetchAssets();
  return res.json(assets);
});

router.post('/', async (req, res) => {
  const asset = req.body.asset;
  const assets = await common.fetchAssets();

  if (
    assets['cryptocurrencies'].filter((coin) => coin.id === asset.id).length > 0
  ) {
    return res.status(203).send('Already exists');
  }
  try {
    await db.executeQuery(
      'INSERT INTO assets (id, symbol, name) VALUES (?, ?, ?)',
      [asset.id, asset.symbol, asset.name]
    );
    res.status(200).end();
  } catch (error) {
    logger.warn(error);
    res.status(500).send('Failed to add asset to database');
  }
});

router.get('/search/:symbol', async (req, res) => {
  const tokenList = CoinedaCache.get('TOKEN_LIST');

  if (typeof tokenList === 'undefined') {
    try {
      const coins = await axios.get(
        'https://api.coingecko.com/api/v3/coins/list'
      );
      logger.info('Save token list in cache');
      CoinedaCache.set('TOKEN_LIST', coins.data);
      const targets = coins.data.filter(
        (coin) => coin.symbol.toLowerCase() === req.params.symbol.toLowerCase()
      );
      res.json(targets);
    } catch (error) {
      logger.warn(error);
      res.status(500).send('Unable to fetch data from api.coingecko.com');
    }
  } else {
    logger.info('Read token list from cache');
    const targets = tokenList.filter(
      (coin) => coin.symbol.toLowerCase() === req.params.symbol.toLowerCase()
    );
    res.json(targets);
  }
});

router.get('/sorted', async (req, res) => {
  let transactions = await db.executeSelectQuery('SELECT * FROM transactions');
  transactions = [
    ...transactions.map((transaction) => transaction.toCurrency.toLowerCase()),
    ...transactions.map((transaction) =>
      transaction.fromCurrency.toLowerCase()
    ),
  ];

  let frequency = transactions.reduce(
    (previous, current) => ({
      ...previous,
      [current]: (previous[current] || 0) + 1,
    }),
    {}
  );

  transactions.sort((a, b) => frequency[a] - frequency[b]);
  const tradedAssets = [...new Set(transactions)];

  let assets = await common.fetchAssets();
  assets = [...assets.cryptocurrencies, ...assets.fiat];

  res.json([
    ...tradedAssets.map((asset) =>
      assets.find((currency) => currency.id === asset)
    ),
    ...assets.filter((asset) => !tradedAssets.includes(asset.id)),
  ]);
});

module.exports = router;
