/**
 * THE "find an employee by partial ID or partial name" RULE — one implementation, shared.
 *
 * It was written for the Personnel "Search Employee" switcher (c002b3c3) and lived inside
 * `app/admin/personnel/employee-search.ts`. Two payroll screens now ask for the same affordance at the top
 * of their own filter row (98e69987 Transaction Detail, f35f758a Individual Payslip), so the rule moves
 * here and the personnel module re-exports it. Nothing about the behaviour changed in the move — the
 * ranking, the folding and the cap are the same code, and test/employee-search-shared.test.ts pins them
 * independently of any screen.
 *
 * DELIBERATELY DEPENDENCY-FREE: no React, no `next/*`, no db. That is what lets a client island, a server
 * page and a plain unit test all import it without a cycle and without dragging anything into a bundle.
 *
 * WHAT THIS IS NOT. It is not a query and it never reaches the database. The caller hands it a list it has
 * ALREADY read under the session's scope, so this can only ever NARROW that list — there is no widening
 * path here to get wrong. Whatever route consumes the chosen id must still resolve it under the session
 * scope itself; a result list is never what grants access.
 */

/** The minimum a row must carry to be searchable. Callers pass their own wider row; the generic keeps it. */
export type EmployeeSearchRow = { name: string; employeeCode: string | null };

/** How many matches a search control offers at once. A search box is for jumping, not for browsing. */
export const EMPLOYEE_SEARCH_RESULT_CAP = 8;

/**
 * Lowercase + strip the separators an Employee ID carries, so "emp0008" finds "EMP-0008".
 *
 * r289 EXPORTED IT rather than copying it. `lib/employment-selection.ts` resolves a PASTED Employee ID to
 * an employment id and has to fold the token exactly as this file's search box folds a typed one — if the
 * two rules ever diverge, typing `emp0008` into the search finds Irwin while pasting it into the box
 * beside it finds nobody, and both halves' tests pass. One rule, one place. Both modules are
 * dependency-free, so the import adds nothing to any bundle.
 *
 * ⚠️ FOLDING IS LOSSY AND CALLERS MUST KNOW IT: `EMP-0008` and `EMP0008` are two DIFFERENT codes under
 * `employment_employee_code_uq` and fold to the same key. Ranking here can afford that (it offers both
 * rows and a human picks); a resolver cannot, which is why `resolveEmploymentSelection` refuses a folded
 * collision instead of choosing one.
 */
export function foldEmployeeCode(v: string): string {
  return v.toLowerCase().replace(/[\s._-]/g, '');
}
const fold = foldEmployeeCode;

/**
 * Match on PARTIAL Employee ID or PARTIAL name, best match first.
 *
 * Ranking exists so pressing Enter on the first row is predictable: an exact Employee ID beats a code
 * that merely starts with what you typed, which beats a name that starts with it, which beats a
 * substring hit anywhere. Ties keep the caller's order (`listEmployees` sorts by full name), so the
 * list never reshuffles for reasons the user cannot see.
 */
export function matchEmployees<T extends EmployeeSearchRow>(
  employees: readonly T[],
  query: string,
  cap: number = EMPLOYEE_SEARCH_RESULT_CAP,
): T[] {
  const raw = query.trim().toLowerCase();
  if (!raw) return [];
  const folded = fold(query);
  const scored: { e: T; rank: number; i: number }[] = [];
  employees.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const code = (e.employeeCode ?? '').toLowerCase();
    const codeFolded = fold(e.employeeCode ?? '');
    let rank: number | null = null;
    if (folded && codeFolded && codeFolded === folded) rank = 0;
    else if (folded && codeFolded && codeFolded.startsWith(folded)) rank = 1;
    else if (name.startsWith(raw)) rank = 2;
    else if (code.includes(raw) || (folded && codeFolded.includes(folded))) rank = 3;
    else if (name.includes(raw)) rank = 4;
    if (rank != null) scored.push({ e, rank, i });
  });
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return scored.slice(0, cap).map((s) => s.e);
}

/**
 * The same "partial Employee ID or partial name" rule as a PREDICATE, for the callers that FILTER a list
 * in place instead of offering a jump list.
 *
 * `matchEmployees` above ranks and CAPS (it answers "which eight rows should the switcher offer?"). The
 * Payroll Process wizard's Step-2 picker needs the opposite shape: keep every row that matches, in the
 * caller's own order, so the search can be AND-combined with the seven existing dropdowns and the
 * checkbox list stays stable while you type. Sharing the folding rule is the point — "emp0008" must find
 * "EMP-0008" in the picker for exactly the same reason it does in the switcher.
 *
 * An empty/whitespace query matches EVERYTHING (a filter that is not set narrows nothing), which is the
 * opposite of `matchEmployees`, where an empty query offers nothing to jump to.
 */
export function matchesEmployeeSearch(row: EmployeeSearchRow, query: string): boolean {
  const raw = query.trim().toLowerCase();
  if (!raw) return true;
  const folded = fold(query);
  const name = row.name.toLowerCase();
  const code = (row.employeeCode ?? '').toLowerCase();
  const codeFolded = fold(row.employeeCode ?? '');
  return name.includes(raw) || code.includes(raw) || (!!folded && !!codeFolded && codeFolded.includes(folded));
}
