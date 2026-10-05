import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { linkInternalTransfers, linkedEventIds } from '@/ledger/transfers';
import { match } from '@/tax/matching';
import { ownedVenuesOf } from '@/ledger/balances';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent } from '@/ledger/types';
import type { LotMove, TaxEvent } from '@/tax/types';

/**
 * Transfers between a person's own venues, across sources.
 *
 * Withdrawing from an exchange to your own wallet sells nothing. Apart,
 * the two events read as a disposal and an acquisition from nowhere - and
 * on a German report that is a taxable gain the person never made.
 */
const BTC = 'bitcoin:native';
const HASH = '9f3c'.repeat(16);

const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e',
  sourceId: 's',
  externalId: 'x',
  timestamp: Date.UTC(2024, 5, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [],
  ...overrides,
});

const leg = (
  direction: 'in' | 'out',
  venue: string,
  amount = '50000000',
  role: 'principal' | 'fee' = 'principal',
) => ({ assetId: BTC, amount, direction, venue, role });

/** The real pair: an exchange sends, a wallet receives, one chain tx. */
const withdrawal = event({
  id: 'exchange-out',
  sourceId: 'bitpanda',
  txHash: HASH,
  legs: [leg('out', 'bitpanda'), leg('out', 'bitpanda', '5000', 'fee')],
});
const arrival = event({
  id: 'wallet-in',
  sourceId: 'bitcoin',
  txHash: HASH,
  timestamp: Date.UTC(2024, 5, 1, 1),
  legs: [leg('in', 'bc1qwallet', '49995000')],
});

describe('recognising the pair', () => {
  const owned = () => ownedVenuesOf([withdrawal, arrival]);

  it('pairs an exchange withdrawal with the wallet receipt it caused', () => {
    const links = linkInternalTransfers([withdrawal, arrival], owned());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      assetId: BTC,
      fromVenue: 'bitpanda',
      toVenue: 'bc1qwallet',
      txHash: HASH,
      // What ARRIVED, not what left: the difference is the network fee,
      // and the destination holds the smaller number.
      amount: '49995000',
    });
    expect(linkedEventIds(links)).toEqual(
      new Set(['exchange-out', 'wallet-in']),
    );
  });

  it('leaves a payment to someone else alone', () => {
    // THE case this must never get wrong. Paying a third party produces an
    // owned OUT leg and no owned IN leg - a module never emits the
    // counterparty's side - so nothing pairs and it stays a disposal.
    const payment = event({
      id: 'paid-out',
      txHash: 'aaaa',
      legs: [leg('out', 'bc1qwallet')],
    });
    expect(linkInternalTransfers([payment], ownedVenuesOf([payment]))).toEqual(
      [],
    );
  });

  it('pairs on the hash alone, never on amount or time', () => {
    // A heuristic that paired the wrong two events would hide a real
    // disposal, which is the most expensive mistake available here. Same
    // amount, same minute, different transactions: not a pair.
    const sold = event({
      id: 'a',
      txHash: 'hash-one',
      legs: [leg('out', 'bitpanda')],
    });
    const bought = event({
      id: 'b',
      txHash: 'hash-two',
      legs: [leg('in', 'bc1qwallet')],
    });
    expect(
      linkInternalTransfers([sold, bought], ownedVenuesOf([sold, bought])),
    ).toEqual([]);
  });

  it('never pairs an event with ITSELF, even beside another event', () => {
    // The dangerous shape. A UTXO payment with change has an owned out-leg
    // AND an owned in-leg, so if it were allowed to be both sides of a
    // pair, an ordinary payment to a stranger would become an internal
    // transfer and vanish from the tax input. The single-event guard in
    // `linkInternalTransfers` is the only thing stopping it once another
    // event shares the hash - here a fee-only row, which has no principal
    // leg of its own to pair with.
    const payment = event({
      id: 'payment',
      txHash: 'dddd',
      legs: [
        leg('out', 'bc1qwallet', '50000000'),
        leg('in', 'bc1qwallet', '39800000'),
      ],
    });
    const feeOnly = event({
      id: 'fee-row',
      txHash: 'dddd',
      legs: [leg('out', 'bc1qwallet', '1000', 'fee')],
    });
    expect(
      linkInternalTransfers(
        [payment, feeOnly],
        ownedVenuesOf([payment, feeOnly]),
      ),
    ).toEqual([]);
  });

  it('ignores a single event holding both directions', () => {
    // A UTXO change output makes "has both" true for an ordinary outbound
    // payment. That case belongs to isInternalTransfer, which decides it
    // on the NET and so gets it right.
    const selfSend = event({
      id: 'one',
      txHash: 'cccc',
      legs: [
        leg('out', 'bc1qwallet', '50000000'),
        leg('in', 'bc1qwallet', '39800000'),
      ],
    });
    expect(
      linkInternalTransfers([selfSend], ownedVenuesOf([selfSend])),
    ).toEqual([]);
  });

  it('ignores an event with no hash at all', () => {
    const noHash = event({ id: 'n', legs: [leg('out', 'bitpanda')] });
    const other = event({ id: 'm', legs: [leg('in', 'bc1qwallet')] });
    expect(
      linkInternalTransfers([noHash, other], ownedVenuesOf([noHash, other])),
    ).toEqual([]);
  });
});

describe('the lot following the coins', () => {
  const taxEvent = (overrides: Partial<TaxEvent>): TaxEvent => ({
    sourceEventId: 'te',
    kind: 'acquisition',
    assetId: BTC,
    amount: '50000000',
    timestamp: Date.UTC(2022, 0, 1),
    venue: 'bitpanda',
    value: '20000',
    ...overrides,
  });

  const perVenue = (event: TaxEvent) => event.venue;

  const move: LotMove = {
    sourceEventId: 'exchange-out',
    assetId: BTC,
    amount: '50000000',
    timestamp: Date.UTC(2024, 5, 1),
    fromVenue: 'bitpanda',
    toVenue: 'bc1qwallet',
  };

  it('lets a wallet disposal use a lot acquired on an exchange', () => {
    // Without the move, German per-venue FIFO finds no lot in the wallet's
    // partition and reports "no acquisition on record" - which is just a
    // different wrong answer from the fake disposal it replaced.
    const { matched, shortfalls } = match(
      [
        taxEvent({ sourceEventId: 'buy' }),
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '35000',
        }),
      ],
      'fifo',
      perVenue,
      [move],
    );

    expect(shortfalls).toHaveLength(0);
    expect(matched).toHaveLength(1);
    expect(matched[0].costBasis).toBe('20000');
    expect(matched[0].gain).toBe('15000');
  });

  it('keeps the ORIGINAL acquisition date, so a holding period survives', () => {
    // The one that decides money in Germany: a coin held over a year is
    // tax free. Re-dating the lot at the transfer would make a two-year
    // holding look freshly bought and turn a free disposal into a taxable
    // one.
    const { matched } = match(
      [
        taxEvent({ sourceEventId: 'buy', timestamp: Date.UTC(2022, 0, 1) }),
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '35000',
        }),
      ],
      'fifo',
      perVenue,
      [move],
    );
    expect(matched[0].consumed[0].acquiredAt).toBe(Date.UTC(2022, 0, 1));
    expect(matched[0].consumed[0].heldDays).toBeGreaterThan(365 * 2);
  });

  it('moves lots in FIFO order, not whichever is cheapest', () => {
    const { matched } = match(
      [
        taxEvent({
          sourceEventId: 'old',
          amount: '10000000',
          value: '1000',
          timestamp: Date.UTC(2021, 0, 1),
        }),
        taxEvent({
          sourceEventId: 'new',
          amount: '10000000',
          value: '9000',
          timestamp: Date.UTC(2023, 0, 1),
        }),
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          amount: '10000000',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '5000',
        }),
      ],
      'fifo',
      perVenue,
      [{ ...move, amount: '10000000' }],
    );
    // The 2021 lot moved, so the disposal uses its 1000 basis.
    expect(matched[0].costBasis).toBe('1000');
  });

  it('is a no-op where the jurisdiction does not partition by venue', () => {
    // Austria pools by acquisition era, so both ends of a move answer the
    // same partition and nothing needs to cross.
    const pooled = () => 'all';
    const withMove = match(
      [
        taxEvent({ sourceEventId: 'buy' }),
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '35000',
        }),
      ],
      'moving-average',
      pooled,
      [move],
    );
    const without = match(
      [
        taxEvent({ sourceEventId: 'buy' }),
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '35000',
        }),
      ],
      'moving-average',
      pooled,
      [],
    );
    expect(withMove.matched).toEqual(without.matched);
  });

  it('leaves the destination empty when the source cannot cover the move', () => {
    // Not a shortfall of its own - no disposal happened - but a later
    // disposal at the destination says "no acquisition on record", which is
    // the honest answer rather than an invented lot.
    const { matched, shortfalls } = match(
      [
        taxEvent({
          sourceEventId: 'sell',
          kind: 'disposal',
          venue: 'bc1qwallet',
          timestamp: Date.UTC(2024, 11, 1),
          value: '35000',
        }),
      ],
      'fifo',
      perVenue,
      [move],
    );
    expect(matched).toHaveLength(0);
    expect(shortfalls).toHaveLength(1);
  });

  it('changes nothing at all when there are no moves', () => {
    // The regression guard for the restructure: grouping by asset instead
    // of asset+partition must not alter an ordinary report.
    const events = [
      taxEvent({ sourceEventId: 'buy' }),
      taxEvent({
        sourceEventId: 'sell',
        kind: 'disposal',
        timestamp: Date.UTC(2024, 11, 1),
        value: '35000',
      }),
    ];
    const { matched } = match(events, 'fifo', perVenue, []);
    expect(matched).toHaveLength(1);
    expect(matched[0].partition).toBe('bitpanda');
    expect(matched[0].gain).toBe('15000');
  });
});

describe('end to end, through a German report', () => {
  const HASH2 = 'abcd'.repeat(16);

  /** Bought on an exchange, withdrawn to a wallet, sold from the wallet.
   *  The withdrawal is not a sale and must not appear as one. */
  const story = (): LedgerEvent[] => [
    {
      id: 'buy',
      sourceId: 'bitpanda',
      externalId: 'buy',
      timestamp: Date.UTC(2024, 0, 10),
      kind: 'trade',
      origin: 'derived',
      legs: [
        leg('in', 'bitpanda', '50000000'),
        {
          assetId: 'fiat:eur',
          amount: '20000',
          direction: 'out',
          venue: 'bitpanda',
          role: 'principal',
        },
      ],
    },
    {
      id: 'withdraw',
      sourceId: 'bitpanda',
      externalId: 'withdraw',
      txHash: HASH2,
      timestamp: Date.UTC(2024, 1, 1),
      kind: 'transfer',
      origin: 'derived',
      legs: [leg('out', 'bitpanda', '50000000')],
    },
    {
      id: 'arrive',
      sourceId: 'bitcoin',
      externalId: 'arrive',
      txHash: HASH2,
      timestamp: Date.UTC(2024, 1, 1, 1),
      kind: 'transfer',
      origin: 'derived',
      legs: [leg('in', 'bc1qwallet', '50000000')],
    },
  ];

  it('drops both sides of the transfer from what the engine considers', () => {
    const events = story();
    const owned = ownedVenuesOf(events);
    const linked = linkedEventIds(linkInternalTransfers(events, owned));

    expect(linked).toEqual(new Set(['withdraw', 'arrive']));
    // The purchase is untouched: it really did acquire something.
    expect(linked.has('buy')).toBe(false);
  });

  it('carries the exchange lot to the wallet, with its own basis', () => {
    const events = story();
    const owned = ownedVenuesOf(events);
    const links = linkInternalTransfers(events, owned);

    const { matched, shortfalls } = match(
      [
        {
          sourceEventId: 'buy',
          kind: 'acquisition',
          assetId: BTC,
          amount: '50000000',
          timestamp: Date.UTC(2024, 0, 10),
          venue: 'bitpanda',
          value: '20000',
        },
        {
          sourceEventId: 'sell',
          kind: 'disposal',
          assetId: BTC,
          amount: '50000000',
          timestamp: Date.UTC(2024, 8, 1),
          venue: 'bc1qwallet',
          value: '30000',
        },
      ],
      'fifo',
      (event) => event.venue,
      links.map((link) => ({
        sourceEventId: link.fromEventId,
        assetId: link.assetId,
        amount: link.amount,
        timestamp: link.timestamp,
        fromVenue: link.fromVenue,
        toVenue: link.toVenue,
      })),
    );

    expect(shortfalls).toHaveLength(0);
    // One disposal, not two: the withdrawal is gone and the sale is real.
    expect(matched).toHaveLength(1);
    expect(matched[0].disposalEventId).toBe('sell');
    expect(matched[0].costBasis).toBe('20000');
    expect(matched[0].gain).toBe('10000');
    // And it kept the January acquisition date, not February's transfer.
    expect(matched[0].consumed[0].acquiredAt).toBe(Date.UTC(2024, 0, 10));
  });
});

describe('through runTaxReport, where the figures are actually produced', () => {
  const HASH3 = 'feed'.repeat(16);

  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'prices', 'settings'] as const) {
      await db.clear(store);
    }
    // Serves the DEEP price path (DefiLlama plus the ECB), not CoinGecko.
    // The events below are more than a year old, which is exactly what
    // CoinGecko's free tier refuses - so a CoinGecko-only stub would make
    // this test fail for a pricing reason and say nothing about transfers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const asked = String(url);
        if (asked.includes('frankfurter')) {
          // Rate 1, so a dollar price is also the euro price and the
          // figures below stay readable.
          return new Response(
            JSON.stringify({
              rates: Object.fromEntries(DAYS.map((day) => [day, { EUR: 1 }])),
            }),
            { status: 200 },
          );
        }
        if (asked.includes('llama.fi')) {
          const coins = JSON.parse(
            decodeURIComponent(/coins=([^&]+)/.exec(asked)?.[1] ?? '{}'),
          ) as Record<string, number[]>;
          return new Response(
            JSON.stringify({
              coins: Object.fromEntries(
                Object.entries(coins).map(([coin, times]) => [
                  coin,
                  {
                    prices: times.map((timestamp) => ({
                      timestamp,
                      price:
                        PRICE_ON[
                          new Date(timestamp * 1000).toISOString().slice(0, 10)
                        ] ?? 1,
                    })),
                  },
                ]),
              ),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ prices: [] }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 40,000 on the day it was bought and 60,000 on the day it was sold, so
   *  a gain of exactly 10,000 on half a bitcoin is readable in the result. */
  const PRICE_ON: Record<string, number> = {
    '2025-01-10': 40000,
    '2025-09-01': 60000,
  };
  const DAYS = ['2025-01-10', '2025-02-01', '2025-09-01'];

  const fiatLeg = (amount: string, direction: 'in' | 'out') => ({
    assetId: 'fiat:eur',
    amount,
    direction,
    venue: 'bitpanda',
    role: 'principal' as const,
  });

  /** Bought on an exchange in January, withdrawn to a wallet in February.
   *  Nothing is sold, so a 2025 report must show no gain at all. */
  const bought = (): LedgerEvent[] => [
    {
      id: 'buy',
      sourceId: 'bitpanda',
      externalId: 'buy',
      timestamp: Date.UTC(2025, 0, 10),
      kind: 'trade',
      origin: 'derived',
      legs: [leg('in', 'bitpanda', '50000000'), fiatLeg('20000', 'out')],
    },
    {
      id: 'withdraw',
      sourceId: 'bitpanda',
      externalId: 'withdraw',
      txHash: HASH3,
      timestamp: Date.UTC(2025, 1, 1),
      kind: 'transfer',
      origin: 'derived',
      legs: [leg('out', 'bitpanda', '50000000')],
    },
    {
      id: 'arrive',
      sourceId: 'bitcoin',
      externalId: 'arrive',
      txHash: HASH3,
      timestamp: Date.UTC(2025, 1, 1, 1),
      kind: 'transfer',
      origin: 'derived',
      legs: [leg('in', 'bc1qwallet', '50000000')],
    },
  ];

  it('reports no disposal for a withdrawal to the user’s own wallet', async () => {
    // THE regression. Before this, moving your own coins off an exchange
    // produced a taxable disposal you never made - and on a German report
    // that is a gain on a sale that did not happen.
    await putEvents(bought());

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.lines).toHaveLength(0);
    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.omitted).toBe(0);
  });

  it('prices a later wallet sale from the exchange lot it was bought with', async () => {
    // The whole point, end to end: bought on an exchange, withdrawn, then
    // sold from the wallet. Without the lot move, German per-venue FIFO
    // finds nothing in the wallet's partition and the sale reports "no
    // acquisition on record" - swapping a fake disposal for a missing cost
    // basis, which is no better a report.
    await putEvents([
      ...bought(),
      {
        id: 'sell',
        sourceId: 'bitcoin',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 8, 1),
        kind: 'trade',
        origin: 'derived',
        legs: [
          leg('out', 'bc1qwallet', '50000000'),
          {
            assetId: 'fiat:eur',
            amount: '30000',
            direction: 'in',
            venue: 'bc1qwallet',
            role: 'principal' as const,
          },
        ],
      },
    ]);

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.totals.omitted).toBe(0);
    expect(report.lines).toHaveLength(1);
    // The lot kept its January basis across the February transfer.
    expect(report.lines[0].costBasis).toBe('20000');
    expect(report.lines[0].proceeds).toBe('30000');
    expect(report.lines[0].gain).toBe('10000');
  });

  it('still reports a real payment to somebody else as a disposal', async () => {
    // The companion proof, and the one that matters more: the guard must
    // not swallow a genuine disposal. Same shape, except the coins arrive
    // nowhere the user owns - so nothing pairs.
    const events = bought();
    await putEvents([
      events[0],
      {
        ...events[1],
        id: 'paid',
        externalId: 'paid',
        txHash: 'dead'.repeat(16),
      },
    ]);

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.lines.length + report.totals.omitted).toBeGreaterThan(0);
  });
});
