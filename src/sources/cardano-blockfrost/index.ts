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
 * - **VERIFIED, and it diverges.** `/txs/{hash}/utxos` was assumed to match
 *   Yaci Store's. It does not. Measured across the 16 live mainnet
 *   transactions recorded beside this file, Blockfrost's input entries
 *   carry `address, amount, collateral, data_hash, inline_datum,
 *   output_index, reference, reference_script_hash, tx_hash` and its output
 *   entries `address, amount, collateral, consumed_by_tx, data_hash,
 *   inline_datum, output_index, reference_script_hash` - and **no
 *   `stake_address`** on either side. Yaci's do carry it. That field is
 *   what the single-address path uses to recognise the account, so on
 *   Blockfrost `accountOf` always returned null, the path fell back to
 *   exact payment-address matching, and `fetchRewardEvents` - gated on a
 *   resolved account - never ran at all. A Blockfrost source had no account
 *   view and no staking income from the day this module shipped until the
 *   account tier landed. It was invisible because the only Blockfrost tests
 *   rehosted the recorded YACI bodies, which supply exactly the field the
 *   real provider omits. There are now recorded Blockfrost fixtures beside
 *   this file, and tests/cardanoBlockfrostFixtures.test.ts asserts the
 *   absence directly.
 * - **Also verified, also divergent, and already handled:**
 *   `/accounts/{stake}/rewards` returns `amount` as a STRING here, where
 *   Yaci returns a JSON number. The translator accepts either, which is the
 *   only reason this was never a defect - and `amountString` refuses a
 *   number JSON.parse has already rounded rather than record it.
 * - **Verified from the recordings:** `/epochs/{n}` carries `end_time` in
 *   seconds, the one field read from it, alongside `epoch, start_time,
 *   first_block_time, last_block_time, block_count, tx_count, output,
 *   fees, active_stake`.
 * - **Where the mirroring stops, and why it is a DEPLOYMENT difference
 *   rather than an API one.** Both the address endpoints and the account
 *   ones - `/accounts/{stake}/transactions`, `/accounts/{stake}/addresses`,
 *   `/accounts/{stake}/rewards`, `/accounts/{stake}/withdrawals` - exist in
 *   both APIs: Yaci Store implements the account routes under its
 *   `blockfrost` Spring profile, and spec P2 records that they are simply
 *   not enabled on the PUBLIC deployments. An earlier version of this
 *   comment said Yaci "has no such route" and cited
 *   src/sources/cardano-yaci/fixtures/201.json as the recorded 404 for
 *   `/accounts/{stake}/addresses`; both were wrong - 201.json is the
 *   recorded 404 for `/accounts/{stake}/transactions`, and this project has
 *   no recording of the addresses route against Yaci at all. The practical
 *   consequence is unchanged: the account tier reaches Blockfrost and not a
 *   public Yaci instance, which keeps answering on the address tier - but
 *   it is reachable on a self-hosted Yaci with that profile on, which is
 *   why the tier is chosen by probing behaviour rather than by provider.
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
