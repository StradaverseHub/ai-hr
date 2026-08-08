/**
 * PAGE-LEVEL company selection, resolved from a URL query parameter (20e759a0).
 *
 * WHY THIS IS NOT THE COMPANY SCOPE COOKIE, and this is the whole reason the helper exists rather than
 * the page just reading `company_scope`. `lib/scope.ts getScopeIds` is GLOBAL — one cookie shared by
 * Roster, Payroll, Personnel and every other screen. A configuration page that narrowed itself by
 * writing that cookie would silently re-scope the entire product for the admin, which is the opposite
 * of "let me configure one company without leaving this screen".
 *
 * So the global scope stays the OUTER bound (the caller still filters companies by `scopeIds`) and this
 * picks ONE from inside it, carried in the address so a link opens on the same company.
 *
 * THE FALLBACK IS LOAD-BEARING. `absent or unrecognised ⇒ the first visible company` is not defensive
 * padding: a bookmark kept after a company is archived, a scope cookie narrowed since the link was
 * copied, or simply the first visit with no parameter at all must all render a usable page. Returning
 * "nothing selected" would render an empty configuration screen that looks broken.
 *
 * Pure and dependency-free on purpose — it is unit-tested directly (test/replacement-leave-controls.test.ts)
 * rather than pinned by scanning the page source for a string.
 */

/** The sentinel that means "keep today's stacked, every-company view". Never a real company id (uuid). */
export const ALL_COMPANIES = 'all';

/**
 * Resolve `?company=` against the companies the caller may actually see.
 *
 * @param raw        the query parameter, exactly as it arrived (may be undefined / junk / stale).
 * @param visibleIds the in-scope company ids, in the order they are rendered.
 * @returns `ALL_COMPANIES`, one id from `visibleIds`, or `null` when there is nothing to show at all.
 */
export function resolveCompanyFilter(
  raw: string | undefined,
  visibleIds: readonly string[],
): string | null {
  // Checked before the membership test, not after: `all` is a reserved word here, and a company whose
  // id were literally "all" (impossible — ids are uuids) must not be able to shadow it.
  if (raw === ALL_COMPANIES) return ALL_COMPANIES;
  if (raw && visibleIds.includes(raw)) return raw;
  return visibleIds[0] ?? null;
}
