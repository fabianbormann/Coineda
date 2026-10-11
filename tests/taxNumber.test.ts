import { describe, it, expect } from 'vitest';
import {
  GERMAN_STATES,
  caretAfterDigits,
  digitCountOf,
  digitsOf,
  fitsState,
  formatDigits,
  isCanonical,
  isGermanState,
  maskOf,
} from '@/settings/taxNumber';

describe('the tax number masks', () => {
  it('covers all sixteen Bundesländer with the format printed on notices', () => {
    // ELSTER, "Prüfung der Steuer- und Steueridentifikationsnummer",
    // Tabelle 4-1 (Stand 02.09.2026).
    expect(GERMAN_STATES).toHaveLength(16);
    const masks = Object.fromEntries(
      GERMAN_STATES.map((state) => [state, maskOf(state)]),
    );
    expect(masks).toEqual({
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
    });
  });

  it('counts the digit positions of a mask', () => {
    expect(digitCountOf('BW')).toBe(10);
    expect(digitCountOf('BY')).toBe(11);
    expect(digitCountOf('BE')).toBe(10);
    expect(digitCountOf('HE')).toBe(11);
    expect(digitCountOf('NW')).toBe(11);
  });

  it('recognises only the sixteen two-letter codes', () => {
    expect(isGermanState('NW')).toBe(true);
    expect(isGermanState('nw')).toBe(false);
    expect(isGermanState('XX')).toBe(false);
    expect(isGermanState(undefined)).toBe(false);
  });
});

describe('formatDigits', () => {
  it('places a full set of digits into the mask', () => {
    expect(formatDigits('BE', '1234567890')).toBe('12/345/67890');
    expect(formatDigits('BW', '1234567890')).toBe('12345/67890');
    expect(formatDigits('HB', '1234567890')).toBe('12 345 67890');
    expect(formatDigits('HE', '12345678901')).toBe('123 456 78901');
    expect(formatDigits('NW', '12345678901')).toBe('123/4567/8901');
  });

  it('adds a separator only once a digit follows it', () => {
    expect(formatDigits('BY', '')).toBe('');
    expect(formatDigits('BY', '123')).toBe('123');
    expect(formatDigits('BY', '1234')).toBe('123/4');
    expect(formatDigits('BY', '123456')).toBe('123/456');
    expect(formatDigits('BY', '1234567')).toBe('123/456/7');
  });

  it('ignores anything that is not a digit and anything past the mask', () => {
    expect(formatDigits('BE', '12a34')).toBe('12/34');
    expect(formatDigits('BE', '123456789012')).toBe('12/345/67890');
  });
});

describe('digitsOf', () => {
  it('keeps the digits of a number written with any separators or none', () => {
    expect(digitsOf('12 345 67890')).toBe('1234567890');
    expect(digitsOf('12/345/67890')).toBe('1234567890');
    expect(digitsOf('1234567890')).toBe('1234567890');
    expect(digitsOf(' 12-345.67890 ')).toBe('1234567890');
    expect(digitsOf('')).toBe('');
  });
});

describe('fitsState', () => {
  it('accepts a value whose digit count matches the mask, whatever its separators', () => {
    expect(fitsState('BE', '12 345 67890')).toBe(true);
    expect(fitsState('BE', '1234567890')).toBe(true);
    expect(fitsState('BY', '1234567890')).toBe(false);
    expect(fitsState('BE', '')).toBe(false);
  });
});

describe('isCanonical', () => {
  it('holds for an empty value and for any prefix the mask produces', () => {
    expect(isCanonical('BY', '')).toBe(true);
    expect(isCanonical('BY', '123/4')).toBe(true);
    expect(isCanonical('BY', '123/456/78901')).toBe(true);
  });

  it('fails for a value written in another format', () => {
    expect(isCanonical('BE', '12/345/678/901')).toBe(false);
    expect(isCanonical('BE', '1234567890')).toBe(false);
    expect(isCanonical('BY', '123/')).toBe(false);
  });
});

describe('caretAfterDigits', () => {
  it('puts the caret right after the n-th digit', () => {
    expect(caretAfterDigits('123/456/78901', 0)).toBe(0);
    expect(caretAfterDigits('123/456/78901', 3)).toBe(3);
    expect(caretAfterDigits('123/456/78901', 4)).toBe(5);
    expect(caretAfterDigits('123/456/78901', 11)).toBe(13);
    expect(caretAfterDigits('123/4', 9)).toBe(5);
  });
});
