import Big from 'big.js';
import {
  addAmounts,
  compareAmounts,
  isZeroAmount,
  negateAmount,
  normaliseAmount,
  subtractAmounts,
  sumAmounts,
} from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import { fiatConsiderationOf } from '@/tax/consideration';
import { rewardKindOf } from '@/tax/rewardKinds';
import type { Leg, LedgerEvent, RewardKind } from '@/ledger/types';
import type {
  AssessedDisposal,
  AssessInput,
  MatchedDisposal,
  TaxAssessment,
  TaxEvent,
  TaxModule,
  TaxReason,
  ThresholdOutcome,
} from '@/tax/types';

/**
 * Germany - §23 Abs. 1 Nr. 2 EStG private Veräußerungsgeschäfte, not §20, so
 * no Abgeltungsteuer. This is the reference jurisdiction every
 * community-contributed country is expected to be copied from, so the
 * comments here explain not just what the rule is but why it is written the
 * way it is.
 *
 * Not legal or tax advice. `manifest.rulesCheckedOn` and `manifest.references`
 * carry that uncertainty to the reader rather than hiding it behind a
 * confident-looking number.
 */

/**
 * §23 Abs. 1 Nr. 2 EStG exempts a holding period of MORE than one year.
 *
 * The period runs by calendar date, not by counting days (§187 Abs. 1,
 * §188 Abs. 2 and 3 BGB): the day of acquisition is not counted, and the
 * period ends with the day of the following year bearing the same date -
 * or, when that month has no such day (29 February), with its last day.
 * The anniversary itself is therefore still inside the period, and only a
 * disposal on a LATER calendar day is exempt.
 *
 * A day count cannot express this. This used to compare `heldDays > 365`:
 * 1 March 2023 to 1 March 2024 spans a 29 February, reads as 366 days, and
 * was exempted - a taxable gain made to disappear by a leap day, which is
 * exactly the failure the old "REVIEW FOCUS 1" comment warned about from
 * the other direction. Decided in UTC, the same calendar the tax year
 * itself is decided in (see taxYearOf).
 */
export const heldMoreThanOneYear = (
  acquiredAt: number,
  disposedAt: number,
): boolean => {
  const acquired = new Date(acquiredAt);
  const year = acquired.getUTCFullYear() + 1;
  const month = acquired.getUTCMonth();
  const candidate = Date.UTC(year, month, acquired.getUTCDate());
  // Date.UTC rolls 29 February over into 1 March in a common year; §188
  // Abs. 3 BGB ends the period on the last day of the month instead, which
  // is day 0 of the month after.
  const anniversary =
    new Date(candidate).getUTCMonth() === month
      ? candidate
      : Date.UTC(year, month + 1, 0);
  const disposed = new Date(disposedAt);
  const disposalDay = Date.UTC(
    disposed.getUTCFullYear(),
    disposed.getUTCMonth(),
    disposed.getUTCDate(),
  );
  return disposalDay > anniversary;
};

const PRIVATE_SALE_THRESHOLD_LABEL =
  'Tax-free threshold for private sales (§23 EStG)';
/** Attached to the §23 threshold ONLY. The §22 Nr. 3 Freigrenze below is
 *  not a private-sale limit and must never carry this. */
const PRIVATE_SALE_SCOPE_NOTE =
  'This limit covers every private sale you made in the year, not only crypto.';
const LIABILITY_NOTE =
  'Your marginal rate applied to the taxable gain. It does not include solidarity surcharge, church tax, or the effect on your overall progression.';
/** Named for the provision, not for staking: every reward kind taxed as
 *  income here counts against it, and so does any non-crypto §22 Nr. 3
 *  income, which the scope note says. */
const OTHER_INCOME_THRESHOLD_LABEL =
  'Tax-free threshold for other income (§22 Nr. 3 EStG)';
const OTHER_INCOME_SCOPE_NOTE =
  'This limit covers all of your income under §22 Nr. 3 EStG in the year, not only crypto rewards.';

const BUSINESS_INCOME_NOTE =
  'This reward may be gewerbliche Einkünfte rather than §22 Nr. 3 income. This classification is uncertain, so confirm it yourself before relying on it.';
const AIRDROP_NOTE =
  'Treated as received for a counter-performance (§22 Nr. 3 income at the value on receipt). An airdrop received for nothing may not be income at receipt; see BMF 06.03.2025 on airdrops and confirm which applies.';
const OTHER_REWARD_NOTE =
  'The source did not say what kind of reward this was, so it is treated as §22 Nr. 3 income at the value on receipt.';

/** Exhaustive: a kind with no entry is deliberately noteless. */
const REWARD_NOTES: Record<Exclude<RewardKind, 'fork'>, string | undefined> = {
  staking: undefined,
  lending: undefined,
  liquidity: undefined,
  leader: BUSINESS_INCOME_NOTE,
  mining: BUSINESS_INCOME_NOTE,
  masternode: BUSINESS_INCOME_NOTE,
  airdrop: AIRDROP_NOTE,
  other: OTHER_REWARD_NOTE,
};

/** A leg becomes a disposal (out) or acquisition (in) - unless it is fiat,
 *  which is never a crypto disposal: it is a buy's payment side, a sell's
 *  proceeds side, or a bank deposit/withdrawal. This one predicate covers
 *  'trade' (a plain buy/sell carries a fiat leg plus a crypto leg; a
 *  crypto-to-crypto swap carries two crypto legs - the "disposal plus
 *  acquisition" rule falls out of applying it to every leg rather than
 *  needing a special case), 'transfer' (internal transfers are already
 *  removed by the host, so a remaining transfer leg is a real send/receive
 *  across the ledger's boundary) and 'fiat-in'/'fiat-out' (where it discards
 *  the fiat leg entirely). */
const legToTaxEvent = (event: LedgerEvent, leg: Leg): TaxEvent[] => {
  if (isFiatAsset(leg.assetId)) {
    return [];
  }
  return [
    {
      sourceEventId: event.id,
      kind: leg.direction === 'out' ? 'disposal' : 'acquisition',
      assetId: leg.assetId,
      amount: leg.amount,
      timestamp: event.timestamp,
      venue: leg.venue,
    },
  ];
};

/**
 * A trade's fee legs are Werbungskosten of that trade (§23 Abs. 3 Satz 1
 * EStG), so they ride on the trade's own tax event as `costs`: on a sell
 * or a swap, the crypto disposal (Veräußerungskosten); on a buy, where
 * there is no crypto disposal, the acquisition (Anschaffungsnebenkosten).
 *
 * A fee paid in crypto ALSO leaves the holdings, so it keeps the
 * standalone disposal `legToTaxEvent` always gave it - the two are not a
 * double count. The fee coins' disposal realises whatever gain THEY had
 * since purchase; the cost attachment deducts the fee's value from the
 * trade. Netted: gain on trade - fee value + (fee value - fee coins' cost
 * basis) = gain on trade - what the fee coins originally cost, which is
 * what actually happened. A fiat fee has no holding to dispose of and
 * previously vanished here entirely: `legToTaxEvent` returns [] for fiat,
 * so a Kraken EUR trading fee never reduced anything.
 *
 * Only `trade`. A fee on a transfer to a third party is gas on a gift or a
 * payment, not a selling cost, and stays the plain disposal it was.
 */
const classifyTrade = (event: LedgerEvent): TaxEvent[] => {
  const principals = event.legs.filter((leg) => leg.role === 'principal');
  const fees = event.legs.filter((leg) => leg.role === 'fee');

  // The actual consideration, when the trade had a fiat side. Defined only
  // when exactly one crypto leg faces exactly one fiat leg, so every tax
  // event here is that one crypto leg and the map attaches to it alone.
  const consideration = fiatConsiderationOf(event);
  const taxEvents = principals
    .flatMap((leg) => legToTaxEvent(event, leg))
    .map((taxEvent) =>
      consideration === undefined ? taxEvent : { ...taxEvent, consideration },
    );
  const feeDisposals = fees.flatMap((leg) => legToTaxEvent(event, leg));

  if (fees.length === 0) {
    return [...taxEvents, ...feeDisposals];
  }

  const carrier =
    taxEvents.find((taxEvent) => taxEvent.kind === 'disposal') ??
    taxEvents.find((taxEvent) => taxEvent.kind === 'acquisition');
  if (carrier === undefined) {
    // Fiat for fiat: nothing crypto to attach a cost to.
    return [...taxEvents, ...feeDisposals];
  }

  const costs = fees.map((leg) => ({
    assetId: leg.assetId,
    amount: leg.amount,
  }));
  return [
    ...taxEvents.map((taxEvent) =>
      taxEvent === carrier ? { ...taxEvent, costs } : taxEvent,
    ),
    ...feeDisposals,
  ];
};

const classifyReward = (event: LedgerEvent): TaxEvent[] => {
  // The reward's own leg: the principal that arrived. A fee leg on the
  // same event is not the reward.
  const leg = event.legs.find(
    (one) => one.role === 'principal' && one.direction === 'in',
  );
  if (!leg) {
    return [];
  }
  const kind = rewardKindOf(event);
  if (kind === undefined) {
    // Nothing the source or the legacy signals can name: unclassified, so
    // the host lists it rather than this guessing.
    return [];
  }

  const acquisition: TaxEvent = {
    sourceEventId: event.id,
    kind: 'acquisition',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
  };

  if (kind === 'fork') {
    // BMF 06.03.2025: coins from a hard fork have no acquisition cost. The
    // letter carries the ORIGINAL lot's acquisition date over; the ledger
    // cannot link a fork to its parent lot yet, so the fork date is used,
    // which is the shorter holding period and so the conservative side.
    return [
      { ...acquisition, consideration: { assetId: leg.assetId, amount: '0' } },
    ];
  }

  const note = REWARD_NOTES[kind];
  const income: TaxEvent = {
    sourceEventId: event.id,
    kind: 'income',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
    ...(note === undefined ? {} : { note }),
  };
  return [income, acquisition];
};

/**
 * Pure and synchronous - no Date.now(), no Math.random(), no locale
 * formatting. The conformance gate (Task 6) runs this twice on the same
 * input and compares, so any hidden impurity would be caught, but the real
 * reason is simpler: a tax classification that depends on when it happens to
 * run is not a classification, it is a race.
 */
const classify = (event: LedgerEvent): TaxEvent[] => {
  switch (event.kind) {
    case 'trade':
      return classifyTrade(event);
    case 'transfer':
    case 'fiat-in':
    case 'fiat-out':
      return event.legs.flatMap((leg) => legToTaxEvent(event, leg));
    case 'reward':
      return classifyReward(event);
    default:
      // 'fee' is not addressed by this task's confirmed rules, so a
      // standalone fee event is left unclassified rather than guessed at.
      return [];
  }
};

// Apportioning a disposal's proceeds across its consumed lots is a
// proportional split, the same operation src/tax/matching.ts already
// performs for partially-consumed lots - and for the same reason, it needs a
// pinned rounding mode rather than whatever Big's own default happens to be,
// since an unpinned mode would compound differently depending on lot order.
// src/ledger/amount.ts deliberately has no multiply/divide helper (nothing
// else there needs one), so this is the one place in this module, besides
// the final liability calculation, that touches Big directly.
const DIVIDE_DP = 20;
const DIVIDE_RM = 1; // Big.roundHalfUp

const proportion = (
  total: string,
  numerator: string,
  denominator: string,
): string =>
  normaliseAmount(
    new Big(total)
      .times(new Big(numerator))
      .div(new Big(denominator))
      .round(DIVIDE_DP, DIVIDE_RM)
      .toString(),
  );

/** Explains, per disposal, which §23 Abs. 1 Nr. 2 EStG outcome applied.
 *  A translation key rather than the raw sentence this used to return: the
 *  outcome is one of exactly three, and the document it lands in is read by
 *  a German tax office. See TaxReason in src/tax/types.ts for why the
 *  earlier "assembled from a computed split" argument did not survive. */
const describeHoldingPeriod = (exempt: string, taxable: string): TaxReason => {
  const hasExempt = !isZeroAmount(exempt);
  const hasTaxable = !isZeroAmount(taxable);
  if (hasExempt && hasTaxable) {
    return {
      key: 'Split disposal: the lots held more than one year are tax-free under §23 Abs. 1 Nr. 2 EStG, the rest was held one year or less and is taxable.',
    };
  }
  if (hasExempt) {
    return {
      key: 'Held more than one year, so the gain is tax-free under §23 Abs. 1 Nr. 2 EStG.',
    };
  }
  return {
    key: 'Held one year or less, so the gain is taxable under §23 Abs. 1 Nr. 2 EStG.',
  };
};

/**
 * Splits one disposal by consumed lot, because the one-year holding period
 * is a per-lot fact: two halves of the same sale can land on opposite sides
 * of the exemption when they were bought on different days. Proceeds are
 * apportioned across lots by amount share; the last lot absorbs whatever
 * remains rather than its own proportional share, so the parts always sum
 * back to the disposal's own proceeds exactly instead of drifting by a
 * rounding remainder.
 */
const assessDisposal = (disposal: MatchedDisposal): AssessedDisposal => {
  let exempt = '0';
  let taxable = '0';
  let allocatedProceeds = '0';

  disposal.consumed.forEach((lot, index) => {
    const isLast = index === disposal.consumed.length - 1;
    const lotProceeds = isLast
      ? subtractAmounts(disposal.proceeds, allocatedProceeds)
      : proportion(disposal.proceeds, lot.amount, disposal.amount);
    allocatedProceeds = addAmounts(allocatedProceeds, lotProceeds);

    const lotGain = subtractAmounts(lotProceeds, lot.costBasis);

    // By calendar date, never by heldDays: see heldMoreThanOneYear.
    if (heldMoreThanOneYear(lot.acquiredAt, disposal.timestamp)) {
      exempt = addAmounts(exempt, lotGain);
    } else {
      taxable = addAmounts(taxable, lotGain);
    }
  });

  return {
    disposalEventId: disposal.disposalEventId,
    assetId: disposal.assetId,
    timestamp: disposal.timestamp,
    proceeds: disposal.proceeds,
    costBasis: disposal.costBasis,
    gain: disposal.gain,
    exempt,
    taxable,
    reason: describeHoldingPeriod(exempt, taxable),
  };
};

/**
 * §23 Abs. 3 Satz 5 EStG: the year's total private-sale gain is tax-free
 * under €1,000 (2024 onward) or €600 (through 2023) - a Freigrenze, not a
 * Freibetrag. REVIEW FOCUS: at or above the limit the WHOLE gain becomes
 * taxable, not just the excess; below it, nothing is taxed at all. The sum
 * tested is the year's total taxable-side gain INCLUDING negatives (a loss
 * reduces it), which is Review Focus 4 below.
 *
 * Losses offset only private-sale gains - never staking income, which is
 * assessed completely independently against its own §22 Nr. 3 Freigrenze.
 *
 * No rate is applied, and no estimatedLiability is produced, unless the
 * caller supplies one.
 */
const assess = (input: AssessInput): TaxAssessment => {
  const lines = input.matched.map(assessDisposal);

  const exemptGain = sumAmounts(lines.map((line) => line.exempt));
  // Pre-threshold sum of the taxable side only - the Freigrenze is tested
  // against this total, not the per-line figures, which stay informational.
  const rawTaxableGain = sumAmounts(lines.map((line) => line.taxable));

  const gainLimit = input.year >= 2024 ? '1000' : '600';
  const gainExceeded = compareAmounts(rawTaxableGain, gainLimit) >= 0;
  const taxableGain = gainExceeded ? rawTaxableGain : '0';

  // A negative year is NOT the same thing as a year under the Freigrenze,
  // even though the old code gave both the same taxableGain of '0'. One
  // owes nothing and carries nothing; the other owes nothing but carries a
  // loss forward, and only if it is declared.
  const loss =
    compareAmounts(rawTaxableGain, '0') < 0
      ? negateAmount(rawTaxableGain)
      : '0';

  const gainThreshold: ThresholdOutcome = {
    label: PRIVATE_SALE_THRESHOLD_LABEL,
    limit: gainLimit,
    actual: rawTaxableGain,
    exceeded: gainExceeded,
    kind: 'freigrenze',
    scopeNote: PRIVATE_SALE_SCOPE_NOTE,
  };

  // §22 Nr. 3 EStG's own €256 Freigrenze, assessed independently of §23 -
  // a private-sale loss must never reduce it.
  const incomeSum = sumAmounts(input.income.map((event) => event.value ?? '0'));
  const incomeLimit = '256';
  const incomeExceeded = compareAmounts(incomeSum, incomeLimit) >= 0;
  const income = incomeExceeded ? incomeSum : '0';

  const incomeThreshold: ThresholdOutcome = {
    label: OTHER_INCOME_THRESHOLD_LABEL,
    limit: incomeLimit,
    actual: incomeSum,
    exceeded: incomeExceeded,
    kind: 'freigrenze',
    scopeNote: OTHER_INCOME_SCOPE_NOTE,
  };

  let estimatedLiability: string | undefined;
  let liabilityNote: string | undefined;
  if (input.rate !== undefined) {
    liabilityNote = LIABILITY_NOTE;
    // A marginal rate times the taxable gain, and deliberately nothing
    // more. This used to multiply by 1.055 for the Solidaritätszuschlag
    // unconditionally - but the Soli has had a Freigrenze since 2021 and is
    // owed only once the ASSESSED INCOME TAX passes it, a figure that is
    // not in this app and cannot be derived from a crypto gain and a
    // marginal rate. So the surcharge was wrong for most private taxpayers,
    // and wrong in the direction that overstates. Kirchensteuer is not
    // modelled either, and neither is the gain's effect on progression.
    //
    // The report states all three in words beside the figure rather than
    // quietly producing a number that looks more complete than it is: a
    // number that is wrong but labelled is recoverable, one that is wrong
    // and confident is not.
    //
    // Still the one place besides `proportion` that touches Big directly,
    // and every intermediate still round-trips through a decimal string via
    // normaliseAmount before leaving this function.
    const tax = new Big(taxableGain).times(new Big(input.rate)).div(100);
    estimatedLiability = normaliseAmount(tax.toString());
  }

  return {
    year: input.year,
    lines,
    totals: {
      taxableGain,
      exemptGain,
      income,
      loss,
      // The host (runTaxReport) recomputes `omitted` from what it could not
      // resolve; this module only knows the disposals it was handed.
      computedFrom: input.matched.length,
      omitted: 0,
    },
    thresholds: [gainThreshold, incomeThreshold],
    estimatedLiability,
    liabilityNote,
    unresolved: [],
  };
};

const germanTax: TaxModule = {
  manifest: {
    id: 'de',
    jurisdiction: 'Germany',
    contributor: 'Fabian Bormann',
    rulesCheckedOn: '2026-10-09',
    partitionLabel:
      'Lots are matched per wallet or exchange, not pooled across the portfolio.',
    references: [
      '§23 Abs. 1 Nr. 2 EStG',
      '§23 Abs. 3 Satz 1 EStG',
      '§23 Abs. 3 Satz 5 EStG',
      // The loss carry-forward this module now reports through
      // `totals.loss` rather than folding into a tax-free zero.
      '§23 Abs. 3 Satz 7-8 EStG',
      '§187 Abs. 1, §188 Abs. 2-3 BGB',
      '§22 Nr. 3 EStG',
      // Re-issued 2025-03-06, replacing the 10.05.2022 letter this cited
      // for three years while `rulesCheckedOn` claimed a current review -
      // a contradiction the disclaimer surface exists to prevent, since
      // the freshness signal was true and the citation behind it was not.
      //
      // Two parts of it bear directly on this report: Rn. 87 onward is the
      // record-keeping section its reader will be measured against, and
      // Rn. 29b addresses tax reports like this one, making the point this
      // module's own notice makes - such a report resembles a bank's
      // Steuerbescheinigung in form and carries none of its authority.
      'BMF 06.03.2025 (IV C 1 - S 2256/00042/064/043)',
    ],
    supportedYears: { from: 2020 },
  },
  // 'reward' is deliberately absent: classifyReward's airdrop branch
  // returns [] because the tax treatment is genuinely unresolved, not
  // because an airdrop is a considered non-event, and that gap must keep
  // surfacing as `unclassified` rather than vanish. 'fee' is absent for the
  // same reason the classify switch's default case returns [] for it -
  // this task's confirmed rules do not address it.
  handles: ['trade', 'transfer', 'fiat-in', 'fiat-out'],
  defaultMatching: 'fifo',
  // German FIFO is per wallet, not pooled across the whole portfolio.
  partitionBy: (event) => event.venue,
  classify,
  assess,
};

export default germanTax;
