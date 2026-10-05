import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { fetchUsdHistory, NEAREST_LIMIT_MS } from '@/prices/defillama';
import { fetchUsdRates, MAX_CARRY_DAYS } from '@/prices/ecb';
import { fetchHistory, inCurrency } from '@/prices/history';
import { resolveValues } from '@/tax/resolveValues';
import { openLedger } from '@/ledger/db';
import type { TaxEvent } from '@/tax/types';

/**
 * The deep history path: DefiLlama for the price, the ECB for the rate,
 * CoinGecko only for what is left.
 *
 * The reason it exists is a hard limit, not a preference: CoinGecko's free
 * tier refuses anything older than 365 days, and a disposal's cost basis is
 * routinely an acquisition several years earlier - exactly the figure it
 * will not serve.
 */
const DAY = 86_400_000;
const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';

const seconds = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 1000;

const llamaBody = (points: Record<string, [number, number][]>): string =>
  JSON.stringify({
    coins: Object.fromEntries(
      Object.entries(points).map(([coin, list]) => [
        coin,
        { prices: list.map(([timestamp, price]) => ({ timestamp, price })) },
      ]),
    ),
  });

const ratesBody = (rates: Record<string, number>): string =>
  JSON.stringify({
    base: 'USD',
    rates: Object.fromEntries(
      Object.entries(rates).map(([day, value]) => [day, { EUR: value }]),
    ),
  });

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['prices', 'settings'] as const) {
    await db.clear(store);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DefiLlama history', () => {
  it('takes every asset and every day in ONE request', async () => {
    // The whole reason for choosing it. CoinGecko needs one request per
    // asset; this takes the entire report at once, which is what a free
    // tier's rate limit cannot be provoked by.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(
          llamaBody({
            'coingecko:cardano': [[seconds('2021-06-01'), 1.74]],
            'coingecko:bitcoin': [[seconds('2021-06-01'), 36663.45]],
          }),
          { status: 200 },
        );
      }),
    );

    const prices = await fetchUsdHistory(
      new Map([
        [ADA, ['2021-06-01']],
        [BTC, ['2021-06-01']],
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(prices.get(`${ADA}|2021-06-01`)).toBe('1.74');
    expect(prices.get(`${BTC}|2021-06-01`)).toBe('36663.45');
  });

  it('refuses a point too far from the day it is meant to represent', async () => {
    // It returns the NEAREST observation, not a daily close, so a day with
    // no data comes back as a neighbour's price rather than as a gap.
    // Measured drift on real data was under an hour; this is the illiquid
    // asset whose nearest point is a week away.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            llamaBody({
              'coingecko:cardano': [
                [seconds('2021-06-01') + NEAREST_LIMIT_MS / 1000 + 60, 99],
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const prices = await fetchUsdHistory(new Map([[ADA, ['2021-06-01']]]));
    expect(prices.size).toBe(0);
  });

  it('accepts a point inside the window', async () => {
    // The companion proof: the guard must not swallow the ordinary case,
    // where the nearest observation is minutes away.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            llamaBody({
              'coingecko:cardano': [[seconds('2021-06-01') + 900, 1.74]],
            }),
            { status: 200 },
          ),
      ),
    );
    const prices = await fetchUsdHistory(new Map([[ADA, ['2021-06-01']]]));
    expect(prices.get(`${ADA}|2021-06-01`)).toBe('1.74');
  });

  it('asks nothing at all for an asset it has no id for', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const prices = await fetchUsdHistory(
      new Map([['cardano:somepolicy', ['2021-06-01']]]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prices.size).toBe(0);
  });
});

describe('ECB rates', () => {
  it('carries a weekend back to the last published day', async () => {
    // The ECB publishes on business days only. 2021-06-05 is a Saturday,
    // and the real service answers it with Friday's rate and says so by
    // returning the earlier date.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(ratesBody({ '2021-06-04': 0.82529 }), { status: 200 }),
      ),
    );
    const rates = await fetchUsdRates(['2021-06-05'], 'eur');
    expect(rates.get('2021-06-05')).toBe('0.82529');
  });

  it('stops carrying rather than reaching across a long gap', async () => {
    // A rate from the far side of a long gap is a guess. A missing price is
    // a better answer than a quietly stale one.
    //
    // The gap is a FIXED thirty days, not MAX_CARRY_DAYS + n: deriving it
    // from the constant under test makes the test move with the mutation,
    // so raising the limit to 400 changed nothing this could see.
    expect(MAX_CARRY_DAYS).toBeLessThan(30);
    const stale = new Date(Date.parse('2021-06-14T00:00:00Z') - 30 * DAY)
      .toISOString()
      .slice(0, 10);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(ratesBody({ [stale]: 0.8 }), { status: 200 }),
      ),
    );
    const rates = await fetchUsdRates(['2021-06-14'], 'eur');
    expect(rates.has('2021-06-14')).toBe(false);
  });

  it('asks nobody when the base currency is already dollars', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rates = await fetchUsdRates(['2021-06-01'], 'usd');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rates.get('2021-06-01')).toBe('1');
  });
});

describe('combining them', () => {
  it('multiplies through decimals, not floats', () => {
    // Both inputs arrive as JSON numbers and are already floats; the
    // product must not compound that on its way into the ledger.
    //
    // Verified against an exact decimal multiplication outside this
    // codebase. The float product of the same two numbers is
    // 29990.700746968854 - it diverges at the thirteenth digit, which is
    // the error this avoids inheriting.
    const exact = '29990.700746968855328';
    expect(inCurrency('36663.448345927696', '0.818')).toBe(exact);
    expect(String(36663.448345927696 * 0.818)).not.toBe(exact);
  });

  it('prices a day far outside CoinGeckos free tier', async () => {
    // THE case. 2021 is four years back; the free tier stops at 365 days.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('llama.fi')) {
          return new Response(
            llamaBody({ 'coingecko:cardano': [[seconds('2021-06-01'), 1.74]] }),
            { status: 200 },
          );
        }
        if (String(url).includes('frankfurter')) {
          return new Response(ratesBody({ '2021-06-01': 0.818 }), {
            status: 200,
          });
        }
        throw new Error('CoinGecko must not be asked: the deep source had it');
      }),
    );

    const { prices, failures } = await fetchHistory(
      new Map([[ADA, ['2021-06-01']]]),
      'eur',
    );
    expect(failures.size).toBe(0);
    // 1.74 USD at 0.818 EUR/USD.
    expect(prices.get(`${ADA}|2021-06-01`)).toBe('1.42332');
  });

  it('refuses to price when the rate is missing, rather than quoting dollars', async () => {
    // A dollar figure under a euro heading is the kind of wrong number
    // nobody catches by looking at it.
    //
    // The FX service ANSWERS here - 200, with rates for other days - and
    // simply has nothing within carry-back range of the day wanted. An
    // earlier version made it fail outright, which rejected the whole
    // primary path including the price, so the missing-rate branch was
    // never reached and the test passed with that branch deleted. CoinGecko
    // is refused too, so the only route to a price is the one under test.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('llama.fi')) {
          return new Response(
            llamaBody({ 'coingecko:cardano': [[seconds('2021-06-01'), 1.74]] }),
            { status: 200 },
          );
        }
        if (String(url).includes('frankfurter')) {
          const faraway = new Date(
            Date.parse('2021-06-01T00:00:00Z') - 30 * DAY,
          )
            .toISOString()
            .slice(0, 10);
          return new Response(ratesBody({ [faraway]: 0.8 }), { status: 200 });
        }
        return new Response('no', { status: 503 });
      }),
    );

    const { prices } = await fetchHistory(
      new Map([[ADA, ['2021-06-01']]]),
      'eur',
    );
    expect(prices.has(`${ADA}|2021-06-01`)).toBe(false);
  });

  it('falls back to CoinGecko for a day the deep source has not got', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(String(url));
        if (String(url).includes('llama.fi')) {
          return new Response(llamaBody({}), { status: 200 });
        }
        if (String(url).includes('frankfurter')) {
          return new Response(ratesBody({ '2026-09-15': 0.9 }), {
            status: 200,
          });
        }
        const at = Date.parse('2026-09-15T00:00:00Z');
        return new Response(JSON.stringify({ prices: [[at, 0.5]] }), {
          status: 200,
        });
      }),
    );

    const { prices } = await fetchHistory(
      new Map([[ADA, ['2026-09-15']]]),
      'eur',
    );
    expect(asked.some((url) => url.includes('coingecko.com'))).toBe(true);
    expect(prices.get(`${ADA}|2026-09-15`)).toBe('0.5');
  });
});

describe('end to end, through the tax resolver', () => {
  const event = (overrides: Partial<TaxEvent>): TaxEvent => ({
    sourceEventId: 'e1',
    kind: 'disposal',
    assetId: ADA,
    amount: '10000000', // 10 ADA, in lovelace
    timestamp: Date.parse('2021-06-01T12:00:00Z'),
    venue: 'wallet-a',
    ...overrides,
  });

  it('values a four-year-old disposal with no API key at all', async () => {
    // What this whole change is for: before it, this event came back
    // "needs a CoinGecko API key" and the report was unusable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('llama.fi')) {
          return new Response(
            llamaBody({ 'coingecko:cardano': [[seconds('2021-06-01'), 1.74]] }),
            { status: 200 },
          );
        }
        if (String(url).includes('frankfurter')) {
          return new Response(ratesBody({ '2021-06-01': 0.818 }), {
            status: 200,
          });
        }
        throw new Error('CoinGecko must not be needed here');
      }),
    );

    const { valued, unpriced } = await resolveValues([event({})], 'eur');
    expect(unpriced).toHaveLength(0);
    // 10 ADA at 1.74 USD x 0.818 = 14.2332 EUR.
    expect(valued[0].value).toBe('14.2332');
  });
});
