const db = require('./database/helper.js');

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
});

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

const NodeCache = require('node-cache');
const TIMEOUT = 24 * 60 * 60;
const CoinedaCache = new NodeCache({
  stdTTL: TIMEOUT,
  checkperiod: 60 * 60,
});

const isFiat = async (asset) => {
  const currencies = await db.executeSelectQuery(
    'SELECT * FROM assets WHERE isFiat=1'
  );

  return currencies
    .map((currency) => currency.id.toLowerCase())
    .includes(asset.toLowerCase());
};

const fetchAssets = async () => {
  const assets = await db.executeSelectQuery('SELECT * FROM assets');

  return {
    fiat: assets.filter((asset) => asset.isFiat === 1),
    cryptocurrencies: assets.filter((asset) => asset.isFiat === 0),
  };
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
  TransactionType: TransactionType,
  isFiat: isFiat,
  fetchAssets: fetchAssets,
  fetchPrice: fetchPrice,
};
