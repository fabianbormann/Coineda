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
 *
 * The DEEP sources are refused by default. resolveValues now tries
 * DefiLlama and the ECB first and only falls back to CoinGecko, so without
 * this every test below would exercise the new path instead of the one it
 * was written for. The tests that cover the primary path stub it
 * explicitly; see `deepStub`.
 */
const isCoinGecko = (url: string): boolean => url.includes('coingecko.com');
const isDeepSource = (url: string): boolean =>
  url.includes('llama.fi') || url.includes('frankfurter');

const rangeStub = (priceFor: (isoDate: string) => number) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url: string) => {
      if (isDeepSource(String(url))) {
        return new Response('upstream unavailable', { status: 503 });
      }
      const from = Number(/from=(\d+)/.exec(String(url))![1]) * 1000;
      const to = Number(/to=(\d+)/.exec(String(url))![1]) * 1000;
      const prices: [number, number][] = [];
      for (let t = Math.ceil(from / DAY) * DAY; t <= to; t += DAY) {
        prices.push([t, priceFor(new Date(t).toISOString().slice(0, 10))]);
      }
      return new Response(JSON.stringify({ prices }), { status: 200 });
    },
  );

/** Only the CoinGecko calls, because the deep sources are asked first and
 *  a raw call count no longer says anything about the fallback's shape. */
const coinGeckoCalls = (mock: { mock: { calls: unknown[][] } }): string[] =>
  mock.mock.calls.map((call) => String(call[0])).filter(isCoinGecko);

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

    expect(coinGeckoCalls(fetchMock)).toHaveLength(1);
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
    expect(coinGeckoCalls(fetchMock)).toHaveLength(1);
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

    // Two assets, two days each: two CoinGecko requests, because its span
    // is per asset. The deep sources take both assets in one call, which is
    // the point of them - see the primary-path tests below.
    expect(coinGeckoCalls(fetchMock)).toHaveLength(2);
  });

  it('serves a second run entirely from cache', async () => {
    const fetchMock = flatRange(2);
    vi.stubGlobal('fetch', fetchMock);

    await resolveValues([event({})], 'eur');
    await resolveValues([event({})], 'eur');

    expect(coinGeckoCalls(fetchMock)).toHaveLength(1);
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
    expect(unpriced[0].reason.key).toMatch(/historical prices before/i);
    expect(unpriced[0].reason.params).toMatchObject({ days: 365 });
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

    // The CoinGecko call specifically: it is no longer the first request
    // made, because the deep sources are tried ahead of it.
    const call = fetchMock.mock.calls.find((entry) =>
      isCoinGecko(String(entry[0])),
    ) as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(String(url)).not.toContain('cg-demo-key');
    expect((init.headers as Record<string, string>)['x-cg-demo-api-key']).toBe(
      'cg-demo-key',
    );

    // And the key goes ONLY there. The deep sources are third parties that
    // were never given it and have no use for it.
    for (const [other, otherInit] of fetchMock.mock.calls) {
      if (isCoinGecko(String(other))) {
        continue;
      }
      expect(String(other)).not.toContain('cg-demo-key');
      expect(
        JSON.stringify((otherInit as RequestInit)?.headers ?? {}),
      ).not.toContain('cg-demo-key');
    }
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

    expect(JSON.stringify(unpriced[0].reason)).not.toContain('cg-secret');
  });
});

describe('a zero amount', () => {
  it('is valued as zero without asking anybody', async () => {
    const fetchMock = rangeStub(() => 2);
    vi.stubGlobal('fetch', fetchMock);
    const { valued, unpriced } = await resolveValues(
      [
        event({
          kind: 'acquisition',
          amount: '1000000',
          consideration: { assetId: 'cardano:lovelace', amount: '0' },
        }),
        event({
          kind: 'acquisition',
          assetId: 'cardano:deadbeef.NoSuchToken',
          amount: '0',
        }),
      ],
      'eur',
    );
    expect(valued.map((e) => e.value)).toEqual(['0', '0']);
    expect(unpriced).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nobody priced it, and the label says so rather than crediting the
    // base currency with a figure it did not supply.
    expect(valued.map((e) => e.priceSource)).toEqual([
      'consideration · none (zero amount)',
      'none (zero amount)',
    ]);
  });

  it('still values a non-zero cost on a zero-amount event', async () => {
    // The zero shortcut values the amount, not the event: a fee paid on it
    // is real money and must still reach the cost basis.
    const fetchMock = rangeStub(() => 2);
    vi.stubGlobal('fetch', fetchMock);
    const { valued, unpriced } = await resolveValues(
      [
        event({
          kind: 'acquisition',
          amount: '0',
          costs: [{ assetId: 'fiat:eur', amount: '2' }],
        }),
      ],
      'eur',
    );
    expect(valued).toHaveLength(1);
    expect(valued[0].value).toBe('0');
    expect(valued[0].costs?.[0].value).toBe('2');
    expect(unpriced).toHaveLength(0);
  });
});

describe('transaction costs', () => {
  it('values a cost in the base currency without a lookup', async () => {
    const fetchMock = rangeStub(() => 2);
    vi.stubGlobal('fetch', fetchMock);

    const { valued, unpriced } = await resolveValues(
      [
        event({
          assetId: 'fiat:eur',
          amount: '100',
          costs: [{ assetId: 'fiat:eur', amount: '1.5' }],
        }),
      ],
      'eur',
    );

    expect(valued[0].value).toBe('100');
    expect(valued[0].costs).toEqual([
      {
        assetId: 'fiat:eur',
        amount: '1.5',
        value: '1.5',
        priceSource: 'base currency',
      },
    ]);
    expect(unpriced).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("values a cost paid in the event's own asset at that day's price", async () => {
    vi.stubGlobal(
      'fetch',
      rangeStub(() => 2),
    );

    const { valued, unpriced } = await resolveValues(
      [
        event({
          amount: '1000000',
          costs: [{ assetId: 'cardano:lovelace', amount: '500000' }],
        }),
      ],
      'eur',
    );

    expect(valued[0].value).toBe('2');
    expect(valued[0].costs?.[0].value).toBe('1');
    expect(unpriced).toHaveLength(0);
  });

  it('lists a cost it cannot price instead of deducting zero', async () => {
    vi.stubGlobal(
      'fetch',
      rangeStub(() => 2),
    );

    const { valued, unpriced } = await resolveValues(
      [
        event({
          sourceEventId: 'swap-1',
          amount: '1000000',
          costs: [{ assetId: 'cardano:deadbeef.NoSuchToken', amount: '7' }],
        }),
        // The fee coins' own disposal, which a crypto fee always produces
        // as well and which cannot be priced either.
        event({
          sourceEventId: 'swap-1',
          assetId: 'cardano:deadbeef.NoSuchToken',
          amount: '7',
        }),
      ],
      'eur',
    );

    // The event itself is valued and returned: the fee's price is the
    // gap, not the trade's.
    expect(valued).toHaveLength(1);
    expect(valued[0].value).toBe('2');
    expect(valued[0].costs?.[0].value).toBeUndefined();

    // Same asset, same amount, same event - told apart by `subject`, so a
    // reader does not see the one gap as two failed disposals.
    expect(unpriced).toHaveLength(2);
    const ownDisposal = unpriced.find((item) => item.subject === undefined);
    expect(ownDisposal?.taxEventKind).toBe('disposal');
    const costEntry = unpriced.find((item) => item.subject === 'cost');
    expect(costEntry).toMatchObject({
      kind: 'needs-price',
      subject: 'cost',
      sourceEventId: 'swap-1',
      assetId: 'cardano:deadbeef.NoSuchToken',
      amount: '7',
      resolutions: [],
      reason: {
        key: 'No price source is configured for {{asset}}.',
        params: { asset: 'cardano:deadbeef.NoSuchToken' },
      },
    });
    // Not a disposal missing from the gain figure, so it must not be
    // counted as one by runTaxReport's `omitted` rule.
    expect(costEntry?.taxEventKind).toBeUndefined();
  });
});

describe('consideration', () => {
  it('values a euro buy at the euro paid, asking nobody', async () => {
    const fetchMock = rangeStub(() => 2);
    vi.stubGlobal('fetch', fetchMock);

    const { valued, unpriced } = await resolveValues(
      [
        event({
          kind: 'acquisition',
          amount: '1000000',
          consideration: { assetId: 'fiat:eur', amount: '500' },
        }),
      ],
      'eur',
    );

    expect(valued[0].value).toBe('500');
    expect(unpriced).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('values a dollar sale at the euro value of the dollars received', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('frankfurter')) {
          return new Response(
            JSON.stringify({
              base: 'USD',
              rates: { '2026-09-15': { EUR: 0.85 } },
            }),
            { status: 200 },
          );
        }
        throw new Error(`nobody but the ECB may be asked: ${url}`);
      }),
    );

    const { valued, unpriced } = await resolveValues(
      [
        event({
          amount: '1000000',
          consideration: { assetId: 'fiat:usd', amount: '100' },
        }),
      ],
      'eur',
    );

    expect(unpriced).toHaveLength(0);
    expect(valued[0].value).toBe('85');
  });

  it('lists an unpriceable consideration rather than falling back to market', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('frankfurter')) {
        return new Response(JSON.stringify({ base: 'XYZ', rates: {} }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ prices: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { valued, unpriced } = await resolveValues(
      [
        event({
          sourceEventId: 'odd-pair',
          amount: '1000000',
          consideration: { assetId: 'fiat:xyz', amount: '100' },
        }),
      ],
      'eur',
    );

    expect(valued).toHaveLength(0);
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0]).toMatchObject({
      kind: 'needs-price',
      sourceEventId: 'odd-pair',
      taxEventKind: 'disposal',
      reason: {
        key: 'No price for {{asset}} on {{date}}.',
        params: { asset: 'fiat:xyz', date: '2026-09-15' },
      },
    });
    // The leg's own asset was never priced: the consideration IS the value.
    expect(coinGeckoCalls(fetchMock)).toEqual([]);
  });

  it('never blames the free tier for a fiat asset the ECB does not list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('frankfurter')) {
          return new Response(JSON.stringify({ base: 'XYZ', rates: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ prices: [] }), { status: 200 });
      }),
    );

    const { unpriced } = await resolveValues(
      [
        event({
          amount: '1000000',
          timestamp: Date.UTC(2024, 8, 15, 12),
          consideration: { assetId: 'fiat:xyz', amount: '100' },
        }),
      ],
      'eur',
    );

    expect(unpriced).toHaveLength(1);
    expect(unpriced[0].reason).toEqual({
      key: 'No price for {{asset}} on {{date}}.',
      params: { asset: 'fiat:xyz', date: '2024-09-15' },
    });
  });
});

describe('price provenance', () => {
  it('labels base fiat as the base currency', async () => {
    const { valued } = await resolveValues(
      [event({ assetId: 'fiat:eur', amount: '12' })],
      'eur',
    );
    expect(valued[0].priceSource).toBe('base currency');
  });

  it('labels a CoinGecko-priced event with CoinGecko', async () => {
    vi.stubGlobal(
      'fetch',
      rangeStub(() => 0.35),
    );
    const { valued } = await resolveValues(
      [event({ amount: '10000000' })],
      'eur',
    );
    expect(valued[0].priceSource).toBe('CoinGecko');
  });

  it('prefixes a fiat consideration with consideration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('frankfurter')) {
          return new Response(
            JSON.stringify({
              base: 'USD',
              rates: { '2026-09-15': { EUR: 0.85 } },
            }),
            { status: 200 },
          );
        }
        throw new Error(`nobody but the ECB may be asked: ${url}`);
      }),
    );
    const { valued } = await resolveValues(
      [
        event({
          amount: '1000000',
          consideration: { assetId: 'fiat:usd', amount: '100' },
        }),
      ],
      'eur',
    );
    expect(valued[0].priceSource).toBe('consideration · ECB');
  });

  it('labels a base-currency consideration', async () => {
    const { valued } = await resolveValues(
      [
        event({
          kind: 'acquisition',
          amount: '1000000',
          consideration: { assetId: 'fiat:eur', amount: '500' },
        }),
      ],
      'eur',
    );
    expect(valued[0].priceSource).toBe('consideration · base currency');
  });

  it('prices a cache row with no source again, and records who priced it', async () => {
    // Rows cached before sources were recorded would otherwise print
    // "source not recorded" on every report for good: a day's price is
    // never refetched once cached.
    const db = await openLedger();
    await db.put('prices', {
      key: 'cardano:lovelace|eur|2026-09-15',
      price: '0.4',
    });
    vi.stubGlobal(
      'fetch',
      rangeStub(() => 0.35),
    );
    const { valued, unpriced } = await resolveValues(
      [event({ amount: '10000000' })],
      'eur',
    );
    expect(unpriced).toEqual([]);
    expect(valued[0].priceSource).toBe('CoinGecko');
    expect(valued[0].value).toBe('3.5');
    expect(await db.get('prices', 'cardano:lovelace|eur|2026-09-15')).toEqual({
      key: 'cardano:lovelace|eur|2026-09-15',
      price: '0.35',
      source: 'CoinGecko',
    });
  });

  it('keeps an unsourced cached price, labelled as such, when it cannot be priced again', async () => {
    // Offline, restricted, or past the free tier: the cached figure is
    // still better than listing the event as unpriced.
    const db = await openLedger();
    await db.put('prices', {
      key: 'cardano:lovelace|eur|2026-09-15',
      price: '0.4',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream unavailable', { status: 503 })),
    );
    const { valued, unpriced } = await resolveValues(
      [event({ amount: '10000000' })],
      'eur',
    );
    expect(unpriced).toEqual([]);
    expect(valued[0].priceSource).toBe('cache (source not recorded)');
    expect(valued[0].value).toBe('4');
  });

  it('keeps an unsourced cached price for an asset it has no provider id for', async () => {
    const db = await openLedger();
    await db.put('prices', {
      key: 'cardano:unlisted|eur|2026-09-15',
      price: '2',
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('nobody may be asked about an unmapped asset');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { valued, unpriced } = await resolveValues(
      [event({ assetId: 'cardano:unlisted', amount: '3' })],
      'eur',
    );
    expect(unpriced).toEqual([]);
    expect(valued[0].priceSource).toBe('cache (source not recorded)');
    expect(valued[0].value).toBe('6');
  });

  it('reads the source off a cache row that has one', async () => {
    const db = await openLedger();
    await db.put('prices', {
      key: 'cardano:lovelace|eur|2026-09-15',
      price: '0.4',
      source: 'ECB',
    });
    const { valued } = await resolveValues(
      [event({ amount: '10000000' })],
      'eur',
    );
    expect(valued[0].priceSource).toBe('ECB');
  });
});
