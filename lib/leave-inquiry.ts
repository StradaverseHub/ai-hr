/**
 * Shared selection rules for the HR-admin leave inquiry screens (feedback 20c699f8 / 953be4b0).
 *
 * Pure and server-safe (no React, no db) so both inquiry pages agree on WHICH employee they are showing
 * and so the "open the tab without picking anyone" rule is unit-testable without a database.
 */

/** The subset of `listEmployees` these screens order and choose from. */
export type InquiryEmployee = {
  employmentId: string;
  name: string;
  company: string;
  employeeCode: string | null;
  terminatedOn: string | null;
};

/**
 * The reporter's order: Company A→Z, then Employee Name A→Z. Locale-aware and case-insensitive, because
 * "Acme" and "acme" landing in different halves of the list reads as a bug to the person scrolling it.
 */
export function sortInquiryEmployees<T extends InquiryEmployee>(rows: T[], locale?: string): T[] {
  const cmp = (a: string, b: string) => a.localeCompare(b, locale, { sensitivity: 'base' });
  return [...rows].sort((a, b) => cmp(a.company, b.company) || cmp(a.name, b.name));
}

/**
 * Which employee an EXPORT ROUTE serves: the requested one when it is actually in the (already
 * access-fenced) list, otherwise the first by company-then-name — "landing on Employee Balances without
 * having picked anyone shows the first employee" (20c699f8 §1).
 *
 * Falling back rather than erroring on an unknown id is deliberate: the id comes from a URL an admin may
 * have bookmarked before an employee left, or edited by hand. It is NOT an authorization decision — the
 * caller passes a list RLS already fenced, so an id outside it simply is not selectable here.
 *
 * ⚠️ 9949f91a (r369) — THE TWO SCREENS NO LONGER USE THIS, and the sentence above used to open "Which
 * employee the SCREEN shows". The reporter asked for "Select an employee to view their leave balances"
 * instead of quietly opening on whoever sorted first, so the screens resolve their selection through
 * `selectInquiryEmployee` below and this function keeps exactly the behaviour it always had for the two
 * export route handlers — which have no screen to prompt on and must answer SOMETHING or hand back a
 * workbook about nobody. `test/leave-balance-as-at-date.test.ts` pins that the screen and its export
 * validate `asOf` identically; that is a claim about the DATE and is untouched by this split.
 */
export function pickInquiryEmployee<T extends InquiryEmployee>(sorted: T[], requestedId?: string): T | undefined {
  return (requestedId ? sorted.find((e) => e.employmentId === requestedId) : undefined) ?? sorted[0];
}

/**
 * 9949f91a (r369) — which employee a leave inquiry SCREEN shows: the requested one, or NOBODY.
 *
 * THE FALLBACK IS THE THING THIS REMOVES, on the screens only. With the employee panel down the left-hand
 * side, opening the tab on whoever sorted first is worse than saying nothing: the reader is shown a real
 * person's real leave position without having asked for them, and the panel beside it marks nobody as
 * Selected, so the two halves of the screen disagree about who is being looked at.
 *
 * STILL NOT AN AUTHORIZATION DECISION, and the shape says so: the caller passes a list RLS has already
 * fenced, and this only ever NARROWS — an id that is not in that list selects nothing. That is also the
 * post-guard value the panel must be handed (`selectedId`), never the raw query param.
 */
export function selectInquiryEmployee<T extends InquiryEmployee>(sorted: T[], requestedId?: string): T | undefined {
  return requestedId ? sorted.find((e) => e.employmentId === requestedId) : undefined;
}

/**
 * The page numbers a numbered pager should print — "1 2 3 Next >" (650b6eb8 §ii) — for a 0-based `page`
 * out of `pageCount`. `null` marks a gap: the first and last page are always offered so a long list still
 * has one click to either end, and `span` pages either side of the current one keep the neighbourhood
 * reachable. Everything between collapses to an ellipsis rather than printing a hundred links.
 *
 * Pure and here rather than in the page, so the windowing is unit-testable without a database or a render.
 */
export function inquiryPageWindow(page: number, pageCount: number, span = 2): (number | null)[] {
  if (pageCount <= 0) return [];
  const shown = new Set<number>([0, pageCount - 1]);
  for (let p = page - span; p <= page + span; p++) if (p >= 0 && p < pageCount) shown.add(p);
  const out: (number | null)[] = [];
  let previous = -1;
  for (const p of [...shown].sort((a, b) => a - b)) {
    if (previous >= 0 && p - previous > 1) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}
