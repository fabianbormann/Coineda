import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg, RewardKind } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * Reward kinds end to end through the real German module: the kind a source
 * set decides the income row, its note and the cost basis of what is sold.
 * Amounts are lovelace and the stubbed price is 1 EUR per whole ADA.
 */

const ADA = 'cardano:lovelace';
const EUR = 'fiat:eur';
const VENUE = 'wallet';

const ada = (whole: number): string => `${whole}000000`;

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'assetId' | 'amount' | 'direction'>,
): Leg => ({ venue: VENUE, role: 'principal', ...overrides });

const reward = (
  id: string,
  rewardKind: RewardKind,
  whole: number,
  month: number,
): LedgerEvent => ({
  id,
  sourceId: 's1',
  externalId: id,
  timestamp: Date.UTC(2025, month, 1),
  kind: 'reward',
  origin: 'derived',
  rewardKind,
  legs: [leg({ assetId: ADA, amount: ada(whole), direction: 'in' })],
});

const sale = (id: string, whole: number, month: number): LedgerEvent => ({
  id,
  sourceId: 's1',
  externalId: id,
  timestamp: Date.UTC(2025, month, 1),
  kind: 'trade',
  origin: 'derived',
  legs: [
    leg({ assetId: ADA, amount: ada(whole), direction: 'out' }),
    leg({ assetId: EUR, amount: String(whole), direction: 'in' }),
  ],
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

const runGermany = () =>
  runTaxReport(germanTax, { year: 2025, baseCurrency: 'eur' });

describe('reward kinds end to end', () => {
  it('taxes an airdrop at its value on receipt and uses that as cost basis', async () => {
    await putEvents([reward('air', 'airdrop', 300, 2), sale('sell', 300, 8)]);

    const report = await runGermany();

    expect(report.income).toHaveLength(1);
    expect(report.income[0]).toMatchObject({
      rewardKind: 'airdrop',
      value: '300',
    });
    expect(report.income[0].note).toMatch(/counter-performance/);
    expect(report.totals.income).toBe('300');
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].costBasis).toBe('300');
    expect(report.lines[0].gain).toBe('0');
  });

  it('gives a fork no income and a zero cost basis', async () => {
    await putEvents([reward('fork', 'fork', 100, 2), sale('sell', 100, 8)]);

    const report = await runGermany();

    expect(report.income).toHaveLength(0);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].costBasis).toBe('0');
    expect(report.lines[0].gain).toBe('100');
    expect(report.unresolved).toEqual([]);
  });

  it('counts lending and staking together against the income Freigrenze', async () => {
    await putEvents([
      reward('lend', 'lending', 10, 2),
      reward('stake', 'staking', 20, 3),
    ]);

    const report = await runGermany();

    expect(report.income).toHaveLength(2);
    expect(report.totals.income).toBe('0');
    expect(report.thresholds.some((one) => one.actual === '30')).toBe(true);
  });
});
