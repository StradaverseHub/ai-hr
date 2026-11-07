/**
 * Source helpers for declared shell-inventory assertions. Read lib/navigation/shell-inventory.ts
 * for rows/pack mounting and lib/navigation/shell-resolver.ts for visibility policy. Render and
 * interaction assertions still inspect/render components/sidebar.tsx. Do not concatenate the owners
 * to satisfy an assertion about one file: select the file that actually owns the fact.
 * Framework-free so callers supply their own assertions and failure messages.
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
