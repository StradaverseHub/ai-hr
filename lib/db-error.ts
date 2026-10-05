/**
 * r388 — WHAT COUNTS AS A DATABASE ERROR, IN ONE PLACE.
 *
 * Drizzle re-throws a failed statement as its own Error whose message is `Failed query: <the entire SQL>
 * params: <every bound value>`, with the driver's PostgresError on `.cause`. So `e.code` on the OUTER error is
 * undefined for every database refusal, and its message is SQL plus parameter values — record ids and, on a
 * personnel write, a person's name. That text reached `?error=` and the screen from ~180 call sites (f1bbc572,
 * 464b58e6 and the roster write path each patched one of them locally). This module only CLASSIFIES; what the
 * user is shown instead lives in lib/public-error.ts.
 *
 * Pure: no imports, safe for tests, scripts and core/.
 */

type Link = { code?: unknown; message?: unknown; name?: unknown };

/** The error and up to three causes beneath it, outermost first. */
export function pgErrorChain(e: unknown): { code?: string; message?: string; name?: string }[] {
  const out: { code?: string; message?: string; name?: string }[] = [];
  let cur = e as (Link & { cause?: unknown }) | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++) {
    out.push({
      code: typeof cur.code === 'string' ? cur.code : undefined,
      message: typeof cur.message === 'string' ? cur.message : undefined,
      name: typeof cur.name === 'string' ? cur.name : undefined,
    });
    cur = cur.cause as (Link & { cause?: unknown }) | null | undefined;
  }
  return out;
}

/** The SQLSTATE of the database refusal behind `e`, or undefined when `e` did not come from Postgres.
 *  (A SQLSTATE is five characters of [0-9A-Z]; Node's own `code`s — ECONNREFUSED, ERR_… — are not.) */
export function pgSqlState(e: unknown): string | undefined {
  return pgErrorChain(e).find((l) => /^[0-9A-Z]{5}$/.test(l.code ?? ''))?.code;
}

/** True when `e` is, or wraps, a database or driver failure: a SQLSTATE anywhere in the chain, drizzle's own
 *  wrapper (which is also what a dropped connection arrives as, with no SQLSTATE at all), or a Node network
 *  error such as ECONNREFUSED from a pool that never reached a query — whose message names the host and port. */
export function isDatabaseError(e: unknown): boolean {
  if (pgSqlState(e) !== undefined) return true;
  return pgErrorChain(e).some(
    (l) =>
      l.name === 'DrizzleQueryError' ||
      (l.message ?? '').startsWith('Failed query:') ||
      /^E(CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|HOSTUNREACH|NETUNREACH|PIPE|AI_AGAIN)$/.test(l.code ?? ''),
  );
}
