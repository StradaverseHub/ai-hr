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
 * Which employee the screen shows: the requested one when it is actually in the (already access-fenced)
 * list, otherwise the first by company-then-name — "landing on Employee Balances without having picked
 * anyone shows the first employee" (20c699f8 §1).
 *
 * Falling back rather than erroring on an unknown id is deliberate: the id comes from a URL an admin may
 * have bookmarked before an employee left, or edited by hand. It is NOT an authorization decision — the
 * caller passes a list RLS already fenced, so an id outside it simply is not selectable here.
 */
export function pickInquiryEmployee<T extends InquiryEmployee>(sorted: T[], requestedId?: string): T | undefined {
  return (requestedId ? sorted.find((e) => e.employmentId === requestedId) : undefined) ?? sorted[0];
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
