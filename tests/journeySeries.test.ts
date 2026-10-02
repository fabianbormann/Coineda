import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger } from '@/ledger/db';
import { buildJourneySeries, monthlySampleTimestamps } from '@/journey/series';
import type { LedgerEvent } from '@/ledger/types';

const reward = (overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: 'reward-1',
  sourceId: 'src-1',
  externalId: 'reward-1',
  timestamp: Date.UTC(2025, 0, 15),
  kind: 'reward',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      // 10 ADA, in the base unit the ledger stores - a price is per whole
      // unit, so the scale matters to every total below. See
      // src/prices/scale.ts.
      amount: '10000000',
      direction: 'in',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
  ...overrides,
});

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('prices');
  vi.unstubAllGlobals();
});

describe('monthlySampleTimestamps', () => {
  it('samples once per calendar month between the first event and now, inclusive', () => {
    const first = Date.UTC(2025, 0, 15); // 15 Jan 2025
    const now = Date.UTC(2025, 2, 15); // 15 Mar 2025, two months later
    expect(monthlySampleTimestamps(first, now)).toEqual([
      Date.UTC(2025, 0, 15),
      Date.UTC(2025, 1, 15),
      Date.UTC(2025, 2, 15),
    ]);
  });

  it('clamps a day-of-month that would otherwise overflow into a later month', () => {
    // 31 Jan + 1 month must land on 28 Feb 2025 (not a leap year), never
    // slide into 3 Mar the way naive Date.UTC(year, month+1, 31) would.
    const first = Date.UTC(2025, 0, 31);
    const now = Date.UTC(2025, 2, 31);
    const samples = monthlySampleTimestamps(first, now);
    expect(samples[1]).toBe(Date.UTC(2025, 1, 28));
  });

  it('returns just the first timestamp when now is not after it', () => {
    const first = Date.UTC(2025, 0, 15);
    expect(monthlySampleTimestamps(first, first)).toEqual([first]);
  });
});

describe('buildJourneySeries', () => {
  it('returns an empty series for an empty ledger', async () => {
    const series = await buildJourneySeries([], 'eur');
    expect(series).toEqual({ points: [], acquisitions: [] });
  });

  it('folds holdings at each monthly sample and prices them on that sample’s UTC day', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ market_data: { current_price: { eur: 2 } } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.UTC(2025, 2, 15); // two months after the reward
    const series = await buildJourneySeries([reward()], 'eur', { now });

    expect(series.points).toHaveLength(3);
    for (const point of series.points) {
      expect(point.holdings).toEqual([
        { assetId: 'cardano:lovelace', amount: '10000000' },
      ]);
      // 10 ADA at a price of 2 = 20, as a decimal string.
      expect(point.totalValue).toBe('20');
    }

    // One fetch per distinct (asset, day) pair - three sample months, not
    // one lookup per day in between. This is the bound monthly sampling
    // exists for.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A buy/earn event becomes an acquisition marker: asset, when, how much.
    expect(series.acquisitions).toEqual([
      {
        timestamp: Date.UTC(2025, 0, 15),
        assetId: 'cardano:lovelace',
        amount: '10000000',
      },
    ]);
  });

  it('never asks the provider twice for the same (asset, day) pair - a second run costs nothing', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ market_data: { current_price: { eur: 2 } } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.UTC(2025, 1, 15); // one month after the reward
    await buildJourneySeries([reward()], 'eur', { now });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await buildJourneySeries([reward()], 'eur', { now });
    // The second run hits the permanent (assetId, currency, day) cache for
    // every pair the first run already resolved, so no new fetches happen.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks a point unpriced rather than reporting it as zero when the provider has no data for that day', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );

    const now = Date.UTC(2025, 0, 15); // same day as the reward
    const series = await buildJourneySeries([reward()], 'eur', { now });

    expect(series.points).toHaveLength(1);
    // Real, non-zero holdings exist at this point - a provider failure
    // must leave totalValue null, never fabricate '0', which would draw a
    // cliff in the chart that never happened.
    expect(series.points[0].holdings).not.toEqual([]);
    expect(series.points[0].totalValue).toBeNull();
  });

  it('excludes transfers from acquisition markers - moving your own assets is not buying them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ market_data: { current_price: { eur: 2 } } }),
            { status: 200 },
          ),
      ),
    );

    const transfer: LedgerEvent = {
      id: 'transfer-1',
      sourceId: 'src-1',
      externalId: 'transfer-1',
      timestamp: Date.UTC(2025, 0, 20),
      kind: 'transfer',
      origin: 'derived',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '5',
          direction: 'out',
          venue: 'wallet-a',
          role: 'principal',
        },
        {
          assetId: 'cardano:lovelace',
          amount: '5',
          direction: 'in',
          venue: 'wallet-b',
          role: 'principal',
        },
      ],
    };

    const now = Date.UTC(2025, 0, 25);
    const series = await buildJourneySeries([reward(), transfer], 'eur', {
      now,
    });

    expect(series.acquisitions).toEqual([
      {
        timestamp: Date.UTC(2025, 0, 15),
        assetId: 'cardano:lovelace',
        amount: '10000000',
      },
    ]);
  });
});
