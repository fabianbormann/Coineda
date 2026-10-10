import { describe, it, expect } from 'vitest';
import {
  buildRegister,
  registerFilename,
  registerToCsv,
  reportToJson,
} from '@/tax/register';
import { readCsv } from '@/sources/csv/readCsv';
import type { SourceDirectoryEntry } from '@/tax/sourceDirectory';
import type { LedgerEvent } from '@/ledger/types';
import type {
  RegisterRow,
  TaxEvent,
  TaxReport,
  UnresolvedItem,
} from '@/tax/types';

const ADA = 'cardano:lovelace';
const BOM = String.fromCharCode(0xfeff);

const taxEvent = (overrides: Partial<TaxEvent>): TaxEvent => ({
  sourceEventId: 'e1',
  kind: 'acquisition',
  assetId: ADA,
  amount: '10000000',
  timestamp: Date.UTC(2025, 0, 10),
  venue: 'kraken',
  value: '10',
  priceSource: 'ECB',
  ...overrides,
});

const transfer: LedgerEvent = {
  id: 'move',
  sourceId: 's',
  externalId: 'move',
  timestamp: Date.UTC(2025, 2, 1),
  kind: 'transfer',
  origin: 'derived',
  legs: [
    {
      assetId: ADA,
      amount: '5000000',
      direction: 'out',
      venue: 'wallet-a',
      role: 'principal',
    },
    {
      assetId: ADA,
      amount: '5000000',
      direction: 'in',
      venue: 'wallet-b',
      role: 'principal',
    },
  ],
};

const unpriced: UnresolvedItem = {
  kind: 'needs-price',
  taxEventKind: 'acquisition',
  sourceEventId: 'u1',
  assetId: ADA,
  amount: '1000000',
  venue: 'kraken',
  timestamp: Date.UTC(2025, 1, 1),
  reason: { key: 'No price' },
  resolutions: [],
};

const FP = 'cd'.repeat(32);
const LABELS = new Map([['s', 'Kraken CSV']]);

const build = () =>
  buildRegister({
    year: 2025,
    valued: [
      taxEvent({
        sourceEventId: 'sell',
        kind: 'disposal',
        timestamp: Date.UTC(2025, 5, 1),
      }),
      taxEvent({ sourceEventId: 'buy' }),
      taxEvent({
        sourceEventId: 'reward',
        kind: 'income',
        timestamp: Date.UTC(2025, 3, 1),
      }),
      taxEvent({ sourceEventId: 'old', timestamp: Date.UTC(2024, 3, 1) }),
    ],
    internalTransfers: [transfer],
    residuals: [],
    unresolved: [unpriced],
    sourceLabelById: LABELS,
    currency: 'eur',
    fingerprint: FP,
  });

describe('buildRegister', () => {
  it('has a row for each kind, in date order, and only for the year', () => {
    const rows = build();
    expect(rows.map((r) => r.kind)).toEqual([
      'acquisition',
      'unresolved',
      'internal-transfer',
      'income',
      'disposal',
    ]);
    expect(rows.map((r) => r.date)).toEqual(
      [...rows.map((r) => r.date)].sort(),
    );
    expect(rows[0].date).toBe('2025-01-10T00:00:00.000Z');
    expect(rows[0].amountWhole).toBe('10');
    expect(rows[0].symbol).toBe('ADA');
  });

  it('names where an internal transfer went and gives it no value', () => {
    const row = build().find((r) => r.kind === 'internal-transfer');
    expect(row?.venue).toBe('wallet-a');
    expect(row?.counterVenue).toBe('wallet-b');
    expect(row?.value).toBeUndefined();
  });

  it('turns an unresolved item into an unresolved row with no value', () => {
    const row = build().find((r) => r.kind === 'unresolved');
    expect(row?.value).toBeUndefined();
    expect(row?.priceSource).toBeUndefined();
    expect(row?.sourceEventId).toBe('u1');
  });
});

describe('unresolved rows', () => {
  const rowFor = (item: UnresolvedItem) =>
    buildRegister({
      year: 2025,
      valued: [],
      internalTransfers: [],
      residuals: [],
      unresolved: [item],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
    })[0];

  it('says which kind of gap it is and on which tax event', () => {
    const row = rowFor({
      ...unpriced,
      kind: 'needs-cost-basis',
      taxEventKind: 'disposal',
      reason: { key: 'No acquisition is on record for this disposal.' },
    });
    expect(row.kind).toBe('unresolved');
    expect(row.unresolvedKind).toBe('needs-cost-basis');
    expect(row.taxEventKind).toBe('disposal');
    const parsed = readCsv(registerToCsv([row])).rows[0];
    expect(parsed.unresolvedKind).toBe('needs-cost-basis');
    expect(parsed.taxEventKind).toBe('disposal');
  });

  it('leaves taxEventKind empty for an unclassified item', () => {
    const { taxEventKind: _omit, ...rest } = unpriced;
    void _omit;
    const row = rowFor({ ...rest, kind: 'unclassified' });
    expect(row.unresolvedKind).toBe('unclassified');
    expect(row.taxEventKind).toBeUndefined();
  });

  it('fills the note parameters into the English sentence', () => {
    const row = rowFor({
      ...unpriced,
      reason: {
        key: 'No price for {{asset}} on {{date}}.',
        params: { asset: 'ADA', date: '2025-02-01' },
      },
    });
    expect(row.note).toBe('No price for ADA on 2025-02-01.');
  });
});

describe('tracing a row to its provider', () => {
  const ledgerEvent = (id: string, externalId: string): LedgerEvent => ({
    ...transfer,
    id,
    externalId,
    sourceId: 's',
  });

  it('names the provider record and the source that holds it', () => {
    const rows = buildRegister({
      year: 2025,
      valued: [taxEvent({ sourceEventId: 'buy' })],
      internalTransfers: [transfer],
      residuals: [],
      unresolved: [{ ...unpriced, sourceEventId: 'gone' }],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
      eventById: new Map([['buy', ledgerEvent('buy', 'kraken-TX1')]]),
    });
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect(byKind.get('acquisition')?.externalId).toBe('kraken-TX1');
    expect(byKind.get('acquisition')?.source).toBe('Kraken CSV');
    expect(byKind.get('internal-transfer')?.externalId).toBe('move');
    expect(byKind.get('internal-transfer')?.source).toBe('Kraken CSV');
    // No ledger event behind it: nothing to name, and no guess.
    expect(byKind.get('unresolved')?.externalId).toBeUndefined();
    expect(byKind.get('unresolved')?.source).toBe('');
  });

  it('yields an empty source for a source id it does not know', () => {
    const rows = buildRegister({
      year: 2025,
      valued: [],
      internalTransfers: [{ ...transfer, sourceId: 'removed' }],
      residuals: [],
      unresolved: [],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
    });
    expect(rows[0].source).toBe('');
  });

  it('orders rows at the same instant by externalId', () => {
    const rows = buildRegister({
      year: 2025,
      valued: [
        taxEvent({ sourceEventId: 'a' }),
        taxEvent({ sourceEventId: 'b' }),
      ],
      internalTransfers: [],
      residuals: [],
      unresolved: [],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
      eventById: new Map([
        ['a', ledgerEvent('a', 'z-later')],
        ['b', ledgerEvent('b', 'y-earlier')],
      ]),
    });
    expect(rows.map((row) => row.externalId)).toEqual(['y-earlier', 'z-later']);
  });
});

describe('a transfer straddling New Year', () => {
  const sender: LedgerEvent = {
    ...transfer,
    id: 'send',
    externalId: 'send',
    txHash: '0xabc',
    timestamp: Date.UTC(2025, 11, 31, 23, 0),
    legs: [transfer.legs[0]],
  };
  const receipt: LedgerEvent = {
    ...transfer,
    id: 'recv',
    externalId: 'recv',
    txHash: '0xabc',
    timestamp: Date.UTC(2026, 0, 1, 1, 0),
    legs: [transfer.legs[1]],
  };
  const forYear = (year: number) =>
    buildRegister({
      year,
      valued: [],
      internalTransfers: [sender, receipt],
      residuals: [],
      unresolved: [],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
    });

  it('does not count a receipt with a fee out leg as a second sender', () => {
    const feePaying: LedgerEvent = {
      ...receipt,
      timestamp: Date.UTC(2025, 11, 31, 23, 30),
      legs: [
        ...receipt.legs,
        {
          assetId: ADA,
          amount: '170000',
          direction: 'out',
          venue: 'wallet-b',
          role: 'fee',
        },
      ],
    };
    const rows = buildRegister({
      year: 2025,
      valued: [],
      internalTransfers: [sender, feePaying],
      residuals: [],
      unresolved: [],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceEventId).toBe('send');
  });

  it('is one row in the sender year and none in the receiver year', () => {
    const rows = forYear(2025);
    expect(rows).toHaveLength(1);
    expect(rows[0].venue).toBe('wallet-a');
    expect(rows[0].counterVenue).toBe('wallet-b');
    expect(forYear(2026)).toHaveLength(0);
  });
});

describe('registerToCsv', () => {
  it('starts with a BOM and names every column in the header', () => {
    const csv = registerToCsv([]);
    expect(csv.startsWith(BOM)).toBe(true);
    const { header, rows } = readCsv(csv);
    expect(header).toEqual([
      'year',
      'fingerprint',
      'date',
      'kind',
      'sourceEventId',
      'externalId',
      'source',
      'txHash',
      'assetId',
      'symbol',
      'amount',
      'amountWhole',
      'venue',
      'counterVenue',
      'value',
      'currency',
      'priceSource',
      'considerationAssetId',
      'considerationAmount',
      'costs',
      'unresolvedKind',
      'taxEventKind',
      'note',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('ties every row to its year and fingerprint, so a renamed file still says', () => {
    const { rows } = readCsv(registerToCsv(build()));
    expect(rows.map((row) => row.year)).toEqual(rows.map(() => '2025'));
    expect(rows.map((row) => row.fingerprint)).toEqual(rows.map(() => FP));
  });

  it('names the currency on every row, upper-case', () => {
    const { rows } = readCsv(registerToCsv(build()));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.currency)).toEqual(rows.map(() => 'EUR'));
  });

  it('quotes and doubles awkward cells so readCsv gets them back', () => {
    const built = build();
    const row: RegisterRow = { ...built[0], venue: 'a, "b"\nc', note: 'x' };
    const { rows } = readCsv(registerToCsv([row, built[1]]));
    expect(rows).toHaveLength(2);
    expect(rows[0].venue).toBe('a, "b"\nc');
    expect(rows[0].note).toBe('x');
    expect(rows[0].amount).toBe(row.amount);
    expect(rows[1].kind).toBe('unresolved');
  });
});

describe('a token name that looks like a formula', () => {
  const name = '=HYPERLINK("//x.io")';
  const hex = Array.from(new TextEncoder().encode(name))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const asset = `cardano:${'ab'.repeat(28)}${hex}`;

  it('is defused with a leading quote and survives the round trip', () => {
    const rows = buildRegister({
      year: 2025,
      valued: [taxEvent({ assetId: asset, amount: '-5' })],
      internalTransfers: [],
      residuals: [],
      unresolved: [],
      sourceLabelById: LABELS,
      currency: 'eur',
      fingerprint: FP,
    });
    expect(rows[0].symbol).toBe(name);
    const csv = registerToCsv(rows);
    expect(csv).toContain(`"'=HYPERLINK(""//x.io"")"`);
    // A negative decimal is a number, not a formula: left alone.
    expect(csv).toContain(',-5,');
    const parsed = readCsv(csv).rows[0];
    expect(parsed.symbol).toBe(`'${name}`);
    expect(parsed.amount).toBe('-5');
  });
});

describe('reportToJson and filenames', () => {
  const report = (register: RegisterRow[]) =>
    ({
      year: 2025,
      jurisdiction: 'de',
      method: { fingerprint: 'ab'.repeat(32) },
      totals: { taxableGain: '1', omitted: 1 },
      thresholds: [],
      lines: [],
      income: [],
      capital: [],
      omittedDisposals: [{ ...unpriced, taxEventKind: 'disposal' }],
      unresolved: [unpriced, { ...unpriced, taxEventKind: 'disposal' }],
      register,
    }) as unknown as TaxReport;
  const generatedAt = '2026-10-10T08:00:00.000Z';

  it('is self-describing JSON: year, jurisdiction, when, and the gaps', () => {
    const register = build();
    const parsed = JSON.parse(reportToJson(report(register), { generatedAt }));
    expect(parsed.fingerprint).toBe('ab'.repeat(32));
    expect(parsed.year).toBe(2025);
    expect(parsed.jurisdiction).toBe('de');
    expect(parsed.generatedAt).toBe(generatedAt);
    expect(parsed.register).toHaveLength(register.length);
    expect(parsed.totals.taxableGain).toBe('1');
    expect(parsed.omittedDisposals).toHaveLength(1);
    expect(parsed.unresolved).toHaveLength(2);
    expect('sourceDirectory' in parsed).toBe(false);
  });

  it('carries the filing aid when present and null otherwise', () => {
    const filing = {
      year: 2025,
      linesVerified: true,
      sections: [
        {
          title: 'Private sales - crypto assets',
          form: 'Anlage SO',
          entries: [
            {
              label: 'Total proceeds',
              amount: '10',
              reference: { form: 'Anlage SO', line: 48 },
            },
          ],
        },
      ],
    };
    const withFiling = JSON.parse(
      reportToJson({ ...report(build()), filing } as unknown as TaxReport, {
        generatedAt,
      }),
    );
    expect(withFiling.filing).toEqual(filing);
    const without = JSON.parse(reportToJson(report(build()), { generatedAt }));
    expect(without.filing).toBeNull();
  });

  it('carries the source directory when the caller supplies it', () => {
    const sourceDirectory: SourceDirectoryEntry[] = [
      {
        sourceId: 's',
        label: 'Kraken CSV',
        moduleId: 'kraken-csv',
        venues: ['kraken'],
        identities: ['addr1qxyz'],
        hasXpub: false,
        eventCount: 3,
      },
    ];
    const parsed = JSON.parse(
      reportToJson(report(build()), { generatedAt, sourceDirectory }),
    );
    expect(parsed.sourceDirectory).toEqual(sourceDirectory);
  });

  it('names the file after the year and fingerprint', () => {
    expect(registerFilename(2025, 'ab'.repeat(32), 'csv')).toMatch(
      /^coineda-register-2025-[0-9a-f]{12}\.csv$/,
    );
  });
});
