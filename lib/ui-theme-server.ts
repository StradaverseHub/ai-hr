import { cache } from 'react';
import { cookies } from 'next/headers';
import { DEFAULT_UI_THEME, UI_THEME_COOKIE, resolveUiTheme, type UiTheme } from '@/lib/ui-theme';

/**
 * r401 — the UI theme on the SERVER, for the pages whose STRUCTURE differs by theme (Monolith rollout step
 * 4: the Dashboard and My Profile). ONE reader of the `ui_theme` cookie for the whole request: app/layout.tsx
 * writes `<html data-ui-theme>` from this same function, and a page that branches calls it too, so the
 * attribute the stylesheet keys on and the markup a page chose can never disagree (React `cache` makes it one
 * read per request, however many callers).
 *
 * Client components keep using `useUiTheme()` (components/ui-theme-context.tsx), which follows the attribute.
 *
 * Outside a request (a unit test that calls a page function directly) there is no cookie and no theme to
 * read; it answers the default, the same value the layout writes for an absent cookie. Every other error is
 * rethrown — in particular Next's own dynamic-rendering signals, which must reach the framework.
 */
export const currentUiTheme = cache(async (): Promise<UiTheme> => {
  let value: string | undefined;
  try {
    value = (await cookies()).get(UI_THEME_COOKIE)?.value;
  } catch (e) {
    if (e instanceof Error && /outside a request scope/.test(e.message)) return DEFAULT_UI_THEME;
    throw e;
  }
  return resolveUiTheme(value);
});
