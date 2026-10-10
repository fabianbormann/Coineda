import { getLinkedEvents, getManualLinks } from '@/ledger/manualLinks';
import { fingerprintLedger } from '@/ledger/fingerprint';
import {
  foldDisposals,
  isInternalTransfer,
  netPrincipalLegs,
  ownedVenuesOf,
} from '@/ledger/balances';
import { getAllEvents, getSources } from '@/ledger/db';
import type { LedgerEvent } from '@/ledger/types';
import {
  intraEventLotMoves,
  linkInternalTransfers,
  linkedEventIds,
  residualTransferEvents,
} from '@/ledger/transfers';
import { match } from './matching';
import {
  FEE_RESIDUAL_SUFFIX,
  PAID_RESIDUAL_SUFFIX,
  PAID_ORIGIN_KEY,
  RESIDUAL_ORIGIN_KEY,
} from './residualOrigin';
import { buildRegister } from './register';
import { resolveValues } from './resolveValues';
import { rewardKindOf } from '@/tax/rewardKinds';
import { APP_VERSION } from '@/global/version';
import type {
  LotMove,
  MatchedDisposal,
  CarryForward,
  MatchingMethod,
  ReportedDisposal,
  ReportedCapital,
  ReportedIncome,
  ReportMethod,
  TaxEvent,
  TaxModule,
  TaxReport,
  UnresolvedItem,
} from './types';

export type RunTaxReportOptions = {
  year: number;
  baseCurrency: string;
  /** Overrides the module's own `defaultMatching` for this run. */
  matching?: MatchingMethod;
  /** Optional personal rate as a decimal string percentage, e.g. '42'. */
  rate?: string;
  /** Losses carried into `year`, as declared by the user. */
  carryForward?: CarryForward;
};

/**
 * The tax year an instant belongs to, in UTC.
 *
 * UTC and not local time, deliberately. The ledger stores epoch
 * milliseconds and the project already recorded that a local reading of a
 * late-evening UTC timestamp displays the previous day. At a year boundary
 * that is not a cosmetic difference: it decides which annual return a gain
 * belongs on.
 */
export const taxYearOf = (timestamp: number): number =>
  new Date(timestamp).getUTCFullYear();

/**
 * The reason keys this host itself can emit.
 *
 * Exported so the conformance gate can assert they are keyed in every
 * locale without having to run a whole report to discover them - the same
 * reason a jurisdiction's own keys are reachable through `assess`.
 */
export const HOST_REASON_KEYS = [
  'This jurisdiction has no rule for a {{kind}} event.',
  'No acquisition is on record for this disposal.',
] as const;

export { RESIDUAL_ORIGIN_KEY, PAID_ORIGIN_KEY };

/** A ledger event the module's `classify` produced nothing for. Recorded
 *  so a new `EventKind` the module has not been taught about cannot vanish
 *  from a report silently - it shows up as something to resolve instead.
 *  `resolutions` is deliberately empty: neither recording a purchase nor
 *  adding a source for a venue can close a gap in the rules themselves. */
const unclassifiedToUnresolved = (event: LedgerEvent): UnresolvedItem => {
  const leg = event.legs[0];
  return {
    kind: 'unclassified',
    sourceEventId: event.id,
    assetId: leg?.assetId ?? 'unknown',
    amount: leg?.amount ?? '0',
    venue: leg?.venue ?? 'unknown',
    timestamp: event.timestamp,
    // Indexed into the exported constant, never retyped: the conformance
    // gate asserts the CONSTANT is keyed in both locales, so a literal
    // repeated here could drift from it by one character and the gate would
    // stay green while the report printed an untranslated key.
    reason: {
      key: HOST_REASON_KEYS[0],
      params: { kind: event.kind },
    },
    resolutions: [],
  };
};

/** A disposal `match` could not find an acquisition for. The sending
 *  venue is deliberately absent: the ledger never recorded it, only the
 *  disposing venue is known, so only that one can be named. */
const shortfallToUnresolved = (event: TaxEvent): UnresolvedItem => ({
  kind: 'needs-cost-basis',
  // `match` only ever reports a shortfall for a disposal it could not
  // cover, so this one is a disposal by construction.
  taxEventKind: 'disposal',
  sourceEventId: event.sourceEventId,
  assetId: event.assetId,
  amount: event.amount,
  venue: event.venue,
  timestamp: event.timestamp,
  reason: { key: HOST_REASON_KEYS[1] },
  resolutions: [
    { kind: 'add-source-for-venue', venue: event.venue },
    { kind: 'record-purchase' },
  ],
});

/**
 * Runs the full pipeline for one jurisdiction, one year: the jurisdiction
 * classifies raw ledger events, the host values and matches them against
 * each other, and the jurisdiction assesses the result.
 *
 * The whole ledger is read, not just the requested year - a lot acquired
 * in an earlier year must still be matchable against a disposal in this
 * one, and filtering to the tax year before matching would leave that sale
 * with no cost basis and report the entire proceeds as gain. Internal
 * transfers are dropped before the jurisdiction ever sees them, reusing
 * `isInternalTransfer` rather than asking every contributor to re-derive
 * what is and is not a disposal.
 *
 * `isInternalTransfer` is not enough on its own, which is what
 * `netPrincipalLegs` is for. That predicate answers yes or no from an
 * event's per-asset net; using it only as a filter and then handing the
 * survivor's RAW legs to `classify` makes every UTXO input a disposal and
 * every change output a re-acquisition. The same net the filter already
 * computes is therefore applied to the event before the jurisdiction sees
 * it, so a module is handed one net leg per asset - a fee-only disposal on
 * a self-send, 102 on a payment with change - rather than the gross legs.
 * That belongs here and not in a jurisdiction: a contributor writing the
 * rules for a new country must not have to rediscover how UTXO change
 * works.
 *
 * Throws, rather than returning a partial assessment, the moment anything
 * the module controls (the supported-year range, `classify` itself) fails -
 * a half-computed tax figure is worse than none. Everything the host
 * itself cannot resolve (a missing price, a disposal with no acquisition,
 * an event kind the module does not handle) becomes an `UnresolvedItem`
 * instead, and `totals.omitted` is recomputed from those here rather than
 * trusted from the module, because omitted is the guarantee that a total
 * cannot be read without knowing what it excludes.
 */
export const runTaxReport = async (
  module: TaxModule,
  options: RunTaxReportOptions,
): Promise<TaxReport> => {
  const { from, to } = module.manifest.supportedYears;
  if (options.year < from || (to !== undefined && options.year > to)) {
    const range = to === undefined ? `${from} or later` : `${from}-${to}`;
    throw new Error(
      `${module.manifest.id} supports tax years ${range}, not ${options.year}`,
    );
  }

  // Read once, with the events, so the fingerprint describes what this run
  // read even if the ledger changes while prices are being fetched.
  const [rawEvents, manualLinks, sources] = await Promise.all([
    getAllEvents(),
    getManualLinks(),
    getSources(),
  ]);
  const allEvents = await getLinkedEvents();
  const ownedVenues = ownedVenuesOf(allEvents);
  // Transfers between the user's own venues, in BOTH shapes.
  //
  // `isInternalTransfer` sees the one that lives inside a single event - a
  // UTXO self-send. It cannot see the one that spans two: an exchange
  // withdrawal and the wallet receipt it caused are separate events from
  // separate sources, and apart they read as a disposal followed by an
  // acquisition from nowhere. `linkInternalTransfers` pairs them on the
  // on-chain transaction hash, which is exact rather than heuristic.
  const transferLinks = linkInternalTransfers(allEvents, ownedVenues);
  const linked = linkedEventIds(transferLinks);

  const survivors = allEvents.filter(
    (event) => !isInternalTransfer(event, ownedVenues) && !linked.has(event.id),
  );
  // What a linked pair consumed on the way - fees, gas - comes back as a
  // synthetic event the jurisdiction classifies like any other outgoing
  // leg. See residualTransferEvents for the rule.
  const residuals = residualTransferEvents(
    allEvents,
    transferLinks,
    ownedVenues,
  );
  const consideredEvents = [...survivors, ...residuals];

  /**
   * What the dropped pair is replaced BY.
   *
   * Dropping the two events alone would be no better than leaving them as a
   * disposal: German FIFO partitions per venue, so a coin bought on an
   * exchange and later sold from a wallet would find no lot in the wallet's
   * partition and report "no acquisition on record". The move carries the
   * lot across, keeping its cost basis and its acquisition date - a
   * transfer to oneself neither realises a gain nor restarts a holding
   * period.
   */
  const lotMoves: LotMove[] = [
    ...transferLinks.map((link) => ({
      sourceEventId: link.fromEventId,
      assetId: link.assetId,
      amount: link.amount,
      timestamp: link.timestamp,
      fromVenue: link.fromVenue,
      toVenue: link.toVenue,
    })),
    // The single-event shape is dropped above too, and a grouped exchange
    // transfer between two owned venues (Spot -> Futures, spot -> earn)
    // must carry its lots across just the same.
    ...intraEventLotMoves(allEvents, ownedVenues),
  ];

  const taxEvents: TaxEvent[] = [];
  const hostUnresolved: UnresolvedItem[] = [];

  for (const event of consideredEvents) {
    let produced: TaxEvent[];
    try {
      produced = module.classify(netPrincipalLegs(event, ownedVenues));
    } catch (error) {
      throw new Error(
        `tax module "${module.manifest.id}" threw while classifying event ${event.id}`,
        { cause: error },
      );
    }

    if (produced.length === 0) {
      // Two different reasons `classify` can return nothing, and only one
      // of them is a gap: a kind the module declares in `handles` has been
      // considered and genuinely has no taxable event here (Austria's
      // crypto-to-crypto swap; either jurisdiction's pure-fiat leg) - that
      // is a deliberate answer, not a missing one, so it is dropped rather
      // than surfaced. A kind outside `handles` - an unmapped fee, or a
      // brand-new EventKind no module has been taught about - is a real
      // coverage gap and must not vanish from the report silently.
      if (!module.handles.includes(event.kind)) {
        // The ORIGINAL event, not the netted one: netting can legitimately
        // leave no legs behind, and a diagnostic that named nothing would
        // be worse than one naming the gross leg the user can actually
        // find in their transaction history.
        hostUnresolved.push(unclassifiedToUnresolved(event));
      }
      continue;
    }

    taxEvents.push(...produced);
  }

  const { valued, unpriced } = await resolveValues(
    taxEvents,
    options.baseCurrency,
  );
  hostUnresolved.push(...unpriced);

  // Resolved once and reused, rather than read twice: the method the
  // matcher ran under and the method the document states must be the same
  // value, not two reads of the same expression that a later edit could
  // separate.
  const matching = options.matching ?? module.defaultMatching;

  const { matched, shortfalls } = match(
    valued,
    matching,
    module.partitionBy,
    lotMoves,
  );
  hostUnresolved.push(...shortfalls.map(shortfallToUnresolved));

  const yearMatched = matched.filter(
    (disposal) => taxYearOf(disposal.timestamp) === options.year,
  );
  const yearIncome = valued.filter(
    (event) =>
      event.kind === 'income' && taxYearOf(event.timestamp) === options.year,
  );

  const yearCapital = valued.filter(
    (event) =>
      (event.kind === 'capital-gain' || event.kind === 'capital-loss') &&
      taxYearOf(event.timestamp) === options.year,
  );

  // The ledger event behind an item, where the id still matches one. Every
  // shipped jurisdiction stamps a tax event with the ledger event's own id,
  // so this resolves for them; a module that mints its own ids simply gets
  // no hash, which is the same outcome as an exchange row that has none.
  const eventById = new Map(
    [...allEvents, ...residuals].map((event) => [event.id, event]),
  );
  // Sorted here rather than left to insertion order, which came from the
  // order sources happened to sync in: a document's rows must not reorder
  // between two runs of the same data.
  const income: ReportedIncome[] = yearIncome
    .map((event) => {
      // Through rewardKindOf, so a legacy row with no typed field is
      // labelled from the same signals the module classified it by.
      const source = eventById.get(event.sourceEventId);
      const rewardKind =
        source === undefined ? undefined : rewardKindOf(source);
      return {
        sourceEventId: event.sourceEventId,
        assetId: event.assetId,
        amount: event.amount,
        timestamp: event.timestamp,
        venue: event.venue,
        // `valued` only ever holds events resolveValues gave a value to;
        // the fallback is for the type, not for a case that occurs.
        value: event.value ?? '0',
        ...(event.priceSource === undefined
          ? {}
          : { priceSource: event.priceSource }),
        ...(event.note === undefined ? {} : { note: event.note }),
        ...(rewardKind === undefined ? {} : { rewardKind }),
      };
    })
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        // A plain comparison, not localeCompare: without a locale that
        // depends on the machine, and the same ledger must print the same
        // order everywhere.
        (a.sourceEventId < b.sourceEventId
          ? -1
          : a.sourceEventId > b.sourceEventId
            ? 1
            : 0),
    );

  const capital: ReportedCapital[] = yearCapital
    .map((event) => {
      const derivative = eventById.get(event.sourceEventId)?.derivative;
      return {
        sourceEventId: event.sourceEventId,
        assetId: event.assetId,
        amount: event.amount,
        timestamp: event.timestamp,
        venue: event.venue,
        value: event.value ?? '0',
        ...(event.priceSource === undefined
          ? {}
          : { priceSource: event.priceSource }),
        kind:
          event.kind === 'capital-gain' ? ('gain' as const) : ('loss' as const),
        deducted: event.deductible !== false,
        ...(event.note === undefined ? {} : { note: event.note }),
        ...(derivative === undefined
          ? {}
          : { derivativeKind: derivative.kind }),
        ...(derivative?.instrument === undefined
          ? {}
          : { instrument: derivative.instrument }),
      };
    })
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        (a.sourceEventId < b.sourceEventId
          ? -1
          : a.sourceEventId > b.sourceEventId
            ? 1
            : 0),
    );

  const assessment = module.assess({
    year: options.year,
    matched: yearMatched,
    income: yearIncome,
    capital: yearCapital,
    rate: options.rate,
    carryForward: options.carryForward,
  });

  // `omitted` is typed as "disposals that stayed unresolved" and is
  // rendered as "N disposals could not be computed", so only an item that
  // really corresponds to an in-year disposal counts. Two different ways
  // an item can fail that test, and both used to be counted anyway:
  //
  //   - an `unclassified` event produced no tax event at all, and most
  //     such events are not disposals (an unrecognised reward, an unmapped
  //     fee leg with no outgoing principal) - so it counts only if it
  //     would have qualified as a disposal under the ledger's own rule,
  //     the same one `foldDisposals` applies;
  //   - a `needs-price` item may sit on an ACQUISITION or on income - an
  //     unpriced native-token leg arriving is a real gap but not a
  //     disposal missing from the gain figure. `taxEventKind` is what the
  //     module's classify already knew and the host would otherwise have
  //     to guess.
  //
  // The rest stay in `unresolved`, where the UI reports them as what they
  // are. Nothing is hidden; it is only counted honestly.
  const disposalEventIds = new Set(
    foldDisposals(consideredEvents, ownedVenues).map((event) => event.id),
  );
  const isOmittedDisposal = (item: UnresolvedItem): boolean => {
    if (taxYearOf(item.timestamp) !== options.year) {
      return false;
    }
    if (item.kind === 'unclassified') {
      return disposalEventIds.has(item.sourceEventId);
    }
    return item.taxEventKind === 'disposal';
  };

  const withTxHash = (item: UnresolvedItem): UnresolvedItem => {
    const txHash = eventById.get(item.sourceEventId)?.txHash;
    return txHash === undefined ? item : { ...item, txHash };
  };

  const unresolved = hostUnresolved.map(withTxHash);
  const omittedDisposals = unresolved.filter(isOmittedDisposal);

  // Joined on disposalEventId, never by position: `assess` is free to drop,
  // reorder or merge the lines it returns, and a positional join would
  // silently attach one disposal's acquisition dates to another's figures -
  // a wrong holding period that reads as entirely plausible on paper, which
  // is the worst kind of wrong a tax document can be.
  //
  // A QUEUE per id, not one entry per id. `disposalEventId` is a tax
  // event's `sourceEventId`, and that is not unique: a jurisdiction stamps
  // every leg of a ledger event with the event's own id, so one event
  // disposing of two assets yields two disposals sharing an id. Keyed into
  // a Map the second overwrote the first, and both report lines printed one
  // disposal's quantity, venue and lots beneath the other's figures - which
  // is how a real report came to show "Anschaffungskosten: 240,12 EUR" above
  // its own lot breakdown reading "0,15 EUR".
  //
  // Within one id the queue is consumed in order. Both shipped modules map
  // `input.matched` one-to-one, so that order is the matcher's; a module
  // that reorders its own lines within a single event would pair them
  // differently, but every candidate then belongs to that same event rather
  // than to an unrelated one, which is the failure this guards against.
  const byDisposalId = new Map<string, MatchedDisposal[]>();
  for (const disposal of yearMatched) {
    const queue = byDisposalId.get(disposal.disposalEventId);
    if (queue) {
      queue.push(disposal);
    } else {
      byDisposalId.set(disposal.disposalEventId, [disposal]);
    }
  }

  // The label each residual disposal carries, by the event it came from:
  // a network fee, or coins paid to somebody else in the same transaction.
  // A residual `in` event is an acquisition and never becomes a line.
  const originKeyById = new Map<string, string>();
  for (const event of residuals) {
    if (event.id.endsWith(FEE_RESIDUAL_SUFFIX)) {
      originKeyById.set(event.id, RESIDUAL_ORIGIN_KEY);
    } else if (event.id.endsWith(PAID_RESIDUAL_SUFFIX)) {
      originKeyById.set(event.id, PAID_ORIGIN_KEY);
    }
  }

  // The matcher's disposals carry no TaxEvent, so who priced each one is
  // looked up from the valued disposal events by the same id and asset the
  // join above narrows by. First wins; a shared id with a shared asset is
  // the same ledger event valued the same way.
  const priceSourceByDisposal = new Map<string, string>();
  for (const event of valued) {
    const key = `${event.sourceEventId}|${event.assetId}`;
    if (
      event.kind === 'disposal' &&
      event.priceSource !== undefined &&
      !priceSourceByDisposal.has(key)
    ) {
      priceSourceByDisposal.set(key, event.priceSource);
    }
  }

  const lines: ReportedDisposal[] = assessment.lines.map((line) => {
    const queue = byDisposalId.get(line.disposalEventId);
    // Narrowed by assetId first, because a module's line carries one and a
    // mismatch there is a pairing this join can still rule out.
    const index = queue?.findIndex(
      (candidate) => candidate.assetId === line.assetId,
    );
    const disposal =
      queue && index !== undefined && index >= 0
        ? queue.splice(index, 1)[0]
        : undefined;
    if (!disposal) {
      // No report at all, rather than one line that renders blanks where an
      // acquisition date belongs - the same call this function already
      // makes when a module throws while classifying.
      throw new Error(
        `tax module "${module.manifest.id}" assessed a disposal it was not handed: ${line.disposalEventId} (${line.assetId})`,
      );
    }
    const priceSource = priceSourceByDisposal.get(
      `${line.disposalEventId}|${line.assetId}`,
    );
    const reported: ReportedDisposal = {
      ...line,
      ...(priceSource === undefined ? {} : { priceSource }),
      amount: disposal.amount,
      venue: disposal.venue,
      consumed: disposal.consumed,
      costs: disposal.costs,
    };
    const originKey = originKeyById.get(line.disposalEventId);
    if (originKey === undefined) {
      return reported;
    }
    const txHash = eventById.get(line.disposalEventId)?.txHash;
    return {
      ...reported,
      origin:
        txHash === undefined ? { key: originKey } : { key: originKey, txHash },
    };
  });

  const method: ReportMethod = {
    matching,
    partitionLabel: module.manifest.partitionLabel,
    baseCurrency: options.baseCurrency,
    valuation: 'utc-day',
    // Named here rather than imported from the price layer: this is the
    // list a reader checks a figure against, and it has to stay accurate to
    // what fetchHistory actually tries, in the order it tries them.
    priceSources: ['DefiLlama', 'ECB', 'CoinGecko'],
    appVersion: APP_VERSION,
    // Raw events plus the links, exactly what a checkpoint stores - NOT
    // the linked events, so the two can be compared.
    fingerprint: await fingerprintLedger({
      events: rawEvents,
      links: manualLinks,
    }),
    rulesVersion: module.manifest.rulesVersion,
    eventsConsidered: survivors.length,
    internalTransfersNetted: allEvents.length - survivors.length,
    // Only the fees: the sentence this count feeds describes network fee
    // coins treated as disposals. A residual `in` event is no disposal, and
    // a `:residual-paid-out` event is a payment, not a fee.
    transferResiduals: residuals.filter((event) =>
      event.id.endsWith(FEE_RESIDUAL_SUFFIX),
    ).length,
  };

  // The events dropped as internal transfers: the single-event shape and
  // both halves of every linked pair.
  const keptIds = new Set(survivors.map((event) => event.id));
  const register = buildRegister({
    year: options.year,
    valued,
    internalTransfers: allEvents.filter((event) => !keptIds.has(event.id)),
    residuals,
    unresolved: unresolved.filter(
      (item) => taxYearOf(item.timestamp) === options.year,
    ),
    eventById,
    sourceLabelById: new Map(
      sources.map((source) => [source.id, source.label]),
    ),
  });

  const { capital: capitalResult, ...assessed } = assessment;

  return {
    ...assessed,
    ...(capitalResult === undefined ? {} : { capitalResult }),
    lines,
    income,
    capital,
    method,
    unresolved: [...assessment.unresolved, ...unresolved],
    omittedDisposals,
    register,
    totals: {
      ...assessment.totals,
      omitted: omittedDisposals.length,
    },
  };
};
