import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearCredentials,
  credentialKey,
  readCredential,
  writeCredential,
} from '@/lib/credentials';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('credential keys', () => {
  it('contains no name component, so a rename needs no migration', () => {
    expect(credentialKey(7, 'binanceApiKey')).toBe(
      'coineda.credential.7.binanceApiKey',
    );
    expect(credentialKey(7, 'binanceApiKey')).not.toContain('Binance');
  });
});

describe('round trip', () => {
  it('reads back what it wrote', () => {
    writeCredential(7, 'binanceApiKey', 'abc123');
    expect(readCredential(7, 'Binance', 'binanceApiKey')).toBe('abc123');
  });

  it('returns an empty string for an absent credential', () => {
    expect(readCredential(7, 'Binance', 'binanceApiKey')).toBe('');
  });
});

describe('legacy migration', () => {
  it('adopts a legacy value and removes the legacy key', () => {
    localStorage.setItem('7-Binance-binanceApiKey', 'legacy-secret');

    expect(readCredential(7, 'Binance', 'binanceApiKey')).toBe('legacy-secret');
    expect(localStorage.getItem(credentialKey(7, 'binanceApiKey'))).toBe(
      'legacy-secret',
    );
    expect(localStorage.getItem('7-Binance-binanceApiKey')).toBeNull();
  });

  it('writes the new key BEFORE removing the legacy one', () => {
    // If the order were reversed and the write failed, the credential would be
    // gone for good. Assert the ordering rather than only the end state.
    localStorage.setItem('7-Binance-binanceApiKey', 'legacy-secret');
    const calls: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => {
      calls.push(`set:${k}`);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((k) => {
      calls.push(`remove:${k}`);
    });

    readCredential(7, 'Binance', 'binanceApiKey');

    const setAt = calls.indexOf(`set:${credentialKey(7, 'binanceApiKey')}`);
    const removeAt = calls.indexOf('remove:7-Binance-binanceApiKey');
    expect(setAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(removeAt);
  });

  it('prefers the new key and ignores a stale legacy one', () => {
    writeCredential(7, 'binanceApiKey', 'current');
    localStorage.setItem('7-Binance-binanceApiKey', 'stale');
    expect(readCredential(7, 'Binance', 'binanceApiKey')).toBe('current');
  });
});

describe('unavailable storage', () => {
  it('returns an empty string rather than throwing when reads fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => readCredential(7, 'Binance', 'binanceApiKey')).not.toThrow();
    expect(readCredential(7, 'Binance', 'binanceApiKey')).toBe('');
  });

  it('does not throw when writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeCredential(7, 'binanceApiKey', 'abc')).not.toThrow();
  });
});

describe('clearing', () => {
  it('removes both the new and the legacy key for every field', () => {
    writeCredential(7, 'binanceApiKey', 'a');
    localStorage.setItem('7-Binance-binanceSecretKey', 'b');

    clearCredentials(7, 'Binance', ['binanceApiKey', 'binanceSecretKey']);

    expect(localStorage.getItem(credentialKey(7, 'binanceApiKey'))).toBeNull();
    expect(localStorage.getItem('7-Binance-binanceSecretKey')).toBeNull();
  });
});
