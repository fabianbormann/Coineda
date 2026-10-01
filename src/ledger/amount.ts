import Big from 'big.js';

/**
 * Ledger amounts are decimal strings, never JS numbers.
 *
 * Two reasons, both load-bearing for a tool that feeds a tax report. An
 * 18-decimal token's base units exceed Number.MAX_SAFE_INTEGER, so a float
 * silently loses the low digits. And binary floats cannot represent most
 * decimal fractions, so folding a column of holdings drifts.
 *
 * big.js is configured to throw rather than round or return NaN, so an
 * invalid amount fails loudly at the boundary instead of becoming a wrong
 * number deeper in.
 */

// Exponential notation is rejected on input, so keep Big from ever producing
// it on output either - a round-tripped amount must stay comparable as a string.
Big.NE = -1e6;
Big.PE = 1e6;

/** Plain decimal, optional leading minus, optional fractional part. No
 *  exponents, no thousands separators, no hex, no whitespace. */
const DECIMAL = /^-?(\d+(\.\d+)?|\.\d+)$/;

export const isValidAmount = (value: string): boolean =>
  typeof value === 'string' && DECIMAL.test(value);

const toBig = (value: string): Big => {
  if (!isValidAmount(value)) {
    throw new Error(`invalid amount: ${JSON.stringify(value)}`);
  }
  return new Big(value);
};

/** Canonical form, so two equal amounts are the same string and can be
 *  compared or used as a key. */
export const normaliseAmount = (value: string): string => {
  const big = toBig(value);
  // Big keeps -0; the ledger should not distinguish it from 0.
  return big.eq(0) ? '0' : big.toString();
};

export const addAmounts = (a: string, b: string): string =>
  normaliseAmount(toBig(a).plus(toBig(b)).toString());

export const subtractAmounts = (a: string, b: string): string =>
  normaliseAmount(toBig(a).minus(toBig(b)).toString());

export const negateAmount = (value: string): string =>
  normaliseAmount(toBig(value).times(-1).toString());

export const compareAmounts = (a: string, b: string): -1 | 0 | 1 =>
  toBig(a).cmp(toBig(b)) as -1 | 0 | 1;

export const isZeroAmount = (value: string): boolean => toBig(value).eq(0);

export const sumAmounts = (values: string[]): string =>
  normaliseAmount(
    values
      .reduce((total, value) => total.plus(toBig(value)), new Big(0))
      .toString(),
  );
