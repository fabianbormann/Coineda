import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger } from '@/ledger/db';
import { buildJourneySeries, monthlySampleTimestamps } from '@/journey/series';
import type { LedgerEvent } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

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
  // Prices are only requested for days the free tier can serve, which is
  // decided locally against the clock - so these 2025 fixtures need a clock
  // that sits just after them, or nothing is asked for at all. Deciding
  // locally is deliberate: CoinGecko's 401 carries no CORS header, so a
  // browser cannot read it and would see only "Failed to fetch".
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2025-04-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(series).toEqual({ points: [], acquisitions: [], disposals: [] });
  });

  it('folds holdings at each monthly sample and prices them on that sample’s UTC day', async () => {
    const fetchMock = flatRange(2);
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

    // ONE request for all three sample months, not one per month. Monthly
    // sampling still bounds how many DAYS are priced; batching bounds how
    // many requests that costs, which is what stopped the journey dying on
    // a rate limit it could not even read the status of.
    expect(fetchMock).toHaveBeenCalledTimes(1);

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
    const fetchMock = flatRange(2);
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.UTC(2025, 1, 15); // one month after the reward
    await buildJourneySeries([reward()], 'eur', { now });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await buildJourneySeries([reward()], 'eur', { now });
    // The second run hits the permanent (assetId, currency, day) cache for
    // every pair the first run already resolved, so no new fetches happen.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    vi.stubGlobal('fetch', flatRange(2));

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

describe('carrying a value over an unpriced sample', () => {
  /** Prices only the days this set names; every other day comes back empty,
   *  which is what an unpriceable month looks like to the series. */
  const priceOnly = (days: string[]) =>
    vi.fn(async (url: string) => {
      const from = Number(/from=(\d+)/.exec(String(url))![1]) * 1000;
      const to = Number(/to=(\d+)/.exec(String(url))![1]) * 1000;
      const prices: [number, number][] = [];
      for (
        let at = Math.ceil(from / 86_400_000) * 86_400_000;
        at <= to;
        at += 86_400_000
      ) {
        const day = new Date(at).toISOString().slice(0, 10);
        if (days.includes(day)) {
          prices.push([at, 2]);
        }
      }
      return new Response(JSON.stringify({ prices }), { status: 200 });
    });

  it('reaches BACKWARD to fill a run of unpriced samples at the start', async () => {
    // The reported complaint: the opening seconds of the video said "Not
    // enough priced history yet" over an empty frame. There is nothing
    // earlier to carry forward from, so the first value that IS known
    // reaches back - which is what removes the dead opening.
    vi.stubGlobal('fetch', priceOnly(['2025-03-15']));

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.totalValue)).toEqual(['20', '20', '20']);
    // Flagged, every one of them, except the sample that was really priced.
    expect(series.points.map((p) => p.carried === true)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('carries FORWARD over a hole in the middle', async () => {
    vi.stubGlobal('fetch', priceOnly(['2025-01-15', '2025-03-15']));

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.points.map((p) => p.carried === true)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('leaves every sample null when nothing at all could be priced', async () => {
    // The genuinely empty case has to survive: with no priced sample there
    // is nothing to carry, and the renderer still needs its "not enough
    // history" frame rather than a flat line through zero.
    vi.stubGlobal('fetch', priceOnly([]));

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.points.every((p) => p.totalValue === null)).toBe(true);
    expect(series.points.some((p) => p.carried)).toBe(false);
  });
});

describe('disposal markers', () => {
  const sale = (): LedgerEvent => ({
    id: 'sale-1',
    sourceId: 'src-1',
    externalId: 'sale-1',
    timestamp: Date.UTC(2025, 1, 10),
    kind: 'trade',
    origin: 'authored',
    legs: [
      {
        assetId: 'cardano:lovelace',
        amount: '4000000',
        direction: 'out',
        venue: 'wallet-a',
        role: 'principal',
      },
      {
        assetId: 'fiat:eur',
        amount: '8',
        direction: 'in',
        venue: 'wallet-a',
        role: 'principal',
      },
    ],
  });

  it('records what left, so the scene can shrink as well as grow', async () => {
    vi.stubGlobal('fetch', flatRange(2));

    const series = await buildJourneySeries([reward(), sale()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.disposals).toEqual([
      {
        timestamp: Date.UTC(2025, 1, 10),
        assetId: 'cardano:lovelace',
        amount: '4000000',
      },
    ]);
    // The fiat side of the trade is not a disposal of anything the journey
    // tracks, and the reward is still an acquisition.
    expect(series.acquisitions).toHaveLength(1);
  });

  it('does not count moving your own coins between venues as a disposal', async () => {
    // Symmetric with the acquisition rule: a 'transfer' is excluded in both
    // directions, or every wallet-to-wallet move would read as a sale.
    vi.stubGlobal('fetch', flatRange(2));

    const series = await buildJourneySeries(
      [
        reward(),
        { ...sale(), id: 'move-1', externalId: 'move-1', kind: 'transfer' },
      ],
      'eur',
      { now: Date.UTC(2025, 2, 15) },
    );

    expect(series.disposals).toEqual([]);
  });
});
