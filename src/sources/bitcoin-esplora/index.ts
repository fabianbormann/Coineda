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
        name: 'xpub',
        label: 'Account xpub',
        // Deliberately `text`, not `apiKey`/`secret`. A credential field is
        // skipped by the re-drain rule - correcting a rejected key does not
        // change which wallet is read - but changing an xpub changes the
        // entire wallet, so it has to be a field type that re-drains. The
        // cost is that it is visible in the edit form, which is acceptable:
        // it cannot spend, and it sits in plaintext in IndexedDB either way.
        type: 'text',
        help: 'Your wallet account extended public key, not an address. Sparrow or Electrum connected to your device show it with its derivation path; Ledger Live has it under the account’s advanced logs. Ledger Live labels native-SegWit accounts "xpub" regardless, so Coineda works out the address type by checking the chain rather than trusting the prefix. One key covers one account, so a second Ledger Live account needs a second data source. It cannot spend - but treat it as private, since it reveals every address the wallet will ever use.',
        optional: true,
      },
      {
        name: 'address',
        label: 'Bitcoin addresses',
        type: 'addressList',
        help: 'One address per line, for addresses no xpub derives - a paper wallet, a cold address, an exchange deposit address. Only the addresses listed here are tracked, so one you own but never add stays invisible to Coineda.',
        // Optional and advanced now that the xpub covers the ordinary case.
        // `probe` enforces the real rule - at least one of the two - because
        // the manifest's `optional` flag is per-field and cannot express
        // "one of these".
        optional: true,
        advanced: true,
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
