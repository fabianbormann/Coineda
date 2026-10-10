import type { FileSourceModule } from '@/sources/csv/types';
import { MappingRequiredError } from './types';

/**
 * Any CSV, read through a column mapping the user supplies.
 *
 * Never auto-detected: with no mapping there is nothing it could recognise,
 * and guessing which column is the amount is how a balance goes wrong
 * silently. The host calls `parseMapped` with the saved mapping instead.
 */
export const mappedCsv: FileSourceModule = {
  manifest: {
    id: 'mapped-csv',
    kind: 'file',
    label: 'Other CSV (map the columns)',
    help: 'For an exchange Coineda has no importer for: drop the file, tell Coineda which column holds the date, asset, amount and type, and how dates and decimals are written. Nothing is guessed, the mapping is saved for the next file from that venue, and nothing leaves this device.',
    emits: ['trade', 'transfer', 'reward', 'fee', 'fiat-in', 'fiat-out'],
    docsUrl: 'https://github.com/fabianbormann/Coineda',
  },
  sniff: () => false,
  parse: () => {
    throw new MappingRequiredError();
  },
};

export default mappedCsv;
