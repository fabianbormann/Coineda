# Writing a tax module

This is a guide for contributing a new jurisdiction under `src/tax/jurisdictions/`.
Read `src/tax/jurisdictions/de.ts` (Germany, FIFO, per-wallet partition) and
`src/tax/jurisdictions/at.ts` (Austria, moving average, Altvermögen partition)
side by side before you start — they deliberately disagree with each other in
every dimension the contract allows, and that disagreement is the
specification.

## The two-stage contract, and why `classify` is pure and synchronous

A `TaxModule` does its work in two separate stages that never call back into
each other:

1. `classify(event: LedgerEvent): TaxEvent[]` turns one ledger event into zero
   or more country-specific tax events (`acquisition`, `disposal`, `income`).
   A crypto-to-crypto swap might become two tax events (Germany: a disposal
   and an acquisition) or none (Austria: the cost simply carries over).
2. `assess(input: AssessInput): TaxAssessment` takes *already-matched*
   disposals — the host has long since turned the raw stream of
   acquisitions/disposals into `MatchedDisposal`s — and decides what is
   taxable, what is exempt, which thresholds apply, and what the estimated
   liability is.

`classify` must be pure and synchronous: no network call, no `Date.now()`, no
`Math.random()`, no locale-dependent formatting (`toLocaleString`,
`Intl.NumberFormat` with the ambient locale, etc.). The conformance gate
(`tests/taxConformance.test.ts`) checks this two ways: it runs `classify`
twice on the same input and asserts the two outputs are deeply equal (a
sampling check — it only catches an impurity that happens to produce a
different value between the two calls, which a millisecond-resolution
`Date.now()` often won't), and it stubs `Date.now`, `Math.random` and
`performance.now` to throw for the duration of one pass (a direct check —
an impure classify throws every single run). Neither is a style preference:
together they are the only mechanical way to catch an impure classifier
before it ships, because a reviewer reading a diff will not reliably spot a
`Date.now()` tucked into a `note` string. An irreproducible classification
makes the tax report itself irreproducible: the same wallet history must
always produce the same report, or the report cannot be trusted or audited.

### An empty `classify` result means one of two different things

`TaxModule.handles: EventKind[]` tells the host (`runTaxReport`) which
ledger event kinds your rules have a confident answer for — not necessarily
a taxable one. When `classify` returns `[]` for an event:

- if the event's kind is in `handles`, the host treats that as your module
  having *considered* the event and decided it is not a taxable event
  (Austria's crypto-to-crypto swap; either jurisdiction's pure-fiat leg) —
  nothing is recorded, because there is nothing to resolve.
- if the event's kind is *not* in `handles`, the host treats the empty
  result as a coverage gap and records an `unclassified` `UnresolvedItem` so
  it cannot silently vanish from the report.

Declare a kind in `handles` only when every event of that kind gets a
confident answer from your rules — including the ones that confidently
resolve to "not taxable". If your rules are only *partly* settled for a
kind (a reward's kind is `rewardKindOf(event)` from `src/tax/rewardKinds.ts`;
branch on it, never on `note`), leave that kind off `handles` entirely, so
the still-unresolved sub-case keeps surfacing instead of disappearing the
moment the kind as a whole is declared handled. Keep `'reward'` out of
`handles` while any reward kind is unresolved. Getting
this wrong in the other direction — declaring a kind your rules don't
actually have an answer for — makes a real gap disappear exactly the way an
unclassified kind is supposed to prevent.

## The host owns matching; a jurisdiction *selects* a method

Jurisdictions do not implement FIFO or moving-average matching themselves —
that lives once, in `src/tax/matching.ts`, shared by everyone. A module only
declares which method its law mandates via `defaultMatching: 'fifo' |
'moving-average'`, and the host's matcher (`match()`) applies it. This keeps
the matching arithmetic (lot splitting, proportional cost apportionment,
pinned rounding) in one audited place instead of being re-implemented,
subtly differently, per country.

## `partitionBy` expresses both per-wallet scope and grandfathering

`partitionBy(event: TaxEvent): string` tells the matcher which events are
allowed to settle against each other. It is one hook used for two unrelated
purposes depending on the jurisdiction:

- Germany partitions by **venue** (`event.venue`), because German FIFO is
  per-wallet: a lot bought on exchange A can never satisfy a disposal on
  exchange B.
- Austria partitions by **Altvermögen vs. Neuvermögen**
  (`event.timestamp < cutoff ? 'alt' : 'neu'`), because it pools cost per
  asset across the whole portfolio (moving average) — venue is irrelevant —
  but a pre-cutoff, tax-free holding must never be averaged together with a
  post-cutoff, taxable one. Mixing them would make part of a tax-free
  holding taxable and part of a taxable holding tax-free, with no way to
  recover which averaged unit came from which side.

Whatever partition key `match()` used to group a disposal is carried onto
the result as `MatchedDisposal.partition`. If your jurisdiction's exemption
depends on *when* something was acquired and you use moving-average
matching, read that fact from `partition`, never from a consumed lot's
`acquiredAt` — moving-average's synthetic lot always carries the
*disposal's own* timestamp as `acquiredAt` with `heldDays: 0`, because an
averaged pool has no acquisition date of its own.

`ConsumedLot.heldDays` is for display. A holding-period rule that turns on
a calendar date must compare `acquiredAt` and the disposal's `timestamp`
as dates, in UTC — Germany's `heldMoreThanOneYear` in `de.ts` is the
reference, including the 29 February case. A day count silently moves a
leap-year anniversary across the boundary.

## Transaction costs ride on the event they belong to

A ledger event's fee legs (`role: 'fee'`) reach `classify` untouched. Your
module decides what they are. If your law deducts them from a sale or adds
them to a purchase, attach them to that tax event as `costs: TaxCost[]`
(asset and amount, no value): the host prices each cost on the event's
day, the matcher raises an acquisition's cost basis or lowers a disposal's
proceeds by the valued costs, and the report prints what came off a
disposal; a buy's fee is inside the lot's cost basis the report prints per
lot. A cost the host cannot price is listed as unpriced and **not**
deducted — never treated as zero. Germany's `classifyTrade` in `de.ts` is
the reference: a fee on a sell or swap goes on the disposal, on a buy on
the acquisition, and a fee paid in crypto additionally keeps its own
disposal because the coins really left.

## Freigrenze vs. Freibetrag — pick the right one

`ThresholdOutcome.kind` is `'freigrenze' | 'freibetrag'`, and conflating the
two is the most expensive modelling error available in this contract:

- A **Freigrenze** ("exemption limit") taxes the *entire* amount once the
  limit is reached or exceeded. Below the limit, nothing is taxed. Germany's
  €1,000/€600 private-sale threshold and its €256 staking-income threshold
  are both Freigrenzen — note they're tested with `>=`, not `>`.
- A **Freibetrag** ("allowance") only taxes the *excess* over the limit, no
  matter how far above it you are. The first N euros are always exempt.

If your jurisdiction has neither (Austria has none at all —
`thresholds: []`), say so explicitly rather than reusing a Freigrenze
structure with a limit of zero; an empty array is honest, a disguised
zero-Freigrenze is not.

## Derivative settlements and the `capital` block

Margin and futures settlements arrive as `derivative` ledger events
(`event.derivative.kind` is `pnl`, `funding`, `rollover` or `commission`,
and `event.derivative.product`, when the source knows it, is `margin` or
`futures`), each with a principal leg in the settlement asset and/or fee
legs. A module that has a rule for them lists `'derivative'` in `handles`
and classifies the legs as `capital-gain` / `capital-loss` tax events. A
settlement paid in crypto also moves holdings, so emit an `acquisition` or
`disposal` beside it to keep the lots right. Where your rules differ by
product or kind, branch on those typed fields and never on `event.note`,
which is provenance prose and may change with any source. A loss your
jurisdiction records but does not deduct carries `deductible: false`; keep it
out of `losses` and report it as `notDeducted` so the report still shows it.
The matcher skips the capital kinds; they reach `assess` as `input.capital`,
and you return a `capital` result (gains, deducted losses, notDeducted, net,
allowance, taxable, loss, optional estimated tax, a note key) only when
`input.capital` is non-empty. The block is optional: a module with
no rule leaves `'derivative'` out of `handles`, and the host then lists those
events as unclassified rather than guessing. Germany taxes them under §20
EStG with the Sparer-Pauschbetrag; Austria does not handle them yet.

## Loss carry-forward: `supportsCarryForward` and `input.carryForward`

A loss carried into the year is a figure only the tax office knows (in
Germany, the remaining amount in the Verlustfeststellungsbescheid as at 31
December of the previous year), so the user enters it and the host passes
it to `assess` as `input.carryForward`: `{ privateSales?, capital? }`,
decimal strings in the base currency. The host shows the inputs only when
your manifest sets `supportsCarryForward: true`; leave it unset and
`carryForward` never arrives. The contract, if you set it:

- **Per pot, never across Einkunftsarten.** `privateSales` offsets only
  private-sale gains and `capital` only capital income; one never reduces
  the other, and neither touches other income such as staking. `capital`
  is the general capital-income pot only - a separately ring-fenced pot
  (Germany's share-loss pot, §20 Abs. 6 S. 4 EStG) offsets only its own
  kind of gain and must never be applied here.
- **The Freigrenze first.** A Freigrenze is tested on the year's own gain,
  and only then is the carry deducted from a gain that exceeded it (§23
  Abs. 3 S. 5 and S. 8 EStG). Deducting first would exempt gains the law
  taxes and consume carry-forward the law preserves. A year under the
  Freigrenze, or a loss year, uses none of it.
- **Report what happened.** For each non-zero pot return
  `carryForward.<pot>` as `{ declared, used, remaining }`, with
  `used <= gain` and `remaining = declared - used`; a declared `'0'` is no
  carry-forward. For the capital pot also set `capital.carryForwardUsed`
  (deducted from a positive net before the allowance, `'0'` otherwise) and
  report the allowance threshold on the net AFTER it, so the threshold card
  and the derivatives card agree.

## A filing aid is optional, and line numbers are never guessed

`TaxAssessment.filing?: FilingFigures` lets a module print the figures a user
types into the tax form, in the form's order. Germany supplies it (Anlage SO
and Anlage KAP); Austria does not, and a module without a filing aid simply
omits the field. The shape is sections of entries:

```ts
FilingFigures = { year; linesVerified: boolean; verifiedBy?; sections: FilingSection[] }
FilingSection = { title; form; entries: FilingEntry[] }   // title: translation key
FilingEntry   = { label; amount?; text?; reference?; note? }
```

Each entry carries a translation-key `label`, an optional form `reference`
(form, line, optional field) and either a decimal-string `amount` or a literal
`text` such as a period or "Kryptowerte". The figures are the pre-threshold
sums the form asks for, taxable side only: Freigrenzen, the saver's allowance
and loss carry-forward are applied by the tax office, not by the report. Line
numbers come from a per-year data table with provenance, never from code or
memory: Germany's is `FORM_LINES_DE` in `src/tax/jurisdictions/de.forms.ts`,
each year carrying `verified: { source, checkedOn }`, which Germany copies to
`FilingFigures.verifiedBy` so the page can name the source. A year with no verified
table supplies no `reference` at all and sets `linesVerified: false`, so the
page prints the section names and says the lines were not verified, rather
than printing a number that might be a line off.

## Unresolved items are how you decline to guess

`UnresolvedItem.kind` is `'needs-cost-basis' | 'needs-price' | 'unclassified'`.
When your module cannot determine a confident answer — an airdrop whose tax
treatment your jurisdiction's rules do not cover, a disposal whose
acquisition cost is genuinely unknown — do not invent a number. Return
nothing from `classify` (the host records the gap as `unclassified`) or
leave the disposal out of `assess`'s totals (`totals.omitted` counts these).
A wrong number silently baked into a report is worse than an honest gap a
user can go fill in.

## `rulesCheckedOn` and `references` are what make the report honest

Every `TaxManifest` carries `rulesCheckedOn` (an ISO date, the last day the
contributor actually verified the rules against the statute) and
`references` (the citations themselves — section numbers, the name of the
reform act). `src/tax/disclaimer.ts`'s `buildDisclaimer` turns these into a
per-report notice: who wrote the rules, when they were checked, what they
cite, and — computed, not hard-coded — how many months stale the check now
is. "Last checked 19 months ago" tells a reader something true and
falsifiable; a generic "consult a professional" banner tells them nothing.
Keep `rulesCheckedOn` current when you touch the rules, and keep
`references` precise enough that someone else can go verify your work
instead of trusting it.

`rulesVersion` and `changelog` sit beside them: a semantic version of your
rule set, printed on every report, and a newest-first list of
`{ version, date, summary }` entries. Whenever a rule changes, bump the
version and add an entry; the conformance gate enforces that
`rulesVersion` equals `changelog[0].version`, every version is
`MAJOR.MINOR.PATCH`, versions strictly decrease down the list (no
duplicates), dates are ISO `YYYY-MM-DD` and not increasing down the list,
and `rulesCheckedOn` is not older than the newest entry.

## Golden fixtures, and proving each one load-bearing

Your PR must include fixture-driven tests ("golden cases") that pin down the
specific behaviour your jurisdiction disagrees on — the swap-as-non-event
case, the grandfathering cutoff, a repeating-decimal moving-average split,
whatever is distinctive about your law. For each rule your tests claim to
cover, you must also show the test can actually fail: temporarily break the
implementation (flip a boundary, use the wrong field, remove a locale key)
and show the exact test output that catches it, then revert. A test that
cannot fail is not a test, it is decoration — and a reviewer cannot tell the
difference between a real assertion and a tautological one just by reading
the code, so the break-and-revert proof is the only true verification you
can hand them.


## The register is host-built

The year's register (every acquisition, disposal, income, capital and
internal-transfer row, plus the items that could not be priced) and its CSV
and JSON exports are built by the host from what `classify` returned and from
the ledger. A module does not produce, return or format any of it; there is
nothing to implement.

## Checklist before opening the PR

- [ ] `manifest.contributor`, `manifest.rulesCheckedOn`, `manifest.references`,
      `manifest.supportedYears` all filled in honestly.
- [ ] `manifest.jurisdiction` keyed with a real translation in both
      `src/translations/en.json` and `src/translations/de.json`.
- [ ] `classify` is pure and synchronous — no clock, no randomness, no
      ambient locale formatting.
- [ ] `partitionBy` matches what your law actually requires groups to share.
- [ ] `thresholds` correctly distinguishes Freigrenze from Freibetrag, or is
      empty if neither applies.
- [ ] Every amount is a decimal string, end to end — never a JS `number`,
      including in test fixtures.
- [ ] Golden fixtures for the behaviour that's distinctive to your
      jurisdiction, each with a reported break-and-revert proof.
- [ ] Registered in `src/tax/registry.ts`.
- [ ] `npx vitest run && npx tsc --noEmit && npm run lint && npm run
      format:check && npm run build` all clean.
