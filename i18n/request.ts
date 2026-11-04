import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import {messagesForLocale} from './catalogs';

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
