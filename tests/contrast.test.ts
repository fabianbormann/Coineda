import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  composite,
  contrastRatio,
  markdownTable,
  measure,
  parseCssColor,
  readThemeTokens,
  relativeLuminance,
} from '../src/a11y/contrast';

const css = ['src/styles/lumen.css', 'src/index.css']
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const close = (actual: number, expected: number, within = 1) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(within);

describe('parseCssColor', () => {
  it('reads hex in all four lengths', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#121318')).toEqual({ r: 18, g: 19, b: 24, a: 1 });
    expect(parseCssColor('#0008').a).toBeCloseTo(136 / 255);
    expect(parseCssColor('#00000080').a).toBeCloseTo(128 / 255);
  });

  it('reads rgb() in comma and space syntax, with and without alpha', () => {
    expect(parseCssColor('rgb(18 19 24 / 0.72)')).toEqual({
      r: 18,
      g: 19,
      b: 24,
      a: 0.72,
    });
    expect(parseCssColor('rgba(255, 255, 255, 0.35)')).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 0.35,
    });
    expect(parseCssColor('rgb(100% 0% 0%)')).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 1,
    });
  });

  it('reads hsl()', () => {
    const red = parseCssColor('hsl(0 100% 50%)');
    close(red.r, 255);
    close(red.g, 0);
    const teal = parseCssColor('hsla(180, 50%, 25%, 0.5)');
    close(teal.r, 32);
    close(teal.g, 96);
    close(teal.b, 96);
    expect(teal.a).toBe(0.5);
  });

  it('converts oklch() to sRGB', () => {
    const white = parseCssColor('oklch(1 0 0)');
    close(white.r, 255);
    close(white.g, 255);
    close(white.b, 255);
    const black = parseCssColor('oklch(0 0 0)');
    close(black.r, 0);
    // CSS Color 4's own reference values for sRGB red and #3a3c45-ish greys.
    const red = parseCssColor('oklch(0.62796 0.25768 29.234)');
    close(red.r, 255);
    close(red.g, 0);
    close(red.b, 0);
    const blue = parseCssColor('oklch(45.2% 0.3132 264.05 / 0.5)');
    close(blue.b, 255);
    close(blue.r, 0);
    expect(blue.a).toBe(0.5);
  });

  it('clips out-of-gamut oklch to the sRGB cube', () => {
    const vivid = parseCssColor('oklch(0.77 0.35 172)');
    for (const channel of [vivid.r, vivid.g, vivid.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });
});

describe('luminance, ratio and compositing', () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };

  it('matches the WCAG reference points', () => {
    expect(relativeLuminance(white)).toBeCloseTo(1);
    expect(relativeLuminance(black)).toBe(0);
    expect(contrastRatio(white, black)).toBeCloseTo(21);
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    // #767676 is the classic lightest grey that passes 4.5 on white.
    const grey = parseCssColor('#767676');
    expect(contrastRatio(grey, white)).toBeCloseTo(4.54, 2);
  });

  it('composites alpha over an opaque background', () => {
    expect(composite({ ...black, a: 0.5 }, white)).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
    expect(() => composite(black, { ...white, a: 0.5 })).toThrow();
  });
});

describe('readThemeTokens', () => {
  it('resolves var() through both files', () => {
    const light = readThemeTokens(css, 'light');
    expect(light['--background']).toBe('#f2f3f7');
    expect(light['--muted-foreground']).toBe(light['--lm-mute']);
  });

  it('layers .dark over :root for the dark theme and ignores @media print', () => {
    const dark = readThemeTokens(css, 'dark');
    expect(dark['--background']).toBe('#0b0c10');
    expect(dark['--foreground']).toBe('#f3f4f8');
    // index.css's :root mapping, read through .dark's --lm-* values.
    expect(dark['--primary']).toBe(dark['--lm-fill']);
  });

  it('takes the later declaration when a selector repeats', () => {
    const tokens = readThemeTokens(
      ':root { --a: #000; --b: var(--a); } .dark { --a: #fff; } @media print { :root { --a: red; } }',
      'dark',
    );
    expect(tokens['--b']).toBe('#fff');
    expect(
      readThemeTokens(':root { --a: #000; --b: var(--a); }', 'light')['--b'],
    ).toBe('#000');
  });
});

describe.each(['light', 'dark'] as const)(
  'token contrast, %s theme',
  (theme) => {
    const rows = measure(css, theme);

    it.each(rows.map((row) => [row.label, row] as const))(
      '%s meets its threshold',
      (_label, row) => {
        expect(
          // Unrounded: WCAG thresholds are not met by rounding up to them.
          row.ratio,
          `${theme}: ${row.label} (${row.fg} over ${row.on.join(' + ')})`,
        ).toBeGreaterThanOrEqual(row.min);
      },
    );
  },
);

describe('scripts/contrast.mjs', () => {
  it('prints exactly the table the typed module computes', () => {
    const out = execFileSync(process.execPath, ['scripts/contrast.mjs'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(markdownTable(css));
  });

  it('is the table docs/accessibility.md embeds', () => {
    expect(readFileSync('docs/accessibility.md', 'utf8')).toContain(
      markdownTable(css),
    );
  });
});
