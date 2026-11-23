/**
 * The server half of the payroll progress polls (lib/payroll-progress-poll.ts holds the browser half). Kept apart
 * because the database failure classifier reaches server-only modules, and the panels that read the poll run in
 * the browser.
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
