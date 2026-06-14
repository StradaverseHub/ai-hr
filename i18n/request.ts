import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import en from '../messages/en.json';

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

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  if (locale === 'en') return { locale, messages: en };
  const localeMessages = (await import(`../messages/${locale}.json`)).default as Dict;
  return { locale, messages: withFallback(en as Dict, localeMessages) as typeof en };
});
