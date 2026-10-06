import { describe, it, expect } from 'vitest';
import austrianTax from '@/tax/jurisdictions/at';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent } from '@/ledger/types';
import type { MatchedDisposal, TaxEvent } from '@/tax/types';

const ALT_CUTOFF = Date.UTC(2021, 2, 1);

const swap: LedgerEvent = {
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
};

// The brief's own helper builds a MatchedDisposal from `acquiredAt` alone,
// which cannot drive Austria's exemption: moving-average matching emits a
// single synthetic lot whose acquiredAt is the DISPOSAL's own timestamp
// (heldDays: 0), because an averaged pool has no acquisition date. The
// signal Austria actually decides on is `partition`, set by match() to the
// partitionBy key the disposal was matched within ('alt' or 'neu'). This
// helper derives the partition from acquiredAt relative to the cutoff, so
// it still reads as "build a disposal from an acquisition time" at call
// sites, but produces a MatchedDisposal shaped the way match() really
// produces one.
const disposalFrom = (acquiredAt: number, gain: string): MatchedDisposal => ({
  disposalEventId: 'd1',
  assetId: 'cardano:lovelace',
  venue: 'wallet-a',
  partition: acquiredAt < ALT_CUTOFF ? 'alt' : 'neu',
  amount: '10',
  proceeds: '1000',
  timestamp: Date.UTC(2024, 5, 1),
  costBasis: '0',
  gain,
  consumed: [
    {
      acquisitionEventId: 'pool',
      amount: '10',
      costBasis: '0',
      acquiredAt,
      heldDays: 0,
    },
  ],
});

/** A plain sale: BTC out, euros in. The ledger's 'trade' kind carries this
 *  just as it carries a swap. */
const sale: LedgerEvent = {
  ...swap,
  id: 'sale',
  legs: [
    {
      assetId: 'bitcoin:native',
      amount: '1',
      direction: 'out',
      venue: 'wallet-a',
      role: 'principal',
    },
    {
      assetId: 'fiat:eur',
      amount: '50000',
      direction: 'in',
      venue: 'wallet-a',
      role: 'principal',
    },
  ],
};

/** A plain buy: euros out, BTC in. */
const purchase: LedgerEvent = {
  ...swap,
  id: 'purchase',
  legs: [
    {
      assetId: 'fiat:eur',
      amount: '50000',
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
};

describe('austrian classification', () => {
  it('treats a crypto-to-crypto swap as a non-event', () => {
    // GOLDEN CASE 3. The same swap Germany splits in two produces nothing
    // here, which is the single clearest demonstration that the contract
    // is not shaped around one country.
    expect(austrianTax.classify(swap)).toEqual([]);
    expect(germanTax.classify(swap)).toHaveLength(2);
  });

  it('reports a crypto-to-fiat sale as a disposal rather than silently nothing', () => {
    // The ledger's 'trade' kind is not only a swap: it also carries a
    // plain sale. Returning [] for one of those is read by the host as
    // Austria's considered "not a taxable event" - because 'trade' is in
    // `handles` - so an Austrian selling BTC for euros would get
    // taxableGain: 0, no unresolved item, and `omitted` still at 0, with
    // nothing anywhere indicating a disposal had been dropped.
    const events = austrianTax.classify(sale);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'disposal',
      assetId: 'bitcoin:native',
      amount: '1',
    });
  });

  it('reports a fiat-to-crypto purchase as an acquisition', () => {
    // The acquisition side matters just as much: without it the coins
    // bought here have no cost basis, and their eventual sale reports the
    // whole proceeds as gain.
    const events = austrianTax.classify(purchase);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'acquisition',
      assetId: 'bitcoin:native',
      amount: '1',
    });
  });

  it('uses moving average, not FIFO', () => {
    expect(austrianTax.defaultMatching).toBe('moving-average');
  });

  it('partitions by Altvermoegen rather than by venue', () => {
    // GOLDEN CASE 4. Austria pools per asset, so the venue is NOT the
    // partition - but pre-cutoff holdings must stay separate because they
    // are tax-free, and mixing them into the average would make part of a
    // tax-free holding taxable and part of a taxable one free.
    const old = { timestamp: ALT_CUTOFF - 1, venue: 'wallet-a' } as TaxEvent;
    const recent = { timestamp: ALT_CUTOFF, venue: 'wallet-b' } as TaxEvent;

    expect(austrianTax.partitionBy(old)).not.toBe(
      austrianTax.partitionBy(recent),
    );
    // Two different venues on the same side of the cutoff pool together.
    const alsoRecent = {
      timestamp: ALT_CUTOFF + 1,
      venue: 'wallet-c',
    } as TaxEvent;
    expect(austrianTax.partitionBy(recent)).toBe(
      austrianTax.partitionBy(alsoRecent),
    );
  });
});

describe('austrian assessment', () => {
  it('exempts a disposal of Altvermoegen', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(ALT_CUTOFF - 86_400_000, '5000')],
      income: [],
    });
    expect(report.totals.exemptGain).toBe('5000');
    expect(report.totals.taxableGain).toBe('0');
  });

  it('taxes a disposal acquired on the cutoff day itself', () => {
    // 1 March 2021 is Neuvermoegen: the exemption is for acquisitions
    // BEFORE that date.
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(ALT_CUTOFF, '5000')],
      income: [],
    });
    expect(report.totals.taxableGain).toBe('5000');
  });

  it('applies no holding-period exemption at all', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '5000')],
      income: [],
    });
    expect(report.totals.taxableGain).toBe('5000');
  });

  it('computes liability at the statutory 27.5 per cent without being asked', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '1000')],
      income: [],
    });
    expect(report.estimatedLiability).toBe('275');
  });

  it('reports no Freigrenze, because Austria has none', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '50')],
      income: [],
    });
    expect(report.thresholds).toEqual([]);
    expect(report.totals.taxableGain).toBe('50');
  });

  it('refuses a year before the regime existed', () => {
    expect(austrianTax.manifest.supportedYears.from).toBe(2022);
  });
});

describe('austrian rationales', () => {
  it('states Altvermögen as a translatable key', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2020, 0, 1), '1000')],
      income: [],
    });

    expect(report.lines[0].reason).toEqual({
      key: 'Altvermögen (acquired before 1 March 2021): exempt from KESt under §27b EStG.',
    });
  });

  it('states Neuvermögen as a translatable key', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '1000')],
      income: [],
    });

    expect(report.lines[0].reason).toEqual({
      key: 'Neuvermögen: taxable at the flat 27.5% KESt under §27a Abs. 1 EStG. No holding-period exemption applies.',
    });
  });
});

describe('austrian loss handling', () => {
  it('never estimates a negative KESt', () => {
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '-750')],
      income: [],
    });

    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.loss).toBe('750');
    expect(report.estimatedLiability).toBe('0');
  });
});

describe('what the austrian liability figure is', () => {
  it('describes the statutory KESt, not a German marginal rate', () => {
    // Austria computes estimatedLiability unconditionally from the
    // statutory 27.5% KESt - the user supplies no rate. Printing Germany's
    // caveat beside it claimed a marginal rate the user never entered, and
    // disclaimed a Solidaritätszuschlag, a Kirchensteuer and a progression
    // effect that do not exist here. KESt is an Endbesteuerung.
    const report = austrianTax.assess({
      year: 2024,
      matched: [disposalFrom(Date.UTC(2022, 0, 1), '1000')],
      income: [],
    });

    expect(report.estimatedLiability).toBe('275');
    expect(report.liabilityNote).toBe(
      'The statutory 27.5% KESt on the taxable gain. It is a final tax, so it does not depend on your other income.',
    );
  });
});
