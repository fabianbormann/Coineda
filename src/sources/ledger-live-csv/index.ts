import type { FileSourceModule } from '@/sources/csv/types';
import { parse, sniff } from './parse';

/**
 * Ledger Live, by file: the "Operation history" export of its accounts.
 *
 * Amounts are unsigned with the direction in the operation type, fees are in
 * the parent chain's coin, and the same hash can appear on several rows - the
 * parser keeps those distinct and keeps the hash so a transfer to an exchange
 * can be linked.
 */
export const ledgerLiveCsv: FileSourceModule = {
  manifest: {
    id: 'ledger-live-csv',
    kind: 'file',
    label: 'Ledger Live (CSV)',
    help: "In Ledger Live, open Accounts, use the export menu and save the operation history as CSV. Fees are booked in each chain's own coin, sends are booked net of the fee because Ledger Live reports their amount with the fee included, hashes are kept so transfers to an exchange can be linked, and governance operations without a fee are left out. Do not add the same wallet as an on-chain source as well, or its holdings count twice. Nothing leaves this device.",
    emits: ['transfer', 'fee', 'reward'],
    docsUrl: 'https://support.ledger.com/article/360014094879-zd',
  },
  sniff,
  parse,
};

export default ledgerLiveCsv;
