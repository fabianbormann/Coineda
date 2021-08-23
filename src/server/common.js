const db = require('./database/helper.js');

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
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

module.exports = {
  TransactionType: TransactionType,
  isFiat: isFiat,
  fetchAssets: fetchAssets,
};
