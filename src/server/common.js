const version = {
  major: 0,
  minor: 1,
  patch: 8,
};

const db = require('./database/helper.js');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-common' });

const axios = require('axios');

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
});

const CoinedaError = Object.freeze({
  UNKOWN_TOKEN_SYMBOL: { message: 'Unkown token symbol', code: 0 },
});

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

const NodeCache = require('node-cache');
const TIMEOUT = 24 * 60 * 60;
const CoinedaCache = new NodeCache({
  stdTTL: TIMEOUT,
  checkperiod: 60 * 60,
});

const isFiat = async (assetId) => {
  const currency = await db.executeSelectQuery(
    'SELECT isFiat FROM assets WHERE lower(id)=?',
    [assetId.toLowerCase()]
  );

  if (currency.length === 0) {
    return false;
  } else {
    return currency[0].isFiat;
  }
};

const fetchAssets = async () => {
  const assets = await db.executeSelectQuery('SELECT * FROM assets');

  return {
    fiat: assets.filter((asset) => asset.isFiat === 1),
    cryptocurrencies: assets.filter((asset) => asset.isFiat === 0),
  };
};

const getBinanceTokenPair = async (binanceSymbol) => {
  let pair = CoinedaCache.get(`binance-pair-${binanceSymbol.toLowerCase()}`);
  if (typeof pair === 'undefined') {
    try {
      const response = await axios.get(
        'https://api.binance.com/api/v3/exchangeInfo?symbol=' + binanceSymbol
      );

      const fromCurrency = response.data.symbols[0].baseAsset;
      const toCurrency = response.data.symbols[0].quoteAsset;

      CoinedaCache.set(
        `binance-pair-${binanceSymbol.toLowerCase()}`,
        { fromCurrency, toCurrency },
        365 * TIMEOUT
      );

      return { fromCurrency, toCurrency };
    } catch (error) {
      logger.error(error);
      return {
        fromCurrency: null,
        toCurrency: null,
      };
    }
  } else {
    return pair;
  }
};

const getAssetSymbol = async (id) => {
  const result = await db.executeSelectQuery(
    'SELECT symbol FROM assets WHERE id=?',
    id.toLowerCase()
  );
  return result[0].symbol;
};

const getAssetId = async (symbol) => {
  const result = await db.executeSelectQuery(
    'SELECT id FROM assets WHERE lower(symbol)=?',
    symbol.toLowerCase()
  );
  if (result.length === 0) {
    logger.warn('No id found for symbol ' + symbol);
    throw CoinedaError.UNKOWN_TOKEN_SYMBOL;
  } else {
    return result[0].id;
  }
};

const fetchPrice = async (currency, date = null) => {
  let fetchSingle = true;
  if (typeof currency !== 'string') {
    currency = currency.join(',');
    fetchSingle = false;
  }

  if (date) {
    const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
    const fromTimestamp = Math.floor(
      (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
    );

    let price = CoinedaCache.get(
      `${fromTimestamp}-${toTimestamp}-${currency.toLowerCase()}`
    );

    if (typeof price !== 'undefined') {
      return price;
    } else {
      price = (
        await CoinGeckoClient.coins.fetchMarketChartRange(
          currency.toLowerCase(),
          {
            from: fromTimestamp,
            to: toTimestamp,
            vs_currency: 'eur',
          }
        )
      ).data.prices[0][1];
      CoinedaCache.set(
        `${fromTimestamp}-${toTimestamp}-${currency.toLowerCase()}`,
        price,
        14 * TIMEOUT
      );
      return price;
    }
  } else {
    let price = CoinedaCache.get(`simple-price-${currency.toLowerCase()}`);
    if (typeof price !== 'undefined') {
      return price;
    } else {
      if (fetchSingle) {
        price = (
          await CoinGeckoClient.simple.price({
            ids: currency,
            vs_currencies: 'eur',
          })
        ).data[currency.toLowerCase()].eur;

        CoinedaCache.set(
          `simple-price-${currency.toLowerCase()}`,
          price,
          60 * 15
        );
        return price;
      } else {
        const response = await CoinGeckoClient.simple.price({
          ids: currency,
          vs_currencies: 'eur',
        });

        const prices = {};
        for (const coin of Object.keys(response.data)) {
          prices[coin] = response.data[coin].eur;
        }

        CoinedaCache.set(
          `simple-price-${currency.toLowerCase()}`,
          prices,
          60 * 15
        );
        return prices;
      }
    }
  }
};

module.exports = {
  TransactionType,
  CoinedaError,
  isFiat,
  fetchAssets,
  fetchPrice,
  getAssetSymbol,
  getAssetId,
  getBinanceTokenPair,
  version,
};
