import { describe, it, expect } from 'vitest';
import { parseAccountKey } from '@/sources/bitcoin-esplora/xpub';
import {
  SCRIPT_TYPES,
  addressFor,
  type ScriptType,
} from '@/sources/bitcoin-esplora/script';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const key = () => {
  const parsed = parseAccountKey(ZPUB);
  if ('problem' in parsed) {
    throw new Error('fixture key must parse');
  }
  return parsed.key;
};

/**
 * Expected addresses for the BIP84 test vector's account 0.
 *
 * The `p2wpkh` column is the BIP's own published vector. The other two were
 * produced by @scure/btc-signer, an audited implementation, used once as an
 * oracle and then removed - and the reason that is trustworthy rather than
 * circular is that the same oracle reproduced all three published `p2wpkh`
 * addresses exactly, so it was checked against the BIP before being relied
 * on for the columns the BIP does not publish.
 */
const MAINNET: Record<string, Record<Exclude<ScriptType, 'p2tr'>, string>> = {
  '0/0': {
    p2wpkh: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    'p2sh-p2wpkh': '3GtVZYzsKF6Feikdjd4bDyPdAiyeHANY9b',
    p2pkh: '1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso',
  },
  '0/1': {
    p2wpkh: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    'p2sh-p2wpkh': '3F6eH8MTJeGUNvetRLt6RHFdA7oc8PH6r4',
    p2pkh: '1FGr5rndZHDypjwMWqudNrKtnPHhugFXVg',
  },
  '1/0': {
    p2wpkh: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
    'p2sh-p2wpkh': '3EjM76QBfwkwVoPKaHvt1cMz2NXYfQoKUE',
    p2pkh: '16fuuGhkywq9pB7BBxi3btQ3C3s4f4dz1N',
  },
};

const TESTNET_0_0: Record<Exclude<ScriptType, 'p2tr'>, string> = {
  p2wpkh: 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0',
  'p2sh-p2wpkh': '2N8ShdHvtvhbbrWPBQkgTqvNtP5Bp33veEi',
  p2pkh: 'my6RhGaMEf8v9yyQKqiuUYniJLfyU4gzqe',
};

describe('addressFor', () => {
  it('encodes every mainnet address type for three derived keys', () => {
    const account = key();
    const got: Record<string, Record<string, string>> = {};
    for (const [path, expected] of Object.entries(MAINNET)) {
      const [chain, index] = path.split('/').map(Number) as [0 | 1, number];
      const pubkey = account.publicKeyAt(chain, index);
      got[path] = {};
      for (const type of Object.keys(expected) as Exclude<
        ScriptType,
        'p2tr'
      >[]) {
        got[path][type] = addressFor(type, pubkey, 'mainnet');
      }
    }
    // Compared as one object so a failure names every wrong cell at once
    // rather than stopping at the first.
    expect(got).toEqual(MAINNET);
  });

  it('encodes the testnet forms, which differ by more than the prefix', () => {
    // p2pkh and p2sh carry a different version BYTE on testnet, not just a
    // different leading character, and p2wpkh a different bech32 hrp. A
    // mainnet-only implementation would produce a valid mainnet address here
    // and silently watch the wrong chain.
    const pubkey = key().publicKeyAt(0, 0);
    const got = {
      p2wpkh: addressFor('p2wpkh', pubkey, 'testnet'),
      'p2sh-p2wpkh': addressFor('p2sh-p2wpkh', pubkey, 'testnet'),
      p2pkh: addressFor('p2pkh', pubkey, 'testnet'),
    };
    expect(got).toEqual(TESTNET_0_0);
  });

  it('puts native SegWit first in the probe order', () => {
    // The order is load-bearing: the probe walks it and stops at the first
    // type with history, so the most likely type being first is what keeps
    // the common case at one request.
    expect(SCRIPT_TYPES[0]).toBe('p2wpkh');
    expect(SCRIPT_TYPES).toHaveLength(3);
    expect(new Set(SCRIPT_TYPES).size).toBe(SCRIPT_TYPES.length);
  });

  it('does not claim Taproot support it has not got', () => {
    // Deliberately absent rather than half-done. A p2tr address needs the
    // TapTweak key tweak, and shipping an unvalidated tweak would produce
    // valid-looking addresses belonging to nobody - the silent-wrong-address
    // failure this module's whole design is arranged to avoid. If this ever
    // includes 'p2tr', it must arrive with the BIP86 published vectors.
    expect(SCRIPT_TYPES).not.toContain('p2tr');
  });
});
