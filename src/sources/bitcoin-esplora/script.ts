import { base58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

/**
 * Encodes a derived public key as a Bitcoin address.
 *
 * `@scure/base` is used here rather than the hand-rolled
 * src/sources/cardano/bech32.ts, which exists only because BIP-173's
 * 90-character cap rejects Cardano's 103-character addresses. A Bitcoin
 * address is well inside the cap, so the audited implementation serves.
 */

/**
 * Taproot is deliberately absent.
 *
 * A p2tr address is not an encoding of the derived key: it is an encoding of
 * that key TWEAKED by taggedHash('TapTweak', internalKey), which is real
 * elliptic-curve work. Shipping it unvalidated would produce well-formed
 * addresses belonging to nobody, and a wallet that silently reports an empty
 * history - the exact failure this module has twice been fixed for. Adding
 * it means arriving with the BIP86 published vectors, or taking
 * @scure/btc-signer, which implements it.
 */
export type ScriptType = 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'p2tr';

/**
 * Probe order: most likely first, because the detector stops at the first
 * type with history and that is what keeps the common case to one request.
 *
 * Native SegWit leads because it is what every current wallet defaults to,
 * Ledger Live included.
 */
/** The types this module can actually encode. Taproot stays in ScriptType
 *  as a named, documented gap rather than being quietly forgotten, but it
 *  cannot appear anywhere an address is produced. */
export type SupportedScriptType = Exclude<ScriptType, 'p2tr'>;

export const SCRIPT_TYPES: SupportedScriptType[] = [
  'p2wpkh',
  'p2sh-p2wpkh',
  'p2pkh',
];

type Network = 'mainnet' | 'testnet';

/** Version bytes and hrp per network. p2pkh and p2sh differ by a whole
 *  version BYTE between networks, not merely by a leading character, so a
 *  mainnet-only encoder would silently produce an address on the wrong
 *  chain. */
const PARAMS: Record<
  Network,
  { hrp: string; pubKeyHash: number; scriptHash: number }
> = {
  mainnet: { hrp: 'bc', pubKeyHash: 0x00, scriptHash: 0x05 },
  testnet: { hrp: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4 },
};

const b58 = base58check(sha256);

/** RIPEMD160(SHA256(x)), Bitcoin's standard key and script digest. */
const hash160 = (bytes: Uint8Array): Uint8Array => ripemd160(sha256(bytes));

const base58Address = (version: number, payload: Uint8Array): string =>
  b58.encode(new Uint8Array([version, ...payload]));

/** Witness v0: the version is its own 5-bit symbol and is NOT part of the
 *  regrouped program, which is why the program is converted separately. */
const segwitV0 = (hrp: string, program: Uint8Array): string =>
  bech32.encode(hrp, [0, ...bech32.toWords(program)]);

export const addressFor = (
  type: SupportedScriptType,
  pubkey: Uint8Array,
  network: Network,
): string => {
  const params = PARAMS[network];
  const keyHash = hash160(pubkey);

  switch (type) {
    case 'p2wpkh':
      return segwitV0(params.hrp, keyHash);
    case 'p2pkh':
      return base58Address(params.pubKeyHash, keyHash);
    case 'p2sh-p2wpkh': {
      // The address commits to the REDEEM SCRIPT, not to the key: a p2sh
      // wrapper spends to hash160(0x00 0x14 <keyhash>), the serialised
      // witness program. Hashing the key directly here would produce a
      // valid address nobody can spend from and nobody owns.
      const redeemScript = new Uint8Array([0x00, 0x14, ...keyHash]);
      return base58Address(params.scriptHash, hash160(redeemScript));
    }
  }
};
