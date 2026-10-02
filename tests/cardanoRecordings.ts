/**
 * The recorded Cardano responses, adapted to two routes the recordings
 * predate.
 *
 * Not a test file - the fixture-driven suites import it.
 *
 * Two things changed in the module after these fixtures were captured, and
 * neither can be re-recorded here: recording needs a Blockfrost mainnet
 * project id and a live Yaci instance, and this working copy has neither.
 * So the gap is declared in one place, in test code, rather than invented as
 * a new `fixtures/*.json` that would read as a recording of something nobody
 * observed.
 *
 * 1. **`/accounts/{stake}/rewards` is now paged.** It was requested bare,
 *    which truncated at the provider's default page size - measured, an
 *    account with at least 200 reward epochs answers the bare URL with 100
 *    rows and `?page=2&count=100` with another 100. The recorded bodies are
 *    the bare URL's, and they are SHORT (91 rows on Blockfrost, 10 on Yaci),
 *    so serving them as page 1 and an empty array as page 2 reproduces
 *    exactly what the live provider would answer for those accounts. Nothing
 *    is fabricated: a short page is a last page.
 *
 * 2. **`/accounts/{stake}/withdrawals` is new**, and no recording of it
 *    exists for either provider. It is served as an empty array, which is
 *    the one answer that asserts nothing about the row shape. The
 *    consequence is that no fixture-driven test here exercises a withdrawal;
 *    the withdrawal logic is covered by unit tests over synthetic rows
 *    instead (tests/cardanoRewardPot.test.ts), and the shape still needs a
 *    recording. Serving `[]` is also what keeps these suites honest about
 *    the recorded ACCOUNT: the three withdrawals the controller measured
 *    against it live, totalling 29,817.21 ADA, are not in this repository.
 */
export type Recorded = { url: string; status: number; body: unknown };

/** Mirrors ACCOUNT_HISTORY_PAGE_SIZE in src/sources/cardano/cursor.ts.
 *  Spelled out rather than imported so a change to the module's page size
 *  shows up as a failing fixture lookup instead of being silently absorbed
 *  by the shim. */
export const RECORDED_HISTORY_PAGE_SIZE = 100;

/**
 * Adds the paged-rewards and empty-withdrawals entries for every account the
 * recordings mention.
 *
 * Accounts are discovered from the recorded URLs themselves, so a fixture
 * set gains them without naming any address here.
 */
export const withAccountHistoryRoutes = (
  fixtures: Map<string, Recorded>,
): Map<string, Recorded> => {
  const next = new Map(fixtures);

  const accountRoots = new Set<string>();
  for (const url of fixtures.keys()) {
    const match = /^(.*\/accounts\/[^/?]+)\//.exec(url);
    if (match) {
      accountRoots.add(match[1]);
    }
  }

  for (const root of accountRoots) {
    const recordedRewards = fixtures.get(`${root}/rewards`);
    if (recordedRewards) {
      const page1 = `${root}/rewards?page=1&count=${RECORDED_HISTORY_PAGE_SIZE}`;
      next.set(page1, { ...recordedRewards, url: page1 });
      // The recorded body is short, so the live provider's next page is
      // empty. Registered explicitly rather than left to a stub's fallback,
      // because a stub that throws on an unrecorded URL is doing its job.
      const page2 = `${root}/rewards?page=2&count=${RECORDED_HISTORY_PAGE_SIZE}`;
      next.set(page2, { url: page2, status: 200, body: [] });
    }

    const withdrawals = `${root}/withdrawals?page=1&count=${RECORDED_HISTORY_PAGE_SIZE}`;
    if (!next.has(withdrawals)) {
      next.set(withdrawals, { url: withdrawals, status: 200, body: [] });
    }
  }

  return next;
};
