import { describe, it, expect } from 'vitest';
import germanTax, { heldMoreThanOneYear } from '@/tax/jurisdictions/de';
import austrianTax from '@/tax/jurisdictions/at';
import type { LedgerEvent, RewardKind } from '@/ledger/types';
import type { MatchedDisposal, TaxEvent } from '@/tax/types';
import { subtractAmounts } from '@/ledger/amount';
import { legacyRewardKind } from '@/tax/rewardKinds';

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
    costs: '0',
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
  const trade = (
    legs: LedgerEvent['legs'],
    kind: LedgerEvent['kind'] = 'trade',
  ): LedgerEvent => ({
    id: 't',
    sourceId: 's1',
    externalId: 'x',
    timestamp: Date.UTC(2024, 5, 1),
    kind,
    origin: 'derived',
    legs,
  });

  it('attaches a fiat fee on a sell to the disposal, and emits no disposal of the fee', () => {
    const events = germanTax.classify(
      trade([
        {
          assetId: 'cardano:lovelace',
          amount: '100',
          direction: 'out',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '50',
          direction: 'in',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '1',
          direction: 'out',
          venue: 'kraken',
          role: 'fee',
        },
      ]),
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('disposal');
    expect(events[0].costs).toEqual([{ assetId: 'fiat:eur', amount: '1' }]);
  });

  it('attaches a fiat fee on a buy to the acquisition', () => {
    const events = germanTax.classify(
      trade([
        {
          assetId: 'fiat:eur',
          amount: '50',
          direction: 'out',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'cardano:lovelace',
          amount: '100',
          direction: 'in',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '2',
          direction: 'out',
          venue: 'kraken',
          role: 'fee',
        },
      ]),
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('acquisition');
    expect(events[0].costs).toEqual([{ assetId: 'fiat:eur', amount: '2' }]);
  });

  it('attaches a crypto fee on a swap to the disposal AND disposes of the fee coins', () => {
    const events = germanTax.classify(
      trade([
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
        {
          assetId: 'cardano:lovelace',
          amount: '1',
          direction: 'out',
          venue: 'wallet-a',
          role: 'fee',
        },
      ]),
    );

    const disposals = events.filter((e) => e.kind === 'disposal');
    const acquisition = events.find((e) => e.kind === 'acquisition');
    expect(disposals.map((e) => e.amount).sort()).toEqual(['1', '100']);
    expect(disposals.find((e) => e.amount === '100')?.costs).toEqual([
      { assetId: 'cardano:lovelace', amount: '1' },
    ]);
    // The fee coins' own disposal carries no costs, and neither does the
    // acquisition: the fee is deducted exactly once.
    expect(disposals.find((e) => e.amount === '1')?.costs).toBeUndefined();
    expect(acquisition?.costs).toBeUndefined();
  });

  it('leaves a fee on a transfer as a plain disposal with nothing attached', () => {
    // Guards that gas is never attached as a cost to a transfer. A send to
    // a third party is not a sale, so there is
    // nothing to deduct the gas from. The fee coins still left.
    const events = germanTax.classify(
      trade(
        [
          {
            assetId: 'eth:native',
            amount: '1000',
            direction: 'out',
            venue: 'wallet-e',
            role: 'principal',
          },
          {
            assetId: 'eth:native',
            amount: '21',
            direction: 'out',
            venue: 'wallet-e',
            role: 'fee',
          },
        ],
        'transfer',
      ),
    );

    expect(events.map((e) => e.kind)).toEqual(['disposal', 'disposal']);
    expect(events.every((e) => e.costs === undefined)).toBe(true);
  });

  it('values a euro buy at the euro paid, not the market price', () => {
    const events = germanTax.classify(
      trade([
        {
          assetId: 'fiat:eur',
          amount: '500',
          direction: 'out',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'bitcoin:native',
          amount: '1000000',
          direction: 'in',
          venue: 'kraken',
          role: 'principal',
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].consideration).toEqual({
      assetId: 'fiat:eur',
      amount: '500',
    });
  });

  it('carries both the consideration and the fee costs on a euro buy with a euro fee', () => {
    const events = germanTax.classify(
      trade([
        {
          assetId: 'fiat:eur',
          amount: '500',
          direction: 'out',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'bitcoin:native',
          amount: '1000000',
          direction: 'in',
          venue: 'kraken',
          role: 'principal',
        },
        {
          assetId: 'fiat:eur',
          amount: '1.3',
          direction: 'out',
          venue: 'kraken',
          role: 'fee',
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('acquisition');
    expect(events[0].consideration).toEqual({
      assetId: 'fiat:eur',
      amount: '500',
    });
    expect(events[0].costs).toEqual([{ assetId: 'fiat:eur', amount: '1.3' }]);
  });

  it('values a swap at market: no consideration', () => {
    const events = germanTax.classify(
      trade([
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
      ]),
    );
    expect(events.every((event) => event.consideration === undefined)).toBe(
      true,
    );
  });
});

describe('german holding period', () => {
  it('exempts a lot held more than one year', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 367, gain: '5000' })],
      income: [],
      capital: [],
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
      capital: [],
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
      costs: '0',
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
      capital: [],
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
      capital: [],
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
      capital: [],
    });
    expect(report.totals.taxableGain).toBe('1000');
    expect(report.thresholds[0].exceeded).toBe(true);
  });

  it('uses the 600 limit for 2023 and 1000 for 2024', () => {
    // GOLDEN CASE 5. Identical gains, different years, different answers.
    const matched = [disposal({ heldDays: 10, gain: '800' })];
    const y2023 = germanTax.assess({
      year: 2023,
      matched,
      income: [],
      capital: [],
    });
    const y2024 = germanTax.assess({
      year: 2024,
      matched,
      income: [],
      capital: [],
    });

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
      capital: [],
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
      capital: [],
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
      capital: [],
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
      capital: [],
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
      capital: [],
    });
    expect(report.estimatedLiability).toBeUndefined();
  });

  it('estimates the rate alone, adding no surcharge nobody may owe', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '1000' })],
      income: [],
      capital: [],
      rate: '42',
    });
    // 1000 at 42% = 420, exactly. The flat 5.5% Solidaritätszuschlag this
    // used to add unconditionally is owed only once the ASSESSED INCOME TAX
    // passes its own Freigrenze - a figure no crypto gain and marginal rate
    // can produce - so it overstated the estimate for most private
    // taxpayers. Kirchensteuer and progression are not modelled either, and
    // the report now says all three in words instead.
    expect(report.estimatedLiability).toBe('420');
  });
});

describe('german rationales', () => {
  it('states a fully exempt holding period as a translatable key', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 400, gain: '500' })],
      income: [],
      capital: [],
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
      capital: [],
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
      capital: [],
    });

    expect(report.lines[0].reason.key).toBe(
      'Split disposal: the lots held more than one year are tax-free under §23 Abs. 1 Nr. 2 EStG, the rest was held one year or less and is taxable.',
    );
  });
});

describe('german loss handling', () => {
  it('reports a losing year as a declarable loss, not as a tax-free zero', () => {
    // §23 Abs. 3 Satz 7-8 EStG: a private-sale loss offsets other
    // private-sale gains, carried back or forward - but only once it has
    // been DECLARED. A report that folds a negative year into the same
    // "0,00 €" it shows for a year under the Freigrenze costs the user the
    // whole carry-forward while looking entirely reassuring.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '-750' })],
      income: [],
      capital: [],
    });

    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.loss).toBe('750');
  });

  it('reports no loss for a year that is merely under the threshold', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '300' })],
      income: [],
      capital: [],
    });

    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.loss).toBe('0');
  });
});

describe('german threshold scope notes', () => {
  it('scopes the "all private sales" note to §23, never to §22 Nr. 3 income', () => {
    // The §23 Freigrenze really does span every private sale in the year -
    // gold, art, a property sold inside ten years. The §22 Nr. 3 Freigrenze
    // covers Einkünfte aus Leistungen and nothing of the sort, and this
    // module's own assess() keeps the two independent. A note printed under
    // both tells the reader that staking income consumes a private-sale
    // allowance, which is wrong in both directions.
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '500' })],
      income: [],
      capital: [],
    });

    const [privateSale, otherIncome] = report.thresholds;
    expect(privateSale.scopeNote).toBe(
      'This limit covers every private sale you made in the year, not only crypto.',
    );
    expect(otherIncome.label).toBe(
      'Tax-free threshold for other income (§22 Nr. 3 EStG)',
    );
    expect(otherIncome.scopeNote).toBe(
      'This limit covers all of your income under §22 Nr. 3 EStG in the year, not only crypto rewards.',
    );
  });
});

describe('what the estimated liability leaves out', () => {
  it('says in its own words what is not in the figure', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '2000' })],
      income: [],
      capital: [],
      rate: '42',
    });

    expect(report.liabilityNote).toBe(
      'Your marginal rate applied to the taxable gain. It does not include solidarity surcharge, church tax, or the effect on your overall progression.',
    );
  });

  it('offers no note when it offers no figure', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain: '2000' })],
      income: [],
      capital: [],
    });

    expect(report.estimatedLiability).toBeUndefined();
    expect(report.liabilityNote).toBeUndefined();
  });
});

describe('german holding period runs by calendar date', () => {
  // Gain 5000 so the 2024 Freigrenze of 1000 is comfortably exceeded and
  // the taxable total reads the holding-period decision alone.
  const disposalOn = (
    acquiredAt: number,
    disposedAt: number,
  ): MatchedDisposal => ({
    disposalEventId: 'd-cal',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    partition: 'wallet-a',
    amount: '10',
    proceeds: '6000',
    costBasis: '1000',
    gain: '5000',
    costs: '0',
    timestamp: disposedAt,
    consumed: [
      {
        acquisitionEventId: 'a-cal',
        amount: '10',
        costBasis: '1000',
        acquiredAt,
        heldDays: Math.floor((disposedAt - acquiredAt) / 86_400_000),
      },
    ],
  });

  const taxableGainOf = (acquiredAt: number, disposedAt: number): string =>
    germanTax.assess({
      year: new Date(disposedAt).getUTCFullYear(),
      matched: [disposalOn(acquiredAt, disposedAt)],
      income: [],
      capital: [],
    }).totals.taxableGain;

  it('taxes a sale on the anniversary even when a leap day made it 366 days', () => {
    // 1 March 2023 to 1 March 2024 spans 29 February 2024: 366 days, and
    // still the anniversary. §188 Abs. 2 BGB ends the period WITH that
    // day, so the sale is inside it. A day count of 366 > 365 exempted it.
    expect(taxableGainOf(Date.UTC(2023, 2, 1), Date.UTC(2024, 2, 1))).toBe(
      '5000',
    );
  });

  it('exempts the day after the anniversary', () => {
    expect(taxableGainOf(Date.UTC(2023, 2, 1), Date.UTC(2024, 2, 2))).toBe('0');
  });

  it('ends a period that began on 29 February with 28 February', () => {
    // §188 Abs. 3 BGB: the following year has no 29 February, so the
    // period ends with the last day of that month.
    expect(taxableGainOf(Date.UTC(2024, 1, 29), Date.UTC(2025, 1, 28))).toBe(
      '5000',
    );
    expect(taxableGainOf(Date.UTC(2024, 1, 29), Date.UTC(2025, 2, 1))).toBe(
      '0',
    );
  });

  it('decides by calendar day, not by elapsed hours', () => {
    const lateEvening = Date.UTC(2024, 5, 1, 23, 59);
    // 00:01 on the anniversary: 364.99 days elapsed, still the anniversary.
    expect(taxableGainOf(lateEvening, Date.UTC(2025, 5, 1, 0, 1))).toBe('5000');
    // Midnight the day after: exempt, however few hours over a year.
    expect(taxableGainOf(lateEvening, Date.UTC(2025, 5, 2, 0, 0))).toBe('0');
  });

  it('exposes the decision so the boundary can be read directly', () => {
    expect(
      heldMoreThanOneYear(Date.UTC(2023, 2, 1), Date.UTC(2024, 2, 1)),
    ).toBe(false);
    expect(
      heldMoreThanOneYear(Date.UTC(2023, 2, 1), Date.UTC(2024, 2, 2)),
    ).toBe(true);
  });
});

describe('german reward kinds', () => {
  const reward = (
    kind?: RewardKind,
    legs?: LedgerEvent['legs'],
    extra: Partial<LedgerEvent> = {},
  ): LedgerEvent => ({
    id: 'r',
    sourceId: 's1',
    externalId: 'x',
    timestamp: Date.UTC(2025, 5, 1),
    kind: 'reward',
    origin: 'derived',
    ...(kind === undefined ? {} : { rewardKind: kind }),
    legs: legs ?? [
      {
        assetId: 'cardano:lovelace',
        amount: '100',
        direction: 'in',
        venue: 'w',
        role: 'principal',
      },
    ],
    ...extra,
  });
  const incomeNote = (event: LedgerEvent) =>
    germanTax.classify(event).find((one) => one.kind === 'income')?.note;

  it.each(['staking', 'lending', 'liquidity'] as const)(
    '%s is income plus acquisition with no note',
    (kind) => {
      const events = germanTax.classify(reward(kind));
      expect(events.map((e) => e.kind).sort()).toEqual([
        'acquisition',
        'income',
      ]);
      expect(incomeNote(reward(kind))).toBeUndefined();
    },
  );

  it.each(['leader', 'mining', 'masternode'] as const)(
    '%s carries the business-income note',
    (kind) => {
      expect(incomeNote(reward(kind))).toMatch(/gewerblich/);
    },
  );

  it('notes an airdrop as received for a counter-performance', () => {
    expect(incomeNote(reward('airdrop'))).toMatch(
      /counter-performance|Gegenleistung/i,
    );
    // Points at the guidance rather than asserting the alternative outcome.
    expect(incomeNote(reward('airdrop'))).toMatch(/BMF 06\.03\.2025/);
  });

  it('notes an other reward as unspecified by the source', () => {
    expect(incomeNote(reward('other'))).toMatch(/did not say/);
  });

  it('treats a fork as a zero-cost acquisition and no income', () => {
    const events = germanTax.classify(reward('fork'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'acquisition',
      consideration: { assetId: 'cardano:lovelace', amount: '0' },
    });
  });

  it('returns nothing for a reward no signal can name', () => {
    expect(germanTax.classify(reward())).toEqual([]);
  });

  it('reads the legacy member record as staking', () => {
    const events = germanTax.classify(
      reward(undefined, undefined, { raw: { type: 'member' } }),
    );
    expect(events.map((e) => e.kind).sort()).toEqual(['acquisition', 'income']);
  });

  it('never reads a Cardano deposit refund as staking from its note', () => {
    // The translator's note says "staking reward (...)" for every provider
    // record; the record's own type decides, so the note cannot promote a
    // pool deposit refund into staking income.
    const refund = reward(undefined, undefined, {
      raw: { type: 'pool_deposit_refund' },
      note: 'staking reward (pool_deposit_refund), epoch 1',
    });
    expect(legacyRewardKind(refund)).toBeUndefined();
    expect(germanTax.classify(refund)).toEqual([]);
  });

  it('takes the income amount from the principal leg, not a fee leg', () => {
    const events = germanTax.classify(
      reward('staking', [
        {
          assetId: 'cardano:lovelace',
          amount: '1',
          direction: 'out',
          venue: 'w',
          role: 'fee',
        },
        {
          assetId: 'cardano:lovelace',
          amount: '100',
          direction: 'in',
          venue: 'w',
          role: 'principal',
        },
      ]),
    );
    expect(events.find((e) => e.kind === 'income')?.amount).toBe('100');
  });
});

describe('german derivatives', () => {
  const derivative = (
    legs: {
      asset: string;
      direction: 'in' | 'out';
      role?: 'principal' | 'fee';
    }[],
  ): LedgerEvent => ({
    id: 'dv',
    sourceId: 's1',
    externalId: 'dv',
    timestamp: Date.UTC(2024, 5, 1),
    kind: 'derivative',
    derivative: { kind: 'pnl' },
    origin: 'derived',
    legs: legs.map((one) => ({
      assetId: one.asset,
      amount: '5',
      direction: one.direction,
      venue: 'ex',
      role: one.role ?? 'principal',
    })),
  });
  const kinds = (event: LedgerEvent) =>
    germanTax.classify(event).map((one) => one.kind);

  it('classifies fiat settlements as capital events only', () => {
    expect(kinds(derivative([{ asset: 'fiat:eur', direction: 'in' }]))).toEqual(
      ['capital-gain'],
    );
    expect(
      kinds(derivative([{ asset: 'fiat:eur', direction: 'out' }])),
    ).toEqual(['capital-loss']);
    expect(
      kinds(derivative([{ asset: 'fiat:eur', direction: 'out', role: 'fee' }])),
    ).toEqual(['capital-loss']);
  });

  it('adds an acquisition or disposal for crypto settlements', () => {
    const btc = 'bitcoin:native';
    const gain = germanTax.classify(
      derivative([{ asset: btc, direction: 'in' }]),
    );
    expect(gain.map((one) => one.kind)).toEqual([
      'capital-gain',
      'acquisition',
    ]);
    expect(gain[0].amount).toBe(gain[1].amount);
    expect(kinds(derivative([{ asset: btc, direction: 'out' }]))).toEqual([
      'capital-loss',
      'disposal',
    ]);
    expect(
      kinds(derivative([{ asset: btc, direction: 'out', role: 'fee' }])),
    ).toEqual(['capital-loss', 'disposal']);
  });

  it('is handled by Germany and not by Austria', () => {
    expect(germanTax.handles).toContain('derivative');
    expect(austrianTax.handles).not.toContain('derivative');
    expect(
      austrianTax.classify(
        derivative([{ asset: 'fiat:eur', direction: 'in' }]),
      ),
    ).toEqual([]);
  });

  const capitalEvent = (
    kind: 'capital-gain' | 'capital-loss',
    value: string,
  ): TaxEvent => ({
    sourceEventId: `c-${kind}-${value}`,
    kind,
    assetId: 'fiat:eur',
    amount: value,
    timestamp: Date.UTC(2024, 5, 1),
    venue: 'ex',
    value,
  });
  const assessCapital = (year: number, events: TaxEvent[]) =>
    germanTax.assess({
      year,
      matched: [],
      income: [],
      capital: events,
    });

  it('nets gains and losses inside the allowance', () => {
    const result = assessCapital(2024, [
      capitalEvent('capital-gain', '500'),
      capitalEvent('capital-loss', '200'),
      capitalEvent('capital-loss', '5'),
    ]);
    expect(result.capital).toMatchObject({
      gains: '500',
      losses: '205',
      net: '295',
      allowance: '1000',
      taxable: '0',
      loss: '0',
      estimatedTax: '0',
    });
    expect(result.thresholds).toHaveLength(3);
    expect(result.thresholds[2]).toMatchObject({
      label: "Saver's allowance (§20 Abs. 9 EStG)",
      kind: 'freibetrag',
    });
    expect(result.thresholds[2].scopeNote).toBeDefined();
    expect(result.thresholds[0].label).toMatch(/§23/);
    expect(result.thresholds[1].label).toMatch(/§22/);
  });

  it('taxes only the excess over the allowance at 25 percent', () => {
    expect(
      assessCapital(2024, [capitalEvent('capital-gain', '3000')]).capital,
    ).toMatchObject({ taxable: '2000', estimatedTax: '500' });
    expect(
      assessCapital(2022, [capitalEvent('capital-gain', '3000')]).capital,
    ).toMatchObject({ allowance: '801', taxable: '2199' });
  });

  it('owes nothing at exactly the allowance', () => {
    const result = assessCapital(2024, [capitalEvent('capital-gain', '1000')]);
    expect(result.capital?.taxable).toBe('0');
    expect(result.thresholds[2].exceeded).toBe(false);
  });

  it('carries a net loss forward', () => {
    const result = assessCapital(2024, [
      capitalEvent('capital-loss', '700'),
      capitalEvent('capital-gain', '100'),
    ]);
    expect(result.capital).toMatchObject({
      net: '-600',
      loss: '600',
      taxable: '0',
    });
  });

  it('adds nothing without capital input and never changes §23 totals', () => {
    const matched = [disposal({ heldDays: 10, gain: '1500' })];
    const base = germanTax.assess({
      year: 2024,
      matched,
      income: [],
      capital: [],
    });
    const withCapital = germanTax.assess({
      year: 2024,
      matched,
      income: [],
      capital: [capitalEvent('capital-loss', '700')],
    });
    expect(base.capital).toBeUndefined();
    expect(base.thresholds).toHaveLength(2);
    expect(withCapital.totals).toEqual(base.totals);
  });

  const MARGIN_NOTE =
    'Margin trading is treated here as a Termingeschäft under §20 EStG. German practice is divided; it may instead be a §23 private sale at your personal rate. Confirm which applies.';
  const ROLLOVER_NOTE =
    'A margin rollover is a financing cost. It is shown here but not deducted: §20 Abs. 9 EStG allows no actual Werbungskosten beyond the allowance. Confirm whether it is deductible in your case.';

  it('says a margin settlement is a contested §20 reading', () => {
    const events = germanTax.classify({
      ...derivative([{ asset: 'fiat:eur', direction: 'in' }]),
      derivative: { kind: 'pnl', product: 'margin' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].note).toBe(MARGIN_NOTE);
    expect(events[0].deductible).toBeUndefined();
  });

  it('records a rollover fee as a loss it does not deduct', () => {
    const btc = 'bitcoin:native';
    const events = germanTax.classify({
      ...derivative([{ asset: btc, direction: 'out', role: 'fee' }]),
      derivative: { kind: 'rollover', product: 'margin' },
    });
    expect(events[0]).toMatchObject({
      kind: 'capital-loss',
      deductible: false,
      note: ROLLOVER_NOTE,
    });
    // The coins still left: the disposal is a plain one.
    expect(events[1].kind).toBe('disposal');
    expect(events[1].note).toBeUndefined();
    expect(events[1].deductible).toBeUndefined();
  });

  it('keeps an undeducted loss out of the losses and the net', () => {
    const result = assessCapital(2024, [
      { ...capitalEvent('capital-loss', '5'), deductible: false },
      capitalEvent('capital-loss', '200'),
    ]);
    expect(result.capital).toMatchObject({
      losses: '200',
      notDeducted: '5',
      net: '-200',
      loss: '200',
    });
  });

  it('adds no note to a futures settlement', () => {
    const events = germanTax.classify({
      ...derivative([{ asset: 'fiat:eur', direction: 'out' }]),
      derivative: { kind: 'pnl', product: 'futures' },
    });
    expect(events[0].note).toBeUndefined();
  });
});

describe('german loss carry-forward', () => {
  const run = (
    gain: string,
    carryForward?: { privateSales?: string; capital?: string },
  ) =>
    germanTax.assess({
      year: 2024,
      matched: [disposal({ heldDays: 10, gain })],
      income: [],
      capital: [],
      carryForward,
    });

  const capitalEvent = (
    kind: 'capital-gain' | 'capital-loss',
    value: string,
  ): TaxEvent => ({
    sourceEventId: `c-${kind}-${value}`,
    kind,
    assetId: 'fiat:eur',
    amount: value,
    timestamp: Date.UTC(2024, 5, 1),
    venue: 'ex',
    value,
  });
  const runCapital = (events: TaxEvent[], carryForward: { capital?: string }) =>
    germanTax.assess({
      year: 2024,
      matched: [],
      income: [],
      capital: events,
      carryForward,
    });

  it('reduces a taxable gain by the declared loss', () => {
    const report = run('2000', { privateSales: '500' });
    expect(report.totals.taxableGain).toBe('1500');
    expect(report.carryForward?.privateSales).toEqual({
      declared: '500',
      used: '500',
      remaining: '0',
    });
  });

  it('uses no more than the gain and keeps the rest', () => {
    const report = run('2000', { privateSales: '5000' });
    expect(report.totals.taxableGain).toBe('0');
    expect(report.carryForward?.privateSales).toEqual({
      declared: '5000',
      used: '2000',
      remaining: '3000',
    });
  });

  it('tests the Freigrenze before the carry-forward', () => {
    const report = run('800', { privateSales: '500' });
    expect(report.totals.taxableGain).toBe('0');
    expect(report.carryForward?.privateSales).toEqual({
      declared: '500',
      used: '0',
      remaining: '500',
    });
  });

  it('uses nothing in a loss year', () => {
    const report = run('-400', { privateSales: '500' });
    expect(report.totals.loss).toBe('400');
    expect(report.carryForward?.privateSales).toEqual({
      declared: '500',
      used: '0',
      remaining: '500',
    });
  });

  it('is unchanged without a carry-forward', () => {
    const report = run('2000');
    expect(report.carryForward).toBeUndefined();
    expect(report.totals.taxableGain).toBe('2000');
  });

  it('treats a declared zero as no carry-forward', () => {
    const report = run('2000', { privateSales: '0' });
    expect(report.carryForward).toBeUndefined();
    expect(report.totals.taxableGain).toBe('2000');
  });

  it('applies a §20 carry-forward before the allowance', () => {
    const report = runCapital([capitalEvent('capital-gain', '1500')], {
      capital: '600',
    });
    expect(report.capital?.carryForwardUsed).toBe('600');
    expect(report.capital?.taxable).toBe('0');
    expect(report.carryForward?.capital).toEqual({
      declared: '600',
      used: '600',
      remaining: '0',
    });
  });

  it('reports the saver threshold on the post-carry figure', () => {
    const saver = (carry?: string) =>
      runCapital(
        [capitalEvent('capital-gain', '1500')],
        carry === undefined ? {} : { capital: carry },
      ).thresholds.find((threshold) => threshold.kind === 'freibetrag');
    expect(saver('600')).toMatchObject({ actual: '900', exceeded: false });
    expect(saver()).toMatchObject({ actual: '1500', exceeded: true });
  });

  it('uses no §20 carry-forward against a net loss', () => {
    const report = runCapital([capitalEvent('capital-loss', '100')], {
      capital: '600',
    });
    expect(report.capital?.carryForwardUsed).toBe('0');
    expect(report.carryForward?.capital).toEqual({
      declared: '600',
      used: '0',
      remaining: '600',
    });
  });

  it('advertises support in the manifest, for Germany only', () => {
    expect(germanTax.manifest.supportsCarryForward).toBe(true);
    expect(austrianTax.manifest.supportsCarryForward).toBeUndefined();
  });
});

describe('german filing figures', () => {
  const at = Date.UTC(2025, 5, 1);
  const lotOf = (id: string, heldDays: number) => ({
    acquisitionEventId: id,
    amount: '5',
    costBasis: '200',
    acquiredAt: at - heldDays * 86_400_000,
    heldDays,
  });
  // Lot A held 400 days (exempt), lot B 10 days (taxable): proceeds 1000
  // over 10 units, 500 each side, cost 200 each.
  const split = (
    overrides: Partial<MatchedDisposal> = {},
  ): MatchedDisposal => ({
    disposalEventId: 'd-filing',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    partition: 'wallet-a',
    amount: '10',
    proceeds: '1000',
    timestamp: at,
    costBasis: '400',
    gain: '600',
    costs: '0',
    consumed: [lotOf('a', 400), lotOf('b', 10)],
    ...overrides,
  });
  const incomeEvent = (value: string): TaxEvent => ({
    sourceEventId: 'r1',
    kind: 'income',
    assetId: 'cardano:lovelace',
    amount: '1',
    timestamp: at,
    venue: 'stake1',
    value,
  });
  const capitalEvent = (
    kind: 'capital-gain' | 'capital-loss',
    value: string,
    deductible?: boolean,
  ): TaxEvent => ({
    sourceEventId: `c-${kind}-${value}`,
    kind,
    assetId: 'fiat:eur',
    amount: value,
    timestamp: at,
    venue: 'ex',
    value,
    ...(deductible === undefined ? {} : { deductible }),
  });
  const entry = (
    report: ReturnType<typeof germanTax.assess>,
    section: number,
    line: number,
  ) =>
    report.filing?.sections[section].entries.find(
      (e) => e.reference?.line === line,
    );

  it('reports the taxable side of a split disposal', () => {
    const [line] = germanTax.assess({
      year: 2025,
      matched: [split()],
      income: [],
      capital: [],
    }).lines;
    expect(line.taxableProceeds).toBe('500');
    expect(line.taxableCostBasis).toBe('200');
  });

  it('builds the 2025 figures with their form lines', () => {
    const report = germanTax.assess({
      year: 2025,
      matched: [split({ costs: '3' })],
      income: [incomeEvent('300')],
      capital: [
        capitalEvent('capital-gain', '500'),
        capitalEvent('capital-loss', '205'),
        capitalEvent('capital-loss', '9', false),
      ],
    });
    expect(report.filing?.year).toBe(2025);
    expect(report.filing?.linesVerified).toBe(true);
    expect(report.filing?.sections.map((s) => s.form)).toEqual([
      'Anlage SO',
      'Anlage SO',
      'Anlage KAP',
    ]);

    // MatchedDisposal.proceeds is already NET of the costs, so the gross
    // the form asks for adds the taxable-side share back: 500 + 1.5. The
    // result is then the taxable gain, 501.5 - 200 - 1.5 = 300.
    expect(entry(report, 0, 48)?.amount).toBe('501.5');
    expect(entry(report, 0, 49)?.amount).toBe('200');
    expect(entry(report, 0, 50)?.amount).toBe('1.5');
    expect(entry(report, 0, 51)?.amount).toBe('300');
    expect(entry(report, 0, 58)?.amount).toBe('300');
    expect(entry(report, 0, 51)?.reference?.form).toBe('Anlage SO');
    expect(entry(report, 0, 47)?.text).toBe('01.01.2025 – 31.12.2025');
    expect(entry(report, 0, 45)?.text).toBe('1');
    expect(entry(report, 0, 46)?.text).toBe('Kryptowerte');

    expect(entry(report, 1, 14)?.text).toBe('1');
    expect(entry(report, 1, 15)?.text).toBe(
      'Staking, Lending, Airdrops (Kryptowerte)',
    );
    expect(entry(report, 1, 18)?.amount).toBe('300');
    expect(entry(report, 1, 19)?.amount).toBe('0');
    expect(entry(report, 1, 20)?.amount).toBe('300');

    // Gross deductible losses only; the not-deducted loss never appears.
    expect(entry(report, 2, 19)?.amount).toBe('500');
    expect(entry(report, 2, 22)?.amount).toBe('205');
    expect(entry(report, 2, 19)?.reference?.form).toBe('Anlage KAP');
  });

  it('prints a fully taxable disposal with its full costs', () => {
    const report = germanTax.assess({
      year: 2025,
      matched: [
        split({
          costs: '4',
          proceeds: '996',
          costBasis: '400',
          consumed: [lotOf('a', 10), lotOf('b', 10)],
        }),
      ],
      income: [],
      capital: [],
    });
    expect(entry(report, 0, 50)?.amount).toBe('4');
    expect(entry(report, 0, 48)?.amount).toBe('1000');
  });

  it('leaves the line references off a year whose lines are unverified', () => {
    const report = germanTax.assess({
      year: 2024,
      matched: [split()],
      income: [incomeEvent('300')],
      capital: [capitalEvent('capital-gain', '5')],
    });
    expect(report.filing?.linesVerified).toBe(false);
    const entries = report.filing?.sections.flatMap((s) => s.entries) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.reference === undefined)).toBe(true);
    expect(entries.find((e) => e.amount === '300')).toBeDefined();
  });

  it('has no private-sales section when only exempt lots were sold', () => {
    const report = germanTax.assess({
      year: 2025,
      matched: [split({ consumed: [lotOf('a', 400), lotOf('b', 500)] })],
      income: [],
      capital: [],
    });
    expect(report.filing).toBeUndefined();
  });

  it('carries a negative result for a loss year', () => {
    const report = germanTax.assess({
      year: 2025,
      matched: [
        split({
          proceeds: '100',
          costBasis: '400',
          gain: '-300',
          consumed: [lotOf('a', 10), lotOf('b', 10)],
        }),
      ],
      income: [],
      capital: [],
    });
    expect(entry(report, 0, 51)?.amount).toBe('-300');
    expect(entry(report, 0, 58)?.amount).toBe('-300');
  });

  it('keeps an exempt disposal and its costs out of every SO entry', () => {
    const exempt = split({
      disposalEventId: 'd-exempt',
      costs: '4',
      proceeds: '996',
      consumed: [lotOf('a', 400), lotOf('b', 500)],
    });
    const taxable = split({
      disposalEventId: 'd-taxable',
      costs: '6',
      proceeds: '594',
      costBasis: '400',
      gain: '194',
      consumed: [lotOf('c', 10), lotOf('d', 20)],
    });
    const report = germanTax.assess({
      year: 2025,
      matched: [exempt, taxable],
      income: [],
      capital: [],
    });
    // Only the taxable disposal: gross 594 + 6, cost 400, expenses 6.
    expect(entry(report, 0, 48)?.amount).toBe('600');
    expect(entry(report, 0, 49)?.amount).toBe('400');
    expect(entry(report, 0, 50)?.amount).toBe('6');
    expect(entry(report, 0, 51)?.amount).toBe('194');
    expect(entry(report, 0, 58)?.amount).toBe('194');
  });

  it('gives Austria no filing figures', () => {
    expect(
      austrianTax.assess({
        year: 2025,
        matched: [split()],
        income: [],
        capital: [],
      }).filing,
    ).toBeUndefined();
  });
});
