import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Parses an account extended public key.
 *
 * Why a dependency here when bech32 was hand-rolled next door: BIP32 child
 * derivation is secp256k1 point arithmetic, where a mistake is silent and
 * produces a plausible WRONG address - which in a tax calculator means
 * someone else's coins in a report. Bech32 is table lookups over public data
 * and a mistake fails a checksum. The two are not the same risk, so this
 * takes @scure/bip32 and that one did not.
 *
 * Nothing here can sign. The key is a public one by construction - §
 * `privateKey` below refuses anything else twice over - and no code path
 * produces a signature.
 */

/**
 * SLIP-132 version bytes, each verified by re-versioning a known payload and
 * reading back the prefix the string acquired, rather than copied from
 * memory.
 *
 * The important thing this table does NOT do is tell you the address type.
 * xpub, ypub and zpub differ only in these four bytes, and Ledger Live
 * exports a native-SegWit account labelled `xpub` regardless - so the prefix
 * is evidence of the NETWORK and of nothing else. The address type is
 * settled by probing the chain (see detectScriptType).
 */
const PUBLIC_VERSIONS: Record<number, 'mainnet' | 'testnet'> = {
  0x0488b21e: 'mainnet', // xpub
  0x049d7cb2: 'mainnet', // ypub
  0x04b24746: 'mainnet', // zpub
  0x043587cf: 'testnet', // tpub
  0x044a5262: 'testnet', // upub
  0x045f1cf6: 'testnet', // vpub
};

/**
 * What @scure/bip32 will accept; everything else is re-versioned to one of
 * these, which leaves the payload untouched.
 *
 * The private half has to be supplied even though nothing here holds or
 * wants a private key: `fromExtendedKey` validates the string's version
 * against this pair, and its default pair is mainnet-only - so a `tpub`
 * without it is rejected as malformed rather than recognised as testnet.
 */
const CANONICAL: Record<
  'mainnet' | 'testnet',
  { public: number; private: number }
> = {
  mainnet: { public: 0x0488b21e, private: 0x0488ade4 },
  testnet: { public: 0x043587cf, private: 0x04358394 },
};

/** 4 version + 1 depth + 4 parent fingerprint + 4 child number
 *  + 32 chain code + 33 key = 78. */
const SERIALISED_BYTES = 78;
const DEPTH_OFFSET = 4;
const KEY_OFFSET = 45;

/** m / purpose' / coin' / account' - three hardened levels, so an account
 *  key is always at depth 3. */
const ACCOUNT_DEPTH = 3;

export type AccountKey = {
  network: 'mainnet' | 'testnet';
  /** The public key at `<chain>/<index>` below the account. */
  publicKeyAt: (chain: 0 | 1, index: number) => Uint8Array;
};

export type KeyProblem =
  'notAKey' | 'privateKey' | 'wrongDepth' | 'unknownVersion';

const b58 = base58check(sha256);

const readUint32 = (bytes: Uint8Array): number =>
  ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;

export const parseAccountKey = (
  value: string,
): { key: AccountKey } | { problem: KeyProblem } => {
  // Trimmed, never case-folded. A pasted key arrives with a newline, so the
  // trim is required - but base58's alphabet is case-SENSITIVE, so folding
  // case would silently corrupt the key into a different one or into
  // nothing. Cardano's configuredAddress folds case for bech32, which is
  // right there and would be a bug here.
  const trimmed = value.trim();
  if (trimmed === '') {
    return { problem: 'notAKey' };
  }

  let raw: Uint8Array;
  try {
    raw = b58.decode(trimmed);
  } catch {
    // A bad checksum, a character outside the alphabet, a truncated string.
    // Refusing is what stops a mistyped key from decoding into a plausible
    // different wallet.
    return { problem: 'notAKey' };
  }

  if (raw.length !== SERIALISED_BYTES) {
    return { problem: 'notAKey' };
  }

  // TWO independent guards against a private key, deliberately not one.
  //
  // The first is structural and needs no table: a serialised private key
  // carries 0x00 ahead of its 32 bytes, where a public key carries the
  // 0x02/0x03 of a compressed point. The second is the version table, which
  // simply does not list any private version. Either alone would be enough
  // today; together, neither a new private version byte nor a reshuffled
  // table can let one through.
  if (raw[KEY_OFFSET] === 0x00) {
    return { problem: 'privateKey' };
  }

  const version = readUint32(raw.subarray(0, 4));
  const network = PUBLIC_VERSIONS[version];
  if (network === undefined) {
    // Includes every xprv/yprv/zprv/tprv: they are not in the public table.
    return {
      problem: version in PRIVATE_VERSIONS ? 'privateKey' : 'unknownVersion',
    };
  }

  if (raw[DEPTH_OFFSET] !== ACCOUNT_DEPTH) {
    // A master key or a purpose-level key derives <chain>/<index> perfectly
    // happily and yields a different, valid, wrong wallet. Refusing is the
    // only way that failure is ever visible.
    return { problem: 'wrongDepth' };
  }

  const versions = CANONICAL[network];
  const canonical = new Uint8Array(raw);
  canonical[0] = (versions.public >>> 24) & 0xff;
  canonical[1] = (versions.public >>> 16) & 0xff;
  canonical[2] = (versions.public >>> 8) & 0xff;
  canonical[3] = versions.public & 0xff;

  let account: HDKey;
  try {
    account = HDKey.fromExtendedKey(b58.encode(canonical), versions);
  } catch {
    return { problem: 'notAKey' };
  }

  return {
    key: {
      network,
      publicKeyAt: (chain, index) => {
        const child = account.deriveChild(chain).deriveChild(index);
        if (child.publicKey === null) {
          throw new Error('bitcoin: derived child has no public key');
        }
        return child.publicKey;
      },
    },
  };
};

/** Listed only so an xprv can be named as what it is rather than lumped in
 *  with unrecognised bytes - the message a user needs is "that is your
 *  private key", not "unknown format". */
const PRIVATE_VERSIONS: Record<number, true> = {
  0x0488ade4: true, // xprv
  0x049d7878: true, // yprv
  0x04b2430c: true, // zprv
  0x04358394: true, // tprv
};
