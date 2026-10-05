import Big from 'big.js';
import { normaliseAmount } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import { ASSET_DECIMALS } from '@/prices/scale';

/**
 * The unit boundary every exchange importer crosses, in one place.
 *
 * Kraken, Binance and Coinbase all quote WHOLE units in their exports while
 * the ledger stores base units. `0.01` in any of those files is one
 * hundredth of a bitcoin, and storing it verbatim understates the position
 * a hundred million fold. This exact class of error has threatened this
 * codebase four times now, so the conversion lives in one tested function
 * rather than once per importer.
 *
 * Decimals are REQUIRED, never defaulted. `decimalsOf` answers 0 for an
 * unknown asset, which is the right answer at the pricing boundary and a
 * silent corruption at this one.
 */
export class UnscalableAmountError extends Error {
  constructor(
    readonly importer: string,
    assetId: string,
  ) {
    super(
      `${importer}: no decimals are known for ${assetId}, so its amount cannot be stored`,
    );
    this.name = 'UnscalableAmountError';
  }
}

export const toBaseUnits = (
  importer: string,
  whole: string,
  assetId: string,
): string => {
  const fiat = isFiatAsset(assetId);
  const decimals = fiat ? 0 : ASSET_DECIMALS[assetId];
  if (decimals === undefined) {
    throw new UnscalableAmountError(importer, assetId);
  }

  const trimmed = whole.trim().replace(/,/g, '');
  if (trimmed === '' || !/^-?\d*\.?\d+$/.test(trimmed)) {
    throw new Error(
      `${importer}: expected a decimal amount but got '${whole}' for ${assetId}`,
    );
  }

  const scaled = new Big(trimmed).times(new Big(`1${'0'.repeat(decimals)}`));

  // Fiat keeps its fractional part; crypto has none left. A euro is stored
  // as a decimal with cents, so rounding here would drop them and a report
  // losing a cent per row cannot be reconciled. A crypto amount past its
  // own smallest unit cannot be represented or spent.
  return normaliseAmount(fiat ? scaled.toString() : scaled.toFixed(0));
};

/**
 * Counts skipped rows by REASON rather than listing one line per row.
 *
 * An export can carry hundreds of rows in the same unsupported asset, and
 * three hundred identical sentences is not a report anybody reads - but a
 * silent drop is worse, because a user whose balance is short has no way to
 * find out why.
 */
export const makeSkipLog = () => {
  const counts = new Map<string, number>();
  return {
    note: (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1),
    lines: (): string[] =>
      [...counts.entries()].map(([reason, count]) =>
        count === 1 ? `Skipped ${reason}` : `Skipped ${count} ${reason}`,
      ),
  };
};
