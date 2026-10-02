import Big from 'big.js';
import {
  addAmounts,
  subtractAmounts,
  compareAmounts,
  isZeroAmount,
  normaliseAmount,
} from '@/ledger/amount';
import type {
  ConsumedLot,
  MatchedDisposal,
  MatchingMethod,
  TaxEvent,
} from './types';

const MS_PER_DAY = 86_400_000;

// A running average divides, which FIFO never does, so this is the only
// place in the codebase that can produce a repeating decimal. 20 decimal
// places with ROUND_HALF_UP is pinned here rather than inherited from a
// global Big.DP, because an unpinned mode compounds through every
// subsequent disposal of the same pool - and because changing a global
// would silently alter every other amount in the app.
const DIVIDE_DP = 20;
const DIVIDE_RM = 1; // Big.roundHalfUp
const divide = (a: string, b: string): string =>
  normaliseAmount(
    new Big(a).div(new Big(b)).round(DIVIDE_DP, DIVIDE_RM).toString(),
  );

// A proportional split (apportioning a lot's remaining cost, or a
// disposal's proceeds, across a partially-consumed amount) also divides,
// so it goes through the same pinned rounding rather than whatever Big's
// global default happens to be.
const proportion = (
  total: string,
  numerator: string,
  denominator: string,
): string =>
  divide(new Big(total).times(new Big(numerator)).toString(), denominator);

/**
 * The tie-break when two events share a timestamp.
 *
 * Sorting on the timestamp alone leaves ties to Array.prototype.sort's
 * stability, which means to INSERTION order - and insertion order came
 * from the order the Cardano translator happens to build its legs in
 * (`legsFor(inputs, 'out')` before `legsFor(outputs, 'in')`). A tax result
 * that depends on the call order inside an unrelated module is not a
 * result, and renaming or reordering those two calls would silently change
 * a cost basis.
 *
 * Acquisition before disposal, deliberately: value that arrived in the
 * same instant really was available to cover what left, which is what the
 * user's balance did. Ordering the disposal first would report a shortfall
 * - "no acquisition on record" - for a disposal their holdings plainly
 * covered. Statute has no rule for an identical instant, so what matters
 * is that the answer is the same on every run.
 */
const kindRank = (event: TaxEvent): number =>
  event.kind === 'acquisition' ? 0 : 1;

type FifoLot = {
  acquisitionEventId: string;
  amount: string;
  costBasis: string;
  acquiredAt: number;
};

type AveragePool = {
  amount: string;
  cost: string;
};

type MatchResult = {
  matched: MatchedDisposal[];
  shortfalls: TaxEvent[];
};

/**
 * Groups events by assetId + partition key, sorts each group by timestamp,
 * and walks each group matching disposals against acquisitions using the
 * given method. Both the asset boundary and the partition boundary are
 * hard: a lot in another asset or another partition is never available to
 * a disposal, because crossing either produces a wrong-but-plausible cost
 * basis (REVIEW FOCUS 3).
 */
export const match = (
  events: TaxEvent[],
  method: MatchingMethod,
  partitionBy: (event: TaxEvent) => string,
): MatchResult => {
  const groups = new Map<string, { partition: string; events: TaxEvent[] }>();

  for (const event of events) {
    if (event.kind === 'income') {
      continue;
    }
    const partition = partitionBy(event);
    const key = `${event.assetId}\u0000${partition}`;
    const group = groups.get(key);
    if (group) {
      group.events.push(event);
    } else {
      groups.set(key, { partition, events: [event] });
    }
  }

  const matched: MatchedDisposal[] = [];
  const shortfalls: TaxEvent[] = [];

  for (const { partition, events: groupEvents } of groups.values()) {
    const sorted = [...groupEvents].sort(
      (a, b) => a.timestamp - b.timestamp || kindRank(a) - kindRank(b),
    );
    if (method === 'fifo') {
      matchFifo(sorted, partition, matched, shortfalls);
    } else {
      matchMovingAverage(sorted, partition, matched, shortfalls);
    }
  }

  return { matched, shortfalls };
};

const matchFifo = (
  events: TaxEvent[],
  partition: string,
  matched: MatchedDisposal[],
  shortfalls: TaxEvent[],
): void => {
  const lots: FifoLot[] = [];

  for (const event of events) {
    if (event.kind === 'acquisition') {
      if (event.value === undefined) {
        // Not a lot: never substitute zero for an unknown cost basis.
        continue;
      }
      lots.push({
        acquisitionEventId: event.sourceEventId,
        amount: event.amount,
        costBasis: event.value,
        acquiredAt: event.timestamp,
      });
      continue;
    }

    // event.kind === 'disposal'
    if (event.value === undefined) {
      shortfalls.push(event);
      continue;
    }

    let remainingToSell = event.amount;
    const consumed: ConsumedLot[] = [];

    while (!isZeroAmount(remainingToSell) && lots.length > 0) {
      const lot = lots[0];
      const takeAmount =
        compareAmounts(remainingToSell, lot.amount) <= 0
          ? remainingToSell
          : lot.amount;

      const takenCost =
        compareAmounts(takeAmount, lot.amount) === 0
          ? lot.costBasis
          : proportion(lot.costBasis, takeAmount, lot.amount);

      consumed.push({
        acquisitionEventId: lot.acquisitionEventId,
        amount: takeAmount,
        costBasis: takenCost,
        acquiredAt: lot.acquiredAt,
        heldDays: Math.floor((event.timestamp - lot.acquiredAt) / MS_PER_DAY),
      });

      lot.amount = subtractAmounts(lot.amount, takeAmount);
      lot.costBasis = subtractAmounts(lot.costBasis, takenCost);
      remainingToSell = subtractAmounts(remainingToSell, takeAmount);

      if (isZeroAmount(lot.amount)) {
        lots.shift();
      }
    }

    if (consumed.length === 0) {
      shortfalls.push(event);
      continue;
    }

    const amountMatched = subtractAmounts(event.amount, remainingToSell);
    const costBasis = consumed.reduce(
      (total, lot) => addAmounts(total, lot.costBasis),
      '0',
    );
    const proceeds =
      compareAmounts(amountMatched, event.amount) === 0
        ? event.value
        : proportion(event.value, amountMatched, event.amount);

    matched.push({
      disposalEventId: event.sourceEventId,
      assetId: event.assetId,
      venue: event.venue,
      amount: amountMatched,
      proceeds,
      timestamp: event.timestamp,
      consumed,
      costBasis,
      gain: subtractAmounts(proceeds, costBasis),
      partition,
    });

    if (!isZeroAmount(remainingToSell)) {
      shortfalls.push({ ...event, amount: remainingToSell });
    }
  }
};

const matchMovingAverage = (
  events: TaxEvent[],
  partition: string,
  matched: MatchedDisposal[],
  shortfalls: TaxEvent[],
): void => {
  const pool: AveragePool = { amount: '0', cost: '0' };

  for (const event of events) {
    if (event.kind === 'acquisition') {
      if (event.value === undefined) {
        continue;
      }
      pool.amount = addAmounts(pool.amount, event.amount);
      pool.cost = addAmounts(pool.cost, event.value);
      continue;
    }

    // event.kind === 'disposal'
    if (event.value === undefined) {
      shortfalls.push(event);
      continue;
    }

    if (isZeroAmount(pool.amount)) {
      shortfalls.push(event);
      continue;
    }

    const disposedAmount =
      compareAmounts(event.amount, pool.amount) <= 0
        ? event.amount
        : pool.amount;

    const costBasis =
      compareAmounts(disposedAmount, pool.amount) === 0
        ? pool.cost
        : proportion(pool.cost, disposedAmount, pool.amount);

    pool.amount = subtractAmounts(pool.amount, disposedAmount);
    pool.cost = subtractAmounts(pool.cost, costBasis);

    const proceeds =
      compareAmounts(disposedAmount, event.amount) === 0
        ? event.value
        : proportion(event.value, disposedAmount, event.amount);

    matched.push({
      disposalEventId: event.sourceEventId,
      assetId: event.assetId,
      venue: event.venue,
      amount: disposedAmount,
      proceeds,
      timestamp: event.timestamp,
      consumed: [
        {
          acquisitionEventId: 'pool',
          amount: disposedAmount,
          costBasis,
          acquiredAt: event.timestamp,
          heldDays: 0,
        },
      ],
      costBasis,
      gain: subtractAmounts(proceeds, costBasis),
      partition,
    });

    const unmatched = subtractAmounts(event.amount, disposedAmount);
    if (!isZeroAmount(unmatched)) {
      shortfalls.push({ ...event, amount: unmatched });
    }
  }
};
