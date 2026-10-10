# Self-hosting Coineda's data services

Coineda has no backend of its own: the app (a PWA, or the Electron desktop shell) calls price and chain
APIs directly from the user's device. By default those are public providers. An organisation that must
not send holdings or addresses to third parties - a tax authority, an advisory firm, a company running it
for its staff - can instead build Coineda against services it runs itself, and pin the build so it never
calls anything else.

This guide is the contract such services must meet. Everything here is read off the fetch code; the file
named in each section is the source of truth if the two ever disagree.

## The endpoints

Every outbound host lives in one place, `src/config/endpoints.ts`. Each key is a **base URL** (no
trailing slash); the calling module appends its own route, so a replacement service must serve the same
routes under its base.

| Key                  | Public default                                    | Used for                                   | Self-hostable                 |
| -------------------- | ------------------------------------------------- | ------------------------------------------ | ----------------------------- |
| `priceHistory`       | `https://coins.llama.fi`                          | Historical USD prices (tax report)         | Yes (implement the contract)  |
| `spotPrices`         | `https://api.coingecko.com/api/v3`                | Spot prices; historical fallback           | Yes (implement the contract)  |
| `fx`                 | `https://api.frankfurter.dev/v1`                  | ECB reference rates (USD to base currency) | Yes (Frankfurter is open source) |
| `tokenRegistry`      | `https://tokens.cardano.org/metadata`             | Cardano native-token names and decimals    | Yes (Cardano token registry)  |
| `bitcoinEsplora`     | `https://blockstream.info/api`                    | Bitcoin source                             | Yes (Esplora)                 |
| `ethereumBlockscout` | `https://eth.blockscout.com`                      | Ethereum source                            | Yes (Blockscout)              |
| `cardanoYaci`        | `https://yaci-store.mainnet.colo2.cf-systems.org` | Cardano source (Yaci Store)                | Yes (Yaci Store)              |
| `cardanoBlockfrost`  | `https://cardano-mainnet.blockfrost.io`           | Cardano source (Blockfrost)                | Yes (any Blockfrost-compatible API) |
| `bitpanda`           | `https://api.bitpanda.com/v1`                     | Bitpanda exchange source                   | No - hidden in restricted mode |

You need only the services your users need. A key left at its public default is simply unavailable in
restricted mode (see [How restricted mode behaves](#how-restricted-mode-behaves)).

## API contracts

All requests are plain `GET` unless stated otherwise and expect a JSON response with status 2xx. A non-2xx
status is treated as an outage for that lookup, never as a value.

### `priceHistory` - DefiLlama coins API (`src/prices/defillama.ts`)

```
GET {priceHistory}/batchHistorical?coins={urlencoded JSON}
Accept: application/json
```

`coins` is a JSON object mapping `coingecko:<id>` (CoinGecko coin ids, from `COINGECKO_IDS` in
`src/prices/coingecko.ts`) to an array of Unix timestamps **in seconds**, each the UTC midnight of a day
being valued:

```json
{ "coingecko:bitcoin": [1748736000, 1748822400], "coingecko:cardano": [1748736000] }
```

Response fields read:

```json
{
  "coins": {
    "coingecko:bitcoin": {
      "prices": [{ "timestamp": 1748736012, "price": 104512.3 }]
    }
  }
}
```

`timestamp` (seconds) and `price` (USD, a JSON number) are required per point; other fields are ignored.
Each point is matched to the nearest requested day and dropped if it is more than 12 hours away. A day
with no point is reported as missing, not zero.

### `spotPrices` - CoinGecko API (`src/prices/coingecko.ts`)

Three routes:

```
GET {spotPrices}/simple/price?ids={id1,id2,...}&vs_currencies={currency}
```

Reads `body[<id>][<currency>]` (a number). `currency` is the lower-cased base currency, e.g. `eur`.

```
GET {spotPrices}/coins/{id}/market_chart/range?vs_currency={currency}&from={seconds}&to={seconds}
x-cg-demo-api-key: {key}        (only if the user entered a CoinGecko key)
```

Reads `prices`: an array of `[millisecondTimestamp, price]` pairs. The nearest point within 12 hours of
each requested UTC midnight is used.

```
GET {spotPrices}/coins/{id}/history?date={dd-mm-yyyy}&localization=false
x-cg-demo-api-key: {key}        (optional, as above)
```

Reads `market_data.current_price[<currency>]`.

The historical routes are the fallback for days DefiLlama does not cover; a service that implements only
`simple/price` still serves the overview screen.

### `fx` - Frankfurter / ECB rates (`src/prices/ecb.ts`)

```
GET {fx}/{start}..{end}?base={BASE}&symbols={SYMBOL}
Accept: application/json
```

`start`/`end` are ISO dates (`2025-05-28..2025-06-01`); the range is padded a few days back so weekends
and holidays carry the last published rate. Reads `rates[<isoDay>][<SYMBOL>]` (a number). Running the
open-source [Frankfurter](https://github.com/lineofflight/frankfurter) and pointing `fx` at its `/v1`
root satisfies this as-is.

### `tokenRegistry` - Cardano token registry (`src/assets/tokenRegistry.ts`)

```
POST {tokenRegistry}/query
Content-Type: application/json

{ "subjects": ["<policyId><assetNameHex>", ...], "properties": ["name", "ticker", "decimals", "logo"] }
```

Sent in chunks of at most 50 subjects. Reads `subjects`: an array of rows, each with `subject` and any of
`name`, `ticker`, `decimals`, `logo` (base64 PNG), where each property is either a plain value or an
object with a `value` field (the registry's own format). A failed request leaves tokens undecorated; the
name decoded from the asset id is shown instead.

### `bitcoinEsplora` - Esplora (`src/sources/bitcoin-esplora/translator.ts`)

```
GET {bitcoinEsplora}/address/{address}/txs
GET {bitcoinEsplora}/address/{address}/txs/chain/{lastSeenTxid}
```

Reads, per transaction: `txid`, `status.confirmed`, `status.block_height`, `status.block_time` (seconds),
`vin[].prevout.scriptpubkey_address`, `vin[].prevout.value`, `vout[].scriptpubkey_address`,
`vout[].value` (satoshis) and `fee`. An xpub is never sent; addresses are derived locally. A stock
[Esplora](https://github.com/Blockstream/esplora) or electrs-esplora deployment serves this unchanged.

### `ethereumBlockscout` - Blockscout (`src/sources/ethereum-blockscout/translator.ts`)

```
GET {ethereumBlockscout}/api/v2/addresses/{address}
GET {ethereumBlockscout}/api/v2/addresses/{address}/transactions[?{next_page_params}]
GET {ethereumBlockscout}/api/v2/addresses/{address}/internal-transactions[?{next_page_params}]
```

Reads `items` and `next_page_params` (echoed back verbatim as the next page's query). Transaction rows:
`hash`, `timestamp`, `value`, `fee.value`, `status`, `from.hash`, `to.hash`. Internal rows:
`transaction_hash`, `index`, `timestamp`, `value`, `success`, `from.hash`, `to.hash`. A stock Blockscout
instance serves this unchanged.

### `cardanoYaci` and `cardanoBlockfrost` - Cardano (`src/sources/cardano/`)

Both share one translator; Yaci Store's API root is `/api/v1`, Blockfrost's `/api/v0`, appended to the
base URL. Blockfrost requests carry the user's project id in a `project_id` header; Yaci requests carry
no credential.

```
GET {root}/addresses/{address}
GET {root}/addresses/{address}/transactions?page={n}&count={size}&order=asc
GET {root}/accounts/{stake}/transactions?page={n}&count={size}&order=asc
GET {root}/accounts/{stake}/addresses?page={n}&count={size}
GET {root}/accounts/{stake}/rewards?page={n}&count={size}
GET {root}/accounts/{stake}/withdrawals?page={n}&count={size}
GET {root}/txs/{hash}/utxos
GET {root}/epochs/{epoch}
```

Fields read: transaction lists `tx_hash`, `block_time` (seconds); utxos `inputs[]`/`outputs[]` with
`address`, `amount[].unit`, `amount[].quantity` (decimal string), and where present `stake_address`,
`collateral`, `reference`; rewards `epoch`, `amount`, `type` (`member`/`leader`); withdrawals `tx_hash`,
`amount`; epochs `end_time` (seconds). A self-run [Yaci Store](https://store.yaci.xyz) serves this
unchanged.

## CORS

Every request is a cross-origin request from the app's origin, so each service must answer it - including
the `OPTIONS` preflight for requests with a custom header or a JSON body:

- `Access-Control-Allow-Origin`: the origin the app is served from (for example
  `https://coineda.internal.example`), or for the desktop shell `coineda://app`. List both if you serve
  both.
- `Access-Control-Allow-Headers`: at least `Accept`, `Content-Type`, `project_id` (Blockfrost-compatible
  Cardano) and `x-cg-demo-api-key` (CoinGecko-compatible historical prices, only if users enter a key).
- `Access-Control-Allow-Methods`: `GET, POST, OPTIONS` (`POST` is used only by the token registry).

Services must be served over **HTTPS**: the app's Content-Security-Policy (`public/csp.json`) allows
`connect-src 'self' https:`, so an `http://` endpoint is refused by the browser. Port numbers are fine.

## Building an authority build

Two build-time variables, both read by Vite and baked into the bundle:

- `VITE_ENDPOINTS` - a JSON object with any subset of the keys above. Unknown keys and empty values are
  ignored; invalid JSON logs a warning and falls back to the public defaults (so check the build output).
- `VITE_EGRESS=restricted` - pins restricted mode. A user cannot switch a restricted build back to public.

```bash
export VITE_ENDPOINTS='{
  "priceHistory": "https://prices.internal.example",
  "spotPrices": "https://prices.internal.example/api/v3",
  "fx": "https://fx.internal.example/v1",
  "tokenRegistry": "https://tokens.internal.example/metadata",
  "bitcoinEsplora": "https://esplora.internal.example/api",
  "ethereumBlockscout": "https://blockscout.internal.example",
  "cardanoYaci": "https://yaci.internal.example"
}'
export VITE_EGRESS=restricted
npm ci
npm run build          # typecheck, then build/ with the endpoints baked in
```

Without `VITE_EGRESS=restricted` the configured endpoints become the defaults, but any key you did not
set still points at its public provider, and users may still override endpoints in Settings.

### Serving the PWA from your origin

`build/` is a static site. `vite.config.ts` sets `base: './'` and the app uses hash routes, so it works
from any path on any host without server rewrites - `https://intranet.example/tools/coineda/` is fine.
Serve it over HTTPS (the service worker requires it) and make that origin the one your services allow in
CORS.

### Electron

The desktop shell loads the same `build/` from its own `coineda://app` origin, so build first with the
variables set, then package:

```bash
VITE_ENDPOINTS='...' VITE_EGRESS=restricted npm run build
npm run dist           # electron-builder installers, containing that build/
```

`npm run dist` does not rebuild; the installers contain whatever `build/` holds, so always run the
`build` with the environment set immediately before it. Allow `coineda://app` as an origin on your
services.

## How restricted mode behaves

Restricted mode applies when the build sets `VITE_EGRESS=restricted` (or, in an unpinned build, the user
enables it). In it, only endpoints that differ from the public defaults count as configured, and nothing
else is ever contacted:

- **Hidden modules.** The add-source list shows only self-hostable modules whose endpoint is configured.
  Bitpanda (a hosted exchange API) is never shown; e.g. the Ethereum module disappears if
  `ethereumBlockscout` was left at its public default. CSV imports are local and always available.
- **Missing prices instead of public calls.** A price, rate or token-metadata service that is not
  configured is treated as unavailable: no request is made, and affected values are reported as missing
  (the tax report lists them as unresolved; the overview shows the asset unpriced). Nothing falls back to
  a public provider.
- **Refused foreign sources.** A source whose base URL points at a host outside the configured endpoints
  (for example one imported in a checkpoint from a public build) is refused before any request is made,
  with "This source points at a host outside the configured endpoints."

## What the method sheet shows

Every tax report's method sheet carries an **Egress** line. A public build prints `Egress: public`. A
restricted build prints `Egress: restricted` followed by the host of each configured service the report
used (host names only - no paths, no keys). The JSON register export carries the same as `method.egress`
and `method.endpoints`, so an auditor can confirm from the report itself that it was produced without
third-party calls, and against which services.
