import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { inflateRawSync } from 'node:zlib';
import type { LedgerEvent } from '@/ledger/types';
import {
  getAllEvents,
  getSources,
  openLedger,
  putEvents,
  putSource,
} from '@/ledger/db';
import {
  buildCheckpoint,
  chooseChannel,
  generateTransferSecret,
  openCheckpoint,
  restoreCheckpoint,
  sealCheckpoint,
  QR_BYTE_LIMIT,
  type Checkpoint,
} from '@/checkpoint/format';
import {
  getSettings,
  isOnboarded,
  putSettings,
} from '@/settings/settingsStore';

const authored = (externalId: string): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'manual',
  externalId,
  timestamp: 1_700_000_000_000,
  kind: 'fiat-in',
  origin: 'authored',
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '500',
      direction: 'in',
      venue: 'bank',
      role: 'principal',
    },
  ],
});

// Mirrors crypto.ts's own compress/decompress helpers, but kept separate
// (and unbounded) here so tests can run deflate-raw directly against raw
// bytes to probe what the sealed envelope actually contains.
const rawDeflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

// The wire format documented in src/checkpoint/crypto.ts:
// MAGIC(2) | FORMAT_BYTE(1) | salt(16) | iv(12), then ciphertext.
const HEADER_LENGTH = 2 + 1 + 16 + 12;

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
});

describe('the transfer secret', () => {
  it('is eight base32 characters, so a leaked QR is not brute-forceable', () => {
    // A six-digit PIN is a million combinations - hours of offline guessing if
    // the image leaks. Eight base32 characters is ~40 bits.
    const secret = generateTransferSecret();
    expect(secret).toMatch(/^[A-Z2-7]{8}$/);
    const many = new Set(Array.from({ length: 200 }, generateTransferSecret));
    expect(many.size).toBeGreaterThan(190);
  });
});

describe('normalising the base currency on write', () => {
  it('lowercases baseCurrency through putSettings', async () => {
    await putSettings({ baseCurrency: 'EUR' });
    expect((await getSettings())?.baseCurrency).toBe('eur');
  });

  it('lowercases baseCurrency through restoreCheckpoint', async () => {
    await restoreCheckpoint({
      v: 1,
      settings: { language: 'de', baseCurrency: 'EUR' },
      sources: [],
      authoredEvents: [],
    });
    expect((await getSettings())?.baseCurrency).toBe('eur');
  });
});

describe('what the checkpoint carries', () => {
  it('refuses to build a checkpoint before onboarding', async () => {
    // getSettings() is null until onboarding has run. Building a checkpoint
    // anyway would have to invent a baseCurrency, producing an asset id
    // ('fiat:') that matches nothing - and there is nothing to export
    // before onboarding in the first place.
    await expect(buildCheckpoint()).rejects.toThrow();
  });

  it('includes authored events and excludes derived ones', async () => {
    // Derived rows reload from their source. Authored rows - bank movements and
    // manual corrections - have no source, so dropping them loses data.
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    await putEvents([
      authored('bank-1'),
      { ...authored('synced-1'), origin: 'derived', sourceId: 'cfg-1' },
    ]);
    const checkpoint = await buildCheckpoint();
    expect(checkpoint.authoredEvents).toHaveLength(1);
    expect(checkpoint.authoredEvents[0].externalId).toBe('bank-1');
  });

  it('round-trips settings, sources and authored events', async () => {
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    await putSource({
      id: 'cfg-1',
      moduleId: 'cardano-blockfrost',
      label: 'Main',
      config: { projectId: 'secret-project-id', address: 'addr1' },
    });
    await putEvents([authored('bank-1')]);

    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(await buildCheckpoint(), secret);
    const reopened = await openCheckpoint(sealed, secret);

    expect(reopened.settings).toEqual({ language: 'de', baseCurrency: 'eur' });
    expect(reopened.sources[0].config.projectId).toBe('secret-project-id');
    expect(reopened.authoredEvents).toHaveLength(1);
  });
});

describe('encryption', () => {
  it('produces ciphertext, not just compressed plaintext, so a secret is never recoverable without the right key', async () => {
    // A substring check against the decoded sealed bytes alone proves
    // nothing: deflating the plaintext ALONE already destroys a substring
    // match, so that check alone would pass even with encryption removed
    // entirely. The checks below prove the actual property: the body is
    // ciphertext, fresh per seal, and unreadable without the secret.
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    await putSource({
      id: 'cfg-1',
      moduleId: 'cardano-blockfrost',
      label: 'Main',
      config: { projectId: 'super-secret-value', address: 'addr1' },
    });
    const secret = generateTransferSecret();
    const checkpoint = await buildCheckpoint();

    const sealedOnce = await sealCheckpoint(checkpoint, secret);
    const sealedTwice = await sealCheckpoint(checkpoint, secret);

    expect(new TextDecoder().decode(sealedOnce)).not.toContain(
      'super-secret-value',
    );

    // Per-seal IV and salt freshness: the identical payload sealed twice
    // with the same secret must never produce identical bytes.
    expect(sealedOnce).not.toEqual(sealedTwice);

    const ciphertext = sealedOnce.slice(HEADER_LENGTH);

    // Real ciphertext is pseudorandom and does not compress. A compressed
    // plaintext body masquerading as ciphertext would shrink substantially
    // if deflated again; genuine ciphertext does not.
    const reDeflated = await rawDeflateRaw(ciphertext);
    expect(reDeflated.byteLength).toBeGreaterThanOrEqual(
      ciphertext.byteLength * 0.95,
    );

    // The plaintext is reachable only through `unseal`/`openCheckpoint`
    // with the right secret: inflating the ciphertext region directly,
    // without decrypting first, must never hand back what was sealed.
    //
    // Asserting that it THROWS is a different and weaker claim, and it is
    // false about one run in two hundred. Raw-deflate decoding of
    // pseudorandom bytes succeeds by chance roughly 0.5% of the time -
    // measured at 11 successes in 2000 real seals, and at 0.42-0.56%
    // across random buffers from 64 bytes to 16KiB, so the rate is a
    // property of the format rather than of this payload's size. The three
    // header bits pick a block type, and a fixed-Huffman block (one case
    // in four) can decode random bits all the way to an end-of-block
    // symbol without hitting an invalid code.
    //
    // What it returns when that happens is garbage - the plaintext came
    // back in 0 of those 2000 seals - so the property worth asserting is
    // the one that is deterministic. Uses node:zlib's sync API directly
    // (rather than DecompressionStream) because feeding genuinely invalid
    // deflate data through Node's WHATWG-streams zlib adapter can surface
    // as a double-emitted, unhandleable error rather than a clean promise
    // rejection.
    let inflatedDirectly: string | null = null;
    try {
      inflatedDirectly = inflateRawSync(ciphertext).toString('utf8');
    } catch {
      // The overwhelmingly common case: the bytes are not a deflate stream
      // at all. Either way the assertion below is what has to hold.
    }
    expect(inflatedDirectly ?? '').not.toContain('super-secret-value');
  });

  it('still catches a body that is merely deflated plaintext', async () => {
    // Guards the assertion above rather than the production code.
    //
    // That assertion was rewritten from "inflating throws" to "inflating
    // never yields the plaintext" to remove a 0.5% flake, and an assertion
    // that passes against a broken implementation would be a worse outcome
    // than the flake it replaced. This pins its discriminating power: on a
    // body that IS deflated plaintext - exactly what encryption being
    // removed or bypassed would leave behind - inflating succeeds and the
    // secret comes straight back out, so the assertion above fails.
    const deflatedPlaintext = await rawDeflateRaw(
      new TextEncoder().encode(
        '{"sources":[{"config":{"projectId":"super-secret-value"}}]}',
      ),
    );

    const recovered = inflateRawSync(deflatedPlaintext).toString('utf8');

    expect(recovered).toContain('super-secret-value');
  });

  it('refuses a wrong secret', async () => {
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    const sealed = await sealCheckpoint(await buildCheckpoint(), 'AAAAAAAA');
    await expect(openCheckpoint(sealed, 'BBBBBBBB')).rejects.toThrow();
  });

  it('refuses a checkpoint from a newer format version', async () => {
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(
      { ...(await buildCheckpoint()), v: 99 as 1 },
      secret,
    );
    await expect(openCheckpoint(sealed, secret)).rejects.toThrow(
      /newer version/i,
    );
  });

  it('rejects a decrypted payload that is not a well-formed checkpoint, even though it authenticated', async () => {
    // Decrypting with the right secret proves the bytes are AUTHENTICATED,
    // not that they are WELL-FORMED. A payload that is valid JSON with the
    // right version but a malformed field must still be rejected, rather
    // than trusted by the `as Checkpoint` cast and handed to
    // restoreCheckpoint.
    const secret = generateTransferSecret();
    const malformed = {
      v: 1,
      settings: { language: 'de', baseCurrency: 'eur' },
      sources: 'not-an-array',
      authoredEvents: [],
    } as unknown as Checkpoint;
    const sealed = await sealCheckpoint(malformed, secret);

    await expect(openCheckpoint(sealed, secret)).rejects.toThrow(/malformed/i);
  });
});

describe('the sealed envelope', () => {
  it('rejects a buffer too short to contain a header', async () => {
    await expect(
      openCheckpoint(new Uint8Array(HEADER_LENGTH - 1), 'AAAAAAAA'),
    ).rejects.toThrow(/not a coineda checkpoint/i);
  });

  it('reports a bad magic prefix as "not a checkpoint", not an auth failure', async () => {
    // The brief's reason for having a header at all: a format problem must
    // report as a format problem, not surface as a confusing AES-GCM
    // authentication failure.
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(await buildCheckpoint(), secret);
    const corrupted = new Uint8Array(sealed);
    corrupted[0] ^= 0xff;

    await expect(openCheckpoint(corrupted, secret)).rejects.toThrow(
      /not a coineda checkpoint/i,
    );
  });

  it('reports an unsupported format byte as a format problem, not an auth failure', async () => {
    await putSettings({ language: 'de', baseCurrency: 'eur' });
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(await buildCheckpoint(), secret);
    const corrupted = new Uint8Array(sealed);
    corrupted[2] = 0xff; // the format byte, right after the 2-byte magic

    await expect(openCheckpoint(corrupted, secret)).rejects.toThrow(
      /unsupported checkpoint format/i,
    );
  });
});

describe('choosing a channel', () => {
  it('picks the QR for a small checkpoint', () => {
    expect(chooseChannel(new Uint8Array(500)).channel).toBe('qr');
  });

  it('refuses the QR rather than truncating a large checkpoint', () => {
    // Review Focus 4: a truncated QR would scan back into a partial setup that
    // looks complete.
    const result = chooseChannel(new Uint8Array(QR_BYTE_LIMIT + 1));
    expect(result.channel).toBe('file');
    expect(result.bytes).toBe(QR_BYTE_LIMIT + 1);
  });
});

describe('restoring', () => {
  it('is atomic: a failure part-way leaves nothing applied', async () => {
    // Review Focus 5. A half-restored install - settings applied, sources
    // missing, onboarded already true - is worse than a failed restore.
    const broken = {
      v: 1 as const,
      settings: { language: 'de', baseCurrency: 'eur' },
      sources: [
        {
          id: 'cfg-1',
          moduleId: 'cardano-blockfrost',
          label: 'Main',
          config: { address: 'addr1' },
        },
      ],
      // An event with an invalid amount makes assertValidEvent reject.
      // restoreCheckpoint never calls putEvents - see the doc comment on
      // restoreCheckpoint in src/checkpoint/format.ts.
      authoredEvents: [
        {
          ...authored('bad'),
          legs: [
            {
              assetId: 'fiat:eur',
              amount: '1e3',
              direction: 'in' as const,
              venue: 'bank',
              role: 'principal' as const,
            },
          ],
        },
      ],
    };

    await expect(restoreCheckpoint(broken)).rejects.toThrow();

    expect(await getSources()).toHaveLength(0);
    expect(await getAllEvents()).toHaveLength(0);
    expect(await getSettings()).toBeNull();
    expect(await isOnboarded()).toBe(false);
  });

  it('merges onto a row the device already has, rather than failing whole', async () => {
    // This replaces a test that forced IndexedDB's own ConstraintError on
    // the unique 'identity' index by restoring two events with one
    // identity. That failure is no longer reachable: restore writes
    // THROUGH that index, the way putEvents does, because a checkpoint now
    // carries synced events too - and restoring a backup onto a device
    // that already synced the same source is the ordinary case, not an
    // error. The two rows carry the same [sourceId, externalId] under
    // different ids, so a bare put would collide and abort the whole
    // restore.
    //
    // The transaction's rollback behaviour is still covered, by the test
    // below: a plain JS throw mid-transaction, which is the failure mode
    // that remains after this.
    const local = { ...authored('shared'), id: 'local-id' };
    await putEvents([local]);

    const incoming = {
      ...authored('shared'),
      id: 'checkpoint-id',
      legs: [
        {
          assetId: 'fiat:eur',
          amount: '900',
          direction: 'in' as const,
          venue: 'bank',
          role: 'principal' as const,
        },
      ],
    };

    await expect(
      restoreCheckpoint({
        v: 1,
        settings: { language: 'de', baseCurrency: 'eur' },
        sources: [],
        authoredEvents: [incoming],
      }),
    ).resolves.toBeUndefined();

    const rows = await getAllEvents();
    expect(rows).toHaveLength(1);
    // The device's own id survives, the checkpoint's content wins.
    expect(rows[0].id).toBe('local-id');
    expect(rows[0].legs[0].amount).toBe('900');
  });

  it('rolls back a plain JS throw after an awaited put, not just a failed IDB request', async () => {
    // Found experimentally: a failed IDB request aborts its transaction on
    // its own, but a plain JS throw does not - if it happens after an
    // awaited put has already resolved and before any further request is
    // queued, there is no pending request for IndexedDB to notice, so
    // without an explicit abort it auto-commits whatever was already
    // queued. `sources: null` (calling restoreCheckpoint directly, bypassing
    // openCheckpoint's own shape check) throws a plain TypeError from
    // `for (const source of checkpoint.sources)` AFTER the settings write
    // has already been awaited inside the transaction - exactly the gap
    // that let a half-restored install through.
    await expect(
      restoreCheckpoint({
        v: 1,
        settings: { language: 'de', baseCurrency: 'eur' },
        sources: null as never,
        authoredEvents: [],
      }),
    ).rejects.toThrow();

    expect(await getSources()).toHaveLength(0);
    expect(await getAllEvents()).toHaveLength(0);
    expect(await getSettings()).toBeNull();
    expect(await isOnboarded()).toBe(false);
  });

  it('flips onboarded last, once everything else landed', async () => {
    await restoreCheckpoint({
      v: 1,
      settings: { language: 'de', baseCurrency: 'eur' },
      sources: [],
      authoredEvents: [authored('bank-1')],
    });
    expect(await isOnboarded()).toBe(true);
    expect(await getAllEvents()).toHaveLength(1);
  });
});
