import krakenCsv from '@/sources/kraken-csv';
import type { FileSourceModule } from './types';

/**
 * File importers, shipped in the bundle and added by reviewed pull request
 * - the same rule the pull-source registry follows, and for the same
 * reason: module code runs beside the user's exchange credentials.
 */
export const fileRegistry: FileSourceModule[] = [krakenCsv];

export const findFileModule = (id: string): FileSourceModule | undefined =>
  fileRegistry.find((module) => module.manifest.id === id);

/**
 * The importer whose own header this text matches, or null.
 *
 * Matched on CONTENT, never on filename: a user renames a download, and an
 * importer that runs on the wrong file produces plausible-looking garbage
 * rather than a refusal. Returns null when none matches so the caller can
 * say which formats it does know, instead of failing vaguely.
 */
export const detectFileModule = (text: string): FileSourceModule | null =>
  fileRegistry.find((module) => module.sniff(text)) ?? null;
