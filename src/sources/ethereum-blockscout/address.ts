import { readAddresses } from '@/sources/addresses';

/**
 * Ethereum addresses, validated by shape.
 *
 * An address is 20 bytes, written as `0x` plus 40 hex digits. Mixed case
 * carries EIP-55's checksum, which this deliberately does NOT verify: doing
 * so needs keccak256, roughly a hundred lines of hand-rolled hashing to get
 * exactly right, and it only ever catches a typo in an address that was
 * checksummed to begin with. A typo'd all-lowercase address - equally
 * common, since that is what most tools and this app itself produce - would
 * sail through either way.
 *
 * The failure it would catch is also soft rather than silent: a wrong
 * address almost always has no history, so the source syncs to zero events
 * and says so, which is visible. Compare the xpub work, where getting the
 * derivation wrong produced a confidently WRONG balance; that earned its
 * hand-rolled bech32, and this does not earn keccak256.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isAddress = (value: string): boolean => ADDRESS.test(value.trim());

/**
 * The form this module compares and stores.
 *
 * Lowercased, because every direction test in the translator is
 * "is this leg's counterparty us?" and Blockscout returns checksummed
 * mixed case while a user may well paste lowercase. Comparing those two
 * directly answers "no" for an address that is the user's own, which would
 * classify every one of their own transactions as somebody else's.
 */
export const normaliseAddress = (value: string): string =>
  value.trim().toLowerCase();

/**
 * The configured addresses, normalised and deduped in list order - the
 * stored `addressList`, or a source saved before lists existed read as a
 * one-element list (see readAddresses).
 *
 * `invalidLine` is the 1-based line of the first entry that is not an
 * address at all, or null. A malformed line is reported rather than
 * silently dropped: dropping it would track fewer addresses than the user
 * listed, with nothing saying so.
 */
export const configuredAddresses = (
  config: Record<string, string>,
): { addresses: string[]; invalidLine: number | null } => {
  const raw = readAddresses(config);
  const invalid = raw.findIndex((value) => !isAddress(value));
  const addresses: string[] = [];
  for (const value of raw) {
    const normalised = normaliseAddress(value);
    if (isAddress(value) && !addresses.includes(normalised)) {
      addresses.push(normalised);
    }
  }
  return { addresses, invalidLine: invalid < 0 ? null : invalid + 1 };
};

/** The first configured address, or null when it is missing or malformed. */
export const configuredAddress = (
  config: Record<string, string>,
): string | null => {
  const raw = readAddresses(config)[0] ?? '';
  return isAddress(raw) ? normaliseAddress(raw) : null;
};
