export const MAX_ADDRESSES = 50;

/**
 * Parses a newline-separated list of addresses, normalizing whitespace and deduping.
 *
 * Order is semantic: a transaction appearing under several configured addresses is owned by
 * the FIRST configured one, so reordering changes which address owns it. Dedupe preserves
 * the insertion order of first-seen addresses.
 */
export const parseAddressList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  const addresses = value
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Dedupe while preserving first-seen order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    if (!seen.has(address)) {
      seen.add(address);
      result.push(address);
    }
  }

  return result;
};

export const addressListProblem = (
  value: string | undefined,
): { index: number; reason: 'empty' | 'tooMany' } | null => {
  const parsed = parseAddressList(value);

  if (parsed.length === 0) {
    return { index: 0, reason: 'empty' };
  }

  if (parsed.length > MAX_ADDRESSES) {
    return { index: MAX_ADDRESSES, reason: 'tooMany' };
  }

  return null;
};
