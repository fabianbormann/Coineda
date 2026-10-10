/**
 * What a report line says when it is the coins a transfer between the
 * user's own venues consumed (see residualTransferEvents). Without it the
 * printed report shows an unexplained few satoshi leaving an exchange, and
 * a reader cannot tie the method sheet's count to any line. Exported, like
 * HOST_REASON_KEYS, so the conformance gate can check it is keyed in every
 * locale.
 */
export const RESIDUAL_ORIGIN_KEY =
  'Network fee on a transfer between your own wallets, disposed of at market value and not deducted.';

/**
 * What a report line says when it is coins paid to somebody else in a
 * transaction that also moved coins between the user's own venues (the
 * `:residual-paid-out` events of residualTransferEvents). A payment, not a
 * fee, so it must not be labelled or counted as one.
 */
export const PAID_ORIGIN_KEY =
  'Sent to someone else in a transaction that also moved coins between your own wallets.';

export const FEE_RESIDUAL_SUFFIX = ':residual-out';
export const PAID_RESIDUAL_SUFFIX = ':residual-paid-out';

/** The label a synthetic transfer-residual event carries, by its id. */
export const residualOriginKey = (id: string): string | undefined =>
  id.endsWith(FEE_RESIDUAL_SUFFIX)
    ? RESIDUAL_ORIGIN_KEY
    : id.endsWith(PAID_RESIDUAL_SUFFIX)
      ? PAID_ORIGIN_KEY
      : undefined;

/** The `origin.key` a hard fork's zero-cost acquisition carries. */
export const FORK_ORIGIN_KEY = 'fork-at-zero';

/** The English label for a fork lot. The CODE above is what travels; this is
 *  what a file or the page prints, the page through t(). */
export const FORK_ORIGIN_LABEL = 'Hard fork — acquired at 0 (BMF 06.03.2025)';

/** The label for a lot-origin code; anything else is returned as it came. */
export const lotOriginLabel = (key: string): string =>
  key === FORK_ORIGIN_KEY ? FORK_ORIGIN_LABEL : key;
