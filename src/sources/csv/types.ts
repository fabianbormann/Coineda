import type { DerivedEvent } from '@/sources/types';
import type { EventKind } from '@/ledger/types';

/**
 * A source that reads a file the user exports, rather than one it polls.
 *
 * Kraken, Binance and Coinbase all refuse a browser outright. Measured
 * against Kraken's own private endpoint: the CORS preflight answers 404 and
 * the response carries no `access-control-allow-origin`, so the request is
 * blocked before it is sent and the reply could not be read if it were. No
 * amount of module code changes that; the only ways in are a relay this app
 * deliberately does not have, or a file the user already owns.
 *
 * The shape deliberately mirrors `SourceModule`'s central promise - a PURE
 * translator, text in and normalised events out, touching no storage and
 * fetching nothing. That is what keeps these testable from a fixture and
 * safe to accept from a contributor, and it is why a file source is a
 * different type rather than a `SourceModule` with its network parts left
 * dangling.
 */
export type FileSourceManifest = {
  /** Stable, lowercase, hyphenated: 'kraken-csv'. */
  id: string;
  kind: 'file';
  /** Translation key. */
  label: string;
  /** Translation key for the sentence telling a user where to get the file. */
  help: string;
  /** Which kinds this importer can produce, so the UI can state coverage
   *  honestly rather than implying completeness. */
  emits: EventKind[];
  docsUrl: string;
};

/**
 * What one row became, or why it became nothing.
 *
 * `skipped` is a first-class result rather than a silent drop. An export
 * carries rows this app cannot represent - an asset it has no id for, a
 * row type no jurisdiction has rules for - and a user whose balance is
 * short needs to know which rows were left out and why. The same reason
 * ImportError exists on the pull side.
 */
export type ParseResult = {
  events: DerivedEvent[];
  /** One human-readable sentence per skipped row, already deduplicated by
   *  the parser where a reason repeats across hundreds of rows. */
  skipped: string[];
};

export type FileSourceModule = {
  manifest: FileSourceManifest;
  /**
   * Whether this text looks like this provider's export.
   *
   * Checked against the HEADER, never the filename: a user renames a
   * download, and a wrong parser that runs anyway produces garbage rather
   * than a refusal. Must be cheap and must not throw on arbitrary input -
   * it is run against every registered importer in turn.
   */
  sniff: (text: string) => boolean;
  /**
   * Pure: the file's text in, normalised events out.
   *
   * Throws only when the text is not this provider's format at all, and
   * then with a message naming the columns it actually found. A single
   * unreadable ROW is a `skipped` entry, not an exception - one bad line
   * must not cost the user every other line in the file.
   */
  parse: (text: string) => ParseResult;
};
