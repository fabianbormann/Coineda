import Big from 'big.js';
import { normaliseAmount } from '@/ledger/amount';
import type { DatevSettings } from '@/settings/settingsStore';
import type { TaxReport } from '@/tax/types';
import { DATEV_COLUMNS } from './columns';

/**
 * DATEV Buchungsstapel (EXTF, format version 700) for the German report.
 * Pure: no I/O, no clock. The caller passes the creation time and encodes
 * the text with encodeCp1252.
 */

export type Posting = {
  /** Cents, decimal comma, never negative. */
  umsatz: string;
  sollHaben: 'S' | 'H';
  konto: string;
  gegenkonto: string;
  /** DDMM of the UTC date. */
  belegdatum: string;
  belegfeld1: string;
  buchungstext: string;
};

export type DatevMeta = {
  year: number;
  fingerprint: string;
  createdAt: Date;
  appVersion: string;
};

/** Which field is wrong and the translation key saying why. `params` is set
 *  for the key that has a placeholder ('Must be {{length}} digits'). */
export type DatevSettingsIssue = {
  field:
    | 'beraternummer'
    | 'mandantennummer'
    | 'sachkontenlaenge'
    | 'konten.verrechnung'
    | 'konten.gewinn23'
    | 'konten.verlust23'
    | 'konten.einkuenfte22';
  key: string;
  params?: { length: number };
};

const DIGITS = /^\d+$/;

/** Exact half-up rounding to cents of the decimal string, decimal comma. */
const amountDe = (value: string): string | null => {
  const cents = new Big(value).abs().round(2, 1);
  if (cents.eq(0)) return null;
  return cents.toFixed(2).replace('.', ',');
};

const plainDe = (value: string): string =>
  normaliseAmount(value).replace(/^-/, '').replace('.', ',');

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

const ddmm = (timestamp: number): string => {
  const d = new Date(timestamp);
  return pad(d.getUTCDate()) + pad(d.getUTCMonth() + 1);
};

/** Free text for a quoted field: no control characters, and no leading
 *  character a spreadsheet would read as a formula. */
const cleanText = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^[=+\-@\s]+/, '');

const capitalise = (text: string): string => {
  const clean = cleanText(text);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
};

const symbolOf = (assetId: string): string =>
  (assetId.split(':').pop() ?? assetId).toUpperCase();

const belegfeld1Of = (eventId: string): string =>
  eventId
    .slice(0, 12)
    .replace(/[^A-Za-z0-9$&%*+\-/]/g, '')
    .slice(0, 36);

const buchungstextOf = (text: string): string => cleanText(text).slice(0, 60);

export const postingsFromReport = (
  report: TaxReport,
  datev: DatevSettings,
): Posting[] => {
  const postings: Posting[] = [];
  const { verrechnung, gewinn23, verlust23, einkuenfte22 } = datev.konten;

  for (const line of report.lines) {
    const umsatz = amountDe(line.taxable);
    if (umsatz === null) continue;
    const loss = new Big(line.taxable).lt(0);
    postings.push({
      umsatz,
      sollHaben: loss ? 'H' : 'S',
      konto: verrechnung,
      gegenkonto: loss ? verlust23 : gewinn23,
      belegdatum: ddmm(line.timestamp),
      belegfeld1: belegfeld1Of(line.disposalEventId),
      buchungstext: buchungstextOf(
        `Verkauf ${plainDe(line.amount)} ${symbolOf(line.assetId)} ${capitalise(line.venue)}`,
      ),
    });
  }

  for (const income of report.income) {
    const umsatz = amountDe(income.value);
    if (umsatz === null) continue;
    const label = income.rewardKind ? capitalise(income.rewardKind) : 'Ertrag';
    postings.push({
      umsatz,
      sollHaben: 'S',
      konto: verrechnung,
      gegenkonto: einkuenfte22,
      belegdatum: ddmm(income.timestamp),
      belegfeld1: belegfeld1Of(income.sourceEventId),
      buchungstext: buchungstextOf(
        `${label} ${plainDe(income.amount)} ${symbolOf(income.assetId)}`,
      ),
    });
  }

  return postings;
};

const quote = (text: string): string => `"${text.replace(/"/g, '""')}"`;

const fingerprint12 = (fingerprint: string): string => fingerprint.slice(0, 12);

const stamp = (d: Date): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
  pad(d.getUTCMilliseconds(), 3);

export const buchungsstapel = (
  postings: Posting[],
  meta: DatevMeta,
  datev: DatevSettings,
): string => {
  const { year } = meta;
  const header = [
    quote('EXTF'),
    '700',
    '21',
    quote('Buchungsstapel'),
    '13',
    stamp(meta.createdAt),
    '',
    quote('CO'),
    quote(`Coineda ${meta.appVersion}`),
    '',
    datev.beraternummer,
    datev.mandantennummer,
    `${year}0101`,
    String(datev.sachkontenlaenge),
    `${year}0101`,
    `${year}1231`,
    quote(`Coineda §23/§22 ${year} ${fingerprint12(meta.fingerprint)}`),
    '',
    '1',
    '0',
    '0',
    quote('EUR'),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ];

  const rows = postings.map((p) => {
    const fields: string[] = new Array(DATEV_COLUMNS.length).fill('');
    fields[0] = p.umsatz;
    fields[1] = quote(p.sollHaben);
    fields[2] = quote('EUR');
    fields[6] = p.konto;
    fields[7] = p.gegenkonto;
    fields[9] = p.belegdatum;
    fields[10] = quote(p.belegfeld1);
    fields[13] = quote(p.buchungstext);
    return fields.join(';');
  });

  return (
    [header.join(';'), DATEV_COLUMNS.join(';'), ...rows].join('\r\n') + '\r\n'
  );
};

export const validateDatevSettings = (
  d: Partial<DatevSettings> | undefined,
): DatevSettingsIssue[] => {
  const issues: DatevSettingsIssue[] = [];
  const digits = (v: unknown, min: number, max: number): boolean =>
    typeof v === 'string' &&
    DIGITS.test(v) &&
    v.length >= min &&
    v.length <= max;

  if (!digits(d?.beraternummer, 1, 7)) {
    issues.push({ field: 'beraternummer', key: 'Must be 1–7 digits' });
  }
  if (!digits(d?.mandantennummer, 1, 5)) {
    issues.push({ field: 'mandantennummer', key: 'Must be 1–5 digits' });
  }
  const length = d?.sachkontenlaenge;
  const lengthOk =
    typeof length === 'number' &&
    Number.isInteger(length) &&
    length >= 4 &&
    length <= 8;
  if (!lengthOk) {
    issues.push({ field: 'sachkontenlaenge', key: 'Must be 4–8 digits' });
  }
  for (const name of [
    'verrechnung',
    'gewinn23',
    'verlust23',
    'einkuenfte22',
  ] as const) {
    const v = d?.konten?.[name];
    const ok =
      typeof v === 'string' &&
      DIGITS.test(v) &&
      (lengthOk ? v.length === length : true);
    if (!ok) {
      issues.push({
        field: `konten.${name}`,
        key: 'Must be {{length}} digits',
        params: { length: lengthOk ? length : 0 },
      });
    }
  }
  return issues;
};

export const datevFilename = (year: number, fingerprint: string): string =>
  `EXTF_Buchungsstapel_${year}_${fingerprint12(fingerprint)}.csv`;
