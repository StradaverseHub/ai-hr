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
  return [...rows].sort((a, b) => cmp(a.company, b.company) || cmp(a.name, b.name) || a.employmentId.localeCompare(b.employmentId));
}

/** Legacy first-person selection helper, retained for compatibility.
 * 23e87eef: inquiry screens AND downloads now use the explicit All/single authorized contract in
 * core/leave-inquiry.ts. They never call this fallback, including for stale or inaccessible IDs.
 */
export function pickInquiryEmployee<T extends InquiryEmployee>(sorted: T[], requestedId?: string): T | undefined {
  return (requestedId ? sorted.find((e) => e.employmentId === requestedId) : undefined) ?? sorted[0];
}

/** Legacy optional-single selector. The inquiry owner now distinguishes absent All from refused IDs. */
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
