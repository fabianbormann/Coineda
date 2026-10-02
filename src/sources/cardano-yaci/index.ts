import type { SourceModule } from '@/sources/types';
import {
  fetchCardanoEvents,
  probeCardano,
  type CardanoProvider,
} from '@/sources/cardano/translator';

/**
 * Yaci Store (https://store.yaci.xyz) is an open-source, self-hostable
 * Cardano indexer. Public deployments exist per network at
 * `https://yaci-store.{mainnet,preprod,preview}.colo2.cf-systems.org` - this
 * is only the default; `baseUrl` is a manifest field precisely so anyone
 * running their own instance, or pointing at a different network, can.
 *
 * The translation itself lives in src/sources/cardano/translator.ts, shared
 * with cardano-blockfrost: Yaci Store mirrors Blockfrost's API, so the two
 * modules differ only in host, API path and authentication.
 */
const DEFAULT_BASE_URL = 'https://yaci-store.mainnet.colo2.cf-systems.org';

/**
 * Needs no credential of any kind: no API key, no project id, no header. A
 * Yaci source therefore holds no secret, which is what keeps a chain-only
 * user's checkpoint free of secrets entirely. `headers` returning an empty
 * object is that property, stated where the shared translator can see it -
 * and tests/cardanoBlockfrost.test.ts asserts sharing a translator with a
 * credential-bearing module has not quietly introduced one here.
 */
const provider: CardanoProvider = {
  // Handles all three states an optional field can be stored in - empty
  // string, whitespace, or absent from config entirely. See the `optional`
  // doc comment on ManifestField.
  host: (config) => config.baseUrl?.trim() || DEFAULT_BASE_URL,
  apiPath: '/api/v1',
  headers: () => ({}),
  exampleHost: DEFAULT_BASE_URL,
  probeMessage: () => 'Could not reach the Yaci Store instance.',
};

export const cardanoYaci: SourceModule = {
  manifest: {
    id: 'cardano-yaci',
    kind: 'chain',
    label: 'Cardano (Yaci Store)',
    fields: [
      {
        name: 'baseUrl',
        label: 'Yaci Store base URL',
        type: 'text',
        help: 'The Yaci Store instance to query. Leave this empty to use the public mainnet deployment, or point it at a preprod, preview or self-hosted instance.',
        optional: true,
      },
      {
        name: 'address',
        label: 'Cardano address',
        type: 'address',
        help: 'The address to track. Coineda only ever reads this address - it never asks for a private key.',
      },
    ],
    needsRelay: false,
    // 'reward' as well as 'transfer': the shared translator emits a
    // staking reward per epoch (fetchRewardEvents), and conformance.ts
    // rejects a kind a manifest does not declare. The gate only ever
    // passed on ['transfer'] because the tracked fixture account's
    // recorded rewards response is empty, so no reward event was drained -
    // tests/cardanoYaci.test.ts now runs conformance over a
    // reward-bearing account as well.
    emits: ['transfer', 'reward'],
    docsUrl: 'https://store.yaci.xyz',
  },

  probe: (config, signal) => probeCardano(provider, config, signal),

  fetchEvents: (config, cursor, signal) =>
    fetchCardanoEvents(provider, config, cursor, signal),
};

export default cardanoYaci;
