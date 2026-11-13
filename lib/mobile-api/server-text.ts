/**
 * Server-translated text for a mobile response, from the web's own catalogues (messages/*.json), in the locale
 * lib/mobile-api/request.ts mobileLocale resolved. A missing or blank key falls back to English, as the web's
 * i18n/request.ts does; a key absent from English too is null (the caller then sends nothing, never a raw key).
 *
 * `catalogue`: `web` (the default) reads messages/<locale>.json; `aiCentre` reads messages/ai-centre/<locale>.json,
 * the AI Centre and Today loop-card strings (today.loops, today.autonomy) that i18n/catalogs.ts merges over the web
 * catalogue for the web. Each resolves within its own catalogue only.
 *
 * next-intl's request config is not used: it reads the web's locale cookie, and a bearer-token request has none.
 */
import { createTranslator } from 'next-intl';
import en from '../../messages/en.json';
import aiCentreEn from '../../messages/ai-centre/en.json';
import type { Locale } from '../../i18n/config';

type Translate = { (key: string, values?: Record<string, string | number>): string; has(key: string): boolean };
const make = (locale: Locale, messages: unknown, namespace: string) =>
  createTranslator({ locale, messages: messages as never, namespace: namespace as never, onError: () => {}, getMessageFallback: () => '' }) as unknown as Translate;

export type MobileCatalogue = 'web' | 'aiCentre';
const english: Readonly<Record<MobileCatalogue, unknown>> = { web: en, aiCentre: aiCentreEn };
const own = async (locale: Locale, catalogue: MobileCatalogue): Promise<unknown> =>
  (catalogue === 'aiCentre' ? await import(`../../messages/ai-centre/${locale}.json`) : await import(`../../messages/${locale}.json`)).default;

export async function mobileTranslator(locale: Locale, namespace: string, catalogue: MobileCatalogue = 'web'): Promise<(key: string, values?: Record<string, string | number>) => string | null> {
  const base = make('en', english[catalogue], namespace);
  const local = locale === 'en' ? base : make(locale, await own(locale, catalogue), namespace);
  return (key, values) => {
    for (const t of locale === 'en' ? [base] : [local, base]) if (t.has(key)) { const text = t(key, values); if (text) return text; }
    return null;
  };
}
