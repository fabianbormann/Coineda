import { describe, it, expect } from 'vitest';
import { amountString } from '@/sources/amount';
import { amountString as cardanoAmountString } from '@/sources/cardano/utxo';

/**
 * The shared provider-amount guard, extracted from
 * src/sources/cardano/utxo.ts when the Esplora module needed the same
 * protection. Nothing tested it directly - it was only ever exercised
 * incidentally, through whichever provider fixture happened to carry a
 * number - so its branches are pinned here.
 */
describe('amountString', () => {
  it('passes a string through untouched', () => {
    // The utxo endpoints send `quantity` as a string, and Blockfrost sends a
    // reward `amount` as one. A string has lost nothing, so it is not parsed,
    // not normalised, and not range-checked.
    expect(amountString('18446744073709551615', 'x', 'cardano')).toBe(
      '18446744073709551615',
    );
  });

  it('accepts a safe integer', () => {
    expect(amountString(615932, 'an output', 'bitcoin')).toBe('615932');
  });

  it('accepts the largest satoshi amount that can ever exist', () => {
    // 21 million BTC in satoshis is 2.1e15, comfortably inside
    // Number.MAX_SAFE_INTEGER (9.007e15) - so no real Bitcoin amount can
    // trip the precision guard, and this asserts that rather than leaving it
    // as a claim in a comment.
    expect(amountString(2_100_000_000_000_000, 'a supply', 'bitcoin')).toBe(
      '2100000000000000',
    );
    expect(2_100_000_000_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a number JSON parsing has already rounded', () => {
    expect(() =>
      amountString(Number.MAX_SAFE_INTEGER + 2, 'a reward', 'cardano'),
    ).toThrow(/exceeds safe integer precision/);
  });

  it('reports a MISSING amount as missing, not as rounded', () => {
    // These are two different failures and a user has to be able to tell
    // them apart: the message is stored verbatim as the source's lastError
    // and rendered on screen. Esplora's `vin[].prevout.value` is optional in
    // the provider's own shape and the translator casts it to `number`, so an
    // undefined really can arrive here - and it used to land on the
    // precision message above, claiming JSON.parse had rounded a value that
    // was never sent.
    expect(() =>
      amountString(undefined as unknown as number, 'a spent input', 'bitcoin'),
    ).toThrow(/is missing from the provider's response/);
    expect(() =>
      amountString(undefined as unknown as number, 'a spent input', 'bitcoin'),
    ).not.toThrow(/exceeds safe integer precision/);
  });

  it('reports NaN as missing rather than silently recording it', () => {
    // NaN is not a safe integer either, so without its own branch it would
    // also have been blamed on rounding.
    expect(() => amountString(Number.NaN, 'an output', 'bitcoin')).toThrow(
      /is missing from the provider's response/,
    );
  });

  it('keeps Cardano messages byte-identical through the re-export', () => {
    // The extraction's whole premise. cardano/utxo.ts re-exports a wrapper
    // bound to 'cardano', and two existing tests assert on that prefix
    // verbatim; this pins the equivalence directly rather than relying on
    // those two noticing.
    const viaWrapper = (() => {
      try {
        cardanoAmountString(Number.MAX_SAFE_INTEGER + 2, 'a reward');
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const viaShared = (() => {
      try {
        amountString(Number.MAX_SAFE_INTEGER + 2, 'a reward', 'cardano');
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(viaWrapper).toBe(viaShared);
    expect(viaWrapper).toContain('cardano: a reward');
  });
});
