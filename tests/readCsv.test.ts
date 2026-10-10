import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCsv, sniffDelimiter } from '@/sources/csv/readCsv';
import {
  AmbiguousDecimalError,
  normaliseDecimal,
} from '@/sources/csv/ledgerShape';

describe('sniffDelimiter', () => {
  it('finds the delimiter outside quotes', () => {
    expect(sniffDelimiter('a;b;"c,d"\r\n')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    expect(sniffDelimiter('a,b,c')).toBe(',');
    expect(sniffDelimiter('a')).toBe(',');
    expect(sniffDelimiter('a,b,"c;d"')).toBe(',');
  });

  it.each(['kraken-csv', 'binance-csv', 'coinbase-csv'])(
    'still answers a comma for the %s fixtures',
    (dir) => {
      const base = `src/sources/${dir}/fixtures`;
      const files = readdirSync(base).filter((f) => f.endsWith('.csv'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(`${base}/${file}`, 'utf8');
        const lines = (
          text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
        ).split(/\r\n|\n|\r/);
        // Coinbase puts prose before the header; the header is the first
        // line with a separator in it.
        const header = lines.find((line) => line.includes(',')) ?? lines[0];
        expect(sniffDelimiter(header)).toBe(',');
        expect(sniffDelimiter(lines[0])).toBe(',');
      }
    },
  );
});

describe('readCsv delimiter', () => {
  it('sniffs a semicolon file only when asked to', () => {
    expect(readCsv('x;y\r\n1;2\r\n', { delimiter: 'auto' }).rows).toEqual([
      { x: '1', y: '2' },
    ]);
  });
  it('reads commas only by default, exactly as before the sniff existed', () => {
    // An exchange module that never asked for a sniff must keep refusing a
    // German-Excel re-save: one header cell, not a matching header.
    expect(readCsv('x;y\r\n1;2\r\n').header).toEqual(['x;y']);
    expect(readCsv('a\tb\n1\t2\n').header).toEqual(['a\tb']);
  });
  it('honours a fixed semicolon or tab', () => {
    expect(readCsv('x;y\n1;2\n', { delimiter: ';' }).header).toEqual([
      'x',
      'y',
    ]);
    expect(readCsv('x\ty\n1\t2\n', { delimiter: '\t' }).header).toEqual([
      'x',
      'y',
    ]);
  });
  it('honours a forced delimiter', () => {
    expect(readCsv('x;y,z\n1;2,3\n', { delimiter: ',' }).header).toEqual([
      'x;y',
      'z',
    ]);
  });
});

describe('normaliseDecimal', () => {
  it('normalises decimal commas', () => {
    expect(normaliseDecimal('0,5')).toBe('0.5');
    expect(normaliseDecimal('1234.5')).toBe('1234.5');
    expect(normaliseDecimal('1 234,5')).toBe('1234.5');
    expect(normaliseDecimal('-0,001')).toBe('-0.001');
  });
  it('refuses both separators', () => {
    expect(() => normaliseDecimal('1.234,5')).toThrow(AmbiguousDecimalError);
    expect(() => normaliseDecimal('1,234,567')).toThrow(AmbiguousDecimalError);
    expect(() => normaliseDecimal('1.234.567')).toThrow(AmbiguousDecimalError);
  });
});
