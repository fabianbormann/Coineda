import { CoinedaFile, TransactionType } from '../../global/types';
import { ImportSource } from '../ImportSource';
import * as XLSX from 'xlsx';
import { getAssetId, isFiat } from '../../helper/common';
import axios from 'axios';

export class BinanceImport extends ImportSource {
  name: string = 'BinanceImport';

  static canImport(file: CoinedaFile) {
    return file.name.toLowerCase().endsWith('.xlsx');
  }

  async deserialize(file: CoinedaFile) {
    if (!(file.data instanceof ArrayBuffer)) {
      this.errors.push({
        type: 'UnexpectedContent',
        filename: file.name,
        source: this.name,
      });
      return;
    }

    const workbook = XLSX.read(new Uint8Array(file.data), { type: 'array' });
    const sheetNameList = workbook.SheetNames;
    const rows: Array<{ [key: string]: any }> = XLSX.utils.sheet_to_json(
      workbook.Sheets[sheetNameList[0]]
    );

    let skipFeeRows = false;

    for (const row of rows) {
      if (typeof row['Date(UTC)'] !== 'undefined') {
        let { fromCurrency, toCurrency } = await this.getBinanceTokenPair(
          row['Pair']
        );

        try {
          fromCurrency = await getAssetId(fromCurrency);
          toCurrency = await getAssetId(toCurrency);
        } catch (error) {
          console.warn(error);
          fromCurrency = null;
          toCurrency = null;
        }

        if (fromCurrency && toCurrency) {
          this.transactions.push({
            fromCurrency: fromCurrency,
            toCurrency: toCurrency,
            exchange: 'Binance',
            type: await this.estimateTransactionType(fromCurrency, toCurrency),
            toValue: Number(row['Order Amount']),
            fromValue:
              Number(row['AvgTrading Price']) * Number(row['Order Amount']),
            date: new Date(row['Date(UTC)']).getTime(),
            feeValue: 0,
            isComposed: '0',
            feeCurrency: 'BTC',
            account: 0,
            id: 0,
            value: 0,
            symbol: '',
            currency: '',
            fromExchange: '',
            toExchange: '',
            fromSymbol: '',
            toSymbol: '',
            formattedDate: '',
            children: [],
            parent: 0,
            key: 0,
            composedKeys: '',
          });
          skipFeeRows = false;
        } else {
          this.errors.push({
            type: 'UnknownToken',
            filename: file.name,
            source: this.name,
          });
          skipFeeRows = true;
        }
      } else if (
        typeof row['Date(UTC)'] === 'undefined' &&
        row['AvgTrading Price'] !== 'Fee' &&
        !skipFeeRows
      ) {
        const target = this.transactions.length - 1;
        let feeCurrency = null;
        let feeValue = null;

        if (
          row['AvgTrading Price'].endsWith(
            this.transactions[target].fromCurrency
          )
        ) {
          feeValue = row['AvgTrading Price'].split(
            this.transactions[target].fromCurrency
          )[0];
          feeCurrency = this.transactions[target].fromCurrency;
        } else if (
          row['AvgTrading Price'].endsWith(this.transactions[target].toCurrency)
        ) {
          feeValue = row['AvgTrading Price'].split(
            this.transactions[target].toCurrency
          )[0];
          feeCurrency = this.transactions[target].toCurrency;
        } else if (row['AvgTrading Price'].endsWith('BNB')) {
          feeValue = row['AvgTrading Price'].split('BNB')[0];
          feeCurrency = 'BNB';
        }

        if (feeValue && feeCurrency) {
          this.transactions[target].feeValue += Number(feeValue);
          this.transactions[target].feeCurrency = feeCurrency;
        }
      }
    }

    const importedTransactions = [];
    for (const transaction of this.transactions) {
      try {
        importedTransactions.push({
          ...transaction,
          feeCurrency: await getAssetId(transaction.feeCurrency),
        });
      } catch (error) {
        this.errors.push({
          type: 'UnknownToken',
          filename: file.name,
          source: this.name,
          transaction: transaction,
        });
      }
    }
  }

  private async getBinanceTokenPair(binanceSymbol: string) {
    const cachedTokenPair = localStorage.getItem(
      `binance-pair-${binanceSymbol.toLowerCase()}`
    );

    const pair = cachedTokenPair ? JSON.parse(cachedTokenPair) : null;

    if (!pair || new Date().getTime() - pair.age > 365 * 24 * 60 * 60 * 1000) {
      try {
        const response = await axios.get(
          'https://api.binance.com/api/v3/exchangeInfo?symbol=' + binanceSymbol
        );

        const fromCurrency = response.data.symbols[0].baseAsset;
        const toCurrency = response.data.symbols[0].quoteAsset;

        localStorage.setItem(
          `binance-pair-${binanceSymbol.toLowerCase()}`,
          JSON.stringify({
            data: { fromCurrency, toCurrency },
            age: new Date().getTime(),
          })
        );

        return { fromCurrency, toCurrency };
      } catch (error) {
        console.error(error);
        return {
          fromCurrency: null,
          toCurrency: null,
        };
      }
    } else {
      return pair.data;
    }
  }

  private async estimateTransactionType(
    fromCurrency: string,
    toCurrency: string
  ) {
    let transactionType: TransactionType = 'buy';
    const fromCurrencyIsFiat = await isFiat(fromCurrency);
    const toCurrencyIsFiat = await isFiat(toCurrency);

    if (!fromCurrencyIsFiat && toCurrencyIsFiat) {
      transactionType = 'sell';
    } else if (!fromCurrencyIsFiat && !toCurrencyIsFiat) {
      transactionType = 'swap';
    }
    return transactionType;
  }
}
