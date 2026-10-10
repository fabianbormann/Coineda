import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import 'fake-indexeddb/auto';
import '@/i18n';
import { AddSourceDialog } from '@/screens/AddSourceDialog';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { findModule, visibleModules } from '@/sources/registry';
import { activeEndpoints } from '@/config/egress';
import { resolveEndpoints, type Endpoints } from '@/config/endpoints';
import { fetchTokenMeta } from '@/assets/tokenRegistry';
import { resolveTokenMeta } from '@/assets/tokenMetaStore';
import { fetchHistory } from '@/prices/history';
import { fetchSpotPrices } from '@/prices/coingecko';
import { resolveValues } from '@/tax/resolveValues';
import {
  EGRESS_REFUSED,
  EgressRefusedError,
  assertEgressAllowed,
} from '@/sources/egress';
import { syncSource } from '@/sync/syncSource';
import { getSources, openLedger, putSource } from '@/ledger/db';
import { putSettings, type Settings } from '@/settings/settingsStore';
import type { SourceRecord } from '@/ledger/types';
import type { TaxEvent } from '@/tax/types';

/**
 * Restricted egress: the app talks only to the hosts the operator
 * configured. A service still on its public default is unavailable - no
 * request, the price reported missing, the decoration skipped - and a
 * module that cannot be self-hosted is not offered at all.
 */
const GOV_PRICES = 'https://prices.gov.example';
const GOV_INDEXER = 'https://indexer.gov.example';

const restricted: Partial<Settings> = {
  egress: 'restricted',
  endpoints: { priceHistory: GOV_PRICES, ethereumBlockscout: GOV_INDEXER },
};

const ETH_ADDRESS = '0x' + 'a'.repeat(40);
const POLICY = 'b'.repeat(56);

const PUBLIC_HOST_MARKERS = [
  'frankfurter',
  'llama.fi',
  'coingecko',
  'cardano.org',
  'blockscout.com',
  'public.example',
  'bitpanda',
];

/** Every request recorded; anything to a public host fails the test. */
const guardedFetch = (
  answer: (url: string) => Response = () => {
    throw new Error('no answer configured');
  },
) => {
  const calls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const marker of PUBLIC_HOST_MARKERS) {
      if (url.includes(marker)) {
        throw new Error(`unexpected egress to ${url}`);
      }
    }
    return answer(url);
  });
  vi.stubGlobal('fetch', stub);
  return { calls, stub };
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['prices', 'settings', 'sources', 'tokenMeta'] as const) {
    await db.clear(store);
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderDialog = () =>
  render(
    <ConfirmProvider>
      <AddSourceDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        onImportFile={vi.fn()}
        onImportMapped={vi.fn()}
      />
    </ConfirmProvider>,
  );

describe('the module list', () => {
  it('hides Bitpanda and every module whose service is unconfigured', () => {
    const ids = visibleModules('restricted', resolveEndpoints(restricted)).map(
      (m) => m.manifest.id,
    );
    expect(ids).not.toContain('bitpanda');
    expect(ids).toContain('ethereum-blockscout');
    expect(ids).not.toContain('bitcoin-esplora');
  });

  it('shows everything in public mode', () => {
    const ids = visibleModules('public').map((m) => m.manifest.id);
    expect(ids).toContain('bitpanda');
    expect(ids).toContain('bitcoin-esplora');
  });

  it('leaves Bitpanda out of the add-source picker when restricted', async () => {
    await putSettings(restricted);
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    // Settings load asynchronously; wait for the filtered list.
    await vi.waitFor(() =>
      expect(
        within(dialog).queryByRole('button', { name: /^Bitpanda$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole('button', { name: /Ethereum/i }),
    ).toBeInTheDocument();
  });

  it('offers Bitpanda in the picker in public mode', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('button', { name: /^Bitpanda$/i }),
    ).toBeInTheDocument();
  });
});

describe('active endpoints', () => {
  it('blanks every unconfigured service when restricted', () => {
    const active = activeEndpoints(restricted);
    expect(active.priceHistory).toBe(GOV_PRICES);
    expect(active.ethereumBlockscout).toBe(GOV_INDEXER);
    expect(active.fx).toBe('');
    expect(active.spotPrices).toBe('');
    expect(active.tokenRegistry).toBe('');
    expect(active.bitpanda).toBe('');
  });

  it('is the resolved set in public mode', () => {
    const settings = { endpoints: { fx: GOV_PRICES } };
    expect(activeEndpoints(settings)).toEqual(resolveEndpoints(settings));
  });
});

describe('token metadata', () => {
  it('fetches nothing when no registry is available', async () => {
    const { stub } = guardedFetch();
    const empty: Endpoints = { ...resolveEndpoints(), tokenRegistry: '' };
    const result = await fetchTokenMeta([POLICY + '41'], undefined, empty);
    expect(result.size).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('skips the decoration when restricted without a registry', async () => {
    await putSettings(restricted);
    const { stub } = guardedFetch();
    const result = await resolveTokenMeta([`cardano:${POLICY}41`]);
    expect(result.size).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });
});

describe('prices', () => {
  it('reports a fiat conversion missing when no FX service is configured', async () => {
    const { stub } = guardedFetch();
    const { prices, sources } = await fetchHistory(
      new Map([['fiat:usd', ['2024-03-01']]]),
      'eur',
      undefined,
      undefined,
      activeEndpoints(restricted),
    );
    expect(prices.size).toBe(0);
    expect(sources.size).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('never falls back to a public host for a crypto price', async () => {
    const { stub } = guardedFetch();
    const { prices } = await fetchHistory(
      new Map([['cardano:lovelace', ['2024-03-01']]]),
      'eur',
      undefined,
      undefined,
      activeEndpoints(restricted),
    );
    expect(prices.size).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('asks for no spot price when the spot service is unavailable', async () => {
    const { stub } = guardedFetch();
    const prices = await fetchSpotPrices(
      ['cardano:lovelace'],
      'eur',
      activeEndpoints(restricted),
    );
    expect(prices.size).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('reports the tax run price missing in restricted mode without FX', async () => {
    await putSettings(restricted);
    const { calls } = guardedFetch(() => new Response('{}', { status: 500 }));
    const event: TaxEvent = {
      sourceEventId: 'e1',
      kind: 'disposal',
      assetId: 'fiat:usd',
      amount: '10',
      timestamp: Date.parse('2021-06-01T12:00:00Z'),
      venue: 'wallet-a',
    };
    const { unpriced } = await resolveValues([event], 'eur');
    expect(unpriced.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it("sends a tax run's price history to the client's own override", async () => {
    await putSettings({ endpoints: { priceHistory: GOV_PRICES } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('{}', { status: 500 });
      }),
    );
    const event: TaxEvent = {
      sourceEventId: 'e1',
      kind: 'disposal',
      assetId: 'cardano:lovelace',
      amount: '10000000',
      timestamp: Date.parse('2021-06-01T12:00:00Z'),
      venue: 'wallet-a',
    };
    await resolveValues([event], 'eur');
    expect(calls.some((url) => url.startsWith(`${GOV_PRICES}/`))).toBe(true);
    expect(calls.some((url) => url.includes('llama.fi'))).toBe(false);
    // Public mode: the services left alone keep their public hosts.
    expect(calls.some((url) => url.includes('frankfurter'))).toBe(true);
  });
});

describe('syncing a source', () => {
  const source: SourceRecord = {
    id: 'src-1',
    moduleId: 'ethereum-blockscout',
    label: 'Wallet',
    config: { address: ETH_ADDRESS, baseUrl: 'https://public.example' },
  };

  it('refuses a host outside the configured endpoints', async () => {
    await putSettings(restricted);
    await putSource(source);
    const { stub } = guardedFetch();

    const report = await syncSource(source);

    expect(report.error).toBe(EGRESS_REFUSED);
    expect(stub).not.toHaveBeenCalled();
    const [stored] = await getSources();
    expect(stored.lastError).toBe(
      'This source points at a host outside the configured endpoints.',
    );
  });

  it('throws EgressRefusedError from the check itself', () => {
    const module = findModule('ethereum-blockscout')!;
    expect(() =>
      assertEgressAllowed(module, source.config, restricted),
    ).toThrow(EgressRefusedError);
    // The configured indexer, given explicitly or as the default, passes.
    expect(() =>
      assertEgressAllowed(
        module,
        { address: ETH_ADDRESS, baseUrl: GOV_INDEXER },
        restricted,
      ),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed(module, { address: ETH_ADDRESS }, restricted),
    ).not.toThrow();
  });

  it('refuses a module that cannot be self-hosted', () => {
    const bitpanda = findModule('bitpanda')!;
    expect(() =>
      assertEgressAllowed(bitpanda, { apiKey: 'k' }, restricted),
    ).toThrow(EgressRefusedError);
  });

  it('lets public mode reach public hosts', () => {
    const module = findModule('ethereum-blockscout')!;
    expect(() => assertEgressAllowed(module, source.config, {})).not.toThrow();
    expect(() =>
      assertEgressAllowed(findModule('bitpanda')!, { apiKey: 'k' }, null),
    ).not.toThrow();
  });

  it("syncs from the client's configured default when no URL is given", async () => {
    await putSettings(restricted);
    const blank: SourceRecord = { ...source, config: { address: ETH_ADDRESS } };
    await putSource(blank);
    const { calls } = guardedFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await syncSource(blank);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.startsWith(`${GOV_INDEXER}/`))).toBe(true);
  });
});
