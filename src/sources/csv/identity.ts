const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

const fnv1a64 = (text: string, seed: bigint): string => {
  let hash = seed;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
};

/**
 * A synchronous 128-bit-wide identity (two FNV-1a 64 passes), because
 * `FileSourceModule.parse` is synchronous and Web Crypto is not. It is a
 * dedupe key over a few thousand rows of one user's own file, not a security
 * boundary.
 */
export const fnv64Hex = (text: string): string =>
  fnv1a64(text, FNV_OFFSET) + fnv1a64(`|${text}`, FNV_OFFSET ^ 0x9e3779b9n);
