import { describe, it, expect } from 'vitest';
import {
  addAmounts,
  compareAmounts,
  isValidAmount,
  isZeroAmount,
  negateAmount,
  normaliseAmount,
  subtractAmounts,
  sumAmounts,
} from '@/ledger/amount';

describe('validation', () => {
  it('accepts plain and signed decimal strings', () => {
    for (const value of [
      '0',
      '1',
      '-1',
      '0.1',
      '-0.00000001',
      '12345678901234567890',
    ]) {
      expect(isValidAmount(value)).toBe(true);
    }
  });

  it('rejects anything that is not a finite decimal string', () => {
    for (const value of [
      '',
      ' ',
      'abc',
      'NaN',
      'Infinity',
      '1e5',
      '1,5',
      '0x10',
      '--1',
    ]) {
      expect(isValidAmount(value)).toBe(false);
    }
  });
});

describe('precision', () => {
  it('adds without the float drift that 0.1 + 0.2 shows', () => {
    // Number(0.1) + Number(0.2) === 0.30000000000000004
    expect(addAmounts('0.1', '0.2')).toBe('0.3');
  });

  it('keeps 18-decimal base units exactly, beyond Number.MAX_SAFE_INTEGER', () => {
    // 1 token with 18 decimals = 1e18 base units; MAX_SAFE_INTEGER is ~9.007e15
    const oneToken = '1000000000000000000';
    expect(Number(oneToken) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(addAmounts(oneToken, '1')).toBe('1000000000000000001');
    // The float path loses the increment entirely - prove the string path does not.
    expect(String(Number(oneToken) + 1)).not.toBe('1000000000000000001');
  });

  it('subtracts a satoshi-scale amount without underflowing to zero', () => {
    expect(subtractAmounts('0.00000002', '0.00000001')).toBe('0.00000001');
  });

  it('sums a long list exactly', () => {
    const hundredth = '0.01';
    expect(sumAmounts(Array.from({ length: 100 }, () => hundredth))).toBe('1');
  });
});

describe('normalisation', () => {
  it('strips redundant zeros and a redundant sign so equal amounts are equal strings', () => {
    expect(normaliseAmount('1.000')).toBe('1');
    expect(normaliseAmount('01.5')).toBe('1.5');
    expect(normaliseAmount('-0')).toBe('0');
    expect(normaliseAmount('.5')).toBe('0.5');
  });
});

describe('comparison and sign', () => {
  it('compares by value, not lexically', () => {
    // '9' > '10' as strings; must not be as amounts
    expect(compareAmounts('9', '10')).toBe(-1);
    expect(compareAmounts('10', '9')).toBe(1);
    expect(compareAmounts('1.0', '1')).toBe(0);
  });

  it('negates and detects zero', () => {
    expect(negateAmount('1.5')).toBe('-1.5');
    expect(negateAmount('-1.5')).toBe('1.5');
    expect(isZeroAmount('0.000')).toBe(true);
    expect(isZeroAmount('0.001')).toBe(false);
  });
});

describe('invalid input', () => {
  it('throws rather than coercing, so a bad amount cannot reach the ledger', () => {
    expect(() => addAmounts('1', 'oops')).toThrow(/invalid amount/i);
    expect(() => normaliseAmount('1e5')).toThrow(/invalid amount/i);
  });
});
