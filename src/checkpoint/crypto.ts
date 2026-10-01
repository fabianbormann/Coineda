/**
 * Internal to the checkpoint module - `format.ts` is the public surface.
 *
 * Seals arbitrary JSON-serialisable payloads for transfer: deflate-raw
 * compress, then AES-GCM keyed by PBKDF2-SHA-256 over a human-typed secret.
 * Compression happens BEFORE encryption - ciphertext is incompressible, so
 * compressing after encrypting would blow the QR budget for no benefit.
 *
 * Wire format: MAGIC(2) | FORMAT_BYTE(1) | salt(16) | iv(12) | ciphertext.
 * The magic bytes and format byte let a future change to this envelope be
 * detected explicitly - "unsupported checkpoint format" - rather than
 * surfacing as a confusing AES-GCM authentication failure.
 */

const MAGIC = new Uint8Array([0xc0, 0xed]);
const FORMAT_BYTE = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 600_000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Eight base32 characters (~40 bits) - a six-digit PIN is a million
 * combinations and brute-forceable offline in hours if a QR image leaks;
 * this is not. Drawn with rejection sampling rather than `% alphabetSize`:
 * a plain modulo would make the low end of the alphabet marginally more
 * likely whenever the random byte range is not an exact multiple of the
 * alphabet size.
 */
export const generateTransferSecret = (): string => {
  const alphabetSize = BASE32_ALPHABET.length;
  const rejectAt = 256 - (256 % alphabetSize);
  const byte = new Uint8Array(1);
  let secret = '';
  while (secret.length < 8) {
    crypto.getRandomValues(byte);
    if (byte[0] >= rejectAt) {
      continue;
    }
    secret += BASE32_ALPHABET[byte[0] % alphabetSize];
  }
  return secret;
};

const deriveKey = async (
  secret: string,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      // Re-wrapped: `salt` may arrive as a Uint8Array view over an
      // ArrayBufferLike (e.g. a slice of another Uint8Array parameter
      // typed loosely), and SubtleCrypto's BufferSource excludes that.
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const compress = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

/**
 * A checkpoint is meant to be a few kilobytes; nothing legitimate comes
 * close to this. Decryption already requires the right secret, so an
 * oversized payload here is a local-DoS risk rather than a data-loss one
 * (a hostile few-hundred-KB file can expand to gigabytes under deflate) -
 * but decompression is the one place attacker-controlled bytes get
 * expanded, so it is the one place worth bounding.
 */
const MAX_DECOMPRESSED_BYTES = 512 * 1024;

const decompress = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();

  // Read in chunks rather than buffering the whole decompressed output in
  // one `arrayBuffer()` call, so an over-limit payload is caught - and the
  // reader cancelled, stopping further decompression - instead of being
  // fully expanded first and only measured afterwards.
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        throw new Error('checkpoint payload too large after decompression');
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed - nothing left to cancel.
    }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

/** Encrypts an arbitrary JSON-serialisable payload. */
export const seal = async (
  payload: unknown,
  secret: string,
): Promise<Uint8Array> => {
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await compress(plain);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(secret, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new Uint8Array(compressed),
    ),
  );
  return concatBytes(
    MAGIC,
    new Uint8Array([FORMAT_BYTE]),
    salt,
    iv,
    ciphertext,
  );
};

/**
 * Reverses `seal`. A wrong secret surfaces as an AES-GCM authentication
 * failure - that throw is left to propagate rather than being caught into
 * a partial result.
 */
export const unseal = async (
  sealed: Uint8Array,
  secret: string,
): Promise<unknown> => {
  const headerLength = MAGIC.length + 1 + SALT_LENGTH + IV_LENGTH;
  if (
    sealed.length < headerLength ||
    sealed[0] !== MAGIC[0] ||
    sealed[1] !== MAGIC[1]
  ) {
    throw new Error('not a Coineda checkpoint');
  }
  if (sealed[MAGIC.length] !== FORMAT_BYTE) {
    throw new Error('unsupported checkpoint format');
  }

  let offset = MAGIC.length + 1;
  const salt = sealed.slice(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = sealed.slice(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const ciphertext = sealed.slice(offset);

  const key = await deriveKey(secret, salt);
  const compressed = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext),
    ),
  );
  const plain = await decompress(compressed);
  return JSON.parse(new TextDecoder().decode(plain));
};
