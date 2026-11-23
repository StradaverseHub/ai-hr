/**
 * The payroll progress polls (the run screen's processing panel and the wizard result screen's run-group panel).
 *
 * A read that throws is not a missing run. November 2026: the run-group read waits at most 5 s for the
 * tenant's Access lock (core/access-configuration-lock.ts) and gave up while background payroll jobs held it; the
 * route turned that into a 404 "Payroll run unavailable." beside a run that was saved and still processing. A failed
 * read now answers 503 with `retry`, and the panel keeps its last progress, says it is still checking and polls again.
 * Only a run the caller cannot see (or that does not exist) is "unavailable".
 */
const RETRY_AFTER_SECONDS = 2;

/** The failure's PostgreSQL SQLSTATE (such as 55P03), also when drizzle wraps the driver's error as its cause. */
function failureCode(error: unknown): string {
  for (let e = error as { code?: unknown; cause?: unknown; name?: unknown } | null, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++)
    if (typeof e.code === 'string') return e.code;
  return typeof (error as { name?: unknown } | null)?.name === 'string' ? (error as Error).name : 'unknown';
}

/** Logs only the failure's code, never its text. */
export function payrollProgressReadFailed(source: string, error: unknown, headers: Record<string, string>): Response {
  console.error(`[${source}] progress read failed`, failureCode(error));
  return Response.json({ retry: true }, { status: 503, headers: { ...headers, 'Retry-After': String(RETRY_AFTER_SECONDS) } });
}

/** The panel's reading of one poll response: progress, a read to retry, or a refusal with its message. */
export type PayrollProgressPoll<T> = { kind: 'progress'; payload: T } | { kind: 'retry' } | { kind: 'refused'; message: string };

export async function readPayrollProgressPoll<T>(response: Response): Promise<PayrollProgressPoll<T>> {
  const payload = await response.json().catch(() => null);
  if (response.ok && payload) return { kind: 'progress', payload: payload as T };
  if (response.status === 503 || (payload as { retry?: unknown } | null)?.retry === true) return { kind: 'retry' };
  return { kind: 'refused', message: typeof payload?.error === 'string' ? payload.error : '' };
}
