'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { UI_THEME_COOKIE, UI_THEME_COOKIE_MAX_AGE, isUiTheme } from '@/lib/ui-theme';

/**
 * r396 — set the viewer's UI theme (the switcher in the account menu). Rendering preference only: it
 * reads no session and touches no data, exactly like `setLocale` in app/i18n-actions.ts.
 *
 * Only the two named themes are accepted. Anything else is REFUSED (no cookie is written) rather than
 * coerced to the default — a server action is a public endpoint, and a malformed call should change
 * nothing. The layout would resolve a bad value to the default anyway (lib/ui-theme.ts).
 */
export async function setUiTheme(theme: unknown): Promise<{ ok: boolean }> {
  if (!isUiTheme(theme)) return { ok: false };
  const cookieStore = await cookies();
  // 1-year persistent cookie so the choice survives sessions; lax so it rides top-level navigations.
  cookieStore.set(UI_THEME_COOKIE, theme, {
    sameSite: 'lax',
    path: '/',
    maxAge: UI_THEME_COOKIE_MAX_AGE,
  });
  // Re-render the root layout so <html data-ui-theme> comes back from the server with the new value.
  revalidatePath('/', 'layout');
  return { ok: true };
}
