import type { SourceModule } from '@/sources/types';
import { fetchEvents, probe } from './translator';

/**
 * Esplora (https://github.com/Blockstream/esplora) is the open-source
 * block explorer backend both Blockstream.info and mempool.space run - the
 * two public deployments this module defaults between via `baseUrl`, and it
 * is also self-hostable. Its API needs no credential at all: `address` is
 * the only thing this module asks for besides where to ask.
 *
 * The translation itself lives in src/sources/bitcoin-esplora/translator.ts,
 * including the default base URL (`baseUrlOf`'s `DEFAULT_BASE_URL`) - kept
 * there rather than duplicated here, since that is the one place it is
 * actually used.
 */
export const bitcoinEsplora: SourceModule = {
  manifest: {
    id: 'bitcoin-esplora',
    kind: 'chain',
    label: 'Bitcoin (Esplora)',
    fields: [
      {
        name: 'baseUrl',
        label: 'Esplora base URL',
        type: 'text',
        help: 'The Esplora-compatible API to query. Leave this empty to use the public Blockstream.info deployment, or point it at mempool.space or a self-hosted instance.',
        optional: true,
      },
      {
        name: 'address',
        label: 'Bitcoin addresses',
        type: 'addressList',
        help: 'One address per line. Bitcoin has no account view, so only the addresses listed here are tracked - an address you own but never add here stays completely invisible to Coineda.',
      },
    ],
    needsRelay: false,
    emits: ['transfer'],
    docsUrl: 'https://github.com/Blockstream/esplora/blob/master/API.md',
  },

  probe: (config, signal) => probe(config, signal),

  fetchEvents: (config, cursor, signal) => fetchEvents(config, cursor, signal),
};

export default bitcoinEsplora;
