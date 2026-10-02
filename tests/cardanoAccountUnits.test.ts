import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchAddressSet,
  lastTxHashOf,
  legsForAccount,
  uniqueTransactions,
  type AccountRow,
} from '@/sources/cardano/account';
import { ADDRESS_PAGE_SIZE } from '@/sources/cardano/cursor';
import type { UtxoEntry } from '@/sources/cardano/utxo';

const ROOT = 'https://provider.example.org/api/v0';
const ACCOUNT = 'stake1_account_fixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

const row = (hash: string): AccountRow => ({
  tx_hash: hash,
  block_time: 1_667_587_468,
});

describe('uniqueTransactions', () => {
  it('collapses the adjacent rows one transaction occupies', () => {
    // The account listing returns one row per (address, transaction) pair,
    // so a transaction involving three of the account's addresses arrives
    // as three adjacent rows. Emitting each would produce a duplicate
    // externalId, which conformance.ts rejects outright - and qualifying
    // the id by address instead would make each event carry the account's
    // FULL movement, inflating the balance threefold.
    const rows = [row('a'), row('b'), row('b'), row('b'), row('c')];
    expect(uniqueTransactions(rows, '').map((r) => r.tx_hash)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('suppresses a transaction already emitted from the previous page', () => {
    // The straddle case. Rows of one transaction share block_time and
    // tx_index, and tx_index is unique within a block, so they are
    // necessarily adjacent in an ordered listing - which means a
    // transaction split across a page boundary has its first rows at the
    // end of one page and its last at the start of the next. The carried
    // hash is how the second page knows.
    const rows = [row('b'), row('b'), row('c')];
    expect(uniqueTransactions(rows, 'b').map((r) => r.tx_hash)).toEqual(['c']);
  });

  it('does not suppress a later recurrence of a non-adjacent hash', () => {
    // Only the immediately preceding hash is suppressed. A listing that
    // somehow returned the same transaction again later is a different
    // problem, and silently dropping it would hide it.
    const rows = [row('b'), row('c'), row('b')];
    expect(uniqueTransactions(rows, '').map((r) => r.tx_hash)).toEqual([
      'b',
      'c',
      'b',
    ]);
  });

  it('handles an empty page', () => {
    expect(uniqueTransactions([], 'b')).toEqual([]);
  });
});

describe('lastTxHashOf', () => {
  it('reports the final row’s hash, so the next page can suppress it', () => {
    expect(lastTxHashOf([row('a'), row('b')], '')).toBe('b');
  });

  it('keeps the carried hash when a page is empty', () => {
    // Otherwise an empty page would clear the suppression and a straddling
    // transaction could be emitted twice.
    expect(lastTxHashOf([], 'b')).toBe('b');
  });
});

describe('legsForAccount', () => {
  const entry = (address: string, quantity: string): UtxoEntry => ({
    address,
    amount: [{ unit: 'lovelace', quantity }],
  });

  it('keeps the account’s own entries and drops the counterparty’s', () => {
    // The module contract: emit legs only for the account configured,
    // never the counterparty. A stranger's venue in the ledger would make
    // foldHoldings count their money as the user's AND make every outbound
    // send look like an internal transfer, hiding real disposals.
    const legs = legsForAccount(
      [entry('mine-1', '100'), entry('theirs', '900'), entry('mine-2', '5')],
      'out',
      new Set(['mine-1', 'mine-2']),
      ACCOUNT,
    );
    expect(legs.map((leg) => leg.amount)).toEqual(['100', '5']);
  });

  it('reports every leg under the account, so inter-address movement nets to zero', () => {
    const legs = legsForAccount(
      [entry('mine-1', '100'), entry('mine-2', '5')],
      'in',
      new Set(['mine-1', 'mine-2']),
      ACCOUNT,
    );
    expect(new Set(legs.map((leg) => leg.venue))).toEqual(new Set([ACCOUNT]));
  });

  it('does not read stake_address, which Blockfrost never sends', () => {
    // Spec P3. Blockfrost's utxo entries carry no stake_address at all, so
    // a filter that reads it matches nothing there - which is why the
    // Blockfrost module has silently had no account view since it shipped.
    const legs = legsForAccount(
      [entry('mine-1', '100')],
      'out',
      new Set(['mine-1']),
      ACCOUNT,
    );
    expect(legs).toHaveLength(1);
  });

  it('chain-qualifies asset ids and passes quantities through as strings', () => {
    const legs = legsForAccount(
      [
        {
          address: 'mine-1',
          amount: [
            { unit: 'lovelace', quantity: '100' },
            { unit: 'abc123', quantity: '7' },
          ],
        },
      ],
      'in',
      new Set(['mine-1']),
      ACCOUNT,
    );
    expect(legs.map((leg) => leg.assetId)).toEqual([
      'cardano:lovelace',
      'cardano:abc123',
    ]);
    expect(legs.map((leg) => leg.amount)).toEqual(['100', '7']);
  });

  it('ignores a collateral entry, which a successful script never spends', async () => {
    // Collateral is pledged as a guarantee and returned. Counting it as a
    // spend made a real wallet report -727 ADA against a true +25 ADA.
    const legs = legsForAccount(
      [
        { address: 'mine-1', amount: [{ unit: 'lovelace', quantity: '100' }] },
        {
          address: 'mine-1',
          collateral: true,
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      ],
      'out',
      new Set(['mine-1']),
      ACCOUNT,
    );
    expect(legs.map((leg) => leg.amount)).toEqual(['100']);
  });

  it('ignores a reference input, which a script reads and never consumes', async () => {
    // The collateral bug's untouched sibling, and the same symptom: a
    // reference input is POINTED AT so a script can see its datum, and it
    // survives the transaction. Counting it as a spend is a phantom
    // disposal and a negative balance. Reachable whenever a dApp references
    // one of this wallet's own utxos; all 30 recorded Blockfrost input
    // entries carry `reference: false`, so the field is live and simply
    // never true in that recording.
    const legs = legsForAccount(
      [
        { address: 'mine-1', amount: [{ unit: 'lovelace', quantity: '100' }] },
        {
          address: 'mine-1',
          reference: true,
          amount: [{ unit: 'lovelace', quantity: '7000000' }],
        },
      ],
      'out',
      new Set(['mine-1']),
      ACCOUNT,
    );
    expect(legs.map((leg) => leg.amount)).toEqual(['100']);
  });

  it('yields nothing when the account owns no entry in the transaction', () => {
    // Review Focus 4. The account listing can return a row for a
    // transaction the account only appears in as a collateral or reference
    // input, whose utxos then contain none of its addresses. Zero legs is
    // the correct answer; the caller must skip such an event, because
    // conformance.ts rejects an event with no legs.
    expect(
      legsForAccount(
        [entry('theirs', '900')],
        'out',
        new Set(['mine']),
        ACCOUNT,
      ),
    ).toEqual([]);
  });
});

describe('fetchAddressSet', () => {
  const stubPages = (pages: { address: string }[][]) => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        const match = /page=(\d+)/.exec(String(url));
        const page = Number(match?.[1] ?? '1');
        return new Response(JSON.stringify(pages[page - 1] ?? []), {
          status: 200,
        });
      }),
    );
    return seen;
  };

  it('returns every address of a small account in one request', async () => {
    const seen = stubPages([[{ address: 'a' }, { address: 'b' }]]);
    await expect(fetchAddressSet(ROOT, {}, ACCOUNT)).resolves.toEqual(
      new Set(['a', 'b']),
    );
    expect(seen).toHaveLength(1);
  });

  it('follows paging past the first full page', async () => {
    // Review Focus 2. Two of the public accounts measured for the spec have
    // exactly 100 addresses on page 1. Stopping there would silently drop
    // every address beyond it, and a dropped address is a wrong amount -
    // not an error anyone would see.
    const first = Array.from({ length: ADDRESS_PAGE_SIZE }, (_, i) => ({
      address: `a${i}`,
    }));
    const seen = stubPages([first, [{ address: 'tail' }]]);
    const addresses = await fetchAddressSet(ROOT, {}, ACCOUNT);
    expect(addresses.size).toBe(ADDRESS_PAGE_SIZE + 1);
    expect(addresses.has('tail')).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('page=2');
  });

  it('stops on a short page without asking for another', async () => {
    const seen = stubPages([[{ address: 'a' }]]);
    await fetchAddressSet(ROOT, {}, ACCOUNT);
    expect(seen).toHaveLength(1);
  });

  it('fails loudly rather than loop when a provider pages forever', async () => {
    const full = Array.from({ length: ADDRESS_PAGE_SIZE }, (_, i) => ({
      address: `a${i}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(full), { status: 200 })),
    );
    await expect(fetchAddressSet(ROOT, {}, ACCOUNT)).rejects.toThrow(
      /more than/,
    );
  });

  it('names no address in that failure', async () => {
    // Captured rather than written as `.rejects.not.toThrow(...)`: that
    // chain does not assert the promise rejected at all, so it would pass
    // if fetchAddressSet ever started RESOLVING - a test that cannot fail
    // for the reason it claims to check. The module contract forbids
    // putting config into an error message, so the assertion needs a real
    // captured value to be true or false about.
    const full = Array.from({ length: ADDRESS_PAGE_SIZE }, (_, i) => ({
      address: `a${i}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(full), { status: 200 })),
    );

    const captured = await fetchAddressSet(ROOT, {}, ACCOUNT).then(
      () => null,
      (error: unknown) => error,
    );
    expect(captured).toBeInstanceOf(Error);
    expect(String(captured)).toContain('more than');
    expect(String(captured)).not.toContain(ACCOUNT);
  });
});
