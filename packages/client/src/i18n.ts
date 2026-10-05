import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import de from './locales/de.json';
import en from './locales/en.json';

export const languages = { en: 'English', de: 'Deutsch' } as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, de: { translation: de } },
    fallbackLng: 'en',
    supportedLngs: Object.keys(languages),
    // React escapes output already. A custom prefix keeps {{char}} and {{user}} literal in
    // strings that explain template placeholders.
    interpolation: { escapeValue: false, prefix: '%{', suffix: '}' },
    detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'teahouse.lang' },
  });

export default i18n;
