/**
 * Where a payroll draft-adjustment action sends the operator back to (7076f8af).
 *
 * The seven consolidation bridges (prefill overtime / claims / loans / shift differential / fixed zakat /
 * TP1, transfer allowances) and the per-employee input row all hard-redirected to `/payroll/<batchId>`.
 * That was correct while the only screen rendering them WAS the run screen. 7076f8af relocates that panel
 * to the Payroll Process wizard's Review step and to a screen under Transactions, and a button that yanks
 * you onto the very screen the change removes from the path is a worse bug than the one it replaces. So
 * each of those forms now posts the screen it was pressed on, and the action returns there.
 *
 * A posted destination is UNTRUSTED — it arrives in a FormData that anything can craft — so it is
 * whitelisted, not sanitised: only a path this product actually renders the panel on is accepted, and
 * anything else falls back to the run screen (today's behaviour). That rules out the open-redirect class
 * entirely; there is no scheme, host or protocol-relative form that can survive an exact-match against a
 * fixed list.
 *
 * DEPENDENCY-FREE on purpose (no next/*, no db): the actions module is `'use server'`, where every export
 * must be an async server action, so this rule cannot live there and still be unit-testable.
 */

/** The screens that render the draft-adjustment panel and may therefore ask to be returned to. */
export const ADJUSTMENT_RETURN_PATHS = ['/payroll/process', '/payroll/transactions/adjustments'] as const;

/**
 * Resolve the destination a draft-adjustment action redirects to.
 *
 * @param raw       whatever was posted as `returnTo` (may be absent, empty, or hostile)
 * @param batchId   the run being adjusted — its screen is the fallback and today's behaviour
 *
 * Accepts a bare whitelisted path, or a whitelisted path carrying a query string (the wizard resume link
 * is `/payroll/process?resume=<id>`, and the Transactions screen carries `?batchId=<id>`). The query is
 * preserved verbatim BUT only after the path before `?` matched exactly — a value like
 * `https://evil.example/payroll/process` has no whitelisted path segment and is rejected, and so is
 * `//evil.example` (protocol-relative), because neither equals a listed path.
 *
 * The returned value never carries a `toast=`/`error=` of its own: the caller appends one, and a posted
 * query that already contains those keys would double them. They are stripped here rather than in each of
 * the eight call sites.
 */
export function adjustmentReturnTo(raw: unknown, batchId: string): string {
  const fallback = `/payroll/${batchId}`;
  if (typeof raw !== 'string' || raw === '') return fallback;
  const [path, query = ''] = raw.split('?', 2);
  if (!(ADJUSTMENT_RETURN_PATHS as readonly string[]).includes(path)) return fallback;
  const kept = query
    .split('&')
    .filter((p) => p && !/^(toast|error)=/.test(p))
    .join('&');
  return kept ? `${path}?${kept}` : path;
}

/**
 * 9066bd6c — WHERE "BACK" GOES FROM A SCREEN BELOW PAYROLL PROCESS, filters and all.
 *
 * The Payroll Process list is driven entirely by the address bar (`app/payroll/dashboard-logic.ts` —
 * every control writes `?year=&m=&company=&cycle=&status=`). What loses the operator's selection is not
 * the filter bar: it is the row link and the fixed `back={{ href: '/payroll' }}` on the screens below
 * it, which throw the query away. The list therefore hands each row's links its own current query as
 * `?from=…`, and those screens send Back to the value they were given.
 *
 * WHITELISTED BY SHAPE, NOT SANITISED. A href taken straight out of `searchParams` is the open-redirect
 * shape, so the value is accepted only when it is a RELATIVE path under `/payroll`:
 *   • it must start with `/payroll`, and the next character must be end-of-string, `/` or `?` — so
 *     `/payrollevil.example` is refused as well as `/admin`;
 *   • a protocol-relative `//evil.example/payroll` fails the first rule (it does not start with
 *     `/payroll`), and so does any absolute `https://…` form, because neither begins with `/payroll`.
 * Anything else falls back to `/payroll`, which is exactly today's behaviour.
 *
 * `toast=` / `error=` are stripped for the same reason `adjustmentReturnTo` strips them: the caller
 * appends its own, and a round-tripped one would double.
 */
export function payrollListReturnTo(raw: unknown): string {
  const fallback = '/payroll';
  if (typeof raw !== 'string' || raw === '') return fallback;
  if (!raw.startsWith('/payroll')) return fallback;
  const next = raw.charAt('/payroll'.length);
  if (next !== '' && next !== '/' && next !== '?') return fallback;
  const [path, query = ''] = raw.split('?', 2);
  const kept = query
    .split('&')
    .filter((p) => p && !/^(toast|error)=/.test(p))
    .join('&');
  return kept ? `${path}?${kept}` : path;
}

/**
 * 65e2d5de — WHERE A SUCCESSFUL RESET LANDS: the list as the operator left it, MINUS the one filter that
 * would hide the run they just reset.
 *
 * `payrollListReturnTo` alone is not enough here, and the gap is specific to reset. The Payroll Process
 * list filters on status (`?status=…`, intersected in `applyFilters`), and Reset is offered on PROCESSED
 * runs ONLY — so "Status: Processed" is the natural filter to be standing in when you press it. Reset then
 * makes the run DRAFT. Handing the query back verbatim drops the operator on a filtered list that the row
 * they just acted on has fallen straight out of: a success toast over a table with no sign of the run,
 * which reads as "did that delete it?". Every other filter they set — year, months, company, cycle — still
 * matches the run and is kept untouched.
 *
 * CLEARED, NOT WIDENED, AND THE CONTROL IS WHY. The obvious alternative is to append `status=draft` and
 * keep `status=processed`, which sounds like it honours "your filters are still set" more faithfully. It
 * does not: the Status control (app/payroll/dashboard-filters.tsx) is a SINGLE `<select>` bound to
 * `filters.statuses[0]`, so a two-value query paints "Processed" in the dropdown above a table that is
 * also listing Draft rows — the filter bar would be making a false statement about the list under it, and
 * the next filter the operator touched would carry the invisible second value along. Replacing the value
 * with `draft` has the opposite problem: it is a filter they never chose, and it hides every processed run
 * they were looking at. Clearing is the only one of the three where the control and the list agree — the
 * dropdown reads "All statuses", which is exactly what is being shown.
 *
 * An EMPTY status filter already shows every status and is left exactly as it is, and so is a `status=draft`
 * that already admits the reset run. So is a destination that is not the list itself (`payrollListReturnTo`
 * also accepts `/payroll/…` sub-paths, where `status=` means nothing).
 */
export function payrollListAfterReset(raw: unknown): string {
  const dest = payrollListReturnTo(raw);
  const [path, query = ''] = dest.split('?', 2);
  if (path !== '/payroll') return dest;
  const params = query.split('&').filter(Boolean);
  // Defensive on the plural: the control emits at most one today, but `applyFilters` intersects a set.
  if (!params.some((p) => p.startsWith('status=') && p !== 'status=draft')) return dest;
  const kept = params.filter((p) => !p.startsWith('status='));
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

/** Append a `toast=`/`error=` to a destination that may or may not already carry a query string. */
export function withQueryParam(destination: string, key: 'toast' | 'error', value: string): string {
  return `${destination}${destination.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}
