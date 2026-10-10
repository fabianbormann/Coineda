import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * The filing figures through the REAL German pipeline: matching, fee
 * valuation and assessment, then the numbers a user would type.
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

describe('filing figures end to end', () => {
  it('matches the private sale lines and the income lines to the report', async () => {
    await putEvents([
      event({
        id: 'buy',
        externalId: 'buy',
        timestamp: Date.UTC(2025, 0, 10),
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
          leg({ assetId: ADA, amount: ada(500), direction: 'out' }),
          leg({ assetId: EUR, amount: '700', direction: 'in' }),
          leg({ assetId: EUR, amount: '2', direction: 'out', role: 'fee' }),
        ],
      }),
      event({
        id: 'reward',
        externalId: 'reward',
        kind: 'reward',
        timestamp: Date.UTC(2025, 3, 1),
        raw: { epoch: 500, type: 'leader' },
        legs: [
          leg({
            assetId: ADA,
            amount: ada(5),
            direction: 'in',
            venue: 'stake1',
          }),
        ],
      }),
    ]);

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });
    const filing = report.filing;
    expect(filing?.linesVerified).toBe(true);

    const amountAt = (section: number, line: number) =>
      filing?.sections[section].entries.find((e) => e.reference?.line === line)
        ?.amount;

    // 700 received less a 2 fee: proceeds 698 net, costs 2, cost 500.
    expect(report.lines[0].proceeds).toBe('698');
    expect(amountAt(0, 48)).toBe('700');
    expect(amountAt(0, 49)).toBe('500');
    expect(amountAt(0, 50)).toBe('2');
    expect(amountAt(0, 51)).toBe(report.lines[0].gain);
    expect(amountAt(0, 51)).toBe('198');
    expect(amountAt(0, 58)).toBe('198');

    expect(amountAt(1, 18)).toBe('5');
    expect(amountAt(1, 19)).toBe('0');
    expect(amountAt(1, 20)).toBe('5');
    expect(filing?.sections).toHaveLength(2);
  });

  it('enters a fee paid to receive a reward as the expenses of the income', async () => {
    vi.stubGlobal('fetch', flatRange(0.4));
    await putEvents([
      event({
        id: 'reward',
        externalId: 'reward',
        kind: 'reward',
        rewardKind: 'staking',
        timestamp: Date.UTC(2025, 3, 1),
        legs: [
          leg({
            assetId: ADA,
            amount: '200000',
            direction: 'out',
            role: 'fee',
            venue: 'stake1',
          }),
          leg({
            assetId: ADA,
            amount: ada(100),
            direction: 'in',
            venue: 'stake1',
          }),
        ],
      }),
    ]);

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });
    const income = report.filing?.sections.find(
      (section) => section.title === 'Other income (§22 Nr. 3 EStG)',
    );
    const amountAt = (line: number) =>
      income?.entries.find((e) => e.reference?.line === line)?.amount;

    expect(amountAt(18)).toBe('40');
    expect(amountAt(19)).toBe('0.08');
    expect(amountAt(20)).toBe('39.92');
    expect(report.totals.incomeCosts).toBe('0.08');
  });
});
