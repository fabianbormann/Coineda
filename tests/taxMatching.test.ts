import { describe, it, expect } from 'vitest';
import { match } from '@/tax/matching';
import type { TaxEvent } from '@/tax/types';

const event = (
  overrides: Partial<TaxEvent> & Pick<TaxEvent, 'kind' | 'amount' | 'value'>,
): TaxEvent => ({
  sourceEventId: overrides.sourceEventId ?? 'e1',
  assetId: 'cardano:lovelace',
  timestamp: 1_700_000_000_000,
  venue: 'wallet-a',
  ...overrides,
});

const byVenue = (e: TaxEvent) => e.venue;
const pooled = () => 'all';

const DAY = 86_400_000;

describe('fifo matching', () => {
  it('consumes the oldest lot first', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy-old',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 1000,
        }),
        event({
          sourceEventId: 'buy-new',
          kind: 'acquisition',
          amount: '10',
          value: '300',
          timestamp: 2000,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: 3000,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(1);
    expect(matched[0].consumed.map((lot) => lot.acquisitionEventId)).toEqual([
      'buy-old',
    ]);
    expect(matched[0].costBasis).toBe('100');
    expect(matched[0].gain).toBe('300');
  });

  it('splits a disposal across two lots and reports each separately', () => {
    // The holding period applies per consumed lot, so a disposal can be
    // partly exempt. Collapsing the lots into one would make that
    // impossible to compute and the error would look like a plausible
    // number.
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy-1',
          kind: 'acquisition',
          amount: '5',
          value: '50',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'buy-2',
          kind: 'acquisition',
          amount: '5',
          value: '150',
          timestamp: 400 * DAY,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: 500 * DAY,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched[0].consumed).toHaveLength(2);
    expect(matched[0].consumed[0]).toMatchObject({
      acquisitionEventId: 'buy-1',
      amount: '5',
      costBasis: '50',
      heldDays: 500,
    });
    expect(matched[0].consumed[1]).toMatchObject({
      acquisitionEventId: 'buy-2',
      amount: '5',
      costBasis: '150',
      heldDays: 100,
    });
    expect(matched[0].costBasis).toBe('200');
    expect(matched[0].gain).toBe('200');
  });

  it('takes part of a lot and leaves the remainder available', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell-1',
          kind: 'disposal',
          amount: '4',
          value: '80',
          timestamp: 1000,
        }),
        event({
          sourceEventId: 'sell-2',
          kind: 'disposal',
          amount: '6',
          value: '120',
          timestamp: 2000,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(2);
    expect(matched[0].costBasis).toBe('40');
    expect(matched[1].costBasis).toBe('60');
  });

  it("never matches a disposal against another partition's lots", () => {
    // REVIEW FOCUS 3. German FIFO is per wallet. A disposal at wallet-b
    // eating wallet-a's cheaper lot would understate the gain, and the
    // number it produced would look entirely reasonable.
    const { matched, shortfalls } = match(
      [
        event({
          sourceEventId: 'buy-a',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
          venue: 'wallet-a',
        }),
        event({
          sourceEventId: 'sell-b',
          kind: 'disposal',
          amount: '10',
          value: '500',
          timestamp: 1000,
          venue: 'wallet-b',
        }),
      ],
      'fifo',
      byVenue,
    );

    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0].sourceEventId).toBe('sell-b');
  });

  it('reports only the unmatched part as a shortfall', () => {
    const { matched, shortfalls } = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '3',
          value: '30',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '200',
          timestamp: 1000,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(1);
    expect(matched[0].amount).toBe('3');
    expect(shortfalls[0].amount).toBe('7');
  });

  it('keeps assets separate', () => {
    const { matched, shortfalls } = match(
      [
        event({
          sourceEventId: 'buy-ada',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell-btc',
          kind: 'disposal',
          amount: '1',
          value: '1000',
          timestamp: 1000,
          assetId: 'bitcoin:native',
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(1);
  });
});

describe('moving average matching', () => {
  it('uses the running average cost of the pool', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy-1',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'buy-2',
          kind: 'acquisition',
          amount: '10',
          value: '300',
          timestamp: 1000,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: 2000,
        }),
      ],
      'moving-average',
      pooled,
    );

    // 400 total cost over 20 units = 20 per unit; 10 units disposed = 200.
    expect(matched[0].costBasis).toBe('200');
    expect(matched[0].gain).toBe('200');
  });

  it('returns one synthetic lot, because an average has no lots', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '5',
          value: '100',
          timestamp: 1000,
        }),
      ],
      'moving-average',
      pooled,
    );

    expect(matched[0].consumed).toHaveLength(1);
    expect(matched[0].consumed[0].acquisitionEventId).toBe('pool');
  });

  it('pins rounding so a repeating decimal cannot drift', () => {
    // A running average divides, producing repeating decimals FIFO never
    // does. 100/3 is the canonical case. An unpinned rounding mode
    // compounds through every later disposal, so the mode is pinned at this
    // module's own boundary rather than inherited from a global default.
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '3',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '1',
          value: '50',
          timestamp: 1000,
        }),
      ],
      'moving-average',
      pooled,
    );

    expect(matched[0].costBasis).toBe('33.33333333333333333333');
    expect(matched[0].gain).toBe('16.66666666666666666667');
  });

  it('keeps the average after a partial disposal', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell-1',
          kind: 'disposal',
          amount: '5',
          value: '100',
          timestamp: 1000,
        }),
        event({
          sourceEventId: 'sell-2',
          kind: 'disposal',
          amount: '5',
          value: '100',
          timestamp: 2000,
        }),
      ],
      'moving-average',
      pooled,
    );

    expect(matched[0].costBasis).toBe('50');
    expect(matched[1].costBasis).toBe('50');
  });

  it('starts a fresh average after the pool empties', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'buy-1',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 0,
        }),
        event({
          sourceEventId: 'sell-1',
          kind: 'disposal',
          amount: '10',
          value: '200',
          timestamp: 1000,
        }),
        event({
          sourceEventId: 'buy-2',
          kind: 'acquisition',
          amount: '10',
          value: '500',
          timestamp: 2000,
        }),
        event({
          sourceEventId: 'sell-2',
          kind: 'disposal',
          amount: '10',
          value: '600',
          timestamp: 3000,
        }),
      ],
      'moving-average',
      pooled,
    );

    // The second disposal must cost 500, not an average that still
    // remembers the first, cheaper acquisition.
    expect(matched[1].costBasis).toBe('500');
  });
});

describe('matching, both methods', () => {
  it('processes events in date order regardless of input order', () => {
    const { matched } = match(
      [
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: 3000,
        }),
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: 1000,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(1);
    expect(matched[0].costBasis).toBe('100');
  });

  it('ignores income events, which are not disposals or lots', () => {
    const { matched, shortfalls } = match(
      [
        event({
          sourceEventId: 'reward',
          kind: 'income',
          amount: '10',
          value: '50',
          timestamp: 0,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(0);
  });

  it('treats an unvalued event as unmatchable rather than free', () => {
    // An acquisition with no value is not a zero-cost lot - that would
    // make the entire proceeds a gain. It is simply not a usable lot.
    //
    // The acquisition's timestamp must be earlier than the disposal's: the
    // default from the `event()` helper (1_700_000_000_000) is NOT early
    // enough on its own, because match() sorts by timestamp before
    // walking, and an acquisition that sorts after its disposal never
    // reaches the lot queue regardless of whether undefined values are
    // handled at all - which would make this test pass for the wrong
    // reason.
    const { matched, shortfalls } = match(
      [
        {
          ...event({
            kind: 'acquisition',
            amount: '10',
            value: '100',
            timestamp: 0,
          }),
          value: undefined,
          sourceEventId: 'buy',
        },
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: 1000,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(matched).toHaveLength(0);
    expect(shortfalls[0].sourceEventId).toBe('sell');
  });
});

describe('ordering at an identical timestamp', () => {
  it('matches an acquisition that shares the disposal’s timestamp, whatever order they arrive in', () => {
    // Both legs of one chain transaction carry event.timestamp, so a tie
    // is routine rather than exotic. Sorting on the timestamp alone leaves
    // the tie to sort stability, i.e. to INSERTION order - which came from
    // the order the Cardano translator builds its legs in. Handed the
    // disposal first, FIFO found no lot and reported "no acquisition on
    // record" for a disposal the user's balance plainly covered.
    const sameInstant = 1_700_000_000_000;
    const disposalFirst = match(
      [
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: sameInstant,
        }),
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: sameInstant,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(disposalFirst.shortfalls).toEqual([]);
    expect(disposalFirst.matched).toHaveLength(1);
    expect(disposalFirst.matched[0].costBasis).toBe('100');

    // And the other input order must produce the identical result: the
    // outcome is a property of the data, not of the call that assembled
    // it.
    const acquisitionFirst = match(
      [
        event({
          sourceEventId: 'buy',
          kind: 'acquisition',
          amount: '10',
          value: '100',
          timestamp: sameInstant,
        }),
        event({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10',
          value: '400',
          timestamp: sameInstant,
        }),
      ],
      'fifo',
      pooled,
    );

    expect(acquisitionFirst.matched).toEqual(disposalFirst.matched);
  });
});
