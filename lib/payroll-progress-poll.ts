/**
 * The payroll progress polls (the run screen's processing panel and the wizard result screen's run-group panel).
 * This is the browser half; the routes' busy classifier is lib/payroll-progress-poll.server.ts.
 *
 * A busy read is not a missing run. November 2026: the run-group read waits at most 5 s for the tenant's Access
 * lock (core/access-configuration-lock.ts) and gave up while background payroll work held it; the route turned that
 * into a 404 "Payroll run unavailable." beside a run that was saved and still processing. A busy read now answers
 * 503 `{busy:true}`, and the panel keeps its last progress, says the server is busy and polls again. Only a run the
 * caller cannot see (or that does not exist or cannot be read) is "unavailable".
 */

/** The panel's reading of one poll response: progress, a busy read to retry, or a refusal with its message. */
export type PayrollProgressPoll<T> = { kind: 'progress'; payload: T } | { kind: 'busy' } | { kind: 'refused'; message: string };

export async function readPayrollProgressPoll<T>(response: Response): Promise<PayrollProgressPoll<T>> {
  const payload = await response.json().catch(() => null);
  if (response.ok && payload) return { kind: 'progress', payload: payload as T };
  if (response.status === 503 || (payload as { busy?: unknown } | null)?.busy === true) return { kind: 'busy' };
  return { kind: 'refused', message: typeof payload?.error === 'string' ? payload.error : '' };
}
