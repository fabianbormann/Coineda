import { CoinedaFile, Transaction } from '../../global/types';
import { getAssetId } from '../../helper/common';
import { FileInputSource } from '../FileInputSource';

export class KrakenFileInput extends FileInputSource {
  name: string = 'KrakenFileInput';

  static canImport(file: CoinedaFile) {
    if (!file.data) {
      return false;
    }

    const rows = file.data.toString().split('\n');
    const header = rows[0];

    return (
      file.name.toLowerCase().endsWith('.csv') &&
      !(header[2] === 'Cur.' && header[4] === 'Cur.' && header[6] === 'Cur.')
    );
  }

  async deserialize(file: CoinedaFile) {
    if (!file.data) {
      this.errors.push({
        type: 'EmptyFile',
        filename: file.name,
        source: this.name,
      });
      return;
    }

    const rows = file.data.toString().split('\n');
    rows.shift();
    let transactionReferences: { [key: string]: Transaction } = {};

    for (const row of rows) {
      if (row === '') {
        continue;
      }
      const columns = row.split('"').join('').split(',');
      const type = columns[3];

      let currency = null;

      try {
        currency = await this.getKrakenAssetId(columns[6]);
      } catch (error) {
        console.warn(error);
        this.errors.push({
          type: 'UnknownToken',
          filename: file.name,
          source: this.name,
        });
      }

      if (currency) {
        if (type === 'spend') {
          transactionReferences[columns[1]] = {
            exchange: 'Kraken',
            isComposed: '0',
            fromCurrency: currency,
            fromValue: Math.abs(Number(columns[7])),
            feeCurrency: currency,
            feeValue: Number(columns[8]),
            date: new Date(columns[2]).getTime(),
            symbol: '',
            fromSymbol: '',
            toSymbol: '',
            toValue: 0,
            toCurrency: '',
            formattedDate: '',
            children: [],
            parent: 0,
            composedKeys: '',
            value: Number(0),
            currency: '',
            type: 'buy',
            fromExchange: '',
            toExchange: '',
          };
        } else if (type === 'receive') {
          transactionReferences[columns[1]] = {
            ...transactionReferences[columns[1]],
            exchange: 'Kraken',
            isComposed: '0',
            toCurrency: currency,
            toValue: Number(columns[7]),
          };
        }
      }
    }

    for (const reference of Object.keys(transactionReferences)) {
      if (
        typeof transactionReferences[reference].fromCurrency !== 'undefined' &&
        typeof transactionReferences[reference].toCurrency !== 'undefined'
      ) {
        this.transactions.push(transactionReferences[reference]);
      }
    }
  }

  async getKrakenAssetId(symbol: string) {
    if (symbol === 'XXBT') {
      return 'bitcoin';
    } else if (symbol === 'XXDG') {
      return 'dogecoin';
    } else if (symbol.startsWith('Z') || symbol.startsWith('X')) {
      return await getAssetId(symbol.substring(1));
    } else {
      return await getAssetId(symbol);
    }
  }
}
