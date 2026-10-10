import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_ENDPOINTS,
  allowedHosts,
  defaultEndpoints,
  egressMode,
  isConfigured,
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

  it('keeps the port, so a service on another port is a different host', () => {
    expect(
      allowedHosts({
        ...PUBLIC_ENDPOINTS,
        fx: 'http://fx.example.gov:8080/v1',
      }),
    ).toContain('fx.example.gov:8080');
  });

  it('allows every host in public mode', () => {
    const endpoints = { ...PUBLIC_ENDPOINTS, fx: 'https://fx.example.gov' };
    expect(allowedHosts(endpoints, 'public').size).toBe(9);
  });

  it('allows only configured hosts in restricted mode', () => {
    expect(
      allowedHosts(
        {
          ...PUBLIC_ENDPOINTS,
          fx: 'https://fx.example.gov',
          priceHistory: 'https://prices.example.gov:8443',
        },
        'restricted',
      ),
    ).toEqual(new Set(['fx.example.gov', 'prices.example.gov:8443']));
    expect(allowedHosts(PUBLIC_ENDPOINTS, 'restricted').size).toBe(0);
  });
});

describe('isConfigured', () => {
  it('is false for a public default', () => {
    expect(isConfigured(PUBLIC_ENDPOINTS, 'fx')).toBe(false);
  });

  it('is true for an operator-chosen value', () => {
    expect(
      isConfigured({ ...PUBLIC_ENDPOINTS, fx: 'https://fx.example.gov' }, 'fx'),
    ).toBe(true);
  });

  it('is false for an empty value', () => {
    expect(isConfigured({ ...PUBLIC_ENDPOINTS, fx: '' }, 'fx')).toBe(false);
  });

  it('sees through a configured value that is the public default', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://api.frankfurter.dev/v1/"}');
    expect(isConfigured(defaultEndpoints(), 'fx')).toBe(false);
  });
});

describe('empty overrides', () => {
  it('keeps the default when the build configuration leaves a field empty', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"","spotPrices":"   /  "}');
    expect(defaultEndpoints()).toEqual(PUBLIC_ENDPOINTS);
  });

  it('keeps the default when a setting is cleared', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://fx.example.gov"}');
    expect(
      resolveEndpoints({ endpoints: { fx: '  ', priceHistory: '' } }),
    ).toEqual({ ...PUBLIC_ENDPOINTS, fx: 'https://fx.example.gov' });
  });
});

describe('env parse memoisation', () => {
  it('warns once for the same invalid value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITE_ENDPOINTS', '{memo not json');
    defaultEndpoints();
    defaultEndpoints();
    resolveEndpoints();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-reads when the value changes', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://a.example.gov"}');
    expect(defaultEndpoints().fx).toBe('https://a.example.gov');
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://b.example.gov"}');
    expect(defaultEndpoints().fx).toBe('https://b.example.gov');
  });

  it('hands out copies, so a caller cannot corrupt the cache', () => {
    vi.stubEnv('VITE_ENDPOINTS', '{"fx":"https://c.example.gov"}');
    defaultEndpoints().fx = 'mutated';
    expect(defaultEndpoints().fx).toBe('https://c.example.gov');
  });
});
