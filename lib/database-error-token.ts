/**
 * r388 — THE REFERENCE A REDACTED DATABASE ERROR CARRIES: `DB-<kind letter>-<six hex>`, e.g. `DB-P-7F3A2C`.
 *
 * lib/public-error.ts writes it into the English sentence that goes into `?error=` (so a page that prints the
 * raw param still shows something readable), and ErrorBanner / ToastFromQuery parse it back to show the same
 * sentence in the viewer's language. The kind travels inside the reference so the two never need a second
 * query parameter. Pure and tiny: imported by client components.
 */

export const DATABASE_ERROR_KINDS = {
  S: 'system',
  P: 'permission',
  D: 'duplicate',
  L: 'linked',
  V: 'invalidValue',
  R: 'rule',
  B: 'busy',
} as const;

export type DatabaseErrorKind = (typeof DATABASE_ERROR_KINDS)[keyof typeof DATABASE_ERROR_KINDS];

const LETTER_OF = Object.fromEntries(
  Object.entries(DATABASE_ERROR_KINDS).map(([letter, kind]) => [kind, letter]),
) as Record<DatabaseErrorKind, string>;

export function formatDatabaseErrorRef(kind: DatabaseErrorKind, id: string): string {
  return `DB-${LETTER_OF[kind]}-${id}`;
}

const REF = /\bDB-([SPDLVRB])-([0-9A-F]{6})\b/;

/** The kind and full reference inside a message, or null when the message is not a redacted database error. */
export function parseDatabaseErrorRef(message: string | null | undefined): { kind: DatabaseErrorKind; ref: string } | null {
  const m = REF.exec(message ?? '');
  if (!m) return null;
  return { kind: DATABASE_ERROR_KINDS[m[1] as keyof typeof DATABASE_ERROR_KINDS], ref: m[0] };
}
