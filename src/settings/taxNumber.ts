/**
 * The German Steuernummer as it is printed on a notice, per Bundesland.
 *
 * Source: ELSTER, "Prüfung der Steuer- und Steueridentifikationsnummer"
 * (Stand 02.09.2026), Tabelle 4-1, the format on notices ("Bescheidformat").
 * The 13-digit ELSTER format is deliberately not used: people copy the
 * number off their Bescheid, and that is the form a tax office recognises
 * on a printed report.
 *
 * Pure: no React, no settings. `0` in a mask stands for one digit; every
 * other character is a fixed separator.
 */

export const GERMAN_STATES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const;

export type GermanState = (typeof GERMAN_STATES)[number];

const MASKS: Record<GermanState, string> = {
  BW: '00000/00000',
  BY: '000/000/00000',
  BE: '00/000/00000',
  BB: '000/000/00000',
  HB: '00 000 00000',
  HH: '00/000/00000',
  HE: '000 000 00000',
  MV: '000/000/00000',
  NI: '00/000/00000',
  NW: '000/0000/0000',
  RP: '00/000/00000',
  SL: '000/000/00000',
  SN: '000/000/00000',
  ST: '000/000/00000',
  SH: '00/000/00000',
  TH: '000/000/00000',
};

/** Translation keys (English names) for the select, in GERMAN_STATES order. */
export const STATE_NAMES: Record<GermanState, string> = {
  BW: 'Baden-Württemberg',
  BY: 'Bavaria',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hesse',
  MV: 'Mecklenburg-Western Pomerania',
  NI: 'Lower Saxony',
  NW: 'North Rhine-Westphalia',
  RP: 'Rhineland-Palatinate',
  SL: 'Saarland',
  SN: 'Saxony',
  ST: 'Saxony-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thuringia',
};

export const isGermanState = (value: unknown): value is GermanState =>
  typeof value === 'string' && Object.hasOwn(MASKS, value);

export const maskOf = (state: GermanState): string => MASKS[state];

export const digitCountOf = (state: GermanState): number =>
  [...MASKS[state]].filter((char) => char === '0').length;

/** The digits of a value, whatever separators (or none) it was written with. */
export const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * `digits` placed into the state's mask. A separator is written only once a
 * digit follows it, so a partial number never ends in one; non-digits and
 * digits past the mask are dropped.
 */
export const formatDigits = (state: GermanState, digits: string): string => {
  const queue = [...digitsOf(digits)];
  let out = '';
  let pending = '';
  for (const char of MASKS[state]) {
    if (queue.length === 0) {
      break;
    }
    if (char === '0') {
      out += pending + queue.shift();
      pending = '';
    } else {
      pending += char;
    }
  }
  return out;
};

/** Whether the value's digit count is exactly the state's. */
export const fitsState = (state: GermanState, value: string): boolean =>
  digitsOf(value).length === digitCountOf(state);

/** Whether the value is what the mask itself would write (a prefix of it,
 *  for a number still being typed). A value in another format is not. */
export const isCanonical = (state: GermanState, value: string): boolean =>
  formatDigits(state, value) === value &&
  digitsOf(value).length <= digitCountOf(state);

/** The caret position just after the `count`-th digit of a formatted value
 *  (its end when it has fewer). */
export const caretAfterDigits = (formatted: string, count: number): number => {
  if (count <= 0) {
    return 0;
  }
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index])) {
      seen += 1;
      if (seen === count) {
        return index + 1;
      }
    }
  }
  return formatted.length;
};
