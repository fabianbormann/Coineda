import { subjectOf } from './cardanoAsset';

/**
 * The Cardano Token Metadata Registry (CIP-26), at tokens.cardano.org.
 *
 * Measured on 2026-10-05, because two of these facts decide the design:
 *
 * - **A browser may call it.** Both the single GET and the bulk POST answer
 *   `access-control-allow-origin: *`, and the POST preflight allows
 *   `content-type`. So this needs no relay, which is the only reason a
 *   local-first app can use it at all.
 * - **The logo is a base64 PNG, never an SVG.** CIP-26 specifies PNG and
 *   the registry serves it: NIGHT's logo arrives as 25,100 base64
 *   characters whose decoded bytes begin `89 50 4E 47`. There is no SVG to
 *   be had here, so the vector icons in src/components/money/icons are
 *   bundled for the chains Coineda knows and a registry logo is a raster
 *   image by necessity.
 * - **The two routes wrap their values differently.** A single
 *   `GET /metadata/<subject>` returns each property as
 *   `{ value, signatures }`; the bulk `POST /metadata/query` returns the
 *   value directly. `valueOf` below reads either, because a parser written
 *   against only the shape I happened to test first is exactly how this
 *   module's Bitpanda sibling shipped a call that could never have worked.
 * - **An unknown subject is simply absent** from the response rather than
 *   present-and-empty. That makes "not in the registry" indistinguishable
 *   from "not asked about" unless the caller records it, which is why
 *   resolveTokenMeta caches misses as well as hits.
 */
const REGISTRY_ROOT = 'https://tokens.cardano.org/metadata';

/** The registry answers a bulk query happily, but a request is still a
 *  request: a wallet with hundreds of native tokens is chunked rather than
 *  sent as one enormous body. */
export const QUERY_CHUNK = 50;

const TIMEOUT_MS = 10_000;

export type TokenMeta = {
  subject: string;
  name: string | null;
  ticker: string | null;
  /**
   * The registry's own decimals, kept for DISPLAY and comparison only.
   *
   * Never used to scale a stored amount. Scaling lives in
   * src/prices/scale.ts and is hardcoded on purpose: if the scale of an
   * amount depended on a network fetch, the same holding would mean
   * different quantities depending on whether a request succeeded, and
   * nothing downstream could tell. The registry agreeing with
   * ASSET_DECIMALS is a thing to assert in a test, not to trust at runtime.
   */
  decimals: number | null;
  /** Base64 PNG, exactly as the registry serves it. Never SVG - see above. */
  logoPng: string | null;
};

/** Reads a property that may or may not be wrapped in a signature envelope. */
const valueOf = (property: unknown): unknown => {
  if (
    property !== null &&
    typeof property === 'object' &&
    'value' in property
  ) {
    return (property as { value: unknown }).value;
  }
  return property;
};

const asString = (property: unknown): string | null => {
  const value = valueOf(property);
  return typeof value === 'string' && value !== '' ? value : null;
};

const asNumber = (property: unknown): number | null => {
  const value = valueOf(property);
  // Integer-checked rather than truthy-checked: HOSKY's decimals are 0,
  // which is a real answer and must not read as "absent".
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

type RegistryRow = Record<string, unknown> & { subject?: unknown };

const rowToMeta = (row: RegistryRow): TokenMeta | null => {
  const subject = typeof row.subject === 'string' ? row.subject : null;
  if (subject === null) {
    return null;
  }
  return {
    subject: subject.toLowerCase(),
    name: asString(row.name),
    ticker: asString(row.ticker),
    decimals: asNumber(row.decimals),
    logoPng: asString(row.logo),
  };
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

/**
 * Looks up metadata for the given subjects.
 *
 * Returns only what the registry actually knows: a subject it does not list
 * is absent from the result, never present with empty fields, so a caller
 * can tell "unlisted" from "listed with no ticker".
 *
 * Throws only on a transport failure. A non-2xx response resolves to an
 * empty map for that chunk instead, because an unavailable registry must
 * degrade to "no decoration" rather than break a balance screen - the
 * asset name is still resolvable offline from the subject itself.
 */
export const fetchTokenMeta = async (
  subjects: string[],
  signal?: AbortSignal,
): Promise<Map<string, TokenMeta>> => {
  const result = new Map<string, TokenMeta>();
  const wanted = [...new Set(subjects.map((s) => s.toLowerCase()))];
  if (wanted.length === 0) {
    return result;
  }

  for (const group of chunk(wanted, QUERY_CHUNK)) {
    const response = await fetch(`${REGISTRY_ROOT}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjects: group,
        properties: ['name', 'ticker', 'decimals', 'logo'],
      }),
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      continue;
    }

    let body: { subjects?: unknown };
    try {
      body = (await response.json()) as { subjects?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(body.subjects)) {
      continue;
    }

    for (const row of body.subjects as RegistryRow[]) {
      const meta = rowToMeta(row);
      if (meta !== null) {
        result.set(meta.subject, meta);
      }
    }
  }

  return result;
};

/** The subjects worth asking about, from a list of ledger asset ids. */
export const subjectsOf = (assetIds: string[]): string[] => {
  const subjects = new Set<string>();
  for (const assetId of assetIds) {
    const subject = subjectOf(assetId);
    if (subject !== null) {
      subjects.add(subject);
    }
  }
  return [...subjects];
};
