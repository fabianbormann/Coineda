import type { Cursor, EventKind, LedgerEvent } from '@/ledger/types';

export type ManifestField = {
  name: string;
  /** Translation key, not display text - see the i18n constraint. */
  label: string;
  type: 'address' | 'apiKey' | 'secret' | 'text';
  /** Translation key for the help line under the field. */
  help: string;
  /**
   * Absent or false means REQUIRED. Required is the default on purpose: a
   * credential field silently accepting a blank value would store an
   * unusable source, and a module author has to opt a field out of
   * validation deliberately rather than by forgetting a flag.
   *
   * Set it only when the module genuinely works with the field left empty -
   * typically because it substitutes its own default, as cardano-yaci's
   * `baseUrl` does. AddSourceDialog validates non-optional fields only, so
   * an optional field is stored exactly as the user left it: empty string,
   * whitespace, or absent from `config` entirely if never touched. A module
   * declaring `optional` must handle all three.
   */
  optional?: boolean;
};

export type SourceManifest = {
  /** Stable, lowercase, hyphenated: 'cardano-blockfrost'. */
  id: string;
  kind: 'chain' | 'exchange';
  label: string;
  fields: ManifestField[];
  /** Exchange key permissions the module needs, so onboarding can name the
   *  exact boxes to tick and nothing wider. */
  requiredScopes?: string[];
  /** True when the provider sends no browser CORS headers and requests must
   *  go through the signing relay. Declared from the start so the relay
   *  milestone does not reshape this interface. */
  needsRelay: boolean;
  /** Which kinds this source can produce, so the UI can state coverage
   *  honestly instead of implying completeness. */
  emits: EventKind[];
  docsUrl: string;
};

export type ProbeResult = {
  ok: boolean;
  /** Translation key when !ok. */
  message?: string;
  /**
   * Interpolation values for `message`, when its key carries placeholders.
   *
   * A message cannot always be a bare sentence: the host-shape complaint
   * has to name THIS provider's example host, and a per-provider English
   * sentence built by string concatenation is a sentence no locale file can
   * translate. These are rendered through t(message, messageParams).
   *
   * Same rule as `message`: nothing from `config` may go in here. An
   * example host is the module's own constant, not the user's input.
   */
  messageParams?: Record<string, string>;
  /** False when the credential has more than read access. Undefined when the
   *  provider gives no way to tell. */
  readOnly?: boolean;
};

/**
 * What a module returns. It supplies `externalId` - the stable id from its
 * own provider - but never `id` or `sourceId`: those identify the row and the
 * configured source, which only the host knows. A module that could stamp
 * sourceId could collide two of the user's wallets onto one identity and
 * corrupt dedupe, so the contract does not let it hold that value at all.
 */
export type DerivedEvent = Omit<LedgerEvent, 'id' | 'sourceId'>;

export type FetchPage = { events: DerivedEvent[]; cursor: Cursor };

/**
 * Passed to `probe` and `fetchEvents` so a sync can be stopped and so a
 * module can combine it with its own request deadline.
 *
 * A module MUST give every request a timeout of its own regardless of
 * whether a caller supplies this: a provider that accepts a connection and
 * never answers would otherwise wedge a sync permanently, writing no error
 * and never completing. That happened, from an ordinary pasted URL, which
 * is why it is stated in the contract rather than left to each author.
 */
export type ModuleSignal = AbortSignal | undefined;

/**
 * A pure translator: config plus cursor in, normalised events out.
 *
 * A module never touches storage, never writes, never fetches prices and never
 * learns the base currency. That constraint is what makes it testable from
 * recorded fixtures - and therefore safe to accept from a contributor or to
 * generate with a model.
 *
 * A module emits legs only for the account it was configured to watch -
 * never the counterparty side of a transaction. The host derives the set of
 * venues the user owns from the venues appearing in its own events, so a
 * module that reported both sides of a transfer would put a stranger's
 * venue into that set: `foldHoldings` would then count the counterparty's
 * received amount as the user's own holding, inflating the balance, and the
 * disposal classifier would see both legs at "owned" venues and treat every
 * outbound send as an internal transfer, hiding real disposals from the tax
 * input. Concretely: filter every provider response to entries belonging to
 * the configured address/account before building a leg from it.
 *
 * A module must never put anything from its `config` into an error message
 * or a `ProbeResult.message`. Whatever `probe` or `fetchEvents` rejects with
 * is stored verbatim as the source's `lastError` (see
 * src/sync/syncSource.ts) and rendered on screen by `SourceRow`, so an API
 * key, a secret or even an address interpolated into a diagnostic leaks it
 * somewhere the user never chose to put it. Name the request that failed
 * and the status it returned, never the credential it used:
 *
 *     // no
 *     throw new Error(`auth failed for key ${config.apiKey}`);
 *     // yes
 *     throw new Error(`myprovider: listing trades failed with status ${status}`);
 *
 * This is a contract rule, not something the host sanitises: there is no way
 * to recognise a secret inside an arbitrary string, so the module is the
 * only place it can be kept out.
 */
export type SourceModule = {
  manifest: SourceManifest;
  probe(
    config: Record<string, string>,
    signal?: ModuleSignal,
  ): Promise<ProbeResult>;
  fetchEvents(
    config: Record<string, string>,
    cursor: Cursor,
    signal?: ModuleSignal,
  ): Promise<FetchPage>;
};
