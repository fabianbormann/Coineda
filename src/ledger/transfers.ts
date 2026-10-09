import {
  addAmounts,
  compareAmounts,
  subtractAmounts,
  sumAmounts,
} from './amount';
import { netPrincipalLegs } from './balances';
import type { LedgerEvent, Leg, LegDirection } from './types';

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

/** An event's owned principal legs netted per asset (see
 *  `netPrincipalLegs`): at most one leg per asset, pointing the way the
 *  event moved that asset on balance. UTXO change is already subtracted. */
const netOwnedPrincipals = (
  event: LedgerEvent,
  ownedVenues: Set<string>,
): Leg[] =>
  netPrincipalLegs(event, ownedVenues).legs.filter(
    (leg) => leg.role === 'principal' && ownedVenues.has(leg.venue),
  );

type Side = { event: LedgerEvent; leg: Leg };

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

    const netted = group.map((event) => ({
      event,
      legs: netOwnedPrincipals(event, ownedVenues),
    }));

    // Per asset, because one transaction can move more than one.
    const assets = new Set(
      netted.flatMap(({ legs }) => legs.map((leg) => leg.assetId)),
    );

    for (const assetId of assets) {
      // Sender and receiver are decided on each event's NET for the asset,
      // never on whether it has a leg pointing some way. A UTXO sender's
      // change output is an owned `in` leg, so "has an in leg" used to pick
      // the sender as its own receiver whenever its id sorted first - and
      // the guard against pairing an event with itself then linked
      // nothing, leaving roughly half of real wallet-to-wallet sends as a
      // disposal and an acquisition at market. An event that nets to zero
      // for the asset (a self-send, which `isInternalTransfer` decides) is
      // neither side, so an event can never be paired with itself.
      const senders: Side[] = [];
      const receivers: Side[] = [];
      for (const { event, legs } of netted) {
        const leg = legs.find((one) => one.assetId === assetId);
        if (leg === undefined) {
          continue;
        }
        if (leg.direction === 'out') {
          senders.push({ event, leg });
        } else {
          receivers.push({ event, leg });
        }
      }

      // Exactly one sender. Several events netting out on one hash is
      // ambiguous - which of them fed which receipt is not something a
      // hash can say - so nothing is linked rather than guessed.
      if (senders.length !== 1 || receivers.length === 0) {
        continue;
      }
      const [sender] = senders;

      // One link per receiver, each carrying what THAT receiver netted: a
      // receipt split across two owned wallets moves both halves, rather
      // than one half moving and the other being realised as a disposal at
      // the sender and an acquisition at market.
      for (const receiver of receivers) {
        links.push({
          assetId,
          fromEventId: sender.event.id,
          fromVenue: sender.leg.venue,
          toEventId: receiver.event.id,
          toVenue: receiver.leg.venue,
          amount: receiver.leg.amount,
          txHash,
          // The arrival's time: the destination holds it from then, and
          // ordering the move before the receipt would let a disposal at
          // the destination match a lot that had not landed yet.
          timestamp: receiver.event.timestamp,
        });
      }
    }
  }

  return links;
};

/** Every event id that is one side of a linked transfer. */
export const linkedEventIds = (links: TransferLink[]): Set<string> =>
  new Set(links.flatMap((link) => [link.fromEventId, link.toEventId]));

/** The amount of `assetId` moving in `direction` across these legs,
 *  optionally only those of one role. */
const sumLegs = (
  legs: Leg[],
  assetId: string,
  direction: LegDirection,
  role?: Leg['role'],
): string =>
  sumAmounts(
    legs
      .filter(
        (leg) =>
          leg.assetId === assetId &&
          leg.direction === direction &&
          (role === undefined || leg.role === role),
      )
      .map((leg) => leg.amount),
  );

/**
 * What a linked transfer consumed: the coins that left one of the user's
 * venues and never arrived at the other.
 *
 * `linkInternalTransfers` pairs a withdrawal with its receipt and the host
 * replaces the pair with a lot move of the ARRIVED amount. The difference -
 * an explicit fee leg on an exchange withdrawal, the fee a UTXO chain hides
 * in inputs minus change, gas paid in another asset on the same
 * transaction - used to stay in the source partition as a phantom holding,
 * or vanish with the dropped event. It really did leave the user's control,
 * so it is returned here as a synthetic `transfer` event with one `out` leg
 * per asset, for the jurisdiction to classify like any other outgoing leg:
 * a disposal at market value, in the venue it left. Symmetrically, anything
 * that arrived in a linked receipt beyond what the link carried becomes an
 * `in` leg. Nothing here deducts anything: a network fee on a move to
 * oneself is not a selling cost (owner's decision, 2026-10-09).
 *
 * Per asset, per linked event: residualOut = netOut + explicitFees −
 * arrivedByLink, residualIn = netIn − arrivedByLink. `netPrincipalLegs`
 * supplies the net so UTXO change is already subtracted. Only positive
 * residuals are emitted; an event with none produces nothing.
 */
export const residualTransferEvents = (
  events: LedgerEvent[],
  links: TransferLink[],
  ownedVenues: Set<string>,
): LedgerEvent[] => {
  const byId = new Map(events.map((event) => [event.id, event]));

  // Per (event, direction): how much of each asset the links carried.
  const carried = new Map<string, Map<string, string>>();
  const record = (
    eventId: string,
    direction: LegDirection,
    assetId: string,
    amount: string,
  ) => {
    const key = `${eventId}|${direction}`;
    const perAsset = carried.get(key) ?? new Map<string, string>();
    perAsset.set(assetId, addAmounts(perAsset.get(assetId) ?? '0', amount));
    carried.set(key, perAsset);
  };
  for (const link of links) {
    record(link.fromEventId, 'out', link.assetId, link.amount);
    record(link.toEventId, 'in', link.assetId, link.amount);
  }

  const residuals: LedgerEvent[] = [];
  for (const [key, perAsset] of carried) {
    const [eventId, direction] = key.split('|') as [string, LegDirection];
    const original = byId.get(eventId);
    if (original === undefined) {
      continue;
    }
    const netted = netPrincipalLegs(original, ownedVenues);
    const assets = [...new Set(original.legs.map((leg) => leg.assetId))];

    const legs: Leg[] = [];
    for (const assetId of assets) {
      const net = sumLegs(netted.legs, assetId, direction, 'principal');
      const fees =
        direction === 'out'
          ? sumLegs(original.legs, assetId, 'out', 'fee')
          : '0';
      const residual = subtractAmounts(
        addAmounts(net, fees),
        perAsset.get(assetId) ?? '0',
      );
      if (compareAmounts(residual, '0') <= 0) {
        continue;
      }
      const venue =
        original.legs.find(
          (leg) => leg.assetId === assetId && leg.direction === direction,
        )?.venue ?? original.legs[0].venue;
      legs.push({
        assetId,
        amount: residual,
        direction,
        venue,
        role: 'principal',
      });
    }
    if (legs.length === 0) {
      continue;
    }

    residuals.push({
      id: `${original.id}:residual-${direction}`,
      sourceId: original.sourceId,
      externalId: `${original.externalId}:residual-${direction}`,
      timestamp: original.timestamp,
      kind: 'transfer',
      origin: 'derived',
      legs,
      ...(original.txHash === undefined ? {} : { txHash: original.txHash }),
    });
  }

  return residuals;
};
