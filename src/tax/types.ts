import type {
  DerivativeKind,
  EventKind,
  LedgerEvent,
  RewardKind,
} from '@/ledger/types';

export type TaxEventKind =
  'acquisition' | 'disposal' | 'income' | 'capital-gain' | 'capital-loss';

/**
 * What was actually given or received for a tax event's leg, when the
 * trade had a fiat side: the fiat leg's asset and amount.
 *
 * The BMF letter of 6 March 2025 asks for the actual consideration -
 * Veräußerungserlös, Anschaffungskosten - and keeps market value for
 * crypto-to-crypto exchanges, where no fiat changed hands. Valuing a euro
 * buy at the coin's market price instead made every buy and sell line
 * differ from the exchange statement by the day's spread.
 *
 * A jurisdiction may also set a zero consideration in the leg's own asset
 * to record an acquisition at no cost (a hard fork).
 */
export type Consideration = {
  assetId: string;
  /** Decimal string. Never a JS number. */
  amount: string;
};

/**
 * A transaction cost attributable to a tax event, in the asset it was paid
 * in: an exchange's trading fee, the network fee of a swap.
 *
 * §23 Abs. 3 Satz 1 EStG: the gain is proceeds less acquisition cost less
 * Werbungskosten. The host values a cost the same way it values the event
 * itself (`value`, base currency, UTC day), and the matcher then raises an
 * acquisition's cost basis or lowers a disposal's proceeds by it.
 *
 * An unvalued cost is NOT deducted. The host lists it as unpriced and the
 * matcher skips it, so a fee that could not be priced never silently
 * becomes a fee of zero - the same rule `match` applies to an acquisition
 * with no value.
 */
export type TaxCost = {
  assetId: string;
  /** Decimal string. Never a JS number. */
  amount: string;
  /** Base-currency value as a decimal string, filled by the host. */
  value?: string;
};

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
  /** Who priced `value`: set by the host alongside it. Never empty on a
   *  valued event. */
  priceSource?: string;
  /**
   * Costs the jurisdiction attributes to this event. Only a jurisdiction
   * knows which leg a fee belongs to (Germany: a sell's or swap's
   * disposal, a buy's acquisition), so `classify` fills this; the host
   * only values it.
   */
  costs?: TaxCost[];
  /**
   * Set by `classify` through `fiatConsiderationOf`. The host values the
   * event at this instead of at the leg's own market price. Absent on a
   * swap, which is valued at market by definition.
   */
  consideration?: Consideration;
  /** Why the module emitted this, for the audit trail. Display only. */
  note?: string;
  /**
   * On a `capital-loss`: `false` when the jurisdiction records the loss but
   * does not deduct it (Germany: a margin rollover fee, which §20 Abs. 9
   * EStG leaves undeductible beyond the allowance), so the report can show
   * it as not deducted rather than drop it. Absent means deducted.
   */
  deductible?: boolean;
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
   * The valued costs deducted from `proceeds`, as a positive decimal
   * string, '0' when there were none. Apportioned to the matched amount
   * the same way `proceeds` is. Reported, not just applied, so a reader
   * can reconcile `proceeds` against their exchange's own statement
   * instead of meeting a figure that disagrees with it by an unexplained
   * fee.
   */
  costs: string;
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
   * The on-chain transaction this came from, where the ledger knows one.
   *
   * Carried so a reader can act on the item rather than only count it: a
   * gap named by date and venue alone still has to be hunted for in an
   * explorer, and the whole point of listing these is that someone can
   * close them. Absent for exchange-internal activity, which has no hash.
   */
  txHash?: string;
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
  /**
   * Set when the gap is a COST the host could not price rather than the
   * event's own principal. The event itself was computed; only the
   * deduction is missing. Rendered as its own wording so the row is not
   * mistaken for a second failed disposal of the same asset and amount.
   */
  subject?: 'cost';
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
  /**
   * Optional translation key qualifying what this limit covers.
   *
   * Only the jurisdiction knows. Germany's §23 Freigrenze spans every
   * private sale in the year - gold, art, a property sold inside ten years
   * - while its §22 Nr. 3 Freigrenze covers Einkünfte aus Leistungen and
   * nothing of the sort. A note the SCREEN printed under every threshold
   * told a reader that staking income consumed a private-sale allowance,
   * which is wrong in both directions. Prose about a jurisdiction's rules
   * belongs to that jurisdiction, the same way `partitionLabel` does.
   */
  scopeNote?: string;
};

/**
 * A loss carried INTO the year, as the Finanzamt stated it (user-entered
 * decimal strings in the base currency).
 *
 * Strictly per pot. A carry-forward offsets only income of the same kind it
 * arose in: a §23 private-sale loss reduces only §23 gains, a §20 loss only
 * §20 income, and never across Einkunftsarten (§23 Abs. 3 S. 7-8, §20 Abs.
 * 6 EStG). `capital` is the general §20 pot ONLY - losses from selling
 * shares (§20 Abs. 6 S. 4, the Aktien pot) offset only gains from selling
 * shares, which this app does not compute, so they must never be entered
 * or applied here.
 */
export type CarryForward = { privateSales?: string; capital?: string };

/** What happened to one declared carry-forward. `used <= gain`,
 *  `remaining = declared - used`. */
export type CarryForwardOutcome = {
  /** The figure as DECLARED BY THE FINANZAMT in its Verlustfeststellungs-
   *  bescheid and entered by the user - not something the user declares.
   *  The report prints it as "as stated by the Finanzamt". */
  declared: string;
  used: string;
  remaining: string;
};

/**
 * The year's derivative (Kapitalvermögen) result as a jurisdiction
 * computed it. Optional on an assessment: only a module that classifies
 * capital events returns one.
 */
export type CapitalResult = {
  gains: string;
  /** Deducted losses only. */
  losses: string;
  /** Losses recorded but not deducted (`TaxEvent.deductible === false`),
   *  kept out of `losses` and `net`. '0' when there are none. */
  notDeducted: string;
  net: string;
  /** The allowance applied (Sparer-Pauschbetrag for Germany). */
  allowance: string;
  taxable: string;
  /** Declared carry-forward applied to a positive net before the allowance;
   *  '0' when none. */
  carryForwardUsed: string;
  /** Positive carry-forward loss, or '0'. */
  loss: string;
  estimatedTax?: string;
  /** Translation key: what the figures are and what estimatedTax leaves out. */
  note: string;
};

export type TaxAssessment = {
  year: number;
  capital?: CapitalResult;
  /** Present only when a non-zero carry-forward was declared. */
  carryForward?: {
    privateSales?: CarryForwardOutcome;
    capital?: CarryForwardOutcome;
  };
  lines: AssessedDisposal[];
  totals: {
    taxableGain: string;
    exemptGain: string;
    income: string;
    /**
     * The year's loss, as a POSITIVE number, or '0'.
     *
     * Deliberately kept OUT of `taxableGain`, which stays "what is
     * actually taxed". A §23 loss offsets only other private-sale gains,
     * and only once it has been DECLARED (§23 Abs. 3 Satz 7-8 EStG) - so a
     * report that folds a negative year into the same "0" it prints for a
     * year under the Freigrenze silently costs the user the entire
     * carry-forward, while looking perfectly reassuring. That is the most
     * expensive thing this report can do to someone.
     */
    loss: string;
    /** Disposals included in the figures above. */
    computedFrom: number;
    /** Disposals that stayed unresolved and are NOT in the figures above. */
    omitted: number;
  };
  thresholds: ThresholdOutcome[];
  estimatedLiability?: string;
  /**
   * Translation key saying what `estimatedLiability` is and what it leaves
   * out. Present exactly when `estimatedLiability` is.
   *
   * Jurisdiction-supplied for the same reason `scopeNote` is: Germany's
   * figure is a caller-supplied marginal rate excluding Solidaritätszuschlag
   * and Kirchensteuer, Austria's is the statutory 27.5% KESt and a final
   * tax. A single sentence written at the screen described one of them and
   * printed on both.
   */
  liabilityNote?: string;
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
  /** From the matcher, see MatchedDisposal.costs. */
  costs: string;
  /** Who priced the disposal, from its valued tax event. */
  priceSource?: string;
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
  /**
   * Set by the host when this disposal is the coins a transfer between the
   * user's own venues consumed (see residualTransferEvents): a translation
   * key explaining the line, and the on-chain hash where one is known, so a
   * reader can tie it to the movement it belongs to.
   */
  origin?: { key: string; txHash?: string };
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
  /** The jurisdiction's rule-set version this report was produced under. */
  rulesVersion: string;
  /** Ledger events the jurisdiction was asked to classify, after internal
   *  transfers were removed. */
  eventsConsidered: number;
  /** Movements between the user's own venues, netted out before
   *  classification rather than reported as sales. */
  internalTransfersNetted: number;
  /** Network fees on transfers between the user's own venues, each
   *  treated as a disposal of the fee coins and not deducted: the
   *  `:residual-out` events. A residual acquisition (more arrived than a
   *  link carried) and coins paid to somebody else in the same transaction
   *  (`:residual-paid-out`) are not fees and are not counted here. */
  transferResiduals: number;
};

/**
 * One income event as the report prints it: what arrived, where, when,
 * and what it was worth that day. The sum of `value` over a year is what
 * `totals.income` is tested against the §22 Nr. 3 Freigrenze, and a sum
 * with no rows behind it is a figure a reader cannot check - the same
 * reason disposals print their lots.
 *
 * `note` is the jurisdiction's own key (Germany's leader-reward caveat),
 * rendered through t(). Before this it was never shown anywhere.
 */
export type ReportedIncome = {
  sourceEventId: string;
  assetId: string;
  amount: string;
  timestamp: number;
  venue: string;
  value: string;
  priceSource?: string;
  note?: string;
  /** From the ledger event, when the host can find it. */
  rewardKind?: RewardKind;
};

/** One capital gain or loss event (a derivative settlement) as printed. */
export type ReportedCapital = {
  sourceEventId: string;
  assetId: string;
  amount: string;
  timestamp: number;
  venue: string;
  value: string;
  priceSource?: string;
  kind: 'gain' | 'loss';
  /** False for a loss the jurisdiction records but does not deduct. */
  deducted: boolean;
  /** Translation key from the tax event: the caveat on this row. */
  note?: string;
  derivativeKind?: DerivativeKind;
  instrument?: string;
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
export type TaxReport = Omit<TaxAssessment, 'lines' | 'capital'> & {
  lines: ReportedDisposal[];
  /** The valued income events of the year, in date order. */
  income: ReportedIncome[];
  /** The valued capital events of the year, in date order. */
  capital: ReportedCapital[];
  /**
   * The module's capital figures (`TaxAssessment.capital`), renamed because
   * `capital` on the report is the row list. Absent when the module has none.
   */
  capitalResult?: CapitalResult;
  method: ReportMethod;
  /**
   * The items behind `totals.omitted`, not just how many there were.
   *
   * A figure that says "2 disposals could not be computed" and nothing
   * else leaves the reader to find those two among every other gap in the
   * ledger - 65 of them in the report that prompted this - which is the
   * difference between a warning someone can act on and one they learn to
   * ignore. `totals.omitted === omittedDisposals.length` by construction.
   */
  omittedDisposals: UnresolvedItem[];
};

export type AssessInput = {
  year: number;
  matched: MatchedDisposal[];
  income: TaxEvent[];
  /** Capital gain/loss events of the year (derivative settlements). */
  capital: TaxEvent[];
  /** Optional personal rate as a decimal string percentage, e.g. '42'. */
  rate?: string;
  /** Losses carried into the year, as declared by the user. */
  carryForward?: CarryForward;
};

export type TaxManifest = {
  /** The module applies a declared loss carry-forward. */
  supportsCarryForward?: boolean;
  /** Stable, lowercase: 'de', 'at'. */
  id: string;
  /** Translation key for the country name. */
  jurisdiction: string;
  /** Who wrote these rules. Shown on every report. */
  contributor: string;
  /** ISO date (YYYY-MM-DD) the contributor last verified the rules. */
  rulesCheckedOn: string;
  /** Semantic version of this rule set; printed on every report and tied to `changelog[0]`. */
  rulesVersion: string;
  /** Newest first. English prose for contributors and reviewers; the report prints only the version. */
  changelog: { version: string; date: string; summary: string }[];
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
