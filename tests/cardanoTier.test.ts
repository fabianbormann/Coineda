import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTarget } from '@/sources/cardano/tier';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';
import type { CardanoProvider } from '@/sources/cardano/provider';

const ROOT = 'https://provider.example.org/api/v0';
const PAYMENT = 'addr1_payment_fixture';
const STAKE = 'stake1_account_fixture';

const provider: CardanoProvider = {
  host: () => 'https://provider.example.org',
  apiPath: '/api/v0',
  headers: () => ({}),
  exampleHost: 'https://provider.example.org',
  probeMessage: (status) => `provider said ${status}`,
};

/** Routes the instance serves, by URL, each either a body or a status. */
type Route =
  { body: unknown } | { status: number } | 'timeout' | 'abort' | 'unreachable';

const stub = (routes: Record<string, Route>) => {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      const route = routes[key];
      if (route === undefined) {
        // An instance that does not serve a route answers 404, which is the
        // whole ambiguity this procedure exists to resolve. Defaulting to a
        // throw would make every unlisted route look like a network failure.
        return new Response('{}', { status: 404 });
      }
      if (route === 'timeout') {
        throw new DOMException('aborted', 'TimeoutError');
      }
      if (route === 'abort') {
        throw new DOMException('aborted', 'AbortError');
      }
      if (route === 'unreachable') {
        // What fetch does when the host does not resolve or the connection
        // is refused: a TypeError, neither a status nor an abort.
        throw new TypeError('fetch failed');
      }
      if ('status' in route) {
        return new Response('{}', { status: route.status });
      }
      return new Response(JSON.stringify(route.body), { status: 200 });
    }),
  );
  return seen;
};

/**
 * The two account routes, at the URLs the DRAIN issues - page size, order
 * and all. The probe deliberately requests nothing else: probing a cheaper
 * `count=1` variant was a weaker check than the sync it is a check for, and
 * it also meant no recorded response could ever serve both. Spelled out
 * literally here, and literally again for the drain in
 * tests/cardanoAccountTier.test.ts, so the two drifting apart fails one of
 * them.
 */
const accountRoutes = (stake: string): Record<string, Route> => ({
  [`${ROOT}/accounts/${stake}/transactions?page=1&count=20&order=asc`]: {
    body: [],
  },
  [`${ROOT}/accounts/${stake}/addresses?page=1&count=100`]: { body: [] },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveTarget — a stake address was configured', () => {
  it('picks the account tier when both account routes answer', async () => {
    stub(accountRoutes(STAKE));
    await expect(
      resolveTarget(provider, { address: STAKE }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: STAKE });
  });

  it('refuses, naming the payment-address alternative, when the account API is absent', async () => {
    stub({});
    await expect(
      resolveTarget(provider, { address: STAKE }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.stakeAddressNeedsAccountApi,
    });
  });

  it('refuses when transactions answer but addresses do not', async () => {
    // Both routes are load-bearing: Tier 1 recognises the account's own
    // utxo entries by its enumerated address set, so an instance that can
    // list transactions but not addresses would build WRONG legs rather
    // than fail. See spec section 8a.
    stub({
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: {
        body: [],
      },
    });
    await expect(
      resolveTarget(provider, { address: STAKE }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.stakeAddressNeedsAccountApi,
    });
  });

  it('refuses with the instance message when an account route times out', async () => {
    // A timing-out account route is not evidence that the address tier
    // works, so it must not fall through to it - that silent fallback is
    // the bug TODO item 6 is about.
    stub({
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
        'timeout',
    });
    await expect(
      resolveTarget(provider, { address: STAKE }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.instanceCannotServe,
    });
  });

  it('tells a stake-address user their credential was refused, not to change their address', async () => {
    // Laundering a 403 into "this instance cannot look up an account" sends
    // the user to re-enter an address that was never the problem.
    stub({
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: {
        status: 403,
      },
    });
    await expect(
      resolveTarget(provider, { address: STAKE }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 403' });
  });
});

describe('resolveTarget — the configured address is normalised', () => {
  it('recognises an ALL-UPPERCASE stake address as a stake address', async () => {
    // Bech32 permits an all-uppercase encoding, and some wallets and QR
    // codes use it. `isStakeAddress` matches its prefixes case-sensitively,
    // so without folding the case an uppercase STAKE1... was taken for a
    // payment address - and the user was told to paste the stake address
    // they had just pasted.
    const seen = stub(accountRoutes(STAKE));
    await expect(
      resolveTarget(provider, { address: STAKE.toUpperCase() }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: STAKE });
    // Requested in the canonical lowercase spelling, which is what the
    // providers index.
    expect(seen.every((url) => !/STAKE1/.test(url))).toBe(true);
  });

  it('leaves a Byron address exactly as given, because base58 is case-sensitive', async () => {
    // NEW-1. The uppercase-bech32 fix was first written as an
    // unconditional `.toLowerCase()`, which destroys a Byron-era address:
    // base58 IS case-sensitive, and this module supports a Byron address as
    // a configured one (see the enterprise/Byron branch below, and legsFor's
    // null-account fallback). Folded, the lookup missed and the user was
    // told to paste a stake address a Byron address does not have - and if a
    // listing had answered, legsFor's `entry.address === address` would have
    // matched nothing, skipped every transaction and reported zero events
    // with no error. Normalisation happens at read time, so an
    // already-working source would have broken on upgrade with no user
    // action. The pre-existing Byron test uses the synthetic lowercase name
    // `addr_test1_enterprise`, so it could not see any of this.
    const BYRON = 'DdzFFzCqrhsf1sVGPjhRTaMSFNEKbEzWRbEaAJfqBZPNQxABCDEF';
    const lookup = `${ROOT}/addresses/${BYRON}`;
    const seen = stub({
      // A Byron address has no staking part, so the address tier is the
      // right answer - not an error.
      [lookup]: { body: { stake_address: null } },
    });

    await expect(
      resolveTarget(provider, { address: BYRON }, ROOT),
    ).resolves.toEqual({ tier: 'address' });

    // The case the user pasted, byte for byte, in the URL that was actually
    // requested.
    expect(seen).toContain(lookup);
    expect(seen.every((url) => !url.includes(BYRON.toLowerCase()))).toBe(true);
  });

  it('still trims whitespace, which is how an address usually arrives', async () => {
    stub(accountRoutes(STAKE));
    await expect(
      resolveTarget(provider, { address: `  ${STAKE}\n` }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: STAKE });
  });
});

describe('resolveTarget — a payment address was configured', () => {
  it('resolves the account and picks the account tier', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      ...accountRoutes(STAKE),
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: STAKE });
  });

  it('falls back to the address tier when the account API is absent', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'address' });
  });

  it('uses the address tier for an enterprise address with no staking part', async () => {
    // Asserts no ACCOUNT probe happens, not just the resulting tier: with the
    // null-stake guard removed, the code probes /accounts/null/... which the
    // stub 404s, yielding the same tier - so the tier alone cannot tell a
    // working guard from a missing one.
    const seen = stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: null } },
      ...accountRoutes(STAKE),
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'address' });
    expect(seen.some((url) => url.includes('/accounts/'))).toBe(false);
  });

  it('treats an empty stake_address the same as a missing one', async () => {
    const seen = stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: '' } },
      ...accountRoutes(STAKE),
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'address' });
    expect(seen.some((url) => url.includes('/accounts/'))).toBe(false);
  });

  it('does NOT call an unseen address unseen when the lookup route is simply absent', async () => {
    // Native Yaci has /addresses/{addr}/transactions but no plain
    // /addresses/{addr} - confirmed against its own 151-path OpenAPI
    // document. Reading that 404 as "never seen on chain" would tell a
    // healthy preprod user their address does not exist. The listing route
    // answering is what tells the two 404s apart.
    stub({
      [`${ROOT}/addresses/${PAYMENT}/transactions?page=1&count=20&order=asc`]: {
        body: [],
      },
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'address' });
  });

  it('reports an address the provider has never seen, when neither route answers', async () => {
    stub({});
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.addressNeverSeen,
    });
  });

  it('passes a refused credential through as the provider’s own message', async () => {
    // Removing /blocks/latest from the probe must not lose 401/403
    // handling: a Blockfrost project id that is wrong, or for the wrong
    // network, has to keep saying so rather than becoming "never seen".
    stub({ [`${ROOT}/addresses/${PAYMENT}`]: { status: 403 } });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: 'provider said 403',
    });
  });

  it('refuses with the instance message when the address listing times out', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}/transactions?page=1&count=20&order=asc`]:
        'timeout',
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.instanceCannotServe,
    });
  });

  it('checks the lookup route before the listing route, and stops as soon as it knows', async () => {
    const seen = stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      ...accountRoutes(STAKE),
    });
    await resolveTarget(provider, { address: PAYMENT }, ROOT);
    expect(seen[0]).toBe(`${ROOT}/addresses/${PAYMENT}`);
    expect(seen).not.toContain(
      `${ROOT}/addresses/${PAYMENT}/transactions?page=1&count=20&order=asc`,
    );
  });
});

describe('resolveTarget — the branches a happy path never reaches', () => {
  // resolveTarget's whole value is that it is TOTAL: every outcome of every
  // request maps to exactly one Target. An untested branch here either
  // refuses a working source or accepts a broken one.

  it('refuses with the instance message when the address LOOKUP times out', async () => {
    stub({ [`${ROOT}/addresses/${PAYMENT}`]: 'timeout' });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.instanceCannotServe,
    });
  });

  it('falls back to the provider’s own message when the lookup is unreachable', async () => {
    stub({ [`${ROOT}/addresses/${PAYMENT}`]: 'unreachable' });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 0' });
  });

  it('refuses when the account check times out after a successful lookup', async () => {
    // Reached only via a payment address, so the stake-address test of the
    // same timeout does not cover it.
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
        'timeout',
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({
      tier: 'refused',
      message: CARDANO_MESSAGES.instanceCannotServe,
    });
  });

  it('refuses rather than quietly dropping to the address tier when an account route is rate-limited', async () => {
    // The silent degrade is the dangerous one: address-only coverage misses
    // change returning to another address of the same wallet, which is what
    // makes an ordinary payment look like a disposal.
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: {
        status: 429,
      },
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 429' });
  });

  it('refuses when an account route cannot be reached at all', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
        'unreachable',
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 0' });
  });

  it('falls back to the provider’s own message when the address listing is unreachable', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}/transactions?page=1&count=20&order=asc`]:
        'unreachable',
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 0' });
  });

  it('reports a rate-limited address listing as the provider’s status, not as unseen', async () => {
    // A 429 on the listing says nothing about whether the address exists.
    // Calling it "never seen on chain" would send the user to change a
    // setting that was never wrong.
    stub({
      [`${ROOT}/addresses/${PAYMENT}/transactions?page=1&count=20&order=asc`]: {
        status: 429,
      },
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'refused', message: 'provider said 429' });
  });
});

describe('resolveTarget — cancellation', () => {
  it('rethrows a caller’s abort instead of reporting it as a provider failure', async () => {
    // Review Focus 1. resolveTarget runs before the drain, and probeRoute
    // deliberately swallows failures - so without an explicit rethrow a
    // user pressing Stop during resolution would get "could not reach the
    // provider" written to lastError, a red row for doing exactly what they
    // asked. syncSource reports `cancelled` only for an AbortError.
    stub({ [`${ROOT}/addresses/${PAYMENT}`]: 'abort' });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a caller’s abort during the account check too', async () => {
    stub({
      [`${ROOT}/addresses/${PAYMENT}`]: { body: { stake_address: STAKE } },
      [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]:
        'abort',
    });
    await expect(
      resolveTarget(provider, { address: PAYMENT }, ROOT),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/**
 * A REAL mainnet base address and the account it belongs to, from the
 * recordings in src/sources/cardano-blockfrost/fixtures.
 *
 * The PAYMENT constant above is a placeholder string, not a decodable
 * address, which is exactly why it cannot exercise the local-derivation path
 * added to resolveTarget: stakeAddressOf returns null for it and the
 * procedure falls through to the provider lookup, the behaviour every test
 * above was written against. These two are the real thing.
 */
const REAL_PAYMENT =
  'addr1q9peuc0k30wf5x9x34zh7zk4wvn4l3yzcdfvjdrfe3rkw98923ktg2mgzzy3y5jz90u0mawe47aft2m8nn8m7v2nl4yqwz6vle';
const REAL_ACCOUNT =
  'stake1u8j4gm959d5ppzgj2fpzh78a7hv6lw544dneenalx9fl6jqzpkxrm';

describe('resolveTarget - the staking credential is read from the address', () => {
  it('reaches the account tier without asking the provider to resolve the account', async () => {
    const seen = stub(accountRoutes(REAL_ACCOUNT));

    await expect(
      resolveTarget(provider, { address: REAL_PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: REAL_ACCOUNT });

    // The point of the change, and asserted as an absence because the tier
    // alone cannot distinguish it: /addresses/{address} is never requested,
    // so the account was resolved from the address bytes rather than from a
    // provider that may not know the address at all.
    expect(seen.some((url) => url.includes('/addresses/'))).toBe(false);
    expect(seen.some((url) => url.includes('/accounts/'))).toBe(true);
  });

  it('reaches the account tier for an address with NO history, which the provider 404s', async () => {
    // The reported failure. /addresses/{address} is left unstubbed, so it
    // answers 404 exactly as Blockfrost does for an address that has never
    // appeared on chain - and the account tier is still reached.
    stub(accountRoutes(REAL_ACCOUNT));

    await expect(
      resolveTarget(provider, { address: REAL_PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'account', account: REAL_ACCOUNT });
  });

  it('tolerates the whitespace and casing a pasted address arrives with', async () => {
    stub(accountRoutes(REAL_ACCOUNT));
    await expect(
      resolveTarget(
        provider,
        { address: `  ${REAL_PAYMENT.toUpperCase()}\n` },
        ROOT,
      ),
    ).resolves.toEqual({ tier: 'account', account: REAL_ACCOUNT });
  });

  it('falls through to the provider path when the instance serves no account routes', async () => {
    // Deliberately NOT short-circuiting to the address tier here: the
    // provider path below is what validates the drain's own listing route,
    // and skipping it would let the probe pass on an instance the sync then
    // fails against.
    const seen = stub({
      [`${ROOT}/addresses/${REAL_PAYMENT}`]: {
        body: { stake_address: REAL_ACCOUNT },
      },
      [`${ROOT}/addresses/${REAL_PAYMENT}/transactions?page=1&count=20&order=asc`]:
        { body: [] },
    });

    await expect(
      resolveTarget(provider, { address: REAL_PAYMENT }, ROOT),
    ).resolves.toEqual({ tier: 'address' });
    // It tried the account first, then fell through to the provider lookup
    // rather than short-circuiting - which is what keeps the pre-existing
    // provider path, and the decisions it makes, reachable.
    expect(seen.some((url) => url.includes('/accounts/'))).toBe(true);
    expect(seen).toContain(`${ROOT}/addresses/${REAL_PAYMENT}`);
  });
});
