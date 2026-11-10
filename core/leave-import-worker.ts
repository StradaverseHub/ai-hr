/**
 * Background worker for leave ledger imports. The owner connection only finds the next job and holds the
 * single-worker lock. Every HR write goes through the app role under the creator's fresh authority,
 * one row per transaction, with the checkpoint committed alongside the row.
 */
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {DatabaseAdmissionError} from '../db/admission';
import {isDatabaseCapacityFailure} from '../db/read-retry';
import {withBackgroundDatabaseWork} from '../db/workload';
import {withTenant, type SessionContext} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {publicErrorMessage} from '../lib/public-error';
import {freshImportContext} from './bank-import-worker';
import {LeaveDependencyUnavailable} from './leave-dependency-lock';
import {appendLeaveImportCompletedTx, applyLeaveImportRowTx, planLeaveImport} from './leave-import';
import {leaveImportJobTx, type LeaveImportJobRow} from './leave-import-job';

const CHUNK_BUDGET_MS = 250;
/** Row-level retries before a row is reported as failed, so a stuck row cannot block the job for ever. */
const MAX_TRANSIENT_RETRIES = 30;

export function isTransientLeaveImportError(error: unknown): boolean {
  if (error instanceof LeaveDependencyUnavailable) return error.reason === 'busy';
  const code = pgSqlState(error);
  return isDatabaseCapacityFailure(error) || code === '40P01' || code === '40001' || code === '55P03';
}

/** One bounded slice of one job. Returns false when it should wait before trying again. */
export function processLeaveImportJob(ctx: SessionContext, id: string): Promise<boolean> {
  return withBackgroundDatabaseWork(async () => {
    const job = await withTenant(ctx, tx => leaveImportJobTx(tx, id));
    if (!job) return false;
    if (job.state === 'queued') return planJob(ctx, job);
    if (job.state === 'importing') return applySlice(ctx, job);
    return true;
  });
}

/** Validates the file once, with no tenant locks held, and persists the plan. */
async function planJob(ctx: SessionContext, job: LeaveImportJobRow): Promise<boolean> {
  const plan = await planLeaveImport(ctx, {records: job.records});
  await withTenant(ctx, tx => tx.execute(sql`update leave_import_job set state='importing',plan=${JSON.stringify(plan.writable)}::jsonb,
    total=${plan.totalRows},skipped=${plan.skipped},updated_at=now() where id=${job.id}::uuid and state='queued'`));
  return true;
}

async function applySlice(ctx: SessionContext, job: LeaveImportJobRow): Promise<boolean> {
  const startedAt = performance.now();
  for (let index = job.next_index; index < job.plan.length; index++) {
    if (performance.now() - startedAt >= CHUNK_BUDGET_MS) return true;
    if (!await applyRow(ctx, job, index)) return false;
  }
  await finish(ctx, job.id);
  return true;
}

/** Writes one row and its checkpoint together. False means a transient refusal: stop and retry later. */
async function applyRow(ctx: SessionContext, job: LeaveImportJobRow, index: number): Promise<boolean> {
  const row = job.plan[index];
  try {
    await withTenant(ctx, async tx => {
      const written = await applyLeaveImportRowTx(tx, ctx, row, job.records[row.result.rowNum - 1]);
      await tx.execute(sql`update leave_import_job set next_index=${index + 1},imported=imported+${written ? 1 : 0},
        skipped=skipped+${written ? 0 : 1},retries=0,updated_at=now() where id=${job.id}::uuid and next_index=${index}`);
    });
    return true;
  } catch (error) {
    if (isTransientLeaveImportError(error) && await retryLater(ctx, job.id, index)) return false;
    // The row's transaction rolled back. Recording the refusal and moving on is its own small transaction;
    // a crash here repeats the row, which reaches the same refusal.
    const failure = {rowNum: row.result.rowNum, employeeRef: row.result.employeeRef, message: publicErrorMessage(error)};
    await withTenant(ctx, tx => tx.execute(sql`update leave_import_job set next_index=${index + 1},retries=0,
      failed=failed||${JSON.stringify([failure])}::jsonb,updated_at=now() where id=${job.id}::uuid and next_index=${index}`));
    return true;
  }
}

/** Counts a transient retry. False once the row has used its retries and should be reported instead. */
async function retryLater(ctx: SessionContext, id: string, index: number): Promise<boolean> {
  const [row] = await withTenant(ctx, tx => tx.execute<{retries: number}>(sql`update leave_import_job set retries=retries+1,updated_at=now()
    where id=${id}::uuid and next_index=${index} returning retries`));
  return (row?.retries ?? MAX_TRANSIENT_RETRIES) < MAX_TRANSIENT_RETRIES;
}

/** The summary event and the finished state commit together, once. */
async function finish(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async tx => {
    const job = await leaveImportJobTx(tx, id, true);
    if (!job || job.state !== 'importing') return;
    await appendLeaveImportCompletedTx(tx, ctx, job.batch_id, {imported: job.imported, failed: job.failed.length, skipped: job.skipped, totalRows: job.total, source: job.source});
    await tx.execute(sql`update leave_import_job set state='completed',updated_at=now() where id=${id}::uuid`);
  });
}

export async function runLeaveImportTick(owner: postgres.Sql): Promise<boolean> {
  const connection = await owner.reserve();
  try {
    const [lock] = await connection<{ok: boolean}[]>`select pg_try_advisory_lock(hashtextextended('leave-import-worker',0)) as ok`;
    if (!lock?.ok) return false;
    try {
      const [job] = await connection<LeaveImportJobRow[]>`select * from leave_import_job where state in ('queued','importing') order by updated_at,created_at limit 1`;
      if (!job) return false;
      try {
        return await processLeaveImportJob(await freshImportContext(job.context), job.id);
      } catch (error) {
        if (error instanceof DatabaseAdmissionError) return false;
        // Rows already saved stay saved; a bounded message only, because raw failures can contain employee values.
        await connection`update leave_import_job set state='failed',error='Import stopped. Rows already saved are retained.',updated_at=now() where id=${job.id}::uuid`;
        return true;
      }
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended('leave-import-worker',0))`;
    }
  } finally {
    await connection.release();
  }
}
