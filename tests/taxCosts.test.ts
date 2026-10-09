import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * Trade fees end to end: the German module attaches them, the host values
 * them, the matcher deducts them, and the report shows what came off.
 * Through the REAL pipeline, because the defect this covers lived in the
 * seam between a jurisdiction that dropped fiat fee legs and a host that
 * never asked - and every unit test on either side was green.
 *
 * Amounts are lovelace and the stubbed price is 1 EUR per whole ADA.
 */

const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';
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

/** 1000 ADA bought for 1000 EUR two years earlier, fee-free. */
const oldBuy = event({
  id: 'buy',
  externalId: 'buy',
  timestamp: Date.UTC(2023, 0, 1),
  legs: [
    leg({ assetId: EUR, amount: '1000', direction: 'out' }),
    leg({ assetId: ADA, amount: ada(1000), direction: 'in' }),
  ],
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  // Keyed, because the scenarios span more than the free tier's 365 days.
  await db.put('settings', {
    key: 'settings',
    value: { language: 'en', baseCurrency: 'eur', coingeckoApiKey: 'test-key' },
  });
  vi.stubGlobal('fetch', flatRange(1));
});

const runGermany = (year: number) =>
  runTaxReport(germanTax, { year, baseCurrency: 'eur' });

describe('trade fees reach the gain', () => {
  it('deducts a fiat fee on a sell from the proceeds', async () => {
    await putEvents([
      oldBuy,
      event({
        id: 'sell',
        externalId: 'sell',
        legs: [
          leg({ assetId: ADA, amount: ada(100), direction: 'out' }),
          leg({ assetId: EUR, amount: '100', direction: 'in' }),
          leg({ assetId: EUR, amount: '1', direction: 'out', role: 'fee' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].proceeds).toBe('99');
    expect(report.lines[0].costs).toBe('1');
    expect(report.lines[0].costBasis).toBe('100');
    expect(report.lines[0].gain).toBe('-1');
    expect(report.unresolved).toHaveLength(0);
  });

  it('adds a fiat fee on a buy to the cost basis of the lot', async () => {
    await putEvents([
      event({
        id: 'buy-with-fee',
        externalId: 'buy-with-fee',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          leg({ assetId: EUR, amount: '100', direction: 'out' }),
          leg({ assetId: ADA, amount: ada(100), direction: 'in' }),
          leg({ assetId: EUR, amount: '2', direction: 'out', role: 'fee' }),
        ],
      }),
      event({
        id: 'sell',
        externalId: 'sell',
        legs: [
          leg({ assetId: ADA, amount: ada(100), direction: 'out' }),
          leg({ assetId: EUR, amount: '100', direction: 'in' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].costBasis).toBe('102');
    expect(report.lines[0].consumed[0].costBasis).toBe('102');
    expect(report.lines[0].gain).toBe('-2');
  });

  it('deducts a crypto fee on a swap once, and disposes of the fee coins', async () => {
    await putEvents([
      oldBuy,
      event({
        id: 'swap',
        externalId: 'swap',
        legs: [
          leg({ assetId: ADA, amount: ada(100), direction: 'out' }),
          leg({ assetId: BTC, amount: '1', direction: 'in' }),
          leg({ assetId: ADA, amount: ada(1), direction: 'out', role: 'fee' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    const byAmount = new Map(report.lines.map((line) => [line.amount, line]));
    const swap = byAmount.get(ada(100));
    const fee = byAmount.get(ada(1));
    expect(swap?.proceeds).toBe('99');
    expect(swap?.costs).toBe('1');
    expect(fee?.proceeds).toBe('1');
    expect(fee?.costs).toBe('0');
    // 101 ADA left the 1000-ADA lot: the swap's 100 and the fee's 1.
    expect(report.lines.map((line) => line.costBasis).sort()).toEqual([
      '1',
      '100',
    ]);
  });

  it('lists a fee it cannot price and computes the trade without it', async () => {
    // REVIEW FOCUS 2.
    await putEvents([
      oldBuy,
      event({
        id: 'sell',
        externalId: 'sell',
        legs: [
          leg({ assetId: ADA, amount: ada(100), direction: 'out' }),
          leg({ assetId: EUR, amount: '100', direction: 'in' }),
          leg({
            assetId: 'cardano:deadbeef.NoSuchToken',
            amount: '7',
            direction: 'out',
            role: 'fee',
          }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    const sell = report.lines.find((line) => line.amount === ada(100));
    expect(sell?.proceeds).toBe('100');
    expect(sell?.costs).toBe('0');

    // Two gaps, both naming the fee's asset: the fee coins' OWN disposal
    // (a crypto fee always leaves the holdings, and that disposal could
    // not be priced either - it is the one omitted disposal), and the
    // cost entry on the sell, which carries no taxEventKind because the
    // sell itself was computed.
    const unpriced = report.unresolved.filter(
      (item) => item.assetId === 'cardano:deadbeef.NoSuchToken',
    );
    expect(unpriced).toHaveLength(2);
    expect(unpriced.map((item) => item.taxEventKind).sort()).toEqual([
      'disposal',
      undefined,
    ]);
    expect(report.totals.omitted).toBe(1);
  });

  it('does not deduct gas on a transfer to a third party', async () => {
    // REVIEW FOCUS 1, end to end.
    await putEvents([
      oldBuy,
      event({
        id: 'gift',
        externalId: 'gift',
        kind: 'transfer',
        legs: [
          leg({ assetId: ADA, amount: ada(10), direction: 'out' }),
          leg({ assetId: ADA, amount: ada(1), direction: 'out', role: 'fee' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines.map((line) => line.proceeds).sort()).toEqual([
      '1',
      '10',
    ]);
    expect(report.lines.every((line) => line.costs === '0')).toBe(true);
  });
});
