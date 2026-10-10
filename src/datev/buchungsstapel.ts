import Big from 'big.js';
import {
  symbolOf as knownSymbolOf,
  toWholeUnits,
} from '@/components/money/asset';
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

/** Plain decimal comma, no exponent, no trailing zeros; `maxDecimals`
 *  rounds half-up first. */
const plainDe = (value: string, maxDecimals?: number): string => {
  let big = new Big(value).abs();
  if (maxDecimals !== undefined) big = big.round(maxDecimals, 1);
  const fixed = big.toFixed();
  const trimmed = fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '')
    : fixed;
  return trimmed.replace('.', ',');
};

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

/** The register's symbol; an id with no known symbol (an ERC-20) falls
 *  back to its shortened address. */
const symbolOf = (assetId: string): string => {
  const symbol = knownSymbolOf(assetId);
  if (symbol !== assetId) return symbol;
  const last = assetId.split(':').pop() ?? assetId;
  return last.length > 12 ? `${last.slice(0, 6)}…${last.slice(-3)}` : last;
};

const MAX_TEXT = 60;

/** `<label> <amount> <SYMBOL> [venue]`, within 60 characters: the amount
 *  loses decimals first (down to 8), then the venue is shortened. */
const bookingText = (
  label: string,
  amountBase: string,
  assetId: string,
  venue?: string,
): string => {
  const whole = toWholeUnits(amountBase, assetId);
  const symbol = symbolOf(assetId);
  const venueLabel = venue === undefined ? '' : capitalise(venue);
  const build = (amount: string, v: string): string =>
    cleanText([label, amount, symbol, v].filter(Boolean).join(' '));
  let amount = plainDe(whole);
  let text = build(amount, venueLabel);
  if (text.length > MAX_TEXT) {
    amount = plainDe(whole, 8);
    text = build(amount, venueLabel);
  }
  if (text.length > MAX_TEXT && venueLabel) {
    const room = MAX_TEXT - build(amount, '').length - 1;
    text = build(amount, room > 0 ? venueLabel.slice(0, room).trim() : '');
  }
  return text.slice(0, MAX_TEXT);
};

const belegfeld1Of = (eventId: string): string =>
  eventId
    .slice(0, 12)
    .replace(/[^A-Za-z0-9$&%*+\-/]/g, '')
    .slice(0, 36);

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
      buchungstext: bookingText(
        'Verkauf',
        line.amount,
        line.assetId,
        line.venue,
      ),
    });
  }

  for (const income of report.income) {
    // Booked net of the fee paid to receive the reward (Werbungskosten):
    // the figure the return takes, not the gross.
    const net = new Big(income.value).minus(new Big(income.costs ?? '0'));
    if (net.lte(0)) continue;
    const umsatz = amountDe(net.toString());
    if (umsatz === null) continue;
    const label = income.rewardKind ? capitalise(income.rewardKind) : 'Ertrag';
    postings.push({
      umsatz,
      sollHaben: 'S',
      konto: verrechnung,
      gegenkonto: einkuenfte22,
      belegdatum: ddmm(income.timestamp),
      belegfeld1: belegfeld1Of(income.sourceEventId),
      buchungstext: bookingText(label, income.amount, income.assetId),
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
    quote(`Coineda ${year} ${fingerprint12(meta.fingerprint)}`),
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
  if (!lengthOk) return issues;
  for (const name of [
    'verrechnung',
    'gewinn23',
    'verlust23',
    'einkuenfte22',
  ] as const) {
    const v = d?.konten?.[name];
    const ok = typeof v === 'string' && DIGITS.test(v) && v.length === length;
    if (!ok) {
      issues.push({
        field: `konten.${name}`,
        key: 'Must be {{length}} digits',
        params: { length },
      });
    }
  }
  return issues;
};

export const datevFilename = (year: number, fingerprint: string): string =>
  `EXTF_Buchungsstapel_${year}_${fingerprint12(fingerprint)}.csv`;
