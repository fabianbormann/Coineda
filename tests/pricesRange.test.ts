import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  FREE_TIER_DAYS,
  freeTierCutoff,
  fetchHistoricalPrices,
  CoinGeckoHistoryError,
} from '@/prices/coingecko';

/**
 * One request for a whole span, instead of one request per day.
 *
 * The per-day endpoint is what made a real tax report unusable: 80 events
 * meant up to 80 sequential requests, the keyless free tier answers 429
 * after four of them, and that 429 carries no access-control-allow-origin
 * header - so the browser cannot read it and reports `TypeError: Failed to
 * fetch`, which is what the owner actually saw. Fewer requests is therefore
 * not an optimisation here; it is the fix.
 */
const DAY = 86_400_000;

/** A UTC midnight, as CoinGecko's own per-day snapshot is defined. */
const midnight = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`);

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Days close enough to now to be inside the free tier. */
const recentDays = (count: number) => {
  const days: string[] = [];
  for (let i = count; i > 0; i -= 1) {
    days.push(isoOf(Date.now() - i * DAY));
  }
  return days;
};

const stubRange = (points: [number, number][]) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ prices: points }), { status: 200 });
    }),
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchHistoricalPrices', () => {
  it('asks for a whole span in ONE request', async () => {
    const days = recentDays(30);
    const calls = stubRange(
      days.map((d) => [midnight(d), 50_000] as [number, number]),
    );

    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', days);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/market_chart/range');
    expect(calls[0]).toContain('vs_currency=eur');
    expect(prices.size).toBe(30);
  });

  it('picks the point at UTC midnight for each day', async () => {
    // The per-day endpoint this replaces returns the snapshot at 00:00:00
    // UTC, and prices already cached were written under that meaning - so
    // the batched path has to agree, or a re-run silently revalues history.
    const [day] = recentDays(1);
    stubRange([
      [midnight(day) - 2 * 3_600_000, 111],
      [midnight(day), 222],
      [midnight(day) + 5 * 3_600_000, 333],
    ]);

    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', [day]);
    expect(prices.get(day)).toBe('222');
  });

  it('takes the closest point when none sits exactly on midnight', async () => {
    // An hourly series does not land on the second, and a daily one can be
    // minutes out. Nearest-to-midnight is the honest reading.
    const [day] = recentDays(1);
    stubRange([
      [midnight(day) + 40 * 60_000, 456],
      [midnight(day) + 13 * 3_600_000, 999],
    ]);

    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', [day]);
    expect(prices.get(day)).toBe('456');
  });

  it('leaves a day out rather than borrowing a price from another day', async () => {
    // A gap in the series must read as "no price", not as the nearest
    // neighbour: silently valuing Tuesday at Friday's price is the kind of
    // wrong number nobody would ever catch by looking.
    const days = recentDays(3);
    stubRange([[midnight(days[0]), 100]]);

    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', days);
    expect(prices.get(days[0])).toBe('100');
    expect(prices.has(days[1])).toBe(false);
    expect(prices.has(days[2])).toBe(false);
  });

  it('never asks for days older than the free tier can serve', async () => {
    // Asking for a span that starts before the cutoff 401s the WHOLE
    // request, which would lose the recent days too. So the request is
    // clamped and the old days are simply absent.
    const old = isoOf(Date.now() - (FREE_TIER_DAYS + 40) * DAY);
    const recent = recentDays(1)[0];
    const calls = stubRange([[midnight(recent), 777]]);

    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', [
      old,
      recent,
    ]);

    expect(prices.get(recent)).toBe('777');
    expect(prices.has(old)).toBe(false);
    const from = Number(/from=(\d+)/.exec(calls[0])![1]) * 1000;
    expect(from).toBeGreaterThanOrEqual(freeTierCutoff() - DAY);
  });

  it('makes no request at all when every day is too old', async () => {
    const calls = stubRange([]);
    const prices = await fetchHistoricalPrices('bitcoin:native', 'eur', [
      isoOf(Date.now() - (FREE_TIER_DAYS + 200) * DAY),
    ]);
    expect(prices.size).toBe(0);
    // Spending a request to be told what the cutoff already says would be
    // one more chance to be rate-limited for nothing.
    expect(calls).toHaveLength(0);
  });

  it('returns nothing for an asset it cannot price, without asking', async () => {
    const calls = stubRange([]);
    const prices = await fetchHistoricalPrices(
      'cardano:somenativetoken',
      'eur',
      recentDays(1),
    );
    expect(prices.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('throws with the status so a caller can tell a rate limit apart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429 })),
    );
    await expect(
      fetchHistoricalPrices('bitcoin:native', 'eur', recentDays(1)),
    ).rejects.toBeInstanceOf(CoinGeckoHistoryError);
  });

  it('sends the api key as a header, never in the url', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ prices: [] }), { status: 200 });
      }),
    );

    await fetchHistoricalPrices(
      'bitcoin:native',
      'eur',
      recentDays(1),
      'secret-key',
    );
    expect(calls[0].url).not.toContain('secret-key');
    expect(
      (calls[0].init?.headers as Record<string, string>)['x-cg-demo-api-key'],
    ).toBe('secret-key');
  });
});
