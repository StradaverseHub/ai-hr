import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import en from '../messages/en.json';
import aiCentreEn from '../messages/ai-centre/en.json';

type Dict = Record<string, unknown>;

/** Deep-merge a (partial) locale catalog over the English base so any missing or blank key falls
 *  back to English rather than rendering the raw key. Catalogs are nested string maps, never arrays. */
function withFallback(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = withFallback(b as Dict, v as Dict);
    } else if (v != null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

// Catalogs are static for the lifetime of a build. Cache only the merged messages,
// while each request independently resolves its explicit locale or cookie.
const englishMessages = withFallback(en as Dict, aiCentreEn as Dict) as typeof en;
const catalogs = new Map<Locale, Promise<typeof en>>();

function messagesForLocale(locale: Locale): Promise<typeof en> {
  if (locale === 'en') return Promise.resolve(englishMessages);
  const cached = catalogs.get(locale);
  if (cached) return cached;

  const loading = Promise.all([
    import(`../messages/${locale}.json`).then(module => module.default as Dict),
    import(`../messages/ai-centre/${locale}.json`).then(module => module.default as Dict),
  ]).then(([messages, aiCentre]) =>
    withFallback(englishMessages, withFallback(messages, aiCentre)) as typeof en,
  ).catch(error => {
    catalogs.delete(locale);
    throw error;
  });
  catalogs.set(locale, loading);
  return loading;
}

/**
 * 587ee719 — `requested` IS THE EXPLICIT OVERRIDE, AND IGNORING IT SILENTLY BROKE A FEATURE.
 *
 * next-intl calls this with `{locale}` set only when a caller asked for a specific one —
 * `getTranslations({locale, namespace})`, which the EA PDF route now uses to produce the C.P.8A in the
 * language the operator picked rather than the language their screen is set to. This callback used to
 * take no arguments and read the cookie unconditionally, so that override resolved to the COOKIE's
 * catalog: the route would return 200, render a perfectly valid PDF, and quietly be in the wrong
 * language. Nothing would have failed.
 *
 * Ordinary rendering is unchanged: `requested` is undefined for every render that did not name a locale,
 * and the cookie path below is then byte-for-byte what it always was. next-intl caches per requested
 * locale, so honouring this cannot leak one request's language into another's.
 */
export default getRequestConfig(async ({ locale: requested }) => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(requested)
    ? requested
    : isLocale(cookieLocale)
      ? cookieLocale
      : defaultLocale;

  return { locale, messages: await messagesForLocale(locale) };
});
