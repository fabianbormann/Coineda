import { CoinedaFile } from '../../global/types';
import { getAssetId } from '../../helper/common';
import { ImportSource } from '../ImportSource';

export class CointrackingImport extends ImportSource {
  name: string = 'CointrackingImport';

  static canImport(file: CoinedaFile) {
    if (!file.data) {
      return false;
    }

    const rows = file.data.toString().split('\n');
    const header = rows[0];

    return (
      file.name.toLowerCase().endsWith('.csv') &&
      header[2] === 'Cur.' &&
      header[4] === 'Cur.' &&
      header[6] === 'Cur.'
    );
  }

  async deserialize(file: CoinedaFile) {
    const rows = file.toString().split('\n');
    rows.shift();

    for (const row of rows) {
      if (row === '') {
        continue;
      }
      const columns = row.split('"').join('').split(',');
      let type = columns[0];

      let fromCurrency = null;
      let toCurrency = null;

      try {
        toCurrency = await getAssetId(columns[2]);
        fromCurrency = await getAssetId(columns[4]);
      } catch (error) {
        console.warn(error);
        this.errors.push({
          type: 'UnknownToken',
          filename: file.name,
          source: this.name,
        });
      }

      if (fromCurrency && toCurrency) {
        const feeValue = Number(columns[5]);
        let feeCurrency = 'bitcoin';

        if (columns[6] !== '') {
          try {
            feeCurrency = await getAssetId(columns[6]);
          } catch (error) {
            if (feeValue > 0) {
              this.errors.push({
                type: 'UnknownToken',
                filename: file.name,
                source: this.name,
              });
              console.warn(error);
              type = 'invalid';
            }
          }
        }

        if (type === 'Trade') {
          this.transactions.push({
            exchange: columns[7],
            isComposed: '0',
            fromCurrency: fromCurrency,
            fromValue: Number(columns[3]),
            toCurrency: toCurrency,
            toValue: Number(columns[1]),
            feeCurrency: feeCurrency,
            feeValue: feeValue,
            date: new Date(columns[10]).getTime(),
            account: 0,
            id: 0,
            value: 0,
            symbol: '',
            currency: '',
            fromExchange: '',
            toExchange: '',
            fromSymbol: '',
            toSymbol: '',
            type: 'buy',
            formattedDate: '',
            children: [],
            parent: 0,
            composedKeys: '',
          });
        }
      }
    }
  }
}
