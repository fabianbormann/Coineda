import type { LedgerEvent } from '@/ledger/types';

/** A minimal valid ledger event; override any field. */
export const ledgerEvent = (
  overrides: Partial<LedgerEvent> = {},
): LedgerEvent => ({
  id: 'e1',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '10',
      direction: 'in',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
  ...overrides,
});
