import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

describe('every literal t() key has an entry', () => {
  /**
   * The gap the key-set parity test above cannot see.
   *
   * That test proves en.json and de.json hold the SAME keys. A string that
   * exists in neither is identical in both, so it sails through - and
   * i18next hands an unknown key straight back, which renders the English
   * literal. The result is an English sentence in a German UI with nothing
   * failing anywhere. "Back to overview" shipped exactly that way.
   *
   * Only literal single-quoted calls are checkable; `t(source.lastError)`
   * and `t(KIND_LABELS[event.kind])` pass a value and are skipped by
   * construction.
   */
  const LITERAL_CALL = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;

  /** i18next resolves a `count` key through its plural forms, so the base
   *  key legitimately has no entry of its own. */
  const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Vendored shadcn components carry their own copy strings and are
        // not part of this app's translated surface.
        return full.endsWith(path.join('components', 'ui'))
          ? []
          : sourceFiles(full);
      }
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it('finds no key that is missing from en.json', () => {
    const keys = new Set(Object.keys(en.translation));
    const known = (key: string) =>
      keys.has(key) ||
      PLURAL_SUFFIXES.some((suffix) => keys.has(`${key}${suffix}`));

    const missing: string[] = [];
    const files = sourceFiles(path.join(__dirname, '..', 'src'));
    // Guards the scan itself: a glob that silently matched nothing would
    // make this test pass without checking anything at all.
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const match of contents.matchAll(LITERAL_CALL)) {
        const key = match[1].replace(/\\'/g, "'");
        if (!known(key)) {
          missing.push(`${key}  (${path.relative(process.cwd(), file)})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('instructions name the menu a user actually sees', () => {
  /**
   * An export instruction is only useful if it names the label on screen.
   * Kraken's German interface calls the ledgers export "Hauptbuch", so a
   * German string telling someone to look for "Ledgers" sends them hunting
   * for a word their screen does not contain - and the consequence is not
   * cosmetic: picking "Trades" instead yields a balance that looks right
   * and is larger than it is, because it leaves out every withdrawal.
   *
   * Checked here rather than in a rendered test, because the dialog test
   * renders in English and can never see this string at all.
   */
  // Indexed through a widened view: the JSON import is typed as a literal
  // object, so a key looked up at runtime is not one TypeScript knows.
  const english = en.translation as Record<string, string>;
  const german = de.translation as Record<string, string>;
  const krakenKey = Object.keys(english).find((key) =>
    key.startsWith('In Kraken, open Exports'),
  );

  it('has the Kraken instruction in both locales', () => {
    expect(krakenKey).toBeDefined();
    expect(german[krakenKey!]).toBeDefined();
  });

  it('uses the German menu labels in the German instruction', () => {
    const text = german[krakenKey!];
    // The one to pick, as Kraken labels it in German.
    expect(text).toContain('Hauptbuch');
    // And the three it must not be confused with.
    for (const wrong of ['Trades', 'Guthaben', 'Kontoauszug']) {
      expect(text).toContain(wrong);
    }
    // Never the English name for the one to pick.
    expect(text).not.toMatch(/\bLedgers\b/);
  });

  it('uses the English menu labels in the English instruction', () => {
    const text = english[krakenKey!];
    expect(text).toContain('"Ledgers"');
    for (const wrong of ['"Trades"', '"Balances"', '"Account statement"']) {
      expect(text).toContain(wrong);
    }
  });
});
