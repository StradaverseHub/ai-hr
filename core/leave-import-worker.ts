/** Leave ledger import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts, kind `leave_ledger`).
 * Per-step: one planned row per step, each re-checked under its own locks by the same writer the synchronous import
 * used, and committed with the kernel's applied marker so a resumed worker never writes a row twice. Row-level
 * success is the design (core/leave-import.ts: "not-atomic-by-design"); cancel keeps the rows already saved. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import type {LeaveImportResult} from '../lib/leave-import-schema';
import {appendLeaveImportCompletedTx, applyLeaveImportRowTx, planLeaveImport, type LeaveImportPlanRow} from '../packs/leave/service';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {LEAVE_LEDGER_IMPORT_KIND, type LeaveImportJobInput} from './leave-import-job';

/** Row work per chunk before it commits. One row measured about 27 ms of Access-lock time (bulk plan, section 1). */
export const LEAVE_IMPORT_CHUNK_BUDGET_MS = Number(process.env.LEAVE_IMPORT_CHUNK_BUDGET_MS ?? 100);
/** Consecutive temporary refusals of one row before it is reported as failed, so a stuck row cannot block the file. */
export const LEAVE_IMPORT_STEP_RETRIES = 30;
export type LeaveImportStoredPlan = {batchId: string; totalRows: number; otherCompany?: number; finalized?: boolean};

export const isTransientLeaveImportError = (error: unknown) => isTransientBulkJobError(error);
const inputOf = (job: BulkJobRow) => job.input as LeaveImportJobInput;
const planOf = (job: BulkJobRow) => job.plan as LeaveImportStoredPlan;
const notAdmin = 'Your access changed, so the leave import was stopped. Rows already saved are kept.';

/** The synchronous import's return value, from the job's counters and recorded row refusals. */
export function leaveImportJobResult(job: Pick<BulkJobRow, 'counters' | 'errors' | 'plan'>): LeaveImportResult {
  const plan = job.plan as LeaveImportStoredPlan;
  return {
    imported: Number(job.counters?.imported ?? 0),
    failed: (job.errors ?? []).map(e => ({rowNum: e.rowNum, employeeRef: e.ref, message: e.message})),
    skipped: Number(job.counters?.skipped ?? 0),
    totalRows: plan.totalRows,
    ...(plan.otherCompany === undefined ? {} : {otherCompany: plan.otherCompany}),
  };
}
/** The one summary event, exactly once: written with the job's own `finalized` marker in the same transaction. */
async function appendSummaryTx(tx: Tx, ctx: SessionContext, job: BulkJobRow) {
  const [row] = await tx.execute<{plan: LeaveImportStoredPlan; counters: Record<string, number>}>(sql`select plan,counters from bulk_job where id=${job.id}::uuid for update`);
  if (!row || row.plan.finalized) return;
  await appendLeaveImportCompletedTx(tx, ctx, row.plan.batchId, {
    imported: Number(row.counters.imported ?? 0), failed: Number(row.counters.failed ?? 0), skipped: Number(row.counters.skipped ?? 0),
    totalRows: row.plan.totalRows, source: inputOf(job)?.source ?? null,
  });
  await tx.execute(sql`update bulk_job set plan=plan||'{"finalized":true}'::jsonb,updated_at=now() where id=${job.id}::uuid`);
}

export const leaveImportJobHandler: BulkJobHandler<LeaveImportPlanRow> = {
  kind: LEAVE_LEDGER_IMPORT_KIND,
  mode: 'per-step',
  chunkBudgetMs: LEAVE_IMPORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: 16,
  transientStepLimit: LEAVE_IMPORT_STEP_RETRIES,
  isTransient: isTransientLeaveImportError,
  stepRef: step => step.payload.result.employeeRef,
  /** Validate the whole file once, with no write transaction or tenant lock held. */
  async prepare(ctx, job) {
    if (!isAdmin(ctx)) return {refused: notAdmin};
    const input = inputOf(job);
    const plan = await planLeaveImport(ctx, {records: input.records, companyId: input.companyId});
    const stored: LeaveImportStoredPlan = {batchId: randomUUID(), totalRows: plan.totalRows, ...(plan.otherCompany === undefined ? {} : {otherCompany: plan.otherCompany})};
    return {
      steps: plan.writable.map(row => ({kind: 'row', rowNum: row.result.rowNum, payload: row})),
      counters: {total: plan.totalRows, imported: 0, skipped: plan.skipped, failed: 0},
      plan: stored,
    };
  },
  async applyStepTx(tx, ctx, job, step) {
    const input = inputOf(job);
    const written = await applyLeaveImportRowTx(tx, ctx, step.payload, input.records[step.payload.result.rowNum - 1], input.companyId);
    // Counters describe committed effects, including a duplicate discovered under ownership.
    return {counters: written ? {imported: 1} : {skipped: 1}};
  },
  /** The summary event under the creator's re-checked authority, then the same result the synchronous import returned. */
  async finalize(ctx, job, unit: BulkJobUnit) {
    if (!planOf(job).finalized) {
      await withTenant(ctx, async tx => {
        await tx.execute(sql`select set_config('application_name','aihr-bulk:leave_ledger:finalize',true)`);
        await unit.fenceTx(tx);
        if (!isAdmin(ctx)) throw new Error(notAdmin);
        await appendSummaryTx(tx, ctx, job);
      });
    }
    const [fresh] = await unit.owner<BulkJobRow[]>`select counters,errors,plan from bulk_job where id=${job.id}::uuid`;
    return {result: leaveImportJobResult(fresh)};
  },
  /** A stopped or failed import that already processed rows still leaves its one summary event (best effort, as the
   * synchronous import's own summary transaction was). Nobody else can write it once the creator's access is gone. */
  async afterTerminal(ctx, job) {
    if (!ctx || job.state === 'completed' || !job.plan || planOf(job).finalized || !isAdmin(ctx)) return;
    if (!Number(job.steps_done)) return;
    await withTenant(ctx, tx => appendSummaryTx(tx, ctx, job));
  },
};
