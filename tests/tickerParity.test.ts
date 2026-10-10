import { describe, it, expect } from 'vitest';
import { assetIdForCode } from '@/sources/kraken-csv/assets';
import { binanceAssetId } from '@/sources/binance-csv/parse';
import { coinbaseAssetId } from '@/sources/coinbase-csv/parse';
import { assetIdForSymbol } from '@/sources/bitpanda/assets';
import { NIGHT_ASSET_ID, USDC_ASSET_ID, USDT_ASSET_ID } from '@/prices/scale';

/**
 * Every ticker the per-module maps carried before the asset catalogue
 * (f41562b), with the id it mapped to. The catalogue promised to lose
 * nothing; this table makes that promise a test rather than an accident.
 */
const KRAKEN: Record<string, string> = {
  XXBT: 'bitcoin:native',
  XBT: 'bitcoin:native',
  BTC: 'bitcoin:native',
  XETH: 'eth:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  USDT: USDT_ASSET_ID,
  USDC: USDC_ASSET_ID,
  ZEUR: 'fiat:eur',
  EUR: 'fiat:eur',
  ZUSD: 'fiat:usd',
  USD: 'fiat:usd',
  ZGBP: 'fiat:gbp',
  GBP: 'fiat:gbp',
  CHF: 'fiat:chf',
  ZCAD: 'fiat:cad',
  CAD: 'fiat:cad',
  ZAUD: 'fiat:aud',
  AUD: 'fiat:aud',
  ZJPY: 'fiat:jpy',
  JPY: 'fiat:jpy',
};

const BINANCE: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
  USDT: USDT_ASSET_ID,
  USDC: USDC_ASSET_ID,
};

const COINBASE: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
};

const BITPANDA: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
  NIGHT: NIGHT_ASSET_ID,
};

const TABLE: [
  string,
  Record<string, string>,
  (ticker: string) => string | null,
][] = [
  ['kraken-csv', KRAKEN, assetIdForCode],
  ['binance-csv', BINANCE, binanceAssetId],
  ['coinbase-csv', COINBASE, coinbaseAssetId],
  ['bitpanda', BITPANDA, assetIdForSymbol],
];

describe('ticker parity with the pre-catalogue maps', () => {
  for (const [module, old, resolve] of TABLE) {
    for (const [ticker, id] of Object.entries(old)) {
      it(`${module} still resolves ${ticker} to ${id}`, () => {
        expect(resolve(ticker)).toBe(id);
      });
    }
  }

  it('lists every entry the old maps had', () => {
    expect(TABLE.map(([, old]) => Object.keys(old).length)).toEqual([
      21, 6, 4, 5,
    ]);
  });
});
