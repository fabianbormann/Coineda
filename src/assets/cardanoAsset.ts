/**
 * Cardano native assets, resolved offline.
 *
 * A native asset's ledger id is `cardano:<subject>`, where the subject is
 * the concatenation the Cardano world already uses: a 28-byte policy id
 * followed by the asset name, both in hex. That is not an opaque key - the
 * name is IN there - so the first and cheapest way to show a person what
 * they hold needs no network at all:
 *
 *   cardano:0691b2…f1fa4e49474854
 *                     ^^^^^^^^^^ 4e 49 47 48 54 = "NIGHT"
 *
 * Which is why this module exists separately from the token registry
 * client. The registry gives a nicer ticker, a logo and a description, but
 * it is a network call that can fail, be slow, or simply not list the
 * asset; decoding the name cannot. The registry refines what this says, it
 * is never required for it.
 */

/** A policy id is 28 bytes. */
const POLICY_HEX = 56;

/** An asset name is at most 32 bytes on chain. */
const MAX_NAME_HEX = 64;

const HEX = /^[0-9a-f]*$/i;

export type CardanoAsset = {
  policyId: string;
  /** Hex, possibly empty: an asset may have no name at all. */
  nameHex: string;
  /** The subject the token registry is keyed on - policy plus name. */
  subject: string;
  /** The decoded name, or null when the bytes are not printable text. */
  name: string | null;
};

/**
 * True for a byte sequence that is safe to show as a name.
 *
 * Deliberately strict: printable ASCII only. An asset name is arbitrary
 * bytes, and plenty are not text at all - CIP-68 reference tokens begin
 * with a four-byte binary label, and some policies use raw hashes. Rendering
 * those through a lenient UTF-8 decode produces replacement characters and
 * control codes in the middle of a balance, which looks like corruption in
 * the app rather than what it is. When in doubt this returns false and the
 * caller falls back to the hex, which is at least honest.
 */
const isPrintable = (bytes: Uint8Array): boolean =>
  bytes.length > 0 && bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/**
 * Splits a ledger asset id into its Cardano parts, or returns null when it
 * is not a Cardano native asset.
 *
 * `cardano:lovelace` is NOT one: it is the chain's own unit, already named
 * ADA everywhere in the app, and feeding it in here would have it render as
 * an unknown token.
 */
export const parseCardanoAsset = (assetId: string): CardanoAsset | null => {
  if (!assetId.startsWith('cardano:')) {
    return null;
  }
  const subject = assetId.slice('cardano:'.length).toLowerCase();
  // A subject shorter than a policy id, or longer than a policy plus the
  // maximum name, is not a subject. Returning null rather than guessing
  // keeps a malformed id rendering as itself instead of as a confident
  // wrong name.
  //
  // This is also what excludes `cardano:lovelace`, the chain's own unit:
  // 'lovelace' is eight characters where a policy id is fifty-six. An
  // earlier version had an explicit guard for it one line above, which
  // read well and was unreachable - removing it changed no test, so it was
  // a line pretending to do work the length check already did.
  if (
    subject.length < POLICY_HEX ||
    subject.length > POLICY_HEX + MAX_NAME_HEX ||
    subject.length % 2 !== 0 ||
    !HEX.test(subject)
  ) {
    return null;
  }

  const policyId = subject.slice(0, POLICY_HEX);
  const nameHex = subject.slice(POLICY_HEX);
  const bytes = fromHex(nameHex);

  return {
    policyId,
    nameHex,
    subject,
    name: isPrintable(bytes) ? new TextDecoder().decode(bytes) : null,
  };
};

/** The registry subject for an asset id, or null when it has none. */
export const subjectOf = (assetId: string): string | null =>
  parseCardanoAsset(assetId)?.subject ?? null;

/**
 * A short, stable stand-in for an asset whose name is not printable text.
 *
 * Both ends of the policy, because every asset under one policy shares its
 * whole prefix - a prefix-only abbreviation would render two different
 * tokens identically, the same trap `shortVenue` avoids for addresses.
 */
export const shortSubject = (subject: string): string =>
  `${subject.slice(0, 6)}…${subject.slice(-4)}`;
