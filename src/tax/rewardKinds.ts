import type { RewardKind } from '@/ledger/types';

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
