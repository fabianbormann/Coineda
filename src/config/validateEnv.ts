import type { Endpoints } from './endpoints';

/**
 * Build-time validation of the egress environment, run by vite.config.ts.
 *
 * At runtime the app is forgiving on purpose: only the exact `restricted`
 * pins the mode, and a malformed VITE_ENDPOINTS warns in the console and
 * falls back to the public set, so a bad value never breaks the app at
 * boot. That forgiveness is wrong for an operator's build: `Restricted`,
 * `restricted;` or a JSON typo would ship a PUBLIC build without a word.
 * So the build refuses them instead, before a single file is written.
 *
 * Kept free of `import.meta.env` and of runtime imports (the `Endpoints`
 * import is type-only) so the Vite config can load it in Node.
 */

/** Every `Endpoints` key; the type below fails to compile if one is added
 *  to `Endpoints` and not here. */
const KEYS = [
  'priceHistory',
  'spotPrices',
  'fx',
  'tokenRegistry',
  'bitcoinEsplora',
  'ethereumBlockscout',
  'cardanoYaci',
  'cardanoBlockfrost',
  'bitpanda',
] as const satisfies readonly (keyof Endpoints)[];

type MissingKey = Exclude<keyof Endpoints, (typeof KEYS)[number]>;
// A compile-time exhaustiveness check: `never` only while KEYS is complete.
const exhaustive: [MissingKey] extends [never] ? true : MissingKey = true;
void exhaustive;

const KNOWN = new Set<string>(KEYS);

const isHttpsUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
};

export type EgressEnv = {
  VITE_EGRESS?: string;
  VITE_ENDPOINTS?: string;
};

/**
 * Throws a descriptive error unless `VITE_EGRESS` is unset, empty,
 * `public` or `restricted` (surrounding whitespace allowed, as at runtime;
 * case variants refused), and `VITE_ENDPOINTS` is unset, empty, or a JSON
 * object whose keys are all `Endpoints` keys and whose values are all
 * `https://` URLs.
 */
export const validateEgressEnv = (env: EgressEnv): void => {
  const egress = (env.VITE_EGRESS ?? '').trim();
  if (egress !== '' && egress !== 'public' && egress !== 'restricted') {
    throw new Error(
      `VITE_EGRESS=${JSON.stringify(env.VITE_EGRESS)} is not valid: use 'public', 'restricted' or leave it unset. ` +
        'Any other value would silently produce a public build.',
    );
  }

  const raw = env.VITE_ENDPOINTS ?? '';
  if (raw.trim() === '') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `VITE_ENDPOINTS is not valid JSON (${(error as Error).message}). ` +
        'It must be a JSON object keyed by endpoint name, see docs/operations/self-hosting.md.',
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'VITE_ENDPOINTS must be a JSON object keyed by endpoint name, see docs/operations/self-hosting.md.',
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN.has(key)) {
      throw new Error(
        `VITE_ENDPOINTS has an unknown key "${key}". Known keys: ${KEYS.join(', ')}.`,
      );
    }
    if (!isHttpsUrl(value)) {
      throw new Error(
        `VITE_ENDPOINTS.${key} must be an https:// URL, got ${JSON.stringify(value)}.`,
      );
    }
  }
};
