import { describe, expect, it } from 'vitest';
import { validateEgressEnv } from '@/config/validateEnv';

/**
 * The build-time check vite.config.ts runs on VITE_EGRESS / VITE_ENDPOINTS.
 * At runtime a typo silently degrades to a public build (only the exact
 * `restricted` pins the mode) and a malformed VITE_ENDPOINTS only warns in
 * the clerk's console, so the build refuses them instead.
 */
describe('validateEgressEnv', () => {
  it('accepts an unset or empty environment', () => {
    expect(() => validateEgressEnv({})).not.toThrow();
    expect(() =>
      validateEgressEnv({ VITE_EGRESS: '', VITE_ENDPOINTS: '  ' }),
    ).not.toThrow();
  });

  it.each(['public', 'restricted', ' restricted '])(
    'accepts VITE_EGRESS=%j',
    (value) => {
      expect(() => validateEgressEnv({ VITE_EGRESS: value })).not.toThrow();
    },
  );

  it.each(['Restricted', 'RESTRICTED', 'restricted;', 'restrict', 'private'])(
    'refuses VITE_EGRESS=%j',
    (value) => {
      expect(() => validateEgressEnv({ VITE_EGRESS: value })).toThrow(
        /VITE_EGRESS.*'public'.*'restricted'/,
      );
    },
  );

  it('accepts a JSON object of known keys with https URLs', () => {
    expect(() =>
      validateEgressEnv({
        VITE_ENDPOINTS: JSON.stringify({
          fx: 'https://fx.example.gov/v1',
          priceHistory: 'https://prices.example.gov:8443',
        }),
      }),
    ).not.toThrow();
  });

  it('refuses invalid JSON', () => {
    expect(() => validateEgressEnv({ VITE_ENDPOINTS: '{fx:' })).toThrow(
      /VITE_ENDPOINTS is not valid JSON/,
    );
  });

  it.each(['[]', 'null', '"https://x.example"', '42'])(
    'refuses a non-object %s',
    (value) => {
      expect(() => validateEgressEnv({ VITE_ENDPOINTS: value })).toThrow(
        /VITE_ENDPOINTS must be a JSON object/,
      );
    },
  );

  it('refuses an unknown key, naming it', () => {
    expect(() =>
      validateEgressEnv({
        VITE_ENDPOINTS: JSON.stringify({ spotprice: 'https://x.example' }),
      }),
    ).toThrow(/unknown key "spotprice"/);
  });

  it.each([
    ['http', 'http://fx.example.gov'],
    ['bare host', 'fx.example.gov'],
    ['empty', ''],
    ['javascript', 'javascript:alert(1)'],
  ])('refuses a %s value', (_label, value) => {
    expect(() =>
      validateEgressEnv({ VITE_ENDPOINTS: JSON.stringify({ fx: value }) }),
    ).toThrow(/VITE_ENDPOINTS\.fx must be an https:\/\/ URL/);
  });

  it('refuses a non-string value', () => {
    expect(() =>
      validateEgressEnv({ VITE_ENDPOINTS: JSON.stringify({ fx: 1 }) }),
    ).toThrow(/VITE_ENDPOINTS\.fx must be an https:\/\/ URL/);
  });
});
