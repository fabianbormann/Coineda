/**
 * What one Cardano provider supplies. Everything else about the Cardano
 * translation is identical for all of them - see
 * src/sources/cardano/translator.ts.
 *
 * Its own file so the modules that need only this type (tier.ts, http.ts,
 * account.ts) do not import the translator, which imports them.
 */
export type CardanoProvider = {
  /** Host only, no trailing slash - the API path is added here. */
  host: (config: Record<string, string>) => string;
  /** The provider's API root segment, e.g. '/api/v1' or '/api/v0'. */
  apiPath: string;
  /**
   * Request headers. Returns an empty object for a keyless provider, which
   * is why a Yaci-configured source still sends no credential at all.
   */
  headers: (config: Record<string, string>) => Record<string, string>;
  /**
   * A valid host for this provider, named in the "the base URL should be
   * the host only" complaint. Per provider because suggesting a Yaci Store
   * URL on a Blockfrost row - which is what a single hardcoded example
   * did - sends the user to fix their configuration with an address that
   * cannot work for the module they are configuring.
   */
  exampleHost: string;
  /**
   * Maps a non-ok HTTP status from `probe` to a translation key. Separate
   * per provider because a keyless one can never see a 403, and a
   * credential-bearing one must distinguish "your key was refused" from
   * "try again later" - collapsing those leaves the user guessing which.
   *
   * It receives only a status code, never the config, so a credential
   * cannot reach a message by this route.
   */
  probeMessage: (status: number) => string;
};
