import { describe, expect, it } from 'vitest';
import { isCarfFiat, resolveCarfAsset } from '../src/carf/assets';
import {
  guessProviderSources,
  isProviderSource,
} from '../src/carf/guessSources';
import type { SourceRecord } from '../src/ledger/types';

describe('resolveCarfAsset', () => {
  it.each([
    ['BTC', 'bitcoin:native'],
    ['btc', 'bitcoin:native'],
    ['Bitcoin', 'bitcoin:native'],
    ['bitcoin', 'bitcoin:native'],
    ['BTC - Bitcoin', 'bitcoin:native'],
    ['BTC (Bitcoin)', 'bitcoin:native'],
    ['BTC / Bitcoin', 'bitcoin:native'],
    ['ADA', 'cardano:lovelace'],
    ['Cardano', 'cardano:lovelace'],
    ['cardano:lovelace', 'cardano:lovelace'],
    ['MATIC', 'polygon:native'],
  ])('%s', (name, id) => {
    expect(resolveCarfAsset(name)?.id).toBe(id);
  });

  it.each(['NIGHT', 'EUR', 'USD', 'XYZNOPE', ''])('%s is undefined', (n) => {
    expect(resolveCarfAsset(n)).toBeUndefined();
  });

  it('refuses an exact fiat asset id', () => {
    expect(resolveCarfAsset('fiat:eur')).toBeUndefined();
  });

  it('tells a listed fiat currency apart from an unknown name', () => {
    expect(isCarfFiat('EUR')).toBe(true);
    expect(isCarfFiat('fiat:usd')).toBe(true);
    expect(isCarfFiat('BTC')).toBe(false);
    expect(isCarfFiat('XYZNOPE')).toBe(false);
    expect(isCarfFiat('NIGHT')).toBe(false);
  });
});

const sources = [
  { id: 's1', label: 'Bitpanda', moduleId: 'bitpanda' },
  { id: 's2', label: 'Kraken (CSV)', moduleId: 'kraken-csv' },
  { id: 's3', label: 'My wallet', moduleId: 'cardano-yaci' },
];

describe('guessProviderSources', () => {
  it('matches by label or module', () => {
    expect(guessProviderSources('Bitpanda GmbH', sources)).toEqual(['s1']);
    expect(guessProviderSources('Payward Ltd. (Kraken)', sources)).toEqual([
      's2',
    ]);
  });
  it('proposes nothing for unknown or short words', () => {
    expect(guessProviderSources('Unknown Corp', sources)).toEqual([]);
    expect(
      guessProviderSources('UG', [{ id: 'x', label: 'UG', moduleId: 'ug-x' }]),
    ).toEqual([]);
  });
});

describe('isProviderSource', () => {
  const rec = (moduleId: string): SourceRecord => ({
    id: 'a',
    moduleId,
    label: 'l',
    config: {},
  });
  it('is true for exchange and file modules only', () => {
    expect(isProviderSource(rec('bitpanda'))).toBe(true);
    expect(isProviderSource(rec('kraken-csv'))).toBe(true);
    expect(isProviderSource(rec('cardano-yaci'))).toBe(false);
    expect(isProviderSource(rec('bitcoin-esplora'))).toBe(false);
    expect(isProviderSource(rec('nope'))).toBe(false);
  });
  it('is false for a Ledger Live export: that is a wallet, not a provider', () => {
    expect(isProviderSource(rec('ledger-live-csv'))).toBe(false);
  });
});
