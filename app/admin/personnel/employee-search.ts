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
 * WHAT THIS IS NOT. It is not a query and it never reaches the database. The caller hands it a list it
 * has ALREADY read under the session's scope (`listEmployees(s, scopeIds)`), so this can only ever
 * narrow that list. That is the whole reason the search cannot become a way around scope: there is no
 * widening path here to get wrong. The authoritative refusal still lives on the profile route, which
 * resolves the chosen id with `employeeDetail(s, id)` and 404s when it comes back null.
 */
export { matchEmployees, EMPLOYEE_SEARCH_RESULT_CAP as SWITCHER_RESULT_CAP } from '@/lib/employee-search';

/** The fields the switcher renders and matches on — a strict subset of a `listEmployees` row. */
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
