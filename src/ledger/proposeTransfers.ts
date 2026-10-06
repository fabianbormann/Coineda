import Big from 'big.js';
import { netPrincipalLegs } from './balances';
import type { LedgerEvent } from './types';

/**
 * Candidate pairs for a transfer whose two sides cannot be matched exactly.
 *
 * `linkInternalTransfers` pairs on the on-chain transaction hash, which is
 * exact. Some sources simply do not report one: Kraken's ledger export has
 * columns for its OWN id and nothing for the chain's, and no address
 * either. So a withdrawal to your own wallet arrives as two events with no
 * shared key, and the tax engine sees a disposal.
 *
 * What this does NOT do is decide. It proposes, with its reasoning
 * attached, and a person confirms - and the confirmation records the chain
 * hash, so from then on the ordinary exact path handles the pair. A
 * heuristic that silently reclassified would hide a real disposal, and
 * that is the most expensive mistake available in this program.
 *
 * The signals are deliberately weak ones used together:
 *
 * - Same asset, opposite direction, at two venues the user owns.
 * - Amounts close. They are NOT equal: a deposit differs from what the
 *   wallet sent by the miner fee, because the chain module books raw
 *   inputs and outputs and the fee is their difference. A withdrawal
 *   usually matches to the digit, since the exchange pays the network out
 *   of its own fee.
 * - Close in time. A confirmation takes minutes to hours, never weeks.
 */
export type TransferProposal = {
  /** The event with no hash - the exchange side. */
  unlinkedEventId: string;
  /** The chain event it appears to be the other half of. */
  chainEventId: string;
  /** The hash confirming would record against the exchange row. */
  txHash: string;
  assetId: string;
  /** Absolute difference between the two amounts, in base units - the
   *  network fee, if this pair is real. */
  difference: string;
  /** How far apart in milliseconds. */
  apart: number;
};

/** How far apart two sides may sit. Generous on purpose: a confirmation can
 *  be slow, and ranking by closeness matters more than a tight cap. */
export const MAX_APART_MS = 72 * 3_600_000;

/**
 * How much the two amounts may differ, as a fraction of the larger.
 *
 * One percent. A Bitcoin miner fee on an ordinary transfer is a few
 * thousandths of a typical amount, and an exchange withdrawal fee is of the
 * same order. Wider than this stops being "the same money minus a fee" and
 * starts matching unrelated movements of a similar size.
 */
export const MAX_RELATIVE_DIFFERENCE = 0.01;

/**
 * Each event's net movement per asset, through the very same function the
 * tax engine nets with.
 *
 * Reusing `netPrincipalLegs` rather than netting again here is deliberate:
 * a UTXO transaction's raw legs are its inputs and change outputs, so a
 * withdrawal of 0.075 appears as `out 0.4` and `in 0.325`, and matching on
 * raw legs would compare the wrong numbers. A second implementation of the
 * netting rule could also drift from the one the report acts on, and then
 * this list would propose pairs the engine does not see.
 */
const netByAsset = (
  event: LedgerEvent,
  ownedVenues: Set<string>,
): Map<string, Big> => {
  const nets = new Map<string, Big>();
  for (const leg of netPrincipalLegs(event, ownedVenues).legs) {
    if (leg.role !== 'principal') {
      continue;
    }
    nets.set(
      leg.assetId,
      leg.direction === 'in' ? new Big(leg.amount) : new Big(leg.amount).neg(),
    );
  }
  return nets;
};

/**
 * Pairs that look like one movement, best first.
 *
 * `linked` names events already accounted for - by an exact hash match or
 * by an earlier confirmation - so a side is never offered twice.
 */
export const proposeTransfers = (
  events: LedgerEvent[],
  ownedVenues: Set<string>,
  linked: Set<string> = new Set(),
): TransferProposal[] => {
  const nets = new Map(
    events.map((event) => [event.id, netByAsset(event, ownedVenues)]),
  );

  // The side that cannot be matched: a transfer with no hash of its own.
  // Trades are excluded - a trade is not a movement between venues, and
  // offering one would invite confirming something that is genuinely a
  // disposal.
  const unlinked = events.filter(
    (event) =>
      !linked.has(event.id) &&
      event.kind === 'transfer' &&
      (event.txHash === undefined || event.txHash === ''),
  );
  const onChain = events.filter(
    (event) =>
      !linked.has(event.id) &&
      typeof event.txHash === 'string' &&
      event.txHash !== '',
  );

  const proposals: TransferProposal[] = [];

  for (const exchange of unlinked) {
    for (const [assetId, exchangeNet] of nets.get(exchange.id) ?? []) {
      if (exchangeNet.eq(0)) {
        continue;
      }
      for (const chain of onChain) {
        const chainNet = nets.get(chain.id)?.get(assetId);
        if (chainNet === undefined || chainNet.eq(0)) {
          continue;
        }
        // Opposite directions, or it is not one movement.
        if (exchangeNet.gt(0) === chainNet.gt(0)) {
          continue;
        }
        const apart = Math.abs(exchange.timestamp - chain.timestamp);
        if (apart > MAX_APART_MS) {
          continue;
        }
        const a = exchangeNet.abs();
        const b = chainNet.abs();
        const larger = a.gt(b) ? a : b;
        const difference = a.minus(b).abs();
        if (
          larger.eq(0) ||
          difference.div(larger).gt(MAX_RELATIVE_DIFFERENCE)
        ) {
          continue;
        }
        proposals.push({
          unlinkedEventId: exchange.id,
          chainEventId: chain.id,
          txHash: chain.txHash!,
          assetId,
          difference: difference.toFixed(0),
          apart,
        });
      }
    }
  }

  // Closest in amount first, then in time: the fee difference is the more
  // telling of the two, because two unrelated movements of nearly the same
  // size are rarer than two movements minutes apart.
  return proposals.sort(
    (a, b) =>
      new Big(a.difference).cmp(new Big(b.difference)) || a.apart - b.apart,
  );
};
