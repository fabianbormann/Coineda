/**
 * Just enough ZIP to get the file out of an exchange's download.
 *
 * Kraken (and others) hand over a zip, not a bare CSV, so asking a person
 * to unpack it first is asking them to do work the app can do. A
 * dependency would be the obvious answer, but the whole job here is
 * locating one entry and inflating it, and the browser already does the
 * hard half: `DecompressionStream('deflate-raw')` is the DEFLATE decoder,
 * so what is left is the container format.
 *
 * Deliberately NOT a general ZIP implementation. No encryption, no ZIP64,
 * no multi-disk archives, no directory traversal - an exchange export is a
 * handful of small files written by the same tool every time. Anything it
 * does not understand is reported as unreadable rather than guessed at.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The End of Central Directory record, which is the only fixed landmark a
 *  ZIP has - and it sits at the END, because a zip can be appended to. */
const EOCD_MIN_SIZE = 22;

/** The comment that may follow the EOCD is a 16-bit length, so the record
 *  can never start further back than this from the end. */
const MAX_COMMENT = 0xffff;

export class NotAZipError extends Error {
  constructor() {
    super('not a zip archive');
    this.name = 'NotAZipError';
  }
}

export class UnsupportedZipError extends Error {
  constructor(reason: string) {
    super(`this zip cannot be read: ${reason}`);
    this.name = 'UnsupportedZipError';
  }
}

export type ZipEntry = { name: string; bytes: Uint8Array };

/** A zip starts with a local file header, but an empty one starts with the
 *  EOCD - so the cheap check is the first signature either way. */
export const looksLikeZip = (bytes: Uint8Array): boolean => {
  if (bytes.length < 4) {
    return false;
  }
  const first = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(
    0,
    true,
  );
  return first === LOCAL_SIGNATURE || first === EOCD_SIGNATURE;
};

const findEocd = (view: DataView): number => {
  const earliest = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
  // Scanned backwards: the record is at the end, and starting from the
  // front would find a signature that happens to appear inside compressed
  // data first.
  for (let at = view.byteLength - EOCD_MIN_SIZE; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      return at;
    }
  }
  return -1;
};

const inflate = async (
  data: Uint8Array,
  method: number,
  name: string,
): Promise<Uint8Array> => {
  if (method === 0) {
    return data;
  }
  if (method !== 8) {
    // 8 is DEFLATE, which is what every ordinary zip uses. 9 is Deflate64,
    // 12 bzip2, 14 LZMA - all real, none of them what an exchange writes,
    // and none decodable here.
    throw new UnsupportedZipError(
      `"${name}" uses compression method ${method}, which Coineda cannot decode`,
    );
  }
  // 'deflate-raw' rather than 'deflate': a zip entry holds a bare DEFLATE
  // stream with no zlib header, and the wrong one fails on the first byte.
  //
  // Written through the stream's own writer rather than from a Blob:
  // `Blob.stream()` does not exist under jsdom, so a Blob here would make
  // this untestable - and the writer is the more direct route anyway.
  const decompressor = new DecompressionStream('deflate-raw');
  const writer = decompressor.writable.getWriter();
  // NOT awaited before reading. A large entry fills the stream's buffer and
  // the write only settles once the reader drains it, so awaiting here
  // would deadlock on exactly the files big enough to matter.
  const written = writer
    // Copied into a buffer of its own: `data` is a subarray of the whole
    // archive, and a view onto a shared buffer is not the BufferSource the
    // stream's types accept.
    .write(new Uint8Array(data) as unknown as BufferSource)
    .then(() => writer.close())
    .catch(() => undefined);
  const inflated = new Uint8Array(
    await new Response(decompressor.readable).arrayBuffer(),
  );
  await written;
  return inflated;
};

/**
 * Every file in the archive, decompressed.
 *
 * Directory entries are skipped: they carry no content and their names end
 * in a slash.
 */
export const readZip = async (bytes: Uint8Array): Promise<ZipEntry[]> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd === -1) {
    throw new NotAZipError();
  }

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (
      at + 46 > view.byteLength ||
      view.getUint32(at, true) !== CENTRAL_SIGNATURE
    ) {
      throw new UnsupportedZipError('its directory is not where it says it is');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLength),
    );
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }
    // Bit 0 is the encryption flag. An encrypted entry decompresses to
    // noise, which would reach the CSV parser as a header it cannot read -
    // a confusing error for a file that is simply locked.
    if ((flags & 0x1) !== 0) {
      throw new UnsupportedZipError(`"${name}" is password protected`);
    }

    if (view.getUint32(localAt, true) !== LOCAL_SIGNATURE) {
      throw new UnsupportedZipError(`"${name}" is not where the index says`);
    }
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      bytes: await inflate(
        bytes.subarray(dataAt, dataAt + compressedSize),
        method,
        name,
      ),
    });
  }

  return entries;
};
