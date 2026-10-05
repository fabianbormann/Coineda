import { describe, it, expect } from 'vitest';
import {
  parseCardanoAsset,
  shortSubject,
  subjectOf,
} from '@/assets/cardanoAsset';
import { symbolOf } from '@/components/money/asset';

/**
 * Resolving a Cardano native asset to a name, with no network.
 *
 * The subject IS the name: policy id followed by the asset name, both hex.
 * Before this, a holding of NIGHT rendered as the 66-character subject,
 * which told the user nothing and looked like a bug.
 */
const POLICY = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa';
const NIGHT = `${POLICY}4e49474854`;

describe('parseCardanoAsset', () => {
  it('decodes the asset name out of the subject', () => {
    const parsed = parseCardanoAsset(`cardano:${NIGHT}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.policyId).toBe(POLICY);
    expect(parsed?.nameHex).toBe('4e49474854');
    expect(parsed?.name).toBe('NIGHT');
    expect(parsed?.subject).toBe(NIGHT);
  });

  it('is not fooled by ADA itself', () => {
    // cardano:lovelace is the chain's own unit, named ADA everywhere in the
    // app. Treating it as a native asset would render it as an unknown
    // token whose "name" is the word lovelace.
    expect(parseCardanoAsset('cardano:lovelace')).toBeNull();
    expect(subjectOf('cardano:lovelace')).toBeNull();
  });

  it('refuses anything that is not a subject rather than guessing', () => {
    for (const bad of [
      'bitcoin:native',
      'fiat:eur',
      'cardano:d8f34b1e9c4a2b', // far too short to be a policy
      `cardano:${POLICY}zz`, // not hex
      `cardano:${POLICY}abc`, // odd number of hex digits
      `cardano:${POLICY}${'ab'.repeat(33)}`, // name past the 32-byte limit
    ]) {
      expect(parseCardanoAsset(bad)).toBeNull();
    }
  });

  it('accepts a policy with no asset name at all', () => {
    const parsed = parseCardanoAsset(`cardano:${POLICY}`);
    expect(parsed?.policyId).toBe(POLICY);
    expect(parsed?.nameHex).toBe('');
    // An empty name is not a printable name, so there is nothing to show.
    expect(parsed?.name).toBeNull();
  });

  it('declines to decode bytes that are not printable text', () => {
    // CIP-68 reference tokens begin with a four-byte binary label, and some
    // policies use raw hashes as names. Pushing those through a lenient
    // decode puts replacement characters and control codes in the middle of
    // a balance, which reads as corruption.
    const cip68 = parseCardanoAsset(`cardano:${POLICY}000643b04e4654`);
    expect(cip68).not.toBeNull();
    expect(cip68?.name).toBeNull();

    const highBytes = parseCardanoAsset(`cardano:${POLICY}fffefd`);
    expect(highBytes?.name).toBeNull();
  });
});

describe('shortSubject', () => {
  it('keeps both ends, so two assets under one policy stay distinct', () => {
    // Every asset minted under a policy shares its entire 56-character
    // prefix, so a prefix-only abbreviation renders them identically.
    const a = `${POLICY}aaaaaaaa`;
    const b = `${POLICY}bbbbbbbb`;
    expect(shortSubject(a)).not.toBe(shortSubject(b));
  });
});

describe('symbolOf, for Cardano native assets', () => {
  it('names NIGHT rather than printing its subject', () => {
    expect(symbolOf(`cardano:${NIGHT}`)).toBe('NIGHT');
    expect(symbolOf(`cardano:${NIGHT}`)).not.toContain(POLICY);
  });

  it('still names the assets it already knew', () => {
    expect(symbolOf('bitcoin:native')).toBe('BTC');
    expect(symbolOf('cardano:lovelace')).toBe('ADA');
    expect(symbolOf('eth:native')).toBe('ETH');
    expect(symbolOf('fiat:eur')).toBe('EUR');
  });

  it('abbreviates an unprintable name instead of showing 66 characters', () => {
    const symbol = symbolOf(`cardano:${POLICY}fffefd`);
    expect(symbol.length).toBeLessThan(16);
    expect(symbol).toContain('…');
  });
});
