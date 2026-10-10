import { describe, expect, it } from 'vitest';
import {
  aggregateLedger,
  REWARD_TRANSFER_TYPE,
  type AggregateOptions,
} from '@/carf/aggregate';
import type { Leg, LedgerEvent } from '@/ledger/types';
import { ledgerEvent } from './helpers/ledger';

const BTC = 'bitcoin:native';
const ADA = 'cardano:lovelace';
const EUR = 'fiat:eur';
const AT = Date.UTC(2026, 3, 15, 12);

const leg = (
  assetId: string,
  amount: string,
  direction: Leg['direction'],
  venue = 'bitpanda',
  role: Leg['role'] = 'principal',
): Leg => ({ assetId, amount, direction, venue, role });

let n = 0;
const event = (overrides: Partial<LedgerEvent>): LedgerEvent => {
  n += 1;
  return ledgerEvent({
    id: `e${n}`,
    externalId: `x${n}`,
    timestamp: AT,
    ...overrides,
  });
};

const options = (
  overrides: Partial<AggregateOptions> = {},
): AggregateOptions => ({
  year: 2026,
  providerVenues: new Set(['bitpanda']),
  ownedVenues: new Set(['bitpanda', 'kraken', 'stake1own']),
  walletVenues: new Set(['stake1own']),
  valueOf: () => undefined,
  ...overrides,
});

describe('aggregateLedger', () => {
  it('(a) books a fiat buy under fiat-in with the crypto fee apart', () => {
    const figures = aggregateLedger(
      [
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '25000000', 'in'),
            leg(EUR, '15000', 'out'),
            leg(BTC, '50000', 'out', 'bitpanda', 'fee'),
          ],
        }),
      ],
      options(),
    );
    expect(figures[BTC]?.['fiat-in']).toMatchObject({
      transactions: 1,
      units: '25000000',
      amount: '15000',
      fees: '50000',
      fiatFees: '0',
    });
    expect(Object.keys(figures[BTC] ?? {})).toEqual(['fiat-in']);
    expect(figures[EUR]).toBeUndefined();
  });

  it('(b) books a fiat sell under fiat-out with the fiat fee apart', () => {
    const figures = aggregateLedger(
      [
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '10000000', 'out'),
            leg(EUR, '7000', 'in'),
            leg(EUR, '10', 'out', 'bitpanda', 'fee'),
          ],
        }),
      ],
      options(),
    );
    expect(figures[BTC]?.['fiat-out']).toMatchObject({
      transactions: 1,
      units: '10000000',
      amount: '7000',
      fees: '0',
      fiatFees: '10',
    });
  });

  it('(c) books a crypto swap under crypto-in and crypto-out with looked-up values', () => {
    const swap = event({
      kind: 'trade',
      legs: [leg(BTC, '1000000', 'out'), leg(ADA, '1000000000', 'in')],
    });
    const priced = aggregateLedger([swap], options({ valueOf: () => '400' }));
    expect(priced[ADA]?.['crypto-in']).toMatchObject({
      transactions: 1,
      units: '1000000000',
      amount: '400',
    });
    expect(priced[BTC]?.['crypto-out']).toMatchObject({
      transactions: 1,
      units: '1000000',
      amount: '400',
    });

    const unpriced = aggregateLedger(
      [swap],
      options({
        valueOf: (id, assetId) =>
          id === swap.id && assetId === BTC ? '400' : undefined,
      }),
    );
    expect(unpriced[ADA]?.['crypto-in']?.units).toBe('1000000000');
    expect(unpriced[ADA]?.['crypto-in']?.amount).toBeUndefined();
    expect(unpriced[BTC]?.['crypto-out']?.amount).toBe('400');
  });

  it('keeps an unpriced category unpriced once one event lacks a value', () => {
    const first = event({
      kind: 'trade',
      legs: [leg(BTC, '1', 'out'), leg(ADA, '10', 'in')],
    });
    const second = event({
      kind: 'trade',
      legs: [leg(BTC, '1', 'out'), leg(ADA, '10', 'in')],
    });
    const figures = aggregateLedger(
      [first, second],
      options({ valueOf: (id) => (id === second.id ? '5' : undefined) }),
    );
    expect(figures[ADA]?.['crypto-in']).toMatchObject({
      transactions: 2,
      units: '20',
    });
    expect(figures[ADA]?.['crypto-in']?.amount).toBeUndefined();
  });

  const rewards = () =>
    Array.from({ length: 12 }, () =>
      event({
        kind: 'reward',
        rewardKind: 'staking',
        legs: [leg(ADA, '7500000', 'in')],
      }),
    );

  it('(d) types staking rewards as CARF502 transfers in', () => {
    const figures = aggregateLedger(rewards(), options({ valueOf: () => '3' }));
    const cat = figures[ADA]?.['transfer-in'];
    expect(cat).toMatchObject({
      transactions: 12,
      units: '90000000',
      amount: '36',
    });
    expect(cat?.byType.CARF502).toEqual({
      transactions: 12,
      units: '90000000',
      amount: '36',
    });
    expect(Object.keys(cat?.byType ?? {})).toEqual(['CARF502']);
  });

  it('maps reward kinds to CARF transfer types', () => {
    expect(REWARD_TRANSFER_TYPE.staking).toBe('CARF502');
    expect(REWARD_TRANSFER_TYPE.airdrop).toBe('CARF501');
    expect(REWARD_TRANSFER_TYPE.mining).toBe('CARF503');
    expect(REWARD_TRANSFER_TYPE.lending).toBe('CARF504');
    expect(REWARD_TRANSFER_TYPE.other).toBe('CARF508');
    const figures = aggregateLedger(
      [
        event({ kind: 'reward', legs: [leg(ADA, '1', 'in')] }),
        event({
          kind: 'reward',
          rewardKind: 'liquidity',
          legs: [leg(ADA, '2', 'in')],
        }),
      ],
      options(),
    );
    expect(figures[ADA]?.['transfer-in']?.byType.CARF508).toMatchObject({
      transactions: 2,
      units: '3',
    });
  });

  const deposit = () =>
    event({
      kind: 'transfer',
      legs: [
        leg(ADA, '500000000', 'out', 'addr1ext'),
        leg(ADA, '500000000', 'in'),
      ],
    });

  it('(e) types an untyped deposit as CARF509', () => {
    const figures = aggregateLedger([deposit()], options());
    const cat = figures[ADA]?.['transfer-in'];
    expect(cat?.byType.CARF509).toMatchObject({
      transactions: 1,
      units: '500000000',
    });
    expect(figures[ADA]?.['transfer-out']).toBeUndefined();
  });

  it('(d)+(e) totals transfer-in across types', () => {
    const figures = aggregateLedger(
      [...rewards(), deposit()],
      options({ valueOf: () => '3' }),
    );
    const cat = figures[ADA]?.['transfer-in'];
    expect(cat?.transactions).toBe(13);
    expect(cat?.units).toBe('590000000');
    expect(Object.keys(cat?.byType ?? {}).sort()).toEqual([
      'CARF502',
      'CARF509',
    ]);
  });

  const withdrawal = (to: string) =>
    event({
      kind: 'transfer',
      legs: [
        leg(ADA, '500000000', 'out'),
        leg(ADA, '500000000', 'in', to),
        leg(ADA, '1000000', 'out', 'bitpanda', 'fee'),
      ],
    });

  it('(f) books a withdrawal to the own wallet under transfer-out and wallet', () => {
    const figures = aggregateLedger([withdrawal('stake1own')], options());
    expect(figures[ADA]?.['transfer-out']).toMatchObject({
      transactions: 1,
      units: '500000000',
      fees: '1000000',
    });
    expect(figures[ADA]?.['transfer-out']?.byType.CARF606).toMatchObject({
      transactions: 1,
      units: '500000000',
    });
    expect(figures[ADA]?.wallet).toMatchObject({
      transactions: 1,
      units: '500000000',
    });
    expect(figures[ADA]?.['transfer-in']).toBeUndefined();
  });

  it('(g) books a withdrawal to an unknown address under transfer-out only', () => {
    const figures = aggregateLedger([withdrawal('addr1unknown')], options());
    expect(figures[ADA]?.['transfer-out']?.transactions).toBe(1);
    expect(figures[ADA]?.wallet).toBeUndefined();
  });

  it('(h) books a move to another owned exchange under transfer-out only', () => {
    const figures = aggregateLedger([withdrawal('kraken')], options());
    expect(figures[ADA]?.['transfer-out']?.transactions).toBe(1);
    expect(figures[ADA]?.wallet).toBeUndefined();
  });

  it('ignores a provider-internal move', () => {
    const figures = aggregateLedger([withdrawal('bitpanda')], options());
    expect(figures).toEqual({});
  });

  it('(i) ignores events outside the year or away from the provider', () => {
    const figures = aggregateLedger(
      [
        event({
          kind: 'reward',
          rewardKind: 'staking',
          timestamp: Date.UTC(2025, 11, 31, 23, 59, 59),
          legs: [leg(ADA, '7500000', 'in')],
        }),
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '1000', 'in', 'kraken'),
            leg(EUR, '1', 'out', 'kraken'),
          ],
        }),
      ],
      options(),
    );
    expect(figures).toEqual({});
  });

  it('(j) ignores fiat-in and fee events', () => {
    const figures = aggregateLedger(
      [
        event({ kind: 'fiat-in', legs: [leg(EUR, '1000', 'in')] }),
        event({
          kind: 'fee',
          legs: [leg(ADA, '170000', 'out', 'bitpanda', 'fee')],
        }),
      ],
      options(),
    );
    expect(figures).toEqual({});
  });
});
