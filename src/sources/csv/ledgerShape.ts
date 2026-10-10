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
    reason?: string,
  ) {
    super(
      reason ??
        `${importer}: no decimals are known for ${assetId}, so its amount cannot be stored`,
    );
    this.name = 'UnscalableAmountError';
  }
}

export class AmbiguousDecimalError extends Error {
  constructor(readonly value: string) {
    super(
      `'${value}' has both '.' and ',', so which is the decimal separator cannot be told`,
    );
    this.name = 'AmbiguousDecimalError';
  }
}

/**
 * Turns a decimal-comma amount ('0,5', '1 234,5') into a decimal-point one.
 * Both separators together are refused: '1.234,5' and '1,234.5' look alike
 * and guessing wrong is a thousandfold error.
 */
export const normaliseDecimal = (value: string): string => {
  const stripped = value.replace(/\s/g, '');
  const hasDot = stripped.includes('.');
  const hasComma = stripped.includes(',');
  const count = (char: string) => stripped.split(char).length - 1;
  if ((hasDot && hasComma) || count(',') > 1 || count('.') > 1) {
    throw new AmbiguousDecimalError(value);
  }
  return hasComma ? stripped.replace(',', '.') : stripped;
};

const THOUSANDS_GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * Removes commas only where they are unmistakably thousands groups
 * ('1,234.5', '12,345,678'). Any other comma ('0,01', '1,5', '12,345,6') is
 * a decimal comma or garbage, and stripping it would turn a hundredth into
 * a whole: the answer is `undefined`, and the caller refuses the value.
 */
export const stripThousands = (value: string): string | undefined => {
  if (!value.includes(',')) {
    return value;
  }
  return THOUSANDS_GROUPED.test(value) ? value.replace(/,/g, '') : undefined;
};

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

  const trimmed = stripThousands(whole.trim());
  if (trimmed === undefined || !/^-?\d*\.?\d+$/.test(trimmed)) {
    throw new UnscalableAmountError(
      importer,
      assetId,
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
