import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './translations/en.json';
import de from './translations/de.json';

i18n
  .use(initReactI18next)
  .use(LanguageDetector)
  .init({
    resources: {
      en: en,
      de: de,
    },
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

if (typeof document !== 'undefined') {
  const syncLang = (lng) => {
    if (lng) document.documentElement.lang = lng.split('-')[0];
  };
  i18n.on('languageChanged', syncLang);
  syncLang(i18n.resolvedLanguage || i18n.language);
}

export default i18n;
