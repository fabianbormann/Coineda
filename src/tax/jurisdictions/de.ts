import Big from 'big.js';
import {
  addAmounts,
  compareAmounts,
  isZeroAmount,
  normaliseAmount,
  subtractAmounts,
  sumAmounts,
} from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import type { Leg, LedgerEvent } from '@/ledger/types';
import type {
  AssessedDisposal,
  AssessInput,
  MatchedDisposal,
  TaxAssessment,
  TaxEvent,
  TaxModule,
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

/** Strictly more than one year is exempt - the anniversary itself is still
 *  taxable. REVIEW FOCUS 1: an inclusive (>=) comparison here makes a
 *  taxable gain disappear. */
const ONE_YEAR_DAYS = 365;

const PRIVATE_SALE_THRESHOLD_LABEL =
  'Tax-free threshold for private sales (§23 EStG)';
const STAKING_INCOME_THRESHOLD_LABEL =
  'Tax-free threshold for staking income (§22 Nr. 3 EStG)';

/**
 * Leader rewards are likely gewerbliche Einkünfte rather than §22 Nr. 3
 * sonstige Einkünfte, which this module does not model. Rather than silently
 * folding a leader reward into the wrong category, classify() tags it with
 * this note so a reader (or their accountant) knows the figure needs a
 * second look.
 */
const LEADER_REWARD_UNCERTAIN_NOTE =
  'Leader rewards may be gewerbliche Einkünfte rather than §22 Nr. 3 income. This classification is uncertain, so confirm it yourself before relying on it.';

/** A staking provider record, carried in `raw` by the Cardano sources. Only
 *  `type` matters here: 'member' is plain §22 Nr. 3 income, 'leader' is the
 *  uncertain gewerbliche-Einkünfte case, and its absence (on a reward with no
 *  note identifying it as staking either) is an airdrop. */
type StakingRewardRaw = {
  epoch?: number;
  /** The provider sends this as a JSON NUMBER, unlike the utxo endpoints'
   *  strings, and `raw` is that payload verbatim - so this cannot claim to
   *  be a string. Nothing here reads it (the amount a calculation uses is
   *  the leg's own decimal string), but a typed claim that an amount is a
   *  string when it is not is exactly the mistake this subsystem's first
   *  invariant exists to prevent. See amountString in
   *  src/sources/cardano/translator.ts. */
  amount?: number | string;
  type?: 'member' | 'leader';
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

const classifyReward = (event: LedgerEvent): TaxEvent[] => {
  const leg = event.legs[0];
  if (!leg) {
    return [];
  }

  const rawType = (event.raw as StakingRewardRaw | undefined)?.type;
  const noteIdentifiesStaking = /staking/i.test(event.note ?? '');

  if (rawType === undefined && !noteIdentifiesStaking) {
    // An airdrop. Its tax treatment is unresolved, so this returns nothing
    // rather than guessing - the host records it as an unclassified,
    // unresolved item, which is how "not computed, with a stated reason" is
    // represented without inventing a number.
    return [];
  }

  // The value at receipt is taxed as income under §22 Nr. 3 AND becomes the
  // coins' cost basis for whatever disposes of them later - both events are
  // emitted from the same leg, valued identically by the host.
  const income: TaxEvent = {
    sourceEventId: event.id,
    kind: 'income',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
    note: rawType === 'leader' ? LEADER_REWARD_UNCERTAIN_NOTE : undefined,
  };

  const acquisition: TaxEvent = {
    sourceEventId: event.id,
    kind: 'acquisition',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
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

/** Explains, per disposal, which §23 Abs. 1 Nr. 2 EStG outcome applied. A
 *  raw diagnostic sentence for the audit trail - not a translation key, the
 *  same choice already made for UnresolvedItem.reason, because the content
 *  is assembled from the computed split rather than being one of a fixed set
 *  of sentences. */
const describeHoldingPeriod = (exempt: string, taxable: string): string => {
  const hasExempt = !isZeroAmount(exempt);
  const hasTaxable = !isZeroAmount(taxable);
  if (hasExempt && hasTaxable) {
    return 'Split disposal: the lots held more than one year are tax-free under §23 Abs. 1 Nr. 2 EStG, the rest was held one year or less and is taxable.';
  }
  if (hasExempt) {
    return 'Held more than one year, so the gain is tax-free under §23 Abs. 1 Nr. 2 EStG.';
  }
  return 'Held one year or less, so the gain is taxable under §23 Abs. 1 Nr. 2 EStG.';
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

    // Strictly greater than one year, never >=: Review Focus 1.
    if (lot.heldDays > ONE_YEAR_DAYS) {
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

  const gainThreshold: ThresholdOutcome = {
    label: PRIVATE_SALE_THRESHOLD_LABEL,
    limit: gainLimit,
    actual: rawTaxableGain,
    exceeded: gainExceeded,
    kind: 'freigrenze',
  };

  // §22 Nr. 3 EStG's own €256 Freigrenze, assessed independently of §23 -
  // a private-sale loss must never reduce it.
  const incomeSum = sumAmounts(input.income.map((event) => event.value ?? '0'));
  const incomeLimit = '256';
  const incomeExceeded = compareAmounts(incomeSum, incomeLimit) >= 0;
  const income = incomeExceeded ? incomeSum : '0';

  const incomeThreshold: ThresholdOutcome = {
    label: STAKING_INCOME_THRESHOLD_LABEL,
    limit: incomeLimit,
    actual: incomeSum,
    exceeded: incomeExceeded,
    kind: 'freigrenze',
  };

  let estimatedLiability: string | undefined;
  if (input.rate !== undefined) {
    // The one place besides `proportion` that touches Big directly: a
    // personal rate times a gain, plus the 5.5% Solidaritätszuschlag on the
    // resulting tax. Every intermediate still round-trips through a decimal
    // string via normaliseAmount before leaving this function.
    const tax = new Big(taxableGain).times(new Big(input.rate)).div(100);
    const withSolidaritySurcharge = tax.times(new Big('1.055'));
    estimatedLiability = normaliseAmount(withSolidaritySurcharge.toString());
  }

  return {
    year: input.year,
    lines,
    totals: {
      taxableGain,
      exemptGain,
      income,
      // The host (runTaxReport) recomputes `omitted` from what it could not
      // resolve; this module only knows the disposals it was handed.
      computedFrom: input.matched.length,
      omitted: 0,
    },
    thresholds: [gainThreshold, incomeThreshold],
    estimatedLiability,
    unresolved: [],
  };
};

const germanTax: TaxModule = {
  manifest: {
    id: 'de',
    jurisdiction: 'Germany',
    contributor: 'Fabian Bormann',
    rulesCheckedOn: '2026-10-01',
    references: [
      '§23 Abs. 1 Nr. 2 EStG',
      '§23 Abs. 3 Satz 5 EStG',
      '§22 Nr. 3 EStG',
      'BMF 10.05.2022',
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
