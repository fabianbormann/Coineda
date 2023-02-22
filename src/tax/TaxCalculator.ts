import dayjs from 'dayjs';
import {
  CoinedaAccount,
  TaxResult,
  TaxTransaction,
  Transaction,
} from '../global/types';
import { fetchPrice, getAssetSymbol } from '../helper/common';
import storage from '../persistence/storage';

export default abstract class TaxCalculator {
  abstract name: string;
  abstract label: string;
  abstract taxFreeAfterHoldingPeriod: boolean | number;
  protected realizedGains: { [key: string]: Array<TaxTransaction> } = {};
  protected unrealizedGains: { [key: string]: Array<TaxTransaction> } = {};
  protected taxFreeThreshold = 0;

  protected roundFiat = (value: number) => Math.round(value * 100) / 100;

  protected async getSortedTransactions(
    account: CoinedaAccount
  ): Promise<Array<Transaction>> {
    const transactions: Array<Transaction> =
      await storage.transactions.getAllFromAccount(account.id);
    return transactions.sort((a, b) => a.date - b.date);
  }

  protected async calculateRealizedAndUnrealizedGains(account: CoinedaAccount) {
    this.realizedGains = {};
    this.unrealizedGains = {};
    const transactions = await this.getSortedTransactions(account);

    const coins: { [key: string]: Array<TaxTransaction> } = {};

    for (const transaction of transactions) {
      if (transaction.type === 'buy') {
        if (typeof coins[transaction.toCurrency] === 'undefined') {
          coins[transaction.toCurrency] = [
            {
              ...transaction,
              amount: 0,
              daysFromPurchase: 0,
              value: transaction.toValue,
              gain: 0,
              symbol: await getAssetSymbol(transaction.toCurrency),
            },
          ];
        } else {
          coins[transaction.toCurrency].push({
            ...transaction,
            amount: 0,
            daysFromPurchase: 0,
            value: transaction.toValue,
            gain: 0,
            symbol: await getAssetSymbol(transaction.toCurrency),
          });
        }
      } else if (transaction.type === 'sell') {
        let amount = transaction.fromValue;
        let buyTransactions = coins[transaction.fromCurrency];

        for (const buyTransaction of buyTransactions) {
          buyTransaction.value -= amount;

          const purchasePrice = await fetchPrice(
            transaction.fromCurrency,
            buyTransaction.date
          );

          const sellingPrice = await fetchPrice(
            transaction.fromCurrency,
            transaction.date
          );

          const gainInEuro = sellingPrice - purchasePrice;

          if (buyTransaction.value > 0) {
            if (this.realizedGains[transaction.fromCurrency]) {
              this.realizedGains[transaction.fromCurrency].push({
                ...transaction,
                currency: transaction.fromCurrency,
                symbol: await getAssetSymbol(transaction.fromCurrency),
                amount: amount,
                gain: amount * gainInEuro,
                daysFromPurchase: dayjs(transaction.date).diff(
                  buyTransaction.date,
                  'days'
                ),
              });
            } else {
              this.realizedGains[transaction.fromCurrency] = [
                {
                  ...transaction,
                  currency: transaction.fromCurrency,
                  symbol: await getAssetSymbol(transaction.fromCurrency),
                  amount: amount,
                  gain: amount * gainInEuro,
                  daysFromPurchase: dayjs(transaction.date).diff(
                    buyTransaction.date,
                    'days'
                  ),
                },
              ];
            }
            amount = 0;
          } else {
            if (this.realizedGains[transaction.fromCurrency]) {
              this.realizedGains[transaction.fromCurrency].push({
                ...transaction,
                currency: transaction.fromCurrency,
                symbol: await getAssetSymbol(transaction.fromCurrency),
                amount: amount + buyTransaction.value,
                gain: (amount + buyTransaction.value) * gainInEuro,
                daysFromPurchase: dayjs(transaction.date).diff(
                  buyTransaction.date,
                  'days'
                ),
              });
            } else {
              this.realizedGains[transaction.fromCurrency] = [
                {
                  ...transaction,
                  currency: transaction.fromCurrency,
                  symbol: await getAssetSymbol(transaction.fromCurrency),
                  amount: amount + buyTransaction.value,
                  gain: (amount + buyTransaction.value) * gainInEuro,
                  daysFromPurchase: dayjs(transaction.date).diff(
                    buyTransaction.date,
                    'days'
                  ),
                },
              ];
            }

            amount = Math.abs(buyTransaction.value);
            buyTransaction.value = 0;
          }

          if (amount === 0) {
            break;
          }
        }

        coins[transaction.fromCurrency] = coins[
          transaction.fromCurrency
        ].filter((coin) => coin.value > 0);
      }
    }

    const currentPrices = await fetchPrice(Object.keys(coins));

    for (const coin of Object.keys(coins)) {
      if (coins[coin].length > 0) {
        for (const transaction of coins[coin]) {
          const purchasePrice = transaction.fromValue / transaction.toValue;
          const sellingPrice = currentPrices[coin.toLowerCase()];

          const gainInEuro = sellingPrice - purchasePrice;

          if (this.unrealizedGains[coin]) {
            this.unrealizedGains[coin].push({
              ...transaction,
              amount: transaction.value,
              gain: transaction.value * gainInEuro,
              daysFromPurchase: dayjs().diff(dayjs(transaction.date), 'days'),
            });
          } else {
            this.unrealizedGains[coin] = [
              {
                ...transaction,
                amount: transaction.value,
                gain: transaction.value * gainInEuro,
                daysFromPurchase: dayjs().diff(dayjs(transaction.date), 'days'),
              },
            ];
          }
        }
      }
    }
  }

  abstract calculate(account: CoinedaAccount, year: number): Promise<TaxResult>;
}
