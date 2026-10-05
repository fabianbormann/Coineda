import { openLedger } from '@/ledger/db';
import { fetchTokenMeta, subjectsOf, type TokenMeta } from './tokenRegistry';
import { parseCardanoAsset } from './cardanoAsset';

/**
 * Cached Cardano token metadata.
 *
 * Token metadata is close to immutable - a registry entry changes when its
 * owner submits a new signed record, which is rare - so this caches for a
 * long time and tolerates being a little stale. The cost of being wrong is
 * a slightly outdated logo; the cost of not caching is a 19KB-per-token
 * download on every page load.
 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * A miss is cached too, and for the same length of time.
 *
 * The registry omits an unknown subject from its answer rather than saying
 * "no", so a caller that records only hits cannot tell "never asked" from
 * "asked, not listed" - and would re-ask about every unlisted token, every
 * load, forever. Most native tokens in a real wallet are unlisted, so this
 * is the common case rather than the edge one.
 */
type Row = { subject: string; fetchedAt: number } & (
  { found: true; meta: TokenMeta } | { found: false }
);

const isFresh = (row: Row, now: number): boolean =>
  now - row.fetchedAt < TTL_MS;

export const readCached = async (
  subjects: string[],
  now: number = Date.now(),
): Promise<{ hits: Map<string, TokenMeta>; stale: string[] }> => {
  const db = await openLedger();
  const hits = new Map<string, TokenMeta>();
  const stale: string[] = [];

  for (const subject of subjects) {
    const row = (await db.get('tokenMeta', subject)) as Row | undefined;
    if (row === undefined || !isFresh(row, now)) {
      stale.push(subject);
      continue;
    }
    if (row.found) {
      hits.set(subject, row.meta);
    }
    // A fresh miss contributes nothing and is not re-requested.
  }

  return { hits, stale };
};

export const writeCached = async (
  subjects: string[],
  fetched: Map<string, TokenMeta>,
  now: number = Date.now(),
): Promise<void> => {
  const db = await openLedger();
  const tx = db.transaction('tokenMeta', 'readwrite');
  for (const subject of subjects) {
    const meta = fetched.get(subject);
    await tx.store.put(
      meta === undefined
        ? { subject, fetchedAt: now, found: false }
        : { subject, fetchedAt: now, found: true, meta },
    );
  }
  await tx.done;
};

/**
 * Metadata for the Cardano native assets among `assetIds`, keyed by ASSET
 * ID rather than by subject - callers hold asset ids, and making every one
 * of them re-derive the subject is how the two drift apart.
 *
 * Never throws. A registry that is unreachable, slow or broken degrades to
 * whatever is cached plus nothing, because the asset name is resolvable
 * offline from the subject anyway (see cardanoAsset.ts) and a decoration
 * must not be able to break a balance screen.
 */
export const resolveTokenMeta = async (
  assetIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, TokenMeta>> => {
  const byAssetId = new Map<string, TokenMeta>();
  const subjects = subjectsOf(assetIds);
  if (subjects.length === 0) {
    return byAssetId;
  }

  let hits = new Map<string, TokenMeta>();
  let stale: string[] = subjects;
  try {
    ({ hits, stale } = await readCached(subjects));
  } catch {
    // An unopenable cache is not a reason to skip the network.
  }

  if (stale.length > 0) {
    try {
      const fetched = await fetchTokenMeta(stale, signal);
      for (const [subject, meta] of fetched) {
        hits.set(subject, meta);
      }
      // Every stale subject is written, present in the answer or not, so a
      // miss becomes a recorded miss rather than a permanent re-request.
      await writeCached(stale, fetched);
    } catch {
      // Offline, aborted, rate-limited: keep what the cache had.
    }
  }

  for (const assetId of assetIds) {
    const parsed = parseCardanoAsset(assetId);
    const meta = parsed === null ? undefined : hits.get(parsed.subject);
    if (meta !== undefined) {
      byAssetId.set(assetId, meta);
    }
  }

  return byAssetId;
};
