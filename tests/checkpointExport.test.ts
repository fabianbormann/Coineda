import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {
  buildCheckpoint,
  sealCheckpoint,
  openCheckpoint,
  chooseChannel,
  encodeQrPayload,
  generateTransferSecret,
  QR_BYTE_LIMIT,
} from '@/checkpoint/format';
import { putSettings } from '@/settings/settingsStore';
import { openLedger, putSource, putEvents } from '@/ledger/db';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Renders a byte-mode QR to raw RGBA without a canvas.
 *
 * jsdom has no 2D canvas, so the production path's PNG data URL cannot be
 * decoded back in a test. QRCode.create exposes the module bitmap directly,
 * which is all jsQR needs - and it goes through the SAME segment encoding the
 * production call uses, so a byte-mode/text-mode mismatch still shows up here.
 */
const renderToImageData = (bytes: Uint8Array) => {
  const scale = 4;
  const quiet = 4;
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
  });
  const size = qr.modules.size;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark =
        mx >= 0 &&
        my >= 0 &&
        mx < size &&
        my < size &&
        qr.modules.data[my * size + mx] === 1;
      const value = dark ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
};

const authoredEvent = (n: number): LedgerEvent => ({
  id: `authored-${n}`,
  sourceId: 'manual',
  externalId: `manual-${n}`,
  timestamp: 1_700_000_000_000 + n,
  kind: 'transfer',
  origin: 'authored',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '1000000',
      direction: 'in',
      venue: 'addr_test1_mine',
      role: 'principal',
    },
  ],
});

// Deliberately not `indexedDB.deleteDatabase('coineda-v2')`, as the task
// brief originally specified: openLedger() memoises its connection at
// module-import time and never closes it, so a delete issued against an
// open connection is a no-op in fake-indexeddb just as it would be in a
// real browser (see the "v1 to current schema upgrade" test in
// tests/prices.test.ts, which documents the same caveat and explicitly
// closes the connection first). Verified experimentally: with
// deleteDatabase alone, the 400 authored events from "routes an oversized
// checkpoint..." below bled into the next test's assertions. Clearing every
// store on the already-open connection - the same pattern
// tests/checkpoint.test.ts uses - gets genuine per-test isolation without
// fighting the memoised connection.
beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
});

describe('checkpoint export', () => {
  it('round-trips through the QR channel the import side actually reads', async () => {
    // The one test that would have caught a base64-vs-bytes mismatch: it
    // encodes with the production encoder's segment shape and decodes with
    // the production decoder's library, then opens the result for real.
    await putSettings({ language: 'de', baseCurrency: 'usd' });
    await putSource({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
    });

    const checkpoint = await buildCheckpoint();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(checkpoint, secret);

    expect(chooseChannel(sealed).channel).toBe('qr');

    const decoded = jsQR(
      renderToImageData(sealed).data,
      renderToImageData(sealed).width,
      renderToImageData(sealed).height,
    );
    expect(decoded).not.toBeNull();

    const reopened = await openCheckpoint(
      new Uint8Array(decoded!.binaryData),
      secret,
    );
    expect(reopened).toEqual(checkpoint);
  });

  it('produces a data URL the dialog can render', async () => {
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    const url = await encodeQrPayload(sealed);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('seals with the generated secret and nothing else opens it', async () => {
    // Not a substring search for the secret in the ciphertext: deflate alone
    // would destroy that substring, so such a test passes against an
    // implementation that never encrypted anything. This asserts the property
    // that actually matters - the bytes are useless without the secret.
    const checkpoint = await buildCheckpoint();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(checkpoint, secret);

    await expect(openCheckpoint(sealed, secret)).resolves.toEqual(checkpoint);
    await expect(
      openCheckpoint(sealed, generateTransferSecret()),
    ).rejects.toThrow();
  });

  it('measures a realistic checkpoint against the QR limit', async () => {
    // Evidence for the single-frame ruling in this task's header, not a
    // behavioural assertion: three sources and no authored history is the
    // shape this app is built around, and it must fit one code comfortably.
    for (let n = 0; n < 3; n += 1) {
      await putSource({
        id: `src-${n}`,
        moduleId: 'cardano-yaci',
        label: `Wallet ${n}`,
        config: {
          address: `addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm${n}`,
          baseUrl: 'https://yaci-store.mainnet.colo2.cf-systems.org',
        },
      });
    }
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    console.log(
      `realistic checkpoint: ${sealed.byteLength} bytes of ${QR_BYTE_LIMIT}`,
    );
    expect(sealed.byteLength).toBeLessThan(QR_BYTE_LIMIT / 2);
  });

  it('routes an oversized checkpoint to the file channel instead of truncating', async () => {
    // Authored events are the one unbounded part of a checkpoint. Enough of
    // them must switch channel, never silently produce a QR that scans back
    // into a partial setup looking complete.
    await putEvents(Array.from({ length: 400 }, (_, n) => authoredEvent(n)));
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    expect(sealed.byteLength).toBeGreaterThan(QR_BYTE_LIMIT);
    expect(chooseChannel(sealed).channel).toBe('file');
  });

  it('carries authored events but not synced ones', async () => {
    // The settled model: the tx log reloads from its sources, so only what
    // the user typed themselves has to travel. A checkpoint that carried
    // synced history would duplicate it against a re-sync on the new device.
    await putEvents([
      authoredEvent(1),
      { ...authoredEvent(2), id: 'derived-1', origin: 'derived' },
    ]);
    const checkpoint = await buildCheckpoint();
    expect(checkpoint.authoredEvents.map((e) => e.id)).toEqual(['authored-1']);
  });

  it("leaves this device's sync state out of the checkpoint", async () => {
    // lastSyncedAt and lastError describe one device's sync history, not the
    // portable configuration. Carried across, a freshly restored device
    // with zero synced events would show "Last synced <yesterday>" plus
    // whatever error the other device happened to be sitting on.
    await putSource({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
      lastSyncedAt: 1_700_000_000_000,
      lastError: 'provider refused the request',
    });

    const checkpoint = await buildCheckpoint();

    expect(checkpoint.sources).toHaveLength(1);
    const [source] = checkpoint.sources;
    expect(source.lastSyncedAt).toBeUndefined();
    expect(source.lastError).toBeUndefined();
    // Absent, not merely undefined: the keys must not travel at all.
    expect(Object.keys(source).sort()).toEqual([
      'config',
      'id',
      'label',
      'moduleId',
    ]);
    // Everything that IS portable still travels.
    expect(source).toMatchObject({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
    });
  });

  it('refuses to build a checkpoint before onboarding has run', async () => {
    // The beforeEach above always seeds settings, so this test clears just
    // that store back out rather than relying on deleteDatabase - see the
    // comment on the beforeEach for why that call would not actually do
    // anything here.
    const db = await openLedger();
    await db.clear('settings');
    await expect(buildCheckpoint()).rejects.toThrow(/onboarding/);
  });
});
