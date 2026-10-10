import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * The egress mode is the device's, so no failure reading a client's
 * settings can loosen it. Before it moved to the device, an unreadable
 * settings row fell back to the build default - 'public' - and reopened
 * every public host on a device the operator had restricted.
 */
vi.mock('@/settings/settingsStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/settings/settingsStore')>();
  return {
    ...actual,
    getSettings: vi.fn(async () => {
      throw new Error('settings unreadable');
    }),
  };
});

import { writeDeviceEgress } from '@/config/deviceConfig';
import { activeEndpoints } from '@/config/egress';
import { egressMode } from '@/config/endpoints';
import { getSettings } from '@/settings/settingsStore';
import { resolveSpotPrices } from '@/prices/priceStore';
import { resolveTokenMeta } from '@/assets/tokenMetaStore';
import { findModule } from '@/sources/registry';
import { EgressRefusedError, prepareRun } from '@/sources/egress';

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_EGRESS', '');
  writeDeviceEgress('restricted');
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a settings read that throws', () => {
  it('cannot change the mode', async () => {
    await expect(getSettings()).rejects.toThrow('settings unreadable');
    expect(egressMode()).toBe('restricted');
    expect(activeEndpoints().spotPrices).toBe('');
    expect(() => prepareRun(findModule('bitpanda')!, { apiKey: 'k' })).toThrow(
      EgressRefusedError,
    );
  });

  it('opens no public host for prices or token metadata', async () => {
    const stub = vi.fn(async () => {
      throw new Error('no request expected');
    });
    vi.stubGlobal('fetch', stub);
    await resolveSpotPrices(['cardano:lovelace', 'fiat:usd'], 'eur');
    await resolveTokenMeta([`cardano:${'b'.repeat(56)}41`]);
    expect(stub).not.toHaveBeenCalled();
  });
});
