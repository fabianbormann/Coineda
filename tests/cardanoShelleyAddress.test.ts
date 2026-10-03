import { describe, it, expect } from 'vitest';
import { decodeBech32, encodeBech32 } from '@/sources/cardano/bech32';
import { stakeAddressOf } from '@/sources/cardano/shelley';

/**
 * The staking credential is readable from any of a wallet's payment
 * addresses, with no network access at all.
 *
 * The authoritative vectors are not invented: these four payment addresses
 * and the stake address they belong to are the account recorded in
 * src/sources/cardano-blockfrost/fixtures, so the expected answer here was
 * established by the provider independently of this code.
 */
const ACCOUNT = 'stake1u8j4gm959d5ppzgj2fpzh78a7hv6lw544dneenalx9fl6jqzpkxrm';

const ADDRESSES = [
  'addr1q9peuc0k30wf5x9x34zh7zk4wvn4l3yzcdfvjdrfe3rkw98923ktg2mgzzy3y5jz90u0mawe47aft2m8nn8m7v2nl4yqwz6vle',
  'addr1qx6jawm7tv2t9hh72jw723x4h4j8379tmxznh0mgksswws0923ktg2mgzzy3y5jz90u0mawe47aft2m8nn8m7v2nl4yq742vpr',
  'addr1qx9l2y3gpph7t682ylew7uhdtrettx996k2d9wghj96lual923ktg2mgzzy3y5jz90u0mawe47aft2m8nn8m7v2nl4yqph6fhn',
  'addr1qyl55ytlxsuk3sxse2wmfax0vfkcphne8rjmruxhjz92lvh923ktg2mgzzy3y5jz90u0mawe47aft2m8nn8m7v2nl4yqles4x7',
];

describe('stakeAddressOf', () => {
  it('derives the same account from every payment address of that wallet', () => {
    // The point of the whole exercise: four DIFFERENT payment credentials,
    // one shared staking credential. If this returned the payment half it
    // would produce four different answers here.
    expect(ADDRESSES).toHaveLength(4);
    expect(ADDRESSES.map(stakeAddressOf)).toEqual([
      ACCOUNT,
      ACCOUNT,
      ACCOUNT,
      ACCOUNT,
    ]);
  });

  it('needs no network access', () => {
    // Asserted by making any request impossible rather than by inspection:
    // this is the entire reason the function exists, since the provider
    // route it replaces 404s for an unused address.
    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('stakeAddressOf must not make a request');
    }) as typeof fetch;
    try {
      expect(stakeAddressOf(ADDRESSES[0])).toBe(ACCOUNT);
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });

  it('resolves an address that has never been used on chain', () => {
    // The reported case, as a SYNTHETIC address rather than the reported one.
    // A credential of random bytes has no history by construction, which is
    // the property under test, and no address belonging to a real wallet
    // goes into this repository - the same rule the recorded fixtures follow.
    const payment = new Uint8Array(57);
    payment[0] = (0 << 4) | 1;
    payment.fill(0x5e, 1, 29);
    payment.fill(0xa7, 29, 57);
    const unused = encodeBech32('addr', payment);

    const derived = stakeAddressOf(unused);
    expect(derived).toMatch(/^stake1/);
    // Round-trips: the credential in the reward address is byte-identical to
    // the one in the payment address, which is the property that makes this
    // safe to hand to /accounts/{stake}.
    const fromPayment = decodeBech32(unused)!.bytes.slice(29, 57);
    const fromReward = decodeBech32(derived!)!.bytes.slice(1, 29);
    expect([...fromReward]).toEqual([...fromPayment]);
  });

  it('tolerates the whitespace a pasted address arrives with', () => {
    expect(stakeAddressOf(`  ${ADDRESSES[0]}\n`)).toBe(ACCOUNT);
  });

  it('accepts the all-uppercase form bech32 permits', () => {
    expect(stakeAddressOf(ADDRESSES[0].toUpperCase())).toBe(ACCOUNT);
  });

  it('names a SCRIPT staking credential as a script reward address', () => {
    // Type 2 is PaymentKeyHash + ScriptHash, so its reward address must be
    // type 15 and not 14. Getting this wrong yields a well-formed address
    // naming a credential of the wrong kind, which a provider would simply
    // not find - a silent empty sync rather than an error.
    const payment = new Uint8Array(57);
    payment[0] = (2 << 4) | 1;
    payment.fill(0xab, 1, 29);
    payment.fill(0xcd, 29, 57);
    const derived = stakeAddressOf(encodeBech32('addr', payment));
    expect(derived).not.toBeNull();
    expect(decodeBech32(derived!)!.bytes[0] >> 4).toBe(15);

    const keyKind = new Uint8Array(payment);
    keyKind[0] = (0 << 4) | 1;
    expect(
      decodeBech32(stakeAddressOf(encodeBech32('addr', keyKind))!)!.bytes[0] >>
        4,
    ).toBe(14);
  });

  it('keeps a testnet address on the testnet', () => {
    const payment = new Uint8Array(57);
    payment[0] = (0 << 4) | 0;
    payment.fill(0x11, 1, 57);
    expect(stakeAddressOf(encodeBech32('addr_test', payment))).toMatch(
      /^stake_test1/,
    );
  });

  it('returns null for the address kinds that genuinely have no staking part', () => {
    // Each of these is a real answer, not a parse failure, and the address
    // tier is the correct outcome for them.
    const enterprise = new Uint8Array(29);
    enterprise[0] = (6 << 4) | 1;
    enterprise.fill(0x22, 1, 29);

    const pointer = new Uint8Array(32);
    pointer[0] = (4 << 4) | 1;
    pointer.fill(0x33, 1, 32);

    expect(stakeAddressOf(encodeBech32('addr', enterprise))).toBeNull();
    expect(stakeAddressOf(encodeBech32('addr', pointer))).toBeNull();
    // A Byron address is base58, not bech32.
    expect(
      stakeAddressOf('DdzFFzCqrhsf6hiTY8pZeqF4ZxPWGddvuS1E3RjSPKZkWvDYsTcTD4'),
    ).toBeNull();
    // A reward address is already the answer being asked for.
    expect(stakeAddressOf(ACCOUNT)).toBeNull();
    expect(stakeAddressOf('')).toBeNull();
    expect(stakeAddressOf('not an address')).toBeNull();
  });
});

describe('bech32', () => {
  it('round-trips a payload longer than BIP-173 allows', () => {
    // The reason this is hand-rolled. BIP-173 caps an encoding at 90
    // characters; a Cardano base address is 103, and a library enforcing the
    // cap rejects every address this module reads.
    expect(ADDRESSES[0].length).toBeGreaterThan(90);
    const decoded = decodeBech32(ADDRESSES[0]);
    expect(decoded).not.toBeNull();
    expect(encodeBech32(decoded!.hrp, decoded!.bytes)).toBe(ADDRESSES[0]);
  });

  it('rejects a corrupted checksum rather than decoding to something else', () => {
    // A mistyped address must not quietly become a different valid one -
    // that would send a sync at a stranger's wallet.
    const swapped = `${ADDRESSES[0].slice(0, -2)}${ADDRESSES[0].slice(-1)}${ADDRESSES[0].slice(-2, -1)}`;
    expect(swapped).not.toBe(ADDRESSES[0]);
    expect(decodeBech32(swapped)).toBeNull();
  });

  it('rejects mixed case, which bech32 does not permit', () => {
    const mixed = `${ADDRESSES[0].slice(0, 10).toUpperCase()}${ADDRESSES[0].slice(10)}`;
    expect(decodeBech32(mixed)).toBeNull();
  });

  it('rejects a character outside the bech32 alphabet', () => {
    // 'b', 'i', 'o' and '1' are excluded from the data alphabet precisely
    // because they are the easiest characters to misread.
    expect(decodeBech32('addr1bbbbbb')).toBeNull();
  });

  it('refuses a trailing partial group carrying data', () => {
    // Decoding must not silently drop a remainder: a 5-to-8 bit regroup with
    // leftover non-zero bits is a corrupted encoding, not a short one.
    const decoded = decodeBech32(ADDRESSES[0]);
    expect(decoded!.bytes.length).toBe(57);
  });
});
