import { describe, it, expect } from 'vitest';
import {
  BITPANDA_ASSETS,
  assetIdForSymbol,
  baseUnits,
  UnscalableAmountError,
} from '@/sources/bitpanda/assets';
import { ASSET_DECIMALS } from '@/prices/scale';

/**
 * The unit boundary, which is the dangerous part of an exchange module and
 * not the HTTP.
 *
 * A chain reports base units and the ledger stores them. An exchange reports
 * whole ones: 0.5 BTC, not 50000000 satoshis. Three times now this codebase
 * has been bitten by the same class - lovelace priced as whole ADA, satoshis
 * priced as whole bitcoin, and now whole units stored as base units - so the
 * conversion is pinned here rather than trusted.
 */
describe('baseUnits', () => {
  it('scales whole bitcoin to satoshis', () => {
    expect(baseUnits('0.5', 'bitcoin:native')).toBe('50000000');
    expect(baseUnits('1', 'bitcoin:native')).toBe('100000000');
  });

  it('scales whole ADA to lovelace', () => {
    expect(baseUnits('10', 'cardano:lovelace')).toBe('10000000');
  });

  it('scales whole ether past what a JS number holds exactly', () => {
    // 10^18. Done with a float this is 1000000000000000000 only by luck, and
    // 1.1 ether is not representable at all.
    expect(baseUnits('1', 'eth:native')).toBe('1000000000000000000');
    expect(baseUnits('1.1', 'eth:native')).toBe('1100000000000000000');
  });

  it('keeps a fiat amount WITH its cents', () => {
    // Fiat is deliberately absent from ASSET_DECIMALS - that map is for
    // assets this app prices - and this ledger has no sub-unit for a euro,
    // so the figure passes through unscaled. Rounding it to whole euros,
    // which the first version of this did, loses a cent per trade and makes
    // a report nobody can reconcile.
    expect(ASSET_DECIMALS).not.toHaveProperty('fiat:eur');
    expect(baseUnits('100.25', 'fiat:eur')).toBe('100.25');
  });

  it('drops the fraction of a satoshi an exchange can quote but a chain cannot hold', () => {
    // An exchange may quote more precision than the chain has. The leftover
    // cannot be represented or spent, so it rounds - unlike fiat above.
    expect(baseUnits('0.123456789', 'bitcoin:native')).toBe('12345679');
  });

  it('REFUSES an asset whose decimals are unknown', () => {
    // The whole point. decimalsOf answers 0 for an unknown asset, which is
    // right at the pricing boundary and a silent corruption here: 0.5 would
    // be stored as though it were already in base units, and nothing
    // downstream could tell it was a hundred-million-fold understatement.
    expect(() => baseUnits('0.5', 'solana:native')).toThrow(
      UnscalableAmountError,
    );
  });

  it('refuses something that is not a decimal amount', () => {
    for (const bad of ['', '  ', 'abc', '1,5', '1e8']) {
      expect(() => baseUnits(bad, 'bitcoin:native')).toThrow();
    }
  });
});

describe('assetIdForSymbol', () => {
  it('maps the symbols it knows, whatever the casing', () => {
    expect(assetIdForSymbol('BTC')).toBe('bitcoin:native');
    expect(assetIdForSymbol('btc')).toBe('bitcoin:native');
    expect(assetIdForSymbol(' ada ')).toBe('cardano:lovelace');
  });

  it('refuses a symbol it cannot state with certainty', () => {
    // Bitpanda offers 880 symbols including gold, silver, platinum and
    // palladium. A symbol is ambiguous across chains, so a guess merges two
    // different assets into one position with nothing to show for it.
    expect(assetIdForSymbol('XAU')).toBeNull();
    expect(assetIdForSymbol('DOGE')).toBeNull();
    expect(assetIdForSymbol('')).toBeNull();
  });

  it('knows the decimals of every asset it claims to map', () => {
    // The map and the scale have to move together: a symbol mapped to an
    // asset with no ASSET_DECIMALS entry would pass the mapping and then
    // throw mid-drain, which is a worse failure than refusing it up front.
    // Fiat is exempt: it has no sub-unit here and is priced at 1 by
    // definition, so it is intentionally not in the scale map.
    const mapped = Object.values(BITPANDA_ASSETS).filter(
      (assetId) => !assetId.startsWith('fiat:'),
    );
    expect(mapped.length).toBeGreaterThan(0);
    for (const assetId of mapped) {
      expect(ASSET_DECIMALS).toHaveProperty(assetId);
      // And every mapped asset must survive the conversion it will meet.
      expect(() => baseUnits('1', assetId)).not.toThrow();
    }
  });
});
