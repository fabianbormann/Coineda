import { describe, it, expect } from 'vitest';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseAccountKey } from '@/sources/bitcoin-esplora/xpub';

/**
 * The BIP84 published test vector, account 0, from the mnemonic
 * "abandon abandon ... about". A published vector and never a real wallet's
 * key - the same rule the recorded fixtures follow, and it matters more here
 * than anywhere else in this repository, because an extended public key
 * reveals its wallet's whole past and future.
 */
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const b58 = base58check(sha256);

/** Rebuilds the vector's payload under different version bytes, which is how
 *  the SLIP-132 table was verified in the first place. */
const reVersion = (hex: string): string => {
  const payload = b58.decode(ZPUB).slice(4);
  const version = Uint8Array.from(
    hex.match(/../g)!.map((h) => Number.parseInt(h, 16)),
  );
  return b58.encode(new Uint8Array([...version, ...payload]));
};

const keyOf = (value: string) => {
  const result = parseAccountKey(value);
  if ('problem' in result) {
    throw new Error(`expected a key, got problem '${result.problem}'`);
  }
  return result.key;
};

const problemOf = (value: string) => {
  const result = parseAccountKey(value);
  return 'problem' in result ? result.problem : null;
};

describe('parseAccountKey', () => {
  it('accepts the BIP84 vector and reports mainnet', () => {
    const key = keyOf(ZPUB);
    expect(key.network).toBe('mainnet');
  });

  it('derives a compressed public key at a given chain and index', () => {
    const pubkey = keyOf(ZPUB).publicKeyAt(0, 0);
    expect(pubkey).toHaveLength(33);
    // Compressed form: 0x02 or 0x03. An uncompressed key would be 65 bytes
    // and would hash to a different, wrong address.
    expect([0x02, 0x03]).toContain(pubkey[0]);
  });

  it('derives different keys per chain and per index', () => {
    const key = keyOf(ZPUB);
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const seen = [
      hex(key.publicKeyAt(0, 0)),
      hex(key.publicKeyAt(0, 1)),
      hex(key.publicKeyAt(1, 0)),
      hex(key.publicKeyAt(1, 1)),
    ];
    // Four distinct keys. A derivation that ignored its arguments would
    // return one key four times, and every address in the wallet would
    // collapse onto a single one.
    expect(new Set(seen).size).toBe(4);
  });

  it('accepts every known public version and maps it to a network', () => {
    // The verified SLIP-132 table. xpub/ypub/zpub differ only in these four
    // bytes, which is exactly why the prefix says nothing about the address
    // type - only about the network.
    for (const hex of ['0488b21e', '049d7cb2', '04b24746']) {
      expect(keyOf(reVersion(hex)).network).toBe('mainnet');
    }
    for (const hex of ['043587cf', '044a5262', '045f1cf6']) {
      expect(keyOf(reVersion(hex)).network).toBe('testnet');
    }
  });

  it('REFUSES a private key outright', () => {
    // Review Focus 1. A private key in a browser's IndexedDB is the worst
    // outcome this feature could produce, and someone pasting xprv where
    // xpub was asked for is an ordinary mistake, not a hostile act.
    expect(problemOf(reVersion('0488ade4'))).toBe('privateKey');
    expect(problemOf(reVersion('04b2430c'))).toBe('privateKey');
  });

  it('names a private key as one even under version bytes it does not know', () => {
    // This is the case only the STRUCTURAL guard can catch, and writing it
    // is what makes the two guards independent rather than merely described
    // as such: dropping the offset-45 check left every other test in this
    // file green, because the version table already covers xprv and zprv.
    //
    // A serialised private key carries 0x00 ahead of its 32 bytes where a
    // public key carries a compressed point's 0x02/0x03. So a private key
    // under an unrecognised version - a future SLIP prefix, a wallet's own
    // variant - is still recognisable from its shape, and saying "that is
    // your private key" beats "unknown format" by a wide margin when that
    // is what someone has just pasted into a browser.
    const raw = b58.decode(ZPUB);
    const privateShaped = new Uint8Array(raw);
    privateShaped[0] = 0x01;
    privateShaped[1] = 0x02;
    privateShaped[2] = 0x03;
    privateShaped[3] = 0x04;
    privateShaped[45] = 0x00;
    expect(problemOf(b58.encode(privateShaped))).toBe('privateKey');
  });

  it('refuses a key that is not at account depth', () => {
    // Review Focus 2. A master key derives 0/i perfectly happily and yields
    // a completely different, valid, WRONG wallet - silently. Only depth 3
    // is an account key.
    const raw = b58.decode(ZPUB);
    for (const depth of [0, 1, 2, 4]) {
      const altered = new Uint8Array(raw);
      altered[4] = depth;
      expect(problemOf(b58.encode(altered))).toBe('wrongDepth');
    }
    expect(problemOf(ZPUB)).toBeNull();
  });

  it('tolerates surrounding whitespace but never folds case', () => {
    // Review Focus 3. A pasted key arrives with a newline, so trimming is
    // required - but base58 is case-sensitive, so folding case would corrupt
    // the key. Uppercasing must fail cleanly rather than parse into
    // something else.
    expect(keyOf(`  ${ZPUB}\n`).network).toBe('mainnet');
    expect(problemOf(ZPUB.toUpperCase())).toBe('notAKey');
  });

  it('refuses unknown version bytes rather than guessing', () => {
    expect(problemOf(reVersion('00000000'))).toBe('unknownVersion');
  });

  it('refuses anything that is not a base58check string', () => {
    expect(problemOf('')).toBe('notAKey');
    expect(problemOf('not a key')).toBe('notAKey');
    // A single transposed character breaks the checksum. It must not decode
    // into a plausible different key.
    const swapped = `${ZPUB.slice(0, -2)}${ZPUB.slice(-1)}${ZPUB.slice(-2, -1)}`;
    expect(swapped).not.toBe(ZPUB);
    expect(problemOf(swapped)).toBe('notAKey');
  });

  it('refuses a payload of the wrong length', () => {
    const raw = b58.decode(ZPUB);
    expect(problemOf(b58.encode(raw.slice(0, 70)))).toBe('notAKey');
  });
});
