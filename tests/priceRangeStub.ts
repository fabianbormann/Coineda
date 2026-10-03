import { vi } from 'vitest';

export const DAY_MS = 86_400_000;

/**
 * A faithful stand-in for CoinGecko's `market_chart/range`.
 *
 * Reads the window out of the request and answers with one point at each UTC
 * midnight inside it, which is what the real endpoint does for any span over
 * 90 days. Shared by every test that needs historical prices, because five
 * copies of a provider fake is five chances for one of them to drift away
 * from what the provider actually sends - which is exactly how the Cardano
 * module once passed its tests against a body no provider would return.
 *
 * Generated from the request rather than hardcoded, so a caller that asked
 * for the WRONG window gets no price here instead of quietly getting the
 * right one anyway.
 */
export const rangeStub = (priceFor: (isoDate: string) => number) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url: string) => {
      const text = String(url);
      const from = Number(/from=(\d+)/.exec(text)?.[1] ?? '0') * 1000;
      const to = Number(/to=(\d+)/.exec(text)?.[1] ?? '0') * 1000;
      const prices: [number, number][] = [];
      for (let at = Math.ceil(from / DAY_MS) * DAY_MS; at <= to; at += DAY_MS) {
        prices.push([at, priceFor(new Date(at).toISOString().slice(0, 10))]);
      }
      return new Response(JSON.stringify({ prices }), { status: 200 });
    },
  );

/** The common case: one price for every day in the window. */
export const flatRange = (eur: number) => rangeStub(() => eur);
