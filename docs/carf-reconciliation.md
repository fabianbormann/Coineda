# DAC8 / CARF reconciliation

Coineda can hold a crypto-asset service provider's CARF report against your own ledger and show, per
asset and per category, what the provider reported, what the ledger says, the difference and a verdict.
The comparison runs on the tax report screen ("Reconcile with a CARF report" in the action bar, after a
report has been run), prints with the report and downloads as CSV.

Coineda gives no tax, legal or accounting advice. The comparison is an aid for finding differences
before the tax office does; it decides nothing about which side is right.

## What the file is

From the 2026 reporting period on, every reporting crypto-asset service provider (RCASP) reports its
users' transactions to the Bundeszentralamt für Steuern (BZSt) under § 11 of the
Kryptowerte-Steuertransparenzgesetz (KStTG), the German implementation of DAC8 and the OECD Crypto-Asset
Reporting Framework (CARF). The report for a year is due by 31 July of the following year, so the first
messages, for 2026, arrive in 2027. The BZSt adopted the OECD CARF XML schema version 1.5 as the
prescribed format, and the Länder receive the data through the BZSt.

One message holds, per user and per crypto-asset, aggregated figures: acquisitions and disposals against
fiat, acquisitions and disposals against other crypto-assets, transfers in and out by transfer type,
transfers to wallets not known to belong to a provider, and reportable retail payment transactions
(RRPT). Each figure has a transaction count (where the schema defines one), the number of units and an
amount in a fiat currency.

Coineda reads one file, UTF-8 or UTF-16 (with a byte order mark), containing exactly one `CARF_OECD`
message, either at the root or inside a wrapper such as the BZSt `dip` delivery envelope. Namespace
prefixes do not matter. There is no XSD validation; what the comparison needs is checked, everything
else is ignored. The file's reporting period must be the report's tax year.

## Who has it

The provider and the tax office. § 13 KStTG obliges a provider to *inform* you before it first reports
about you; it does not oblige it to hand you the XML. A data copy under GDPR Art. 15 gives you the same
information, but usually not as CARF XML, and Coineda accepts only the official XML. Everything the
section shows can also be read against a provider's own statement.

The other case is a review: an advisor or a reviewer who has the real message opens the client as a
read-only review client and runs the comparison there. Nothing is written to the review's ledger.

## Using it

1. Run the tax report for the year the message covers.
2. Choose "Reconcile with a CARF report" and drop the XML file.
3. Pick the user in the message who is the client. The one whose TIN equals the tax number in the
   report's taxpayer fields (spaces and slashes ignored) is preselected, otherwise the first. A user
   whose record is marked deleted (`OECD3`) is listed but cannot be compared.
4. Pick the sources that stand for the provider. Only exchange and file sources are offered; sources
   sharing a word with the provider's name are proposed. "At the provider" then means any venue those
   sources' events use.
5. Compare. The section "DAC8 / CARF reconciliation" appears after "Where these figures come from".

## What is compared

Per asset and per CARF block, the own figures come from the ledger events of the tax year (UTC) at the
provider's venues:

| CARF block | Own events counted |
| --- | --- |
| CryptoFiatIn | `trade` with a crypto principal **in** at the provider and a fiat principal **out**; units = crypto in; amount = fiat out principal (fees excluded, listed separately) |
| CryptoFiatOut | `trade` with a crypto principal **out** at the provider and a fiat principal **in**; amount = fiat in principal |
| CryptoToCryptoIn | `trade` crypto↔crypto, the acquired asset; amount = the value from the tax report |
| CryptoToCryptoOut | `trade` crypto↔crypto, the disposed asset; amount = the value from the tax report |
| CryptoTransferIn | `transfer` with a principal **in** at the provider and no out-leg at the provider, plus `reward` events at the provider (staking → CARF502, airdrop → CARF501, mining → CARF503, lending → CARF504, other → CARF508; untyped transfers → CARF509) |
| CryptoTransferOut | `transfer` with a principal **out** at the provider and no in-leg at the provider (CARF606, unknown) |
| TransferWallet | the subset of CryptoTransferOut whose receiving venue belongs to one of your chain sources |
| RRPT | not computed; the reported block is shown as "Not compared" |

`fiat-in`, `fiat-out`, `fee` and `derivative` events are outside CARF's crypto-asset blocks and are
ignored. Counts are event counts; units are summed exactly in base units and shown as whole units. The
valued categories take the value the tax report gave the event (per UTC day); an event without one makes
that category's own amount unknown.

Several blocks of one category for one asset (they differ by type) are summed for the comparison. When a
transfer row has more than one type on either side, the split by type is printed under the figures, for
explanation only.

## Verdict rules

Per asset and category, with R the reported and O the own figures:

- **Not recognised**: the reported asset name matches no catalogue asset, or more than one. Listed with
  its reported figures under "Reported, not recognised"; never guessed.
- **Not compared**: RRPT; or the reported currency is not the report's base currency (counts and units
  are still shown).
- **Not in the ledger**: R has a block, O has no event in that category.
- **Not reported**: O has events, R has no block (every row of a "nothing to report" message, CARF703).
- **Unpriced**: counts and units agree, but the own amount is unknown.
- **Matches**: counts equal, units equal after rounding O to 6 decimals, and the amount within 1 % of R
  or within 1.00 of the currency, whichever is larger.
- **Differs**: anything else; the row shows the differences in count, units and amount (own minus
  reported).

The summary line counts "missing on one side" as Not in the ledger plus Not reported, and "not compared"
as Not compared plus Unpriced.

## Known limits

- **RRPT** cannot be derived from a ledger: what counts as a reportable retail payment is the provider's
  knowledge. Those rows are shown, never compared.
- **Transfer types** are compared as totals. Whether a deposit was a payment, a loan return or a move
  from another provider is what the provider knew, not what the ledger can infer.
- **Valuation time**: the provider values each transaction at the time it happened, Coineda at the UTC
  day's price. The 1 % / 1.00 tolerance absorbs the usual gap; volatile days can exceed it. Fiat
  categories ordinarily match exactly.
- **Fees**: the own fiat amounts exclude fees, which are listed separately. A provider that reports
  amounts including fees will show a difference of the fee total.
- **Unrecognised names**: the CARF asset name is free text in practice. A name that is ambiguous (NIGHT)
  or unknown stays unmatched; there is no manual mapping yet.
- **Scope of the venues**: "at the provider" is whatever venues the selected sources' events use. A
  source that also books a counter-venue will widen that set.

## Privacy

The XML contains the user's name, address, TINs and birth date, and the same for every other user in it.
Coineda reads the file on the device, shows only what the section prints (names, TINs, DocRefIds and the
figures), and stores neither the file nor the parsed message. The reconciliation is screen state: it is
gone when the report is run again, when you go back to the form, or when the client changes. The
section's SHA-256 of the file ties the printout to the XML without keeping it.
