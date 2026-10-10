import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';
import { rewardsVenueOf } from '@/sources/cardano/translator';
import { ACCOUNT_HISTORY_PAGE_SIZE } from '@/sources/cardano/cursor';
import { getAllEvents, openLedger, putEvents, putSource } from '@/ledger/db';
import { syncSource } from '@/sync/syncSource';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';

/**
 * Before Phase 7 every reward of an epoch was stored as
 * `reward:<stake>:<epoch>`, whatever its type. A member reward still uses
 * that id, so it upserts onto the old row; any other type moved to a
 * suffixed id. In an epoch with no member reward the old row is therefore
 * the old non-member reward, and nothing would ever overwrite it - the
 * reward page supersedes it so the next sync removes it.
 */
const HOST = 'https://cardano-mainnet.blockfrost.io';
const ROOT = `${HOST}/api/v0`;
const STAKE = 'stake1_supersede_fixture';
const MINE = 'addr1_supersede_mine';
const PAGED = `page=1&count=${ACCOUNT_HISTORY_PAGE_SIZE}`;

const config = { baseUrl: HOST, projectId: 'k', address: STAKE };

const source: SourceRecord = {
  id: 'ada-1',
  moduleId: cardanoBlockfrost.manifest.id,
  label: 'Pool operator',
  config,
};

const routes: Record<string, unknown> = {
  [`${ROOT}/accounts/${STAKE}/transactions?page=1&count=20&order=asc`]: [],
  [`${ROOT}/accounts/${STAKE}/addresses?page=1&count=100`]: [{ address: MINE }],
  [`${ROOT}/accounts/${STAKE}/rewards?${PAGED}`]: [
    { epoch: 450, amount: '5000000', type: 'leader' },
    { epoch: 451, amount: '1000000', type: 'member' },
    { epoch: 451, amount: '6000000', type: 'leader' },
  ],
  [`${ROOT}/accounts/${STAKE}/withdrawals?${PAGED}`]: [],
  [`${ROOT}/epochs/450`]: { end_time: 1_699_000_000 },
  [`${ROOT}/epochs/451`]: { end_time: 1_699_432_000 },
};

const stale = (epoch: number, type: string): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: source.id,
  externalId: `reward:${STAKE}:${epoch}`,
  timestamp: 1_699_000_000_000,
  kind: 'reward',
  origin: 'derived',
  rewardKind: type === 'member' ? 'staking' : 'leader',
  note: `staking reward (${type}), epoch ${epoch}`,
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '5',
      direction: 'in',
      venue: rewardsVenueOf(STAKE),
      role: 'principal',
    },
  ],
});

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('events');
  await db.clear('cursors');
  await db.clear('sources');
  await putSource(source);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = String(url);
      if (!(key in routes)) {
        return new Response('{}', { status: 404 });
      }
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pre-split Cardano reward rows', () => {
  it('names the stale id of an epoch with no member reward, and only that one', async () => {
    const page = await cardanoBlockfrost.fetchEvents(config, null);
    expect(page.supersedes).toEqual([`reward:${STAKE}:450`]);
  });

  it('removes the stale leader row on the next sync and keeps one leader reward', async () => {
    await putEvents([stale(450, 'leader'), stale(451, 'member')]);

    const report = await syncSource(source);
    expect(report.error).toBeUndefined();
    expect(report.superseded).toBe(1);

    const rewards = (await getAllEvents()).filter((event) =>
      event.externalId.startsWith('reward:'),
    );
    const ids = rewards.map((event) => event.externalId).sort();
    expect(ids).toEqual([
      `reward:${STAKE}:450:leader`,
      `reward:${STAKE}:451`,
      `reward:${STAKE}:451:leader`,
    ]);
    expect(
      rewards.filter(
        (event) =>
          event.rewardKind === 'leader' && event.externalId.includes(':450'),
      ),
    ).toHaveLength(1);
    // The member row kept its id and was overwritten in place.
    const member = rewards.find(
      (event) => event.externalId === `reward:${STAKE}:451`,
    )!;
    expect(member.rewardKind).toBe('staking');
    expect(member.legs[0].amount).toBe('1000000');
  });

  it('reports nothing superseded when no stale row exists', async () => {
    const report = await syncSource(source);
    expect(report.superseded ?? 0).toBe(0);
    const leaders = (await getAllEvents()).filter(
      (event) => event.rewardKind === 'leader',
    );
    expect(leaders).toHaveLength(2);
  });
});
