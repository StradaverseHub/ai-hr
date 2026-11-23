/**
 * The payroll progress polls (the run screen's processing panel and the wizard result screen's run-group panel).
 *
 * A busy read is not a missing run. November 2026: the run-group read waits at most 5 s for the tenant's Access
 * lock (core/access-configuration-lock.ts) and gave up while background payroll work held it; the route turned that
 * into a 404 "Payroll run unavailable." beside a run that was saved and still processing. A busy read now answers
 * 503 `{busy:true}`, and the panel keeps its last progress, says the server is busy and polls again. Only a run the
 * caller cannot see (or that does not exist or cannot be read) is "unavailable".
 */
import {pgSqlState} from '@/lib/db-error';
import {isDatabaseCapacityFailure} from '@/db/read-retry';
import {DATABASE_RETRY_AFTER_SECONDS} from '@/lib/database-capacity';

/** A bounded Access wait that ran out (55P03) or a database without capacity: the run is still there, the read just
 * could not start yet. */
export function isPayrollProgressBusy(error: unknown): boolean {
  return pgSqlState(error) === '55P03' || isDatabaseCapacityFailure(error);
}

/** The 503 a panel retries. Logs only the failure's SQLSTATE, never its text. */
export function payrollProgressBusy(source: string, error: unknown, headers: Record<string, string>): Response {
  console.error(`[${source}] progress read busy`, pgSqlState(error) ?? 'capacity');
  return Response.json({ busy: true }, { status: 503, headers: { ...headers, 'Retry-After': String(DATABASE_RETRY_AFTER_SECONDS) } });
}

/** The panel's reading of one poll response: progress, a busy read to retry, or a refusal with its message. */
export type PayrollProgressPoll<T> = { kind: 'progress'; payload: T } | { kind: 'busy' } | { kind: 'refused'; message: string };

export async function readPayrollProgressPoll<T>(response: Response): Promise<PayrollProgressPoll<T>> {
  const payload = await response.json().catch(() => null);
  if (response.ok && payload) return { kind: 'progress', payload: payload as T };
  if (response.status === 503 || (payload as { busy?: unknown } | null)?.busy === true) return { kind: 'busy' };
  return { kind: 'refused', message: typeof payload?.error === 'string' ? payload.error : '' };
}
