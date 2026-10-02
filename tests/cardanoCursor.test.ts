import { describe, it, expect } from 'vitest';
import {
  decodeCursor,
  encodeAccountCursor,
  encodeAddressCursor,
} from '@/sources/cardano/cursor';

const HASH = '3d20f62fee6896fb0a8c0b2b7ae0e0b55b15ba13a54b7a1c5be1b1ba0bbd44ff';
const ACCOUNT = 'stake1u8j4gm959d5ppzgj2fpzh78a7hv6lw544dneenalx9fl6jqzpkxrm';

describe('decodeCursor', () => {
  it('starts a drain on null', () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it('reads a bare number as an address-tier page', () => {
    // Review Focus 5. Every cursor on disk today is a bare page number,
    // written before tiers existed. A source that was mid-sync when the app
    // upgraded must resume where it was: read as an account cursor it would
    // resume at an unrelated position in a different listing, and read as
    // unparseable it would re-drain a long history from the start.
    expect(decodeCursor('7')).toEqual({ tier: 'address', page: 7 });
    expect(decodeCursor('1')).toEqual({ tier: 'address', page: 1 });
  });

  it('round-trips an address cursor', () => {
    expect(decodeCursor(encodeAddressCursor(4))).toEqual({
      tier: 'address',
      page: 4,
    });
  });

  it('round-trips an account cursor, carrying the boundary hash and the account', () => {
    expect(decodeCursor(encodeAccountCursor(3, HASH, ACCOUNT))).toEqual({
      tier: 'account',
      page: 3,
      lastTxHash: HASH,
      account: ACCOUNT,
    });
  });

  it('accepts an empty boundary hash, which suppresses nothing', () => {
    expect(decodeCursor(encodeAccountCursor(2, '', ACCOUNT))).toEqual({
      tier: 'account',
      page: 2,
      lastTxHash: '',
      account: ACCOUNT,
    });
  });

  it('restarts rather than guess at anything it does not recognise', () => {
    // A page number replayed against the wrong tier's listing resumes at an
    // unrelated position and silently skips history. This project has twice
    // ruled that worse than refetching, so an unrecognised cursor is null.
    for (const cursor of [
      'acct',
      'acct:',
      'acct:2',
      `acct:2:${HASH}`,
      `acct:0:${HASH}:${ACCOUNT}`,
      `acct:x:${HASH}:${ACCOUNT}`,
      `acct:2:${HASH}:`,
      'addr',
      'addr:',
      'addr:0',
      'addr:x',
      'page=2',
      '0',
      '-1',
      '1.5',
      '',
      ' 2',
    ]) {
      expect(decodeCursor(cursor)).toBeNull();
    }
  });

  it('never produces a cursor another tier would accept', () => {
    // The prefixes are the whole mechanism keeping the two sequences apart.
    expect(decodeCursor(encodeAddressCursor(9))?.tier).toBe('address');
    expect(decodeCursor(encodeAccountCursor(9, HASH, ACCOUNT))?.tier).toBe(
      'account',
    );
  });
});
