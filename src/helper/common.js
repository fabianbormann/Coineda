import storage from '../persistence/storage';

const TransactionType = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  SEND: 'send',
  RECEIVE: 'receive',
  REWARDS: 'rewards',
  SWAP: 'swap',
});

const isFiat = async (assetId) => {
  const currency = await storage.assets.get(assetId);
  return currency.isFiat === 1;
};

export { TransactionType, isFiat };
