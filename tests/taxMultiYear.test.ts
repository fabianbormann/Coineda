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
  eur: number = whole,
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
          leg({ assetId: EUR, amount: String(eur), direction: 'out' }),
          leg({ assetId: ADA, amount: ada(whole), direction: 'in' }),
        ]
      : [
          leg({ assetId: ADA, amount: ada(whole), direction: 'out' }),
          leg({ assetId: EUR, amount: String(eur), direction: 'in' }),
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
    // Two lots at different costs, so FIFO has an order to get wrong:
    //   2023: 100 ADA for 100 EUR    2024: 50 ADA for 100 EUR
    //   2024 sells 70 -> all from the 2023 lot (30 left)
    //   2025 sells 40 -> 30 from the 2023 lot, then 10 from the 2024 lot.
    // A matcher that forgot the 2024 sale would take all 40 from the 2023
    // lot in 2025 (one consumed entry of 40) and fail here.
    await putEvents([
      trade('buy-2023', Date.UTC(2023, 0, 1), 'buy', 100, 100),
      trade('buy-2024', Date.UTC(2024, 2, 1), 'buy', 50, 100),
      trade('sell-2024', Date.UTC(2024, 5, 1), 'sell', 70),
      trade('sell-2025', Date.UTC(2025, 5, 1), 'sell', 40),
    ]);

    const r2024 = await runGermany(2024);
    const r2025 = await runGermany(2025);

    expect(r2024.lines).toHaveLength(1);
    expect(
      r2024.lines[0].consumed.map((lot) => [
        lot.acquisitionEventId,
        lot.amount,
      ]),
    ).toEqual([[expect.stringContaining('buy-2023'), ada(70)]]);

    expect(r2025.lines).toHaveLength(1);
    const consumed2025 = r2025.lines[0].consumed;
    expect(consumed2025).toHaveLength(2);
    expect(consumed2025[0].acquisitionEventId).toContain('buy-2023');
    expect(consumed2025[0].amount).toBe(ada(30));
    expect(consumed2025[1].acquisitionEventId).toContain('buy-2024');
    expect(consumed2025[1].amount).toBe(ada(10));

    const totals = new Map<string, bigint>();
    for (const lot of [...r2024.lines, ...r2025.lines].flatMap(
      (line) => line.consumed,
    )) {
      totals.set(
        lot.acquisitionEventId,
        (totals.get(lot.acquisitionEventId) ?? 0n) + BigInt(lot.amount),
      );
    }
    const byName = (name: string) =>
      [...totals.entries()].find(([id]) => id.includes(name))?.[1];
    expect(byName('buy-2023')).toBe(BigInt(ada(100)));
    expect(byName('buy-2024')).toBe(BigInt(ada(10)));
    expect(totals.size).toBe(2);
  });
});
