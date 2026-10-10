# Security

**Zusammenfassung (Deutsch).** Coineda ist eine lokal laufende Anwendung ohne eigenen Server und ohne
Telemetrie: Alle Daten liegen in der IndexedDB bzw. im localStorage des Browser- oder Electron-Profils,
und zwar **unverschlüsselt**; eine App-Sperre gibt es nicht. Wer Zugriff auf das Gerät bzw. das Profil hat,
kann API-Schlüssel, Wallet-Adressen, xpubs, Steuernummer und alle Transaktionen lesen. Netzwerkzugriffe
gehen direkt vom Gerät an Kurs-Anbieter (CoinGecko, DefiLlama, Frankfurter/EZB, Cardano Token Registry)
und an die vom Nutzer eingerichteten Datenquellen (Blockchain-Indexer, Bitpanda); diese Anbieter sehen
dabei IP-Adresse, User-Agent, gehaltene Assets, abgefragte Adressen und den `Origin`-Header der App
(`https://fabianbormann.github.io` bzw. `coineda://app`), aber keine nutzer- oder installationsbezogene
Kennung; einen `Referer` sendet die App nicht. Checkpoints (Übergabe/Sicherung) sind mit AES-256-GCM
verschlüsselt, der Schlüssel wird per PBKDF2-SHA-256 (600.000 Iterationen) aus einem 8-stelligen
Base32-Geheimnis (40 Bit) abgeleitet – ausreichend für eine einmalige Übergabe, aber kein dauerhafter
Schutz für eine aufbewahrte Sicherungsdatei, die alle Zugangsdaten enthält. Eine Prüfkopie (Review) enthält
keine API-Schlüssel, aber weiterhin die xpub sowie Name, Steuernummer und DATEV-Nummern der
Steuerpflichtigen. Die Web-Version aktualisiert sich ohne Rückfrage von der Origin des Betreibers. Die
Desktop-Installer sind derzeit nicht signiert. Sicherheitslücken bitte vertraulich über „Report a
vulnerability“ (GitHub Security Advisories) melden, nicht als öffentliches Issue; wir koordinieren die
Veröffentlichung innerhalb von 90 Tagen.

This document describes what Coineda stores, what it sends, how it protects both, and where it does not.
Every statement names the file (and, where useful, the function or constant) that implements it, so it
can be checked against the code. Paths are relative to the repository root.

## Scope and model

- **Local-first, no Coineda server.** There is no backend. User data lives in IndexedDB, one database per
  client (`src/ledger/db.ts`, `DEFAULT_LEDGER_NAME = 'coineda-v2'`; further clients
  `coineda-client-<id>` and `coineda-review-<id>` in `src/clients/registry.ts`). Every outbound request
  goes from the device directly to a third-party provider (see [Data in transit](#data-in-transit)).
- **No telemetry, analytics or crash reporting.** The source contains no analytics or error-reporting SDK
  and no `sendBeacon` call (a search of `src/`, `public/`, `index.html` and `package.json` for Sentry,
  analytics, gtag, telemetry, PostHog, Mixpanel, Plausible, Matomo and `sendBeacon` finds nothing). The
  Electron shell has no auto-updater (no `electron-updater` or `autoUpdater` in `public/electron.js` or
  `package.json`).
- **Two shells, one codebase.** A PWA served from GitHub Pages and an Electron desktop app
  (`public/electron.js`). Both run the same renderer bundle built by `vite.config.ts`.

Adversaries considered, and what this document says about each:

| Adversary                                                                         | Relevant sections                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A third party with access to the device or OS account                             | [Data at rest](#data-at-rest), [Known weaknesses](#known-weaknesses)       |
| A malicious or compromised data provider (price API, chain indexer, exchange API) | [Data in transit](#data-in-transit), [Known weaknesses](#known-weaknesses) |
| A malicious exchange export file or checkpoint file                               | [Checkpoints](#checkpoints), [Data in transit](#data-in-transit)           |
| A network observer                                                                | [Data in transit](#data-in-transit)                                        |
| Whoever deploys the web build                                                     | [Web shell](#web-shell), [Build and release](#build-and-release)           |

Out of scope: a compromised operating system, browser or Electron runtime; malicious browser extensions
(they run with access to the page); physical attacks on a running, unlocked device.

**Imported files.** CSV exports are parsed locally and never uploaded. A file module is a pure
`sniff(text)` + `parse(text)` (`src/sources/csv/types.ts`); unreadable rows are reported as `skipped`
rather than thrown, and the module is chosen by content, not by file name (`detectFileModule` in
`src/sources/csv/registry.ts`). Parsed values reach the UI through React, which escapes text.

## Data at rest

Nothing below is encrypted by Coineda. IndexedDB and localStorage are stored in plaintext inside the
browser profile (PWA) or the Electron user-data directory. There is no app lock, PIN or passphrase on
start-up. Whatever protection exists is the operating system's: the user account, disk encryption, and
the browser's profile isolation.

| Datum                                                                                                                                                 | Store                                                                                           | Encrypted? | Notes                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source configuration: Bitpanda API key, Blockfrost project id, Bitcoin xpub, addresses, custom `baseUrl`                                              | IndexedDB `sources` (`src/ledger/db.ts`)                                                        | No         | Field names per module manifest: `apiKey` (`src/sources/bitpanda/index.ts`), `projectId` (`src/sources/cardano-blockfrost/index.ts`), `xpub` and `address` (`src/sources/bitcoin-esplora/index.ts`), `address` (Yaci, Blockscout). |
| Last sync status and error text (`lastSyncedAt`, `lastError`)                                                                                         | IndexedDB `sources`                                                                             | No         | Written by `src/sync/syncSource.ts`. Error text may contain up to 120 characters of a provider response body (see [Known weaknesses](#known-weaknesses)).                                                                          |
| Settings: language, base currency, CoinGecko API key, taxpayer name and tax number, loss carry-forward, DATEV advisor and client numbers and accounts | IndexedDB `settings` under `SETTINGS_KEY` (`src/settings/settingsStore.ts`)                     | No         | The taxpayer name and tax number are personal data printed on the report.                                                                                                                                                          |
| Ledger events (trades, transfers, rewards, fees, fiat movements), including authored manual entries                                                   | IndexedDB `events`                                                                              | No         | Reveal the full transaction history and holdings.                                                                                                                                                                                  |
| Sync cursors                                                                                                                                          | IndexedDB `cursors`                                                                             | No         | Opaque per-source paging state.                                                                                                                                                                                                    |
| Price cache                                                                                                                                           | IndexedDB `prices`                                                                              | No         | Keyed `${assetId}\|${currency}\|${date}` (`src/prices/priceStore.ts`); reveals which assets are held.                                                                                                                              |
| Cardano token metadata and logos                                                                                                                      | IndexedDB `tokenMeta`                                                                           | No         | Fetched from the token registry (`src/assets/tokenMetaStore.ts`).                                                                                                                                                                  |
| Confirmed manual transfer links                                                                                                                       | IndexedDB `transferLinks` (`src/ledger/manualLinks.ts`)                                         | No         |                                                                                                                                                                                                                                    |
| Client registry: client ids, labels, database names, review metadata (file name, fingerprint, verdict)                                                | localStorage `coineda.clients`, active id in `coineda.activeClient` (`src/clients/registry.ts`) | No         | A client label is free text and may be a person's name. Falls back to memory when localStorage throws.                                                                                                                             |
| Theme choice                                                                                                                                          | localStorage `coineda.theme` (`src/components/theme/ThemeProvider.tsx`, `public/theme-init.js`) | No         |                                                                                                                                                                                                                                    |
| Detected UI language                                                                                                                                  | localStorage `i18nextLng` (`src/i18n.js`)                                                       | No         | Cached by `i18next-browser-languagedetector` with its default `caches: ['localStorage']`; `src/i18n.js` sets no `detection` options.                                                                                               |

Deleting data: "reset" (`resetDevice` in `src/settings/resetDevice.ts`) clears every store of the
**active** client's database in one transaction; other clients' databases are removed one by one through
`removeClient` (`src/clients/registry.ts`, `deleteLedgerDatabase` in `src/ledger/db.ts`). The theme choice
is deliberately kept. Clearing IndexedDB does not securely overwrite the underlying files on disk.

## Data in transit

All provider URLs below are `https://`. In a production build the Content-Security-Policy restricts
`connect-src` to `'self' https:` (`public/csp.json`), so a plain `http://` base URL entered by the user is
refused by the browser; a self-hosted indexer must therefore be served over TLS. Every request reveals the
device's IP address, a browser or Electron user agent and the app's origin to the provider: provider calls
are cross-origin CORS requests, which carry an `Origin` header (`https://fabianbormann.github.io` on the
web, `coineda://app` on desktop) that the page cannot suppress. The `Referer` header is suppressed by
`<meta name="referrer" content="no-referrer" />` in `index.html`. No request carries a user- or
install-specific identifier.

Every host in the table below is a base URL in `src/config/endpoints.ts`, which a build can replace through
`VITE_ENDPOINTS`. A build with `VITE_EGRESS=restricted` contacts only the endpoints it configured: modules
whose host is not configured are hidden, an unconfigured price, rate or token-metadata service yields a
missing value instead of a public call, a source pointing anywhere else is refused before any request, and
the tax report's method sheet states the mode and the hosts used. Two tests hold this in place:
`tests/egressAllowlist.test.ts` fails on any new `http(s)://` host in `src/` that is not an endpoint or a
named documentation link, and the fetch guard in `tests/setup.ts` refuses any request a test makes to a host it did
not register. The service contracts, CORS headers and build steps are in
[docs/operations/self-hosting.md](docs/operations/self-hosting.md).

| Host                                                                             | Code                                                                                           | Trigger                                                                                                                                                                                                                                          | What is sent                                                                                                                                                                                | What it reveals                                                                                 | How to disable                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `api.coingecko.com`                                                              | `src/prices/coingecko.ts` (`fetchSpotPrices`, `fetchHistoricalPrices`, `fetchHistoricalPrice`) | Spot: overview screen and journey video load (`resolveSpotPrices` in `src/screens/MainScreen.tsx`, `src/journey/series.ts`), once per asset and UTC day (cached). Historical: tax report, as fallback after DefiLlama (`src/prices/history.ts`). | CoinGecko coin ids of held assets and the base currency; for history a coin id and date range. The optional CoinGecko key is sent only as the `x-cg-demo-api-key` header, never in the URL. | Which assets are held (not amounts); for history, which days are being valued.                  | Hold no priced crypto asset. There is no switch today; an authority build without third-party calls is planned (phase 6c). |
| `coins.llama.fi`                                                                 | `src/prices/defillama.ts` (`fetchUsdHistory`)                                                  | Tax report: historical prices, tried first (`src/prices/history.ts`).                                                                                                                                                                            | `coingecko:<id>` coin names with the UTC-midnight timestamps of the days being valued, in the query string.                                                                                 | Which assets were transacted and on which days.                                                 | As above (no switch; phase 6c).                                                                                            |
| `api.frankfurter.dev` (ECB reference rates)                                      | `src/prices/ecb.ts` (`fetchRates`, `fetchUsdRates`)                                            | Converting USD prices or a non-base fiat holding into the base currency (`src/prices/history.ts`, `src/prices/priceStore.ts`).                                                                                                                   | A date range and a currency pair.                                                                                                                                                           | The base currency and the date range of interest.                                               | As above (no switch; phase 6c).                                                                                            |
| `tokens.cardano.org`                                                             | `src/assets/tokenRegistry.ts` (`fetchTokenMeta`)                                               | Displaying Cardano native tokens whose metadata is not cached (`src/assets/TokenMetaContext.tsx`).                                                                                                                                               | `POST /metadata/query` with the token subjects (policy id + asset name), in chunks of 50.                                                                                                   | Which Cardano native tokens are held.                                                           | Hold no Cardano native tokens (no switch; phase 6c).                                                                       |
| `eth.blockscout.com` (default; user-configurable `baseUrl`)                      | `src/sources/ethereum-blockscout/translator.ts` (`DEFAULT_BASE_URL`)                           | Adding, editing or syncing an Ethereum source (probe in `AddSourceDialog.tsx`/`EditSourceDialog.tsx`; sync in `src/screens/MainScreen.tsx`).                                                                                                     | The configured address in the URL path (`/api/v2/addresses/<address>/…`). No credential.                                                                                                    | That this IP is interested in this address: links the user to the address and its full history. | Remove the source, or point `baseUrl` at a self-hosted Blockscout.                                                         |
| `blockstream.info` (default; user-configurable `baseUrl`)                        | `src/sources/bitcoin-esplora/translator.ts` (`DEFAULT_BASE_URL`)                               | Adding, editing or syncing a Bitcoin source.                                                                                                                                                                                                     | Each address in the URL path (`/address/<address>/txs`). An xpub is **not** sent: addresses are derived from it locally (`src/sources/bitcoin-esplora/xpub.ts`).                            | All queried addresses together, which lets the provider cluster them into one wallet.           | Remove the source, or point `baseUrl` at a self-hosted Esplora.                                                            |
| `yaci-store.mainnet.colo2.cf-systems.org` (default; user-configurable `baseUrl`) | `src/sources/cardano-yaci/index.ts` (`DEFAULT_BASE_URL`), `src/sources/cardano/`               | Adding, editing or syncing a Cardano (Yaci) source.                                                                                                                                                                                              | The address and its stake account in URL paths (`/addresses/…`, `/accounts/<stake>/…`), transaction hashes. No credential.                                                                  | The wallet's addresses and stake account.                                                       | Remove the source, or point `baseUrl` at a self-hosted Yaci Store.                                                         |
| `cardano-mainnet.blockfrost.io` (default; user-configurable `baseUrl`)           | `src/sources/cardano-blockfrost/index.ts` (`DEFAULT_BASE_URL`, `headers`)                      | Adding, editing or syncing a Cardano (Blockfrost) source.                                                                                                                                                                                        | As Yaci, plus the Blockfrost project id in the `project_id` request header.                                                                                                                 | As Yaci, plus the user's Blockfrost account (via the project id).                               | Remove the source.                                                                                                         |
| `api.bitpanda.com`                                                               | `src/sources/bitpanda/translator.ts` (`API_ROOT`, `headersFor`)                                | Adding, editing or syncing a Bitpanda source.                                                                                                                                                                                                    | The Bitpanda API key in the `x-api-key` header.                                                                                                                                             | The user's Bitpanda account; Bitpanda already holds that account's history.                     | Remove the source. The endpoint is a constant and cannot be changed.                                                       |

Notes:

- **Sync is user-initiated.** `syncSource`/`syncAll` (`src/sync/syncSource.ts`) are called from the
  refresh, re-sync and edit handlers in `src/screens/MainScreen.tsx`; there is no background or scheduled
  sync. Sync is refused on a review copy (`if (readOnly) return;` in the same handlers).
- **Secrets in error messages.** The module contract forbids putting anything from a source's `config` into
  an error message (`src/sources/types.ts`, doc comment on `SourceModule`). The Bitpanda translator
  additionally runs the response-body excerpt it puts into an error through `redactSecret`
  (`src/sources/bitpanda/translator.ts`, used in `asJson`), which replaces the raw or URL-encoded key with
  `[redacted]` before the excerpt is cut to 120 characters, so a key straddling the cut cannot leak in part
  (tested in `tests/bitpandaErrors.test.ts`). The Blockscout translator echoes an unredacted
  120-character body excerpt (`asJson` in `src/sources/ethereum-blockscout/translator.ts`); its requests
  carry no secret, so there is nothing of the user's to leak there today, but error messages can contain
  provider-controlled text. They are rendered as text, not HTML.
- **External links** (help and documentation) open only on click. In Electron they go to the system
  browser (see [Desktop shell](#desktop-shell)); in the renderer they are rendered by
  `src/components/ExternalLink.tsx` with `rel="noopener noreferrer"`, so no referrer is sent.
- **Camera.** Scanning a checkpoint QR code uses the camera locally; frames are decoded in the page
  (`src/onboarding/ImportCheckpoint.tsx`, `src/checkpoint/channel.ts`) and not transmitted. The scanner is
  offered in both shells, so the desktop shell grants the camera (and nothing else) to the app (see
  [Desktop shell](#desktop-shell)).
- **Provider responses are trusted as input.** Prices from CoinGecko, DefiLlama and Frankfurter become
  valuations in the tax report (`src/tax/resolveValues.ts`); a wrong or manipulated price produces a
  wrong figure. Mitigations are limited to plausibility rules: a historical point more than 12 hours from
  the requested day is rejected (`NEAREST_LIMIT_MS` in `src/prices/defillama.ts`), and an unpriced asset is
  reported as missing rather than valued at zero (`src/prices/priceStore.ts`). Chain-indexer and exchange
  responses become ledger events through the module translators; the conformance suite
  (`src/sources/conformance.ts`) checks shape, not truth.

## Checkpoints

A checkpoint moves a client's data to another device (handover) or keeps it outside the browser (backup).
It is created in `src/checkpoint/ExportCheckpointDialog.tsx` and built and opened by
`src/checkpoint/format.ts`.

**Contents** (`buildCheckpoint` in `src/checkpoint/format.ts`):

- `handover`: settings, sources **with their credentials**, authored events, confirmed transfer links and
  a fingerprint; derived (re-fetchable) events are left out and only counted (`omittedEventCount`).
- `backup`: everything in a handover plus all derived events.
- Per-device sync state (`lastSyncedAt`, `lastError`) is not carried: sources are reduced to an allow-list
  of `id`, `moduleId`, `label`, `config` (`portableSource`).

**Sealing** (`src/checkpoint/crypto.ts`):

| Parameter         | Value                                                                                                                                                      | Constant / function                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Compression       | `deflate-raw`, applied before encryption                                                                                                                   | `compress`                                         |
| Cipher            | AES-256-GCM (WebCrypto)                                                                                                                                    | `deriveKey` (`length: 256`), `seal`                |
| KDF               | PBKDF2-HMAC-SHA-256, 600,000 iterations                                                                                                                    | `PBKDF2_ITERATIONS`                                |
| Salt              | 16 random bytes per checkpoint                                                                                                                             | `SALT_LENGTH`                                      |
| IV                | 12 random bytes per checkpoint                                                                                                                             | `IV_LENGTH`                                        |
| Envelope          | `C0 ED` magic, format byte `01`, salt, IV, ciphertext                                                                                                      | `MAGIC`, `FORMAT_BYTE`                             |
| Secret            | 8 characters from the 32-character base32 alphabet, drawn with `crypto.getRandomValues` and rejection sampling: 32^8 = 2^40 ≈ 1.1 × 10^12 values (40 bits) | `TRANSFER_SECRET_LENGTH`, `generateTransferSecret` |
| Decompression cap | 512 KiB; decompression stops and fails beyond it                                                                                                           | `MAX_DECOMPRESSED_BYTES`, `decompress`             |

A handover that seals to at most 2,300 bytes is offered as a QR code; anything larger, and every backup,
is offered as a `.coineda` file (`QR_BYTE_LIMIT` and `chooseChannel` in `src/checkpoint/channel.ts`;
`checkpointFilename` in `src/checkpoint/ExportCheckpointDialog.tsx`). The secret is generated afresh each
time the dialog runs and is not stored; **one secret seals both the handover and the backup** produced in
that run (`ExportCheckpointDialog.tsx`).

**Strength, stated plainly.** The secret is short so that a person can type it from one screen into
another. An attacker who obtains the sealed bytes (a photographed QR code, a copied file) can test guesses
offline; exhausting the space costs 2^40 × 600,000 ≈ 6.6 × 10^17 PBKDF2-HMAC-SHA-256 iterations. That is
expensive but within reach of a determined attacker with GPU hardware, on a scale of days to months
rather than centuries (an estimate from the parameters, not a measurement).

- For a **handover** between two devices in front of the same person, where the QR code exists for
  seconds, this is adequate.
- For a **stored backup file**, 40 bits is not long-term protection, and the file contains every
  credential and the complete transaction history.

Recommendations: treat the secret like a password and never store it next to the file; delete a backup
file (and any downloaded copy, cloud sync or e-mail attachment of it) once it has been restored; do not
share a photo or screenshot of the QR code.

**Opening a checkpoint.** `unseal` refuses input without the magic bytes or with an unknown format byte
before attempting decryption; a wrong secret or a modified file fails AES-GCM authentication. Decrypted
content is checked for shape (`openCheckpoint`) and every event and link is validated
(`assertValidEvent`, `assertValidManualLink`) before `restoreCheckpoint` writes everything in one
IndexedDB transaction. The decompression cap bounds memory use from a crafted file; since decompression
happens only after successful authentication, reaching it requires the secret.

## Review mode

A reviewer (for example a tax advisor) can open a client's **backup** checkpoint as a separate read-only
client (`openForReview` in `src/clients/review.ts`). A checkpoint is refused for review only when it
omits derived events (`omittedEventCount > 0`, `HandoverNotReviewableError`); a handover from a client
with no derived events is a complete ledger and opens.

- **What is stripped.** Source configurations are reduced to an allow-list of public identity keys,
  `PUBLIC_IDENTITY_KEYS = ['address', 'addressList', 'xpub']` (`src/tax/sourceDirectory.ts`), applied in
  `restoreCheckpoint` with `stripCredentials: true` (`src/checkpoint/format.ts`). API keys and the
  Blockfrost project id are dropped; so is a custom `baseUrl`. The client's **CoinGecko API key** is
  removed from the restored settings as well (tested in `tests/openForReview.test.tsx`).
- **What is kept, on purpose.** Addresses and the Bitcoin **xpub** are kept so that the review's printed
  source directory names the same wallets as the client's own report. An xpub reveals every address of
  that wallet account, past and future.
- **What is not stripped.** The other settings are restored as they are: the client's taxpayer name and
  tax number, DATEV numbers, loss carry-forward, language and base currency. The reviewer's report needs
  them.
- **Side effect on prices.** Without a key, CoinGecko history is requested only within its free-tier
  window of about 365 days (`FREE_TIER_DAYS`, `freeTierCutoff` in `src/prices/coingecko.ts`); older days
  are priced from DefiLlama alone or reported as missing. The review client is read-only, so the reviewer
  cannot enter a key of their own there (`putSettings` throws `LedgerReadOnlyError`).
- **Integrity.** The fingerprint is recomputed from what was actually written and compared with the one in
  the file (`fingerprintLedger`, verdict `match`/`mismatch`/`none`); a mismatch is shown, not hidden.
- **What read-only means.** `setActiveClient` sets a module-level flag for review clients
  (`setLedgerReadOnly` in `src/clients/registry.ts`, re-applied by the `Gate` in `src/App.tsx`), and every
  write helper then throws `LedgerReadOnlyError` (`openLedgerForWrite` in `src/ledger/db.ts`). This
  prevents accidental changes through the app. It does **not** make the data tamper-proof: anyone with
  access to the browser profile or developer tools can modify the database directly. The review database
  is plaintext at rest like any other client.

## Desktop shell

Implemented in `public/electron.js`:

- **Explicit `webPreferences`:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, and `devTools` only in an unpackaged (development) build (`devTools: isDev`). There
  is no preload script, so the renderer has no Node or IPC surface.
- **Content-Security-Policy header** on every `coineda://` response, including error responses
  (`withCsp`), with the policy read from `public/csp.json`.
- **New windows denied:** `setWindowOpenHandler` always returns `{ action: 'deny' }` and passes only
  `http:`/`https:` URLs to `shell.openExternal`, so links open in the system browser. A failed
  `openExternal` is caught rather than left as an unhandled rejection.
- **Navigation pinned:** `will-navigate` cancels any navigation that is not to the app itself
  (`isAppUrl`): in a packaged build the target must have `protocol === 'coineda:'` and `host === 'app'`;
  in development its origin must be `http://localhost:3000`. An unparsable target is cancelled. The
  packaged check compares protocol and host because Node's `URL` reports the origin of any `coineda://`
  URL as `'null'`.
- **Permissions:** Electron grants every permission request by default. `setPermissionRequestHandler`
  allows only `media` with video alone (the camera, for the QR scanner, which the desktop build offers)
  and only to the app itself; microphone, geolocation, notifications and every other permission are
  denied. `setPermissionCheckHandler` likewise answers true only for `media` from the app.
- **No `<webview>`:** `will-attach-webview` is always prevented.
- **Custom scheme instead of `file://`:** the build is served from `coineda://app/` via
  `protocol.handle`; the scheme is registered as `standard` and `secure`. The handler answers 403 for any
  host other than `app` (preventing a second origin with its own storage) and 403 for any path that
  `path.relative` places outside `build/` (path traversal); malformed escapes get 400.
- **No window menu on Windows and Linux** (`setMenu(null)`). On macOS this call does not remove the
  application menu, so Electron's default menu (including View → Reload) remains there; Toggle Developer
  Tools has no effect in a packaged build because `devTools` is off.

These measures are pinned by a textual test, `tests/securityShell.test.ts`, which reads the files and
asserts the literals that carry the behaviour (for example `{ action: 'deny' }`, `devTools: isDev`,
`require('./csp.json')`, the CSP on the 403 and 400 responses, the navigation comparison and the
permission handlers); it does not launch Electron.

**Future work:** Electron fuses (`@electron/fuses`: RunAsNode, NodeOptions and NodeCliInspect off;
EmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar on) are not configured yet.

What remains the operating system's job: user-account separation, disk encryption, and protecting the
Electron user-data directory where IndexedDB and localStorage live.

**Unsigned installers.** The electron-builder configuration in `package.json` (`build`) contains no
code-signing or notarisation settings, and `.github/workflows/build.yml` passes no signing certificates.
Installers are therefore unsigned and, on macOS, not notarised, until the owner's certificates are
configured for a signed release. Users cannot verify the publisher by signature; obtain installers only
from the project's GitHub repository, or build them from source. There is no auto-update: a new version is
installed by hand.

## Web shell

- **Origin.** The PWA is deployed to GitHub Pages (`.github/workflows/deploy.yml`) at
  `https://fabianbormann.github.io/Coineda/` (linked from `README.md`). Its IndexedDB and localStorage are
  scoped to the `fabianbormann.github.io` origin.
- **The deployer controls the code.** The service worker is generated by `vite-plugin-pwa` with
  `registerType: 'autoUpdate'`, `skipWaiting` and `clientsClaim` (`vite.config.ts`) and registered
  immediately (`src/index.tsx`, only on `http:`/`https:`). A new deployment replaces the running app on the
  next load without a prompt. Whoever can publish to that Pages site — the repository's maintainers and
  GitHub — can therefore ship code that reads the locally stored data. Users who need to rule this out
  should build and serve the app themselves or use the desktop app.
- **CSP via `<meta>`.** The same policy is injected into `index.html` as
  `<meta http-equiv="Content-Security-Policy">` at build time (`src/security/cspPlugin.ts`); the source
  `index.html` contains no inline script (the pre-paint theme script is `public/theme-init.js`). The
  deployment sets no response headers (`deploy.yml` uploads `build/` as is), and `frame-ancestors` is
  ignored by browsers when delivered in a `<meta>` tag, so **framing protection is not enforced on the web
  build**; it is enforced only in Electron, by the header.

The policy (`public/csp.json`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none';
form-action 'none'
```

Limits of the policy: `style-src` allows `'unsafe-inline'` (the UI libraries inject inline styles);
`connect-src` allows **any** `https:` host, because source base URLs are user-configurable, so the CSP
does not prevent exfiltration by injected script. The development server additionally allows
`ws: http://localhost:*` and `'unsafe-inline'` scripts (`devConnectSrcExtra`, `devScriptSrcExtra`; applied
only in serve mode by `cspFor`).

## Build and release

- **Versioning and releases** are generated by release-please (`.github/workflows/release.yml`,
  `google-github-actions/release-please-action@v3`) from Conventional Commits.
- **`test.yml`** runs on pushes and pull requests for every branch except `main`: `npm ci`, then lint,
  Prettier check, `tsc --noEmit` and `vitest run`.
- **`release.yml`** runs on pushes to `main` whose head commit is **not** the release-please merge:
  `npm ci`, `vitest run` (no lint, format or type check), then release-please opens or updates the
  release PR.
- **`deploy.yml`** runs on pushes to `main` whose head commit message contains
  `release-please--branches--main`, or on manual dispatch: `npm ci`, lint, Prettier check,
  `tsc --noEmit`, `vitest run`, `npm run build`, then uploads `build/` to GitHub Pages.
- **`build.yml`** runs on the same release-please condition (its job condition reads the head commit
  message, so a pull-request or manual run skips the job). It checks out, sets up Node 22 and runs
  `samuelmeuli/action-electron-builder@v1` on Linux, Windows and macOS. It has **no** `npm ci` step and
  runs **no** tests, lint or type check; dependencies for the installers are installed by that action
  itself, so the lockfile is not enforced by this workflow. The action's `release` input is
  `startsWith(github.ref, 'refs/tags/v')`, while the workflow runs on pushes to the `main` branch, where
  `github.ref` is `refs/heads/main`. Publishing installers to GitHub Releases is therefore not confirmed
  by the current conditions, although `package.json` names `"publish": { "provider": "github" }`.
- GitHub Actions are referenced by version tag, not pinned to a commit SHA. `build.yml` declares no
  `permissions` block, so it runs with the repository's default token scope.
- **Not in place yet:** no software bill of materials (SBOM) is produced, no dependency-update automation
  is configured in `.github/`, and release artefacts are neither signed nor accompanied by provenance
  attestations.

## Known weaknesses

1. **Credentials and personal data are plaintext at rest.** API keys, the Blockfrost project id, xpubs,
   addresses, the CoinGecko key, taxpayer name and tax number sit unencrypted in IndexedDB
   ([Data at rest](#data-at-rest)). Mitigation is the operating system's (account, disk encryption).
   Users should create exchange keys with read-only permissions.
2. **No app lock.** Anyone who can open the browser profile or the desktop app on an unlocked account sees
   everything.
3. **Review copies keep the xpub and the taxpayer's identity and DATEV numbers** (credentials, including
   the CoinGecko key, are stripped; [Review mode](#review-mode)).
4. **40-bit checkpoint secret,** shared by the handover and backup of one export; adequate for a
   short-lived handover, weak for a stored backup file ([Checkpoints](#checkpoints)).
5. **Egress reveals holdings and addresses.** Price providers learn which assets are held and on which
   days they were valued; chain indexers learn the user's addresses and can link them to the user's IP;
   there is no proxy or relay ([Data in transit](#data-in-transit)). There is no switch to turn price
   lookups off yet.
6. **The Bitpanda endpoint is not configurable** (`API_ROOT` in `src/sources/bitpanda/translator.ts`).
7. **Third-party price data is trusted as valuation input** in the tax report, with only plausibility
   checks.
8. **Error messages can contain provider-controlled text** (an unredacted 120-character response excerpt
   in `src/sources/ethereum-blockscout/translator.ts`); Bitpanda's excerpt is redacted.
9. **The web build updates itself** from the deployer's origin without user confirmation, and its CSP
   cannot enforce `frame-ancestors` ([Web shell](#web-shell)).
10. **Unsigned desktop installers,** no Electron fuses, installers built without a lockfile-enforced
    install or tests, and no SBOM ([Desktop shell](#desktop-shell), [Build and release](#build-and-release)).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories: on
[github.com/fabianbormann/Coineda](https://github.com/fabianbormann/Coineda), open the **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Please include:

- the affected version (shown in the app shell, `src/components/layout/AppShell.tsx`) and shell (web or desktop, with OS);
- a description of the issue and its impact;
- steps to reproduce or a proof of concept, and any crafted input files (CSV export or checkpoint);
- whether you would like to be credited.

We follow a 90-day coordinated disclosure: please allow up to 90 days from the report for a fix before
publishing details, and we will coordinate the publication date with you.
