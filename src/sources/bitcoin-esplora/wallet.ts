import type { AccountKey } from './xpub';
import { addressFor, type SupportedScriptType } from './script';

/** BIP44's gap limit, and what Ledger Live itself uses: a chain is finished
 *  after this many consecutive addresses with no history. */
export const GAP_LIMIT = 20;

/**
 * How far down each chain this module will ever look.
 *
 * This is a coverage limit, stated rather than discovered: an address beyond
 * it is invisible to the scan AND excluded from the leg set. 200 per chain
 * is far past where a gap of 20 would have stopped any ordinary wallet, and
 * it costs about 130ms to derive all 400 addresses once (measured), which is
 * why it can be a fixed bound instead of a growing one.
 *
 * Fixed is the point. The leg set for a transaction has to be the SAME
 * whenever it is encountered, because `runConformance` drains twice and
 * compares a content fingerprint per externalId - so a window that grew with
 * the scan position would make the second drain disagree with the first and
 * the module would look non-idempotent for the harness's reason rather than
 * its own.
 */
export const MAX_DERIVED_INDEX = 200;

export type Wallet = {
  /**
   * Every address this source covers, in ownership order: receive chain,
   * then change chain, then the listed addresses as the user typed them.
   *
   * The order is what makes "the first of these appearing in a transaction
   * owns it" a total rule rather than a partial one, so a transaction
   * touching several of the wallet's addresses is emitted exactly once, by
   * whichever address the scan reaches first.
   */
  ordered: string[];
  /** Where an address sits in `ordered`, or undefined when it is not ours. */
  rankOf: (address: string) => number | undefined;
  /** The derived address at a position, or null beyond the cap. */
  derivedAt: (chain: 0 | 1, index: number) => string | null;
  listed: string[];
};

/**
 * Cached because a sync calls `fetchEvents` once per page and every page
 * needs the same set.
 *
 * Safe to cache: an address is a pure function of (key, script type, index),
 * so this is a memo rather than state, and it holds nothing about where a
 * drain has got to. Keyed by the script type plus the first derived address,
 * which identifies the account without storing the key itself.
 */
const cache = new Map<string, Wallet>();

const EMPTY: Wallet = {
  ordered: [],
  rankOf: () => undefined,
  derivedAt: () => null,
  listed: [],
};

export const buildWallet = (
  key: AccountKey | null,
  scriptType: SupportedScriptType | null,
  listed: string[],
): Wallet => {
  if (key === null || scriptType === null) {
    // No xpub, or an xpub whose type could not be detected because the
    // wallet is empty. Either way the listed addresses are the whole
    // coverage, and a source configured only by address is this case - the
    // same drain with its derived stages empty, not a second code path.
    if (listed.length === 0) {
      return EMPTY;
    }
    const ordered = [...new Set(listed)];
    const ranks = new Map(ordered.map((a, i) => [a, i]));
    return {
      ordered,
      rankOf: (address) => ranks.get(address),
      derivedAt: () => null,
      listed: ordered,
    };
  }

  const first = addressFor(scriptType, key.publicKeyAt(0, 0), key.network);
  const cacheKey = `${scriptType}:${first}:${listed.join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    return hit;
  }

  const derived: string[][] = [[], []];
  for (const chain of [0, 1] as const) {
    for (let index = 0; index < MAX_DERIVED_INDEX; index += 1) {
      derived[chain].push(
        addressFor(scriptType, key.publicKeyAt(chain, index), key.network),
      );
    }
  }

  // Deduplicated across the whole set. A listed address that the xpub also
  // derives must contribute ONE leg, not two: the same output counted twice
  // inflates the balance, and someone pasting an address they already cover
  // is an ordinary thing to do.
  // A listed address the key already derives is dropped from the LISTED set,
  // not merely from the order. Leaving it in both would have stage 2 scan an
  // address stage 0 already scanned, and the transaction would be emitted
  // twice - once under each stage, since the address is its own owner in
  // both. Deduping `ordered` alone is not enough, which a test caught.
  const derivedSet = new Set([...derived[0], ...derived[1]]);
  const extraListed = [...new Set(listed)].filter(
    (address) => !derivedSet.has(address),
  );
  const ordered = [...derived[0], ...derived[1], ...extraListed];
  const ranks = new Map(ordered.map((a, i) => [a, i]));

  const wallet: Wallet = {
    ordered,
    rankOf: (address) => ranks.get(address),
    derivedAt: (chain, index) =>
      index < MAX_DERIVED_INDEX ? derived[chain][index] : null,
    listed: extraListed,
  };
  cache.set(cacheKey, wallet);
  return wallet;
};

/** Test seam: the memo would otherwise leak a wallet between test cases that
 *  configure the same key with different listed addresses. */
export const clearWalletCache = (): void => cache.clear();
