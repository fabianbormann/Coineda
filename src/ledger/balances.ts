import {
  addAmounts,
  compareAmounts,
  isZeroAmount,
  negateAmount,
  subtractAmounts,
} from './amount';
import type { Leg, LedgerEvent } from './types';

export type Holding = { assetId: string; amount: string };

/**
 * Every leg's venue, trusted wholesale.
 *
 * There is no independent way to know, from the host side, which value a
 * module used for `leg.venue` - a chain module typically uses the
 * configured address, an exchange module whatever it can derive from its
 * own credentials, and the host never sees that mapping directly (see the
 * module contract in src/sources/types.ts: `fetchEvents` takes only
 * `config` and a cursor). Everything already sitting in this device's own
 * ledger came from this device's own configured sources or from the
 * user's own authored entries, so every venue it names is trusted as
 * owned. This is the same trust boundary `isInternalTransfer` already
 * leans on one leg at a time; here it is just applied to the whole log at
 * once to build the set `foldHoldings` and `isInternalTransfer`'s callers
 * need.
 *
 * Shared by `MainScreen` and `runTaxReport` - two independent "fold the
 * whole log into a set of owned venues" needs is the line past which a
 * local helper becomes a duplicated one.
 */
export const ownedVenuesOf = (events: LedgerEvent[]): Set<string> => {
  const venues = new Set<string>();
  for (const event of events) {
    for (const leg of event.legs) {
      venues.add(leg.venue);
    }
  }
  return venues;
};

/**
 * Holdings are folded from the log, never stored.
 *
 * A second, persisted copy updated incrementally on ingest would be faster to
 * read and would drift from the truth the first time the updater had a bug -
 * and a silently wrong balance is the worst failure this app has, because it
 * feeds a tax report. Folding a few thousand events is milliseconds.
 */
export const foldHoldings = (
  events: LedgerEvent[],
  ownedVenues: Set<string>,
): Holding[] => {
  const totals = new Map<string, string>();

  for (const event of events) {
    for (const leg of event.legs) {
      // A leg at a venue we do not own is the counterparty's side of the
      // movement; it never belongs in our holdings.
      if (!ownedVenues.has(leg.venue)) {
        continue;
      }
      const current = totals.get(leg.assetId) ?? '0';
      totals.set(
        leg.assetId,
        leg.direction === 'in'
          ? addAmounts(current, leg.amount)
          : subtractAmounts(current, leg.amount),
      );
    }
  }

  return [...totals.entries()]
    .filter(([, amount]) => !isZeroAmount(amount))
    .map(([assetId, amount]) => ({ assetId, amount }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
};

// Deliberately not memoised. The spec sketches a projection cached against
// the event count and last id; that is a performance fix for a problem
// nobody has measured yet, and a stale cache keyed on a proxy for "the log
// changed" is its own correctness risk. Fold on read until a real ledger is
// slow enough to prove otherwise.

/**
 * True when a transfer moved value between the user's own venues and
 * disposed of nothing: every principal leg sits at an owned venue AND, for
 * every asset, the net across those legs is exactly zero.
 *
 * A chain cannot tell us which addresses are the user's. Adding a wallet as a
 * source is the assertion of ownership, which is why ownedVenues is passed in
 * rather than inferred.
 *
 * NET, not leg presence. Deciding this from "an owned out-leg and an owned
 * in-leg both exist" is wrong on every UTXO chain, because the change
 * output returns to the sender: a genuine outbound payment of 102 appears
 * as `out 500 @ ownAddr` plus `in 398 @ ownAddr`, which has an owned leg on
 * each side and would be classified internal - hiding a real disposal from
 * the tax input. Against the recorded preprod fixtures that predicate
 * classified 20 of 33 events internal and found no disposals at all. The
 * only thing that distinguishes a payment from a move between the user's
 * own wallets is whether the value that left owned venues came back to
 * them, which is the per-asset net.
 *
 * The net test also subsumes the single-leg case: a lone `out 10` nets
 * negative, so it needs no separate check.
 *
 * Amounts are netted with the decimal-string helpers in
 * src/ledger/amount.ts. A float net would call two 18-decimal legs
 * differing in their last digit equal and classify the difference away.
 *
 * Two deliberate consequences:
 *
 * - **Fee legs stay out of the test.** A fee is paid to the network, not to
 *   a venue we own, so including it would make every internal move net
 *   negative and look external. `foldHoldings` still charges it.
 * - **An implicit chain fee is reported as a disposal, and that is
 *   correct.** On a UTXO chain the network fee is the input/output
 *   difference, never a leg of its own - `cardano-yaci` emits principal
 *   legs only. So even a pure self-send nets a small negative equal to the
 *   fee and is classified as a disposal of that amount. The fee really did
 *   leave the user's control, so this is the right answer, not a rounding
 *   artefact to special-case away. Do not "fix" it by treating a small net
 *   as zero: there is no threshold that can tell a fee from a small
 *   payment, and tests/balances.test.ts pins this behaviour.
 */
export const isInternalTransfer = (
  event: LedgerEvent,
  ownedVenues: Set<string>,
): boolean => {
  if (event.kind !== 'transfer') {
    return false;
  }
  const principals = event.legs.filter((leg) => leg.role === 'principal');
  const allOwned =
    principals.length > 0 &&
    principals.every((leg) => ownedVenues.has(leg.venue));
  if (!allOwned) {
    return false;
  }

  const net = new Map<string, string>();
  for (const leg of principals) {
    const current = net.get(leg.assetId) ?? '0';
    net.set(
      leg.assetId,
      leg.direction === 'in'
        ? addAmounts(current, leg.amount)
        : subtractAmounts(current, leg.amount),
    );
  }
  // Per asset, not summed across assets: a spend that returns the full
  // lovelace change while sending a native token away nets zero on one
  // asset and negative on the other, and is a disposal.
  return [...net.values()].every((amount) => isZeroAmount(amount));
};

/**
 * One event's owned principal legs collapsed to their per-asset net.
 *
 * The companion to `isInternalTransfer`, and the reason it has to exist.
 * That predicate decides internal-versus-disposal on the per-asset NET, but
 * it answers only yes or no - so a host that used it purely as a filter
 * handed the surviving event's RAW legs on to a tax module, which maps every
 * leg to its own tax event. On a UTXO chain that is catastrophic: a
 * transaction whose inputs are 19,997.637 ADA and outputs 19,997.452 ADA
 * disposed of 0.185 ADA in fees, but leg-by-leg it reads as a disposal of
 * 19,997.637 plus a re-acquisition of 19,997.452. Every transaction then
 * realises the wallet's whole unrealised gain and restarts any
 * holding-period clock, which puts an exemption like Germany's §23 one-year
 * rule permanently out of reach for a wallet that transacts at all.
 *
 * The net is the same quantity `isInternalTransfer` tests, computed once so
 * the two cannot disagree: a zero net here is exactly the event that
 * predicate calls internal.
 *
 * Three deliberate properties:
 *
 * - **Per asset, never summed across assets.** A swap sends one asset out
 *   and brings a different one in; those must stay a disposal AND an
 *   acquisition, because they are different assets. Only legs of the SAME
 *   asset cancel.
 * - **Owned venues only.** A leg at a venue we do not own is the
 *   counterparty's side of the movement - the same reason `foldHoldings`
 *   skips it. Netting it in would cancel a genuine outbound payment (`out
 *   500 @ ours`, `in 500 @ theirs`) to nothing and hide the disposal
 *   entirely.
 * - **Fee legs pass through untouched.** A fee goes to the network, not to
 *   a venue we own, so it is not part of the principal net - exactly as
 *   `isInternalTransfer` already has it. It survives as its own leg, so a
 *   jurisdiction still sees it.
 *
 * The net leg inherits the venue of the first same-asset leg pointing the
 * same way as the net, so a per-venue partition (Germany's per-wallet FIFO)
 * attributes the disposal to the venue the value actually left from.
 */
export const netPrincipalLegs = (
  event: LedgerEvent,
  ownedVenues: Set<string>,
): LedgerEvent => {
  const principals = event.legs.filter(
    (leg) => leg.role === 'principal' && ownedVenues.has(leg.venue),
  );
  const others = event.legs.filter(
    (leg) => leg.role !== 'principal' || !ownedVenues.has(leg.venue),
  );

  // Insertion order, not Map iteration luck: the legs a jurisdiction sees
  // should follow the order the event itself presented them in, so a
  // report's rows stay stable across runs.
  const assetOrder: string[] = [];
  const nets = new Map<string, string>();
  for (const leg of principals) {
    const current = nets.get(leg.assetId);
    if (current === undefined) {
      assetOrder.push(leg.assetId);
    }
    nets.set(
      leg.assetId,
      leg.direction === 'in'
        ? addAmounts(current ?? '0', leg.amount)
        : subtractAmounts(current ?? '0', leg.amount),
    );
  }

  const netted: Leg[] = [];
  for (const assetId of assetOrder) {
    const net = nets.get(assetId) ?? '0';
    // A zero net moved nothing for this asset: no disposal, and no
    // acquisition either. Emitting a zero-amount leg instead would give a
    // jurisdiction a tax event with nothing in it.
    if (isZeroAmount(net)) {
      continue;
    }
    const direction = compareAmounts(net, '0') > 0 ? 'in' : 'out';
    const sameAsset = principals.filter((leg) => leg.assetId === assetId);
    const source =
      sameAsset.find((leg) => leg.direction === direction) ?? sameAsset[0];
    netted.push({
      assetId,
      amount: direction === 'in' ? net : negateAmount(net),
      direction,
      venue: source.venue,
      role: 'principal',
    });
  }

  return { ...event, legs: [...netted, ...others] };
};

/**
 * Fiat assets use the reserved 'fiat:' chain prefix - 'fiat:eur', 'fiat:usd'.
 * Disposing of fiat to buy crypto is not a disposal of crypto, so the
 * disposal predicate has to tell the two apart, and the convention needs to
 * live in one named place rather than as a literal inside a filter.
 */
export const isFiatAsset = (assetId: string): boolean =>
  assetId.startsWith('fiat:');

/**
 * The events a tax calculation should consider disposals. Internal transfers
 * are excluded; treating them as sales is the single most expensive modelling
 * mistake available here. A fiat out-leg - a buy's payment side, or a bank
 * withdrawal - is excluded too: spending or withdrawing euros disposes of no
 * crypto, and foldHoldings still tracks the fiat balance itself.
 */
export const foldDisposals = (
  events: LedgerEvent[],
  ownedVenues: Set<string>,
): LedgerEvent[] =>
  events.filter((event) => {
    if (isInternalTransfer(event, ownedVenues)) {
      return false;
    }
    return event.legs.some(
      (leg) =>
        leg.direction === 'out' &&
        leg.role === 'principal' &&
        ownedVenues.has(leg.venue) &&
        !isFiatAsset(leg.assetId),
    );
  });
