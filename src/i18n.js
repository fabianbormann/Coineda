import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import Cache from 'i18next-localstorage-cache';
import en from './translations/en.json';
import de from './translations/de.json';

i18n
  .use(initReactI18next)
  .use(Cache)
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

export default i18n;
