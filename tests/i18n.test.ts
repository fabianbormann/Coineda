import { describe, it, expect, beforeAll } from 'vitest';
import en from '../src/translations/en.json';
import de from '../src/translations/de.json';

describe('i18n', () => {
  let i18n: any;

  beforeAll(async () => {
    i18n = (await import('../src/i18n')).default;
    await i18n.init();
  });

  it('interpolates the CoinGecko countdown in English', async () => {
    await i18n.changeLanguage('en');
    const message = i18n.t("CoinGecko's API limit has been reached", {
      countdown: 42,
    });
    expect(message).toContain('42');
    expect(message).not.toContain('{{countdown}}');
  });

  it('interpolates the CoinGecko countdown in German', async () => {
    await i18n.changeLanguage('de');
    const message = i18n.t("CoinGecko's API limit has been reached", {
      countdown: 42,
    });
    expect(message).toContain('42');
    expect(message).not.toContain('{{countdown}}');
    // "Sekunden" only appears in de.json's translation of this key (the
    // English string says "seconds"), so this fails if `de` didn't actually
    // load and i18next silently fell back to English.
    expect(message).toContain('Sekunden');
  });

  it('falls back to English for an unknown language', async () => {
    await i18n.changeLanguage('fr');
    // en.json maps "Dashboard" -> "Dashboard", so t('Dashboard') alone would
    // hold even with fallback broken or zero resources loaded. Assert the
    // language i18next actually resolved to, and additionally interpolate a
    // string that reads differently per locale so an English-only word
    // proves the English resource bundle specifically was used.
    expect(i18n.resolvedLanguage).toBe('en');
    const message = i18n.t("CoinGecko's API limit has been reached", {
      countdown: 42,
    });
    expect(message).toContain('seconds');
    expect(message).not.toContain('Sekunden');
  });
});

/**
 * The locale key sets must be IDENTICAL, not merely overlapping.
 *
 * Keys here are the English strings themselves, so a new UI string lands in
 * en.json and has to be added to de.json by hand - and changing English copy
 * means changing the key in de.json too. Nothing enforced that globally:
 * registry.test.ts checks both locales carry every source module's manifest
 * label and help, but a key added anywhere ELSE - a screen, a dialog, an
 * error message - could exist in one file only and pass CI, surfacing as an
 * untranslated English string in a German UI.
 *
 * This was checked by hand on every task of three milestones. It is cheaper
 * as a test.
 */
describe('the two locale files', () => {
  const enKeys = Object.keys(en.translation);
  const deKeys = Object.keys(de.translation);

  it('carry keys at all, so the comparisons below are not vacuous', () => {
    expect(enKeys.length).toBeGreaterThan(0);
    expect(deKeys.length).toBeGreaterThan(0);
  });

  it('have no key present in only one of them', () => {
    const onlyEn = enKeys.filter((key) => !(key in de.translation));
    const onlyDe = deKeys.filter((key) => !(key in en.translation));
    // Named separately rather than compared as sets: when this fails, the
    // message has to say WHICH file is missing WHICH key, or the failure
    // sends you diffing 343 keys by hand.
    expect({ onlyEn, onlyDe }).toEqual({ onlyEn: [], onlyDe: [] });
  });

  it('leave no translation empty', () => {
    // A key copied into de.json with an empty value satisfies the check
    // above while still rendering nothing on screen.
    const blank = deKeys.filter(
      (key) =>
        String((de.translation as Record<string, string>)[key]).trim() === '',
    );
    expect(blank).toEqual([]);
  });
});
