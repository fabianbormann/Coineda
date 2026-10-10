import { describe, it, expect } from 'vitest';
import {
  buchungsstapel,
  postingsFromReport,
  validateDatevSettings,
} from '@/datev/buchungsstapel';
import type { DatevSettings } from '@/settings/settingsStore';
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
    disposalEventId: 'loss-1234567890',
    assetId: 'bitcoin:native',
    timestamp: Date.UTC(2025, 2, 7, 10),
    taxable: '1',
    exempt: '0',
    amount: '50000000',
    venue: 'kraken',
    ...o,
  }) as unknown as ReportedDisposal;

const report = (lines: ReportedDisposal[], income: unknown[] = []): TaxReport =>
  ({ lines, income, capital: [] }) as unknown as TaxReport;

const meta = {
  year: 2025,
  fingerprint: 'abcdef1234567890',
  createdAt: new Date('2025-10-10T12:34:56.789Z'),
  appVersion: '1.0.0',
};

const text = (o: Partial<ReportedDisposal>) =>
  postingsFromReport(report([disposal(o)]), datev)[0].buchungstext;

describe('booking text details', () => {
  it('prints satoshi amounts without an exponent', () => {
    expect(text({ amount: '1' })).toBe('Verkauf 0,00000001 BTC Kraken');
  });

  it('shortens an unknown token to its address', () => {
    expect(
      text({
        assetId: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
        amount: '5',
      }),
    ).toBe('Verkauf 5 0xdac1…ec7 Kraken');
  });

  it('shortens the venue, not the symbol, to fit 60 characters', () => {
    const t = text({ venue: 'a-very-long-exchange-name-'.repeat(4) });
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.startsWith('Verkauf 0,5 BTC A-very-long')).toBe(true);
  });

  it('skips a negative result that rounds to zero', () => {
    expect(
      postingsFromReport(report([disposal({ taxable: '-0.004' })]), datev),
    ).toEqual([]);
  });

  it('doubles a quote in the venue', () => {
    const csv = buchungsstapel(
      postingsFromReport(report([disposal({ venue: 'a"b' })]), datev),
      meta,
      datev,
    );
    expect(csv).toContain('"Verkauf 0,5 BTC A""b"');
  });

  it('writes the full loss and income rows', () => {
    const rows = buchungsstapel(
      postingsFromReport(
        report(
          [disposal({ taxable: '-50' })],
          [
            {
              sourceEventId: 'inc-1',
              assetId: 'cardano:lovelace',
              amount: '12300000',
              timestamp: Date.UTC(2025, 4, 1),
              venue: 'w',
              value: '12.3',
              rewardKind: 'staking',
            },
          ],
        ),
        datev,
      ),
      meta,
      datev,
    ).split('\r\n');
    const tail = ';'.repeat(125 - 14);
    expect(rows[2]).toBe(
      '50,00;"H";"EUR";;;;1360;2701;;0703;"loss-1234567";;;"Verkauf 0,5 BTC Kraken"' +
        tail,
    );
    expect(rows[3]).toBe(
      '12,30;"S";"EUR";;;;1360;2710;;0105;"inc-1";;;"Staking 12,3 ADA"' + tail,
    );
  });

  it('never says "Must be 0 digits"', () => {
    expect(validateDatevSettings({ ...datev, sachkontenlaenge: 3 })).toEqual([
      { field: 'sachkontenlaenge', key: 'Must be 4–8 digits' },
    ]);
  });
});
