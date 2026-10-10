/** The first twelve characters of a ledger fingerprint: enough to tell two
 *  ledgers apart on a printout, short enough to fit a page footer. */
export const shortFingerprint = (fingerprint: string): string =>
  fingerprint.slice(0, 12);
