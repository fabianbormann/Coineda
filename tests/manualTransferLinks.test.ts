import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { MAX_APART_MS, proposeTransfers } from '@/ledger/proposeTransfers';
import {
  applyManualLinks,
  deleteManualLink,
  getLinkedEvents,
  getManualLinks,
  putManualLink,
} from '@/ledger/manualLinks';
import {
  deleteSourceCascade,
  openLedger,
  putEvents,
  putSource,
} from '@/ledger/db';
import { ownedVenuesOf } from '@/ledger/balances';
import { linkInternalTransfers } from '@/ledger/transfers';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';

/**
 * Pairing a transfer whose exchange side reports no chain transaction.
 *
 * Kraken's ledger export is the case this exists for. Its columns are
 * `txid, refid, time, type, subtype, aclass, asset, wallet, amount, fee,
 * balance` - its OWN ids, and no hash or address anywhere - so a
 * withdrawal to the user's own wallet shares no key with the arrival the
 * Bitcoin module records, and an unpaired outflow is a disposal.
 */
const BTC = 'bitcoin:native';
const ADA = 'cardano:lovelace';
const HASH = 'a1b2'.repeat(16);

const leg = (
  direction: 'in' | 'out',
  venue: string,
  amount: string,
  assetId = BTC,
  role: 'principal' | 'fee' = 'principal',
) => ({ assetId, amount, direction, venue, role });

const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e',
  sourceId: 'kraken',
  externalId: 'x',
  timestamp: Date.UTC(2025, 2, 1, 12),
  kind: 'transfer',
  origin: 'derived',
  legs: [],
  ...overrides,
});

/**
 * The user's real rows. 0.07545306 BTC left their wallet for Kraken, and
 * 0.07543806 came back later - the ledger ids are Kraken's own, which is
 * all that export gives.
 */
const krakenDeposit = event({
  id: 'kraken-in',
  externalId: 'LLSN5F-UR5OY-DD6KMV',
  timestamp: Date.UTC(2025, 2, 1, 13),
  legs: [leg('in', 'kraken', '7545306')],
});

/** The wallet side, in raw UTXO legs: an input spent whole, change back.
 *  The NET is what left - 0.07545306 plus the miner fee. */
const walletSpend = event({
  id: 'wallet-out',
  sourceId: 'bitcoin',
  externalId: HASH,
  txHash: HASH,
  timestamp: Date.UTC(2025, 2, 1, 12, 40),
  legs: [leg('out', 'bc1qown', '40000000'), leg('in', 'bc1qown', '32454500')],
});

describe('proposing a pair the sources cannot link themselves', () => {
  const owned = (events: LedgerEvent[]) => ownedVenuesOf(events);

  it('proposes the wallet spend for the Kraken deposit it funded', () => {
    const events = [krakenDeposit, walletSpend];
    const proposals = proposeTransfers(events, owned(events));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      unlinkedEventId: 'kraken-in',
      chainEventId: 'wallet-out',
      txHash: HASH,
      assetId: BTC,
      // 40,000,000 - 32,454,500 = 7,545,500 left the wallet; Kraken
      // credited 7,545,306. The 194 sats between them is the miner fee.
      difference: '194',
    });
  });

  it('compares the NET of the wallet spend, not its raw legs', () => {
    // The raw legs are 40,000,000 out and 32,454,500 in. Matching on
    // those compares a whole UTXO against a deposit and finds nothing -
    // and the amounts are so far apart that no tolerance would rescue it.
    const raw = walletSpend.legs.map((candidate) => candidate.amount);
    expect(raw).toEqual(['40000000', '32454500']);
    expect(raw).not.toContain('7545500');

    const events = [krakenDeposit, walletSpend];
    expect(proposeTransfers(events, owned(events))).toHaveLength(1);
  });

  it('refuses two movements going the same way', () => {
    const alsoOut = event({
      id: 'kraken-out',
      externalId: 'LCU6XN',
      legs: [leg('out', 'kraken', '7545306')],
    });
    const events = [alsoOut, walletSpend];
    expect(proposeTransfers(events, owned(events))).toEqual([]);
  });

  it('refuses amounts further apart than a fee could explain', () => {
    const tooSmall = event({
      id: 'kraken-small',
      externalId: 'other',
      // 7,000,000 against 7,545,500 is 7% - a different movement, not a
      // network fee.
      legs: [leg('in', 'kraken', '7000000')],
    });
    const events = [tooSmall, walletSpend];
    expect(proposeTransfers(events, owned(events))).toEqual([]);
  });

  it('refuses movements too far apart in time', () => {
    const late = event({
      ...krakenDeposit,
      id: 'kraken-late',
      timestamp: walletSpend.timestamp + MAX_APART_MS + 1,
    });
    const events = [late, walletSpend];
    expect(proposeTransfers(events, owned(events))).toEqual([]);

    const justInside = event({
      ...krakenDeposit,
      id: 'kraken-edge',
      timestamp: walletSpend.timestamp + MAX_APART_MS - 1,
    });
    const inside = [justInside, walletSpend];
    expect(proposeTransfers(inside, owned(inside))).toHaveLength(1);
  });

  it('refuses a different asset of a similar size', () => {
    const ada = event({
      id: 'kraken-ada',
      externalId: 'ada',
      legs: [leg('in', 'kraken', '7545306', ADA)],
    });
    const events = [ada, walletSpend];
    expect(proposeTransfers(events, owned(events))).toEqual([]);
  });

  it('never proposes a trade, however well it matches', () => {
    // A buy on an exchange, the same size, minutes after a wallet spend,
    // is exactly the shape of a coincidence this must not offer: saying
    // yes to it would delete a real disposal from the report.
    const buy = event({
      id: 'kraken-buy',
      externalId: 'buy',
      kind: 'trade',
      legs: [
        leg('in', 'kraken', '7545306'),
        leg('out', 'kraken', '500000', 'fiat:eur'),
      ],
    });
    const events = [buy, walletSpend];
    expect(proposeTransfers(events, owned(events))).toEqual([]);
  });

  it('leaves out events that already pair on a hash of their own', () => {
    const events = [krakenDeposit, walletSpend];
    const linked = new Set(['wallet-out']);
    expect(proposeTransfers(events, owned(events), linked)).toEqual([]);
  });

  it('offers the closest amount first', () => {
    const second = event({
      id: 'wallet-out-2',
      sourceId: 'bitcoin',
      externalId: 'bbbb',
      txHash: 'b2c3'.repeat(16),
      timestamp: Date.UTC(2025, 2, 1, 12, 50),
      // Nets to 7,500,000 out: within tolerance, but 45,306 away rather
      // than 194.
      legs: [leg('out', 'bc1qown', '7500000')],
    });
    // The worse match is listed FIRST in the input, so insertion order
    // alone would get this backwards - without that, the assertion passes
    // whether or not anything sorts.
    const events = [krakenDeposit, second, walletSpend];
    const proposals = proposeTransfers(events, owned(events));

    expect(proposals.map((proposal) => proposal.chainEventId)).toEqual([
      'wallet-out',
      'wallet-out-2',
    ]);
  });
});

describe('applying a confirmation', () => {
  const link = {
    sourceId: 'kraken',
    externalId: 'LLSN5F-UR5OY-DD6KMV',
    txHash: HASH,
    confirmedAt: 0,
  };

  it('puts the hash on the event the user confirmed', () => {
    const [applied] = applyManualLinks([krakenDeposit], [link]);
    expect(applied.txHash).toBe(HASH);
  });

  it('keys on the source identity, not the row id', () => {
    // A resync deletes and re-derives rows; ids are regenerated, the
    // externalId is what the source reproduces. A link keyed on the id
    // would quietly stop applying.
    const resynced = { ...krakenDeposit, id: 'a-completely-different-id' };
    expect(applyManualLinks([resynced], [link])[0].txHash).toBe(HASH);
  });

  it('never overwrites a hash the source itself reported', () => {
    const own = 'cafe'.repeat(16);
    const reported = { ...krakenDeposit, txHash: own };
    expect(applyManualLinks([reported], [link])[0].txHash).toBe(own);
  });

  it('leaves unrelated events untouched', () => {
    const other = event({ id: 'other', externalId: 'not-this-one' });
    expect(applyManualLinks([other], [link])[0].txHash).toBeUndefined();
  });

  it('makes the exact linker pair them', () => {
    // The point of the whole design: after the overlay, nothing
    // downstream knows a person was involved.
    const events = applyManualLinks([krakenDeposit, walletSpend], [link]);
    const links = linkInternalTransfers(events, ownedVenuesOf(events));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      fromVenue: 'bc1qown',
      toVenue: 'kraken',
      txHash: HASH,
    });
  });
});

describe('the store', () => {
  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'transferLinks'] as const) {
      await db.clear(store);
    }
  });

  it('round-trips a confirmation', async () => {
    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: HASH,
    });
    const stored = await getManualLinks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourceId: 'kraken', txHash: HASH });
    expect(stored[0].confirmedAt).toBeGreaterThan(0);

    await deleteManualLink('kraken', 'LLSN5F-UR5OY-DD6KMV');
    expect(await getManualLinks()).toEqual([]);
  });

  it('applies confirmations when the log is read', async () => {
    await putEvents([krakenDeposit]);
    expect((await getLinkedEvents())[0].txHash).toBeUndefined();

    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: HASH,
    });
    expect((await getLinkedEvents())[0].txHash).toBe(HASH);
  });

  it('drops a source’s confirmations when the source is removed', async () => {
    // Otherwise re-adding the source would silently re-apply a hash to
    // whatever row happened to reuse that externalId.
    const source: SourceRecord = {
      id: 'kraken',
      moduleId: 'kraken-csv',
      label: 'Kraken',
      config: {},
      status: 'idle',
    } as SourceRecord;
    await putSource(source);
    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: HASH,
    });
    await putManualLink({
      sourceId: 'bitcoin',
      externalId: 'kept',
      txHash: HASH,
    });

    await deleteSourceCascade('kraken');

    expect((await getManualLinks()).map((link) => link.sourceId)).toEqual([
      'bitcoin',
    ]);
  });
});

describe('through a German report, where it actually matters', () => {
  const PRICE_ON: Record<string, number> = {
    '2025-01-10': 40000,
    '2025-03-01': 60000,
  };
  const DAYS = ['2025-01-10', '2025-03-01'];

  beforeEach(async () => {
    const db = await openLedger();
    for (const store of [
      'events',
      'prices',
      'settings',
      'transferLinks',
    ] as const) {
      await db.clear(store);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const asked = String(url);
        if (asked.includes('frankfurter')) {
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

  /** Bought on the wallet in January, moved to Kraken in March. Kraken's
   *  row carries no hash, so the two halves share nothing. */
  const moved = (): LedgerEvent[] => [
    {
      id: 'buy',
      sourceId: 'bitcoin',
      externalId: 'buy',
      timestamp: Date.UTC(2025, 0, 10),
      kind: 'trade',
      origin: 'derived',
      legs: [
        leg('in', 'bc1qown', '7545500'),
        {
          assetId: 'fiat:eur',
          amount: '301820',
          direction: 'out' as const,
          venue: 'bc1qown',
          role: 'principal' as const,
        },
      ],
    },
    {
      ...walletSpend,
      timestamp: Date.UTC(2025, 2, 1, 12, 40),
      legs: [leg('out', 'bc1qown', '7545500')],
    },
    { ...krakenDeposit, timestamp: Date.UTC(2025, 2, 1, 13) },
  ];

  it('reports a disposal while the two halves share no hash', async () => {
    // Not a bug being asserted - this is the correct reading of the log as
    // the sources left it. An outflow with no matching arrival is a sale.
    await putEvents(moved());

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].assetId).toBe(BTC);
  });

  it('reports no disposal once the user confirms the pair', async () => {
    await putEvents(moved());
    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: HASH,
    });

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.lines).toEqual([]);
    expect(report.totals.taxableGain).toBe('0');
  });
});
