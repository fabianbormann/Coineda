import { describe, it, expect, beforeAll } from 'vitest';

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
