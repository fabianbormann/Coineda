import { describe, expect, it } from 'vitest';
import { parseMappedDate } from '../src/sources/mapped-csv/dates';

const U = Date.UTC;

describe('parseMappedDate', () => {
  it('iso with Z, offset and mapping zone', () => {
    expect(
      parseMappedDate('2024-03-07T10:00:00Z', 'iso', 'Europe/Berlin'),
    ).toBe(U(2024, 2, 7, 10));
    expect(parseMappedDate('2024-03-07T10:00:00+02:00', 'iso', 'UTC')).toBe(
      U(2024, 2, 7, 8),
    );
    expect(parseMappedDate('2024-03-07 10:00:00', 'iso', 'UTC')).toBe(
      U(2024, 2, 7, 10),
    );
    expect(parseMappedDate('2024-03-07 10:00:00', 'iso', 'Europe/Berlin')).toBe(
      U(2024, 2, 7, 9),
    );
    expect(parseMappedDate('2024-07-07 10:00:00', 'iso', 'Europe/Berlin')).toBe(
      U(2024, 6, 7, 8),
    );
  });

  it('ymd', () => {
    expect(parseMappedDate('2024-03-07', 'ymd', 'UTC')).toBe(U(2024, 2, 7));
    expect(parseMappedDate('2024.03.07 10:15', 'ymd', 'UTC')).toBe(
      U(2024, 2, 7, 10, 15),
    );
  });

  it('dmy and mdy are never guessed', () => {
    expect(parseMappedDate('07.03.2024', 'dmy', 'UTC')).toBe(U(2024, 2, 7));
    expect(parseMappedDate('07/03/2024 10:15:30', 'dmy', 'UTC')).toBe(
      U(2024, 2, 7, 10, 15, 30),
    );
    expect(parseMappedDate('13/02/2024', 'dmy', 'UTC')).toBe(U(2024, 1, 13));
    expect(parseMappedDate('13/02/2024', 'mdy', 'UTC')).toBeUndefined();
    expect(parseMappedDate('03/07/2024', 'mdy', 'UTC')).toBe(U(2024, 2, 7));
    expect(parseMappedDate('31/04/2024', 'dmy', 'UTC')).toBeUndefined();
  });

  it('unix seconds and milliseconds', () => {
    expect(parseMappedDate('1709805600', 'unix-s', 'UTC')).toBe(1709805600000);
    expect(parseMappedDate('1709805600000', 'unix-ms', 'UTC')).toBe(
      1709805600000,
    );
  });

  it('DST gap and overlap', () => {
    expect(parseMappedDate('2024-03-31 02:30', 'iso', 'Europe/Berlin')).toBe(
      U(2024, 2, 31, 1, 30),
    );
    expect(parseMappedDate('2024-10-27 02:30', 'iso', 'Europe/Berlin')).toBe(
      U(2024, 9, 27, 0, 30),
    );
  });

  it('garbage and empty', () => {
    expect(parseMappedDate('garbage', 'iso', 'UTC')).toBeUndefined();
    expect(parseMappedDate('', 'iso', 'UTC')).toBeUndefined();
    expect(parseMappedDate('2024-13-01', 'ymd', 'UTC')).toBeUndefined();
    expect(parseMappedDate('abc', 'unix-s', 'UTC')).toBeUndefined();
  });
});

describe('parseMappedDate, fix wave', () => {
  it('refuses a unix value in the other unit', () => {
    expect(parseMappedDate('1709805600000', 'unix-s', 'UTC')).toBeUndefined();
    expect(parseMappedDate('1709805600', 'unix-ms', 'UTC')).toBeUndefined();
  });

  it('applies half-hour and American zones', () => {
    expect(parseMappedDate('2024-03-07 10:00', 'iso', 'Asia/Kolkata')).toBe(
      U(2024, 2, 7, 4, 30),
    );
    expect(parseMappedDate('2024-01-15 10:00', 'iso', 'America/New_York')).toBe(
      U(2024, 0, 15, 15),
    );
    expect(parseMappedDate('2024-07-15 10:00', 'iso', 'America/New_York')).toBe(
      U(2024, 6, 15, 14),
    );
  });

  it('answers undefined for an unknown zone', () => {
    expect(
      parseMappedDate('2024-03-07 10:00', 'iso', 'Nope/Zone'),
    ).toBeUndefined();
  });
});
