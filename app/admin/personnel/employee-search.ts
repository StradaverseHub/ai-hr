/**
 * c002b3c3 — what is PERSONNEL-SPECIFIC about the "Search Employee" switcher.
 *
 * THE MATCHING RULE ITSELF NO LONGER LIVES HERE. It moved to `lib/employee-search.ts` when two payroll
 * screens (98e69987 Transaction Detail, f35f758a Individual Payslip) asked for the same "partial ID or
 * partial name" affordance in their own filter rows. One rule, one implementation, one set of tests —
 * `matchEmployees` and the result cap are re-exported below so every existing importer of this module,
 * and test/personnel-full-width-search.test.ts, keep working through the same specifier as before.
 *
 * What stays here is the part only Personnel has: the row shape the switcher renders, and the fact that
 * selection is a URL into /admin/personnel. Payroll's field posts a value into a GET form instead, which
 * is why `switcherHref` is not shared — see components/employee-search-field.tsx.
 *
 * Still a PURE module: no React, no next/* import. The client island stays thin, and the rule that decides
 * what a search shows stays testable on its own — which is the half of this feature that can silently go
 * wrong (a person you may see failing to appear looks identical to a person who does not exist).
 *
 * The live Personnel switcher now imports a bounded server action instead of receiving every employee.
 * core/employee-search.ts implements the same ranking in SQL before LIMIT; regression tests compare it
 * with this pure matcher. The action re-resolves admin/company scope, and the destination still calls
 * employeeDetail under the session before opening a profile.
 */
export { matchEmployees, EMPLOYEE_SEARCH_RESULT_CAP as SWITCHER_RESULT_CAP } from '@/lib/employee-search';

/** The fields the switcher renders — the server action returns only this projection. */
export type SwitcherEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  department: string | null;
};

/**
 * Where picking a result goes. Selection stays IN THE URL — the server component then resolves it under
 * the session's scope on the next request, which is what keeps the route's own guard authoritative. The
 * current tab rides along so switching employee lands you on the same tab you were reading, rather than
 * bouncing back to Profile on every jump.
 */
export function switcherHref(employmentId: string, tab?: string | null): string {
  const base = `/admin/personnel/${encodeURIComponent(employmentId)}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
}
