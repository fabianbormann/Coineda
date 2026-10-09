import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { DerivativeKind, LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * Derivative settlements end to end through the real German module: they
 * are §20 capital income, kept apart from the §23 and §22 figures.
 */

const EUR = 'fiat:eur';
const BTC = 'bitcoin:native';
const VENUE = 'ex';

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'assetId' | 'amount' | 'direction'>,
): Leg => ({ venue: VENUE, role: 'principal', ...overrides });

const settlement = (
  id: string,
  kind: DerivativeKind,
  month: number,
  legs: Leg[],
): LedgerEvent => ({
  id,
  sourceId: 's1',
  externalId: id,
  timestamp: Date.UTC(2025, month, 1),
  kind: 'derivative',
  origin: 'derived',
  derivative: { kind },
  legs,
});

const eur = (
  id: string,
  kind: DerivativeKind,
  month: number,
  amount: string,
  direction: 'in' | 'out',
  role: 'principal' | 'fee' = 'principal',
) =>
  settlement(id, kind, month, [leg({ assetId: EUR, amount, direction, role })]);

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

const runGermany = () =>
  runTaxReport(germanTax, { year: 2025, baseCurrency: 'eur' });

describe('derivatives end to end', () => {
  it('nets a profit, a loss and a rollover fee inside the allowance', async () => {
    await putEvents([
      eur('fee', 'rollover', 3, '5', 'out', 'fee'),
      eur('win', 'pnl', 1, '500', 'in'),
      eur('lose', 'pnl', 2, '200', 'out'),
    ]);

    const report = await runGermany();

    expect(report.capitalResult).toMatchObject({
      gains: '500',
      losses: '205',
      net: '295',
      allowance: '1000',
      taxable: '0',
      loss: '0',
    });
    expect(report.capital.map((row) => row.sourceEventId)).toEqual([
      'win',
      'lose',
      'fee',
    ]);
    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.loss).toBe('0');
    expect(report.income).toEqual([]);
  });

  it('taxes the excess over the allowance at 25 percent', async () => {
    await putEvents([eur('win', 'pnl', 1, '3000', 'in')]);

    const report = await runGermany();

    expect(report.capitalResult).toMatchObject({
      taxable: '2000',
      estimatedTax: '500',
    });
  });

  it('values a crypto settlement and uses it as cost basis for a later sale', async () => {
    // 1 000 000 satoshi = 0.01 BTC at 50 000 EUR = 500 EUR.
    vi.stubGlobal('fetch', flatRange(50000));
    await putEvents([
      settlement('win', 'pnl', 1, [
        leg({ assetId: BTC, amount: '1000000', direction: 'in' }),
      ]),
      {
        id: 'sell',
        sourceId: 's1',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 6, 1),
        kind: 'trade',
        origin: 'derived',
        legs: [
          leg({ assetId: BTC, amount: '1000000', direction: 'out' }),
          leg({ assetId: EUR, amount: '600', direction: 'in' }),
        ],
      },
    ]);

    const report = await runGermany();

    expect(report.capitalResult?.gains).toBe('500');
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].costBasis).toBe('500');
    expect(report.lines[0].gain).toBe('100');
  });

  it('leaves the §23 figures alone when a derivative loses money', async () => {
    await putEvents([
      {
        id: 'buy',
        sourceId: 's1',
        externalId: 'buy',
        timestamp: Date.UTC(2025, 0, 1),
        kind: 'trade',
        origin: 'derived',
        legs: [
          leg({ assetId: BTC, amount: '1000000', direction: 'in' }),
          leg({ assetId: EUR, amount: '1000', direction: 'out' }),
        ],
      },
      {
        id: 'sell',
        sourceId: 's1',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 5, 1),
        kind: 'trade',
        origin: 'derived',
        legs: [
          leg({ assetId: BTC, amount: '1000000', direction: 'out' }),
          leg({ assetId: EUR, amount: '3000', direction: 'in' }),
        ],
      },
      eur('lose', 'pnl', 2, '700', 'out'),
    ]);

    const report = await runGermany();

    expect(report.totals.taxableGain).toBe('2000');
    expect(report.capitalResult).toMatchObject({ loss: '700', taxable: '0' });
  });

  it('lists a settlement in an asset with no price instead of dropping it', async () => {
    await putEvents([
      settlement('win', 'pnl', 1, [
        leg({
          assetId: 'cardano:deadbeef.NoSuchToken',
          amount: '100',
          direction: 'in',
        }),
      ]),
    ]);

    const report = await runGermany();

    const item = report.unresolved.find((one) => one.kind === 'needs-price');
    expect(item?.taxEventKind).toBe('capital-gain');
    expect(report.totals.omitted).toBe(0);
  });
});
