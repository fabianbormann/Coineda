/** SHA-256 of the UTF-8 bytes of `text`, lower-case hex (WebCrypto, as in
 *  `ledger/fingerprint.ts`). Ties a CARF file to the printout. */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
};
