/**
 * Server-translated text for a mobile response, from the web's own catalogues (messages/*.json), in the locale
 * lib/mobile-api/request.ts mobileLocale resolved. A missing or blank key falls back to English, as the web's
 * i18n/request.ts does; a key absent from English too is null (the caller then sends nothing, never a raw key).
 *
 * next-intl's request config is not used: it reads the web's locale cookie, and a bearer-token request has none.
 */
import { createTranslator } from 'next-intl';
import en from '../../messages/en.json';
import type { Locale } from '../../i18n/config';

type Translate = { (key: string, values?: Record<string, string | number>): string; has(key: string): boolean };
const make = (locale: Locale, messages: unknown, namespace: string) =>
  createTranslator({ locale, messages: messages as never, namespace: namespace as never, onError: () => {}, getMessageFallback: () => '' }) as unknown as Translate;

export async function mobileTranslator(locale: Locale, namespace: string): Promise<(key: string, values?: Record<string, string | number>) => string | null> {
  const base = make('en', en, namespace);
  const own = locale === 'en' ? base : make(locale, (await import(`../../messages/${locale}.json`)).default, namespace);
  return (key, values) => {
    for (const t of locale === 'en' ? [base] : [own, base]) if (t.has(key)) { const text = t(key, values); if (text) return text; }
    return null;
  };
}
