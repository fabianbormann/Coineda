import { CoinedaFile, Transaction, TransactionType } from '../../global/types';
import { ImportSource } from '../ImportSource';

export class CoinedaImport extends ImportSource {
  name: string = 'CoinedaImport';

  static canImport(file: CoinedaFile) {
    return file.name.toLowerCase().endsWith('.cnd');
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

    const content = this.readFile(file.data.toString());

    if (content) {
      this.transactions = this.readCSV(content.transactionsText);
      this.transfers = this.readCSV(content.transfersText, true);
    }
  }

  private readCSV = (text: string, isTransfer = false) => {
    if (text === '') {
      return [];
    }

    const rows = text.split('\n');
    rows.shift();
    const transactions: Array<Transaction> = [];

    for (const row of rows) {
      const fields = row.split(';');

      if (isTransfer) {
        transactions.push({
          type: 'transfer',
          fromExchange: fields[0],
          toExchange: fields[1],
          value: Number(fields[2]),
          currency: fields[3],
          feeValue: Number(fields[4]),
          feeCurrency: fields[5],
          date: Number(fields[6]),
          account: fields[7] === '' ? 0 : Number(fields[7]),
          id: Number(fields[8]),
          symbol: '',
          exchange: '',
          fromSymbol: '',
          toSymbol: '',
          fromValue: 0,
          fromCurrency: '',
          toValue: 0,
          toCurrency: '',
          formattedDate: '',
          children: [],
          parent: 0,
          isComposed: '0',
          composedKeys: '',
        });
      } else {
        transactions.push({
          type: fields[0] as TransactionType,
          exchange: fields[1],
          fromValue: Number(fields[2]),
          fromCurrency: fields[3],
          toValue: Number(fields[4]),
          toCurrency: fields[5],
          feeValue: Number(fields[6]),
          feeCurrency: fields[7],
          isComposed: fields[8] as '0' | '1',
          parent: Number(fields[9]),
          composedKeys: fields[10],
          date: Number(fields[11]),
          account: fields[12] === '' ? 0 : Number(fields[12]),
          id: Number(fields[13]),
          fromExchange: '',
          toExchange: '',
          value: 0,
          currency: '',
          symbol: '',
          fromSymbol: '',
          toSymbol: '',
          formattedDate: '',
          children: [],
        });
      }
    }

    return transactions;
  };

  private readHeader = (text: string) => {
    const header = text.match(/<header>\n((.|\n)*?)\n<\/header>/);
    if (header) {
      const [formatString, versionString] = header[1].split('\n');
      const format = formatString.split(':')[1];
      const version = versionString.split(':')[1];

      if (format === 'coineda') {
        return version;
      } else {
        return null;
      }
    }
  };

  private readFile = (text: string) => {
    const version = this.readHeader(text);
    if (version) {
      const transactionsText = text.match(
        /<transactions>\n((.|\n)*?)\n<\/transactions>/
      );
      const transfersText = text.match(
        /<transfers>\n((.|\n)*?)\n<\/transfers>/
      );

      return {
        transfersText: transfersText ? transfersText[1] : '',
        transactionsText: transactionsText ? transactionsText[1] : '',
      };
    }
  };
}
