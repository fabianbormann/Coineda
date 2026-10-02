import type { TaxManifest } from '@/tax/types';

/**
 * Builds the per-report disclaimer from a jurisdiction's manifest, so every
 * report names who wrote the rules, when they were last checked, and the
 * statutes they came from - a reader can verify instead of trusting a
 * number. Not legal or tax advice, and `noticeKey` says exactly that.
 */

/** Rules unchecked for longer than this are reported stale. Twelve months
 *  because tax law moves annually - the 600-to-1000 Freigrenze change is
 *  exactly the kind of thing a year-old rule set has missed. */
const STALE_AFTER_MONTHS = 12;

/** Translation key for the "community contribution, not advice" notice,
 *  keyed in both locale files. */
const COMMUNITY_CONTRIBUTION_NOTICE_KEY =
  'These tax rules are a community contribution, not advice from a lawyer or tax advisor. Verify them against the cited references before relying on them.';

export type Disclaimer = {
  jurisdiction: string;
  contributor: string;
  rulesCheckedOn: string;
  references: string[];
  monthsSinceChecked: number;
  stale: boolean;
  /** Translation key for the "community contribution, not advice" notice. */
  noticeKey: string;
};

/**
 * Whole calendar months between two UTC dates, following the same
 * "has the day-of-month been reached yet" rule a birthday-age calculation
 * uses: a date-only ISO string (`rulesCheckedOn`) parses as UTC midnight,
 * so both sides are compared on UTC calendar fields only - never through a
 * millisecond subtraction, which would drift against month-length
 * differences.
 */
const monthsBetweenUtc = (fromMs: number, toMs: number): number => {
  const from = new Date(fromMs);
  const to = new Date(toMs);

  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());

  if (to.getUTCDate() < from.getUTCDate()) {
    months -= 1;
  }

  return months;
};

export const buildDisclaimer = (
  manifest: TaxManifest,
  now: number,
): Disclaimer => {
  const monthsSinceChecked = monthsBetweenUtc(
    Date.parse(manifest.rulesCheckedOn),
    now,
  );

  return {
    jurisdiction: manifest.jurisdiction,
    contributor: manifest.contributor,
    rulesCheckedOn: manifest.rulesCheckedOn,
    references: manifest.references,
    monthsSinceChecked,
    stale: monthsSinceChecked > STALE_AFTER_MONTHS,
    noticeKey: COMMUNITY_CONTRIBUTION_NOTICE_KEY,
  };
};
