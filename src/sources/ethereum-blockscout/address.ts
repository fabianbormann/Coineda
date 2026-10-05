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

export const configuredAddress = (
  config: Record<string, string>,
): string | null => {
  const raw = (config.address ?? '').trim();
  return isAddress(raw) ? normaliseAddress(raw) : null;
};
