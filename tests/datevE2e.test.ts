import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Big from 'big.js';
import { openLedger, putEvents } from '@/ledger/db';
import { runTaxReport } from '@/tax/runTaxReport';
import germanTax from '@/tax/jurisdictions/de';
import { buchungsstapel, postingsFromReport } from '@/datev/buchungsstapel';
import type { DatevSettings } from '@/settings/settingsStore';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { flatRange } from './priceRangeStub';

/**
 * The Buchungsstapel through the REAL German pipeline: the postings must
 * carry the same figures the report prints, to the cent.
 */

const BTC = 'bitcoin:native';
const ADA = 'cardano:lovelace';
const EUR = 'fiat:eur';
const VENUE = 'kraken';

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

const leg = (
  overrides: Partial<Leg> & Pick<Leg, 'assetId' | 'amount' | 'direction'>,
): Leg => ({ venue: VENUE, role: 'principal', ...overrides });

const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: 'e1',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: Date.UTC(2025, 5, 1),
  kind: 'trade',
  origin: 'derived',
  legs: [],
  ...overrides,
});

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  await db.put('settings', {
    key: 'settings',
    value: { language: 'en', baseCurrency: 'eur', coingeckoApiKey: 'test-key' },
  });
  vi.stubGlobal('fetch', flatRange(0.4));
});

describe('DATEV export end to end', () => {
  it('books the taxable gain and the staking income the report prints', async () => {
    await putEvents([
      event({
        id: 'buy',
        externalId: 'buy',
        timestamp: Date.UTC(2025, 0, 10),
        legs: [
          leg({ assetId: EUR, amount: '10000', direction: 'out' }),
          leg({ assetId: BTC, amount: '100000000', direction: 'in' }),
        ],
      }),
      event({
        id: 'sell',
        externalId: 'sell',
        timestamp: Date.UTC(2025, 5, 1),
        legs: [
          leg({ assetId: BTC, amount: '100000000', direction: 'out' }),
          leg({ assetId: EUR, amount: '10700', direction: 'in' }),
          leg({ assetId: EUR, amount: '2', direction: 'out', role: 'fee' }),
        ],
      }),
      event({
        id: 'reward',
        externalId: 'reward',
        kind: 'reward',
        timestamp: Date.UTC(2025, 6, 1),
        raw: { epoch: 500, type: 'leader' },
        legs: [
          leg({
            assetId: ADA,
            amount: '5000000',
            direction: 'in',
            venue: 'stake1',
          }),
        ],
      }),
    ]);

    const report = await runTaxReport(germanTax, {
      year: 2025,
      baseCurrency: 'eur',
    });

    const postings = postingsFromReport(report, datev);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      umsatz: '698,00',
      sollHaben: 'S',
      gegenkonto: '2700',
      belegdatum: '0106',
    });
    expect(postings[1]).toMatchObject({
      umsatz: '2,00',
      sollHaben: 'S',
      gegenkonto: '2710',
      belegdatum: '0107',
    });

    // The gain postings carry the per-disposal taxable figures, to the cent.
    const booked = postings
      .filter((p) => p.gegenkonto === '2700')
      .reduce((sum, p) => sum.plus(p.umsatz.replace(',', '.')), new Big(0))
      .toFixed(2);
    const lineTotal = report.lines
      .reduce((sum, l) => sum.plus(l.taxable), new Big(0))
      .toFixed(2);
    expect(booked).toBe(lineTotal);
    expect(booked).toBe('698.00');
    // 698 is under the 1,000 Freigrenze, so the report's own headline
    // figure is 0. The export books the per-disposal result and leaves the
    // threshold to the advisor; this pins that the two are not the same.
    expect(report.totals.taxableGain).toBe('0');
    expect(report.totals.income).toBe('0');
    expect(report.income.map((i) => i.value)).toEqual(['2']);

    const text = buchungsstapel(
      postings,
      {
        year: 2025,
        fingerprint: 'abcdef0123456789',
        createdAt: new Date(Date.UTC(2026, 0, 5, 9, 30)),
        appVersion: '1.0.0',
      },
      datev,
    );
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(2 + 2 + 1);
  });
});
