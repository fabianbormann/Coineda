import type { CsvMapping } from './types';

type Format = CsvMapping['dateFormat'];

const TIME = String.raw`(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?`;
const ZONE = String.raw`\s*(Z|[+-]\d{2}(?::?\d{2})?)?`;
const tail = `${TIME}${ZONE}$`;

const PATTERNS: Record<'iso' | 'ymd' | 'dmy' | 'mdy', RegExp> = {
  iso: new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${tail}`),
  ymd: new RegExp(String.raw`^(\d{4})[-./](\d{1,2})[-./](\d{1,2})${tail}`),
  dmy: new RegExp(String.raw`^(\d{1,2})[-./](\d{1,2})[-./](\d{4})${tail}`),
  mdy: new RegExp(String.raw`^(\d{1,2})[-./](\d{1,2})[-./](\d{4})${tail}`),
};

const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC, in ms, at the instant `t`. */
function offsetAt(timeZone: string, t: number): number {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour % 24,
    p.minute,
    p.second,
  );
  return wall - Math.floor(t / 1000) * 1000;
}

/** Wall-clock fields (as if UTC) in `timeZone` to a UTC instant. A time that
 *  does not exist (spring-forward gap) uses the offset before the change; a
 *  repeated time (fall-back overlap) resolves to its first occurrence. */
function zonedToUtc(wall: number, timeZone: string): number | undefined {
  const DAY = 86400000;
  try {
    const before = offsetAt(timeZone, wall - DAY);
    const after = offsetAt(timeZone, wall + DAY);
    const valid = [before, after]
      .map((o) => wall - o)
      .filter((t) => offsetAt(timeZone, t) === wall - t);
    if (valid.length > 0) return Math.min(...valid);
    return wall - before;
  } catch {
    return undefined; // unknown time zone
  }
}

/**
 * Parse a date cell strictly by the chosen format. Returns epoch ms (UTC) or
 * undefined when the value does not fit. Never guesses between dmy and mdy.
 * An explicit zone in the value (`Z`, `±hh:mm`) wins over `timeZone`.
 */
export function parseMappedDate(
  value: string,
  format: Format,
  timeZone: string,
): number | undefined {
  const v = value.trim();
  if (v === '') return undefined;

  if (format === 'unix-s' || format === 'unix-ms') {
    if (!/^\d{1,16}(?:\.\d+)?$/.test(v)) return undefined;
    const n = Number(v);
    return Math.round(format === 'unix-s' ? n * 1000 : n);
  }

  const m = PATTERNS[format].exec(v);
  if (!m) return undefined;

  let y: number, mo: number, d: number;
  if (format === 'iso' || format === 'ymd') {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if (format === 'dmy') {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return undefined;
  if (hh > 23 || mi > 59 || ss > 59) return undefined;

  const wall = Date.UTC(y, mo - 1, d, hh, mi, ss, ms);

  const zone = m[8];
  if (zone !== undefined) {
    if (zone === 'Z') return wall;
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
    if (!z) return undefined;
    const zh = Number(z[2]);
    const zm = z[3] === undefined ? 0 : Number(z[3]);
    if (zh > 14 || zm > 59) return undefined;
    const off = (zh * 60 + zm) * 60000 * (z[1] === '-' ? -1 : 1);
    return wall - off;
  }

  if (timeZone === 'UTC') return wall;
  return zonedToUtc(wall, timeZone);
}
