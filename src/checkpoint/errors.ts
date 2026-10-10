import type { TFunction } from 'i18next';

/**
 * `openCheckpoint` throws three distinct failures - a newer format version,
 * a shape that doesn't look like a `Checkpoint` after decrypting, and (via
 * Web Crypto, when `unseal`'s AES-GCM tag check fails) a native
 * `OperationError` for a wrong secret - plus a couple of header-level
 * throws from `unseal` itself ("not a Coineda checkpoint", "unsupported
 * checkpoint format") for bytes that are not this envelope at all. None of
 * those are presentable to a user as-is, and a raw stack trace must never
 * reach the form. This maps all of them to exactly three translated,
 * static messages: a specific one for "you typed the secret wrong", a
 * specific one for "update the app first", and one shared message for
 * every other way a checkpoint can fail to open (malformed shape, not a
 * Coineda checkpoint, unsupported format, or anything else unexpected).
 */
export const describeOpenError = (error: unknown, t: TFunction): string => {
  // Not `error instanceof DOMException`: under jsdom (this app's own test
  // environment), Web Crypto's AES-GCM failure is thrown as Node's own
  // DOMException, a different realm's class than jsdom's global
  // `DOMException` - `instanceof` across that boundary is false even
  // though `error.name` reads 'OperationError' either way. Checking the
  // name directly against the (specced, stable) `Error` base works in
  // every environment this app ships in, not just the one it's thrown in
  // natively.
  if (error instanceof Error && error.name === 'OperationError') {
    return t('That transfer secret is wrong. Check it and try again.');
  }
  const message = error instanceof Error ? error.message : '';
  if (/newer version/i.test(message)) {
    return t(
      'This checkpoint was made with a newer version of Coineda. Update the app, then try restoring it again.',
    );
  }
  return t(
    "This checkpoint could not be opened. The file may be corrupted or isn't a valid Coineda checkpoint.",
  );
};
