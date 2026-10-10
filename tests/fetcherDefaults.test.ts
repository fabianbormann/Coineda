import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRates, fetchUsdRates } from '@/prices/ecb';
import {
  COINGECKO_IDS,
  fetchHistoricalPrice,
  fetchHistoricalPrices,
  fetchSpotPrices,
} from '@/prices/coingecko';
import { fetchUsdHistory } from '@/prices/defillama';
import { fetchHistory } from '@/prices/history';
import { fetchTokenMeta } from '@/assets/tokenRegistry';
import { baseUrlOf as esploraBase } from '@/sources/bitcoin-esplora/translator';
import { baseUrlOf as blockscoutBase } from '@/sources/ethereum-blockscout/translator';
import { EgressRefusedError } from '@/sources/egress';
import { writeDeviceEgress } from '@/config/deviceConfig';

/**
 * The low-level fetchers' `endpoints` parameter defaults to the
 * restricted-aware `activeEndpoints()`, not the public set: a caller that
 * forgets to pass it must not reach a public provider in restricted mode.
 */
const fetchSpy = vi.fn(async () => new Response('{}'));
const assetId = Object.keys(COINGECKO_IDS)[0];

beforeEach(() => {
  vi.stubEnv('VITE_EGRESS', '');
  vi.stubEnv('VITE_ENDPOINTS', '');
  writeDeviceEgress('restricted');
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  localStorage.clear();
  fetchSpy.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('in restricted mode with nothing configured, called without endpoints', () => {
  it('fetchRates makes no request and reports every day missing', async () => {
    const rates = await fetchRates(['2025-01-02'], 'usd', 'eur');
    expect(rates.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the other price and token fetchers make no request', async () => {
    await fetchUsdRates(['2025-01-02'], 'eur');
    await fetchSpotPrices([assetId], 'eur');
    await fetchHistoricalPrices(assetId, 'eur', ['2025-01-02']);
    await fetchHistoricalPrice(assetId, 'eur', '2025-01-02');
    await fetchUsdHistory(new Map([[assetId, ['2025-01-02']]]));
    await fetchHistory(new Map([[assetId, ['2025-01-02']]]), 'eur');
    await fetchTokenMeta(['a'.repeat(56)]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a chain module with no baseUrl refuses rather than falling back to its public host', () => {
    expect(() => esploraBase({})).toThrow(EgressRefusedError);
    expect(() => blockscoutBase({ baseUrl: ' ' })).toThrow(EgressRefusedError);
  });

  it('a configured service is still used', async () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://fx.operator.example"}');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ rates: { '2025-01-02': { EUR: 0.9 } } })),
    );
    await fetchRates(['2025-01-02'], 'usd', 'eur');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0 as never])).toMatch(
      /^https:\/\/fx\.operator\.example\//,
    );
  });
});

describe('in public mode, called without endpoints', () => {
  it('still uses the public defaults', async () => {
    writeDeviceEgress('public');
    expect(esploraBase({})).toBe('https://blockstream.info/api');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ rates: {} })));
    await fetchRates(['2025-01-02'], 'usd', 'eur');
    expect(String(fetchSpy.mock.calls[0]?.[0 as never])).toMatch(
      /^https:\/\/api\.frankfurter\.dev\/v1\//,
    );
  });
});
