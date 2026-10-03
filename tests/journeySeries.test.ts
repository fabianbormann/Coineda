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
    expect(series).toEqual({
      points: [],
      acquisitions: [],
      disposals: [],
      assets: [],
      finalValue: null,
    });
  });

  it('folds the holdings at each monthly sample, in base units', async () => {
    // No price anywhere. The animation is about amounts, which come
    // straight out of the ledger - so the whole history draws offline, for
    // any year, with no rate limit and no 365-day window.
    vi.stubGlobal('fetch', flatRange(2));

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.points).toHaveLength(3);
    for (const point of series.points) {
      expect(point.holdings).toEqual([
        { assetId: 'cardano:lovelace', amount: '10000000' },
      ]);
    }
  });

  it('spends ONE request on the whole journey, however long it is', async () => {
    // The animation needs no prices at all; the single request is the spot
    // price behind the closing figure. This is what retired the hundreds of
    // historical lookups that made the journey fail against a rate limit it
    // could not even read the status of.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ cardano: { eur: 0.5 } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 11, 15), // twelve monthly samples
    });

    expect(series.points.length).toBeGreaterThan(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prices the closing figure from the spot price, scaled per asset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ cardano: { eur: 0.5 } }), {
            status: 200,
          }),
      ),
    );

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    // 10 ADA held, at 0.50 = 5. The holding is lovelace, so the per-asset
    // scale is part of the conversion - see src/prices/scale.ts.
    expect(series.finalValue).toBe('5');
  });

  it('still plays when the closing figure cannot be priced', async () => {
    // A provider outage costs the end card and nothing else. The journey is
    // the point; the figure is a garnish.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const series = await buildJourneySeries([reward()], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.finalValue).toBeNull();
    expect(series.points).toHaveLength(3);
    expect(series.assets).toEqual(['cardano:lovelace']);
  });

  it('gives a lane to an asset that was sold in full', async () => {
    // That a position went to nothing IS the story. Ranking by today's
    // value would put it last, but dropping it would make the journey
    // disagree with the ledger.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ cardano: { eur: 0.5 } }), {
            status: 200,
          }),
      ),
    );

    const sellAll: LedgerEvent = {
      id: 'sell-all',
      sourceId: 'src-1',
      externalId: 'sell-all',
      timestamp: Date.UTC(2025, 1, 10),
      kind: 'trade',
      origin: 'authored',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '10000000',
          direction: 'out',
          venue: 'wallet-a',
          role: 'principal',
        },
      ],
    };

    const series = await buildJourneySeries([reward(), sellAll], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.assets).toEqual(['cardano:lovelace']);
    expect(series.points[series.points.length - 1].holdings).toEqual([]);
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

  it('does not count moving your own coins between venues as anything', async () => {
    // A real internal move: the SAME asset leaving one owned venue and
    // arriving at another. It nets to zero and so is neither an acquisition
    // nor a disposal - which is the behaviour the old kind-based rule was
    // reaching for when it dropped every 'transfer', and the reason netting
    // can replace it without losing anything.
    vi.stubGlobal('fetch', flatRange(2));

    const internalMove: LedgerEvent = {
      id: 'move-1',
      sourceId: 'src-1',
      externalId: 'move-1',
      timestamp: Date.UTC(2025, 1, 10),
      kind: 'transfer',
      origin: 'derived',
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '4000000',
          direction: 'out',
          venue: 'wallet-a',
          role: 'principal',
        },
        {
          assetId: 'cardano:lovelace',
          amount: '4000000',
          direction: 'in',
          venue: 'wallet-b',
          role: 'principal',
        },
      ],
    };

    const series = await buildJourneySeries([reward(), internalMove], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.disposals).toEqual([]);
    // The reward is still the only acquisition - the move added nothing.
    expect(series.acquisitions).toHaveLength(1);
  });

  it('marks a chain receipt, which carries no kind but a real net gain', async () => {
    // The bug this rule change fixes: the Bitcoin module emits 'transfer'
    // for everything it drains, so under the old kind-based rule a Bitcoin
    // wallet produced no markers at all and its journey could only ever be
    // a line chart.
    vi.stubGlobal('fetch', flatRange(2));

    const received: LedgerEvent = {
      id: 'btc-in',
      sourceId: 'src-btc',
      externalId: 'btc-in',
      timestamp: Date.UTC(2025, 1, 10),
      kind: 'transfer',
      origin: 'derived',
      legs: [
        {
          assetId: 'bitcoin:native',
          amount: '150000',
          direction: 'in',
          venue: 'bc1qwallet',
          role: 'principal',
        },
      ],
    };

    const series = await buildJourneySeries([received], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.acquisitions).toEqual([
      {
        timestamp: Date.UTC(2025, 1, 10),
        assetId: 'bitcoin:native',
        amount: '150000',
      },
    ]);
  });

  it('nets a spend with change down to what actually left', async () => {
    // A Bitcoin spend is one event with an input and a change output, both
    // the user's own. The marker has to be the NET - what really left - or
    // every outgoing payment would look like a disposal of the whole input.
    vi.stubGlobal('fetch', flatRange(2));

    const spend: LedgerEvent = {
      id: 'btc-out',
      sourceId: 'src-btc',
      externalId: 'btc-out',
      timestamp: Date.UTC(2025, 1, 12),
      kind: 'transfer',
      origin: 'derived',
      legs: [
        {
          assetId: 'bitcoin:native',
          amount: '150000',
          direction: 'out',
          venue: 'bc1qwallet',
          role: 'principal',
        },
        {
          assetId: 'bitcoin:native',
          amount: '90000',
          direction: 'in',
          venue: 'bc1qwallet',
          role: 'principal',
        },
      ],
    };

    const series = await buildJourneySeries([spend], 'eur', {
      now: Date.UTC(2025, 2, 15),
    });

    expect(series.disposals).toEqual([
      {
        timestamp: Date.UTC(2025, 1, 12),
        assetId: 'bitcoin:native',
        amount: '60000',
      },
    ]);
  });
});
