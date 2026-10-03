import { describe, it, expect } from 'vitest';
import {
  MAX_ADDRESSES,
  addressListProblem,
  parseAddressList,
} from '@/sources/addressList';

describe('parseAddressList', () => {
  it('splits one address per line', () => {
    expect(parseAddressList('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
  it('tolerates the whitespace a paste carries', () => {
    expect(parseAddressList('  a  \n\n\t b\n   ')).toEqual(['a', 'b']);
  });
  it('splits on a lone carriage return as well as CRLF', () => {
    // CRLF alone does not discriminate: trim() strips the stray \r, so a
    // plain /\n+/ split handles it identically. A lone CR is the input that
    // distinguishes them, and the character class claims to handle it.
    expect(parseAddressList('a\r\nb')).toEqual(['a', 'b']);
    expect(parseAddressList('a\rb')).toEqual(['a', 'b']);
  });
  it('dedupes while preserving first-seen order, because order is semantic', () => {
    // The owner of a transaction appearing under several addresses is the
    // FIRST configured one, so reordering changes which address owns it.
    expect(parseAddressList('b\na\nb')).toEqual(['b', 'a']);
  });
  it('returns nothing for an absent or blank value', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('   \n  ')).toEqual([]);
  });
  it('handles a single address with no newline at all', () => {
    expect(parseAddressList('a')).toEqual(['a']);
  });
  it('treats the empty string like an absent value', () => {
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('addressListProblem', () => {
  it('accepts a normal list', () => {
    expect(addressListProblem('a\nb')).toBeNull();
  });
  it('rejects an empty list', () => {
    expect(addressListProblem('  ')).toEqual({ index: 0, reason: 'empty' });
  });
  it(`rejects more than ${MAX_ADDRESSES} addresses, naming the position only`, () => {
    const many = Array.from(
      { length: MAX_ADDRESSES + 1 },
      (_, i) => `a${i}`,
    ).join('\n');
    expect(addressListProblem(many)).toEqual({
      index: MAX_ADDRESSES,
      reason: 'tooMany',
    });
  });
  it('accepts exactly the maximum', () => {
    const exact = Array.from({ length: MAX_ADDRESSES }, (_, i) => `a${i}`).join(
      '\n',
    );
    expect(addressListProblem(exact)).toBeNull();
  });
});
