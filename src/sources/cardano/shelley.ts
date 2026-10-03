import { decodeBech32, encodeBech32 } from './bech32';

/** Shelley addresses put the address type in the header byte's high nibble
 *  and the network in its low one (CIP-19). */
const PAYMENT_HRP = 'addr';
const PAYMENT_HRP_TESTNET = 'addr_test';

/** header + 28-byte payment credential + 28-byte staking credential. */
const BASE_ADDRESS_BYTES = 57;
const CREDENTIAL_BYTES = 28;

/** Types 0-3 carry a staking credential as a hash. 4 and 5 carry a pointer,
 *  6 and 7 carry nothing, 8 is Byron, 14 and 15 are reward addresses. */
const MAX_TYPE_WITH_STAKE_HASH = 3;

/** Bit 1 of the address type says the STAKING half is a script hash rather
 *  than a key hash: types 0 and 1 pair with a stake key, 2 and 3 with a
 *  script. The reward address has to agree, or it names a credential of the
 *  wrong kind. */
const STAKE_PART_IS_SCRIPT = 0b10;
const REWARD_TYPE_KEY = 14;
const REWARD_TYPE_SCRIPT = 15;

/**
 * Reads the staking credential out of a Shelley payment address, offline.
 *
 * This is the one asymmetry between Cardano and a chain with no account
 * model, and it is worth stating precisely because it is easy to invert: a
 * base address carries TWO credentials, and it is the STAKING one that is
 * shared across a wallet. The payment credential changes with every derived
 * address - under CIP-1852 payment keys are m/1852'/1815'/acct'/0/i for
 * i = 0, 1, 2..., while the staking key is a single m/1852'/1815'/acct'/2/0 -
 * so the staking credential is what identifies the account, and any one of
 * the wallet's addresses carries it.
 *
 * Why this exists rather than asking the provider: Blockfrost's
 * `/addresses/{address}` answers 404 for an address that has never appeared
 * on chain, so resolving the account through the provider fails for exactly
 * the address a user is most likely to paste - the fresh receive address
 * their wallet shows them, which is also what was reported against this app.
 * The bytes are in the address itself, so no request is needed and an unused
 * address resolves as well as a busy one.
 *
 * Returns null when there is genuinely no staking part to read, which is a
 * real answer rather than a failure:
 *  - an enterprise address (types 6, 7) deliberately has none;
 *  - a pointer address (types 4, 5) locates its stake credential by a
 *    position on chain instead of carrying the hash, so no reward address
 *    can be built from it without a lookup;
 *  - a Byron address is base58, not bech32, and predates staking entirely;
 *  - a reward address (types 14, 15) is already the thing being asked for;
 *  - anything that is not a well-formed bech32 Shelley payment address.
 */
export const stakeAddressOf = (address: string): string | null => {
  const decoded = decodeBech32(address.trim());
  if (decoded === null) {
    return null;
  }
  if (decoded.hrp !== PAYMENT_HRP && decoded.hrp !== PAYMENT_HRP_TESTNET) {
    return null;
  }
  if (decoded.bytes.length !== BASE_ADDRESS_BYTES) {
    // Only types 0-3 are this length. An enterprise address is 29 bytes and
    // a pointer address is variable, so the length check rejects both
    // without needing to parse what follows the payment credential.
    return null;
  }

  const header = decoded.bytes[0];
  const type = header >> 4;
  const network = header & 0x0f;
  if (type > MAX_TYPE_WITH_STAKE_HASH) {
    return null;
  }

  const credential = decoded.bytes.slice(
    1 + CREDENTIAL_BYTES,
    1 + CREDENTIAL_BYTES * 2,
  );
  const rewardType =
    type & STAKE_PART_IS_SCRIPT ? REWARD_TYPE_SCRIPT : REWARD_TYPE_KEY;
  const rewardHeader = (rewardType << 4) | network;

  // The network nibble is carried straight through rather than re-derived
  // from the HRP: an address whose header and HRP disagree is malformed, and
  // trusting the header keeps the reward address consistent with the bytes
  // the credential came from.
  return encodeBech32(
    network === 1 ? 'stake' : 'stake_test',
    new Uint8Array([rewardHeader, ...credential]),
  );
};
