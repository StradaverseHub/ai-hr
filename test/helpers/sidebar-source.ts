/**
 * Shared helpers for the sidebar source-text tests (a4e49748).
 *
 * `GROUPS` and the collapsible node consts are module-private in a `'use client'` component, so the
 * sidebar-structure tests read components/sidebar.tsx as text rather than importing it (no need to
 * render next-intl/lucide in a node test, and no behavior change to the component). These two helpers
 * were previously re-derived inline by each such test (test/sidebar-attendance-group.test.ts,
 * test/sidebar-personnel-manage.test.ts); new tests should import them from here. The existing tests
 * deliberately keep their inline copies for now — they can migrate opportunistically.
 *
 * Framework-free on purpose (no vitest import): callers assert on the return values with their own
 * failure messages.
 */

/** Count occurrences of the QUOTED needle so e.g. '/admin/attendance' does not match its
 *  '/admin/attendance-allowance' sibling. */
export const countQuoted = (haystack: string, needle: string): number =>
  haystack.split(`'${needle}'`).length - 1;

/**
 * Slice a module-level `const NAME = { ... };` object literal out of source text: from its
 * declaration to the terminating `\n};` (exclusive). Returns null when the declaration is missing
 * or unterminated, so the caller can fail with its own message.
 */
export function nodeBlock(src: string, constName: string): string | null {
  const start = src.indexOf(`const ${constName}`);
  if (start === -1) return null;
  const end = src.indexOf('\n};', start);
  if (end === -1) return null;
  return src.slice(start, end);
}
