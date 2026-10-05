import Big from 'big.js';
import { normaliseAmount } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import { ASSET_DECIMALS, NIGHT_ASSET_ID } from '@/prices/scale';

/**
 * Bitpanda symbol to Coineda asset id.
 *
 * Deliberately short. Bitpanda offers 880 symbols - including gold, silver,
 * platinum and palladium, and a long tail of coins - and a symbol is
 * ambiguous across chains, so guessing merges two different assets into one
 * position silently. Only symbols that can be stated with certainty AND that
 * the rest of the app can already scale and price appear here; every other
 * holding is reported as unsupported rather than stored wrong.
 *
 * Adding one means adding its ASSET_DECIMALS entry in the same commit, which
 * `baseUnits` below enforces rather than trusts.
 */
export const BITPANDA_ASSETS: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
  // Stated with certainty rather than inferred: the owner's account holds
  // NIGHT, and the id below is its Cardano policy plus asset name, resolved
  // through CoinGecko's own platform record. Mapping the TICKER would have
  // been wrong - CoinGecko lists two different coins as NIGHT.
  NIGHT: NIGHT_ASSET_ID,
};

export const assetIdForSymbol = (symbol: string): string | null =>
  BITPANDA_ASSETS[symbol.trim().toUpperCase()] ?? null;

/** Thrown rather than returned, because every caller is mid-drain and there
 *  is no sensible amount to carry on with. */
export class UnscalableAmountError extends Error {
  constructor(assetId: string) {
    super(
      `bitpanda: no decimals are known for ${assetId}, so its amount cannot be stored`,
    );
    this.name = 'UnscalableAmountError';
  }
}

/**
 * Converts an exchange amount in WHOLE units to the base units the ledger
 * stores.
 *
 * This is the one place that conversion happens, and it is the most
 * dangerous line in an exchange module. A chain reports base units -
 * lovelace, satoshis - and the ledger stores them, which is why every amount
 * in this codebase is a base-unit decimal string. An exchange does not: a
 * Bitpanda balance of 0.5 BTC is 50000000 satoshis, and storing `0.5`
 * understates the position by a factor of one hundred million.
 *
 * This exact class of bug has threatened this codebase three times now -
 * lovelace priced as whole ADA, satoshis priced as whole bitcoin, and now
 * whole units stored as base units - so the asset's decimals are REQUIRED
 * here rather than defaulted. `decimalsOf` answers 0 for an unknown asset,
 * which is the right answer at the pricing boundary and a silent corruption
 * at this one: it would store a whole-unit figure as though it were already
 * scaled, and nothing downstream could tell.
 *
 * Decimal strings throughout, via Big: the scale factor for ETH is 10^18,
 * well past what a JS number holds exactly.
 */
export const baseUnits = (whole: string, assetId: string): string => {
  const fiat = isFiatAsset(assetId);
  const decimals = fiat ? 0 : ASSET_DECIMALS[assetId];
  if (decimals === undefined) {
    throw new UnscalableAmountError(assetId);
  }

  const trimmed = whole.trim();
  if (trimmed === '' || !/^-?\d*\.?\d+$/.test(trimmed)) {
    throw new Error(
      `bitpanda: expected a decimal amount but got '${whole}' for ${assetId}`,
    );
  }

  const scaled = new Big(trimmed).times(new Big(`1${'0'.repeat(decimals)}`));

  // Fiat keeps its fractional part; crypto does not have one left.
  //
  // A euro is stored as a decimal with cents - this ledger has no sub-unit
  // for fiat - so rounding here would quietly drop them, and a report that
  // loses a cent per trade is a report nobody can reconcile. A crypto amount
  // past its own smallest unit is a different thing: an exchange can quote
  // more precision than the chain has, and the fraction of a satoshi left
  // over cannot be represented or spent.
  return normaliseAmount(fiat ? scaled.toString() : scaled.toFixed(0));
};
