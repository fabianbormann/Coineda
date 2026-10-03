import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resolveValues } from '@/tax/resolveValues';
import { toCoinGeckoDate } from '@/prices/coingecko';
import { openLedger } from '@/ledger/db';
import type { TaxEvent } from '@/tax/types';

const event = (overrides: Partial<TaxEvent>): TaxEvent => ({
  sourceEventId: 'e1',
  kind: 'disposal',
  assetId: 'cardano:lovelace',
  amount: '10',
  timestamp: Date.UTC(2026, 8, 15, 12, 0, 0),
  venue: 'wallet-a',
  ...overrides,
});

const DAY = 86_400_000;

/**
 * A faithful stand-in for `market_chart/range`: reads the window out of the
 * URL and answers with a daily point at each UTC midnight in it, which is
 * what the real endpoint does for any span over 90 days.
 *
 * Generated from the request rather than hardcoded so a test does not have
 * to know which days the resolver decided it needed - and so a resolver that
 * asked for the WRONG window produces no price here rather than quietly
 * getting the right one anyway.
 */
const rangeStub = (priceFor: (isoDate: string) => number) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url: string) => {
      const from = Number(/from=(\d+)/.exec(String(url))![1]) * 1000;
      const to = Number(/to=(\d+)/.exec(String(url))![1]) * 1000;
      const prices: [number, number][] = [];
      for (let t = Math.ceil(from / DAY) * DAY; t <= to; t += DAY) {
        prices.push([t, priceFor(new Date(t).toISOString().slice(0, 10))]);
      }
      return new Response(JSON.stringify({ prices }), { status: 200 });
    },
  );

const flatRange = (eur: number) => rangeStub(() => eur);

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['prices', 'settings'] as const) {
    await db.clear(store);
  }
  vi.useRealTimers();
});

describe('toCoinGeckoDate', () => {
  it('converts an ISO date to the day-first format the provider wants', () => {
    // The provider is dd-mm-yyyy and the cache key is YYYY-MM-DD. Getting
    // this backwards fetches a different day's price and the response says
    // nothing about which day it answered, so the wrong number looks right.
    expect(toCoinGeckoDate('2024-04-15')).toBe('15-04-2024');
  });

  it('keeps an ambiguous date unambiguous', () => {
    // 5 June, not 6 May. This is the pair that a swapped conversion gets
    // wrong while still returning a valid price.
    expect(toCoinGeckoDate('2024-06-05')).toBe('05-06-2024');
  });

  it('pads single-digit days and months', () => {
    expect(toCoinGeckoDate('2024-01-02')).toBe('02-01-2024');
  });

  it('rejects anything that is not an ISO date', () => {
    expect(() => toCoinGeckoDate('15-04-2024')).toThrow();
    expect(() => toCoinGeckoDate('2024/04/15')).toThrow();
  });
});

describe('resolveValues', () => {
  it('values an event from the price on its own UTC day', async () => {
    // 0.35 ONLY on the event's own UTC day, a wildly different price on
    // every other day in the window. The value assertion below therefore
    // proves which day was picked - the previous version asserted the
    // dd-mm-yyyy in the URL, which the batched request no longer carries.
    vi.stubGlobal(
      'fetch',
      rangeStub((isoDate) => (isoDate === '2026-09-15' ? 0.35 : 999)),
    );

    // 10 ADA, in lovelace: the provider's price is per whole ADA, so the
    // amount has to be scaled by 10^6 (src/prices/scale.ts).
    const { valued, unpriced } = await resolveValues(
      [event({ amount: '10000000' })],
      'eur',
    );

    expect(unpriced).toHaveLength(0);
    // 10 ADA at 0.35 = 3.5, as a decimal string.
    expect(valued[0].value).toBe('3.5');
  });

  it('fetches each distinct day once however many events share it', async () => {
    // A tax run can touch hundreds of events. The provider rate-limits
    // hard, and a historical price for a past day never changes, so one
    // fetch per (asset, currency, day) is the difference between a report
    // that completes and one that gets throttled.
    const fetchMock = flatRange(1);
    vi.stubGlobal('fetch', fetchMock);

    const day = Date.UTC(2026, 8, 15, 1, 0, 0);
    await resolveValues(
      [
        event({ sourceEventId: 'a', timestamp: day }),
        event({ sourceEventId: 'b', timestamp: day + 3_600_000 }),
        event({ sourceEventId: 'c', timestamp: day + 7_200_000 }),
      ],
      'eur',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prices eighty days in ONE request, not eighty', async () => {
    // The reported failure, as a test. A report needing 80 days priced
    // issued 80 sequential requests; the keyless free tier answers 429
    // after about four, and that 429 carries no CORS header - so the
    // browser could not read it and showed "Failed to fetch" against most
    // of the user's events, with nothing anywhere explaining why.
    const fetchMock = flatRange(3);
    vi.stubGlobal('fetch', fetchMock);

    const base = Date.UTC(2026, 6, 1, 12, 0, 0);
    const events = Array.from({ length: 80 }, (_, i) =>
      event({ sourceEventId: `e${i}`, timestamp: base + i * DAY }),
    );

    const { valued, unpriced } = await resolveValues(events, 'eur');

    expect(unpriced).toHaveLength(0);
    expect(valued).toHaveLength(80);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks one request per asset, not one per asset-day', async () => {
    const fetchMock = flatRange(1);
    vi.stubGlobal('fetch', fetchMock);

    const base = Date.UTC(2026, 6, 1, 12, 0, 0);
    await resolveValues(
      [
        event({ sourceEventId: 'a1', timestamp: base }),
        event({ sourceEventId: 'a2', timestamp: base + DAY }),
        event({
          sourceEventId: 'b1',
          assetId: 'bitcoin:native',
          amount: '100000000',
          timestamp: base,
        }),
        event({
          sourceEventId: 'b2',
          assetId: 'bitcoin:native',
          amount: '100000000',
          timestamp: base + DAY,
        }),
      ],
      'eur',
    );

    // Two assets, two days each: two requests, because a span is per asset.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves a second run entirely from cache', async () => {
    const fetchMock = flatRange(2);
    vi.stubGlobal('fetch', fetchMock);

    await resolveValues([event({})], 'eur');
    await resolveValues([event({})], 'eur');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('values the base currency itself at one without asking anybody', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('must not be called');
      }),
    );

    const { valued } = await resolveValues(
      [event({ assetId: 'fiat:eur', amount: '250' })],
      'eur',
    );

    expect(valued[0].value).toBe('250');
  });

  it('reports an event older than the free tier with a reason naming the limit', async () => {
    // The free tier covers 365 days. A 2022 report cannot be priced from
    // it, and the honest answer is to say exactly that - not to fail the
    // whole report and not to guess a price.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    const { valued, unpriced } = await resolveValues(
      [event({ timestamp: Date.UTC(2022, 0, 10) })],
      'eur',
    );

    expect(valued).toHaveLength(0);
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0].reason).toMatch(/365|historical/i);
  });

  it('reports an unmapped asset rather than pricing it at nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    const { valued, unpriced } = await resolveValues(
      [event({ assetId: 'cardano:somenativetoken' })],
      'eur',
    );

    expect(valued).toHaveLength(0);
    expect(unpriced[0].assetId).toBe('cardano:somenativetoken');
  });

  it('keeps a value as a decimal string with no float round-trip', async () => {
    vi.stubGlobal('fetch', flatRange(0.1));

    const { valued } = await resolveValues(
      [event({ amount: '3000000' })],
      'eur',
    );

    // 3 ADA at 0.1 is 0.30000000000000004 in float arithmetic.
    expect(valued[0].value).toBe('0.3');
  });

  it('sends a configured CoinGecko key as a header, never in the URL', async () => {
    const db = await openLedger();
    await db.put('settings', {
      key: 'settings',
      value: {
        language: 'en',
        baseCurrency: 'eur',
        coingeckoApiKey: 'cg-demo-key',
      },
    });

    // Typed with fetch's real (url, init) parameters - not left to infer as
    // () => ... - so the tuple destructured below actually type-checks
    // against what fetchHistoricalPrice calls fetch with.
    const fetchMock = flatRange(1);
    vi.stubGlobal('fetch', fetchMock);

    await resolveValues([event({})], 'eur');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain('cg-demo-key');
    expect((init.headers as Record<string, string>)['x-cg-demo-api-key']).toBe(
      'cg-demo-key',
    );
  });

  it('never puts the API key in a reason a user will read', async () => {
    const db = await openLedger();
    await db.put('settings', {
      key: 'settings',
      value: {
        language: 'en',
        baseCurrency: 'eur',
        coingeckoApiKey: 'cg-secret',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const { unpriced } = await resolveValues([event({})], 'eur');

    expect(unpriced[0].reason).not.toContain('cg-secret');
  });
});
