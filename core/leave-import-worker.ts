/** Leave ledger import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts, kind `leave_ledger`).
 * Per-step: one planned row per step, each re-checked under its own locks by the same writer the synchronous import
 * used, and committed with the kernel's applied marker so a resumed worker never writes a row twice. Row-level
 * success is the design (core/leave-import.ts: "not-atomic-by-design"); cancel keeps the rows already saved.
 * ADR 0181 J2: the first step of a chunk writes a group of following planned rows in a few set statements
 * (applyLeaveImportGroupTx, decided row by row exactly as the per-row writer decides); a group that declines rolls
 * back and its rows take the per-row writer, which records every outcome and refusal as before. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import type {LeaveImportResult} from '../lib/leave-import-schema';
import {appendLeaveImportCompletedTx, applyLeaveImportGroupTx, applyLeaveImportRowTx, isLeaveImportSetShape, planLeaveImport, type LeaveImportPlanRow} from '../packs/leave/service';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobStep, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {importGroupController} from './import-set-group';
import {LEAVE_LEDGER_IMPORT_KIND, type LeaveImportJobInput} from './leave-import-job';

/** Per-row step work per chunk before it commits. One per-row step measured about 30 ms and 6 statements at the
 * 70-company / 1,000-employment shape (ADR 0181 J2 profile); a set-based group (below) is one chunk of its own. */
export const LEAVE_IMPORT_CHUNK_BUDGET_MS = Number(process.env.LEAVE_IMPORT_CHUNK_BUDGET_MS ?? 100);
/** ADR 0181 J2, imports: set-based groups of planned rows (core/import-set-group.ts). LEAVE_IMPORT_GROUP_MAX=1
 * restores the per-row path for every row; LEAVE_IMPORT_CHUNK_TARGET_MS / _CEILING_MS / _FIXED_MULTIPLE size them. */
const groups = importGroupController<LeaveImportPlanRow, boolean>({
  kind: LEAVE_LEDGER_IMPORT_KIND, envPrefix: 'LEAVE_IMPORT',
  // At most 64 rows: a group's fixed cost (locks, leave types, the narrowed reads) is spread well before that, and a
  // declined group sends at most 64 rows to the per-row path.
  defaults: {groupMax: 64, targetMs: 200, ceilingMs: 400, fixedMultiple: 2, firstGroup: 16},
  perRowBudgetMs: () => LEAVE_IMPORT_CHUNK_BUDGET_MS, perRowMaxSteps: 16,
});
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
/** The one summary event, exactly once. In finalize the caller has fenced the transaction (unit.fenceTx holds the job
 * row's lock) and the job's own `finalized` marker commits with the event through unit.set. After a terminal state
 * (`unit` null) nothing may write the job any more: the kernel calls afterTerminal at most once per job, and the
 * committed marker read here still stops a second event after a finalize that already wrote one. */
async function appendSummaryTx(tx: Tx, ctx: SessionContext, job: BulkJobRow, unit: Pick<BulkJobUnit, 'set'> | null) {
  const [row] = await tx.execute<{plan: LeaveImportStoredPlan; counters: Record<string, number>}>(sql`select plan,counters from bulk_job where id=${job.id}::uuid`);
  if (!row || row.plan.finalized) return;
  await appendLeaveImportCompletedTx(tx, ctx, row.plan.batchId, {
    imported: Number(row.counters.imported ?? 0), failed: Number(row.counters.failed ?? 0), skipped: Number(row.counters.skipped ?? 0),
    totalRows: row.plan.totalRows, source: inputOf(job)?.source ?? null,
  });
  if (unit) await unit.set(tx, {planMerge: {finalized: true}});
}

export const leaveImportJobHandler: BulkJobHandler<LeaveImportPlanRow> = {
  kind: LEAVE_LEDGER_IMPORT_KIND,
  mode: 'per-step',
  // Chunks end by `endChunk`: after a set-based group, or once per-row steps reach LEAVE_IMPORT_CHUNK_BUDGET_MS or 16
  // steps (core/import-set-group.ts). The kernel budget is only a backstop below the lease.
  chunkBudgetMs: 30_000,
  // The pending steps a chunk reads: a group never extends past them.
  get maxStepsPerChunk() { return groups.maxSteps(); },
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
  /** No statement: the set-based group state of this chunk starts empty. */
  async beginChunkTx(_tx, _ctx, job) { groups.beginChunk(job.id); },
  async applyStepTx(tx, ctx, job, step) {
    const input = inputOf(job);
    const raw = (s: BulkJobStep<LeaveImportPlanRow>) => input.records[s.payload.result.rowNum - 1];
    // Counters describe committed effects, including a duplicate discovered under ownership.
    const counters = (written: boolean): Record<string, number> => written ? {imported: 1} : {skipped: 1};
    return groups.applyStep(tx, job, step, {
      shape: s => isLeaveImportSetShape(raw(s)),
      applyGroup: (savepoint, steps) => applyLeaveImportGroupTx(savepoint, ctx, steps.map(s => ({plan: s.payload, raw: raw(s)})), input.companyId),
      outcomeOf: written => ({counters: counters(written)}),
      perRow: async () => ({counters: counters(await applyLeaveImportRowTx(tx, ctx, step.payload, raw(step), input.companyId))}),
    });
  },
  /** The summary event under the creator's re-checked authority, then the same result the synchronous import returned. */
  async finalize(ctx, job, unit: BulkJobUnit) {
    groups.forget(job.id);
    if (!planOf(job).finalized) {
      await withTenant(ctx, async tx => {
        await tx.execute(sql`select set_config('application_name','aihr-bulk:leave_ledger:finalize',true)`);
        await unit.fenceTx(tx);
        if (!isAdmin(ctx)) throw new Error(notAdmin);
        await appendSummaryTx(tx, ctx, job, unit);
      });
    }
    // Counters, row refusals and plan as the creator (this kind has no owner finalize), on the lease.
    const [fresh] = await withTenant(ctx, async tx => {
      await unit.fenceTx(tx);
      return tx.execute<Pick<BulkJobRow, 'counters' | 'errors' | 'plan'>>(sql`select counters,errors,plan from bulk_job where id=${job.id}::uuid`);
    });
    return {result: leaveImportJobResult(fresh)};
  },
  /** A stopped or failed import that already processed rows still leaves its one summary event (best effort, as the
   * synchronous import's own summary transaction was). Nobody else can write it once the creator's access is gone. */
  async afterTerminal(ctx, job) {
    groups.forget(job.id);
    if (!ctx || job.state === 'completed' || !job.plan || planOf(job).finalized || !isAdmin(ctx)) return;
    if (!Number(job.steps_done)) return;
    await withTenant(ctx, tx => appendSummaryTx(tx, ctx, job, null));
  },
};
