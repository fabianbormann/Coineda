import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import krakenCsv from '@/sources/kraken-csv';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange, rangeStub } from './priceRangeStub';

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
    // ADA at 1 EUR before 2025 and 2 EUR from then on, so the identity
    // below is proved at a price that moved, not only at a flat one.
    vi.stubGlobal(
      'fetch',
      rangeStub((isoDate) => (isoDate < '2025-01-01' ? 1 : 2)),
    );
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

    // The lot is 1000 ADA at a cost of 1000. The swap disposes of 100 ADA
    // worth 200 and pays a 1-ADA fee worth 2: its proceeds are 200 - 2.
    // The fee coins are a disposal of their own, worth 2, from the same
    // lot at a cost of 1. Total gain 98 + 1 = 99 = (200 - 100) - 1, the
    // fee coins' original cost - so the fee is deducted exactly once.
    const byAmount = new Map(report.lines.map((line) => [line.amount, line]));
    const swap = byAmount.get(ada(100));
    const fee = byAmount.get(ada(1));
    expect(swap?.proceeds).toBe('198');
    expect(swap?.costBasis).toBe('100');
    expect(swap?.gain).toBe('98');
    expect(swap?.costs).toBe('2');
    expect(fee?.proceeds).toBe('2');
    expect(fee?.costBasis).toBe('1');
    expect(fee?.gain).toBe('1');
    expect(fee?.costs).toBe('0');
    expect(report.lines).toHaveLength(2);
  });

  it('lists a fee it cannot price and computes the trade without it', async () => {
    // An unpriced fee must be listed as a gap, never deducted as zero, and
    // must not stop the trade itself from being computed.
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
    // The cost entry says it is a fee that was not deducted; the fee
    // coins' own disposal does not.
    const costEntry = unpriced.find((item) => item.taxEventKind === undefined);
    const ownDisposal = unpriced.find(
      (item) => item.taxEventKind === 'disposal',
    );
    expect(costEntry?.subject).toBe('cost');
    expect(ownDisposal?.subject).toBeUndefined();
    expect(report.totals.omitted).toBe(1);
  });

  it('does not deduct gas on a transfer to a third party', async () => {
    // Gas on a send to someone else is not a cost of any sale: the fee
    // coins are disposed of, but nothing is deducted. End to end.
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

describe('income rows', () => {
  it('prints a staking reward with its value, venue and the module note', async () => {
    await putEvents([
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

    const report = await runGermany(2025);

    expect(report.income).toHaveLength(1);
    expect(report.income[0]).toMatchObject({
      assetId: ADA,
      amount: ada(5),
      venue: 'stake1',
      value: '5',
    });
    expect(report.income[0].note).toMatch(/gewerbliche Einkünfte/);
  });
});

describe('a real Kraken export', () => {
  it('deducts the fee Kraken charges on the quote row of a buy', async () => {
    // Kraken writes a trade as one row per asset and charges the fee on
    // the euro row. Read row by row, that euro row was an event of its own
    // with no crypto leg to carry the fee, and the 1.30 EUR never reached
    // the cost basis. The parser groups a trade's rows, so it does now.
    //
    // Bitcoin is priced at 60,000 EUR, so the 0.01 BTC the fixture buys
    // would be worth 600 at market - but 500 EUR is what was paid, and
    // that, plus the 1.30 fee, is the lot's cost basis. Market price no
    // longer enters a euro trade at all.
    vi.stubGlobal('fetch', flatRange(60000));
    const text = readFileSync(
      path.join(__dirname, '../src/sources/kraken-csv/fixtures/ledgers.csv'),
      'utf8',
    );
    const { events } = krakenCsv.parse(text);
    const imported: LedgerEvent[] = events.map((derived, index) => ({
      ...derived,
      id: `kraken-${index}`,
      sourceId: 'kraken',
    }));
    // Found by its bitcoin leg, not its id, so this reads the same event
    // whether the parser groups the trade or not.
    const buy = imported.find(
      (row) =>
        row.kind === 'trade' &&
        row.legs.some((one) => one.assetId === BTC && one.direction === 'in'),
    );
    const wallet = buy?.legs.find((row) => row.assetId === BTC)?.venue;
    expect(wallet).toBeDefined();

    await putEvents([
      ...imported,
      event({
        id: 'sell',
        sourceId: 'authored',
        externalId: 'sell',
        origin: 'authored',
        timestamp: Date.UTC(2025, 5, 1),
        legs: [
          leg({
            assetId: BTC,
            amount: '1000000',
            direction: 'out',
            venue: wallet,
          }),
          leg({ assetId: EUR, amount: '600', direction: 'in', venue: wallet }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    // The fixture's 2024 withdrawal took 0.005 BTC plus a 0.00005 BTC fee
    // out of the lot first, so the sell matches the 0.00495 BTC left:
    // 0.495 of the 501.3 EUR lot.
    const sell = report.lines.find((line) => line.disposalEventId === 'sell');
    expect(sell?.amount).toBe('495000');
    expect(sell?.costBasis).toBe('248.1435');
    expect(sell?.consumed).toHaveLength(1);
    expect(sell?.consumed[0].acquisitionEventId).toBe(buy?.id);
    expect(sell?.consumed[0].costBasis).toBe('248.1435');

    // Named rather than waved through: the rest of the sell, which the
    // fixture's withdrawal already consumed, has no lot. The spot-to-staking
    // move is one event now and nets to nothing.
    expect(
      report.unresolved.map((item) => [
        item.kind,
        item.sourceEventId,
        item.assetId,
        item.amount,
      ]),
    ).toEqual([['needs-cost-basis', 'sell', BTC, '505000']]);
  });
});
