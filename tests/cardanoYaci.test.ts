import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runConformance } from '@/sources/conformance';
import cardanoYaci from '@/sources/cardano-yaci';
import { withAccountHistoryRoutes } from './cardanoRecordings';

const config = {
  baseUrl: 'https://yaci-store.preprod.colo2.cf-systems.org',
  address: 'addr_test1_fixture',
};

// The committed fixtures were recorded against a real preprod address (see
// src/sources/cardano-yaci/fixtures - recorded with
// scripts/record-fixtures.ts, not hand-written). That real address is not a
// secret - it is a public read-only chain address - but the test config
// above uses a readable placeholder instead of pasting a 44-character
// bech32 string into every test. loadFixtures() swaps the real address for
// the placeholder everywhere it appears in the recorded text - in the
// request URL and in the inputs/outputs entries' own `address` field - so
// the module's filter-by-configured-address logic still lines up with the
// config this file actually passes.
const RECORDED_ADDRESS =
  'addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm';

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/cardano-yaci/fixtures',
);

/** The account the transaction fixtures belong to. Its recorded rewards
 *  response is `[]` - it never delegated. */
const TRACKED_STAKE =
  'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk';

/** A different preprod account, recorded precisely because it has ten real
 *  epoch rewards. */
const DELEGATED_STAKE =
  'stake_test1uqfzskazkqhtph40s82g93n4srh3x463lazy0n2gkv9rnyq7acw3c';

const HOST = 'https://yaci-store.preprod.colo2.cf-systems.org';
const rewardsUrl = (stake: string): string =>
  `${HOST}/api/v1/accounts/${stake}/rewards`;

type Recorded = { url: string; status: number; body: unknown };

const loadFixtures = async (): Promise<Map<string, Recorded>> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<string, Recorded>();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const raw = await readFile(path.join(FIXTURES_DIR, file), 'utf8');
    const anonymised = raw.split(RECORDED_ADDRESS).join(config.address);
    const recorded = JSON.parse(anonymised) as Recorded;
    fixtures.set(recorded.url, recorded);
  }
  return fixtures;
};

// Keyed on the requested URL, not a call counter: runConformance drains twice
// to check idempotence, so a counter would have advanced by the second drain
// and this module would look non-idempotent for the harness's reason rather
// than its own.
const stubFetch = (fixtures: Map<string, Recorded>) => {
  // withAccountHistoryRoutes adds the paged /rewards URLs the module now
  // requests and an empty /withdrawals - two routes these recordings
  // predate. See tests/cardanoRecordings.ts for exactly what it serves and
  // why none of it is a fabricated provider body.
  const served = withAccountHistoryRoutes(fixtures);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const recorded = served.get(String(url));
      if (!recorded) {
        // Kept a throw rather than a blanket 404: this strictness is what
        // catches a typo'd URL in the module, where a 404 would quietly
        // look like a route the instance does not serve.
        throw new Error(`no recorded fixture for ${String(url)}`);
      }
      // The RECORDED status, not a hardcoded 200. Yaci answers 404 on the
      // plain /addresses/{addr} lookup - it has no such route - and the
      // tier procedure turns that 404 into "the lookup route is absent"
      // only if it ever sees it.
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
      });
    }),
  );
};

/**
 * The same fixture set, with the TRACKED account's rewards response
 * replaced by the reward-bearing account's recorded one.
 *
 * Not a hand-written body: it is fixture 101 verbatim, served under the
 * tracked account's URL. The distinction matters, because it is the whole
 * reason the conformance gate was vacuous. The tracked account's recorded
 * rewards response is `[]`, so a drain over the fixtures as recorded never
 * emits a `kind: 'reward'` event at all, and `checkEvent`'s
 * manifest-declares-this-kind rule - the one rule in the harness that
 * exists to catch exactly a missing `emits` entry - was never reached.
 * Both Cardano manifests declared only ['transfer'] while the shared
 * translator emitted rewards too, and the gate stayed green for an entire
 * milestone.
 */
const withRewardsForTrackedAccount = (
  fixtures: Map<string, Recorded>,
): Map<string, Recorded> => {
  const recorded = fixtures.get(rewardsUrl(DELEGATED_STAKE));
  if (!Array.isArray(recorded?.body) || recorded.body.length === 0) {
    throw new Error('fixture 101 should hold the recorded epoch rewards');
  }
  return new Map(fixtures).set(rewardsUrl(TRACKED_STAKE), {
    ...recorded,
    url: rewardsUrl(TRACKED_STAKE),
  });
};

beforeEach(async () => {
  stubFetch(await loadFixtures());
});

describe('cardano-yaci', () => {
  it('passes the conformance suite', async () => {
    await expect(
      runConformance(cardanoYaci, { config }),
    ).resolves.toBeUndefined();
  });

  it('passes the conformance suite for an account that HAS staking rewards', async () => {
    // The non-vacuous half of the gate. Over the fixtures exactly as
    // recorded the tracked account has no rewards, so no reward event is
    // ever drained and the harness's "emitted a kind its manifest does not
    // declare" check is unreachable. This run serves the recorded rewards
    // of the delegating account for the tracked one, so the drain really
    // does produce `kind: 'reward'` and the manifest really is tested
    // against it.
    stubFetch(withRewardsForTrackedAccount(await loadFixtures()));
    await expect(
      runConformance(cardanoYaci, { config }),
    ).resolves.toBeUndefined();
  });

  it('declares every kind the shared translator can emit', () => {
    // Stated as a property of the manifest as well, because the drain
    // above only covers the kinds THESE fixtures happen to contain.
    expect([...cardanoYaci.manifest.emits].sort()).toEqual([
      'reward',
      'transfer',
    ]);
  });

  it('declares itself browser-callable and credential-free', () => {
    expect(cardanoYaci.manifest.needsRelay).toBe(false);
    const credentialFields = cardanoYaci.manifest.fields.filter(
      (field) => field.type === 'apiKey' || field.type === 'secret',
    );
    expect(credentialFields).toEqual([]);
  });

  it('takes the base URL as a field so anyone can point at their own instance', () => {
    const field = cardanoYaci.manifest.fields.find((f) => f.name === 'baseUrl');
    expect(field).toBeDefined();
    expect(field?.type).toBe('text');
  });

  it('marks the base URL optional, because its own help text says to leave it empty', () => {
    // The help line rendered under this input says "Leave this empty to use
    // the public mainnet deployment". AddSourceDialog refuses to save while
    // any non-optional field is blank, so without this flag the field's own
    // instruction is the thing that blocks the save - the milestone's
    // primary flow, broken by its own help text.
    const field = cardanoYaci.manifest.fields.find((f) => f.name === 'baseUrl');
    expect(field?.optional).toBe(true);
    expect(cardanoYaci.manifest.fields.some((f) => f.optional)).toBe(true);
  });

  it('falls back to the public mainnet instance for every shape of empty base URL', async () => {
    // Storing the field empty has to be safe before the dialog is allowed to
    // do it. Three shapes reach the module: '' (the user cleared the input),
    // whitespace, and absent entirely (the user never touched the input, so
    // AddSourceDialog's `config` has no entry for it at all).
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    const empties: Record<string, string>[] = [
      { baseUrl: '', address: config.address },
      { baseUrl: '   ', address: config.address },
      { address: config.address },
    ];

    await Promise.all(empties.map((cfg) => cardanoYaci.fetchEvents(cfg, null)));

    // Two requests per drain, not one: resolving the tier looks the address
    // up before the listing request the address tier then makes. Counted
    // rather than left loose, because the fallback host has to be the one
    // used by EVERY request a drain issues, not just its first.
    expect(seen).toHaveLength(empties.length * 2);
    expect(
      seen.filter((url) => url.endsWith(`/addresses/${config.address}`)),
    ).toHaveLength(empties.length);
    for (const url of seen) {
      expect(url).toMatch(
        /^https:\/\/yaci-store\.mainnet\.colo2\.cf-systems\.org\//,
      );
    }
  });

  it('emits legs only for the configured account, never the counterparty', async () => {
    // The host derives owned venues from the venues in its own events, so a
    // counterparty leg here would inflate the balance AND make every outbound
    // send look like an internal transfer, hiding real disposals.
    //
    // The venue is the ACCOUNT - the stake address the configured payment
    // address belongs to - not the payment address itself, so that every
    // address of one wallet reports under one venue and movement between
    // them nets to zero. See tests/cardanoAccountView.test.ts.
    const account =
      'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk';
    const { events } = await cardanoYaci.fetchEvents(config, null);
    for (const event of events) {
      for (const leg of event.legs) {
        expect(leg.venue).toBe(account);
      }
    }
  });

  it('passes quantities through as decimal strings without touching floats', async () => {
    const { events } = await cardanoYaci.fetchEvents(config, null);
    for (const event of events) {
      for (const leg of event.legs) {
        expect(leg.amount).toMatch(/^-?\d+(\.\d+)?$/);
      }
    }
  });

  it('chain-qualifies asset ids and keeps lovelace distinct from native tokens', async () => {
    const { events } = await cardanoYaci.fetchEvents(config, null);
    const assetIds = new Set(
      events.flatMap((e) => e.legs.map((l) => l.assetId)),
    );
    for (const assetId of assetIds) {
      expect(assetId.startsWith('cardano:')).toBe(true);
    }
  });

  it('converts block_time from seconds to epoch milliseconds', async () => {
    // The API returns seconds. Storing those unconverted would date every
    // event to 1970 and put it in the wrong tax year.
    const { events } = await cardanoYaci.fetchEvents(config, null);
    for (const event of events) {
      expect(event.timestamp).toBeGreaterThan(1_000_000_000_000);
    }
  });

  it('pages ascending so the cursor stays stable as new transactions arrive', async () => {
    await cardanoYaci.fetchEvents(config, null);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const listCall = calls.find(([url]) =>
      String(url).includes('/transactions'),
    );
    expect(String(listCall?.[0])).toContain('order=asc');
  });

  it('reports a clear failure when the provider is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    const result = await cardanoYaci.probe(config);
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('reports read-only, because an address is all it ever sees', async () => {
    const result = await cardanoYaci.probe(config);
    expect(result.readOnly).toBe(true);
  });
});
