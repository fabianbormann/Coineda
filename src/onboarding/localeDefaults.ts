/**
 * Starting point for the "start fresh" onboarding screen: a language and a
 * base currency guessed from the browser's locale, both still changeable by
 * the user before they confirm. The app only ships `en` and `de`
 * translations (see src/i18n.js), so `language` always resolves to one of
 * those two; `baseCurrency` is free.
 *
 * Every `baseCurrency` value here MUST be lowercase. `putSettings` in
 * src/settings/settingsStore.ts lowercases whatever it is given before
 * persisting it, because src/prices/priceStore.ts compares a holding's
 * asset id against `` `fiat:${currency}` `` in lowercase - but the
 * start-fresh screen pre-selects this value directly into a <Select>, so an
 * uppercase entry here would render as uppercase until the user touched the
 * field, even though it would end up lowercased on save.
 */
export type LocaleDefaults = {
  language: string;
  baseCurrency: string;
};

const FALLBACK: LocaleDefaults = { language: 'en', baseCurrency: 'usd' };

/**
 * Keyed by a lowercased locale fragment: either a bare language subtag
 * ('de', 'fr', ...) or, where the currency depends on the region rather
 * than the language (Swiss franc vs. euro, British pound vs. US dollar),
 * the more specific fragment that disambiguates it. `defaultsForLocale`
 * tries the full locale, then the region, then the language, against this
 * one table, so 'de-CH' resolves through the 'ch' entry to the franc while
 * plain 'de' still resolves to the euro.
 */
const LOCALE_TABLE: Record<string, LocaleDefaults> = {
  de: { language: 'de', baseCurrency: 'eur' },
  at: { language: 'de', baseCurrency: 'eur' },
  ch: { language: 'de', baseCurrency: 'chf' },
  en: FALLBACK,
  'en-us': { language: 'en', baseCurrency: 'usd' },
  'en-gb': { language: 'en', baseCurrency: 'gbp' },
  gb: { language: 'en', baseCurrency: 'gbp' },
  fr: { language: 'en', baseCurrency: 'eur' },
  es: { language: 'en', baseCurrency: 'eur' },
  it: { language: 'en', baseCurrency: 'eur' },
  nl: { language: 'en', baseCurrency: 'eur' },
  pl: { language: 'en', baseCurrency: 'pln' },
  pt: { language: 'en', baseCurrency: 'eur' },
  sv: { language: 'en', baseCurrency: 'sek' },
  se: { language: 'en', baseCurrency: 'sek' },
  da: { language: 'en', baseCurrency: 'dkk' },
  dk: { language: 'en', baseCurrency: 'dkk' },
  no: { language: 'en', baseCurrency: 'nok' },
  fi: { language: 'en', baseCurrency: 'eur' },
  cs: { language: 'en', baseCurrency: 'czk' },
};

/**
 * Never throws: an unmapped locale (or a malformed one - empty string,
 * missing region, anything) still has to produce a usable starting point a
 * new user can change, not a crash on first launch.
 */
export const defaultsForLocale = (locale: string): LocaleDefaults => {
  const normalized = (locale ?? '').toLowerCase();
  const [language, region] = normalized.split('-');

  return (
    LOCALE_TABLE[normalized] ??
    (region ? LOCALE_TABLE[region] : undefined) ??
    LOCALE_TABLE[language] ??
    FALLBACK
  );
};
