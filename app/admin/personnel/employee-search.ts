/**
 * c002b3c3 — the matching rule behind the Personnel "Search Employee" switcher.
 *
 * Deliberately a PURE module with no React and no next/* import, for two reasons: the client island can
 * stay a thin piece of chrome, and the rule that decides what a search shows is testable on its own —
 * which is the half of this feature that can silently go wrong (a person you may see failing to appear
 * looks identical to a person who does not exist).
 *
 * WHAT THIS IS NOT. It is not a query and it never reaches the database. The caller hands it a list it
 * has ALREADY read under the session's scope (`listEmployees(s, scopeIds)`), so this can only ever
 * narrow that list. That is the whole reason the search cannot become a way around scope: there is no
 * widening path here to get wrong. The authoritative refusal still lives on the profile route, which
 * resolves the chosen id with `employeeDetail(s, id)` and 404s when it comes back null.
 */

/** The fields the switcher renders and matches on — a strict subset of a `listEmployees` row. */
export type SwitcherEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  department: string | null;
};

/** How many matches the dropdown shows at once. A switcher is for jumping, not for browsing. */
export const SWITCHER_RESULT_CAP = 8;

/** Lowercase + strip the separators an Employee ID carries, so "emp0008" finds "EMP-0008". */
function fold(v: string): string {
  return v.toLowerCase().replace(/[\s._-]/g, '');
}

/**
 * Match on PARTIAL Employee ID or PARTIAL name, best match first.
 *
 * Ranking exists so pressing Enter on the first row is predictable: an exact Employee ID beats a code
 * that merely starts with what you typed, which beats a name that starts with it, which beats a
 * substring hit anywhere. Ties keep the caller's order (`listEmployees` sorts by full name), so the
 * list never reshuffles for reasons the user cannot see.
 */
export function matchEmployees<T extends { name: string; employeeCode: string | null }>(
  employees: readonly T[],
  query: string,
  cap: number = SWITCHER_RESULT_CAP,
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
 * Where picking a result goes. Selection stays IN THE URL — the server component then resolves it under
 * the session's scope on the next request, which is what keeps the route's own guard authoritative. The
 * current tab rides along so switching employee lands you on the same tab you were reading, rather than
 * bouncing back to Profile on every jump.
 */
export function switcherHref(employmentId: string, tab?: string | null): string {
  const base = `/admin/personnel/${encodeURIComponent(employmentId)}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
}
