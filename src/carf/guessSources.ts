import type { SourceRecord } from '../ledger/types';
import { findModule } from '../sources/registry';
import { findFileModule } from '../sources/csv/registry';

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

/**
 * Source ids whose label or module name shares a word (3+ characters) with
 * the reporting provider's name. A proposal only; the user confirms.
 */
export const guessProviderSources = (
  rcaspName: string,
  sources: Pick<SourceRecord, 'id' | 'label' | 'moduleId'>[],
): string[] => {
  const reported = new Set(wordsOf(rcaspName));
  return sources
    .filter((s) =>
      [...wordsOf(s.label), ...wordsOf(s.moduleId.split('-')[0])].some((w) =>
        reported.has(w),
      ),
    )
    .map((s) => s.id);
};

/**
 * True for sources of an exchange or file module (what a CARF provider can
 * have reported on); false for chain modules and unknown module ids. Looks
 * the module up in both registries, so no field callback is needed.
 */
export const isProviderSource = (
  source: Pick<SourceRecord, 'moduleId'>,
): boolean => {
  const pull = findModule(source.moduleId);
  if (pull) return pull.manifest.kind === 'exchange';
  return findFileModule(source.moduleId) !== undefined;
};
