import type { EventKind, LedgerEvent } from '@/ledger/types';

export type TaxEventKind = 'acquisition' | 'disposal' | 'income';

export type TaxEvent = {
  /** The ledger event this came from, so a report links back to its cause. */
  sourceEventId: string;
  kind: TaxEventKind;
  assetId: string;
  /** Decimal string. Never a JS number. */
  amount: string;
  timestamp: number;
  /** Which wallet or exchange, needed for per-venue partitioning. */
  venue: string;
  /** Base-currency value as a decimal string, filled by the host. */
  value?: string;
  /** Why the module emitted this, for the audit trail. Display only. */
  note?: string;
};

export type ConsumedLot = {
  acquisitionEventId: string;
  amount: string;
  costBasis: string;
  acquiredAt: number;
  heldDays: number;
};

export type MatchedDisposal = {
  disposalEventId: string;
  assetId: string;
  venue: string;
  amount: string;
  proceeds: string;
  timestamp: number;
  consumed: ConsumedLot[];
  costBasis: string;
  gain: string;
  /**
   * The partition key (from `partitionBy`) the disposal was matched within.
   * Needed because moving-average's synthetic lot carries the disposal's
   * own timestamp as its acquiredAt rather than a real acquisition date -
   * a jurisdiction that partitions grandfathered holdings out of the
   * averaged pool (e.g. Austria's Altvermögen/Neuvermögen split) decides a
   * holding-period exemption from this key, not from the lot's date.
   */
  partition: string;
};

export type MatchingMethod = 'fifo' | 'moving-average';

export type Resolution =
  | { kind: 'record-purchase'; marketPriceAt?: string }
  | { kind: 'add-source-for-venue'; venue: string }
  | { kind: 'mark-as-income' };

export type UnresolvedItem = {
  /**
   * 'unclassified' means the module returned no tax events for an event
   * the ledger holds - a coverage gap in the jurisdiction's rules, not
   * missing data, so no resolution (recording a purchase, adding a
   * source) can close it the way the other two kinds' can.
   */
  kind: 'needs-cost-basis' | 'needs-price' | 'unclassified';
  sourceEventId: string;
  assetId: string;
  /** The unmatched shortfall, not the whole disposal. */
  amount: string;
  venue: string;
  timestamp: number;
  /** A raw diagnostic sentence, not a translation key - it names a
   *  provider limitation or a missing acquisition, neither of which maps
   *  to a static key. The UI frames it in translated wrapper text, the same
   *  rule SyncReport.error follows. */
  reason: string;
  /**
   * Which tax event this gap sits on, when there was one.
   *
   * `totals.omitted` is typed as "disposals that stayed unresolved" and is
   * rendered as "N disposals could not be computed", so the host has to be
   * able to tell a disposal apart from an unpriced ACQUISITION or an
   * unpriced income leg - both of which are real gaps, neither of which is
   * a disposal missing from the gain figure. Only the module's own
   * `classify` knows which it was, so the information is carried here
   * rather than re-derived by guessing from the ledger event.
   *
   * Absent for an `unclassified` item: no tax event was produced at all,
   * which is the whole point of that kind.
   */
  taxEventKind?: TaxEventKind;
  resolutions: Resolution[];
};

/** One line of the report: a disposal and what the jurisdiction made of it. */
export type AssessedDisposal = {
  disposalEventId: string;
  assetId: string;
  timestamp: number;
  proceeds: string;
  costBasis: string;
  gain: string;
  /** The exempt portion. A disposal can be partly exempt, because the
   *  holding period applies per consumed lot. */
  exempt: string;
  /** The remainder, which the threshold is then tested against. */
  taxable: string;
  /** Why, in words, for the audit trail. Display only, never parsed. */
  reason: string;
};

export type ThresholdOutcome = {
  /** Translation key naming the threshold. */
  label: string;
  limit: string;
  actual: string;
  /** True when the limit was reached and the gain became taxable. */
  exceeded: boolean;
  /**
   * A Freigrenze taxes EVERYTHING once exceeded; a Freibetrag taxes only
   * the excess. Germany's are Freigrenzen. Conflating the two is the single
   * most expensive modelling error available here, so it is a typed field
   * rather than an implementation detail a contributor could inherit by
   * accident.
   */
  kind: 'freigrenze' | 'freibetrag';
};

export type TaxAssessment = {
  year: number;
  lines: AssessedDisposal[];
  totals: {
    taxableGain: string;
    exemptGain: string;
    income: string;
    /** Disposals included in the figures above. */
    computedFrom: number;
    /** Disposals that stayed unresolved and are NOT in the figures above. */
    omitted: number;
  };
  thresholds: ThresholdOutcome[];
  estimatedLiability?: string;
  unresolved: UnresolvedItem[];
};

export type AssessInput = {
  year: number;
  matched: MatchedDisposal[];
  income: TaxEvent[];
  /** Optional personal rate as a decimal string percentage, e.g. '42'. */
  rate?: string;
};

export type TaxManifest = {
  /** Stable, lowercase: 'de', 'at'. */
  id: string;
  /** Translation key for the country name. */
  jurisdiction: string;
  /** Who wrote these rules. Shown on every report. */
  contributor: string;
  /** ISO date (YYYY-MM-DD) the contributor last verified the rules. */
  rulesCheckedOn: string;
  /** Citations so a reader can verify rather than trust. */
  references: string[];
  supportedYears: { from: number; to?: number };
};

export type TaxModule = {
  manifest: TaxManifest;
  /** What this jurisdiction's law mandates, as a default a report may
   *  override. */
  defaultMatching: MatchingMethod;
  /**
   * The ledger EventKinds this jurisdiction's rules have a confident answer
   * for - not necessarily a taxable one. The host (runTaxReport) uses this
   * to tell apart two reasons `classify` can return `[]` for an event:
   *
   *   - the kind is declared here, so an empty result is the module having
   *     considered the event and decided it is not a taxable event (a
   *     crypto-to-crypto swap under Austria's ÖkoStRefG, a pure-fiat leg
   *     under either jurisdiction's own fiat filter) - nothing is recorded,
   *     because there is nothing to resolve.
   *   - the kind is NOT declared here, so an empty result is a coverage gap
   *     (an unmapped `fee` event, or any brand-new EventKind no module has
   *     been taught about yet) - the host records it as an `unclassified`
   *     UnresolvedItem instead of letting it vanish.
   *
   * Deliberately coarse (per EventKind, not per event): a kind whose rules
   * are only PARTLY settled - Germany's and Austria's shared `reward`
   * handling knows what a staking reward is but not what an airdrop is -
   * must stay OFF this list, so that still-unresolved sub-case keeps
   * surfacing as `unclassified` rather than silently disappearing the
   * moment the kind as a whole is declared handled.
   */
  handles: EventKind[];
  /** Partition key per event. Germany returns the venue (per-wallet FIFO);
   *  Austria returns an Altvermögen/Neuvermögen marker. */
  partitionBy: (event: TaxEvent) => string;
  /** Pure and synchronous: no network, no clock, no randomness. The
   *  conformance gate runs it twice and compares, and also stubs
   *  Date.now/Math.random/performance.now to throw for the duration of one
   *  call. */
  classify: (event: LedgerEvent) => TaxEvent[];
  assess: (input: AssessInput) => TaxAssessment;
};
