import type { SourceModule } from '@/sources/types';
import { fetchEvents, probe } from './translator';

/**
 * Ethereum, through Blockscout (https://github.com/blockscout/blockscout).
 *
 * Blockscout is to Ethereum what Esplora is to Bitcoin here: an open-source
 * indexer with a public deployment that needs no credential, and which you
 * can run yourself. That combination is why it is the default rather than
 * Etherscan, which is also browser-reachable but wants a key.
 *
 * It matters more on Ethereum than elsewhere that this is an INDEXER.
 * Standard JSON-RPC has no method for "transactions belonging to an
 * address" - measured on a public node: `eth_getBalance` answers,
 * `eth_getTransactionsByAddress` does not exist - so an Infura or Alchemy
 * endpoint, or a node of your own, cannot stand in for this.
 *
 * `baseUrl` also makes this module cover the EVM chains Blockscout deploys
 * the same API for; base.blockscout.com and arbitrum.blockscout.com answer
 * these exact routes. The asset id would be wrong for those today, since
 * everything here is hardcoded to `eth:native`, so that is a change to make
 * deliberately rather than a thing to assume works.
 */
export const ethereumBlockscout: SourceModule = {
  manifest: {
    id: 'ethereum-blockscout',
    kind: 'chain',
    label: 'Ethereum (Blockscout)',
    fields: [
      {
        name: 'baseUrl',
        label: 'Blockscout base URL',
        type: 'text',
        help: 'The Blockscout API to query. Leave this empty to use the public eth.blockscout.com deployment, or point it at an instance you run yourself.',
        optional: true,
      },
      {
        name: 'address',
        label: 'Ethereum address',
        type: 'address',
        help: 'The address to track, as 0x followed by 40 hex characters. Only this address is tracked: ether in another address of yours stays invisible to Coineda until you add it as well. Reading an address reveals nothing private - it is public on the chain - and Coineda can only read.',
      },
    ],
    needsRelay: false,
    emits: ['transfer'],
    docsUrl: 'https://docs.blockscout.com/devs/apis/rest',
  },

  probe: (config, signal) => probe(config, signal),

  fetchEvents: (config, cursor, signal) => fetchEvents(config, cursor, signal),
};

export default ethereumBlockscout;
