// Typed face of the contrast maths. The implementation lives in
// ./contrastCore.mjs so scripts/contrast.mjs can run the identical code under
// plain Node; see that file for why.
import * as core from './contrastCore.mjs';

export type Rgba = { r: number; g: number; b: number; a: number };
export type Rgb = Pick<Rgba, 'r' | 'g' | 'b'>;
export type Theme = 'light' | 'dark';

export type Pair = {
  label: string;
  fg: string;
  on: string[];
  darkOn?: string[];
  min: number;
};

export type Measurement = {
  theme: Theme;
  label: string;
  fg: string;
  on: string[];
  ratio: number;
  min: number;
  pass: boolean;
};

export const TEXT: number = core.TEXT;
export const NON_TEXT: number = core.NON_TEXT;
export const PAIRS: readonly Pair[] = core.PAIRS;

export const parseCssColor: (text: string) => Rgba = core.parseCssColor;
export const oklchToRgb: (
  L: number,
  C: number,
  H: number,
  alpha?: number,
) => Rgba = core.oklchToRgb;
export const composite: (fg: Rgba, bg: Rgba) => Rgba = core.composite;
export const relativeLuminance: (c: Rgb) => number = core.relativeLuminance;
export const contrastRatio: (a: Rgb, b: Rgb) => number = core.contrastRatio;
export const readThemeTokens: (
  cssText: string,
  theme: Theme,
) => Record<string, string> = core.readThemeTokens;
export const measure: (cssText: string, theme: Theme) => Measurement[] =
  core.measure;
export const markdownTable: (cssText: string) => string = core.markdownTable;
