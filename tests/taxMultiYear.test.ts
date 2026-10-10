import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * A lot is consumed once, however many years are reported. Each year's
 * report is a separate run over the whole ledger, so the second run must
 * start from the lots the first one left, not from the full purchase.
 *
 * Amounts are lovelace; the stubbed price is 1 EUR per whole ADA.
 */

const ADA = 'cardano:lovelace';
const EUR = 'fiat:eur';
const VENUE = 'kraken';

const ada = (whole: number): string => `${whole}000000`;

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'assetId' | 'amount' | 'direction'>,
): Leg => ({ venue: VENUE, role: 'principal', ...overrides });

const trade = (
  id: string,
  timestamp: number,
  side: 'buy' | 'sell',
  whole: number,
): LedgerEvent => ({
  id,
  sourceId: 's1',
  externalId: id,
  timestamp,
  kind: 'trade',
  origin: 'derived',
  legs:
    side === 'buy'
      ? [
          leg({ assetId: EUR, amount: String(whole), direction: 'out' }),
          leg({ assetId: ADA, amount: ada(whole), direction: 'in' }),
        ]
      : [
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

const runGermany = (year: number) =>
  runTaxReport(germanTax, { year, baseCurrency: 'eur' });

describe('lots across tax years', () => {
  it('consumes each acquisition once across two yearly reports', async () => {
    await putEvents([
      trade('buy-2023', Date.UTC(2023, 0, 1), 'buy', 100),
      trade('sell-2024', Date.UTC(2024, 5, 1), 'sell', 40),
      trade('sell-2025', Date.UTC(2025, 5, 1), 'sell', 40),
    ]);

    const r2024 = await runGermany(2024);
    const r2025 = await runGermany(2025);

    const consumed = [...r2024.lines, ...r2025.lines].flatMap(
      (line) => line.consumed,
    );
    const byAcquisition = new Map<string, number>();
    for (const lot of consumed) {
      byAcquisition.set(
        lot.acquisitionEventId,
        (byAcquisition.get(lot.acquisitionEventId) ?? 0) + Number(lot.amount),
      );
    }
    for (const total of byAcquisition.values()) {
      expect(total).toBeLessThanOrEqual(Number(ada(100)));
    }

    expect(r2025.lines).toHaveLength(1);
    const lot = r2025.lines[0].consumed[0];
    expect(lot.amount).toBe(ada(40));
    expect(lot.acquisitionEventId).toBe(
      r2024.lines[0].consumed[0].acquisitionEventId,
    );
    // The 2025 sale starts from the 60 left after 2024's, not from 100.
    expect(r2024.lines[0].consumed[0].amount).toBe(ada(40));
  });

  it('leaves a later acquisition alone when an earlier lot covers the sale', async () => {
    await putEvents([
      trade('buy-2023', Date.UTC(2023, 0, 1), 'buy', 100),
      trade('buy-2024', Date.UTC(2024, 2, 1), 'buy', 50),
      trade('sell-2024', Date.UTC(2024, 5, 1), 'sell', 40),
    ]);

    const report = await runGermany(2024);

    const ids = report.lines.flatMap((line) =>
      line.consumed.map((lot) => lot.acquisitionEventId),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toContain('buy-2023');
  });
});
