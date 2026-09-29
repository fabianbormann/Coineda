# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Coineda is a **local-first** crypto portfolio tracker and tax calculator (GPLv3). There is no backend: all
user data lives in the browser's IndexedDB. The same React codebase ships three ways — as a PWA, as an
Electron desktop app, and (historically) as a Flutter shell in `mobile/` that is essentially a stub.

Legal note carried from the README: Coineda gives no tax/legal/accounting advice, and the tax calculations
are explicitly "to the best of my knowledge" — be conservative when changing them.

## Commands

```bash
npm start                # Vite dev server on http://localhost:3000
npm run build            # tsc --noEmit, then production build into build/
npm test                 # vitest in watch mode
npx vitest run           # vitest once (this is what you want for a check)
npx vitest run tests/imports.test.ts            # single file
npx vitest run -t 'should import 25 Kraken'     # single test by name
npm run coverage         # vitest run --coverage
npm run lint             # eslint .
npm run format           # prettier --write .
npm run format:check     # prettier --check .
npm run electron-dev     # Vite dev server + Electron pointed at :3000
npm run dist             # electron-builder installers
```

`eslint.config.js` is an ESLint 10 flat config (`@eslint/js` recommended + `typescript-eslint` +
`eslint-plugin-react-hooks`, with `eslint-config-prettier` last to defer style to Prettier rather than
double-enforcing it as a lint error). `.eslintrc` and the CRA `react-app` preset are gone; lint and format
are separate `npm` scripts and separate CI steps, not something that runs implicitly as part of the build.
Prettier is configured for single quotes and 2-space tabs.

There is no split toolchain anymore: `vite.config.ts` configures both the production build and Vitest (via
its `test` block), and `vitest.config.ts` no longer exists. One config, one module resolution, for both.

## Architecture

### Persistence (`src/persistence/storage.js`)

`storage` is a single default-exported object created by calling `setup()` **at module import time** — the
`openDB` promise is module-global and shared. Every store method awaits that promise internally, so callers
just `await storage.transactions.getAll()`.

- DB `Coineda`, version 2. Schema changes go in the `upgrade()` callback guarded by `oldVersion` checks.
- `wrapObjectStore` provides the generic get/getAll/set/delete/clear/keys/add; each store then adds its own
  index-backed queries on top.
- On first run the `assets` store is seeded from `src/persistence/assets.json`. An asset is fiat iff it has
  a `roughly_estimated_in_euro` field, which is stored as `isFiat: 1` (fiat) or `2` (crypto) — a number,
  not a boolean, because IndexedDB cannot index booleans.

### Accounts

Coineda supports multiple isolated portfolios. Nearly every read is
`storage.transactions.getAllFromAccount(account.id)` — if you add a query, keep it account-scoped. The
active account lives in `SettingsContext` (`src/SettingsContext.tsx`) and is persisted by name in
`localStorage['activeAccount']`; `App.tsx` resolves it on boot and creates a default "Coineda" account if
none exists. Pages must wait for `settings.account` before calculating anything.

### The composed-transaction model (`src/helper/common.js`)

This is the least obvious part of the codebase. `createTransaction` normalizes everything into buys and
sells denominated in **EUR** (hardcoded throughout — there is no multi-fiat base currency):

- fiat → crypto = `buy`; crypto → fiat = `sell`.
- crypto → crypto is stored as **three rows**: a synthetic `sell` into euro, a synthetic `buy` out of euro,
  and a parent `swap` row with `isComposed: true` and `composedKeys: "<sellId>,<buyId>"`. The children carry
  `parent: <parentId>`. The EUR leg price is fetched from CoinGecko at write time, so `createTransaction`
  can throw on network failure.

Consequences to respect: aggregations must exclude `type === 'swap'` to avoid double counting, and the
importer drops rows where `isComposed === '1'` (a string, from CSV round-tripping) before re-creating them.

### Import sources (`src/import/`) — the main extension point

Two abstract bases, both intentionally easy to extend (the README points contributors here):

- **`FileInputSource`** — implement `static canImport(file)` plus `async deserialize(file)`, pushing into
  the inherited `transactions` / `transfers` / `errors` arrays. Register it in the `importSources` array in
  `src/import/index.ts`. **Order matters**: the loop breaks on the first `canImport` that returns true, and
  some detectors are loose (`KrakenFileInput` claims nearly any `.csv`), so new CSV sources generally belong
  _before_ it.
- **`ApiSyncSource`** — implement `fetch(config)`, `getMandatoryFields()` and `getDescription(t)` (the last
  returns JSX, which is why `BinanceApiSync` is a `.tsx` file). Registered in the `availableApiSources`
  `useMemo` in `src/pages/Wallets.tsx`. `BinanceApiSync` is incomplete — its button is hard-disabled by name
  in that page.

`importFiles` also dedupes by `JSON.stringify` of the row with `id` zeroed, and auto-creates any exchange it
encounters. Failures are collected as typed `ImportError`s (see `ImportErrorType`) rather than thrown.

### Tax calculation (`src/tax/`)

`TaxCalculator` (abstract) owns the country-independent part: `calculateRealizedAndUnrealizedGains` walks
transactions in date order and matches sells against buys **FIFO**, filling `realizedGains` /
`unrealizedGains` keyed by currency. Subclasses implement `calculate(account, year)` and supply the local
rules — `GermanTaxCalculator` applies the €600 threshold, a flat 50% rate, and `taxFreeAfterHoldingPeriod`.
Add a country by subclassing and registering it in the `taxCalculators` `useMemo` in `src/pages/TaxReports.tsx`.

`src/helper/tax.js` is the **superseded pre-refactor implementation and is dead code** — nothing imports it.
Don't extend it; the name collision with a local function in `TaxReports.tsx` makes greps misleading.

### Prices

All price data comes from the public CoinGecko API via `fetchPrice` in `src/helper/common.js`, cached in
`localStorage`: `simple-price-<ids>` with a 15-minute TTL for spot, `<from>-<to>-<currency>` cached forever
for historical. `fetchPrice` is overloaded — a string returns a number, an array returns a keyed map. Tax
runs issue one request per buy/sell pair, so they are slow and rate-limit-prone on real portfolios; tests
mock `axios` wholesale.

### Routing, packaging and the PWA

`HashRouter` plus `base: './'` in `vite.config.ts` is deliberate: relative asset paths and hash routes are
what make one build work from a custom scheme inside Electron **and** from an arbitrary web subpath (GitHub
Pages) without server rewrites. Don't switch to `BrowserRouter` or an absolute `base` without accounting for
both targets.

Electron's entry is `public/electron.js` (`main` in package.json); it loads `localhost:3000` in dev. In
production it does **not** load the bundled `index.html` via `file://` — Vite emits
`<script type="module" crossorigin>` tags, and module/crossorigin fetches are blocked by the browser's CORS
checks when the document has a `file://` (null) origin, which renders a blank window. Instead
`registerSchemesAsPrivileged` registers a `coineda` scheme (`standard: true`, `secure: true`) before
`app.whenReady()`, and a `protocol.handle('coineda', ...)` serves `build/` off `coineda://app/...`, giving
the page a real origin. That handler checks the request `host` (rejecting anything but `app`) and contains
the resolved path inside `build/` via `path.relative`, so treat both checks as load-bearing if you touch it.

The service worker (`vite-plugin-pwa`, `registerType: 'autoUpdate'`) genuinely works now: registration in
`src/index.tsx` is guarded to `location.protocol` being `http:`/`https:`, so it never runs inside Electron's
`coineda://` window. `workbox.globPatterns` in `vite.config.ts` is deliberately narrow
(`assets/**/*.{js,css,ttf,svg}` plus `index.html`) — a broad glob over the whole build root would also sweep
up `public/electron.js` and the Electron-only `icons/` directory, which Vite copies into `build/` alongside
the web output. The app version comes from `src/global/version.ts` (a typed re-export of
`package.json.version`, via `resolveJsonModule`), not an env var.

### i18n

`src/i18n.js` loads `src/translations/{en,de}.json` eagerly (no HTTP backend) with browser language detection
(`i18next-browser-languagedetector`). `i18next-localstorage-cache` was removed as abandoned/unmaintained, so
there is no longer a localStorage-backed cache layer — detection just re-runs on each load. Keys are **the
English strings themselves**, nested under a top-level `"translation"` object. New UI strings must be added
to both files, and changing English copy means changing the key in `de.json` too.

## Conventions

- **Conventional Commits are required** — `release-please` parses them to generate `CHANGELOG.md` and bump
  the version. See `CONTRIBUTING.md`.
- Work lands via PR from a feature branch (historically through `develop`) into `main`.
- CI is keyed on release-please: `deploy.yml` and `build.yml` only run when the head commit message
  _contains_ `release-please--branches--main`, while `release.yml` only runs when it does not. Keep that
  condition intact when editing workflows. `test.yml` deliberately skips `main`. `deploy.yml` publishes the
  PWA to GitHub Pages (`https://fabianbormann.github.io/Coineda/`) — hosting moved off Firebase — and now
  runs lint, `format:check`, `tsc --noEmit` and `vitest run` before the build step, so the commit actually
  published has been verified rather than just the one release-please merges from.
- Mixed JS/TS is expected: `src/helper/*` and `src/persistence/storage.js` are still plain JS (`allowJs`),
  everything newer is TypeScript. Shared types live in one place, `src/global/types.ts`.
- `tsconfig.json` is `strict` with `"jsx": "react-jsx"` and `noEmit` (Vite/esbuild does the transpiling), so
  `npx tsc --noEmit` is the only way to typecheck. `react-jsx` means files using JSX no longer need a
  per-file `import React from 'react'` just to make `React` resolve — don't reflexively add one.
- `recharts` is pinned at exactly `2.15.4` deliberately (it added React 19 support the week it was pinned,
  so waiting costs nothing), and MUI/`@emotion/*`/React itself are deliberately held back on their current
  majors — all four are Phase 2 work, a Tailwind CSS redesign that replaces MUI outright rather than a
  version bump. Don't upgrade any of them as a drive-by.
- Tests live in `tests/`, use `fake-indexeddb/auto` for storage and real fixture exports in `tests/assets/`.
  Tests assert exact insert/duplicate/error counts, so importer changes surface as count mismatches.
