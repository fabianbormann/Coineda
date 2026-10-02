import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runConformance } from '@/sources/conformance';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';
import { withAccountHistoryRoutes } from './cardanoRecordings';
import { rewardsVenueOf } from '@/sources/cardano/translator';

/**
 * The first Blockfrost-recorded fixtures this project has had.
 *
 * They matter more than one more provider's coverage. The existing
 * Blockfrost tests rehost the recorded YACI bodies under Blockfrost's host
 * and API path - and those bodies carry `stake_address` on every utxo
 * entry, which Blockfrost does not send at all. The double supplied exactly
 * the field the real provider omits, so the account view appeared to work
 * there for an entire milestone while silently doing nothing.
 *
 * Recorded from a PUBLIC mainnet pool reward account, never the owner's
 * wallet: Blockfrost's account routes need a mainnet key, and committing
 * anyone's own mainnet history to a public repository is not a recording
 * decision. The project id travels in a header, so no fixture holds it.
 *
 * What the recorded account contains, measured from the fixtures rather
 * than assumed: 4 payment addresses, 22 listing rows over two pages, 16
 * distinct transactions - 5 of them on more than one row and one on three -
 * and 91 epoch rewards.
 */
const HOST = 'https://cardano-mainnet.blockfrost.io';
const STAKE = 'stake1u8j4gm959d5ppzgj2fpzh78a7hv6lw544dneenalx9fl6jqzpkxrm';
const UNSEEN = 'addr1v8rvgfgc0lqjmr9elj8wf0keptdwrl8j2vzj893gnr0wetg87v4l5';

const config = { baseUrl: HOST, projectId: 'k', address: STAKE };

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/cardano-blockfrost/fixtures',
);

type Recorded = { url: string; status: number; body: unknown };

const loadFixtures = async (): Promise<Map<string, Recorded>> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<string, Recorded>();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const recorded = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, file), 'utf8'),
    ) as Recorded;
    fixtures.set(recorded.url, recorded);
  }
  return fixtures;
};

// Keyed on the requested URL, not a call counter: runConformance drains
// twice to check idempotence, so a counter would have advanced by the
// second drain and this module would look non-idempotent for the harness's
// reason rather than its own.
const stubFetch = (fixtures: Map<string, Recorded>) => {
  // See tests/cardanoRecordings.ts: the paged /rewards URLs and an empty
  // /withdrawals, two routes these recordings predate. The three real
  // withdrawals this account has on chain are NOT in this repository.
  const served = withAccountHistoryRoutes(fixtures);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const recorded = served.get(String(url));
      if (!recorded) {
        // Kept as a throw for a genuinely unrecorded URL: that strictness
        // is what catches a typo'd URL in the module, where a blanket 404
        // would read as a route the provider does not serve and hide it.
        throw new Error(`no recorded fixture for ${String(url)}`);
      }
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
      });
    }),
  );
};

const rewardsUrl = `${HOST}/api/v0/accounts/${STAKE}/rewards`;

let fixtures: Map<string, Recorded>;

beforeEach(async () => {
  fixtures = await loadFixtures();
  stubFetch(fixtures);
});

describe('cardano-blockfrost, against recorded Blockfrost responses', () => {
  it('recorded no utxo entry carrying stake_address', () => {
    // The premise of the whole account tier, asserted against what the
    // provider actually sent. If Blockfrost ever starts sending the field,
    // this test says so rather than letting a stale comment claim it.
    const utxoBodies = [...fixtures.values()].filter((f) =>
      f.url.includes('/utxos'),
    );
    expect(utxoBodies.length).toBeGreaterThan(0);
    for (const recorded of utxoBodies) {
      const body = recorded.body as {
        inputs: Record<string, unknown>[];
        outputs: Record<string, unknown>[];
      };
      for (const entry of [...body.inputs, ...body.outputs]) {
        expect(Object.keys(entry)).not.toContain('stake_address');
      }
    }
  });

  it('passes the conformance suite', async () => {
    await expect(
      runConformance(cardanoBlockfrost, { config }),
    ).resolves.toBeUndefined();
  });

  it('emits one event per transaction over two real pages', async () => {
    // 22 listing rows, 16 distinct transactions, 5 of them on more than one
    // row because the account holds several of their addresses - one on
    // three rows. One event each, or the balance is inflated by the number
    // of the account's own addresses a transaction happened to touch.
    const all = [];
    let cursor: string | null = null;
    do {
      const page = await cardanoBlockfrost.fetchEvents(config, cursor);
      all.push(...page.events);
      cursor = page.cursor;
    } while (cursor !== null);

    const transfers = all.filter((event) => event.kind === 'transfer');
    expect(new Set(transfers.map((event) => event.externalId)).size).toBe(
      transfers.length,
    );
    expect(transfers).toHaveLength(16);
  });

  it('reports every leg under the account', async () => {
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    const transferLegs = events
      .filter((event) => event.kind === 'transfer')
      .flatMap((event) => event.legs);
    // Counted first, and deliberately: "every leg has venue STAKE" is
    // satisfied by having no transfer legs at all, which is precisely the
    // shipped defect this fixture set reproduces - the single-address
    // filter matches nothing on Blockfrost, every transaction is skipped
    // for having no legs, and only the rewards survive.
    expect(transferLegs.length).toBeGreaterThan(0);
    for (const leg of transferLegs) {
      expect(leg.venue).toBe(STAKE);
    }
    // Reward legs sit at the reward POT, which is a different place from
    // the account's utxos - that is what stops a withdrawal being counted
    // twice. Asserted here rather than left to the reward test alone,
    // because this test used to require the two to be the SAME venue.
    const rewardLegs = events
      .filter((event) => event.kind === 'reward')
      .flatMap((event) => event.legs);
    expect(rewardLegs.length).toBeGreaterThan(0);
    for (const leg of rewardLegs) {
      expect(leg.venue).toBe(rewardsVenueOf(STAKE));
    }
  });

  it('emits real staking rewards on Blockfrost, which it never could before', async () => {
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    const rewards = events.filter((event) => event.kind === 'reward');
    expect(rewards).toHaveLength(91);
    for (const reward of rewards) {
      expect(reward.legs[0].amount).toMatch(/^\d+$/);
      expect(reward.legs[0].venue).toBe(rewardsVenueOf(STAKE));
    }
  });

  it('passes every amount through as a decimal string', async () => {
    const { events } = await cardanoBlockfrost.fetchEvents(config, null);
    // Transfer amounts come from the utxo endpoints and reward amounts from
    // the rewards endpoint, and the two providers disagree about the latter
    // - so a run with no transfers in it would check only half of what this
    // test is named for.
    expect(events.filter((event) => event.kind === 'transfer').length).toBe(15);
    for (const event of events) {
      for (const leg of event.legs) {
        expect(leg.amount).toMatch(/^-?\d+(\.\d+)?$/);
      }
    }
  });

  it('records a reward amount as a string, where Yaci sends a JSON number', async () => {
    // Measured, not assumed, and it corrects the assumption this module
    // shipped with: the two providers DIFFER here. Every one of the 91
    // recorded Blockfrost rows carries `amount` as a string;
    // src/sources/cardano-yaci/fixtures/101.json carries it as a number.
    // The translator accepts either, which is the only reason that
    // divergence was never a defect - so the type is worth pinning rather
    // than rediscovering.
    const recorded = fixtures.get(rewardsUrl);
    expect(recorded).toBeDefined();
    const rows = recorded!.body as { amount: unknown }[];
    expect(rows).toHaveLength(91);
    for (const row of rows) {
      expect(typeof row.amount).toBe('string');
    }
  });

  it('refuses a reward amount JSON parsing has already rounded', async () => {
    // Review Focus 3. amountString throws rather than record a rounded
    // value, and that guard has never been reachable on Blockfrost because
    // rewards never ran there at all - `fetchRewardEvents` is gated on a
    // resolved account, and on Blockfrost no account ever resolved. The
    // account tier makes it reachable. The number here is injected, since
    // Blockfrost's own recorded rows are strings (see above); a provider
    // that switches to numbers, as Yaci already sends them, is exactly what
    // this guard stands between and a tax report.
    const recorded = fixtures.get(rewardsUrl);
    expect(recorded).toBeDefined();
    const rows = recorded!.body as { epoch: number; type: string }[];
    stubFetch(
      new Map(fixtures).set(rewardsUrl, {
        ...recorded!,
        body: [{ ...rows[0], amount: Number.MAX_SAFE_INTEGER + 2 }],
      }),
    );
    await expect(cardanoBlockfrost.fetchEvents(config, null)).rejects.toThrow(
      /exceeds safe integer precision/,
    );
  });

  it('tells the user plainly when the provider has never seen the address', async () => {
    // Recorded 404s for both routes - TODO item 5, which surfaced as
    // "cardano: listing transactions failed with status 404" and is what a
    // user pasting a brand-new payment address actually hit.
    await expect(
      cardanoBlockfrost.probe({ ...config, address: UNSEEN }),
    ).resolves.toEqual({
      ok: false,
      message: CARDANO_MESSAGES.addressNeverSeen,
    });
  });

  it('refuses to sync the address it refused to probe', async () => {
    // probe is not on syncSource's path, so a guard that lives only there
    // protects nothing on a refresh - and the raw "status 404" the reported
    // bug showed came from the drain, not the probe.
    await expect(
      cardanoBlockfrost.fetchEvents({ ...config, address: UNSEEN }, null),
    ).rejects.toThrow(CARDANO_MESSAGES.addressNeverSeen);
  });
});
