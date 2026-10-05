import type { FileSourceModule } from '@/sources/csv/types';
import { parse, sniff } from './parse';

/**
 * Binance, by file. Its private API answers a browser no better than
 * Kraken's does, and the transaction export needs no key at all.
 */
export const binanceCsv: FileSourceModule = {
  manifest: {
    id: 'binance-csv',
    kind: 'file',
    label: 'Binance (CSV)',
    help: 'In Binance, open Orders, then Transaction History, and use Export Transaction Records. Choose the widest date range it allows and repeat for each year you need - Binance caps one export at twelve months. Nothing leaves this device, and no API key is needed.',
    emits: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
    docsUrl:
      'https://www.binance.com/en/support/faq/how-to-check-transaction-records-360002058352',
  },
  sniff,
  parse,
};

export default binanceCsv;
