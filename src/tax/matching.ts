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
  LotMove,
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
  moves: LotMove[] = [],
): MatchResult => {
  // Grouped by ASSET, with the partition resolved per event inside the
  // walk, rather than by asset+partition up front.
  //
  // That change is what makes a lot move possible at all: a move crosses
  // two partitions, so neither can be walked in isolation. Within one
  // asset every partition is walked together in timestamp order, each
  // keeping its own lots - so the partition boundary is exactly as hard as
  // before for everything except a move, which is the only thing allowed
  // to cross it.
  const groups = new Map<string, { events: TaxEvent[]; moves: LotMove[] }>();
  const groupFor = (assetId: string) => {
    const existing = groups.get(assetId);
    if (existing) {
      return existing;
    }
    const created = { events: [] as TaxEvent[], moves: [] as LotMove[] };
    groups.set(assetId, created);
    return created;
  };

  for (const event of events) {
    if (event.kind === 'income') {
      continue;
    }
    groupFor(event.assetId).events.push(event);
  }
  for (const move of moves) {
    groupFor(move.assetId).moves.push(move);
  }

  const matched: MatchedDisposal[] = [];
  const shortfalls: TaxEvent[] = [];

  for (const group of groups.values()) {
    const steps: Step[] = [
      ...group.events.map((event): Step => ({ kind: 'event', event })),
      ...group.moves.map((move): Step => ({ kind: 'move', move })),
    ].sort((a, b) => stepTime(a) - stepTime(b) || stepRank(a) - stepRank(b));

    if (method === 'fifo') {
      matchFifo(steps, partitionBy, matched, shortfalls);
    } else {
      matchMovingAverage(steps, partitionBy, matched, shortfalls);
    }
  }

  return { matched, shortfalls };
};

/** One thing that happens to an asset: an event a jurisdiction classified,
 *  or a move the host detected. */
type Step =
  { kind: 'event'; event: TaxEvent } | { kind: 'move'; move: LotMove };

const stepTime = (step: Step): number =>
  step.kind === 'event' ? step.event.timestamp : step.move.timestamp;

/**
 * The tie-break when two steps share a timestamp.
 *
 * Sorting on the timestamp alone leaves ties to Array.prototype.sort's
 * stability, which means to INSERTION order - and insertion order came
 * from the order the Cardano translator happens to build its legs in. A tax
 * result that depends on the call order inside an unrelated module is not a
 * result, and renaming those calls would silently change a cost basis.
 *
 * Acquisition, then move, then disposal. Value that arrived in the same
 * instant really was available to move, and value that moved in the same
 * instant was available to be sold at its destination - which is what the
 * user's balance did. Any other order reports a shortfall ("no acquisition
 * on record") for a disposal their holdings plainly covered. Statute has no
 * rule for an identical instant, so what matters is that the answer is the
 * same on every run.
 */
const stepRank = (step: Step): number =>
  step.kind === 'move' ? 1 : step.event.kind === 'acquisition' ? 0 : 2;

/** Lots per partition, created on first use. */
const lotsIn = (
  byPartition: Map<string, FifoLot[]>,
  partition: string,
): FifoLot[] => {
  const existing = byPartition.get(partition);
  if (existing) {
    return existing;
  }
  const created: FifoLot[] = [];
  byPartition.set(partition, created);
  return created;
};

/** The partition a move's two ends fall in, asked of the jurisdiction's own
 *  function rather than assumed to be the venue. Austria partitions by
 *  acquisition era, so both ends answer the same and the move is a no-op. */
const movePartitions = (
  move: LotMove,
  partitionBy: (event: TaxEvent) => string,
): { from: string; to: string } => {
  const base: TaxEvent = {
    sourceEventId: move.sourceEventId,
    kind: 'acquisition',
    assetId: move.assetId,
    amount: move.amount,
    timestamp: move.timestamp,
    venue: move.toVenue,
  };
  return {
    from: partitionBy({ ...base, venue: move.fromVenue }),
    to: partitionBy(base),
  };
};

const matchFifo = (
  steps: Step[],
  partitionBy: (event: TaxEvent) => string,
  matched: MatchedDisposal[],
  shortfalls: TaxEvent[],
): void => {
  const byPartition = new Map<string, FifoLot[]>();

  for (const step of steps) {
    if (step.kind === 'move') {
      const { from, to } = movePartitions(step.move, partitionBy);
      if (from === to) {
        // Nothing to do: the jurisdiction does not separate these two
        // venues, so the lot is already where it needs to be.
        continue;
      }
      const source = lotsIn(byPartition, from);
      const destination = lotsIn(byPartition, to);

      // Taken FIFO, and each piece keeps its OWN cost basis and acquisition
      // date. Those two are the whole point: a transfer between a person's
      // own wallets neither realises a gain nor restarts a holding period,
      // so re-dating the lot would make a coin held for two years look
      // freshly bought and turn a tax-free German disposal into a taxable
      // one.
      let remaining = step.move.amount;
      while (!isZeroAmount(remaining) && source.length > 0) {
        const lot = source[0];
        const take =
          compareAmounts(remaining, lot.amount) <= 0 ? remaining : lot.amount;
        const takenCost =
          compareAmounts(take, lot.amount) === 0
            ? lot.costBasis
            : proportion(lot.costBasis, take, lot.amount);

        destination.push({
          acquisitionEventId: lot.acquisitionEventId,
          amount: take,
          costBasis: takenCost,
          acquiredAt: lot.acquiredAt,
        });

        lot.amount = subtractAmounts(lot.amount, take);
        lot.costBasis = subtractAmounts(lot.costBasis, takenCost);
        remaining = subtractAmounts(remaining, take);
        if (isZeroAmount(lot.amount)) {
          source.shift();
        }
      }
      // A move the source cannot cover carries nothing further. It is not a
      // shortfall of its own - no disposal happened - and the destination
      // simply receives no lot, so a later disposal there reports "no
      // acquisition on record", which is the honest answer.
      continue;
    }

    const event = step.event;
    const partition = partitionBy(event);
    const lots = lotsIn(byPartition, partition);

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
  steps: Step[],
  partitionBy: (event: TaxEvent) => string,
  matched: MatchedDisposal[],
  shortfalls: TaxEvent[],
): void => {
  const byPartition = new Map<string, AveragePool>();
  const poolIn = (partition: string): AveragePool => {
    const existing = byPartition.get(partition);
    if (existing) {
      return existing;
    }
    const created: AveragePool = { amount: '0', cost: '0' };
    byPartition.set(partition, created);
    return created;
  };

  for (const step of steps) {
    if (step.kind === 'move') {
      const { from, to } = movePartitions(step.move, partitionBy);
      if (from === to) {
        // The usual case here: Austria partitions by acquisition era, not
        // by venue, so a move between two of the user's wallets lands in
        // the same pool and changes nothing.
        continue;
      }
      const source = poolIn(from);
      if (isZeroAmount(source.amount)) {
        continue;
      }
      const moved =
        compareAmounts(step.move.amount, source.amount) <= 0
          ? step.move.amount
          : source.amount;
      const cost =
        compareAmounts(moved, source.amount) === 0
          ? source.cost
          : proportion(source.cost, moved, source.amount);

      source.amount = subtractAmounts(source.amount, moved);
      source.cost = subtractAmounts(source.cost, cost);
      const destination = poolIn(to);
      destination.amount = addAmounts(destination.amount, moved);
      destination.cost = addAmounts(destination.cost, cost);
      continue;
    }

    const event = step.event;
    const partition = partitionBy(event);
    const pool = poolIn(partition);

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
