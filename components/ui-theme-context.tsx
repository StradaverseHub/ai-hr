'use client';

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { UI_THEME_ATTRIBUTE, isUiTheme, type UiTheme } from '@/lib/ui-theme';

/**
 * r398 — which UI theme the SHELL is painting in, for the few shell elements whose STRUCTURE differs by
 * theme (the Monolith rail's inline children and user line, the top line's route path and clock, the intent
 * bar, the status line). Everything that only LOOKS different is a `monolith:` CSS variant on the same
 * markup instead (app/globals.css) and never consults this.
 *
 * THE SOURCE OF TRUTH IS <html data-ui-theme>, the same attribute the CSS keys on, so a branch here and the
 * stylesheet can never disagree: the switcher (components/ui-theme-switcher.tsx) sets the attribute at once,
 * and the MutationObserver below re-renders every consumer in the same tick.
 *
 * ⚠️ NO ATTRIBUTE MEANS CLASSIC, deliberately — not the cookie default. The Monolith tokens and every
 * `monolith:` utility apply only UNDER the attribute, so a document without one is painted Classic by the
 * stylesheet; a component that rendered Monolith structure there would be Monolith markup in Classic paint.
 * The layout always writes the attribute (lib/ui-theme.ts resolves an absent cookie to Monolith first).
 *
 * The server has no document, so it renders the value app/layout.tsx resolved from the cookie, handed in
 * through <UiThemeProvider>; hydration reads the same value back (getServerSnapshot), so there is no
 * mismatch, and the attribute takes over from then on.
 */
const UiThemeContext = createContext<UiTheme>('classic');

export function UiThemeProvider({ theme, children }: { theme: UiTheme; children: ReactNode }) {
  return <UiThemeContext.Provider value={theme}>{children}</UiThemeContext.Provider>;
}

function readDocumentTheme(): UiTheme {
  const v = document.documentElement.getAttribute(UI_THEME_ATTRIBUTE);
  return isUiTheme(v) ? v : 'classic';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [UI_THEME_ATTRIBUTE] });
  return () => observer.disconnect();
}

export function useUiTheme(): UiTheme {
  const serverTheme = useContext(UiThemeContext);
  return useSyncExternalStore(subscribe, readDocumentTheme, () => serverTheme);
}

/** Shorthand for the one question every consumer actually asks. */
export function useIsMonolith(): boolean {
  return useUiTheme() === 'monolith';
}
