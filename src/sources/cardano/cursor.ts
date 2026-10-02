/**
 * The cursor format, and the page sizes a cursor encodes a position into.
 *
 * `Cursor` is opaque to the host (see src/ledger/types.ts): only the module
 * that issued one may interpret it. That is what lets one module run two
 * different listing sequences - the account-level one and the
 * single-address one - and still resume either of them correctly.
 *
 * The tier is part of the cursor because a page number means a different
 * position in a different sequence. A drain decides its tier once, on page
 * 1, and every later page reads it back from here rather than paying for
 * the decision again.
 */

/** Comfortably under both providers' documented maximum of 100 per page. */
export const PAGE_SIZE = 20;

/** The account-addresses route pages like everything else; 100 is both
 *  providers' documented maximum, and the fewest requests per drain. */
export const ADDRESS_PAGE_SIZE = 100;

/** 1,000 addresses is far beyond any real wallet. A bound is here so a
 *  provider that pages forever fails loudly instead of looping. */
export const MAX_ADDRESS_PAGES = 10;

/**
 * The page size for the account-level history routes - `/rewards` and
 * `/withdrawals`.
 *
 * 100 is both providers' documented maximum, and the fewest requests per
 * drain. These routes were requested WITHOUT paging until now, which
 * silently truncated at whatever the provider's default page size is:
 * measured, an account with at least 200 reward epochs answers the bare
 * `/accounts/{stake}/rewards` with 100 rows and `?page=2&count=100` with
 * another 100. A wallet staking beyond ~100 epochs lost the rest, and the
 * lost ones are the most recent - the years a tax report covers.
 */
export const ACCOUNT_HISTORY_PAGE_SIZE = 100;

/**
 * 2,000 rows is about 27 years of Cardano epochs, so far beyond any real
 * account. The bound exists for the same reason MAX_ADDRESS_PAGES does: a
 * provider that pages without end must fail loudly rather than burn the
 * request budget silently.
 */
export const MAX_ACCOUNT_HISTORY_PAGES = 20;

export type CardanoCursor =
  | { tier: 'address'; page: number }
  | {
      tier: 'account';
      page: number;
      /**
       * The last transaction hash of the previous page.
       *
       * The account listing returns one row per (address, transaction)
       * pair, so one transaction can occupy several adjacent rows - and
       * those rows can straddle a page boundary. Carrying the hash here is
       * what lets the next page suppress the repeat: a drain resumes from a
       * persisted cursor after a stop or a failed page, so any in-memory
       * "already seen" set is gone exactly when it would be needed.
       */
      lastTxHash: string;
      /** Resolved once on page 1 and carried, so later pages need neither
       *  the address lookup nor the tier check again. */
      account: string;
    };

/** A page number as the providers define it: 1-based. Blockfrost's account
 *  route rejects page=0 with 400 outright; its address route aliases 0 onto
 *  1. Neither is worth depending on, so 0 is simply not a page. */
const pageNumber = (text: string): number | null => {
  if (!/^[1-9]\d*$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
};

export const encodeAddressCursor = (page: number): string => `addr:${page}`;

export const encodeAccountCursor = (
  page: number,
  lastTxHash: string,
  account: string,
): string => `acct:${page}:${lastTxHash}:${account}`;

export const decodeCursor = (cursor: string | null): CardanoCursor | null => {
  if (cursor === null) {
    return null;
  }

  // A bare number is a cursor this module wrote BEFORE tiers existed.
  // Reading it as an address-tier page is what stops a source that was
  // mid-sync at upgrade time from re-draining its whole history.
  const legacy = pageNumber(cursor);
  if (legacy !== null) {
    return { tier: 'address', page: legacy };
  }

  if (cursor.startsWith('addr:')) {
    const page = pageNumber(cursor.slice('addr:'.length));
    return page === null ? null : { tier: 'address', page };
  }

  if (cursor.startsWith('acct:')) {
    // acct:<page>:<lastTxHash>:<account> - split on the first two colons
    // only, so whatever the account contains survives intact rather than
    // being truncated by a split that assumes it is colon-free.
    const rest = cursor.slice('acct:'.length);
    const firstColon = rest.indexOf(':');
    const secondColon = rest.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) {
      return null;
    }
    const page = pageNumber(rest.slice(0, firstColon));
    const lastTxHash = rest.slice(firstColon + 1, secondColon);
    const account = rest.slice(secondColon + 1);
    if (page === null || account === '') {
      return null;
    }
    return { tier: 'account', page, lastTxHash, account };
  }

  // Unrecognised: start over rather than guess.
  return null;
};
