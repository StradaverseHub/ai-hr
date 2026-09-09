/**
 * f1bbc572 (round 2) — WHAT A FAILED SYSTEM-LABEL WRITE IS ALLOWED TO PUT ON A SCREEN.
 *
 * The System Labels actions used to end `message: (e as Error).message`. For a database refusal that
 * string is drizzle's, and drizzle's is the driver's:
 *
 *   Failed query: update "department" set "name" = $1, "label" = $2, "description" = $3
 *   where "department"."id" = $4  params: RenamedByB,,edited by B,b22d7f28-…
 *
 * — SQL and parameter values, untranslated, in an admin's error banner. The reachable case is an
 * hr_admin editing a Global label whose ORIGIN company they do not administer: RLS (0016
 * `tenant_isolation … WITH CHECK app.is_admin_for(company_id)`) refuses the write, and f1bbc572 is what
 * made such a row visible to them in the first place.
 *
 * So a recognised refusal travels as one of these TOKENS instead of a sentence, and the grid resolves it
 * against `admin.systemLabels.<token>` — the same shape app/payroll/transactions/individual/page.tsx
 * uses for its `errorKeys`. A token is not a message: `messageOrToken` below is what turns it into one,
 * and anything that is NOT a token is an application error's own deliberate, already-readable sentence
 * (LabelInUseError, DuplicateError, CrossCompanyError), which passes through untouched.
 *
 * Pure and dependency-free so the server actions, both client grids and a test all read one list.
 */

/** Refusals the server can NAME. Each is a key under `admin.systemLabels` in all six locales. */
export const LABEL_ERROR_TOKENS = [
  /** The row's company is not one this admin administers — the RLS refusal above. */
  'notAdminForCompany',
  /** Criteria = Global is group-admin-only (the app.guard_is_global trigger, 0157). */
  'globalGroupAdminOnly',
  /** The database refused for a reason we do not model. Its own text is never shown. */
  'unexpectedError',
] as const;

export type LabelErrorToken = (typeof LABEL_ERROR_TOKENS)[number];

const TOKENS: ReadonlySet<string> = new Set(LABEL_ERROR_TOKENS);

export function isLabelErrorToken(v: string | null | undefined): v is LabelErrorToken {
  return v != null && TOKENS.has(v);
}

/**
 * Resolve what the server sent into text for a reader: a token through `t`, anything else verbatim.
 * `fallback` covers the no-message case (an atomic save whose per-row errors carry the detail).
 */
export function messageOrToken(
  raw: string | null | undefined,
  t: (key: string) => string,
  fallback: string,
): string {
  if (isLabelErrorToken(raw)) return t(raw);
  return raw?.trim() ? raw : fallback;
}
