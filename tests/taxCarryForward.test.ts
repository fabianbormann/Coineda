import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * A declared loss carry-forward end to end, through the real German module:
 * the option travels through the host into `assess` and the outcome comes
 * back on the report.
 */

const ADA = 'cardano:lovelace';
const EUR = 'fiat:eur';
const VENUE = 'kraken';

const ada = (whole: number): string => `${whole}000000`;

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'assetId' | 'amount' | 'direction'>,
): Leg => ({ venue: VENUE, role: 'principal', ...overrides });

const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e1',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'trade',
  origin: 'derived',
  legs: [],
  ...overrides,
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  await db.put('settings', {
    key: 'settings',
    value: { language: 'en', baseCurrency: 'eur', coingeckoApiKey: 'test-key' },
  });
  vi.stubGlobal('fetch', flatRange(1));
});

/** 1000 ADA bought for 1000 EUR, sold for 3000 EUR a month later: a 2000
 *  EUR gain held days, not a year. */
const gainOf2000 = async () => {
  await putEvents([
    event({
      id: 'buy',
      externalId: 'buy',
      timestamp: Date.UTC(2025, 4, 1),
      legs: [
        leg({ assetId: EUR, amount: '1000', direction: 'out' }),
        leg({ assetId: ADA, amount: ada(1000), direction: 'in' }),
      ],
    }),
    event({
      id: 'sell',
      externalId: 'sell',
      timestamp: Date.UTC(2025, 5, 1),
      legs: [
        leg({ assetId: ADA, amount: ada(1000), direction: 'out' }),
        leg({ assetId: EUR, amount: '3000', direction: 'in' }),
      ],
    }),
  ]);
};

describe('loss carry-forward through the pipeline', () => {
  it('reduces the taxable gain by the declared §23 loss', async () => {
    await gainOf2000();
    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
      carryForward: { privateSales: '500' },
    });
    expect(report.totals.taxableGain).toBe('1500');
    expect(report.carryForward?.privateSales).toEqual({
      declared: '500',
      used: '500',
      remaining: '0',
    });
  });

  it('leaves the same events untouched without a carry-forward', async () => {
    await gainOf2000();
    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });
    expect(report.totals.taxableGain).toBe('2000');
    expect(report.carryForward).toBeUndefined();
  });

  it('applies a §20 loss to derivative settlements', async () => {
    await putEvents([
      event({
        id: 'd1',
        externalId: 'd1',
        kind: 'derivative',
        derivative: { kind: 'pnl', instrument: 'BTCUSDT' },
        legs: [
          leg({
            assetId: EUR,
            amount: '1500',
            direction: 'in',
            venue: 'futures',
          }),
        ],
      }),
    ]);
    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
      carryForward: { capital: '600' },
    });
    expect(report.capitalResult?.carryForwardUsed).toBe('600');
    expect(report.capitalResult?.taxable).toBe('0');
    expect(report.carryForward?.capital).toEqual({
      declared: '600',
      used: '600',
      remaining: '0',
    });
  });
});
