import type { SourceModule } from '@/sources/types';
import {
  fetchCardanoEvents,
  probeCardano,
  type CardanoProvider,
} from '@/sources/cardano/translator';

/**
 * Blockfrost (https://blockfrost.io) is a hosted Cardano API. It offers the
 * same provider choice as cardano-yaci rather than new capability - pick
 * this if you already have a Blockfrost project, or Yaci Store if you would
 * rather hold no credential at all.
 *
 * Network is chosen through `baseUrl`, the same way Yaci's is:
 * `https://cardano-{mainnet,preprod,preview}.blockfrost.io`.
 *
 * **What is verified and what is assumed.** Yaci Store deliberately mirrors
 * Blockfrost's API, which is the premise this module rests on, so be precise
 * about which parts of that have actually been checked:
 *
 * - Verified from Blockfrost's own documentation: the address-transactions
 *   response is `{tx_hash, tx_index, block_height, block_time}` with
 *   `block_time` in SECONDS, and paging is `page`/`count`/`order` with
 *   `page` 1-based. The two fields the translator reads - `tx_hash` and
 *   `block_time` - match Yaci's exactly.
 * - Verified against the live service: CORS. A GET answers
 *   `access-control-allow-origin: *` and the preflight answers 204 with
 *   `access-control-allow-headers: *`, which is what permits the custom
 *   `project_id` header from a browser. Hence `needsRelay: false`.
 * - **Assumed, not verified:** the `/txs/{hash}/utxos`,
 *   `/accounts/{stake}/rewards` and `/epochs/{n}` response shapes. They are
 *   taken to match Yaci Store's. There are no Blockfrost-recorded fixtures,
 *   because recording them needs a project id and this project does not
 *   hand-write provider fixtures. The first real run against Blockfrost is
 *   therefore the verification; if a shape differs, this module's events
 *   will be wrong in a way its tests cannot currently catch. Record fixtures
 *   and drop them beside this file when a key is available. One difference
 *   is already handled rather than assumed away: the translator accepts an
 *   amount as either a string or a number, so it does not matter which of
 *   the two a provider chooses for a reward amount.
 * - **Where the mirroring stops.** The two APIs match on the *address*
 *   endpoints this module uses, but not on the *account* ones. Blockfrost
 *   has `/accounts/{stake}/addresses`, which would enumerate a wallet's
 *   payment addresses and give complete account history; Yaci Store has no
 *   such route (verified: 404, and nothing equivalent in its OpenAPI
 *   document). That is why account-view tracking currently derives the
 *   account from the configured payment address on both providers rather
 *   than enumerating it, and why "same API" is true only of the endpoints
 *   named above.
 */
const DEFAULT_BASE_URL = 'https://cardano-mainnet.blockfrost.io';

const provider: CardanoProvider = {
  host: (config) => config.baseUrl?.trim() || DEFAULT_BASE_URL,
  apiPath: '/api/v0',
  exampleHost: DEFAULT_BASE_URL,
  // The credential goes in a header, never the URL: a project id in a query
  // string lands in the provider's own request logs and in any proxy
  // between here and them.
  headers: (config) => ({ project_id: config.projectId }),
  // Takes a status code only - never the config - so there is no route by
  // which the project id could reach a message that gets stored as
  // lastError, rendered on screen, and carried in the checkpoint.
  probeMessage: (status) =>
    status === 403 || status === 401
      ? 'Blockfrost rejected this project id. Check that it is correct and matches the network you selected.'
      : 'Could not reach Blockfrost. It may be unavailable or rate-limiting this project.',
};

export const cardanoBlockfrost: SourceModule = {
  manifest: {
    id: 'cardano-blockfrost',
    kind: 'chain',
    label: 'Cardano (Blockfrost)',
    fields: [
      {
        name: 'baseUrl',
        label: 'Blockfrost base URL',
        type: 'text',
        help: 'Leave this empty for Cardano mainnet, or use https://cardano-preprod.blockfrost.io or https://cardano-preview.blockfrost.io for a test network.',
        optional: true,
      },
      {
        name: 'projectId',
        label: 'Blockfrost project id',
        type: 'apiKey',
        help: 'The project id from your Blockfrost dashboard. It only ever reads the chain - it cannot move funds - and it is stored on this device, encrypted inside any checkpoint you create.',
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
    docsUrl: 'https://blockfrost.dev',
  },

  probe: (config, signal) => probeCardano(provider, config, signal),

  fetchEvents: (config, cursor, signal) =>
    fetchCardanoEvents(provider, config, cursor, signal),
};

export default cardanoBlockfrost;
