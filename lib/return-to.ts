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

/** Append a `toast=`/`error=` to a destination that may or may not already carry a query string. */
export function withQueryParam(destination: string, key: 'toast' | 'error', value: string): string {
  return `${destination}${destination.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}
