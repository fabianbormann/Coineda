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
  exchangeVenues: new Set(['bitpanda', 'kraken']),
  baseCurrency: 'eur',
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

  const withdrawal = (to: string, txHash?: string) =>
    event({
      kind: 'transfer',
      ...(txHash ? { txHash } : {}),
      legs: [
        leg(ADA, '500000000', 'out'),
        ...(to ? [leg(ADA, '500000000', 'in', to)] : []),
        leg(ADA, '1000000', 'out', 'bitpanda', 'fee'),
      ],
    });

  /** The receiving side of a cross-source move: its own event, tied to the
   *  withdrawal only by the transaction hash. */
  const receipt = (venue: string, txHash: string) =>
    event({
      kind: 'transfer',
      txHash,
      legs: [
        leg(ADA, '500000000', 'out', 'addr1provider'),
        leg(ADA, '500000000', 'in', venue),
      ],
    });

  it('(f) counts a withdrawal received by the own chain wallet as a wallet transfer', () => {
    const figures = aggregateLedger(
      [withdrawal('', 'h-own'), receipt('stake1own', 'h-own')],
      options(),
    );
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
      fees: '1000000',
    });
    expect(figures[ADA]?.['transfer-in']).toBeUndefined();
  });

  it('(g) counts a withdrawal with no linked receipt as a wallet transfer', () => {
    const figures = aggregateLedger([withdrawal('')], options());
    expect(figures[ADA]?.['transfer-out']?.transactions).toBe(1);
    expect(figures[ADA]?.wallet?.transactions).toBe(1);
  });

  it('(h) does not count a move received at another provider as a wallet transfer', () => {
    const linked = aggregateLedger(
      [withdrawal('', 'h-kraken'), receipt('kraken', 'h-kraken')],
      options(),
    );
    expect(linked[ADA]?.['transfer-out']?.transactions).toBe(1);
    expect(linked[ADA]?.wallet).toBeUndefined();
    // The receipt is linked even when it lies in another year.
    const early = receipt('kraken', 'h-late');
    early.timestamp = Date.UTC(2025, 11, 31, 23);
    const acrossYears = aggregateLedger(
      [withdrawal('', 'h-late'), early],
      options(),
    );
    expect(acrossYears[ADA]?.wallet).toBeUndefined();
    // One event carrying both sides.
    const fused = aggregateLedger([withdrawal('kraken')], options());
    expect(fused[ADA]?.['transfer-out']?.transactions).toBe(1);
    expect(fused[ADA]?.wallet).toBeUndefined();
  });

  it('counts a withdrawal whose hash matches only a wallet receipt as a wallet transfer', () => {
    const figures = aggregateLedger(
      [withdrawal('addr1unknown', 'h-x'), receipt('addr1unknown', 'h-x')],
      options(),
    );
    expect(figures[ADA]?.wallet?.transactions).toBe(1);
  });

  it('ignores a provider-internal move', () => {
    const figures = aggregateLedger([withdrawal('bitpanda')], options());
    expect(figures).toEqual({});
  });

  it('counts an event at exactly 2026-01-01T00:00:00Z in 2026', () => {
    const figures = aggregateLedger(
      [
        event({
          kind: 'reward',
          rewardKind: 'staking',
          timestamp: Date.UTC(2026, 0, 1, 0, 0, 0),
          legs: [leg(ADA, '7500000', 'in')],
        }),
      ],
      options(),
    );
    expect(figures[ADA]?.['transfer-in']?.transactions).toBe(1);
  });

  it('leaves unpriced rewards unpriced in the total and per type', () => {
    const figures = aggregateLedger(rewards(), options());
    const cat = figures[ADA]?.['transfer-in'];
    expect(cat?.transactions).toBe(12);
    expect(cat?.amount).toBeUndefined();
    expect(cat?.byType.CARF502?.transactions).toBe(12);
    expect(cat?.byType.CARF502?.amount).toBeUndefined();
  });

  it('sums fiat only in the base currency; another fiat currency leaves the amount unpriced', () => {
    const USD = 'fiat:usd';
    const figures = aggregateLedger(
      [
        event({
          kind: 'trade',
          legs: [leg(BTC, '10000000', 'in'), leg(USD, '10000', 'out')],
        }),
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '5000000', 'in'),
            leg(EUR, '4600', 'out'),
            leg(EUR, '5', 'out', 'bitpanda', 'fee'),
          ],
        }),
      ],
      options(),
    );
    const cat = figures[BTC]?.['fiat-in'];
    expect(cat?.transactions).toBe(2);
    expect(cat?.units).toBe('15000000');
    expect(cat?.amount).toBeUndefined();

    const eurOnly = aggregateLedger(
      [
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '5000000', 'in'),
            leg(EUR, '4600', 'out'),
            leg(EUR, '5', 'out', 'bitpanda', 'fee'),
          ],
        }),
      ],
      options({ baseCurrency: 'EUR', valueOf: () => undefined }),
    );
    expect(eurOnly[BTC]?.['fiat-in']).toMatchObject({
      amount: '4600',
      fiatFees: '5',
    });
  });

  it('leaves the fiat amount and fees unknown when the crypto side holds two assets', () => {
    const figures = aggregateLedger(
      [
        event({
          kind: 'trade',
          legs: [
            leg(BTC, '1000000', 'in'),
            leg(ADA, '10000000', 'in'),
            leg(EUR, '700', 'out'),
            leg(EUR, '2', 'out', 'bitpanda', 'fee'),
          ],
        }),
      ],
      options(),
    );
    for (const assetId of [BTC, ADA]) {
      const cat = figures[assetId]?.['fiat-in'];
      expect(cat?.transactions).toBe(1);
      expect(cat?.amount).toBeUndefined();
      expect(cat?.fiatFees).toBeUndefined();
    }
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
