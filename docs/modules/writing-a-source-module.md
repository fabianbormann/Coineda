# Writing a source module

A source module is how Coineda learns about a chain or an exchange. The user
picks it, supplies an address or an API key, and the module turns the
provider's raw API responses into normalised ledger events. This document is
the contract a module must satisfy, and the conformance harness
(`src/sources/conformance.ts`) is how that contract is enforced before a
module is merged.

## The types

These are defined in `src/sources/types.ts`. Copy them verbatim into your
mental model — nothing about them is left to interpretation.

```ts
export type ManifestField = {
  name: string;
  /** Translation key, not display text - see the i18n constraint. */
  label: string;
  type: 'address' | 'apiKey' | 'secret' | 'text';
  /** Translation key for the help line under the field. */
  help: string;
};

export type SourceManifest = {
  /** Stable, lowercase, hyphenated: 'cardano-yaci'. */
  id: string;
  kind: 'chain' | 'exchange';
  label: string;
  fields: ManifestField[];
  /** Exchange key permissions the module needs, so onboarding can name the
   *  exact boxes to tick and nothing wider. */
  requiredScopes?: string[];
  /** True when the provider sends no browser CORS headers and requests must
   *  go through the signing relay. Declared from the start so the relay
   *  milestone does not reshape this interface. */
  needsRelay: boolean;
  /** Which kinds this source can produce, so the UI can state coverage
   *  honestly instead of implying completeness. */
  emits: EventKind[];
  docsUrl: string;
};

export type ProbeResult = {
  ok: boolean;
  /** Translation key when !ok. */
  message?: string;
  /** False when the credential has more than read access. Undefined when the
   *  provider gives no way to tell. */
  readOnly?: boolean;
};

/**
 * What a module returns. It supplies `externalId` - the stable id from its
 * own provider - but never `id` or `sourceId`: those identify the row and the
 * configured source, which only the host knows. A module that could stamp
 * sourceId could collide two of the user's wallets onto one identity and
 * corrupt dedupe, so the contract does not let it hold that value at all.
 */
export type DerivedEvent = Omit<LedgerEvent, 'id' | 'sourceId'>;

export type FetchPage = { events: DerivedEvent[]; cursor: Cursor };

/**
 * A pure translator: config plus cursor in, normalised events out.
 *
 * A module never touches storage, never writes, never fetches prices and never
 * learns the base currency. That constraint is what makes it testable from
 * recorded fixtures - and therefore safe to accept from a contributor or to
 * generate with a model.
 */
export type SourceModule = {
  manifest: SourceManifest;
  probe(config: Record<string, string>): Promise<ProbeResult>;
  fetchEvents(
    config: Record<string, string>,
    cursor: Cursor,
  ): Promise<FetchPage>;
};
```

`ManifestField.label` and `ManifestField.help` are **translation keys**, not
display text. The onboarding UI passes them through `t()` from `i18next`; a
module that puts human-readable English into either field will render that
English literally for every locale, including German.

## A module is a pure translator

`fetchEvents` takes a config object and a cursor and returns events and a new
cursor. That is the entire surface. A module must never:

- **Touch storage.** It has no access to IndexedDB, no idea what account is
  active, and no way to know what has already been synced. The host owns
  persistence and dedupe entirely; the module's job ends at producing events.
- **Fetch prices.** Nothing a module returns should depend on CoinGecko or any
  other price feed. Tax calculation and valuation happen later, from the
  ledger, not from the module.
- **Learn the base currency.** Coineda's base currency (EUR, hardcoded
  elsewhere in this codebase) is never passed to a module and a module must
  never assume one. A module that emits amounts in anything other than the
  asset's own native units is wrong regardless of what currency the user has
  selected.
- **Report the counterparty side of a transaction.** A module emits legs
  only for the account it was configured to watch - never the other wallet,
  exchange or address a transfer touched. The host derives the set of
  venues the user owns from the venues appearing in its own events, so a
  module that reported both sides would put a stranger's venue into that
  set: `foldHoldings` would count the counterparty's received amount as the
  user's own holding, inflating the balance, and the disposal classifier
  would see both legs at "owned" venues and treat every outbound send as an
  internal transfer, hiding real disposals from the tax input. Filter every
  provider response to entries belonging to the configured address/account
  before you ever build a leg from it - see `src/sources/cardano-yaci` for a
  worked example (it filters a Cardano transaction's `inputs` and `outputs`
  to the configured address before turning either side into a leg).

This is not a style preference. A module that only transforms the provider's
own responses into events is something the conformance harness can fully
exercise from a recorded fixture with no live network, no live database and
no live price feed — which is what makes it safe to accept from a contributor
you've never met, or to generate with a model and merge on green tests alone.

## The asset id convention: `fiat:<iso-code>` vs `<chain>:<token>`

Every `Leg.assetId` must follow one of two shapes:

- A fiat currency is `fiat:` followed by its lowercase ISO code:
  `fiat:eur`, `fiat:usd`.
- A chain asset is the chain name followed by the token identifier:
  `cardano:lovelace`, `eth:0xa0b86991c...`.

This is a convention, not a type the compiler checks, and the conformance
harness does **not** enforce it — `isValidAmount` checks the amount, not the
asset id's shape. It matters anyway, because `src/ledger/balances.ts` exports
`isFiatAsset(assetId)`, which is literally `assetId.startsWith('fiat:')`, and
the tax disposal classifier (`foldDisposals`) calls it to decide whether an
out-leg is a disposal of crypto or just the fiat payment side of a buy.

If a module reports a fiat leg under any other prefix — say, plainly `eur`
instead of `fiat:eur` — `isFiatAsset` will not recognise it, and the host will
count the fiat leg of an ordinary buy as a crypto disposal. That is a wrong
number on a tax report, which is the single worst class of bug this
application can ship. There is no test in the conformance harness that will
catch a module that gets this wrong, because the harness has no way to know
what currency your module's fixtures are denominated in — so get the prefix
right by convention, deliberately, every time you construct a `Leg`.

## `externalId`: what it must guarantee, and why

`LedgerEvent.externalId` is the stable identifier the *source* assigns to an
event — a transaction hash plus an output index, a trade id, a deposit id.
Combined with `sourceId` (which the host assigns from the configured
`SourceRecord`, never the module — `DerivedEvent` omits `sourceId` and `id`
entirely, so there is no field on a module's own return value to get this
wrong in), the pair `[sourceId, externalId]` is the event's identity for
deduplication and for the storage upsert that follows it.

This means `externalId` must be:

- **Stable across time.** The same real-world event must produce the same
  `externalId` on every sync, forever. If the provider's own id for something
  can change (rare, but it happens with reorg-sensitive chain data), derive a
  stable id from content that cannot change instead.
- **Unique within one provider's event stream.** Two different real-world
  events from the same module must never collide on the same `externalId`.
- **Reproducible under replay.** Fetching the same page twice — which the
  host does, deliberately, after a partial sync — must yield the same
  `externalId` for the same underlying event. If your module invents ids
  (a counter, a random id, a timestamp with insufficient resolution) rather
  than deriving them from the provider's own stable identifiers, this
  property silently breaks and the host's dedupe silently fails: a user will
  see duplicate events after every retried sync.
- **Attached to the same content on every replay, not just the same id.**
  The host's storage write is an upsert keyed on `[sourceId, externalId]` —
  it trusts whatever payload comes with a given id and overwrites the
  stored row with it. A module that returns the same `externalId` on replay
  but a different `kind`, `timestamp` or leg amount will silently corrupt
  previously-stored data on the next re-sync. The conformance harness checks
  this directly (see below), but the property has to hold for real, not just
  pass the fixture.

## Cursors: how they work, and what `null` means

`fetchEvents(config, cursor)` takes a `Cursor` (`string | null`) and returns a
new one in `FetchPage.cursor`. The cursor is **opaque to the host** — only the
module that issued it knows how to interpret it. Encode whatever you need
into the string: a block height, a page token, a composite of both.

- Call `fetchEvents` the first time with `cursor: null`.
- As long as the returned `cursor` is non-null, there is more to fetch: call
  `fetchEvents` again with that cursor.
- `cursor: null` in the response means **done** — pagination terminates and
  the host stops calling your module for this sync.

The host may also replay a cursor you have already answered — for example
after a partial sync that failed partway through. Your module must handle
being asked for the same cursor more than once and return the same events
each time (see `externalId`, above, and idempotence, below).

## The conformance properties

`runConformance(module, fixture)` from `src/sources/conformance.ts` is the
merge gate. It drains your module's full pagination twice from the same
fixture and checks every property below. Each one throws with a message
specific enough to tell you exactly what to fix:

| Violation | Error message (substring, case-insensitive) |
|---|---|
| Event's `kind` is not in `manifest.emits` | `does not declare` |
| Event has zero legs | `has no legs` |
| A leg's `amount` is not a valid decimal string (`isValidAmount`) | `invalid amount` |
| Event's `timestamp` is not a positive finite number | `non-finite timestamp` |
| Event's `origin` is not `'derived'` | `must be origin 'derived'` |
| A `trade` event's principal legs are all the same direction | `needs both an in and an out principal leg` (matches `/trade .* both an in and an out/i`) |
| Same `externalId` appears twice in one drained run | `duplicate externalId` |
| Pagination does not terminate (cursor stays non-null) within 50 pages | `did not terminate` |
| Replaying the whole drain from `cursor: null` produces a different set of `externalId`s | `is not idempotent` (different externalIds) |
| Replaying produces the same `externalId`s but different content (kind, timestamp or legs) for one of them | `is not idempotent` (different data for externalId) |

Every error message is prefixed with `manifest.id`, so running the suite over
several modules at once still tells you which one failed.

Run it against your own module before opening a pull request:

```ts
import { runConformance } from '@/sources/conformance';
import { myModule } from './my-module';

await runConformance(myModule, {
  config: { address: 'addr_test1...' },
});
```

A module that passes `runConformance` against fixtures covering its real
pagination behaviour is mergeable — the harness is the gate, not a human's
read of the diff.

### Your pull request must include your own conformance test

`tests/registry.test.ts` iterates every module in the registry and checks
the manifest invariants that need no network and no fixtures: a well-formed
unique `id`, a `kind`, at least one uniquely-named field, at least one
declared `emits` kind, and every `label`/`help` string keyed in **both**
`src/translations/en.json` and `src/translations/de.json`.

That test cannot drain your module. `runConformance` needs recorded
fixtures, and only you have them — so a module merged without its own test
file would pass CI with none of the properties in the table above ever
checked. **A module pull request is incomplete without a
`tests/<yourModule>.test.ts` that calls `runConformance` against your
recorded fixtures**, in the shape `tests/cardanoYaci.test.ts` uses.

### A module must never put its config into an error message

Anything your module throws can end up in a source's `lastError`, which
`SourceRow` renders on screen and which used to travel inside the encrypted
checkpoint. So an error message must never interpolate anything from
`config` — no API key, no secret, no address. Name the request that failed
and the status it returned, not the credential it used:

```ts
// no
throw new Error(`auth failed for key ${config.apiKey}`);
// yes
throw new Error(`myprovider: listing trades failed with status ${response.status}`);
```

## Recording fixtures

Never hand-write fixture JSON. `scripts/record-fixtures.ts` calls your
module's real provider once, through real `fetch`, and writes every response
to a numbered JSON file:

```bash
npx tsx scripts/record-fixtures.ts <moduleId> ./config.json ./out
```

It is run with `tsx`, not plain `node`, deliberately: the script imports
`src/sources/registry.ts`, a real TypeScript module reachable through the
`@/*` path alias, and Node's own loader cannot resolve a bare `.ts` import at
all. `tsx` resolves TypeScript and honours the `@/*` → `./src/*` mapping in
`tsconfig.json`, so this keeps working once the registry holds modules with
real value imports of their own, not just this task's empty array.

`config.json` holds the same shape as the `config` object your module's
`probe`/`fetchEvents` expect (the fields your manifest declares). The script
is **run by hand, never in CI** — it makes live network calls and needs real
credentials.

Before writing anything to disk, the recorder redacts every manifest field
whose `type` is `apiKey` or `secret`: it replaces the literal value of that
config field, wherever it appears in a captured response, with the string
`'<redacted>'`. This redaction is driven entirely by the manifest's declared
field *types*, not by guessing at field names or regexing for
API-key-shaped strings — so a correctly declared manifest is what keeps your
credential out of the repository, not the recorder's judgement.

Commit the resulting fixture files alongside your module and reference them
from your module's own test file, using them to build the
`ConformanceFixture` you pass to `runConformance`.

## Adding your module to the registry

`src/sources/registry.ts` exports a static array, `registry: SourceModule[]`.
There is no dynamic loading, no plugin discovery, no fetch-and-eval — module
code runs beside the user's exchange API keys and chain addresses, so
anything loaded at runtime would be arbitrary code execution next to a
stranger's secrets. The only way into the registry is a reviewed pull
request that imports your module and pushes it into the array:

```ts
import { myModule } from './cardano-yaci';

export const registry: SourceModule[] = [
  myModule,
  // ...
];
```

`findModule(id)` looks modules up by `manifest.id`, which is also what
`scripts/record-fixtures.ts` takes as its first argument.

## Generating a module with an LLM

This interface is deliberately narrow enough that a model can write a
conforming module from three inputs, and none of them is "trust me, it
compiles":

1. **This document** — the contract above: the type definitions, the pure
   translator rule, the `fiat:` asset-id convention, what `externalId` must
   guarantee, how cursors terminate, and the exact conformance checks.
2. **A reference module** already in the registry (Task 6 adds the first
   one, `cardano-yaci`, a Cardano module against the open-source Yaci Store
   indexer) — a concrete, working example of translating one provider's
   real API shape into `LedgerEvent`s.
3. **The provider's own API documentation** — endpoints, pagination scheme,
   rate limits, and what a "transaction" or "reward" or "trade" actually
   looks like in that provider's JSON.

Hand the model those three things and let it write the module and its own
fixture-backed tests. Do **not** accept the result on the model's own
confidence, or on a human skim of the diff, or because it "looks right" —
**the conformance suite is the acceptance test.** Run
`npx vitest run` and `runConformance` against recorded fixtures covering the
module's real pagination behaviour (including a fixture with at least two
pages, so idempotence and termination are actually exercised rather than
trivially satisfied by a single-page response). A module that passes is
mergeable; a module that does not is not, no matter how it was written.

## Sharing a translator between providers

Two providers with the same API shape should share one translator rather
than ship two copies. `src/sources/cardano/translator.ts` is the worked
example: Yaci Store mirrors Blockfrost's API, so `cardano-yaci` and
`cardano-blockfrost` are thin manifests over one `CardanoProvider`
describing only what differs — host, API path segment, request headers, and
how a failing status becomes a message.

Translation logic decides disposal classification, tax-year membership and
dedupe identity. A second hand-written copy is a second place for those to
drift, and the drift would be silent.

If you do this, the test that matters is the one asserting both modules
derive **identical** events from the same recorded bodies. Prove it can
fail before you trust it: introduce a provider-dependent difference in the
translator and watch that test go red. A test comparing two things that are
identical by construction passes whether or not your code is right.

## Say what you verified and what you assumed

A module whose provider shapes you could not record is still acceptable,
but it must say so where the next reader will see it, not imply more
confidence than it has. `cardano-blockfrost` is the example: its doc
comment separates what was confirmed from the provider's documentation,
what was verified against the live service (its CORS headers and its 403 on
a missing key), and the one shape that is **assumed** to match Yaci's
because recording it needs a credential. Hand-writing a fixture to fill
that gap is not an acceptable substitute — a fabricated fixture tests that
your code agrees with your guess.
