import { isFiatAsset } from '@/ledger/balances';
import type { LedgerEvent } from '@/ledger/types';
import type { Consideration } from '@/tax/types';

/**
 * The fiat side of a trade, when there is exactly one: what was paid for
 * the crypto bought, or received for the crypto sold.
 *
 * Host code, not a jurisdiction's, because Germany (§23 EStG) and Austria
 * (§27a öEStG) agree that a sale against fiat is valued at the actual
 * proceeds. A module that disagrees simply does not call it.
 *
 * Returns undefined - "value the leg at market, as before" - for anything
 * that is not one fiat leg facing one crypto leg: a swap, a fiat-for-fiat
 * trade, a fiat leg facing two crypto legs, or two legs pointing the same
 * way (which is not an exchange of one for the other). Fee legs are not
 * sides; they ride on the event as `costs`.
 *
 * Pure and synchronous, like the classify functions that call it.
 */
export const fiatConsiderationOf = (
  event: LedgerEvent,
): Consideration | undefined => {
  const principals = event.legs.filter((leg) => leg.role === 'principal');
  const fiat = principals.filter((leg) => isFiatAsset(leg.assetId));
  const crypto = principals.filter((leg) => !isFiatAsset(leg.assetId));
  if (fiat.length !== 1 || crypto.length !== 1) {
    return undefined;
  }
  if (fiat[0].direction === crypto[0].direction) {
    return undefined;
  }
  return { assetId: fiat[0].assetId, amount: fiat[0].amount };
};
