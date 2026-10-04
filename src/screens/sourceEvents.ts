/**
 * The pure parts of the per-source event log, split out so they can be
 * tested without rendering a dialog.
 */

/** How many events one page of the log renders. A wallet with years of
 *  history is thousands of events, and mounting a card for each one makes
 *  opening the dialog visibly slow for no benefit - nobody reads past the
 *  first screen without scrolling. */
export const EVENT_PAGE = 50;

/**
 * A venue short enough to sit in a line of text.
 *
 * A venue is whatever the module put there: 'bitpanda' for an exchange, a
 * 108-character bech32 address for a chain. Trimming from the END only
 * would be worse than useless on an address, because every address derived
 * from one account shares its prefix - two different addresses would render
 * identically. Keeping both ends keeps them distinguishable, and the full
 * value stays in the title attribute.
 */
export const shortVenue = (venue: string, keep = 10): string =>
  venue.length <= keep * 2 + 1
    ? venue
    : `${venue.slice(0, keep)}…${venue.slice(-keep)}`;
