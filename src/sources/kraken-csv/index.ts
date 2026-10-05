import type { FileSourceModule } from '@/sources/csv/types';
import { parse, sniff } from './parse';

/**
 * Kraken, by file rather than by API.
 *
 * Not a choice between two working options. Measured against Kraken's own
 * private endpoint from a browser origin: the CORS preflight answers 404,
 * and the response to the request itself carries no
 * `access-control-allow-origin`. A private call needs the `API-Key` and
 * `API-Sign` headers, which makes it a non-simple request, so the browser
 * preflights, gets the 404, and never sends anything. The ledger export is
 * the only way in that does not route a user's API secret through someone
 * else's server.
 *
 * The LEDGER export specifically, not the trades export. The trades export
 * lists trades alone, and a balance rebuilt from trades alone is wrong the
 * moment anything is withdrawn - the exact failure this project already hit
 * on Bitpanda, where it reported EUR 3,900 of bitcoin that was not there.
 */
export const krakenCsv: FileSourceModule = {
  manifest: {
    id: 'kraken-csv',
    kind: 'file',
    label: 'Kraken (CSV)',
    help: 'In Kraken, open History, then Export, and choose the LEDGERS export - not Trades, which leaves out your deposits and withdrawals and would make your balance look larger than it is. Pick the whole date range. Kraken emails you a zip; the file inside it is what Coineda reads. Nothing leaves this device, and no API key is needed.',
    emits: ['trade', 'transfer', 'reward'],
    docsUrl:
      'https://support.kraken.com/articles/360001169383-how-to-export-ledgers',
  },
  sniff,
  parse,
};

export default krakenCsv;
