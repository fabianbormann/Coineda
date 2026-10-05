import type { FileSourceModule } from '@/sources/csv/types';
import { parse, sniff } from './parse';

/**
 * Coinbase, by file.
 *
 * Its export carries a preamble before the header and gives quantities
 * unsigned, with the direction in a type column - both handled in the
 * parser, and both the kind of difference that turns a sale into a purchase
 * if assumed away.
 */
export const coinbaseCsv: FileSourceModule = {
  manifest: {
    id: 'coinbase-csv',
    kind: 'file',
    label: 'Coinbase (CSV)',
    help: 'In Coinbase, open your profile, then Reports, and generate a transaction history report as CSV for all assets and the whole date range. Use the full transaction history rather than a tax report: a tax summary leaves out the movements Coineda needs to work out a cost basis. Nothing leaves this device, and no API key is needed.',
    emits: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
    docsUrl:
      'https://help.coinbase.com/en/coinbase/taxes-reports-and-financial-services/taxes/transaction-history',
  },
  sniff,
  parse,
};

export default coinbaseCsv;
