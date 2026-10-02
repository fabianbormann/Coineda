import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { taxRegistry } from '@/tax/registry';
import type { LedgerEvent } from '@/ledger/types';

const locale = (name: string): Record<string, string> =>
  JSON.parse(
    readFileSync(
      path.join(__dirname, `../src/translations/${name}.json`),
      'utf8',
    ),
  ).translation;

const en = locale('en');
const de = locale('de');

const sampleEvents: LedgerEvent[] = [
  {
    id: 'e1',
    sourceId: 's1',
    externalId: 'x1',
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
  {
    id: 'e2',
    sourceId: 's1',
    externalId: 'x2',
    timestamp: Date.UTC(2024, 6, 1),
    kind: 'reward',
    origin: 'derived',
    raw: { type: 'member' },
    legs: [
      {
        assetId: 'cardano:lovelace',
        amount: '5',
        direction: 'in',
        venue: 'stake1',
        role: 'principal',
      },
    ],
  },
];

describe('tax module registry', () => {
  it('has at least the two reference jurisdictions', () => {
    expect(taxRegistry.length).toBeGreaterThanOrEqual(2);
  });

  it('has unique ids', () => {
    const ids = taxRegistry.map((m) => m.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(taxRegistry.map((m) => [m.manifest.id, m] as const))(
  'tax conformance: %s',
  (id, module) => {
    it('names a contributor', () => {
      expect(module.manifest.contributor.trim().length).toBeGreaterThan(0);
    });

    it('carries a parsable rulesCheckedOn date', () => {
      expect(module.manifest.rulesCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(module.manifest.rulesCheckedOn))).toBe(
        false,
      );
    });

    it('cites at least one reference', () => {
      expect(module.manifest.references.length).toBeGreaterThan(0);
    });

    it('declares a sane supported year range', () => {
      const { from, to } = module.manifest.supportedYears;
      expect(from).toBeGreaterThan(2008);
      if (to !== undefined) {
        expect(to).toBeGreaterThanOrEqual(from);
      }
    });

    it('has its jurisdiction name keyed in both locales', () => {
      expect(en[module.manifest.jurisdiction]).toBeDefined();
      expect(de[module.manifest.jurisdiction]).toBeDefined();
    });

    it('classifies deterministically', () => {
      // Catches Date.now(), Math.random() and locale-dependent formatting -
      // the three things that make a tax report irreproducible, and none of
      // which a reviewer reliably spots by reading.
      //
      // This is a SAMPLING check, not a direct one: two calls only disagree
      // if whatever impurity is in there happened to produce a different
      // value between them. A millisecond-resolution Date.now() call in a
      // classify that ran twice back-to-back landed in the same
      // millisecond on most runs, so this test passed against a broken
      // module far more often than it failed - an intermittent gate on tax
      // reproducibility is close to no gate. The direct purity probe below
      // is the real check; this one is kept because sampling twice is
      // still free insurance against anything the probe's three stubs
      // don't happen to cover (e.g. a `new Date()` with no explicit
      // `Date.now()` call, which still observes wall-clock time but is not
      // itself one of the three stubbed globals).
      const first = sampleEvents.flatMap((e) => module.classify(e));
      const second = sampleEvents.flatMap((e) => module.classify(e));
      expect(first).toEqual(second);
    });

    it('never touches the clock or randomness while classifying', () => {
      // Direct test of the purity property instead of sampling for a
      // disagreement: Date.now, Math.random and performance.now are all
      // stubbed to throw for the duration of one classify pass over the
      // fixtures. A pure classify never calls any of them and the probe
      // passes silently; an impure one throws EVERY run, not only the runs
      // where two samples happened to land on opposite sides of a clock
      // tick - which is what made the test above intermittent.
      const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('classify must not call Date.now()');
      });
      const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('classify must not call Math.random()');
      });
      const performanceNow = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => {
          throw new Error('classify must not call performance.now()');
        });

      try {
        expect(() =>
          sampleEvents.forEach((event) => module.classify(event)),
        ).not.toThrow();
      } finally {
        dateNow.mockRestore();
        mathRandom.mockRestore();
        performanceNow.mockRestore();
      }
    });

    it('never emits an amount that is not a decimal string', () => {
      for (const event of sampleEvents.flatMap((e) => module.classify(e))) {
        expect(typeof event.amount).toBe('string');
        expect(event.amount).toMatch(/^-?\d+(\.\d+)?$/);
      }
    });

    // A test that was here, "never claims to support a year its assess
    // would mis-threshold", asserted only `report.year === from` - every
    // registered assess (stubModule's included) echoes `input.year`
    // verbatim, so the assertion could never fail regardless of whether
    // threshold selection at the boundary year was correct. Deleted rather
    // than patched: there is no single generic assertion that fits every
    // jurisdiction here, because not every jurisdiction HAS a
    // year-dependent threshold to mis-select (Austria has none at all).
    // The real version of this check already exists per jurisdiction,
    // where it can assert something concrete: see
    // tests/taxGermany.test.ts's "uses the 600 limit for 2023 and 1000 for
    // 2024", which asserts the actual limit and resulting taxableGain
    // differ across the boundary.
  },
);
