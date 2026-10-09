import type { LedgerEvent, RewardKind } from '@/ledger/types';

/** Translation keys, one per kind, printed at the head of an income row. */
export const REWARD_KIND_LABELS: Record<RewardKind, string> = {
  staking: 'Staking reward',
  leader: 'Pool operator reward',
  lending: 'Lending interest',
  liquidity: 'Liquidity reward',
  mining: 'Mining reward',
  masternode: 'Masternode reward',
  airdrop: 'Airdrop',
  fork: 'Hard fork',
  other: 'Other reward',
};

/**
 * The kind of a reward written before `rewardKind` existed, from the two
 * signals the modules used to read: the Cardano provider record in `raw`
 * and the word "staking" in the note. Rows a source re-syncs get the typed
 * field; this keeps imported rows readable until they are re-imported.
 */
export const legacyRewardKind = (
  event: LedgerEvent,
): RewardKind | undefined => {
  const rawType = (event.raw as { type?: unknown } | undefined)?.type;
  if (rawType === 'leader') return 'leader';
  if (rawType === 'member') return 'staking';
  // A Cardano record of any other type (a pool deposit refund, a treasury
  // payout) is not a staking reward, and its note still says "staking
  // reward (...)": the record decides, and the note must not promote it.
  if (rawType !== undefined) return undefined;
  if (/staking/i.test(event.note ?? '')) return 'staking';
  return undefined;
};

export const rewardKindOf = (event: LedgerEvent): RewardKind | undefined =>
  event.rewardKind ?? legacyRewardKind(event);
