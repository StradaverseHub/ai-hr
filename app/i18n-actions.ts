'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { LOCALE_COOKIE, isLocale, defaultLocale } from '@/i18n/config';

/** Set the active UI language (the top-bar language switcher). Cookie-based, no URL routing. */
export async function setLocale(formData: FormData) {
  const requested = String(formData.get('locale') ?? '');
  const locale = isLocale(requested) ? requested : defaultLocale;
  const cookieStore = await cookies();
  // 1-year persistent cookie so the choice survives sessions; lax so it rides top-level navigations.
  cookieStore.set(LOCALE_COOKIE, locale, {
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath('/', 'layout');
}
