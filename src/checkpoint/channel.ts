import QRCode from 'qrcode';

/**
 * Internal to the checkpoint module - `format.ts` is the public surface.
 *
 * The most a checkpoint may weigh and still be offered as codes. It was
 * once one version-40 code's capacity at level M (2331 bytes); the codes
 * are now small parts (see `splitQrParts` below), and the limit stays
 * where it was as a bound on how many of them a person should have to
 * hold a camera over - 2300 bytes is 14 parts, under six seconds a cycle.
 * A sealed checkpoint larger than that is sent to the file channel
 * instead - never truncated. A truncated QR would scan back into a
 * partial setup that looks complete, which a user has no way to diagnose.
 */
export const QR_BYTE_LIMIT = 2300;

export const chooseChannel = (
  sealed: Uint8Array,
): { channel: 'qr' | 'file'; bytes: number } => {
  const bytes = sealed.byteLength;
  return { channel: bytes <= QR_BYTE_LIMIT ? 'qr' : 'file', bytes };
};

/**
 * Encodes sealed checkpoint bytes as a byte-mode QR code.
 *
 * Byte mode, not text: `decodeQrPayload` on the import side reads jsQR's
 * `binaryData` straight back into a Uint8Array and hands it to
 * `openCheckpoint`. Encoding base64 text here would scan fine and then fail
 * AES-GCM authentication with the same error a mistyped secret gives, so the
 * user would be told their secret is wrong no matter what they typed.
 *
 * Level M is not a default worth leaving implicit: QR_PART_BYTES below is
 * derived from version 9's capacity AT level M, so the two have to agree.
 */
export const encodeQrPayload = (bytes: Uint8Array): Promise<string> =>
  QRCode.toDataURL([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 6,
  });

/*
 * Several small codes instead of one big one.
 *
 * A single code was correct and unscannable. Even a bare handover - four
 * sources, no keys - sealed to ~490 bytes, a version-17 code of 85x85
 * modules; with API keys and taxpayer details it climbed towards version
 * 40, 177 modules across. A phone camera reading another screen sees that
 * grid at a few pixels per module at best (and at 640x480, the resolution
 * many browsers hand out when none is asked for, at under two), so jsQR
 * found nothing to decode and the scan never finished.
 *
 * So the sealed bytes are split into parts that each fit a version-9 code
 * (53 modules), which the export dialog shows in turn and the scanner
 * collects in any order. Nothing about the payload changes - it is the
 * same sealed checkpoint, reassembled byte for byte before it is opened -
 * and a checkpoint small enough for one part still goes out as one plain
 * code in the original single-code format, which is also what older
 * builds produced and what the scanner still reads.
 *
 * A part: PART_MAGIC(2) | set(2) | index(1) | total(1) | bytes.
 * PART_MAGIC differs from the seal's own magic (0xC0 0xED) in its second
 * byte, so a part can never be mistaken for a whole checkpoint. `set` is
 * two bytes of the seal's random salt: parts of two different checkpoints
 * (the dialog was reopened between scans) cannot be mixed into one.
 */
const PART_MAGIC = [0xc0, 0xee] as const;
const PART_HEADER = 6;
/** 174 + 6 = 180 bytes: version 9's whole byte capacity at level M. */
export const QR_PART_BYTES = 174;
/** How long each part stays on screen. Slow enough for a phone to focus
 *  and decode a part before it changes, fast enough that a ten-part
 *  checkpoint cycles in four seconds. */
export const QR_PART_INTERVAL_MS = 400;

const SALT_OFFSET = 3;

/**
 * The codes a sealed checkpoint is shown as: itself, when it fits one
 * part, otherwise numbered parts. Only for payloads `chooseChannel` sends
 * to 'qr' - the part count has to fit the one-byte index.
 */
export const splitQrParts = (sealed: Uint8Array): Uint8Array[] => {
  if (sealed.byteLength <= QR_PART_BYTES + PART_HEADER) {
    return [sealed];
  }
  const total = Math.ceil(sealed.byteLength / QR_PART_BYTES);
  if (total > 255) {
    throw new Error('Too large for QR parts');
  }
  return Array.from({ length: total }, (_, index) => {
    const chunk = sealed.subarray(
      index * QR_PART_BYTES,
      (index + 1) * QR_PART_BYTES,
    );
    const part = new Uint8Array(PART_HEADER + chunk.byteLength);
    part.set([
      PART_MAGIC[0],
      PART_MAGIC[1],
      sealed[SALT_OFFSET] ?? 0,
      sealed[SALT_OFFSET + 1] ?? 0,
      index,
      total,
    ]);
    part.set(chunk, PART_HEADER);
    return part;
  });
};

/** Every code for a sealed checkpoint, as data URLs, in order. */
export const encodeQrParts = (sealed: Uint8Array): Promise<string[]> =>
  Promise.all(splitQrParts(sealed).map(encodeQrPayload));

export type QrScanProgress =
  | { kind: 'complete'; payload: Uint8Array }
  | { kind: 'partial'; received: number; total: number };

/**
 * Collects scanned codes until a whole checkpoint is in hand.
 *
 * Fed every decoded code, duplicates and all - the scanner sees the same
 * part on many consecutive frames. A plain single code completes at once.
 * A part from a different set than the one being collected starts over
 * with the new set: the codes on the other screen are the ones that count.
 */
export class QrPartCollector {
  private set: number | null = null;
  private parts: (Uint8Array | undefined)[] = [];

  add(code: Uint8Array): QrScanProgress | null {
    if (code[0] !== PART_MAGIC[0] || code[1] !== PART_MAGIC[1]) {
      return { kind: 'complete', payload: code };
    }
    if (code.byteLength <= PART_HEADER) {
      return null;
    }
    const set = (code[2] << 8) | code[3];
    const index = code[4];
    const total = code[5];
    if (total === 0 || index >= total) {
      return null;
    }
    if (set !== this.set || total !== this.parts.length) {
      this.set = set;
      this.parts = new Array<Uint8Array | undefined>(total);
    }
    this.parts[index] = code.subarray(PART_HEADER);
    const received = this.parts.filter((part) => part !== undefined).length;
    if (received < total) {
      return { kind: 'partial', received, total };
    }
    const payload = new Uint8Array(
      this.parts.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0),
    );
    let offset = 0;
    for (const part of this.parts as Uint8Array[]) {
      payload.set(part, offset);
      offset += part.byteLength;
    }
    return { kind: 'complete', payload };
  }
}
