import { describe, expect, it } from 'vitest';
import { registerValueLookup } from '@/carf/registerValues';
import type { RegisterRow } from '@/tax/types';

const BTC = 'bitcoin:native';

const row = (overrides: Partial<RegisterRow>): RegisterRow => ({
  year: 2026,
  fingerprint: 'f',
  date: '2026-05-01T12:00:00.000Z',
  kind: 'disposal',
  sourceEventId: 'e1',
  source: 'Bitpanda',
  assetId: BTC,
  symbol: 'BTC',
  amount: '1000000',
  amountWhole: '0.01',
  venue: 'bitpanda',
  currency: 'EUR',
  ...overrides,
});

describe('registerValueLookup', () => {
  it('takes the principal disposal over a fee disposal of the same event, in any order', () => {
    const fee = row({ amount: '5000', value: '3' });
    const principal = row({ amount: '1000000', value: '600' });
    expect(registerValueLookup([fee, principal])('e1', BTC)).toBe('600');
    expect(registerValueLookup([principal, fee])('e1', BTC)).toBe('600');
  });

  it('prefers a valued acquisition, disposal or income row over other kinds', () => {
    const lookup = registerValueLookup([
      row({ kind: 'internal-transfer', value: '1' }),
      row({ kind: 'unresolved' }),
      row({ kind: 'income', value: '7' }),
    ]);
    expect(lookup('e1', BTC)).toBe('7');
  });

  it('skips rows without a value and falls back to another valued row', () => {
    const lookup = registerValueLookup([
      row({ kind: 'acquisition' }),
      row({ kind: 'capital-gain', value: '9' }),
    ]);
    expect(lookup('e1', BTC)).toBe('9');
    expect(lookup('e1', 'eth:native')).toBeUndefined();
    expect(registerValueLookup([row({})])('e1', BTC)).toBeUndefined();
  });
});
