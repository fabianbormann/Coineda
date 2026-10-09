import type { DerivativeKind } from '@/ledger/types';

/** Translation keys, one per kind, printed on a derivative settlement row so
 *  a reader can tell a realised result from a funding payment or a fee. */
export const DERIVATIVE_KIND_LABELS: Record<DerivativeKind, string> = {
  pnl: 'Realised P&L',
  funding: 'Funding',
  rollover: 'Rollover fee',
  commission: 'Commission',
};
