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
import { linesFor } from '@/tax/jurisdictions/de.forms';
import { costsOf } from '@/tax/matching';
import { FORK_ORIGIN_KEY } from '@/tax/residualOrigin';
import { rewardKindOf } from '@/tax/rewardKinds';
import type { Leg, LedgerEvent, RewardKind } from '@/ledger/types';
import type {
  AssessedDisposal,
  AssessInput,
  CapitalResult,
  CarryForwardOutcome,
  MatchedDisposal,
  FilingEntry,
  FilingFigures,
  FilingSection,
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

/** §20 Abs. 9 EStG Sparer-Pauschbetrag: a Freibetrag, so only the excess is
 *  taxed. It is shared with all other capital income, which the scope note
 *  says. */
const SAVER_ALLOWANCE_LABEL = "Saver's allowance (§20 Abs. 9 EStG)";
const SAVER_ALLOWANCE_SCOPE_NOTE =
  'This allowance covers all of your capital income in the year, not only derivatives, and only what is not already used elsewhere. Spouses assessed jointly have twice the amount.';
const CAPITAL_NOTE =
  'Capital income from Termingeschäfte under §20 Abs. 2 S. 1 Nr. 3 EStG. The estimate is the flat 25 % Abgeltungsteuer on the taxable amount, without Solidaritätszuschlag, Kirchensteuer or the Günstigerprüfung. Losses offset only other capital income (§20 Abs. 6 EStG). A foreign exchange withholds no Kapitalertragsteuer, so this income is declared in Anlage KAP.';
const ABGELTUNGSTEUER_PERCENT = '25';
/** On every capital event from a margin position: the §20 reading is the
 *  one applied, and it is contested. Keyed on the typed `product`. */
const MARGIN_NOTE =
  'Margin trading is treated here as a Termingeschäft under §20 EStG. German practice is divided; it may instead be a §23 private sale at your personal rate. Confirm which applies.';
/** On a rollover event's capital events, whose fee legs are recorded as a
 *  loss that is not deducted. */
const ROLLOVER_NOTE =
  'A margin rollover is a financing cost. It is shown here but not deducted: §20 Abs. 9 EStG allows no actual Werbungskosten beyond the allowance. Confirm whether it is deductible in your case.';

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

/**
 * A reward's fee legs - the network fee of a claim, a pool's withdrawal
 * charge - get the trade branch's two treatments, for the same reasons.
 *
 * The fee coins leave the holding, so a crypto fee is a disposal at market
 * (`feeDisposals`, exactly as in classifyTrade), realising whatever the fee
 * coins gained since purchase. And the fee is an expense of earning the
 * reward, so its value is Werbungskosten against that event's §22 Nr. 3
 * income (§9 Abs. 1, §22 Nr. 3 EStG): it rides on the income event as
 * `costs`, the host values it like any other cost, and `assess` deducts it
 * - never below zero, since the reward is the only income it was spent on.
 * Not on the acquisition: the fee bought the right to the reward, not the
 * coins, so it is no Anschaffungsnebenkosten. A fiat fee has no holding
 * and is only the deduction.
 *
 * Before this, both were dropped: the fee coins never left the lot ledger
 * and the fee reduced nothing.
 */
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
  const fees = event.legs.filter((one) => one.role === 'fee');
  const feeDisposals = fees.flatMap((one) => legToTaxEvent(event, one));

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
    // No income to deduct a fee from, but its coins still left.
    return [
      {
        ...acquisition,
        consideration: { assetId: leg.assetId, amount: '0' },
        origin: { key: FORK_ORIGIN_KEY },
      },
      ...feeDisposals,
    ];
  }

  const note = REWARD_NOTES[kind];
  const costs = fees.map((one) => ({
    assetId: one.assetId,
    amount: one.amount,
  }));
  const income: TaxEvent = {
    sourceEventId: event.id,
    kind: 'income',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
    ...(note === undefined ? {} : { note }),
    ...(costs.length === 0 ? {} : { costs }),
  };
  return [income, acquisition, ...feeDisposals];
};

/**
 * One income event's figures: its value, the costs deducted from it, and
 * what is left. The deduction is capped at the value, so a fee larger than
 * the reward leaves the income at 0 rather than negative; the host notes
 * the excess on the row.
 */
const netIncome = (
  event: TaxEvent,
): { value: string; deducted: string; net: string } => {
  const value = event.value ?? '0';
  const costs = costsOf(event);
  const deducted = compareAmounts(costs, value) > 0 ? value : costs;
  return { value, deducted, net: subtractAmounts(value, deducted) };
};

/**
 * A derivative settlement is §20 Abs. 2 S. 1 Nr. 3 capital income, not a §23
 * private sale: each settlement leg becomes a capital gain (received) or
 * capital loss (paid, or a fee). A settlement in crypto ALSO moves holdings,
 * so it additionally acquires (profit received) or disposes of (loss or fee
 * paid) those coins, which keeps the lot ledger and later §23 sales right.
 * Fiat settlements have no holding and stay capital events only.
 */
const classifyDerivative = (event: LedgerEvent): TaxEvent[] => {
  const isRollover = event.derivative?.kind === 'rollover';
  // One key per event, never two joined: the rollover note already names
  // margin, so a rollover row carries it alone.
  const note = isRollover
    ? ROLLOVER_NOTE
    : event.derivative?.product === 'margin'
      ? MARGIN_NOTE
      : undefined;
  return event.legs.flatMap((leg) => {
    const isGain = leg.role === 'principal' && leg.direction === 'in';
    const base = {
      sourceEventId: event.id,
      assetId: leg.assetId,
      amount: leg.amount,
      timestamp: event.timestamp,
      venue: leg.venue,
    };
    const capital: TaxEvent = {
      ...base,
      kind: isGain ? 'capital-gain' : 'capital-loss',
      ...(note === undefined ? {} : { note }),
      ...(isRollover && leg.role === 'fee' ? { deductible: false } : {}),
    };
    if (isFiatAsset(leg.assetId)) {
      return [capital];
    }
    // The holding side carries neither the note nor `deductible`: those
    // describe the §20 figure, not the coins leaving or arriving.
    return [capital, { ...base, kind: isGain ? 'acquisition' : 'disposal' }];
  });
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
    case 'derivative':
      return classifyDerivative(event);
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
  let taxableProceeds = '0';
  let taxableCostBasis = '0';

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
      taxableProceeds = addAmounts(taxableProceeds, lotProceeds);
      taxableCostBasis = addAmounts(taxableCostBasis, lot.costBasis);
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
    taxableProceeds,
    taxableCostBasis,
    reason: describeHoldingPeriod(exempt, taxable),
  };
};

const FILING_TITLE_SALES = 'Private sales - crypto assets';
const FILING_TITLE_INCOME = 'Other income (§22 Nr. 3 EStG)';
const FILING_TITLE_KAP = 'Derivatives (Anlage KAP)';
const KRYPTO = 'Kryptowerte';
/** The 2025 form asks "1 = Ja" on the indicator lines. */
const INDICATOR_YES = '1';
const INCOME_TYPE_TEXT = 'Staking, Lending, Airdrops (Kryptowerte)';

/**
 * The taxable-side share of a disposal's valued costs. A fully taxable
 * disposal contributes its full `costs`; a split one the share of its
 * amount that sits in lots held one year or less. Zero when no lot is.
 */
const taxableCosts = (disposal: MatchedDisposal): string => {
  let taxableAmount = '0';
  for (const lot of disposal.consumed) {
    if (!heldMoreThanOneYear(lot.acquiredAt, disposal.timestamp)) {
      taxableAmount = addAmounts(taxableAmount, lot.amount);
    }
  }
  if (isZeroAmount(taxableAmount)) {
    return '0';
  }
  if (compareAmounts(taxableAmount, disposal.amount) >= 0) {
    return disposal.costs;
  }
  return proportion(disposal.costs, taxableAmount, disposal.amount);
};

/**
 * The figures the user types into Mein ELSTER: PRE-threshold sums, taxable
 * side only. The Freigrenzen, the saver's allowance and any carry-forward
 * are the Finanzamt's, so none is applied here.
 *
 * `MatchedDisposal.proceeds` is already net of the disposal's valued costs,
 * but the form wants the gross price and the expenses separately, so the
 * taxable-side costs are added back to the proceeds and shown as expenses.
 * The result is then still exactly the taxable-side gain.
 */
const buildFiling = (
  input: AssessInput,
  lines: AssessedDisposal[],
  capital: CapitalResult | undefined,
): FilingFigures | undefined => {
  const forms = linesFor(input.year);
  const ref = (
    form: 'Anlage SO' | 'Anlage KAP',
    line: number | undefined,
  ): Pick<FilingEntry, 'reference'> =>
    forms === undefined || line === undefined
      ? {}
      : { reference: { form, line } };
  const sections: FilingSection[] = [];

  // A disposal with no taxable-side lot has nothing to declare. The lots
  // decide, not the sums: a worthless taxable lot has zero proceeds too.
  const pairs = lines
    .map((line, index) => ({ line, matched: input.matched[index] }))
    .filter(({ matched }) =>
      matched.consumed.some(
        (lot) => !heldMoreThanOneYear(lot.acquiredAt, matched.timestamp),
      ),
    );
  if (pairs.length > 0) {
    const assessed = pairs.map(({ line }) => line);
    const expenses = sumAmounts(
      pairs.map(({ matched }) => taxableCosts(matched)),
    );
    const proceeds = addAmounts(
      sumAmounts(assessed.map((line) => line.taxableProceeds ?? '0')),
      expenses,
    );
    const acquisition = sumAmounts(
      assessed.map((line) => line.taxableCostBasis ?? '0'),
    );
    const result = subtractAmounts(
      subtractAmounts(proceeds, acquisition),
      expenses,
    );
    const so = forms?.so;
    sections.push({
      title: FILING_TITLE_SALES,
      form: 'Anlage SO',
      entries: [
        {
          label: 'Kind of private sale',
          text: INDICATOR_YES,
          ...ref('Anlage SO', so?.indicator),
        },
        {
          label: 'Description of the asset',
          text: KRYPTO,
          ...ref('Anlage SO', so?.description),
        },
        {
          label: 'Period of the sales',
          text: `01.01.${input.year} – 31.12.${input.year}`,
          ...ref('Anlage SO', so?.period),
        },
        {
          label: 'Total proceeds',
          amount: proceeds,
          ...ref('Anlage SO', so?.proceeds),
        },
        {
          label: 'Acquisition costs',
          amount: acquisition,
          ...ref('Anlage SO', so?.acquisitionCosts),
        },
        {
          label: 'Expenses',
          amount: expenses,
          ...ref('Anlage SO', so?.expenses),
        },
        {
          label: 'Result of the private sales',
          amount: result,
          ...ref('Anlage SO', so?.result),
        },
        {
          label: 'Carried over to the tax return',
          amount: result,
          ...ref('Anlage SO', so?.carryOver),
        },
      ],
    });
  }

  if (input.income.length > 0) {
    // Gross receipts and the Werbungskosten separately, as the form asks;
    // the result is the same net sum the Freigrenze is tested on.
    const figures = input.income.map(netIncome);
    const sum = sumAmounts(figures.map((one) => one.value));
    const expenses = sumAmounts(figures.map((one) => one.deducted));
    const result = sumAmounts(figures.map((one) => one.net));
    const income = forms?.income;
    sections.push({
      title: FILING_TITLE_INCOME,
      form: 'Anlage SO',
      entries: [
        {
          label: 'Kind of other income',
          text: INDICATOR_YES,
          ...ref('Anlage SO', income?.indicator),
        },
        {
          label: 'Type of the other income',
          text: INCOME_TYPE_TEXT,
          ...ref('Anlage SO', income?.type),
        },
        {
          label: 'Sum of the receipts',
          amount: sum,
          ...ref('Anlage SO', income?.sum),
        },
        {
          label: 'Expenses related to the receipts',
          amount: expenses,
          ...ref('Anlage SO', income?.expenses),
        },
        {
          label: 'Result of the other income',
          amount: result,
          ...ref('Anlage SO', income?.result),
        },
      ],
    });
  }

  // Line 19 is a balance, line 22 the losses contained in it. A year whose
  // only capital events are not deducted (rollover fees) has nothing to type.
  if (
    capital !== undefined &&
    !(isZeroAmount(capital.gains) && isZeroAmount(capital.losses))
  ) {
    sections.push({
      title: FILING_TITLE_KAP,
      form: 'Anlage KAP',
      entries: [
        {
          label:
            'Foreign capital income without withholding (net of the losses below)',
          amount: capital.net,
          ...ref('Anlage KAP', forms?.kap.net),
          note: 'Other foreign capital income you have is added on this line as well.',
        },
        {
          label: 'Losses contained in the line above',
          amount: capital.losses,
          ...ref('Anlage KAP', forms?.kap.losses),
        },
      ],
    });
  }

  if (sections.length === 0) {
    return undefined;
  }
  return {
    year: input.year,
    linesVerified: forms !== undefined,
    ...(forms === undefined ? {} : { verifiedBy: forms.verified }),
    sections,
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
  let taxableGain = gainExceeded ? rawTaxableGain : '0';

  const declaredPrivate = input.carryForward?.privateSales;
  let privateOutcome: CarryForwardOutcome | undefined;
  if (declaredPrivate !== undefined && !isZeroAmount(declaredPrivate)) {
    // §23 Abs. 3 S. 8 EStG, nach Maßgabe des §10d: the carried loss reduces
    // the Einkünfte AFTER the Freigrenze has been tested on the year's own
    // Gesamtgewinn (S. 5). Testing after the deduction would exempt gains
    // the law taxes and consume carry-forward the law preserves.
    const used = gainExceeded
      ? compareAmounts(declaredPrivate, rawTaxableGain) < 0
        ? declaredPrivate
        : rawTaxableGain
      : '0';
    taxableGain = subtractAmounts(taxableGain, used);
    privateOutcome = {
      declared: declaredPrivate,
      used,
      remaining: subtractAmounts(declaredPrivate, used),
    };
  }

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
  // a private-sale loss must never reduce it. Tested on the income net of
  // its Werbungskosten (a fee paid to receive a reward), per event.
  const incomeFigures = input.income.map(netIncome);
  const incomeSum = sumAmounts(incomeFigures.map((one) => one.net));
  const hasIncomeCosts = input.income.some(
    (event) => (event.costs ?? []).length > 0,
  );
  const incomeCosts = sumAmounts(incomeFigures.map((one) => one.deducted));
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

  const thresholds = [gainThreshold, incomeThreshold];
  let capital: CapitalResult | undefined;
  let capitalOutcome: CarryForwardOutcome | undefined;
  if (input.capital.length > 0) {
    const gains = sumAmounts(
      input.capital
        .filter((event) => event.kind === 'capital-gain')
        .map((event) => event.value ?? '0'),
    );
    const capitalLosses = input.capital.filter(
      (event) => event.kind === 'capital-loss',
    );
    const losses = sumAmounts(
      capitalLosses
        .filter((event) => event.deductible !== false)
        .map((event) => event.value ?? '0'),
    );
    const notDeducted = sumAmounts(
      capitalLosses
        .filter((event) => event.deductible === false)
        .map((event) => event.value ?? '0'),
    );
    const net = subtractAmounts(gains, losses);
    const allowance = input.year >= 2023 ? '1000' : '801';
    // A §20 carry-forward reduces a positive net before the allowance.
    const declaredCapital = input.carryForward?.capital;
    let carryForwardUsed = '0';
    if (declaredCapital !== undefined && !isZeroAmount(declaredCapital)) {
      if (compareAmounts(net, '0') > 0) {
        carryForwardUsed =
          compareAmounts(declaredCapital, net) < 0 ? declaredCapital : net;
      }
      capitalOutcome = {
        declared: declaredCapital,
        used: carryForwardUsed,
        remaining: subtractAmounts(declaredCapital, carryForwardUsed),
      };
    }
    const netAfterCarry = subtractAmounts(net, carryForwardUsed);
    const excess = subtractAmounts(netAfterCarry, allowance);
    const taxable = compareAmounts(excess, '0') > 0 ? excess : '0';
    capital = {
      gains,
      losses,
      notDeducted,
      net,
      allowance,
      taxable,
      carryForwardUsed,
      loss: compareAmounts(net, '0') < 0 ? negateAmount(net) : '0',
      estimatedTax: normaliseAmount(
        new Big(taxable).times(ABGELTUNGSTEUER_PERCENT).div(100).toString(),
      ),
      note: CAPITAL_NOTE,
    };
    thresholds.push({
      label: SAVER_ALLOWANCE_LABEL,
      limit: allowance,
      // The post-carry figure, so this card agrees with the derivatives
      // card: a carry that takes the net under the allowance leaves it
      // unexceeded.
      actual: compareAmounts(netAfterCarry, '0') > 0 ? netAfterCarry : '0',
      exceeded: compareAmounts(netAfterCarry, allowance) > 0,
      kind: 'freibetrag',
      scopeNote: SAVER_ALLOWANCE_SCOPE_NOTE,
    });
  }

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

  const filing = buildFiling(input, lines, capital);

  return {
    year: input.year,
    ...(filing === undefined ? {} : { filing }),
    lines,
    totals: {
      taxableGain,
      exemptGain,
      income,
      ...(hasIncomeCosts ? { incomeCosts } : {}),
      loss,
      // The host (runTaxReport) recomputes `omitted` from what it could not
      // resolve; this module only knows the disposals it was handed.
      computedFrom: input.matched.length,
      omitted: 0,
    },
    thresholds,
    ...(capital === undefined ? {} : { capital }),
    ...(privateOutcome === undefined && capitalOutcome === undefined
      ? {}
      : {
          carryForward: {
            ...(privateOutcome === undefined
              ? {}
              : { privateSales: privateOutcome }),
            ...(capitalOutcome === undefined
              ? {}
              : { capital: capitalOutcome }),
          },
        }),
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
    rulesCheckedOn: '2026-10-10',
    rulesVersion: '1.6.0',
    changelog: [
      {
        version: '1.6.0',
        date: '2026-10-10',
        summary:
          'Fees paid to receive a reward are disposed and deducted as Werbungskosten.',
      },
      {
        version: '1.5.0',
        date: '2026-10-10',
        summary:
          'The report builds the Anlage SO and Anlage KAP filing figures in form order (2025 lines verified); Anlage KAP line 19 is the net balance.',
      },
      {
        version: '1.4.0',
        date: '2026-10-10',
        summary:
          "Declared loss carry-forward applied to §23 after the Freigrenze test and to §20 before the saver's allowance.",
      },
      {
        version: '1.3.0',
        date: '2026-10-10',
        summary:
          "Derivative settlements taxed as capital income under §20 EStG with the saver's allowance; margin flagged as contested; rollover not deducted.",
      },
      {
        version: '1.2.0',
        date: '2026-10-10',
        summary:
          'Typed reward kinds (staking, lending, mining, airdrop, fork); trades valued at the fiat actually paid or received; transfer fees disposed of at market.',
      },
      {
        version: '1.1.0',
        date: '2026-10-09',
        summary:
          'Holding period by calendar date; trade fees deducted as Werbungskosten; income itemised.',
      },
      {
        version: '1.0.0',
        date: '2026-10-01',
        summary:
          'Initial rules: §23 FIFO per venue with the Freigrenze and one-year exemption, §22 Nr. 3 staking income.',
      },
    ],
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
      '§20 Abs. 2 S. 1 Nr. 3, Abs. 6, Abs. 9 EStG',
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
    supportsCarryForward: true,
  },
  // 'reward' is deliberately absent: classifyReward's airdrop branch
  // returns [] because the tax treatment is genuinely unresolved, not
  // because an airdrop is a considered non-event, and that gap must keep
  // surfacing as `unclassified` rather than vanish. 'fee' is absent for the
  // same reason the classify switch's default case returns [] for it -
  // this task's confirmed rules do not address it.
  handles: ['trade', 'transfer', 'fiat-in', 'fiat-out', 'derivative'],
  defaultMatching: 'fifo',
  // German FIFO is per wallet, not pooled across the whole portfolio.
  partitionBy: (event) => event.venue,
  classify,
  assess,
};

export default germanTax;
