import QRCode from 'qrcode';

/**
 * Internal to the checkpoint module - `format.ts` is the public surface.
 *
 * A version-40 byte-mode QR code holds 2953 bytes at error-correction
 * level L, but this feature uses level M, whose capacity at version 40 is
 * 2331 bytes - not 2953. 2300 is chosen to leave headroom under that
 * 2331-byte level-M figure. A sealed checkpoint larger than that is sent
 * to the file channel instead - never truncated. A truncated QR would
 * scan back into a partial setup that looks complete, which a user has no
 * way to diagnose.
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
 * Level M is not a default worth leaving implicit: QR_BYTE_LIMIT above is
 * derived from version 40's capacity AT level M, so the two have to agree.
 */
export const encodeQrPayload = (bytes: Uint8Array): Promise<string> =>
  QRCode.toDataURL([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 6,
  });
