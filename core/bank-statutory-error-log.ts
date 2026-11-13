/**
 * Board d3ba1e9f — the Bank and Statutory Error Log, read from storage (bank_import_row) in bounded pages.
 *
 * Every read is a plain tenant read (bank_import_job/bank_import_row RLS: the job's creator, while they can still
 * view every company of the job — the same visibility as the progress screen and the old CSV). No Access lock, no
 * per-row query: one statement per page of at most BANK_ERROR_LOG_PAGE_ROWS rows, in Excel row order.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { bankJobTx, type BankImportJobRow } from './bank-import-job';
import { bankImportProblemLines, bankJobProblemLine, bankProblemColumns, redactBankRecord, type BankProblemRow } from '../lib/bank-import-problems';
import type { ImportProblemColumn, ImportProblemLine } from '../lib/import-problem-lines';
import { IMPORT_PROBLEM_SCREEN_LIMIT } from '../lib/import-problem-lines';
import { importProblemText, type ImportProblemText } from '../lib/import-problem-rules';

/** Rows per bounded read of the streamed log. */
export const BANK_ERROR_LOG_PAGE_ROWS = 1000;

type StoredRow = { ordinal: number; state: string; error: string | null; preview: BankProblemRow['preview']; record: Record<string, unknown> | null };

/** One page of problem rows after `after` (an ordinal), redacted for anything that may leave the server. */
async function problemRowsTx(tx: Tx, jobId: string, after: number, limit: number): Promise<BankProblemRow[]> {
  const rows = await tx.execute<StoredRow>(sql`select ordinal,state,error,preview,record from bank_import_row
    where job_id=${jobId}::uuid and ordinal>${after} and state in ('invalid','failed') order by ordinal limit ${limit}`);
  // Only what the Error Log uses leaves storage: the preview's proposed values are never passed on.
  return rows.map(row => ({ ordinal: row.ordinal, state: row.state, error: row.error, record: redactBankRecord(row.record),
    preview: row.preview ? { employeeCode: row.preview.employeeCode, employeeName: row.preview.employeeName, errors: row.preview.errors ?? [] } : null }));
}

/** Problem rows (not lines) the job counts: refused at the check plus not saved. */
const problemRowCount = (job: Pick<BankImportJobRow, 'invalid' | 'failed'>) => job.invalid + job.failed;

/** The first screen's worth of problem rows for the progress screen, and how many problem rows there are in all. */
export function bankImportProblems(ctx: SessionContext, jobId: string) {
  return withTenant(ctx, async tx => {
    const job = await bankJobTx(tx, jobId);
    return { rows: await problemRowsTx(tx, jobId, 0, IMPORT_PROBLEM_SCREEN_LIMIT), total: problemRowCount(job), error: job.error };
  });
}

/** The job header the streamed log needs before its first row (throws BankImportJobError when not visible). */
export function bankErrorLogJob(ctx: SessionContext, jobId: string) {
  return withTenant(ctx, tx => bankJobTx(tx, jobId));
}

/** Columns of the job's log: fixed up front, with the support-reference column when the job stopped with one. */
export function bankErrorLogColumns(fileLine: ImportProblemLine | null): ImportProblemColumn[] {
  return bankProblemColumns(!!fileLine?.errorReference);
}

/**
 * Every line of the job's Error Log, page by page: the whole-file line first (a stopped job), then each problem
 * row in Excel row order. Each page is its own short read; visibility is re-checked on every page.
 */
export async function* bankErrorLogPages(ctx: SessionContext, jobId: string, fileLine: ImportProblemLine | null, t: ImportProblemText): AsyncGenerator<ImportProblemLine[]> {
  if (fileLine) yield [fileLine];
  let after = 0;
  for (;;) {
    const rows = await withTenant(ctx, async tx => { await bankJobTx(tx, jobId); return problemRowsTx(tx, jobId, after, BANK_ERROR_LOG_PAGE_ROWS); });
    if (!rows.length) return;
    after = rows[rows.length - 1].ordinal;
    yield bankImportProblemLines(rows, t);
    if (rows.length < BANK_ERROR_LOG_PAGE_ROWS) return;
  }
}

/**
 * Import History (registered by core/import-error-log-registry.ts): the first page of a Bank and Statutory attempt's
 * Error Log for this viewer, or null when the attempt is not a Bank and Statutory import or its job is not visible.
 * `t.problems` is a ROOT translator (getTranslations()); the full log is the streamed
 * /admin/personnel/import/bank-statutory/jobs/<jobId>/error-log download.
 */
export async function bankStatutoryErrorLogFor(
  ctx: SessionContext,
  attemptId: string,
  t: { problems: (key: string, values?: Record<string, unknown>) => string; shared: (key: string) => string },
): Promise<{ lines: ImportProblemLine[]; total: number; truncated: boolean; jobId: string } | null> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId)) return null;
  const text = importProblemText(t.problems as Parameters<typeof importProblemText>[0]);
  const read = await withTenant(ctx, async tx => {
    const [attempt] = await tx.execute<{ kind: string; job_id: string | null }>(sql`select kind,plan->>'jobId' as job_id from import_attempt where id=${attemptId}::uuid`);
    if (attempt?.kind !== 'bank_statutory' || !attempt.job_id) return null;
    const [visible] = await tx.execute<{ id: string }>(sql`select id from bank_import_job where id=${attempt.job_id}::uuid`);
    if (!visible) return null;
    const job = await bankJobTx(tx, attempt.job_id);
    return { job, rows: await problemRowsTx(tx, job.id, 0, IMPORT_PROBLEM_SCREEN_LIMIT) };
  });
  if (!read) return null;
  const fileLine = bankJobProblemLine(read.job.error, text);
  const lines = [...(fileLine ? [fileLine] : []), ...bankImportProblemLines(read.rows, text)];
  const total = Math.max(lines.length, problemRowCount(read.job) + (fileLine ? 1 : 0));
  return { lines, total, truncated: total > lines.length, jobId: read.job.id };
}
