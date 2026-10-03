/**
 * Bech32, hand-rolled, because two things Coineda needs are not negotiable
 * and no dependency was worth either.
 *
 * 1. **No 90-character limit.** BIP-173 caps an encoding at 90 characters.
 *    Cardano ignores that cap - a mainnet base address is 103 characters -
 *    so a strict BIP-173 implementation rejects every address this module
 *    exists to read. Several general-purpose libraries enforce it.
 * 2. **Bech32, not bech32m.** The checksum constant is 1. Bech32m's
 *    0x2bc830a3 is for Taproot and would fail every Cardano address.
 *
 * Deliberately not a dependency: this is the whole of it, it is covered by
 * known-good vectors from the account recorded in this repository, and the
 * project pins and holds back dependencies on purpose rather than adding one
 * for forty lines of table lookup.
 *
 * Decoding only ever reads; nothing here touches a key. A Cardano address is
 * public data and this file cannot produce a signature.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values: number[]): number => {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) {
        checksum ^= GENERATOR[i];
      }
    }
  }
  return checksum;
};

/** The human-readable part, expanded as bech32 specifies: high bits, a
 *  separator zero, then low bits. */
const expandHrp = (hrp: string): number[] => {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
};

/**
 * Regroups between bit widths - 5-bit bech32 symbols to 8-bit bytes and
 * back.
 *
 * `pad` is the asymmetry that matters: encoding pads a trailing partial
 * group with zeroes, while decoding must REFUSE one, because a partial group
 * carrying anything but zero is a corrupted encoding rather than a short
 * one. Returning null there instead of silently dropping the remainder is
 * what stops a mistyped address from decoding into a plausible-looking
 * different address.
 */
const regroup = (
  data: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null => {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << to) - 1;

  for (const value of data) {
    if (value < 0 || value >> from !== 0) {
      return null;
    }
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((accumulator >> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((accumulator << (to - bits)) & maxValue);
    }
    return result;
  }
  if (bits >= from || ((accumulator << (to - bits)) & maxValue) !== 0) {
    return null;
  }
  return result;
};

/**
 * Decodes a bech32 string, or null if it is not one.
 *
 * Null rather than a throw: every caller here is deciding what a user pasted
 * into a form, and "this is not a bech32 address" is an expected answer
 * about input, not an exceptional condition.
 */
export const decodeBech32 = (
  value: string,
): { hrp: string; bytes: Uint8Array } | null => {
  if (value.length === 0) {
    return null;
  }
  // Mixed case is invalid in bech32 - the case-folding exists so an
  // all-uppercase QR encoding round-trips, not so halves can be mixed.
  const lower = value.toLowerCase();
  const upper = value.toUpperCase();
  if (value !== lower && value !== upper) {
    return null;
  }

  const separator = lower.lastIndexOf('1');
  // The HRP must be non-empty and at least six data characters must follow,
  // because the last six are the checksum.
  if (separator < 1 || separator + 7 > lower.length) {
    return null;
  }

  const hrp = lower.slice(0, separator);
  for (const char of hrp) {
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126) {
      return null;
    }
  }

  const symbols: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const index = CHARSET.indexOf(char);
    if (index === -1) {
      return null;
    }
    symbols.push(index);
  }

  if (polymod([...expandHrp(hrp), ...symbols]) !== 1) {
    return null;
  }

  const bytes = regroup(symbols.slice(0, -6), 5, 8, false);
  return bytes === null ? null : { hrp, bytes: new Uint8Array(bytes) };
};

export const encodeBech32 = (hrp: string, bytes: Uint8Array): string => {
  // Encoding pads, so regroup cannot fail here - a Uint8Array's values are
  // already in range by construction.
  const symbols = regroup([...bytes], 8, 5, true) as number[];
  const checksum =
    polymod([...expandHrp(hrp), ...symbols, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    tail.push((checksum >> (5 * (5 - i))) & 31);
  }
  return `${hrp}1${[...symbols, ...tail].map((s) => CHARSET[s]).join('')}`;
};
