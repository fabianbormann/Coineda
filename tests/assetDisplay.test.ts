import { describe, it, expect } from 'vitest';
import { symbolOf, toWholeUnits } from '@/components/money/asset';

/**
 * The display half of the base-unit rule.
 *
 * Amounts are stored in base units because that is what a chain reports.
 * Printing them that way gives "10000000 cardano:lovelace" where the user
 * holds 10 ADA, which is what every screen in this app did before this
 * helper existed.
 */
describe('toWholeUnits', () => {
  it('turns base units back into the units a person holds', () => {
    expect(toWholeUnits('10000000', 'cardano:lovelace')).toBe('10');
    expect(toWholeUnits('50000000', 'bitcoin:native')).toBe('0.5');
    expect(toWholeUnits('1000000000000000000', 'eth:native')).toBe('1');
  });

  it('keeps precision a float would lose', () => {
    // 10^18 is past Number.MAX_SAFE_INTEGER, so this cannot go through a
    // JS number on the way to the screen either.
    expect(toWholeUnits('1100000000000000000', 'eth:native')).toBe('1.1');
    expect(toWholeUnits('1', 'eth:native')).toBe('0.000000000000000001');
  });

  it('leaves an asset with no sub-unit alone', () => {
    expect(toWholeUnits('100.25', 'fiat:eur')).toBe('100.25');
    // An unknown asset is shown unscaled rather than guessed at. Harmless
    // on a screen; the same default at the INGEST boundary would be a
    // hundred-million fold error nothing downstream could see, which is why
    // src/sources/bitpanda/assets.ts refuses it there instead.
    expect(toWholeUnits('42', 'cardano:somepolicy')).toBe('42');
  });

  it('shows a malformed amount rather than swallowing it', () => {
    expect(toWholeUnits('not-a-number', 'bitcoin:native')).toBe('not-a-number');
  });
});

describe('symbolOf', () => {
  it('names the assets a person recognises', () => {
    expect(symbolOf('bitcoin:native')).toBe('BTC');
    expect(symbolOf('cardano:lovelace')).toBe('ADA');
    expect(symbolOf('eth:native')).toBe('ETH');
    expect(symbolOf('fiat:eur')).toBe('EUR');
  });

  it('falls back to the full id rather than inventing a ticker', () => {
    // A Cardano native token is cardano:<policy>, and a policy is not a
    // ticker. Printing a slice of it would put a confident-looking wrong
    // name next to a number.
    const policy = 'cardano:d8f34b1e9c4a2b';
    expect(symbolOf(policy)).toBe(policy);
  });
});
