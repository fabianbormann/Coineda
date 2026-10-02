import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, Leg } from '@/ledger/types';

/**
 * The seam between `isInternalTransfer` and `classify`.
 *
 * `isInternalTransfer` decides internal-versus-disposal on the per-asset
 * NET of an event's principal legs, and documents that a self-send is a
 * disposal of the fee. But the host used it only as a FILTER: whatever
 * survived went to `classify` with its raw UTXO legs, and every
 * jurisdiction maps every leg to its own tax event. So a transaction that
 * really disposed of 0.185 ADA in fees was reported as a disposal of
 * 19,997 ADA plus a re-acquisition of 19,997 ADA - the wallet's entire
 * unrealised gain realised on every transaction, and Germany's §23
 * one-year holding period reset each time, which puts the exemption out of
 * reach for any wallet that transacts at all.
 *
 * Both components were individually correct, which is why 389 tests missed
 * it. These tests therefore drive the REAL German module through the REAL
 * pipeline rather than a stub, because stub-only coverage is precisely
 * what let it through.
 *
 * Amounts are lovelace and the stubbed price is 1 EUR per whole ADA, so a
 * disposal of N ADA has proceeds of exactly N. See src/prices/scale.ts.
 */

const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';
const ACCOUNT = 'stake_test1_mine';

/** N whole ADA, in lovelace. */
const ada = (whole: number): string => `${whole}000000`;

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'amount' | 'direction'>,
): Leg =>
  ({
    assetId: ADA,
    venue: ACCOUNT,
    role: 'principal',
    ...overrides,
  }) as Leg;

const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e1',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [],
  ...overrides,
});

/** An acquisition the disposals below can be matched against, two years
 *  earlier so Germany's one-year holding period is comfortably satisfied. */
const oldAcquisition = event({
  id: 'acq',
  externalId: 'acq',
  timestamp: Date.UTC(2023, 0, 1),
  kind: 'reward',
  note: 'staking reward (member), epoch 1',
  raw: { epoch: 1, type: 'member' },
  legs: [leg({ amount: ada(1000), direction: 'in' })],
});

beforeEach(async () => {
  // Individually, not deleteDatabase(): that is a no-op while openLedger()
  // holds its memoised connection, which has produced a confidently-green
  // suite in this project twice. See tests/checkpointExport.test.ts.
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ market_data: { current_price: { eur: 1 } } }),
          { status: 200 },
        ),
    ),
  );
});

const runGermany = (year: number) =>
  runTaxReport(germanTax, { year, baseCurrency: 'eur' });

describe('the host nets an event before a jurisdiction classifies it', () => {
  it('reports a UTXO self-send as a disposal of the fee alone', async () => {
    // out 500, in 498 at the same account: the 2 ADA difference is the
    // implicit chain fee, which really did leave the user's control, and
    // it is the ONLY thing disposed of here.
    await putEvents([
      oldAcquisition,
      event({
        id: 'selfsend',
        externalId: 'selfsend',
        legs: [
          leg({ amount: ada(500), direction: 'out' }),
          leg({ amount: ada(498), direction: 'in' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].proceeds).toBe('2');
    expect(report.totals.computedFrom).toBe(1);
  });

  it('reports an outbound payment with change as a disposal of the net sent', async () => {
    // out 500, in 398: 100 ADA went to someone else and 2 ADA paid the
    // fee, so 102 left the user's control. Not 500.
    await putEvents([
      oldAcquisition,
      event({
        id: 'payment',
        externalId: 'payment',
        legs: [
          leg({ amount: ada(500), direction: 'out' }),
          leg({ amount: ada(398), direction: 'in' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].proceeds).toBe('102');
  });

  it('still reports a swap as a disposal of one asset and an acquisition of the other', async () => {
    // Netting is PER ASSET, so two different assets never cancel: the ADA
    // leaving is a disposal and the BTC arriving is an acquisition whose
    // cost basis a later BTC disposal must be able to consume. If netting
    // collapsed across assets, the later sale would have no basis and
    // would surface as `needs-cost-basis` instead.
    await putEvents([
      oldAcquisition,
      event({
        id: 'swap',
        externalId: 'swap',
        timestamp: Date.UTC(2025, 0, 1),
        kind: 'trade',
        legs: [
          leg({ amount: ada(100), direction: 'out' }),
          leg({ amount: '2', direction: 'in', assetId: BTC }),
        ],
      }),
      event({
        id: 'sell-btc',
        externalId: 'sell-btc',
        timestamp: Date.UTC(2025, 6, 1),
        kind: 'trade',
        legs: [
          leg({ amount: '2', direction: 'out', assetId: BTC }),
          leg({ amount: '7', direction: 'in', assetId: 'fiat:eur' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    const adaDisposal = report.lines.find((line) => line.assetId === ADA);
    const btcDisposal = report.lines.find((line) => line.assetId === BTC);

    // The ADA side of the swap is still a real disposal of 100 ADA.
    expect(adaDisposal?.proceeds).toBe('100');
    // And the BTC acquired by that same swap carried a cost basis forward,
    // so selling it is matched rather than unresolved.
    expect(btcDisposal?.costBasis).toBe('2');
    expect(
      report.unresolved.filter((item) => item.kind === 'needs-cost-basis'),
    ).toEqual([]);
  });

  it('does not reset Germany’s one-year holding period on a self-send', async () => {
    // The consequence that makes this a critical rather than a cosmetic
    // overstatement. Under gross legs the self-send re-acquires 498 ADA on
    // the day it happens, so the later sale consumes a lot six months old
    // and is fully taxable under §23. Netted, the sale still consumes the
    // 2023 lot and the gain is tax-free.
    //
    // The price has to RISE across the three dates for this test to be
    // able to fail at all: at a flat price the re-acquired lot costs
    // exactly what the sale fetches, so the gross path reports a zero gain
    // and looks identical to the correct one.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const eur = url.includes('-2023') ? 1 : url.includes('01-2025') ? 2 : 3;
        return new Response(
          JSON.stringify({ market_data: { current_price: { eur } } }),
          { status: 200 },
        );
      }),
    );

    // Exactly 500 ADA acquired in 2023, so the gross out-leg of 500 would
    // consume the whole old lot and leave the later sale nothing but the
    // self-send's own same-day re-acquisition. Sized deliberately: with a
    // larger old lot, FIFO reaches the 2023 lot either way and the test
    // could not fail.
    await putEvents([
      { ...oldAcquisition, legs: [leg({ amount: ada(500), direction: 'in' })] },
      event({
        id: 'selfsend',
        externalId: 'selfsend',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          leg({ amount: ada(500), direction: 'out' }),
          leg({ amount: ada(498), direction: 'in' }),
        ],
      }),
      event({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 6, 1),
        kind: 'trade',
        legs: [
          leg({ amount: ada(498), direction: 'out' }),
          leg({ amount: '498', direction: 'in', assetId: 'fiat:eur' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    const sale = report.lines.find((line) => line.disposalEventId === 'sell');
    expect(sale).toBeDefined();
    // 498 ADA sold at 3 against a 2023 cost of 1: a gain of 996, held for
    // more than a year, so the whole of it is exempt under §23 Abs. 1
    // Nr. 2 EStG and none of it is taxable.
    expect(sale?.exempt).toBe('996');
    expect(sale?.taxable).toBe('0');
  });

  it('leaves an explicit fee leg out of the net rather than folding it in', async () => {
    // A fee is paid to the network, not to a venue we own, so it is not
    // part of the principal net - the same rule isInternalTransfer
    // already applies. It survives netting as its own leg, so this event
    // yields the net principal disposal of 102 AND the fee's own disposal
    // of 3, never one blended figure of 105.
    await putEvents([
      oldAcquisition,
      event({
        id: 'with-fee',
        externalId: 'with-fee',
        legs: [
          leg({ amount: ada(500), direction: 'out' }),
          leg({ amount: ada(398), direction: 'in' }),
          leg({ amount: ada(3), direction: 'out', role: 'fee' }),
        ],
      }),
    ]);

    const report = await runGermany(2025);

    expect(report.lines.map((line) => line.proceeds).sort()).toEqual([
      '102',
      '3',
    ]);
  });
});
