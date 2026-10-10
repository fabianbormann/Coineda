import { describe, it, expect } from 'vitest';
import {
  buchungsstapel,
  datevFilename,
  postingsFromReport,
  validateDatevSettings,
} from '@/datev/buchungsstapel';
import { DATEV_COLUMNS } from '@/datev/columns';
import { encodeCp1252 } from '@/datev/cp1252';
import {
  normalizeSettings,
  type DatevSettings,
} from '@/settings/settingsStore';
import type { ReportedDisposal, TaxReport } from '@/tax/types';

const datev: DatevSettings = {
  beraternummer: '1234567',
  mandantennummer: '00123',
  sachkontenlaenge: 4,
  konten: {
    verrechnung: '1360',
    gewinn23: '2700',
    verlust23: '2701',
    einkuenfte22: '2710',
  },
};

const disposal = (o: Partial<ReportedDisposal>): ReportedDisposal =>
  ({
    disposalEventId: 'evt-abc123def456xyz',
    assetId: 'bitcoin:native',
    timestamp: Date.UTC(2025, 2, 7, 10),
    proceeds: '0',
    costBasis: '0',
    gain: '0',
    exempt: '0',
    taxable: '0',
    costs: '0',
    amount: '50000000',
    venue: 'kraken',
    consumed: [],
    reason: { key: 'x' },
    ...o,
  }) as unknown as ReportedDisposal;

const report = (lines: ReportedDisposal[]): TaxReport =>
  ({
    lines,
    income: [
      {
        sourceEventId: 'inc-1',
        assetId: 'cardano:lovelace',
        amount: '12300000',
        timestamp: Date.UTC(2025, 4, 1),
        venue: 'wallet',
        value: '12.3',
        rewardKind: 'staking',
      },
    ],
    capital: [
      {
        sourceEventId: 'cap-1',
        assetId: 'eur',
        amount: '1',
        timestamp: Date.UTC(2025, 5, 1),
        venue: 'kraken',
        value: '77',
        kind: 'gain',
        deducted: true,
      },
    ],
  }) as unknown as TaxReport;

const full = report([
  disposal({ taxable: '123.456' }),
  disposal({ disposalEventId: 'ex-1', exempt: '900' }),
  disposal({ disposalEventId: 'loss-1234567890', taxable: '-50' }),
  disposal({ disposalEventId: 'tiny-1', taxable: '0.004' }),
]);

const meta = {
  year: 2025,
  fingerprint: 'abcdef1234567890',
  createdAt: new Date('2025-10-10T12:34:56.789Z'),
  appVersion: '1.0.0',
};

describe('postingsFromReport', () => {
  it('posts gains, losses and income, nothing else', () => {
    const p = postingsFromReport(full, datev);
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual({
      umsatz: '123,46',
      sollHaben: 'S',
      konto: '1360',
      gegenkonto: '2700',
      belegdatum: '0703',
      belegfeld1: 'evt-abc123de',
      buchungstext: 'Verkauf 0,5 BTC Kraken',
    });
    expect(p[1]).toMatchObject({
      umsatz: '50,00',
      sollHaben: 'H',
      gegenkonto: '2701',
    });
    expect(p[2]).toMatchObject({
      umsatz: '12,30',
      sollHaben: 'S',
      gegenkonto: '2710',
      belegdatum: '0105',
      buchungstext: 'Staking 12,3 ADA',
    });
  });

  it('rounds half-up', () => {
    const p = postingsFromReport(
      report([disposal({ taxable: '0.005' })]),
      datev,
    );
    expect(p[0].umsatz).toBe('0,01');
  });

  it('sanitises the document field and the text', () => {
    const p = postingsFromReport(
      report([
        disposal({ venue: '=cmd', disposalEventId: 'a_b c#d.e', taxable: '1' }),
        disposal({ venue: 'x'.repeat(70), taxable: '1' }),
      ]),
      datev,
    );
    expect(p[0].buchungstext).toBe('Verkauf 0,5 BTC Cmd');
    expect(p[0].belegfeld1).toBe('abcde');
    expect(p[1].buchungstext).toHaveLength(60);
  });
});

describe('buchungsstapel', () => {
  const text = buchungsstapel(postingsFromReport(full, datev), meta, datev);
  const lines = text.split('\r\n');

  it('writes the header, column line and postings with CRLF', () => {
    expect(text.endsWith('\r\n')).toBe(true);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      '"EXTF";700;21;"Buchungsstapel";13;20251010123456789;;"CO";"Coineda 1.0.0";;1234567;00123;20250101;4;20250101;20251231;"Coineda 2025 abcdef123456";;1;0;0;"EUR";;;;;;;;;',
    );
    expect(lines[0].split(';')).toHaveLength(31);
    expect(DATEV_COLUMNS).toHaveLength(125);
    expect(lines[1]).toBe(DATEV_COLUMNS.join(';'));
    expect(
      lines[2].startsWith(
        '123,46;"S";"EUR";;;;1360;2700;;0703;"evt-abc123de";;;"Verkauf 0,5 BTC Kraken";',
      ),
    ).toBe(true);
    expect(lines[2].split(';')).toHaveLength(125);
  });
});

describe('encodeCp1252', () => {
  it('maps to Windows-1252', () => {
    expect([...encodeCp1252('ä€')]).toEqual([0xe4, 0x80]);
    expect([...encodeCp1252('₳')]).toEqual([0x3f]);
  });
});

describe('validateDatevSettings', () => {
  it('lists what is missing', () => {
    expect(validateDatevSettings(undefined)).toHaveLength(3);
    expect(validateDatevSettings(datev)).toEqual([]);
    const bad = validateDatevSettings({
      ...datev,
      konten: { ...datev.konten, gewinn23: '27' },
    });
    expect(bad).toEqual([
      {
        field: 'konten.gewinn23',
        key: 'Must be {{length}} digits',
        params: { length: 4 },
      },
    ]);
  });
});

describe('datevFilename and settings', () => {
  it('names the file', () => {
    expect(datevFilename(2025, 'abcdef1234567890')).toBe(
      'EXTF_Buchungsstapel_2025_abcdef123456.csv',
    );
  });
  it('normalizeSettings keeps datev', () => {
    expect(normalizeSettings({ datev }).datev).toEqual(datev);
  });
});
