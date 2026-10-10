import Big from 'big.js';
import type { RegisterRow, RegisterRowKind } from '@/tax/types';

/** The row kinds that carry an event leg's own value. */
const VALUED_KINDS = new Set<RegisterRowKind>([
  'acquisition',
  'disposal',
  'income',
]);

/**
 * The register value of an event's leg in an asset, in the base currency,
 * for the CARF comparison. Prefers an acquisition, disposal or income row
 * that has a value; among several (a swap whose fee is paid in the disposed
 * asset has a principal and a fee disposal), the one with the largest
 * amount, which is the principal. Falls back to any row with a value.
 */
export const registerValueLookup = (
  register: RegisterRow[],
): ((sourceEventId: string, assetId: string) => string | undefined) => {
  const preferred = new Map<string, RegisterRow>();
  const fallback = new Map<string, string>();
  for (const row of register) {
    if (row.value === undefined) continue;
    const key = `${row.sourceEventId}|${row.assetId}`;
    if (VALUED_KINDS.has(row.kind)) {
      const current = preferred.get(key);
      if (!current || new Big(row.amount).gt(current.amount)) {
        preferred.set(key, row);
      }
    } else if (!fallback.has(key)) {
      fallback.set(key, row.value);
    }
  }
  return (sourceEventId, assetId) => {
    const key = `${sourceEventId}|${assetId}`;
    return preferred.get(key)?.value ?? fallback.get(key);
  };
};
