import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runConformance } from '@/sources/conformance';
import bitcoinEsplora from '@/sources/bitcoin-esplora';
import { parseAccountKey } from '@/sources/bitcoin-esplora/xpub';
import { addressFor } from '@/sources/bitcoin-esplora/script';
import { clearWalletCache } from '@/sources/bitcoin-esplora/wallet';
import type { DerivedEvent } from '@/sources/types';

/**
 * The merge gate for the xpub drain.
 *
 * **Why these transactions are synthetic, when every other module in this
 * repository is gated on recorded provider responses.**
 *
 * Recording the BIP84 published vector's account was attempted and the
 * result discarded: it came to 2.8MB across 92 files, with 2MB of that in
 * four pages of its first receive address, because that address is the
 * canonical test vector and has been dusted by years of other people's
 * testing - one single page is 1.1MB. That is the same shape as the
 * exchange-consolidation wallet rejected while recording the address-list
 * fixtures, and committing it would be five times the largest fixture set
 * here. No other published xpub vector exists to use instead, and inventing
 * one means holding a real wallet's key.
 *
 * What is lost by not recording, and why it is already covered: the point of
 * recorded bodies is proving the module parses what the provider really
 * sends. The xpub path and the address-list path share one translator - the
 * same `legsForTransaction`, the same `amountString`, the same
 * `isConfirmedWithDate` - and the address-list path IS gated on recorded
 * Blockstream responses in tests/bitcoinEsploraFixtures.test.ts, including a
 * real UTXO consolidation and a transaction spanning two configured
 * addresses. Only WHICH addresses get requested differs, and that is
 * derivation, pinned against BIP84's own vectors in tests/bitcoinScript.test.ts.
 *
 * What is NOT substituted for: these bodies are written here, so they cannot
 * be evidence about the provider's shape, and this file does not pretend
 * otherwise. Re-serving recorded bodies from another provider under derived
 * addresses would have been worse - that is precisely the mistake the Cardano
 * module shipped for a whole milestone, where Blockfrost tests replayed Yaci
 * bodies carrying a field Blockfrost never sends.
 *
 * What runConformance still earns here, all of it independent of whose bytes
 * these are: a replayed drain must produce the same externalIds AND the same
 * content per externalId, no externalId may repeat within a run, pagination
 * must terminate, every event must match the manifest's declared kinds, and
 * amounts must be decimal strings.
 */
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const ROOT = 'https://blockstream.info/api';
const config = { xpub: ZPUB };

const account = () => {
  const parsed = parseAccountKey(ZPUB);
  if ('problem' in parsed) throw new Error('fixture key must parse');
  return parsed.key;
};
const at = (chain: 0 | 1, index: number) =>
  addressFor('p2wpkh', account().publicKeyAt(chain, index), 'mainnet');

const txsUrl = (address: string) => `${ROOT}/address/${address}/txs`;

/**
 * A wallet with the shape that matters: a funded receive address, a second
 * one, a transfer to its own change address, and a transaction that touches
 * two of its addresses at once.
 */
const bodies = () => {
  const inbound = {
    txid: 'a'.repeat(64),
    status: {
      confirmed: true,
      block_height: 800_000,
      block_time: 1_700_000_000,
    },
    vin: [
      {
        prevout: {
          scriptpubkey_address: 'bc1qstrangerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          value: 500_000,
        },
      },
    ],
    vout: [{ scriptpubkey_address: at(0, 0), value: 499_000 }],
    fee: 1000,
  };
  const selfTransfer = {
    txid: 'b'.repeat(64),
    status: {
      confirmed: true,
      block_height: 800_001,
      block_time: 1_700_086_400,
    },
    vin: [{ prevout: { scriptpubkey_address: at(0, 0), value: 499_000 } }],
    vout: [
      { scriptpubkey_address: at(1, 0), value: 300_000 },
      { scriptpubkey_address: at(0, 1), value: 197_000 },
    ],
    fee: 2000,
  };
  return new Map<string, unknown[]>([
    [at(0, 0), [inbound, selfTransfer]],
    [at(0, 1), [selfTransfer]],
    [at(1, 0), [selfTransfer]],
  ]);
};

const stub = () => {
  const served = bodies();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      const match = [...served.entries()].find(([a]) => key === txsUrl(a));
      return new Response(JSON.stringify(match ? match[1] : []), {
        status: 200,
      });
    }),
  );
};

beforeEach(() => {
  clearWalletCache();
  stub();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bitcoin-esplora, xpub drain', () => {
  it('passes the conformance suite', async () => {
    await expect(
      runConformance(bitcoinEsplora, { config }),
    ).resolves.toBeUndefined();
  });

  it('emits each transaction exactly once across the whole wallet', async () => {
    const events: DerivedEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await bitcoinEsplora.fetchEvents(config, cursor);
      events.push(...page.events);
      cursor = page.cursor;
    } while (cursor !== null);

    // Two transactions, though one of them appears under three of the
    // wallet's addresses.
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  it('nets the self-transfer to its fee and the inbound to its full value', async () => {
    const events: DerivedEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await bitcoinEsplora.fetchEvents(config, cursor);
      events.push(...page.events);
      cursor = page.cursor;
    } while (cursor !== null);

    const netOf = (externalId: string) =>
      events
        .find((e) => e.externalId === externalId)!
        .legs.reduce(
          (total, leg) =>
            total + (leg.direction === 'in' ? 1 : -1) * Number(leg.amount),
          0,
        );

    // Received from a stranger: the whole output is a gain to this wallet.
    expect(netOf('a'.repeat(64))).toBe(499_000);
    // Spent to its OWN change and its OWN second receive address: only the
    // fee left. A per-address leg filter would report -499000 here and tax a
    // transfer that never left the wallet.
    expect(netOf('b'.repeat(64))).toBe(-2000);
  });

  it('attributes every leg to one venue, the wallet first receive address', async () => {
    const events: DerivedEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await bitcoinEsplora.fetchEvents(config, cursor);
      events.push(...page.events);
      cursor = page.cursor;
    } while (cursor !== null);

    const legs = events.flatMap((e) => e.legs);
    expect(legs.length).toBeGreaterThan(2);
    expect(new Set(legs.map((leg) => leg.venue))).toEqual(new Set([at(0, 0)]));
    // Satoshis, as integer decimal strings - never scaled here.
    for (const leg of legs) {
      expect(leg.amount).toMatch(/^\d+$/);
      expect(leg.assetId).toBe('bitcoin:native');
    }
  });

  it('stamps milliseconds, from a known block time', async () => {
    const page = await bitcoinEsplora.fetchEvents(config, null);
    const inbound = page.events.find((e) => e.externalId === 'a'.repeat(64));
    expect(inbound?.timestamp).toBe(1_700_000_000 * 1000);
  });
});
