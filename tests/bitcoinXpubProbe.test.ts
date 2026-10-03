import { describe, it, expect, afterEach, vi } from 'vitest';
import bitcoinEsplora from '@/sources/bitcoin-esplora';
import {
  BITCOIN_ESPLORA_MESSAGES,
  detectScriptType,
} from '@/sources/bitcoin-esplora/translator';
import { parseAccountKey } from '@/sources/bitcoin-esplora/xpub';
import { addressFor, SCRIPT_TYPES } from '@/sources/bitcoin-esplora/script';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const ROOT = 'https://blockstream.info/api';
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const b58 = base58check(sha256);
const accountKey = () => {
  const parsed = parseAccountKey(ZPUB);
  if ('problem' in parsed) throw new Error('fixture key must parse');
  return parsed.key;
};

/** The receive-chain address for a type at an index, as the probe will
 *  derive it - so a stub keyed on this is keyed on the real URL. */
const receiveAddress = (type: (typeof SCRIPT_TYPES)[number], index: number) =>
  addressFor(type, accountKey().publicKeyAt(0, index), 'mainnet');

const txsUrl = (address: string) => `${ROOT}/address/${address}/txs`;

const tx = {
  txid: 'aa'.repeat(32),
  status: { confirmed: true, block_height: 1, block_time: 1_700_000_000 },
  vin: [],
  vout: [],
  fee: 1,
};

/** Serves `[]` for every address except those listed as having history, and
 *  records what was asked for. */
const stub = (withHistory: string[]) => {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      const hit = withHistory.some((address) => key === txsUrl(address));
      return new Response(JSON.stringify(hit ? [tx] : []), { status: 200 });
    }),
  );
  return seen;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('detectScriptType', () => {
  it.each(SCRIPT_TYPES)(
    'detects %s when only that encoding has history',
    async (type) => {
      // The whole point: the key's prefix says zpub, but the encoding is
      // decided by what the chain actually knows about.
      stub([receiveAddress(type, 0)]);
      await expect(detectScriptType(accountKey(), ROOT)).resolves.toBe(type);
    },
  );

  it('looks past an unused first address', async () => {
    // A wallet whose address 0 was never used but whose later ones were is a
    // real wallet. Probing index 0 alone would refuse it as empty, which is
    // the false negative this walks five indices to avoid.
    stub([receiveAddress('p2wpkh', 3)]);
    await expect(detectScriptType(accountKey(), ROOT)).resolves.toBe('p2wpkh');
  });

  it('costs exactly one request when the first guess is right', async () => {
    // Native SegWit first is not cosmetic - it is what keeps the common case
    // from paying for the whole search.
    const seen = stub([receiveAddress('p2wpkh', 0)]);
    await detectScriptType(accountKey(), ROOT);
    expect(seen).toEqual([txsUrl(receiveAddress('p2wpkh', 0))]);
  });

  it('gives up rather than guessing when nothing has history', async () => {
    stub([]);
    await expect(detectScriptType(accountKey(), ROOT)).resolves.toBeNull();
  });
});

describe('probe, with an xpub', () => {
  it('accepts a wallet whose native SegWit addresses have history', async () => {
    stub([receiveAddress('p2wpkh', 0)]);
    const result = await bitcoinEsplora.probe({ xpub: ZPUB });
    expect(result.ok).toBe(true);
    // An extended PUBLIC key confers no spending power, so this can be
    // stated with certainty rather than left undefined.
    expect(result.readOnly).toBe(true);
  });

  it('refuses an empty wallet with the explanation, not a bare failure', async () => {
    stub([]);
    const result = await bitcoinEsplora.probe({ xpub: ZPUB });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITCOIN_ESPLORA_MESSAGES.noHistory);
  });

  it('names a pasted PRIVATE key as one', async () => {
    // The mistake worth naming precisely: someone pasting xprv where xpub
    // was asked for needs to be told what they just pasted, not handed a
    // generic "invalid".
    const raw = b58.decode(ZPUB);
    const asPrivate = new Uint8Array(raw);
    asPrivate[0] = 0x04;
    asPrivate[1] = 0x88;
    asPrivate[2] = 0xad;
    asPrivate[3] = 0xe4;
    const result = await bitcoinEsplora.probe({ xpub: b58.encode(asPrivate) });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITCOIN_ESPLORA_MESSAGES.xpubPrivateKey);
  });

  it('distinguishes a wrong-depth key from an unreadable one', async () => {
    const raw = b58.decode(ZPUB);
    const shallow = new Uint8Array(raw);
    shallow[4] = 0;
    const wrongDepth = await bitcoinEsplora.probe({
      xpub: b58.encode(shallow),
    });
    expect(wrongDepth.message).toBe(BITCOIN_ESPLORA_MESSAGES.xpubWrongDepth);

    const garbage = await bitcoinEsplora.probe({ xpub: 'not a key' });
    expect(garbage.message).toBe(BITCOIN_ESPLORA_MESSAGES.xpubNotAKey);
    // Three different problems, three different messages - a single
    // "invalid key" would leave the user with nothing to act on.
    expect(new Set([wrongDepth.message, garbage.message]).size).toBe(2);
  });

  it('refuses when neither an xpub nor an address is given', async () => {
    const result = await bitcoinEsplora.probe({});
    expect(result.ok).toBe(false);
    expect(result.message).toBe(BITCOIN_ESPLORA_MESSAGES.nothingToTrack);
  });

  it('never leaks the key into a message', async () => {
    // Whatever this returns is stored as the source's lastError and rendered
    // on screen. An xpub reveals a wallet's whole history, so it must not
    // travel in a diagnostic.
    stub([]);
    const configs: Record<string, string>[] = [
      { xpub: ZPUB },
      { xpub: 'not a key' },
      {},
    ];
    for (const config of configs) {
      const result = await bitcoinEsplora.probe(config);
      // The KEY must not appear. The word "zpub" legitimately does - the
      // messages name the prefixes to look for, which is guidance rather
      // than a leak - so this checks the key's own distinctive payload.
      expect(result.message ?? '').not.toContain(ZPUB.slice(4));
      expect(result.message ?? '').not.toContain(ZPUB.slice(20, 48));
    }
  });
});
