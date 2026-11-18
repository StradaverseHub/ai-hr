/**
 * i18n configuration (ADR-0016). UI language is a separate axis from the statutory localization
 * packs (ADR-0008): the display language never changes which country's payroll/leave rules apply.
 * English is the source + fallback; any key missing from a locale falls back to English.
 */
export const locales = ['en', 'zh', 'ms', 'ta', 'th', 'vi'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** Endonyms — each language's name in its own script, for the switcher. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  zh: '简体中文',
  ms: 'Bahasa Melayu',
  ta: 'தமிழ்',
  th: 'ไทย',
  vi: 'Tiếng Việt',
};

/** The cookie that carries the chosen locale (no URL routing — internal app behind auth). */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}
