import { describe, it, expect } from 'vitest';
import {
  ASSET_CATALOGUE,
  ambiguousSymbols,
  assetById,
  resolveSymbol,
} from '@/assets/catalogue';
import { ASSET_DECIMALS, NIGHT_ASSET_ID, USDT_ASSET_ID } from '@/prices/scale';
import { COINGECKO_IDS } from '@/prices/coingecko';

describe('asset catalogue', () => {
  it('has unique ids', () => {
    const ids = ASSET_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves symbols case-insensitively where unambiguous', () => {
    expect(resolveSymbol('btc')?.id).toBe('bitcoin:native');
    expect(resolveSymbol('USDT')?.id).toBe(USDT_ASSET_ID);
    expect(assetById('eth:native')?.symbol).toBe('ETH');
  });

  it('refuses an ambiguous symbol without a hint', () => {
    expect(resolveSymbol('MATIC')).toBeUndefined();
    expect(ambiguousSymbols()).toContain('MATIC');
  });

  it('resolves an ambiguous symbol with a chain hint', () => {
    expect(resolveSymbol('MATIC', { chain: 'eth' })?.id).toBe(
      'eth:0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
    );
    expect(resolveSymbol('MATIC', { chain: 'polygon' })?.id).toBe(
      'polygon:native',
    );
  });

  it('gives every non-fiat entry decimals and a coingeckoId', () => {
    for (const e of ASSET_CATALOGUE.filter((x) => x.kind !== 'fiat')) {
      expect(Number.isInteger(e.decimals)).toBe(true);
      expect(e.coingeckoId).toBeTruthy();
    }
  });

  it('dates every entry', () => {
    for (const e of ASSET_CATALOGUE) {
      expect(e.verified.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.verified.source).toBeTruthy();
    }
  });

  it('derives ASSET_DECIMALS without fiat', () => {
    expect(ASSET_DECIMALS['cardano:lovelace']).toBe(6);
    expect(ASSET_DECIMALS['eth:native']).toBe(18);
    expect(ASSET_DECIMALS[NIGHT_ASSET_ID]).toBe(6);
    expect(Object.keys(ASSET_DECIMALS).some((k) => k.startsWith('fiat:'))).toBe(
      false,
    );
    expect(Object.keys(ASSET_DECIMALS).length).toBe(
      ASSET_CATALOGUE.filter((e) => e.kind !== 'fiat').length,
    );
  });

  it('derives COINGECKO_IDS', () => {
    expect(COINGECKO_IDS[NIGHT_ASSET_ID]).toBe('midnight-3');
    expect(COINGECKO_IDS['solana:native']).toBe('solana');
  });
});
