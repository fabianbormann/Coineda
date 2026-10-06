import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { taxRegistry } from '@/tax/registry';
import { HOST_REASON_KEYS } from '@/tax/runTaxReport';
import { PRICE_REASON_KEYS } from '@/tax/resolveValues';
import type { LedgerEvent } from '@/ledger/types';
import type { MatchedDisposal } from '@/tax/types';

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

/**
 * Disposals shaped to reach a DIFFERENT outcome branch in every
 * jurisdiction's `assess`, so the key-coverage test below sees every
 * sentence a module can print rather than only the one its happiest path
 * produces. A key emitted on a branch no fixture reaches is exactly the one
 * that ships untranslated, which is the defect this gate exists to catch.
 *
 * Deliberately crude: held long, held briefly, and a disposal straddling
 * both. Between them they cover Germany's three §23 outcomes and Austria's
 * Altvermögen/Neuvermögen split, and any future jurisdiction whose rules
 * turn on how long something was held - which is most of them.
 */
const DISPOSED_AT = Date.UTC(2024, 5, 1);
const DAY = 86_400_000;

const lot = (heldDays: number, amount: string, costBasis: string) => ({
  acquisitionEventId: `a-${heldDays}`,
  amount,
  costBasis,
  acquiredAt: DISPOSED_AT - heldDays * DAY,
  heldDays,
});

const reasonFixtures: MatchedDisposal[] = [
  {
    disposalEventId: 'long',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    // 'alt' and 'neu' are Austria's partition keys; for Germany the
    // partition is a venue and this value is simply carried through.
    partition: 'alt',
    amount: '10',
    proceeds: '1000',
    costBasis: '400',
    gain: '600',
    timestamp: DISPOSED_AT,
    consumed: [lot(400, '10', '400')],
  },
  {
    disposalEventId: 'short',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    partition: 'neu',
    amount: '10',
    proceeds: '1000',
    costBasis: '400',
    gain: '600',
    timestamp: DISPOSED_AT,
    consumed: [lot(10, '10', '400')],
  },
  {
    disposalEventId: 'straddling',
    assetId: 'cardano:lovelace',
    venue: 'wallet-a',
    partition: 'neu',
    amount: '10',
    proceeds: '1000',
    costBasis: '400',
    gain: '600',
    timestamp: DISPOSED_AT,
    consumed: [lot(400, '5', '200'), lot(10, '5', '200')],
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
    it('keys every reason it can emit in both locales', () => {
      // Driven over fixtures rather than read off the source: a reason is
      // produced INSIDE `assess`, so running the module is the only honest
      // way to enumerate what it can print. i18next falls back to the key
      // itself when a translation is missing, which means a German report
      // would silently render the English sentence and every other test
      // would stay green - this is the only thing standing between that
      // defect and a printed tax document.
      const keys = new Set<string>();
      for (const matched of reasonFixtures) {
        for (const line of module.assess({
          year: 2024,
          matched: [matched],
          income: [],
        }).lines) {
          keys.add(line.reason.key);
        }
      }

      expect(keys.size).toBeGreaterThan(0);
      for (const key of keys) {
        expect(en[key], `missing from en.json: ${key}`).toBeDefined();
        expect(de[key], `missing from de.json: ${key}`).toBeDefined();
      }
    });

    it('describes its partition rule with a key in both locales', () => {
      // A report that states FIFO without stating its SCOPE has not stated
      // the method: per-wallet and portfolio-wide FIFO give different
      // answers from identical trades, and only the jurisdiction knows
      // which one its partitionBy means.
      expect(en[module.manifest.partitionLabel]).toBeDefined();
      expect(de[module.manifest.partitionLabel]).toBeDefined();
    });

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

describe('host reason keys', () => {
  // The host writes reasons of its own - an unhandled event kind, a
  // disposal with no acquisition, a price the provider would not serve -
  // and they land in the same printed document as a jurisdiction's. They
  // are exported as constants precisely so this gate does not have to
  // provoke each one through a real report to find it.
  it.each([...HOST_REASON_KEYS, ...PRICE_REASON_KEYS])(
    'keys %s in both locales',
    (key) => {
      expect(en[key], `missing from en.json: ${key}`).toBeDefined();
      expect(de[key], `missing from de.json: ${key}`).toBeDefined();
    },
  );
});
