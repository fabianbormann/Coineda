import { describe, it, expect } from 'vitest';
import {
  buildRegister,
  registerFilename,
  registerToCsv,
  reportToJson,
} from '@/tax/register';
import { readCsv } from '@/sources/csv/readCsv';
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
  });

describe('buildRegister', () => {
  it('has a row for each kind, in date order, and only for the year', () => {
    const rows = build();
    expect(rows.map((r) => r.kind)).toEqual([
      'acquisition',
      'unpriced',
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

  it('turns an unresolved item into an unpriced row with no value', () => {
    const row = build().find((r) => r.kind === 'unpriced');
    expect(row?.value).toBeUndefined();
    expect(row?.priceSource).toBeUndefined();
    expect(row?.sourceEventId).toBe('u1');
  });
});

describe('registerToCsv', () => {
  it('starts with a BOM and names every column in the header', () => {
    const csv = registerToCsv([]);
    expect(csv.startsWith(BOM)).toBe(true);
    const { header, rows } = readCsv(csv);
    expect(header).toEqual([
      'date',
      'kind',
      'sourceEventId',
      'txHash',
      'assetId',
      'symbol',
      'amount',
      'amountWhole',
      'venue',
      'counterVenue',
      'value',
      'priceSource',
      'considerationAssetId',
      'considerationAmount',
      'costs',
      'note',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('quotes and doubles awkward cells so readCsv gets them back', () => {
    const built = build();
    const row: RegisterRow = { ...built[0], venue: 'a, "b"\nc', note: 'x' };
    const { rows } = readCsv(registerToCsv([row, built[1]]));
    expect(rows).toHaveLength(2);
    expect(rows[0].venue).toBe('a, "b"\nc');
    expect(rows[0].note).toBe('x');
    expect(rows[0].amount).toBe(row.amount);
    expect(rows[1].kind).toBe('unpriced');
  });
});

describe('reportToJson and filenames', () => {
  it('is self-describing JSON', () => {
    const register = build();
    const report = {
      method: { fingerprint: 'ab'.repeat(32) },
      totals: { taxableGain: '1' },
      thresholds: [],
      lines: [],
      income: [],
      capital: [],
      register,
    } as unknown as TaxReport;
    const parsed = JSON.parse(reportToJson(report));
    expect(parsed.fingerprint).toBe('ab'.repeat(32));
    expect(parsed.register).toHaveLength(register.length);
    expect(parsed.totals.taxableGain).toBe('1');
  });

  it('names the file after the year and fingerprint', () => {
    expect(registerFilename(2025, 'ab'.repeat(32), 'csv')).toMatch(
      /^coineda-register-2025-[0-9a-f]{12}\.csv$/,
    );
  });
});
