import { describe, it, expect } from 'vitest';
import germanTax from '@/tax/jurisdictions/de';
import type { LedgerEvent } from '@/ledger/types';
import type { MatchedDisposal, TaxEvent } from '@/tax/types';
import { subtractAmounts } from '@/ledger/amount';

const disposal = (
  overrides: Partial<MatchedDisposal> & { heldDays: number; gain: string },
): MatchedDisposal => {
  // heldDays lives on ConsumedLot, not MatchedDisposal - spreading the whole
  // `overrides` object into the MatchedDisposal literal below would add it
  // as an excess property and fail strict typecheck. Destructuring it out
  // first keeps `rest` assignable to Partial<MatchedDisposal>.
  const { heldDays, ...rest } = overrides;

  return {
    disposalEventId: 'd1',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    partition: 'wallet-a',
    amount: '10',
    proceeds: '1000',
    timestamp: Date.UTC(2024, 5, 1),
    // subtractAmounts, not Number() arithmetic: the no-float rule applies to
    // test data too. A helper that builds fixtures through floats can hand
    // the assertion a value the production path would never produce, and the
    // test then passes against a number that is already wrong.
    costBasis: subtractAmounts('1000', overrides.gain),
    consumed: [
      {
        acquisitionEventId: 'a1',
        amount: '10',
        costBasis: subtractAmounts('1000', overrides.gain),
        acquiredAt: Date.UTC(2024, 5, 1) - heldDays * 86_400_000,
        heldDays,
      },
    ],
    ...rest,
  };
};

describe('german classification', () => {
  it('splits a crypto-to-crypto swap into a disposal and an acquisition', () => {
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

    const events = germanTax.classify(swap);
    expect(events.map((e) => e.kind).sort()).toEqual([
      'acquisition',
      'disposal',
    ]);
  });

  it('treats a staking reward as income', () => {
    const reward: LedgerEvent = {
      id: 'r1',
      sourceId: 's1',
      externalId: 'x',
      timestamp: Date.UTC(2024, 5, 1),
      kind: 'reward',
      origin: 'derived',
      note: 'staking reward (member), epoch 500',
      raw: { type: 'member' },
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '100',
          direction: 'in',
          venue: 'stake1',
          role: 'principal',
        },
      ],
    };

    const events = germanTax.classify(reward);
    // Income AND an acquisition: the value at receipt is taxed as income
    // and becomes the coins' cost basis for a later disposal.
    expect(events.map((e) => e.kind).sort()).toEqual(['acquisition', 'income']);
  });

  it('flags a leader reward as uncertain rather than classifying it', () => {
    const reward: LedgerEvent = {
      id: 'r2',
      sourceId: 's1',
      externalId: 'x',
      timestamp: Date.UTC(2024, 5, 1),
      kind: 'reward',
      origin: 'derived',
      raw: { type: 'leader' },
      legs: [
        {
          assetId: 'cardano:lovelace',
          amount: '100',
          direction: 'in',
          venue: 'stake1',
          role: 'principal',
        },
      ],
    };

    const income = germanTax
      .classify(reward)
      .find((event) => event.kind === 'income');
    expect(income?.note).toMatch(/uncertain|gewerblich/i);
  });

  it('partitions by venue, because German FIFO is per wallet', () => {
    const event = {
      sourceEventId: 'e',
      kind: 'disposal',
      assetId: 'cardano:lovelace',
      amount: '1',
      timestamp: 0,
      venue: 'wallet-q',
    } as TaxEvent;
    expect(germanTax.partitionBy(event)).toBe('wallet-q');
    expect(germanTax.defaultMatching).toBe('fifo');
  });
});

describe('german holding period', () => {
  it('exempts a lot held more than one year', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 366, gain: '5000' })],
      income: [],
    });
    expect(report.totals.exemptGain).toBe('5000');
    expect(report.totals.taxableGain).toBe('0');
  });

  it('taxes a lot held exactly one year', () => {
    // REVIEW FOCUS 1. The law exempts a period of MORE than one year, so
    // the anniversary itself is still taxable. An inclusive comparison
    // here makes a taxable gain disappear.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 365, gain: '5000' })],
      income: [],
    });
    expect(report.totals.taxableGain).toBe('5000');
    expect(report.totals.exemptGain).toBe('0');
  });

  it('splits a disposal that consumed lots on either side of the year', () => {
    // GOLDEN CASE 1. The whole reason lots are reported individually.
    const partly: MatchedDisposal = {
      disposalEventId: 'd-split',
      assetId: 'cardano:lovelace',
      venue: 'wallet-a',
      partition: 'wallet-a',
      amount: '10',
      proceeds: '1000',
      timestamp: Date.UTC(2024, 5, 1),
      costBasis: '200',
      gain: '800',
      consumed: [
        {
          acquisitionEventId: 'old',
          amount: '5',
          costBasis: '100',
          acquiredAt: Date.UTC(2024, 5, 1) - 430 * 86_400_000,
          heldDays: 430,
        },
        {
          acquisitionEventId: 'new',
          amount: '5',
          costBasis: '100',
          acquiredAt: Date.UTC(2024, 5, 1) - 90 * 86_400_000,
          heldDays: 90,
        },
      ],
    };

    const report = germanTax.assess({
      year: 2024,
      matched: [partly],
      income: [],
    });

    // Proceeds split by amount: 500 each. Exempt leg gains 400, taxable
    // leg gains 400 - that per-lot split is this test's whole point, and it
    // is unconditional: lines[0].exempt/taxable always reflect the holding
    // period split, regardless of the year's aggregate Freigrenze.
    //
    // DEVIATION FROM THE BRIEF: the brief's literal test code additionally
    // asserted `report.totals.taxableGain` to be '400' here, unconditioned
    // by the threshold. That contradicts both the §23 Abs. 3 Satz 5
    // Freigrenze test below (999 -> taxableGain '0') and REVIEW FOCUS 4
    // (a combined 800 across two disposals -> taxableGain '0'): in every
    // other test in this suite, `totals.taxableGain` is the YEAR'S total
    // taxable-side gain after the Freigrenze is applied, not the raw
    // per-line sum. This disposal's only taxable lot gains 400, which is
    // below the €1,000 2024 limit, so the Freigrenze exempts it and the
    // correct total is '0'. `totals.exemptGain` is unaffected by the
    // Freigrenze (it is a different exemption, the one-year holding
    // period) and stays '400'.
    expect(report.totals.exemptGain).toBe('400');
    expect(report.totals.taxableGain).toBe('0');
    expect(report.lines[0].exempt).toBe('400');
    expect(report.lines[0].taxable).toBe('400');
  });
});

describe('german Freigrenze', () => {
  it('exempts a total gain of 999 in 2024', () => {
    // GOLDEN CASE 2.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '999' })],
      income: [],
    });
    expect(report.totals.taxableGain).toBe('0');
    expect(report.thresholds[0]).toMatchObject({
      limit: '1000',
      actual: '999',
      exceeded: false,
      kind: 'freigrenze',
    });
  });

  it('taxes the whole gain at exactly 1000 in 2024', () => {
    // GOLDEN CASE 2, the other side. A Freigrenze taxes everything once
    // reached - not the 0 of excess. Treating it as a Freibetrag would
    // report nothing owed on a fully taxable gain.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '1000' })],
      income: [],
    });
    expect(report.totals.taxableGain).toBe('1000');
    expect(report.thresholds[0].exceeded).toBe(true);
  });

  it('uses the 600 limit for 2023 and 1000 for 2024', () => {
    // GOLDEN CASE 5. Identical gains, different years, different answers.
    const matched = [disposal({ heldDays: 10, gain: '800' })];
    const y2023 = germanTax.assess({ year: 2023, matched, income: [] });
    const y2024 = germanTax.assess({ year: 2024, matched, income: [] });

    expect(y2023.thresholds[0].limit).toBe('600');
    expect(y2023.totals.taxableGain).toBe('800');
    expect(y2024.thresholds[0].limit).toBe('1000');
    expect(y2024.totals.taxableGain).toBe('0');
  });

  it('nets a loss into the threshold test', () => {
    // REVIEW FOCUS 4. The threshold tests the year's TOTAL gain, so a loss
    // reduces it. Testing gross gains would tax someone who made nothing
    // on the year.
    const report = germanTax.assess({
      year: 2024,
      matched: [
        disposal({ disposalEventId: 'win', heldDays: 10, gain: '1200' }),
        disposal({ disposalEventId: 'lose', heldDays: 10, gain: '-400' }),
      ],
      income: [],
    });
    expect(report.thresholds[0].actual).toBe('800');
    expect(report.totals.taxableGain).toBe('0');
  });
});

describe('german losses', () => {
  it('does not let a private-sale loss reduce staking income', () => {
    // GOLDEN CASE 6. §23 losses offset only §23 gains.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '-5000' })],
      income: [
        {
          sourceEventId: 'r',
          kind: 'income',
          assetId: 'cardano:lovelace',
          amount: '1',
          timestamp: Date.UTC(2024, 5, 1),
          venue: 'stake1',
          value: '900',
        },
      ],
    });
    expect(report.totals.income).toBe('900');
    expect(report.totals.taxableGain).toBe('0');
  });
});

describe('german staking income threshold', () => {
  it('exempts staking income under 256', () => {
    // GOLDEN CASE 7.
    const report = germanTax.assess({
      year: 2024,
      matched: [],
      income: [
        {
          sourceEventId: 'r',
          kind: 'income',
          assetId: 'cardano:lovelace',
          amount: '1',
          timestamp: Date.UTC(2024, 5, 1),
          venue: 'stake1',
          value: '255',
        },
      ],
    });
    const threshold = report.thresholds.find((t) => t.limit === '256');
    expect(threshold?.exceeded).toBe(false);
    expect(report.totals.income).toBe('0');
  });

  it('taxes all staking income at exactly 256', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [],
      income: [
        {
          sourceEventId: 'r',
          kind: 'income',
          assetId: 'cardano:lovelace',
          amount: '1',
          timestamp: Date.UTC(2024, 5, 1),
          venue: 'stake1',
          value: '256',
        },
      ],
    });
    expect(report.totals.income).toBe('256');
  });
});

describe('german rate handling', () => {
  it('applies no rate unless one is supplied', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '5000' })],
      income: [],
    });
    expect(report.estimatedLiability).toBeUndefined();
  });

  it('estimates with the solidarity surcharge when a rate is given', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '1000' })],
      income: [],
      rate: '42',
    });
    // 1000 at 42% = 420, plus 5.5% Soli on the tax = 443.1.
    expect(report.estimatedLiability).toBe('443.1');
  });
});

describe('german rationales', () => {
  it('states a fully exempt holding period as a translatable key', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 400, gain: '500' })],
      income: [],
    });

    expect(report.lines[0].reason).toEqual({
      key: 'Held more than one year, so the gain is tax-free under §23 Abs. 1 Nr. 2 EStG.',
    });
  });

  it('states a fully taxable holding period as a translatable key', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '500' })],
      income: [],
    });

    expect(report.lines[0].reason).toEqual({
      key: 'Held one year or less, so the gain is taxable under §23 Abs. 1 Nr. 2 EStG.',
    });
  });

  it('names both sides when a disposal straddles the one-year boundary', () => {
    const split = disposal({ heldDays: 400, gain: '600' });
    split.consumed = [
      {
        acquisitionEventId: 'old',
        amount: '5',
        costBasis: '200',
        acquiredAt: Date.UTC(2024, 5, 1) - 400 * 86_400_000,
        heldDays: 400,
      },
      {
        acquisitionEventId: 'new',
        amount: '5',
        costBasis: '200',
        acquiredAt: Date.UTC(2024, 5, 1) - 10 * 86_400_000,
        heldDays: 10,
      },
    ];

    const report = germanTax.assess({
      year: 2024,
      matched: [split],
      income: [],
    });

    expect(report.lines[0].reason.key).toBe(
      'Split disposal: the lots held more than one year are tax-free under §23 Abs. 1 Nr. 2 EStG, the rest was held one year or less and is taxable.',
    );
  });
});
