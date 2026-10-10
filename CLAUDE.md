# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Coineda is a **local-first** crypto portfolio tracker and tax calculator (GPLv3). There is no backend: all
user data lives in the browser's IndexedDB, and chains and exchanges are queried directly from the browser.
The same React codebase ships as a PWA (GitHub Pages) and as an Electron desktop app; `mobile/` is a
separate Flutter project that ESLint and Prettier ignore. The German report is built around BMF 06.03.2025
and aims to be a filing aid: figures with their Anlage SO / KAP line references and an audit trail back to
the ledger.

Legal note carried from the README: Coineda gives no tax, legal or accounting advice; the rules are written
"to the best of the contributors' knowledge". Be conservative when changing tax code.

## Commands

```bash
npm start                # Vite dev server on http://localhost:3000 (port is load-bearing for Electron)
npm run dev:expose:https # LAN dev server with a self-signed cert (camera/QR needs a secure context)
npm run build            # tsc --noEmit, then production build into build/
npm test                 # vitest in watch mode
npx vitest run           # vitest once (this is what you want for a check)
npx vitest run tests/krakenCsv.test.ts          # single file
npx vitest run -t 'strips a UTF-8 BOM'           # single test by name
npm run coverage         # vitest run --coverage
npm run lint             # eslint .
npm run format           # prettier --write .
npm run format:check     # prettier --check .
npm run electron-dev     # Vite dev server + Electron pointed at :3000
npm run dist             # electron-builder installers
```

`eslint.config.js` is an ESLint 10 flat config (`@eslint/js` + `typescript-eslint` +
`eslint-plugin-react-hooks`, `eslint-config-prettier` last). Prettier: single quotes, 2-space tabs.
`vite.config.ts` configures both the build and Vitest (its `test` block: jsdom, `tests/setup.ts`, and
`TZ: 'America/New_York'` on purpose, so a local-time slip across a UTC day or year boundary fails in tests).
`tsconfig.json` is `strict`, `noEmit`, `"jsx": "react-jsx"` (no per-file `import React`), with `@/*` →
`src/*`. `npx tsc --noEmit` is the only typecheck.

## Architecture

### Ledger (`src/ledger/`)

- `db.ts`: one IndexedDB database per client (default name `coineda-v2`, `DB_VERSION = 6`) with stores
  `events`, `sources`, `cursors`, `prices`, `settings`, `tokenMeta`, `transferLinks`. Schema changes go in
  `upgrade()` behind `oldVersion < n` guards. The old v1 `Coineda` database is deliberately left untouched.
- Events upsert on the unique `identity` index `[sourceId, externalId]` (`putEvents`,
  `putEventsIfSourceExists`), keeping the original row `id`. That identity is what makes a re-sync or
  re-import converge instead of duplicating, so a source's `externalId` must be stable across runs.
- `openLedger(expected?)` / `openLedgerForWrite(options)`: long-running flows (sync, tax run) capture
  `activeLedgerName()` once and pass it as `{ ledger }`; a write after a client switch throws
  `LedgerSwitchedError` instead of landing in another client's database.
- **Read-only flag**: `setLedgerReadOnly` makes every write helper throw `LedgerReadOnlyError`.
  `setActiveLedger` clears it on every call, so whoever activates a ledger must set it again afterwards
  (`setActiveClient` and the `Gate` in `App.tsx` do). Review copies rely on this at the store level, not
  just on hidden buttons.
- `types.ts`: `LedgerEvent { id, sourceId, externalId, timestamp (epoch ms UTC), kind, legs, origin,
rewardKind?, derivative?, txHash?, raw?, note? }`; `EventKind` = trade | transfer | reward | fee | fiat-in |
  fiat-out | derivative; `Leg { assetId, amount, direction: in|out, venue, role: principal|fee }`.
  `origin: 'derived'` rows are re-fetchable; `'authored'` rows are the user's own and survive
  `deleteDerivedEvents`. `note` is display-only prose, never parsed: anything a rule branches on needs a
  typed field (that is why `rewardKind`, `derivative` and `txHash` exist).
- `amount.ts`: amounts are **decimal strings, never JS numbers**, through big.js (no exponents, `-0`
  normalised to `0`). For any asset in `ASSET_DECIMALS` the amount is in **base units** (lovelace, satoshi,
  wei); fiat amounts are plain decimals.
- `balances.ts`: holdings are folded from the log (`foldHoldings`), never stored. `ownedVenuesOf` trusts
  every venue in the ledger as the user's own; `isInternalTransfer` handles a self-send within one event.
- `transfers.ts`: `linkInternalTransfers` pairs an owned OUT and an owned IN **only by identical `txHash`**:
  no amount or time heuristics, because a wrong pair hides a real disposal. `proposeTransfers.ts` suggests
  candidates (amount within 1 %, ≤ 72 h apart) for sources without a hash; it never decides. A confirmed
  proposal is stored in `transferLinks` (`manualLinks.ts`) keyed by `${sourceId}|${externalId}` and overlaid
  as `txHash` by `getLinkedEvents()`, so the exact linker handles it from then on.
- `fingerprint.ts`: SHA-256 over canonical events (excluding `id`, `sourceId`, `raw`) plus manual links.
  Printed on reports and carried in checkpoints so the two can be tied together.

### Assets and prices (`src/assets/`, `src/prices/`)

- `src/assets/catalogue.ts` `ASSET_CATALOGUE` is the single list of assets Coineda can scale and price, each
  row with `decimals`, `chain`, `kind`, optional `coingeckoId` and `verified` provenance. Asset ids are
  chain-qualified (`cardano:lovelace`, `eth:native`, `eth:0x…`, `fiat:eur`). `ASSET_DECIMALS`
  (`prices/scale.ts`) and `COINGECKO_IDS` (`prices/coingecko.ts`) are derived from it: add an asset there,
  never to the derived maps.
- **Never guess a ticker.** `resolveSymbol` returns an entry only when exactly one matches; ambiguous
  symbols (NIGHT, see `src/assets/ids.ts`) need an explicit asset id. Exchange importers go through
  `src/sources/csv/resolveTicker.ts`. `decimalsOf` returns 0 for an unknown asset, which is correct for
  pricing and corrupting for import, hence `toBaseUnits` below refuses instead.
- Spot prices: CoinGecko (`fetchSpotPrices`), cached in the ledger's `prices` store keyed
  `${assetId}|${currency}|${date}` for the current UTC day (`priceStore.ts` `resolveSpotPrices`). The base
  fiat is priced at 1; other fiat at the ECB rate (`ecb.ts`). Unpriced assets go to a `missing` list,
  never to zero.
- Historical prices (`history.ts` `fetchHistory`): per UTC day, DefiLlama USD × ECB rate first, CoinGecko
  (365-day free-tier limit, optional user API key) as fallback. Failures are reported per asset.
- Base currency is a user setting (`baseCurrency`, normalised lowercase so it matches `fiat:<iso>`). The
  DATEV export and the German forms are euro by nature.

### Sources (`src/sources/`)

Two registries, both bundled and added only by reviewed PR (code runs beside the user's credentials):

- **Pull modules** (`SourceModule`, `src/sources/types.ts`) in `registry.ts`: `cardano-yaci`,
  `cardano-blockfrost`, `bitcoin-esplora`, `ethereum-blockscout`, `bitpanda`. Driven page by page with an
  opaque cursor by `src/sync/syncSource.ts`, capped at `MAX_PAGES`. `conformance.ts` `runConformance`
  (termination, idempotent replay, no duplicate `externalId`, decimal amounts, declared kinds, trades with
  both directions) is enforced by `tests/registry.test.ts` and per-module tests; fixtures live in
  `src/sources/<id>/fixtures/`.
- **File modules** (`FileSourceModule`, `src/sources/csv/types.ts`) in `csv/registry.ts`: `kraken-csv`,
  `binance-csv`, `coinbase-csv`, `ledger-live-csv`, `mapped-csv`. A module is a pure `sniff(text)` +
  `parse(text) → { events, skipped, supersedes? }`; unreadable rows go to `skipped`, never silently
  dropped. `detectFileModule` picks the first module whose `sniff` matches the **content** (never the
  filename).
- **The file gate** (`tests/fileConformance.test.ts`): every file module except `mapped-csv` must parse its
  first `fixtures/*.csv` into well-formed events (crypto amounts as integer base-unit strings), key its
  label and help in both locales, refuse junk without throwing, and be the **only** module whose `sniff`
  accepts its fixture. Sniffs must be mutually exclusive; registry order is not a substitute.
- `csv/importFile.ts` keeps **one source per module id**, reused on every import, so a longer export
  rewrites rows it already wrote. It deletes `supersedes` ids first (Kraken `refid` and Binance same-second
  grouping replaced earlier per-row events). `mapped-csv` is never sniffed: `MapCsvDialog` collects a
  `CsvMapping` and `mapped-csv/importMapped.ts` keeps **one source per module + venue label**, deletes
  nothing unless `replaceExisting` is passed (then atomically via `replaceSourceEvents`).
- `csv/readCsv.ts` reads by column name and strips a BOM. Delimiter sniffing is **opt-in**
  (`{ delimiter: 'auto' }`), because a German-Excel `;` file also carries decimal commas.
- `csv/ledgerShape.ts`: `toBaseUnits` is the one whole-unit → base-unit boundary; it requires known
  decimals (`UnscalableAmountError`). `normaliseDecimal` refuses values with both `.` and `,`;
  `stripThousands` removes commas only where they are unmistakably thousands groups.
- `docs/modules/writing-a-source-module.md` and `writing-a-tax-module.md` are the contributor contracts.

### Tax (`src/tax/`)

`runTaxReport(module, { year, baseCurrency, matching?, rate?, carryForward? })` in `runTaxReport.ts`:
read events + manual links → link internal transfers by `txHash` and net them out (transfer fees become
`:residual-out` disposals) → `module.classify` → `resolveValues` (historical prices, per UTC day) →
`match` (`matching.ts`, grouped per asset, hard partition boundary from `module.partitionBy`) →
`module.assess` → `buildRegister`. Tax years are UTC (`taxYearOf`).

- Jurisdictions in `registry.ts`: `de` (`defaultMatching: 'fifo'`, partitioned per venue) and `at`
  (`'moving-average'`, partitioned Altvermögen/Neuvermögen). `classify` must be pure and deterministic;
  `tests/taxConformance.test.ts` runs it twice and stubs the clock and randomness to throw.
- `handles` lists kinds a module has confident rules for; an empty `classify` result for an unlisted kind
  becomes an `unclassified` unresolved item rather than vanishing.
- `de.forms.ts` `FORM_LINES_DE` maps filing figures to form lines per year, with provenance; unverified
  years are deliberately absent.
- `TaxReport.method` (`ReportMethod`) records matching, partition label, base currency,
  `valuation: 'utc-day'`, price sources, app version, ledger `fingerprint` and the jurisdiction's
  `rulesVersion` (bump it with a `changelog` entry when rules change).
- Loss carry-forward comes from settings `lossCarryForward[year]`, entered by the user.
- `register.ts`: `registerToCsv` / `reportToJson` exports.

### Exports (`src/datev/`)

`buchungsstapel.ts` builds a DATEV EXTF Buchungsstapel (format 700) from a German `TaxReport`; pure, the
caller supplies the time. Dates are DDMM of the UTC day. Encode with `encodeCp1252` (`cp1252.ts`), not
UTF-8. Advisor numbers and accounts come from settings `datev`; there are no defaults.

### Clients and checkpoints (`src/clients/`, `src/checkpoint/`)

- A client is one IndexedDB database. `clients/registry.ts` keeps the list in localStorage
  (`coineda.clients`, active id in `coineda.activeClient`, in-memory fallback when storage throws). Kinds:
  `client` (`coineda-v2` or `coineda-client-<id>`) and `review` (`coineda-review-<id>`, read-only). The
  last `client` cannot be removed.
- `App.tsx` keys `ClientProvider` on the client id, so a switch remounts the gate and router. The `Gate`
  activates the ledger, re-applies the read-only flag, and shows `OnboardingFlow` until `isOnboarded()`.
- `checkpoint/format.ts`: a checkpoint is sealed (`crypto.ts`: deflate-raw, then AES-GCM with PBKDF2 over
  an 8-character base32 secret). Scope `handover` carries settings, sources with credentials, authored
  events and manual links (small enough for a QR); `backup` adds all derived events. `restoreCheckpoint`
  writes in one transaction; `clients/review.ts` restores with `stripCredentials: true`, keeping only
  `PUBLIC_IDENTITY_KEYS` in source configs.
- `settings/settingsStore.ts`: settings live in the ledger's `settings` store under `SETTINGS_KEY` and
  `ONBOARDED_KEY` (language, baseCurrency, coingeckoApiKey, taxpayer, lossCarryForward, datev).

### UI shell

Routes (`HashRouter`): `/` → `screens/MainScreen.tsx`, `/tax` → `screens/TaxReportScreen.tsx`, inside
`components/layout/AppShell.tsx`. Sources are added via `AddSourceDialog` (file drops go to `importFile`,
unknown formats to `MapCsvDialog`). UI is Tailwind + shadcn/ui; `src/components/ui/` is vendored CLI
output, ignored by Prettier, with relaxed hook rules in ESLint: update it through the shadcn CLI, not by
hand.

`HashRouter` plus `base: './'` is deliberate: one build works from Electron's custom scheme **and** from a
GitHub Pages subpath without rewrites. Electron (`public/electron.js`) loads `localhost:3000` in dev and
serves `build/` over a privileged `coineda://app/` scheme in production, because Vite's
`<script type="module" crossorigin>` fails from a `file://` origin. The handler's `host === 'app'` check
and its `path.relative` containment inside `build/` are both load-bearing. The service worker
(`vite-plugin-pwa`, `autoUpdate`) registers only when `location.protocol` is `http:`/`https:`;
`workbox.globPatterns` stays narrow so Electron-only files are not precached. The app version comes from
`src/global/version.ts`.

### i18n

`src/i18n.js` loads `src/translations/{en,de}.json` eagerly with browser language detection. Keys are the
English strings themselves under `"translation"`. Every key goes into **both** files; changing English
copy means changing the key in `de.json` too. New German copy uses the du-form (some older strings still
say Sie). `tests/i18n.test.ts` checks duplicate keys, keys present in only one file, empty translations
and literal `t()` keys missing from `en.json`; the registry and file gates check module labels.

## Conventions

- **Conventional Commits are required**: `release-please` parses them for `CHANGELOG.md` and versioning.
  No attribution or co-author trailers.
- Before a commit: `npx vitest run && npx tsc --noEmit && npx eslint . && npx prettier --check .` (CI runs
  lint, format check, typecheck and tests in `test.yml` and again in `deploy.yml` before the build).
- CI is keyed on release-please: `deploy.yml` and `build.yml` run only when the head commit message
  contains `release-please--branches--main`, `release.yml` only when it does not; `test.yml` skips `main`.
  Keep those conditions intact.
- Money and amounts are decimal strings through big.js or `src/ledger/amount.ts`, never JS numbers.
- Timestamps are epoch ms UTC; day and year boundaries are taken in UTC.
- Tests live in `tests/`, import `fake-indexeddb/auto`, clear the stores they touch in `beforeEach`, and
  build events with `tests/helpers/ledger.ts`. Importer fixtures sit beside their module in
  `src/sources/<id>/fixtures/`. Exact insert/update/skip counts in tests are specs: a changed count needs
  a reason, not a new number.
- Feature work happens in git worktrees under `.claude/worktrees/`. Vitest's default exclude is only
  `node_modules` and `.git`, so `npx vitest run` from the main checkout also collects every worktree's
  `tests/` and reports doubled or foreign failures; run tests from inside the worktree you changed.
- `TODO.md` is the owner's private roadmap and is gitignored; `docs/superpowers/` is gitignored working
  notes, and `.superpowers/` is a working directory Prettier ignores. Do not commit them.

## Pitfalls that have bitten this codebase

- **Unit errors**: whole units stored as base units (or the reverse) are silent 10^n errors. Go through
  `toBaseUnits`; add decimals to the catalogue in the same commit as the source.
- **Sniff overlap**: a loose `sniff` steals another importer's files. The file gate's "only claimant"
  test is the guard; keep it passing rather than reordering the registry.
- **Binance same-second grouping**: rows sharing a timestamp are grouped into one trade; more than two
  principal assets in one bucket are ambiguous and are left as transfers with a note, not fused.
- **Ledger Live**: a native send's amount includes its fee, so principal = amount − fee; token rows never
  book the gas a second time.
- **Decimal commas**: `0,01` is a hundredth, not `001`. Never strip commas outside `stripThousands`.
- **DST**: mapped-CSV local times go through `mapped-csv/dates.ts` (gap uses the pre-change offset,
  overlap resolves to the first occurrence); do not hand-roll offsets.
- **The NIGHT ticker**: two CoinGecko coins share the symbol at prices ~4,500× apart. Identify by
  `NIGHT_ASSET_ID` (policy id + asset name), never by ticker.
