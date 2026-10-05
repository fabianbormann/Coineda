import Big from 'big.js';
import { normaliseAmount } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import { ASSET_DECIMALS } from '@/prices/scale';

/**
 * Kraken's asset codes to Coineda asset ids.
 *
 * Kraken keeps a legacy naming where the major assets carry an X or Z
 * prefix - verified against its own live /0/public/Assets: `XXBT` is
 * bitcoin with altname XBT, `XETH` is ether, `ZEUR` is the euro, and the
 * bare `XBT` and `ETH` are NOT asset codes at all, only altnames. An
 * importer matching on "BTC" or "XBT" therefore recognises nothing in a
 * real ledger export.
 *
 * Deliberately short, like the Bitpanda map it is modelled on. Kraken lists
 * 855 assets; a code this app cannot both scale and price is reported as
 * skipped rather than stored wrong.
 */
export const KRAKEN_ASSETS: Record<string, string> = {
  XXBT: 'bitcoin:native',
  XETH: 'eth:native',
  ADA: 'cardano:lovelace',
  ZEUR: 'fiat:eur',
};

/**
 * Kraken suffixes a code when the holding sits in one of its earn or
 * staking wallets: `ADA.S` is staked ADA, `ETH2.S` was staked ether,
 * `XBT.M` is the opt-in rewards wallet.
 *
 * The suffix names WHERE the asset is, not WHAT it is - which is why it is
 * stripped here and the ledger's `wallet` column becomes the leg's venue
 * instead. Treating `ADA.S` as a different asset would turn every move
 * between a user's own spot and staking wallets into a disposal of one
 * asset and an acquisition of another, inventing a taxable event out of a
 * transfer the user made to themselves.
 */
export const stripWalletSuffix = (code: string): string =>
  code.replace(/\.(S|M|B|F|P)\d*$/i, '');

export const assetIdForCode = (code: string): string | null =>
  KRAKEN_ASSETS[stripWalletSuffix(code.trim()).toUpperCase()] ?? null;

/** Thrown rather than returned: every caller is mid-parse and there is no
 *  sensible amount to carry on with. */
export class UnscalableAmountError extends Error {
  constructor(assetId: string) {
    super(
      `kraken-csv: no decimals are known for ${assetId}, so its amount cannot be stored`,
    );
    this.name = 'UnscalableAmountError';
  }
}

/**
 * Converts a Kraken amount in WHOLE units to the base units the ledger
 * stores.
 *
 * The most dangerous line in any exchange importer, and the same one the
 * Bitpanda module has. A chain reports base units and the ledger stores
 * them; an export does not. `0.01000000` in a Kraken ledger is one
 * hundredth of a bitcoin, and storing it verbatim understates the position
 * a hundred million fold.
 *
 * Decimals are REQUIRED here rather than defaulted. `decimalsOf` answers 0
 * for an unknown asset, which is right at the pricing boundary and a silent
 * corruption at this one.
 *
 * Kraken writes outflows as NEGATIVE amounts, so the sign is meaningful and
 * is preserved; the caller decides direction from it.
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
      `kraken-csv: expected a decimal amount but got '${whole}' for ${assetId}`,
    );
  }

  const scaled = new Big(trimmed).times(new Big(`1${'0'.repeat(decimals)}`));

  // Fiat keeps its fractional part; crypto has none left. A euro is stored
  // as a decimal with cents - this ledger has no sub-unit for fiat - so
  // rounding here would drop them, and a report losing a cent per row is
  // one nobody can reconcile. A crypto amount past its own smallest unit is
  // different: Kraken quotes more precision than the chain has, and the
  // fraction of a satoshi left over cannot be represented or spent.
  return normaliseAmount(fiat ? scaled.toString() : scaled.toFixed(0));
};
