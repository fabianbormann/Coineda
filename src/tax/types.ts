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

/**
 * A holding moving between two venues the user owns, with no sale in it.
 *
 * Deliberately NOT a TaxEventKind. A move is not something a jurisdiction
 * classifies - no module emits one and none should have to handle one - it
 * is the host telling the matcher that a lot changed hands between the
 * user's own wallets. Adding a fourth kind would force every `classify`
 * switch in every jurisdiction to grow a branch for something that never
 * reaches it.
 *
 * It matters only where partitions are per venue. Germany's FIFO is, so
 * without this a coin bought on an exchange and sold from a wallet finds no
 * lot in the wallet's partition and reports "no acquisition on record" -
 * trading a fake disposal for a missing cost basis, which is no better.
 * Austria pools by acquisition era instead, so both ends of a move land in
 * the same partition and it is a no-op there.
 */
export type LotMove = {
  /** The ledger event that moved it, for the audit trail. */
  sourceEventId: string;
  assetId: string;
  /** What ARRIVED. The difference from what left is the network fee, which
   *  really did leave the user's control. */
  amount: string;
  timestamp: number;
  fromVenue: string;
  toVenue: string;
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
  /**
   * Why this could not be computed, as a key plus parameters.
   *
   * This used to be a raw sentence, on the reasoning that it names a
   * provider limitation or a missing acquisition and neither maps to a
   * static key. Half of that was right: a provider's own message really is
   * raw - an outage, a rate limit, a status line nobody can enumerate in
   * advance. The other half was not, and the half that was wrong is the
   * one a reader sees most: "no acquisition on record for this disposal"
   * is a fixed sentence this host writes itself, and it printed in English
   * in the middle of a German tax document.
   *
   * So the split the old comment described - raw text framed by translated
   * wrapper text - becomes structural instead of conventional: the wrapper
   * IS the key, and the provider's text rides in `params.detail`.
   */
  reason: TaxReason;
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

/**
 * Why a jurisdiction reached an outcome, as a translation key and its
 * parameters.
 *
 * This reverses the decision recorded below in the first version of
 * `AssessedDisposal.reason`, which argued that a reason must be raw prose
 * because its content is assembled from a computed split rather than drawn
 * from a fixed set of sentences. That argument holds only while the
 * computed part cannot be separated from the sentence. It can: the split is
 * a PARAMETER, and the sentences around it genuinely are a fixed, small set
 * per jurisdiction - three for Germany, two for Austria.
 *
 * What the raw version actually produced was English paragraphs inside a
 * German tax document, printed and handed to the one audience this field
 * exists for.
 *
 * `params` carries numbers and decimal strings only, never pre-formatted
 * text: formatting is the renderer's job, and a pre-formatted value would
 * re-introduce the same language problem one level down.
 */
export type TaxReason = {
  key: string;
  params?: Record<string, string | number>;
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
  /** Why, for the audit trail: a key into every locale file, with the
   *  computed figures as parameters. Display only, never parsed. */
  reason: TaxReason;
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

/**
 * One disposal as the REPORT shows it: what the jurisdiction assessed, plus
 * the provenance the host already holds.
 *
 * Deliberately NOT fields on `AssessedDisposal`. Every module is handed
 * exactly these three on the `MatchedDisposal` it assesses, so putting them
 * in the module's own return type would mean every contributor copying
 * three fields by hand - and one of them eventually forgetting. A disposal
 * printed without its acquisition date is the single defect that made the
 * printed report unusable to a tax office: it asserts a holding period and
 * offers nothing to check it against. The host joins them on
 * `disposalEventId` instead, where it cannot be skipped.
 */
export type ReportedDisposal = AssessedDisposal & {
  /** How much of the asset left, in its own units. */
  amount: string;
  /** Which wallet or exchange it left from. */
  venue: string;
  /**
   * The lots consumed, in consumption order.
   *
   * For a moving-average jurisdiction this is ONE synthetic pooled lot
   * whose `acquiredAt` is the disposal's own timestamp and whose
   * `heldDays` is 0, because an averaged pool has no acquisition date. A
   * renderer must branch on `ReportMethod.matching` rather than printing
   * that as an acquisition date - doing so would put a falsehood in a
   * document filed with an authority.
   */
  consumed: ConsumedLot[];
};

/**
 * Everything the printed report has to say about how it was produced.
 *
 * A figure without its method is not checkable, and the facts a reader
 * needs - which lots were matched against which, over what scope, and at
 * which price on which day - are each decided in a different file. Carrying
 * them as data rather than as prose inside the screen is what stops the
 * printed statement from drifting away from what the engine actually does:
 * a sheet that claims FIFO over moving-average numbers is worse than a
 * sheet that claims nothing.
 */
export type ReportMethod = {
  matching: MatchingMethod;
  /** Translation key from the jurisdiction's manifest. */
  partitionLabel: string;
  baseCurrency: string;
  /**
   * A typed value, not prose, so a later second-precise mode arrives as a
   * new variant rather than a reworded sentence nobody notices changing.
   * See BMF 06.03.2025 Rn. 43, 58 and 91 on daily versus second-precise
   * rates - the convention this app picks silently today.
   */
  valuation: 'utc-day';
  priceSources: string[];
  appVersion: string;
  /** Ledger events the jurisdiction was asked to classify, after internal
   *  transfers were removed. */
  eventsConsidered: number;
  /** Movements between the user's own venues, netted out before
   *  classification rather than reported as sales. */
  internalTransfersNetted: number;
};

/**
 * What `runTaxReport` returns: a module's assessment plus everything only
 * the host knows.
 *
 * The host already returned something richer than `TaxAssessment` - it
 * recomputes `totals.omitted` and appends its own `unresolved` items - so
 * the old return type was quietly misstating where its fields came from.
 * Naming the two separately is what lets the report grow provenance and a
 * method sheet without widening the contract every contributor implements.
 */
export type TaxReport = Omit<TaxAssessment, 'lines'> & {
  lines: ReportedDisposal[];
  method: ReportMethod;
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
  /**
   * Translation key describing what `partitionBy` means, in words a reader
   * of the printed report can check - "per wallet", "by acquisition era".
   *
   * Only the jurisdiction knows what its own partition key stands for, and
   * a tax document that states FIFO without stating its SCOPE has not
   * stated the method: per-wallet and portfolio-wide FIFO give materially
   * different answers from identical trades. A reader who cannot tell which
   * one produced a figure cannot check the figure.
   */
  partitionLabel: string;
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
