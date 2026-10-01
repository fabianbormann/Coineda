import type { Leg } from '@/ledger/types';
import type { DerivedEvent, FetchPage, SourceModule } from '@/sources/types';

/**
 * Yaci Store (https://store.yaci.xyz) is an open-source, self-hostable
 * Cardano indexer. Public deployments exist per network at
 * `https://yaci-store.{mainnet,preprod,preview}.colo2.cf-systems.org` - this
 * is only the default; `baseUrl` is a manifest field precisely so anyone
 * running their own instance, or pointing at a different network, can.
 */
const DEFAULT_BASE_URL = 'https://yaci-store.mainnet.colo2.cf-systems.org';

// Comfortably under the provider's documented maximum of 100 per page.
const PAGE_SIZE = 20;

type AddressTransaction = {
  tx_hash: string;
  block_height: number;
  block_number: number;
  /** Seconds, not milliseconds - see fetchEvents. */
  block_time: number;
};

type UtxoAmount = {
  unit: string;
  policy_id: string | null;
  asset_name: string | null;
  /** Already a decimal string - never parse this to a number and back. */
  quantity: string;
};

type UtxoEntry = {
  tx_hash: string;
  output_index: number;
  address: string;
  stake_address: string | null;
  amount: UtxoAmount[];
};

type TxUtxos = {
  hash: string;
  inputs: UtxoEntry[];
  outputs: UtxoEntry[];
};

const baseUrlOf = (config: Record<string, string>): string =>
  config.baseUrl?.trim() || DEFAULT_BASE_URL;

/** Chain-qualified so 'lovelace' here can never collide with the same
 *  symbol on another chain, and the native lovelace unit gets its own
 *  readable id instead of inheriting the raw (and, for lovelace, slightly
 *  misleading) provider unit string. */
const assetIdOf = (unit: string): string =>
  unit === 'lovelace' ? 'cardano:lovelace' : `cardano:${unit}`;

/**
 * Legs for one side (inputs or outputs) of a transaction's utxos,
 * filtered to the configured address.
 *
 * This filter is the module's half of the contract documented on
 * `SourceModule` in src/sources/types.ts: emit legs only for the account
 * this source was configured to watch, never the counterparty. An input
 * entry whose address matches is value leaving that address (direction
 * 'out'); a matching output entry is value arriving (direction 'in').
 */
const legsFor = (
  entries: UtxoEntry[],
  direction: Leg['direction'],
  address: string,
): Leg[] =>
  entries
    .filter((entry) => entry.address === address)
    .flatMap((entry) =>
      entry.amount.map((amount) => ({
        assetId: assetIdOf(amount.unit),
        amount: amount.quantity,
        direction,
        venue: entry.address,
        role: 'principal' as const,
      })),
    );

const fetchJson = async <T>(url: string, what: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `cardano-yaci: ${what} failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
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
        // The help text above tells the user to leave this empty, and
        // `baseUrlOf` substitutes DEFAULT_BASE_URL for an empty, whitespace
        // or absent value. Without this flag AddSourceDialog would refuse
        // to save a form that followed its own instruction.
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
    emits: ['transfer'],
    docsUrl: 'https://store.yaci.xyz',
  },

  probe: async (config) => {
    try {
      const response = await fetch(`${baseUrlOf(config)}/api/v1/blocks/latest`);
      if (!response.ok) {
        return {
          ok: false,
          message: 'Could not reach the Yaci Store instance.',
        };
      }
      // An address confers no spending power at all - probing it can only
      // ever confirm read access, never anything more - so this is one of
      // the few modules that can state readOnly with certainty rather than
      // leaving it undefined.
      return { ok: true, readOnly: true };
    } catch {
      return { ok: false, message: 'Could not reach the Yaci Store instance.' };
    }
  },

  fetchEvents: async (config, cursor): Promise<FetchPage> => {
    const baseUrl = baseUrlOf(config);
    const address = config.address;

    // The provider's own OpenAPI document declares `page` as 0-indexed
    // (minimum 0, default 0), but that is not how the live service actually
    // behaves: requesting page=0 and page=1 return the identical first
    // page, and page=2 is the real second page - verified directly against
    // the live preprod instance. Starting the sequence at 1 (and never
    // asking for page 1 twice) is what keeps this module's pagination from
    // re-fetching the first page as its own "next" page, which would emit
    // the same transactions twice in one drain and trip the conformance
    // harness's duplicate-externalId check on any address with more
    // transactions than fit on one page.
    const page = cursor === null ? 1 : Number.parseInt(cursor, 10);

    const transactions = await fetchJson<AddressTransaction[]>(
      `${baseUrl}/api/v1/addresses/${address}/transactions?page=${page}&count=${PAGE_SIZE}&order=asc`,
      'listing transactions',
    );

    const events: DerivedEvent[] = [];
    for (const tx of transactions) {
      const utxos = await fetchJson<TxUtxos>(
        `${baseUrl}/api/v1/txs/${tx.tx_hash}/utxos`,
        `fetching utxos for ${tx.tx_hash}`,
      );

      const legs = [
        ...legsFor(utxos.inputs, 'out', address),
        ...legsFor(utxos.outputs, 'in', address),
      ];

      // A transaction this address merely appears in without actually
      // moving value for it (shouldn't happen given how the transactions
      // were listed, but filtering is what makes it impossible) produces no
      // legs - skip it rather than handing the conformance gate an empty
      // event, which it rejects outright.
      if (legs.length === 0) {
        continue;
      }

      events.push({
        externalId: tx.tx_hash,
        // The API returns seconds; the ledger stores epoch milliseconds.
        timestamp: tx.block_time * 1000,
        kind: 'transfer',
        origin: 'derived',
        legs,
      });
    }

    return {
      events,
      cursor: transactions.length < PAGE_SIZE ? null : String(page + 1),
    };
  },
};

export default cardanoYaci;
