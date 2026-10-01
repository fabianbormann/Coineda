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
    // with the right secret - inflating the ciphertext region directly,
    // without decrypting first, must fail rather than silently returning
    // garbage that happens to look like something. Uses node:zlib's sync
    // API directly (rather than DecompressionStream) because feeding
    // genuinely invalid deflate data through Node's WHATWG-streams zlib
    // adapter can surface as a double-emitted, unhandleable error rather
    // than a clean promise rejection.
    expect(() => inflateRawSync(ciphertext)).toThrow();
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

  it('rolls back a failure that happens inside the transaction, after earlier writes already ran', async () => {
    // The test above proves pre-transaction validation stops a bad payload
    // before any write happens - a real guarantee, but not the one this
    // module actually claims: that restore uses ONE transaction spanning
    // settings/sources/events, so a failure partway through is rolled back
    // by IndexedDB itself. Two authored events sharing one identity
    // ([sourceId, externalId]) each pass assertValidEvent individually, then
    // the second event's put() throws IndexedDB's own ConstraintError on the
    // unique 'identity' index - inside the transaction, after the settings
    // write, the source write and the first event's write have already
    // executed. A source is included so getSources() below is a real
    // assertion, not a vacuous one against an empty fixture.
    const first = authored('dup');
    const second = authored('dup');

    await expect(
      restoreCheckpoint({
        v: 1,
        settings: { language: 'de', baseCurrency: 'eur' },
        sources: [
          {
            id: 'cfg-1',
            moduleId: 'cardano-blockfrost',
            label: 'Main',
            config: { address: 'addr1' },
          },
        ],
        authoredEvents: [first, second],
      }),
    ).rejects.toThrow();

    expect(await getSources()).toHaveLength(0);
    expect(await getAllEvents()).toHaveLength(0);
    expect(await getSettings()).toBeNull();
    expect(await isOnboarded()).toBe(false);
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
