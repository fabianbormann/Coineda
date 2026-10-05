import type { LedgerEvent } from './types';

/**
 * Transfers between the user's OWN venues, recognised across sources.
 *
 * `isInternalTransfer` already handles the case that lives inside one
 * event: a UTXO self-send whose legs all sit at owned venues and net to
 * zero. It cannot see the case that spans two:
 *
 *     Bitpanda event:  out 0.5 BTC @ bitpanda      (tx 9f3c…)
 *     Bitcoin event:   in  0.4999 BTC @ bc1q…      (tx 9f3c…)
 *
 * Separately, the first is a disposal and the second an acquisition from
 * nowhere. Together they are one movement that sold nothing.
 *
 * Matched on the ON-CHAIN TRANSACTION HASH and nothing else. No amount
 * windows, no time proximity, no fuzzy matching - this feeds a tax report,
 * and a heuristic that paired the wrong two events would hide a real
 * disposal, which is the single most expensive mistake available here. A
 * hash identifies exactly one transaction, so a pair sharing one is the
 * same movement by construction.
 *
 * The rule is deliberately safe in the direction that matters. Paying a
 * third party produces an owned OUT leg and no owned IN leg - the
 * counterparty's venue is never emitted, by module contract - so nothing
 * pairs and it stays a disposal. Only a movement that both LEAVES and
 * ARRIVES at venues the user owns is internal.
 *
 * Net-zero is NOT required, unlike the single-event test. The difference
 * between the two sides is the network fee, which really did leave the
 * user's control; requiring the sides to balance would reject every real
 * withdrawal, since no chain delivers quite what was sent.
 */
export type TransferLink = {
  assetId: string;
  /** The event that moved value OUT of an owned venue. */
  fromEventId: string;
  fromVenue: string;
  /** The event that received it at another owned venue. */
  toEventId: string;
  toVenue: string;
  /** The amount that ARRIVED. The difference from what left is the network
   *  fee, and the arriving side is what the destination actually holds. */
  amount: string;
  txHash: string;
  timestamp: number;
};

const ownedPrincipals = (event: LedgerEvent, ownedVenues: Set<string>) =>
  event.legs.filter(
    (leg) => leg.role === 'principal' && ownedVenues.has(leg.venue),
  );

export const linkInternalTransfers = (
  events: LedgerEvent[],
  ownedVenues: Set<string>,
): TransferLink[] => {
  const byHash = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const hash = event.txHash;
    if (hash === undefined || hash === '') {
      continue;
    }
    const group = byHash.get(hash);
    if (group) {
      group.push(event);
    } else {
      byHash.set(hash, [event]);
    }
  }

  const links: TransferLink[] = [];

  for (const [txHash, group] of byHash) {
    if (group.length < 2) {
      // One event for a hash is an ordinary on-chain movement, whatever
      // direction it went. Nothing to pair it with.
      continue;
    }

    // Per asset, because one transaction can move more than one.
    const assets = new Set(
      group.flatMap((event) =>
        ownedPrincipals(event, ownedVenues).map((leg) => leg.assetId),
      ),
    );

    for (const assetId of assets) {
      const sent = group.find((event) =>
        ownedPrincipals(event, ownedVenues).some(
          (leg) => leg.assetId === assetId && leg.direction === 'out',
        ),
      );
      const received = group.find((event) =>
        ownedPrincipals(event, ownedVenues).some(
          (leg) => leg.assetId === assetId && leg.direction === 'in',
        ),
      );

      // Both sides must exist, and they must be DIFFERENT events. One event
      // holding both directions is the single-event case, which
      // `isInternalTransfer` already decides - and decides more strictly,
      // on the net, because a UTXO change output makes "has both" true for
      // an ordinary outbound payment.
      if (
        sent === undefined ||
        received === undefined ||
        sent.id === received.id
      ) {
        continue;
      }

      const arriving = ownedPrincipals(received, ownedVenues).find(
        (leg) => leg.assetId === assetId && leg.direction === 'in',
      );
      const leaving = ownedPrincipals(sent, ownedVenues).find(
        (leg) => leg.assetId === assetId && leg.direction === 'out',
      );
      if (arriving === undefined || leaving === undefined) {
        continue;
      }

      links.push({
        assetId,
        fromEventId: sent.id,
        fromVenue: leaving.venue,
        toEventId: received.id,
        toVenue: arriving.venue,
        amount: arriving.amount,
        txHash,
        // The arrival's time: the destination holds it from then, and
        // ordering the move before the receipt would let a disposal at the
        // destination match a lot that had not landed yet.
        timestamp: received.timestamp,
      });
    }
  }

  return links;
};

/** Every event id that is one side of a linked transfer. */
export const linkedEventIds = (links: TransferLink[]): Set<string> =>
  new Set(links.flatMap((link) => [link.fromEventId, link.toEventId]));
