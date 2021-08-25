const express = require('express');
const router = express.Router();
const common = require('../common.js');
const db = require('../database/helper.js');

router.get('/', async (req, res) => {
  const assets = await common.fetchAssets();
  return res.json(assets);
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
      assets.find((currency) => currency.id == asset)
    ),
    ...assets.filter((asset) => !tradedAssets.includes(asset.id)),
  ]);
});

module.exports = router;
