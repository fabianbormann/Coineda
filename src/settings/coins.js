const express = require('express');
const router = express.Router();

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-exchange' });

const common = require('../common.js');
const { fetchAssets } = common;

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

const fs = require('fs');
const path = require('path');

router.get('/', async (req, res) => {
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

module.exports = router;
