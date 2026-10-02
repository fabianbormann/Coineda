import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runConformance } from '@/sources/conformance';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import cardanoYaci from '@/sources/cardano-yaci';
import { withAccountHistoryRoutes } from './cardanoRecordings';

const ADDRESS = 'addr_test1_fixture';
const PROJECT_ID = 'preprodTESTKEYNOTREAL000000000000000';

const blockfrostConfig = {
  baseUrl: 'https://cardano-preprod.blockfrost.io',
  projectId: PROJECT_ID,
  address: ADDRESS,
};

const yaciConfig = {
  baseUrl: 'https://yaci-store.preprod.colo2.cf-systems.org',
  address: ADDRESS,
};

const RECORDED_ADDRESS =
  'addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm';

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/cardano-yaci/fixtures',
);

/**
 * The recorded Yaci Store bodies, served under whichever host and API path
 * is asked for.
 *
 * These are deliberately the YACI bodies, rehosted - they are NOT
 * Blockfrost-recorded, and must not be read as evidence about Blockfrost's
 * own response shapes. That confusion cost this project a milestone: these
 * rehosted bodies carry `stake_address` on every utxo entry, a field
 * Blockfrost does not send at all, so the account view appeared to work
 * there while doing nothing. Real Blockfrost recordings now live in
 * src/sources/cardano-blockfrost/fixtures and are driven by
 * tests/cardanoBlockfrostFixtures.test.ts; what THIS file asserts is the
 * thing sharing one translator can actually break - that both modules
 * drive it to the same result from identical bodies - plus the parts that
 * are genuinely Blockfrost's own (its auth header and its rejection
 * behaviour), which need no recorded body at all.
 */
type Recorded = { url: string; status: number; body: unknown };

const loadFixtures = async (
  host: string,
  apiPath: string,
): Promise<Map<string, Recorded>> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<string, Recorded>();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const raw = await readFile(path.join(FIXTURES_DIR, file), 'utf8');
    const anonymised = raw.split(RECORDED_ADDRESS).join(ADDRESS);
    const recorded = JSON.parse(anonymised) as Recorded;
    const rehosted = recorded.url
      .replace('https://yaci-store.preprod.colo2.cf-systems.org', host)
      .replace('/api/v1/', `${apiPath}/`);
    fixtures.set(rehosted, { ...recorded, url: rehosted });
  }
  return fixtures;
};

/** The tracked account (recorded rewards: `[]`) and the delegating one
 *  recorded because it has ten real epoch rewards. */
const TRACKED_STAKE =
  'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk';
const DELEGATED_STAKE =
  'stake_test1uqfzskazkqhtph40s82g93n4srh3x463lazy0n2gkv9rnyq7acw3c';

/**
 * The same bodies, with the reward-bearing account's recorded rewards
 * served for the TRACKED account - fixture 101 verbatim, under a different
 * URL. Without this a drain emits no `kind: 'reward'` event at all, and the
 * harness's manifest check never sees one, which is how both Cardano
 * manifests declared only ['transfer'] while the shared translator emitted
 * rewards. See the same helper in tests/cardanoYaci.test.ts.
 */
const withRewardsForTrackedAccount = (
  fixtures: Map<string, Recorded>,
  host: string,
  apiPath: string,
): Map<string, Recorded> => {
  const rewardsUrl = (stake: string) =>
    `${host}${apiPath}/accounts/${stake}/rewards`;
  const recorded = fixtures.get(rewardsUrl(DELEGATED_STAKE));
  if (!Array.isArray(recorded?.body) || recorded.body.length === 0) {
    throw new Error('fixture 101 should hold the recorded epoch rewards');
  }
  return new Map(fixtures).set(rewardsUrl(TRACKED_STAKE), {
    ...recorded,
    url: rewardsUrl(TRACKED_STAKE),
  });
};

type Call = { url: string; headers: Record<string, string> };

let calls: Call[] = [];

const stubFetch = (fixtures: Map<string, Recorded>) => {
  // See tests/cardanoRecordings.ts: the paged /rewards URLs and an empty
  // /withdrawals, two routes these recordings predate.
  const served = withAccountHistoryRoutes(fixtures);
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const recorded = served.get(String(url));
      if (!recorded) {
        // A throw, not a blanket 404: an unrecorded URL here means the
        // module asked for something nobody recorded, and a 404 would hide
        // that behind a plausible-looking "route absent".
        throw new Error(`no recorded fixture for ${String(url)}`);
      }
      // The recorded status. The rehosted Yaci set includes a real 404 for
      // the plain /addresses/{addr} lookup, which is what the tier
      // procedure reads to decide the lookup route is simply absent.
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
      });
    }),
  );
};

beforeEach(async () => {
  stubFetch(
    await loadFixtures('https://cardano-preprod.blockfrost.io', '/api/v0'),
  );
});

describe('cardano-blockfrost', () => {
  it('passes the conformance suite', async () => {
    await expect(
      runConformance(cardanoBlockfrost, { config: blockfrostConfig }),
    ).resolves.toBeUndefined();
  });

  it('passes the conformance suite for an account that HAS staking rewards', async () => {
    stubFetch(
      withRewardsForTrackedAccount(
        await loadFixtures('https://cardano-preprod.blockfrost.io', '/api/v0'),
        'https://cardano-preprod.blockfrost.io',
        '/api/v0',
      ),
    );
    await expect(
      runConformance(cardanoBlockfrost, { config: blockfrostConfig }),
    ).resolves.toBeUndefined();
  });

  it('declares every kind the shared translator can emit', () => {
    expect([...cardanoBlockfrost.manifest.emits].sort()).toEqual([
      'reward',
      'transfer',
    ]);
  });

  it('declares itself browser-callable and credential-bearing', () => {
    // CORS was verified against the live service: a GET answers
    // access-control-allow-origin: *, and the preflight allows a custom
    // header, which is what the project_id header needs.
    expect(cardanoBlockfrost.manifest.needsRelay).toBe(false);
    const credential = cardanoBlockfrost.manifest.fields.find(
      (field) => field.name === 'projectId',
    );
    expect(credential?.type).toBe('apiKey');
    // The credential is the one field that must never be optional: an empty
    // project id would store a source that can only ever return 403.
    expect(credential?.optional).toBeFalsy();
  });

  it('sends the project id as a header on every request', async () => {
    await cardanoBlockfrost.fetchEvents(blockfrostConfig, null);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.headers.project_id).toBe(PROJECT_ID);
    }
  });

  it('never puts the project id in the request URL', async () => {
    // A credential in a query string lands in provider logs and in any
    // proxy between here and them.
    await cardanoBlockfrost.fetchEvents(blockfrostConfig, null);
    for (const call of calls) {
      expect(call.url).not.toContain(PROJECT_ID);
    }
  });

  it('derives the same events as cardano-yaci from the same bodies', async () => {
    // The actual risk of sharing one translator between two modules: a
    // change made for one silently altering the other. Both are driven
    // over the identical recorded bodies and must agree exactly.
    const blockfrost = await cardanoBlockfrost.fetchEvents(
      blockfrostConfig,
      null,
    );

    stubFetch(
      await loadFixtures(
        'https://yaci-store.preprod.colo2.cf-systems.org',
        '/api/v1',
      ),
    );
    const yaci = await cardanoYaci.fetchEvents(yaciConfig, null);

    expect(blockfrost.events).toEqual(yaci.events);
    expect(blockfrost.cursor).toEqual(yaci.cursor);
  });

  it('reports a rejected project id distinctly from an unreachable host', async () => {
    // 403 means the key was refused; the user has to fix the key. A 503
    // means try later. Collapsing both into one message leaves them with
    // no idea which.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    const rejected = await cardanoBlockfrost.probe(blockfrostConfig);
    expect(rejected.ok).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    const unreachable = await cardanoBlockfrost.probe(blockfrostConfig);
    expect(unreachable.ok).toBe(false);

    expect(rejected.message).not.toBe(unreachable.message);
  });

  it('reports read-only, because an address is all it ever sees', async () => {
    const result = await cardanoBlockfrost.probe(blockfrostConfig);
    expect(result.readOnly).toBe(true);
  });

  it('keeps the project id out of every failure it reports', async () => {
    // The contract rule in src/sources/types.ts, which stops being
    // theoretical now that a chain module holds a credential: whatever this
    // rejects with is stored as the source's lastError, rendered on screen
    // by SourceRow, and carried in the checkpoint.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const probed = await cardanoBlockfrost.probe(blockfrostConfig);
    expect(probed.message ?? '').not.toContain(PROJECT_ID);

    await expect(
      cardanoBlockfrost.fetchEvents(blockfrostConfig, null),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(PROJECT_ID),
      }),
    );
  });
});

describe('cardano-yaci after the shared-translator extraction', () => {
  beforeEach(async () => {
    stubFetch(
      await loadFixtures(
        'https://yaci-store.preprod.colo2.cf-systems.org',
        '/api/v1',
      ),
    );
  });

  it('still sends no credential header at all', async () => {
    // A chain-only Yaci user holds no secret, which is why their checkpoint
    // contains none. Sharing a translator with a credential-bearing module
    // must not quietly introduce one.
    await cardanoYaci.fetchEvents(yaciConfig, null);
    for (const call of calls) {
      expect(call.headers.project_id).toBeUndefined();
    }
  });
});
