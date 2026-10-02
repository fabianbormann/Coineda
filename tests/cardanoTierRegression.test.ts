import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import cardanoYaci from '@/sources/cardano-yaci';
import { foldHoldings, ownedVenuesOf } from '@/ledger/balances';
import type { LedgerEvent } from '@/ledger/types';
import { withAccountHistoryRoutes } from './cardanoRecordings';

const HOST = 'https://yaci-store.preprod.colo2.cf-systems.org';
const RECORDED_ADDRESS =
  'addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm';

const FIXTURES_DIR = path.join(
  __dirname,
  '../src/sources/cardano-yaci/fixtures',
);

const config = { baseUrl: HOST, address: RECORDED_ADDRESS };

const loadFixtures = async (): Promise<
  Map<string, { url: string; status: number; body: unknown }>
> => {
  const files = await readdir(FIXTURES_DIR);
  const fixtures = new Map<
    string,
    { url: string; status: number; body: unknown }
  >();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const { url, status, body } = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, file), 'utf8'),
    ) as { url: string; status: number; body: unknown };
    fixtures.set(url, { url, status, body });
  }
  // See tests/cardanoRecordings.ts: the paged /rewards URLs and an empty
  // /withdrawals, two routes these recordings predate.
  return withAccountHistoryRoutes(fixtures);
};

let seen: string[] = [];

beforeEach(async () => {
  const fixtures = await loadFixtures();
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      seen.push(key);
      const recorded = fixtures.get(key);
      if (!recorded) {
        // Native Yaci has no plain /addresses/{addr} and no account routes.
        // A 404 is what the real instance answers, and it is the input the
        // tier procedure has to read correctly.
        return new Response('{}', { status: 404 });
      }
      // Honour the RECORDED status. Serving a recorded 404 as 200 made the
      // two disambiguation tests below pass through the enterprise-address
      // branch instead, so they never exercised the code they are named for.
      return new Response(JSON.stringify(recorded.body), {
        status: recorded.status,
      });
    }),
  );
});

describe('a healthy native Yaci instance is unaffected', () => {
  it('takes the address tier, not a refusal', async () => {
    // The whole risk of this change: native Yaci 404s on
    // /addresses/{address} because the route does not exist, and reading
    // that as "never seen on chain" would refuse every working Yaci source.
    await expect(cardanoYaci.probe(config)).resolves.toEqual({
      ok: true,
      readOnly: true,
    });
  });

  it('still drains the address listing', async () => {
    await cardanoYaci.fetchEvents(config, null);
    expect(
      seen.some((url) =>
        url.includes(
          `/addresses/${RECORDED_ADDRESS}/transactions?page=1&count=20`,
        ),
      ),
    ).toBe(true);
  });

  it('produces byte-identical holdings to the pre-change behaviour', async () => {
    // venue, amounts and asset ids all unchanged. If any of them moved, the
    // user's balance moved with them.
    const { events } = await cardanoYaci.fetchEvents(config, null);
    const stamped = events.map((event, index) => ({
      ...event,
      id: `id-${index}`,
      sourceId: 'source-1',
    })) as LedgerEvent[];
    const holdings = foldHoldings(stamped, ownedVenuesOf(stamped));
    expect(holdings).toMatchSnapshot();
  });

  it('keeps emitting one event per transaction under one account venue', async () => {
    const account =
      'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk';
    const { events } = await cardanoYaci.fetchEvents(config, null);
    const transfers = events.filter((event) => event.kind === 'transfer');
    const transferLegs = transfers.flatMap((event) => event.legs);

    // Counted FIRST, and deliberately - the same guard this test's
    // Blockfrost sibling has. "every leg sits at the account" is satisfied
    // by having no legs at all, so without this the test passed if every
    // transaction were skipped, which is precisely the shipped defect the
    // Blockfrost fixture set reproduces. It asserted nothing about the one
    // thing it was named for either.
    expect(transferLegs.length).toBeGreaterThan(0);
    for (const leg of transferLegs) {
      expect(leg.venue).toBe(account);
    }

    // ONE EVENT PER TRANSACTION, as the name says: 20 listing rows on the
    // recorded page 1, 20 distinct transactions, 20 events. A second event
    // for one transaction would double every amount it carries.
    expect(transfers).toHaveLength(20);
    expect(new Set(transfers.map((event) => event.externalId)).size).toBe(
      transfers.length,
    );
  });

  it('resumes a cursor written before tiers existed', async () => {
    // Every cursor on disk today is a bare page number. A source mid-sync
    // at upgrade time must continue, not restart.
    await cardanoYaci.fetchEvents(config, '2');
    expect(seen.some((url) => url.includes('page=2&count=20'))).toBe(true);
  });

  it('still refuses a stake address, naming the payment-address alternative', async () => {
    const result = await cardanoYaci.probe({
      ...config,
      address:
        'stake_test1uqexa4sgarysazapgg6sq5e78g6dfmhx8x3ns3t2fsk6jagkccvfk',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/payment address/i);
  });

  it('never requests a padded address, however the user pasted it', async () => {
    // The probe trimmed and the drain did not, so a trailing space made the
    // probe accept a source the sync could not drain - and the user saw the
    // raw provider 404 this whole plan exists to replace.
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        // Native Yaci has no plain /addresses/{addr} route.
        return /\/addresses\/[^/]+$/.test(String(url))
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    const config = {
      baseUrl: 'https://yaci.example.org',
      address: `${RECORDED_ADDRESS}  `,
    };
    await cardanoYaci.probe(config);
    await cardanoYaci.fetchEvents(config, null);

    expect(seen.filter((url) => url.includes(`${RECORDED_ADDRESS} `))).toEqual(
      [],
    );
    expect(seen.length).toBeGreaterThan(0);
  });
});
