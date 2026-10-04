import type { SourceModule } from '@/sources/types';
import { fetchEvents, probe } from './translator';

/**
 * Bitpanda (https://www.bitpanda.com), the first exchange Coineda can read.
 *
 * It is first because it is the only widely-used exchange a BROWSER can
 * reach. Measured on 2026-10-04 against each provider's private endpoints:
 * Bitpanda answers a CORS preflight with `x-api-key` explicitly allowed,
 * while Binance returns no allowed headers at all, Coinbase no allowed
 * origin, and Kraken and KuCoin no CORS headers whatever. Those need a
 * server to sign and forward on the app's behalf, which is not something a
 * local-first app should ask for, so they are served by file import instead.
 *
 * Bitpanda also needs no request signing - one header, no HMAC, no
 * timestamp, no passphrase - which is the other half of why it comes first.
 *
 * `needsRelay: false` is therefore a measurement rather than an assumption.
 */
export const bitpanda: SourceModule = {
  manifest: {
    id: 'bitpanda',
    kind: 'exchange',
    label: 'Bitpanda',
    fields: [
      {
        name: 'apiKey',
        label: 'Bitpanda API key',
        type: 'apiKey',
        help: 'In Bitpanda, open your profile menu and go to API. Create a new key, tick only the read scopes listed below, and copy it before closing the dialog - Bitpanda shows a key once and never again. Coineda only ever reads: it cannot trade, withdraw or move anything. The key is stored on this device and travels only inside a checkpoint you create, which is encrypted.',
      },
    ],
    // Named so onboarding can tell the user exactly which boxes to tick and
    // nothing wider. A key that can trade is a key that can lose money, and
    // nothing here needs one.
    requiredScopes: ['Trades', 'Transactions', 'Wallets'],
    needsRelay: false,
    emits: ['trade'],
    docsUrl: 'https://developers.bitpanda.com',
  },

  probe: (config, signal) => probe(config, signal),

  fetchEvents: (config, cursor, signal) => fetchEvents(config, cursor, signal),
};

export default bitpanda;
