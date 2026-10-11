import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {
  buildCheckpoint,
  generateTransferSecret,
  openCheckpoint,
  QrPartCollector,
  QR_BYTE_LIMIT,
  QR_PART_BYTES,
  sealCheckpoint,
  splitQrParts,
} from '@/checkpoint/format';
import { decodeQrPayload } from '@/onboarding/ImportCheckpoint';
import { openLedger, putSource } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';

/**
 * Renders a byte-mode QR to raw RGBA without a canvas, as
 * tests/checkpointExport.test.ts does: jsdom has no 2D canvas, and
 * QRCode.create goes through the same segment encoding as production.
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

const versionOf = (bytes: Uint8Array): number =>
  QRCode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'M' })
    .version;

/** A sealed checkpoint's shape - the real magic, a random salt - at any
 *  length, without paying for PBKDF2. */
const fakeSealed = (length: number, salt = 0x1234): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + 7) & 255;
  }
  bytes[0] = 0xc0;
  bytes[1] = 0xed;
  bytes[2] = 1;
  bytes[3] = salt >> 8;
  bytes[4] = salt & 255;
  return bytes;
};

const collect = (parts: Uint8Array[]) => {
  const collector = new QrPartCollector();
  let last = null;
  for (const part of parts) {
    last = collector.add(part);
  }
  return last;
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'settings'] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
});

describe('QR parts', () => {
  it('keeps every part to a small code a phone camera can read', () => {
    // The finding: one code for the whole checkpoint reached version 17
    // for a bare handover and towards 40 with keys in it, and did not
    // scan. Every part is now at most a version-9 code, 53 modules across.
    const parts = splitQrParts(fakeSealed(QR_BYTE_LIMIT));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(versionOf(part)).toBeLessThanOrEqual(9);
    }
  });

  it('sends a checkpoint that fits one part as one plain code, in the original format', () => {
    const sealed = fakeSealed(QR_PART_BYTES);
    expect(splitQrParts(sealed)).toEqual([sealed]);
  });

  it('reassembles the parts byte for byte, in any order and with repeats', () => {
    const sealed = fakeSealed(1000);
    const parts = splitQrParts(sealed);
    const shuffled = [
      parts[3],
      parts[0],
      parts[3],
      parts[5],
      parts[1],
      parts[1],
      parts[2],
      parts[4],
    ];
    expect(parts).toHaveLength(6);
    const progress = collect(shuffled);
    expect(progress).toEqual({ kind: 'complete', payload: sealed });
  });

  it('reports how many parts are in while some are still missing', () => {
    const parts = splitQrParts(fakeSealed(1000));
    const collector = new QrPartCollector();
    collector.add(parts[2]);
    collector.add(parts[2]);
    expect(collector.add(parts[4])).toEqual({
      kind: 'partial',
      received: 2,
      total: 6,
    });
  });

  it('starts over when the codes on screen belong to another checkpoint', () => {
    // The dialog was closed and reopened between scans: a new seal, a new
    // salt, a new set. Mixing the two would open as garbage.
    const first = splitQrParts(fakeSealed(1000, 0x0001));
    const second = fakeSealed(1000, 0x0002);
    const collector = new QrPartCollector();
    first.slice(0, 5).forEach((part) => collector.add(part));
    let progress = null;
    for (const part of splitQrParts(second)) {
      progress = collector.add(part);
    }
    expect(progress).toEqual({ kind: 'complete', payload: second });
  });

  it('passes a code from an older build - one whole sealed checkpoint - straight through', () => {
    const sealed = fakeSealed(1500);
    expect(new QrPartCollector().add(sealed)).toEqual({
      kind: 'complete',
      payload: sealed,
    });
  });

  it('ignores a part too short to carry anything', () => {
    expect(
      new QrPartCollector().add(new Uint8Array([0xc0, 0xee, 0, 0, 0, 2])),
    ).toBeNull();
  });

  it('round-trips a real handover through rendered codes and the scanner decode', async () => {
    // End to end through the pieces production uses: seal, split, render
    // each part as a code, read it back with the scanner's own decode,
    // collect, open.
    for (let n = 0; n < 4; n += 1) {
      await putSource({
        id: `src-${n}`,
        moduleId: 'cardano-blockfrost',
        label: `Wallet ${n}`,
        config: {
          address: `addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x${n}`,
          projectId: `mainnetAbCdEfGhIjKlMnOpQrStUvWxYz${n}`,
        },
      });
    }
    const checkpoint = await buildCheckpoint('handover');
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(checkpoint, secret);
    const parts = splitQrParts(sealed);
    expect(parts.length).toBeGreaterThan(1);

    const collector = new QrPartCollector();
    let progress = null;
    for (const part of [...parts].reverse()) {
      const scanned = decodeQrPayload(renderToImageData(part));
      expect(scanned).not.toBeNull();
      progress = collector.add(scanned!);
    }
    expect(progress?.kind).toBe('complete');
    const payload = (progress as { payload: Uint8Array }).payload;
    await expect(openCheckpoint(payload, secret)).resolves.toEqual(checkpoint);
  });

  it('still decodes a single code with the scanner as before', () => {
    const sealed = fakeSealed(150);
    const scanned = jsQR(
      renderToImageData(sealed).data,
      renderToImageData(sealed).width,
      renderToImageData(sealed).height,
    );
    expect(new Uint8Array(scanned!.binaryData)).toEqual(sealed);
  });
});
