import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { runTaxReport, taxYearOf } from '@/tax/runTaxReport';
import { openLedger, putEvents } from '@/ledger/db';
import austrianTax from '@/tax/jurisdictions/at';
import type { LedgerEvent } from '@/ledger/types';
import type { TaxModule, TaxEvent } from '@/tax/types';
import { flatRange, rangeStub } from './priceRangeStub';

/** A deliberately minimal module: the pipeline must work without any
 *  jurisdiction's rules, so the two can be rejected independently. 'fee' is
 *  left out of `handles` on purpose - it is the kind the "records an event
 *  kind the module does not classify" test below uses to prove an
 *  undeclared kind still surfaces. */
const stubModule: TaxModule = {
  manifest: {
    id: 'test',
    jurisdiction: 'Testland',
    contributor: 'Test Suite',
    rulesCheckedOn: '2026-10-01',
    references: ['none'],
    supportedYears: { from: 2024, to: 2026 },
  },
  handles: ['trade', 'transfer', 'reward', 'fiat-in', 'fiat-out'],
  defaultMatching: 'fifo',
  partitionBy: (event) => event.venue,
  classify: (event) =>
    event.legs.map((leg, index) => ({
      sourceEventId: `${event.id}:${index}`,
      kind: leg.direction === 'in' ? 'acquisition' : 'disposal',
      assetId: leg.assetId,
      amount: leg.amount,
      timestamp: event.timestamp,
      venue: leg.venue,
    })) as TaxEvent[],
  assess: ({ year, matched, income }) => ({
    year,
    lines: matched.map((m) => ({
      disposalEventId: m.disposalEventId,
      assetId: m.assetId,
      timestamp: m.timestamp,
      proceeds: m.proceeds,
      costBasis: m.costBasis,
      gain: m.gain,
      exempt: '0',
      taxable: m.gain,
      reason: { key: 'stub' },
    })),
    totals: {
      taxableGain: '0',
      exemptGain: '0',
      income: String(income.length),
      computedFrom: matched.length,
      omitted: 0,
    },
    thresholds: [],
    unresolved: [],
  }),
};

const ledgerEvent = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e1',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '10',
      direction: 'in',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
  ...overrides,
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  // These scenarios deliberately span more than a year - an acquisition in
  // one tax year disposed of in another is the whole point of several of
  // them - and the keyless free tier only prices the last 365 days. Prices
  // for days outside that are no longer requested at all, because
  // CoinGecko's 401 carries no CORS header and a browser would see only
  // "Failed to fetch". So these run as a keyed user, which is the honest
  // reading of a report covering several years.
  await db.put('settings', {
    key: 'settings',
    value: {
      language: 'en',
      baseCurrency: 'eur',
      coingeckoApiKey: 'test-key',
    },
  });
  vi.stubGlobal('fetch', flatRange(1));
});

describe('taxYearOf', () => {
  it('assigns an event just before midnight UTC on 31 December to that year', () => {
    // REVIEW FOCUS 2. A local-timezone reading in UTC+2 shows this as
    // 1 January and files the gain in the wrong year - the single most
    // consequential off-by-one available, because it changes which return
    // the number belongs on.
    expect(taxYearOf(Date.UTC(2025, 11, 31, 23, 30))).toBe(2025);
  });

  it('assigns an event just after midnight UTC on 1 January to the new year', () => {
    expect(taxYearOf(Date.UTC(2026, 0, 1, 0, 30))).toBe(2026);
  });
});

describe('runTaxReport', () => {
  it('refuses a year the module does not support', async () => {
    await expect(
      runTaxReport(stubModule, { year: 2019, baseCurrency: 'eur' }),
    ).rejects.toThrow(/2024/);
  });

  it('refuses a year after the supported range', async () => {
    await expect(
      runTaxReport(stubModule, { year: 2030, baseCurrency: 'eur' }),
    ).rejects.toThrow(/2026/);
  });

  it('only considers disposals in the requested year', async () => {
    await putEvents([
      ledgerEvent({
        id: 'buy',
        externalId: 'buy',
        timestamp: Date.UTC(2024, 0, 1),
      }),
      ledgerEvent({
        id: 'sell-2025',
        externalId: 'sell-2025',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2026,
      baseCurrency: 'eur',
    });

    expect(report.totals.computedFrom).toBe(0);
  });

  it('matches a disposal against an acquisition from an earlier year', async () => {
    // A lot bought in 2024 and sold in 2025 must still be found. Filtering
    // events to the tax year BEFORE matching would leave the sale with no
    // cost basis and report a gain equal to the whole proceeds.
    await putEvents([
      ledgerEvent({
        id: 'buy',
        externalId: 'buy',
        timestamp: Date.UTC(2024, 0, 1),
      }),
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.totals.computedFrom).toBe(1);
  });

  it('counts an unresolvable disposal in omitted, not in the figures', async () => {
    // The structural completeness guarantee: a caller holding totals
    // necessarily holds omitted, so "N could not be computed" cannot be
    // left off a report by accident.
    await putEvents([
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.totals.omitted).toBe(1);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].kind).toBe('needs-cost-basis');
  });

  it('offers adding a source as a resolution for a missing basis', async () => {
    await putEvents([
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'out',
            venue: 'wallet-x',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.unresolved[0].resolutions).toEqual(
      expect.arrayContaining([
        { kind: 'add-source-for-venue', venue: 'wallet-x' },
        expect.objectContaining({ kind: 'record-purchase' }),
      ]),
    );
  });

  it('excludes internal transfers before the jurisdiction ever sees them', async () => {
    // isInternalTransfer already exists and is correct. Moving coins
    // between your own venues is not a disposal, and a jurisdiction must
    // not have to re-derive that.
    await putEvents([
      ledgerEvent({
        id: 'move',
        externalId: 'move',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
          {
            assetId: 'cardano:lovelace',
            amount: '10',
            direction: 'in',
            venue: 'wallet-b',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    expect(report.totals.computedFrom).toBe(0);
    expect(report.unresolved).toHaveLength(0);
  });

  it('produces different cost bases under fifo vs moving-average for the same disposal', async () => {
    // The brief's original version of this test only asserted
    // `report.year === 2025`, which `runTaxReport` returns regardless of
    // which matching method actually ran - it could not fail, which is a
    // defect in the test itself. This replaces it with a genuine
    // behavioural check: two acquisitions at different prices, then a
    // partial disposal. FIFO must consume the OLDEST lot's price; moving
    // average must consume the BLENDED pool price. The two methods are
    // expected to, and must, disagree on the resulting cost basis.
    vi.stubGlobal(
      'fetch',
      // Prices are now requested as one span per asset, so each
      // acquisition gets its own price by the DAY the fake answers for
      // rather than by a date in the URL.
      rangeStub((isoDate) =>
        isoDate === '2024-01-01' ? 1 : isoDate === '2024-01-02' ? 3 : 5,
      ),
    );

    // Amounts are lovelace while a price is per whole ADA, so these are
    // 10 ADA, 10 ADA and 5 ADA written in base units - what the ledger
    // actually stores. See src/prices/scale.ts.
    const tenAda = '10000000';
    const inLeg = {
      assetId: 'cardano:lovelace',
      amount: tenAda,
      direction: 'in' as const,
      venue: 'wallet-a',
      role: 'principal' as const,
    };
    await putEvents([
      ledgerEvent({
        id: 'buy-old',
        externalId: 'buy-old',
        timestamp: Date.UTC(2024, 0, 1), // priced at 1/ADA -> lot cost 10
        legs: [inLeg],
      }),
      ledgerEvent({
        id: 'buy-new',
        externalId: 'buy-new',
        timestamp: Date.UTC(2024, 0, 2), // priced at 3/ADA -> lot cost 30
        legs: [inLeg],
      }),
      ledgerEvent({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 0, 1),
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '5000000',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const fifoReport = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
      matching: 'fifo',
    });
    const averageReport = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
      matching: 'moving-average',
    });

    // FIFO: the oldest lot (10 ADA @ cost 10) gives up 5 ADA
    // proportionally -> cost basis 5.
    expect(fifoReport.lines[0].costBasis).toBe('5');
    // Moving average: the pool blends to 20 ADA @ cost 40 (2/ADA) before
    // the disposal, so 5 ADA cost 10.
    expect(averageReport.lines[0].costBasis).toBe('10');
    expect(fifoReport.lines[0].costBasis).not.toBe(
      averageReport.lines[0].costBasis,
    );
  });

  it('surfaces a throwing module by name without a partial assessment', async () => {
    const broken: TaxModule = {
      ...stubModule,
      classify: () => {
        throw new Error('rule exploded');
      },
    };
    await putEvents([ledgerEvent({})]);

    await expect(
      runTaxReport(broken, { year: 2025, baseCurrency: 'eur' }),
    ).rejects.toThrow(/test/);
  });

  it('records an event kind the module does not classify', async () => {
    // A new ledger event kind must not silently vanish from a tax report.
    const ignoring: TaxModule = { ...stubModule, classify: () => [] };
    await putEvents([
      ledgerEvent({
        id: 'odd',
        externalId: 'odd',
        kind: 'fee',
        timestamp: Date.UTC(2025, 0, 1),
      }),
    ]);

    const report = await runTaxReport(ignoring, {
      year: 2025,
      baseCurrency: 'eur',
    });

    const unresolved = report.unresolved.find((item) =>
      item.reason.key.includes('{{kind}}'),
    );
    expect(unresolved?.kind).toBe('unclassified');
    expect(unresolved?.resolutions).toEqual([]);
  });

  it('counts only real disposals in omitted, not every unresolved item', async () => {
    // `omitted` is typed as "disposals that stayed unresolved", and the UI
    // renders it as "{{count}} disposals could not be computed". It
    // accepted every in-year needs-price item, including unpriced
    // ACQUISITIONS and native-token legs that are not disposals at all: on
    // the recorded wallet that read computedFrom=18 omitted=56, where all
    // 56 were needs-price on Cardano native tokens with no CoinGecko
    // mapping. Erring safe, but contradicting its own type - and 56 red
    // cards on a one-wallet report teaches users to ignore the warning
    // that exists to be read.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        // The native token has no CoinGecko id, so it is never asked about
        // at all; lovelace is priced. Anything else 404s, which is what
        // makes a stray request visible rather than silently satisfied.
        if (String(url).includes('cardano')) {
          return flatRange(1)(String(url), init);
        }
        return new Response('', { status: 404 });
      }),
    );

    await putEvents([
      // An unpriceable ACQUISITION: a native token arriving. Not a
      // disposal, so it must not be counted as one.
      ledgerEvent({
        id: 'token-in',
        externalId: 'token-in',
        timestamp: Date.UTC(2025, 2, 1),
        legs: [
          {
            assetId: 'cardano:1234abcd.MyToken',
            amount: '5',
            direction: 'in',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
      // An unpriceable DISPOSAL of the same token: this one really is a
      // disposal the figures do not include.
      ledgerEvent({
        id: 'token-out',
        externalId: 'token-out',
        timestamp: Date.UTC(2025, 3, 1),
        legs: [
          {
            assetId: 'cardano:1234abcd.MyToken',
            amount: '5',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    // Both gaps are still reported - nothing is hidden...
    expect(report.unresolved).toHaveLength(2);
    expect(report.unresolved.map((item) => item.kind)).toEqual([
      'needs-price',
      'needs-price',
    ]);
    // ...but only one of them is a disposal.
    expect(report.totals.omitted).toBe(1);
  });

  it('does not report a correctly-untaxed Austrian swap as unresolved', async () => {
    // The seam the stub module could never expose: a real jurisdiction's
    // classify legitimately returns [] for a kind it fully considered.
    // austrianTax.classify([]) for 'trade' is Austria's deliberate "not a
    // taxable event here" - swaps carry cost over under ÖkoStRefG, they do
    // not realise a gain. foldDisposals still agrees this event LOOKS like
    // a disposal (it has an outgoing non-fiat leg), which is exactly why a
    // kind-unaware host used to funnel it into `unresolved` as a coverage
    // gap. It must now vanish cleanly instead, because 'trade' is declared
    // in austrianTax.handles.
    await putEvents([
      {
        id: 'swap',
        sourceId: 's1',
        externalId: 'x',
        timestamp: Date.UTC(2024, 5, 1),
        kind: 'trade',
        origin: 'authored',
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '100',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
          {
            assetId: 'bitcoin:native',
            amount: '1',
            direction: 'in',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      },
    ]);

    const report = await runTaxReport(austrianTax, {
      year: 2024,
      baseCurrency: 'eur',
    });

    expect(report.unresolved).toHaveLength(0);
    expect(report.totals.omitted).toBe(0);
  });

  it('still reports a kind austrianTax does not declare as unresolved', async () => {
    // The companion proof: `handles` must not become a blanket license to
    // drop anything a module's classify happens to return [] for. A kind
    // genuinely outside austrianTax.handles - here 'fee', the same gap
    // Germany's classify leaves unaddressed - must still surface.
    await putEvents([
      {
        id: 'odd-fee',
        sourceId: 's1',
        externalId: 'odd-fee',
        timestamp: Date.UTC(2024, 5, 1),
        kind: 'fee',
        origin: 'derived',
        legs: [
          {
            assetId: 'cardano:lovelace',
            amount: '1',
            direction: 'out',
            venue: 'wallet-a',
            role: 'fee',
          },
        ],
      },
    ]);

    const report = await runTaxReport(austrianTax, {
      year: 2024,
      baseCurrency: 'eur',
    });

    const unresolved = report.unresolved.find((item) =>
      item.reason.key.includes('{{kind}}'),
    );
    expect(unresolved?.kind).toBe('unclassified');
  });
});

describe('reasons the host itself writes', () => {
  it('names the unhandled kind as a parameter, not inside an English sentence', async () => {
    const ignoring: TaxModule = {
      ...stubModule,
      handles: [],
      classify: () => [],
    };

    await putEvents([
      ledgerEvent({
        id: 'odd-kind',
        externalId: 'odd-kind',
        kind: 'fee',
        timestamp: Date.UTC(2025, 0, 1),
      }),
    ]);

    const report = await runTaxReport(ignoring, {
      year: 2025,
      baseCurrency: 'eur',
    });

    const item = report.unresolved.find((u) => u.kind === 'unclassified');
    expect(item?.reason).toEqual({
      key: 'This jurisdiction has no rule for a {{kind}} event.',
      params: { kind: 'fee' },
    });
  });

  it('keys the missing-acquisition reason rather than writing a sentence', async () => {
    await putEvents([
      ledgerEvent({
        id: 'naked-sale',
        externalId: 'naked-sale',
        kind: 'trade',
        timestamp: Date.UTC(2025, 2, 1),
        legs: [
          {
            assetId: 'fiat:eur',
            amount: '100',
            direction: 'out',
            venue: 'wallet-a',
            role: 'principal',
          },
        ],
      }),
    ]);

    const report = await runTaxReport(stubModule, {
      year: 2025,
      baseCurrency: 'eur',
    });

    const item = report.unresolved.find((u) => u.kind === 'needs-cost-basis');
    expect(item?.reason).toEqual({
      key: 'No acquisition is on record for this disposal.',
    });
  });
});
