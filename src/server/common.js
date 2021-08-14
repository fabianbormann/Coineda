const fs = require('fs');
const path = require('path');

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
});

const isFiat = (asset) => {
  const settings = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'settings', 'assets.json'))
  );

  return settings.fiat.map((currency) => currency.id).includes(asset);
};

const fetchAssets = () =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'settings', 'assets.json'))
  );

module.exports = {
  TransactionType: TransactionType,
  isFiat: isFiat,
  fetchAssets: fetchAssets,
};
