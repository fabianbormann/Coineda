import Big from 'big.js';
import { normaliseAmount, sumAmounts } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import type { Leg, LedgerEvent } from '@/ledger/types';
import type {
  AssessedDisposal,
  AssessInput,
  MatchedDisposal,
  TaxAssessment,
  TaxEvent,
  TaxModule,
  TaxReason,
} from '@/tax/types';

/**
 * Austria - ÖkoStRefG 2022 folded crypto into §27 EStG Einkünfte aus
 * Kapitalvermögen, taxed at a flat 27.5% KESt (§27a Abs. 1), in force from
 * 1 March 2022. This module exists specifically to prove the TaxModule
 * contract is not shaped around Germany: crypto-to-crypto is not a
 * realisation here (cost simply carries over), there is no holding-period
 * exemption for anything acquired after the cutoff, and the mandated cost
 * basis is a moving average pooled per asset rather than per-wallet FIFO.
 *
 * Not legal or tax advice. `manifest.rulesCheckedOn` and `manifest.references`
 * carry that uncertainty to the reader rather than hiding it behind a
 * confident-looking number.
 */

/** 1 March 2021. Crypto acquired BEFORE this is Altvermögen and tax-free
 *  on disposal; on or after it is Neuvermögen. §27b Abs. 4: the old
 *  one-year speculation period (§31 EStG a.F.) still shelters anything
 *  that was already outside it when the new regime took effect a year
 *  later, so the cutoff is a year before ÖkoStRefG's own effective date,
 *  not that date itself. */
const ALTVERMOEGEN_CUTOFF = Date.UTC(2021, 2, 1);

/** §27a Abs. 1 EStG: flat 27.5% KESt. Statutory, not elected, so
 *  estimatedLiability is always computed - never left to an optional
 *  caller-supplied rate the way Germany's income-dependent rate is. */
const KEST_RATE = '27.5';

const PARTITION_ALT = 'alt';
const PARTITION_NEU = 'neu';

/**
 * Austria pools cost per asset across the whole portfolio (moving average),
 * so the venue is never the partition key here the way it is for Germany's
 * per-wallet FIFO. The only split the law requires is Altvermögen versus
 * Neuvermögen, because mixing a tax-free pre-cutoff holding into the same
 * average as a taxable post-cutoff one would make part of a tax-free
 * holding taxable and part of a taxable holding free - there would be no
 * way to recover which averaged unit came from which side.
 */
const partitionBy = (event: TaxEvent): string =>
  event.timestamp < ALTVERMOEGEN_CUTOFF ? PARTITION_ALT : PARTITION_NEU;

/** A leg becomes a disposal (out) or acquisition (in), skipping fiat legs
 *  the same way Germany's classify does - fiat is never itself a crypto
 *  disposal. transfer legs are the host's already-filtered cross-boundary
 *  sends/receives. */
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

/** A staking provider record, carried in `raw` by the Cardano sources -
 *  same shape Germany's classifyReward reads. */
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

const classifyReward = (event: LedgerEvent): TaxEvent[] => {
  const leg = event.legs[0];
  if (!leg) {
    return [];
  }

  const rawType = (event.raw as StakingRewardRaw | undefined)?.type;
  const noteIdentifiesStaking = /staking/i.test(event.note ?? '');

  if (rawType === undefined && !noteIdentifiesStaking) {
    // An airdrop - unresolved rather than guessed, same as Germany.
    return [];
  }

  const income: TaxEvent = {
    sourceEventId: event.id,
    kind: 'income',
    assetId: leg.assetId,
    amount: leg.amount,
    timestamp: event.timestamp,
    venue: leg.venue,
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
 * A 'trade' under ÖkoStRefG, which turns on what was on the other side.
 *
 * Crypto-to-crypto is not a realisation here (§27b Abs. 3: cost carries
 * over to whatever was acquired), so a swap produces nothing - where
 * Germany's classify treats the identical LedgerEvent as a disposal plus
 * an acquisition. That is GOLDEN CASE 3, and it is why 'trade' is declared
 * in `handles`.
 *
 * But the ledger's 'trade' kind is not only a swap: it also carries a
 * plain buy (fiat out, crypto in) and a plain sell (crypto out, fiat in),
 * and those ARE a §27 acquisition and realisation. Returning [] for them
 * was indistinguishable, to the host, from the swap's considered
 * non-event - so an Austrian selling BTC for euros got taxableGain: 0, no
 * unresolved item, and `omitted` still 0, with nothing anywhere stating a
 * disposal had been dropped. No source emits 'trade' yet, which is exactly
 * why it is settled now: it becomes reachable the moment an exchange
 * source or a manual-entry screen lands, and nobody will be re-reading
 * this file then.
 *
 * A fiat leg is what tells the three apart, and `isFiatAsset` already
 * names that convention.
 */
const classifyTrade = (event: LedgerEvent): TaxEvent[] => {
  const hasFiatLeg = event.legs.some(
    (leg) => leg.role === 'principal' && isFiatAsset(leg.assetId),
  );
  if (!hasFiatLeg) {
    // Crypto-to-crypto: cost carries over, nothing is realised.
    return [];
  }
  // One side is fiat, so this is a real acquisition or disposal.
  // legToTaxEvent already drops the fiat leg itself - paying or receiving
  // euros is not a disposal of crypto - which leaves exactly the crypto
  // side of the trade.
  return event.legs.flatMap((leg) => legToTaxEvent(event, leg));
};

/**
 * Pure and synchronous - no Date.now(), no Math.random(), no locale
 * formatting. The conformance gate (Task 6) runs this twice on the same
 * input and compares.
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

/**
 * No per-lot holding-period split: Austria has none. The whole disposal is
 * exempt if it was matched within the Altvermögen partition, taxable
 * otherwise - decided from `disposal.partition`, not from any consumed
 * lot's `acquiredAt`. Moving-average matching deliberately gives every
 * synthetic lot the disposal's OWN timestamp as acquiredAt (heldDays: 0),
 * because an averaged pool has no acquisition date of its own; the
 * partition key is what survives from match()'s grouping and is the only
 * signal that correctly carries the Altvermögen/Neuvermögen distinction
 * through to assess().
 */
const altvermoegenReason = (isAltvermoegen: boolean): TaxReason =>
  isAltvermoegen
    ? {
        key: 'Altvermögen (acquired before 1 March 2021): exempt from KESt under §27b EStG.',
      }
    : {
        key: 'Neuvermögen: taxable at the flat 27.5% KESt under §27a Abs. 1 EStG. No holding-period exemption applies.',
      };

const assessDisposal = (disposal: MatchedDisposal): AssessedDisposal => {
  const isAltvermoegen = disposal.partition === PARTITION_ALT;
  const exempt = isAltvermoegen ? disposal.gain : '0';
  const taxable = isAltvermoegen ? '0' : disposal.gain;

  return {
    disposalEventId: disposal.disposalEventId,
    assetId: disposal.assetId,
    timestamp: disposal.timestamp,
    proceeds: disposal.proceeds,
    costBasis: disposal.costBasis,
    gain: disposal.gain,
    exempt,
    taxable,
    reason: altvermoegenReason(isAltvermoegen),
  };
};

/**
 * Austria has no Freigrenze and no Freibetrag for capital gains - every
 * taxable Euro is taxed, so `thresholds` is always empty. The 27.5% KESt is
 * statutory rather than elected, so `estimatedLiability` is computed
 * unconditionally, unlike Germany's optional caller-supplied rate.
 */
const assess = (input: AssessInput): TaxAssessment => {
  const lines = input.matched.map(assessDisposal);

  const exemptGain = sumAmounts(lines.map((line) => line.exempt));
  const taxableGain = sumAmounts(lines.map((line) => line.taxable));
  const income = sumAmounts(input.income.map((event) => event.value ?? '0'));

  // The one place besides big.js's own default this module touches it
  // directly - the statutory rate multiplication - keeping every
  // intermediate a decimal string via normaliseAmount before it leaves.
  const estimatedLiability = normaliseAmount(
    new Big(taxableGain).times(new Big(KEST_RATE)).div(100).toString(),
  );

  return {
    year: input.year,
    lines,
    totals: {
      taxableGain,
      exemptGain,
      income,
      computedFrom: input.matched.length,
      omitted: 0,
    },
    thresholds: [],
    estimatedLiability,
    unresolved: [],
  };
};

const austrianTax: TaxModule = {
  manifest: {
    id: 'at',
    jurisdiction: 'Austria',
    contributor: 'Fabian Bormann',
    rulesCheckedOn: '2026-10-01',
    partitionLabel:
      'Cost is pooled per asset across the portfolio, split only between Altvermögen and Neuvermögen.',
    references: ['ÖkoStRefG 2022', '§27a Abs. 4 Z 3 EStG', '§27b EStG'],
    supportedYears: { from: 2022 },
  },
  // 'trade' IS declared here, unlike Germany: an empty classify result for
  // a SWAP is Austria's considered answer (crypto-to-crypto carries cost
  // over rather than realising it), not a coverage gap, so the host must
  // not surface it as unclassified. That declaration is only honest
  // because classifyTrade distinguishes the swap from the plain buy and
  // sell the same kind also carries - declaring the kind while returning
  // [] for a real sale would make the host drop it silently. 'reward' is deliberately absent for the
  // same reason Germany's is: classifyReward's airdrop branch returns []
  // because the tax treatment is genuinely unresolved, and that gap must
  // keep surfacing rather than vanish just because staking rewards (the
  // rest of 'reward') are fully handled. 'fee' is absent because the
  // classify switch's default case - which also covers it - is not
  // addressed by this task's confirmed rules.
  handles: ['trade', 'transfer', 'fiat-in', 'fiat-out'],
  defaultMatching: 'moving-average',
  partitionBy,
  classify,
  assess,
};

export default austrianTax;
