/**
 * The only place exchange API credentials are read or written.
 *
 * Keys are `coineda.credential.<exchangeId>.<field>` — deliberately with no
 * name component. The previous scheme was `<id>-<name>-<field>`, which put a
 * MUTABLE value in the key, so every rename had to hand-migrate each
 * credential across six call sites in one file. Keying on the immutable id
 * removes the need for migration entirely.
 *
 * Note on security, recorded rather than solved: these are exchange API keys
 * and secrets in plaintext localStorage. With no backend there is no honest
 * encryption available - any key used to encrypt them would have to sit
 * beside them - so the real mitigations are disclosure (see
 * WalletCredentials) and preferring read-only API keys.
 */

export const credentialKey = (exchangeId: number, field: string): string =>
  `coineda.credential.${exchangeId}.${field}`;

/** The pre-2b-2 key shape, kept only so existing values can be adopted. */
const legacyKey = (
  exchangeId: number,
  exchangeName: string,
  field: string,
): string => `${exchangeId}-${exchangeName}-${field}`;

/**
 * localStorage throws in private windows and when site data is blocked. A
 * credential is never worth failing the wallets screen over, so every access
 * is guarded and reads degrade to an empty string.
 */
const safeGet = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSet = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore - the value still applies to the form for this session
  }
};

const safeRemove = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

export const writeCredential = (
  exchangeId: number,
  field: string,
  value: string,
): void => {
  safeSet(credentialKey(exchangeId, field), value);
};

/**
 * Reads a credential, adopting a legacy-keyed value if one is found.
 *
 * The new key is written BEFORE the legacy key is removed. Reversing that
 * order would mean a failed write loses the credential permanently.
 */
export const readCredential = (
  exchangeId: number,
  exchangeName: string,
  field: string,
): string => {
  const current = safeGet(credentialKey(exchangeId, field));
  if (current !== null) {
    return current;
  }

  const legacy = safeGet(legacyKey(exchangeId, exchangeName, field));
  if (legacy === null) {
    return '';
  }

  safeSet(credentialKey(exchangeId, field), legacy);
  safeRemove(legacyKey(exchangeId, exchangeName, field));
  return legacy;
};

/**
 * Removes every credential for an exchange, both key shapes. Takes the field
 * list explicitly rather than scanning localStorage, so it cannot delete
 * something that merely looks like one of ours.
 */
export const clearCredentials = (
  exchangeId: number,
  exchangeName: string,
  fields: string[],
): void => {
  for (const field of fields) {
    safeRemove(credentialKey(exchangeId, field));
    safeRemove(legacyKey(exchangeId, exchangeName, field));
  }
};
