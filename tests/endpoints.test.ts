import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_ENDPOINTS,
  allowedHosts,
  defaultEndpoints,
  egressMode,
  resolveEndpoints,
} from '@/config/endpoints';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('PUBLIC_ENDPOINTS', () => {
  it('holds the base of every public host the app talks to today', () => {
    expect(PUBLIC_ENDPOINTS).toEqual({
      priceHistory: 'https://coins.llama.fi',
      spotPrices: 'https://api.coingecko.com/api/v3',
      fx: 'https://api.frankfurter.dev/v1',
      tokenRegistry: 'https://tokens.cardano.org/metadata',
      bitcoinEsplora: 'https://blockstream.info/api',
      ethereumBlockscout: 'https://eth.blockscout.com',
      cardanoYaci: 'https://yaci-store.mainnet.colo2.cf-systems.org',
      cardanoBlockfrost: 'https://cardano-mainnet.blockfrost.io',
      bitpanda: 'https://api.bitpanda.com/v1',
    });
  });
});

describe('defaultEndpoints', () => {
  it('is the public set when no build configuration is given', () => {
    vi.stubEnv('VITE_ENDPOINTS', '');
    expect(defaultEndpoints()).toEqual(PUBLIC_ENDPOINTS);
  });

  it('overlays VITE_ENDPOINTS, normalising each value', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://fx.example.gov/"}');
    expect(defaultEndpoints()).toEqual({
      ...PUBLIC_ENDPOINTS,
      fx: 'https://fx.example.gov',
    });
  });

  it('trims whitespace around a configured value', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"  https://fx.example.gov//  "}');
    expect(defaultEndpoints().fx).toBe('https://fx.example.gov');
  });

  it('ignores keys that are not endpoints and values that are not strings', () => {
    vi.stubEnv(
      'VITE_ENDPOINTS',
      '{"nope":"https://x.example.gov","fx":42,"spotPrices":"https://s.example.gov"}',
    );
    expect(defaultEndpoints()).toEqual({
      ...PUBLIC_ENDPOINTS,
      spotPrices: 'https://s.example.gov',
    });
  });

  it('falls back to the public set and warns on invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITE_ENDPOINTS', '{not json');
    expect(defaultEndpoints()).toEqual(PUBLIC_ENDPOINTS);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back and warns when the JSON is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITE_ENDPOINTS', '["https://x.example.gov"]');
    expect(defaultEndpoints()).toEqual(PUBLIC_ENDPOINTS);
    expect(warn).toHaveBeenCalled();
  });
});

describe('resolveEndpoints', () => {
  it('is the defaults without settings', () => {
    expect(resolveEndpoints()).toEqual(defaultEndpoints());
    expect(resolveEndpoints({})).toEqual(defaultEndpoints());
  });

  it('overrides exactly the fields a setting names', () => {
    expect(
      resolveEndpoints({
        endpoints: { priceHistory: 'https://p.example.gov' },
      }),
    ).toEqual({ ...PUBLIC_ENDPOINTS, priceHistory: 'https://p.example.gov' });
  });

  it('normalises a setting the same way as the build configuration', () => {
    expect(
      resolveEndpoints({ endpoints: { fx: ' https://fx.example.gov/ ' } }).fx,
    ).toBe('https://fx.example.gov');
  });

  it('applies settings over the build configuration', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://fx.example.gov"}');
    expect(
      resolveEndpoints({ endpoints: { spotPrices: 'https://s.example.gov' } }),
    ).toEqual({
      ...PUBLIC_ENDPOINTS,
      fx: 'https://fx.example.gov',
      spotPrices: 'https://s.example.gov',
    });
  });
});

describe('egressMode', () => {
  it('is public by default', () => {
    vi.stubEnv('VITE_EGRESS', '');
    expect(egressMode()).toBe('public');
    expect(egressMode({})).toBe('public');
  });

  it('is restricted when the build says so', () => {
    vi.stubEnv('VITE_EGRESS', 'restricted');
    expect(egressMode()).toBe('restricted');
  });

  it('lets the setting restrict a public build', () => {
    vi.stubEnv('VITE_EGRESS', '');
    expect(egressMode({ egress: 'restricted' })).toBe('restricted');
    vi.stubEnv('VITE_EGRESS', 'public');
    expect(egressMode({ egress: 'restricted' })).toBe('restricted');
  });

  it('never lets a setting loosen a build pinned restricted', () => {
    vi.stubEnv('VITE_EGRESS', 'restricted');
    expect(egressMode({ egress: 'public' })).toBe('restricted');
  });
});

describe('allowedHosts', () => {
  it('returns the host names of every endpoint', () => {
    expect(allowedHosts(PUBLIC_ENDPOINTS)).toEqual(
      new Set([
        'coins.llama.fi',
        'api.coingecko.com',
        'api.frankfurter.dev',
        'tokens.cardano.org',
        'blockstream.info',
        'eth.blockscout.com',
        'yaci-store.mainnet.colo2.cf-systems.org',
        'cardano-mainnet.blockfrost.io',
        'api.bitpanda.com',
      ]),
    );
  });

  it('skips empty and unparsable values', () => {
    const hosts = allowedHosts({
      ...PUBLIC_ENDPOINTS,
      tokenRegistry: '',
      fx: 'not a url',
    });
    expect(hosts.size).toBe(7);
    expect(hosts).not.toContain('tokens.cardano.org');
  });
});
