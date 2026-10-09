import { describe, it, expect } from 'vitest';
import { fiatConsiderationOf } from '@/tax/consideration';
import type { LedgerEvent, Leg } from '@/ledger/types';

const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';
const EUR = 'fiat:eur';

const leg = (
  assetId: string,
  amount: string,
  direction: Leg['direction'],
  role: Leg['role'] = 'principal',
): Leg => ({ assetId, amount, direction, venue: 'kraken', role });

const trade = (legs: Leg[]): LedgerEvent => ({
  id: 't',
  sourceId: 's',
  externalId: 'x',
  timestamp: Date.UTC(2025, 0, 1),
  kind: 'trade',
  origin: 'derived',
  legs,
});

describe('the fiat side of a trade', () => {
  it('is the euro paid on a buy', () => {
    expect(
      fiatConsiderationOf(
        trade([leg(EUR, '500', 'out'), leg(BTC, '1000000', 'in')]),
      ),
    ).toEqual({ assetId: EUR, amount: '500' });
  });

  it('is the euro received on a sell', () => {
    expect(
      fiatConsiderationOf(
        trade([leg(ADA, '100000000', 'out'), leg(EUR, '98.5', 'in')]),
      ),
    ).toEqual({ assetId: EUR, amount: '98.5' });
  });

  it('is absent on a crypto-to-crypto swap, which is valued at market', () => {
    expect(
      fiatConsiderationOf(
        trade([leg(ADA, '100000000', 'out'), leg(BTC, '1000', 'in')]),
      ),
    ).toBeUndefined();
  });

  it('is absent on a fiat-for-fiat trade', () => {
    expect(
      fiatConsiderationOf(
        trade([leg(EUR, '100', 'out'), leg('fiat:usd', '108', 'in')]),
      ),
    ).toBeUndefined();
  });

  it('is absent when a fiat leg faces two crypto legs', () => {
    expect(
      fiatConsiderationOf(
        trade([
          leg(EUR, '100', 'out'),
          leg(ADA, '50000000', 'in'),
          leg(BTC, '1000', 'in'),
        ]),
      ),
    ).toBeUndefined();
  });

  it('is absent when both legs point the same way', () => {
    // Not an exchange of one for the other: a mis-parsed export, or a
    // row that lists a fee as a principal. The leg is valued at market,
    // as before.
    expect(
      fiatConsiderationOf(
        trade([leg(EUR, '100', 'out'), leg(BTC, '1000', 'out')]),
      ),
    ).toBeUndefined();
  });

  it('ignores fee legs when counting sides', () => {
    expect(
      fiatConsiderationOf(
        trade([
          leg(EUR, '500', 'out'),
          leg(BTC, '1000000', 'in'),
          leg(EUR, '1.3', 'out', 'fee'),
        ]),
      ),
    ).toEqual({ assetId: EUR, amount: '500' });
  });
});
