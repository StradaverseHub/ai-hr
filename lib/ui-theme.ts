/**
 * r396 — the user-selectable UI THEME (Monolith rollout, step 1).
 *
 * Themes: Current (Plum + Ledger), `monolith` (the default — docs/design/monolith/) and `classic` (the indigo, rounded,
 * floating-shell look the app had before). The theme is ONE axis; light/dark (next-themes, the `.dark`
 * class) is the other, and the two are independent: every theme has a light and a dark palette.
 *
 * The choice is per browser, in the `ui_theme` cookie. app/layout.tsx reads it on the SERVER and writes
 * it as `<html data-ui-theme="…">`, so the very first paint is already in the right theme (no flash);
 * app/globals.css scopes Monolith's tokens under `:root[data-ui-theme="monolith"]`. An absent, empty or
 * unknown cookie value resolves to the default — a hand-edited cookie can never produce an unsupported state.
 *
 * Client-safe: no imports, so both the server layout and the client switcher share these constants.
 */
export const UI_THEME_COOKIE = 'ui_theme';
export const UI_THEMES = ['monolith', 'classic', 'current'] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export const DEFAULT_UI_THEME: UiTheme = 'monolith';
/** The attribute on <html> that globals.css scopes Monolith's tokens under. */
export const UI_THEME_ATTRIBUTE = 'data-ui-theme';
/** One year, in seconds — the same persistence as the language cookie. */
export const UI_THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && (UI_THEMES as readonly string[]).includes(value);
}

/** The theme a cookie value selects: the value itself when it names a theme, else the default. */
export function resolveUiTheme(value: string | null | undefined): UiTheme {
  return isUiTheme(value) ? value : DEFAULT_UI_THEME;
}
