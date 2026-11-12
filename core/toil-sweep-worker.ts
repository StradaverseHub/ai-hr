/**
 * Process expirations (`runToilExpiry`) and Close the replacement-leave year (`closeReplacementLeaveYear`) as clients
 * of the shared bulk-job kernel (core/bulk-job-worker.ts). Each used to be ONE request transaction holding the
 * tenant's Access lock, the leave-dependency configuration lock exclusively and every subject employee's locks for the
 * whole tenant. Here:
 *
 * - `prepare` reads the run's plan once (core/toil.ts `planToilExpiryTx` / `planReplacementYearCloseTx`): the
 *   employees to visit and, for the close, every whole-run idempotency decision (the boundary's markers, the legacy
 *   tenant-wide marker, "already closed"), made before any batch exactly as the synchronous close made them.
 * - The transaction that makes the steps runnable creates the tenant's REPLACEMENT leave type if the run will settle
 *   anything and the type is missing: the one configuration write, under the configuration lock exclusively.
 * - One step is one batch of employees (LEAVE_COHORT_BATCH_EMPLOYEES, 5 by default, and at most
 *   TOIL_SWEEP_BATCH_CREDITS credits unless one employee has more), one batch per chunk: one short
 *   transaction under the Access lock, the configuration lock SHARED and that batch's subject locks, through the
 *   unchanged executor (`expireAccrualsTx`) and the unchanged selection, boundary and carry-forward rules.
 * - Per-step: each accrual's settlement is independent and idempotent (only status 'active' rows are touched), so a
 *   busy employee is retried, and a batch that keeps failing is recorded and left unchanged while the others are
 *   written; the result says how many employees were not processed, and running the sweep again completes them.
 *   The synchronous sweeps were all-or-nothing; see docs/adr/2026-11-10-leave-family-bulk-jobs.md for why this is
 *   not staged and the open question it leaves.
 * - `finalize` writes the run's result (and, for the close, the per-company `replacement-leave-year.closed` markers
 *   with the subtotals the synchronous close computed, only for companies none of whose employees sits in a failed
 *   batch) once, under the creator's re-checked admin authority and the kernel's captured-grant fence.
 */
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {publicErrorMessage} from '../lib/public-error';
import {TOIL_EXPIRY_JOB_KIND, TOIL_YEAR_CLOSE_JOB_KIND} from '../lib/toil-sweep-job';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobPrepared, type BulkJobRefused, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {LeaveDependencyUnavailable} from './leave-dependency-lock';
import {LEAVE_COHORT_BATCH_EMPLOYEES} from './leave-cohort-run';
import {LEAVE_COHORT_CHUNK_BUDGET_MS, LEAVE_COHORT_STEP_RETRIES, LEAVE_COHORT_STEPS_PER_CHUNK} from './leave-cohort-worker';
import {addToilExpiryResults, appendReplacementYearClosedMarkersTx, assertToilSweepAuthority, closeReplacementLeaveYearBatchTx, combineReplacementYearCloseBatches,
  emptyToilExpiryResult, ensureReplacementLeaveTypeForSweepTx, findReplacementLeaveTypeIdTx, planReplacementYearCloseTx, planToilExpiryTx, runToilExpiryBatchTx,
  type CloseReplacementYearResult, type ReplacementYearCloseBatch, type ToilExpiryResult, type ToilSweepEmployee} from '../packs/leave/service';

/** Credits per batch at most, besides the family's employees per batch. A batch's lock hold grows with the credits
 * it settles (the close settles each credit through its own executor call: about six statements), so a few employees
 * with many banked credits are split across batches; an employee is never split (their locks cover all of them). */
export const TOIL_SWEEP_BATCH_CREDITS = Math.max(1, Number(process.env.TOIL_SWEEP_BATCH_CREDITS ?? 40));
export function toilSweepBatches<E extends ToilSweepEmployee>(employees: readonly E[], size = LEAVE_COHORT_BATCH_EMPLOYEES, credits = TOIL_SWEEP_BATCH_CREDITS): E[][] {
  const out: E[][] = [];
  let batch: E[] = [], held = 0;
  for (const e of employees) {
    if (batch.length && (batch.length >= size || held + e.credits > credits)) { out.push(batch); batch = []; held = 0; }
    batch.push(e); held += e.credits;
  }
  if (batch.length) out.push(batch);
  return out;
}

type Batch = {employmentIds: string[]; companyIds?: string[]};
const label = (tx: Tx, kind: string, phase: string) => tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);

/**
 * The sweeps' own refusals (`LeaveDependencyUnavailable`: a subject's credit lock or an accrual row held by another
 * writer, or the due set moving between the nomination and the locked re-read) mean another writer is busy with
 * those employees right now, so the batch is retried like every other temporary refusal; after
 * LEAVE_COHORT_STEP_RETRIES in a row it is recorded as not processed and the run moves on.
 */
export const isTransientToilSweepError = (error: unknown) => isTransientBulkJobError(error) || error instanceof LeaveDependencyUnavailable;

/** A whole-run refusal decided before anything is written (the synchronous sweep refused the same way). */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; }
  catch (error) { if (isTransientToilSweepError(error)) throw error; return publicErrorMessage(error); }
}
const appliedResults = async <R>(tx: Tx, job: BulkJobRow) =>
  (await tx.execute<{result: R}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and state='applied' order by seq`)).map(r => r.result);
const failedBatches = async (tx: Tx, job: BulkJobRow) =>
  (await tx.execute<{payload: Batch}>(sql`select payload from bulk_job_step where job_id=${job.id}::uuid and state='failed' order by seq`)).map(r => r.payload);
const stepsOf = (employees: readonly (ToilSweepEmployee & {companyId?: string})[]) =>
  toilSweepBatches(employees).map((batch, i) => ({kind: 'employees', rowNum: i + 1, payload: {employmentIds: batch.map(e => e.employmentId),
    ...(batch.some(e => e.companyId) ? {companyIds: [...new Set(batch.map(e => e.companyId!))].sort()} : {})} satisfies Batch}));
/** In the transaction that makes the steps runnable: the REPLACEMENT leave type, only when the run settles something
 * and the tenant has none yet (exclusive configuration lock, inside ensureReplacementLeaveTypeForSweepTx). */
async function ensureTypeTx(tx: Tx, ctx: SessionContext, settles: boolean) {
  if (!settles || await findReplacementLeaveTypeIdTx(tx, ctx.tenantId)) return;
  await ensureReplacementLeaveTypeForSweepTx(tx, ctx);
}
/** The run's one closing transaction: fenced on the lease, admin re-checked, written at most once (`final`). */
async function finalTx<R>(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit, write: (tx: Tx) => Promise<R>): Promise<R> {
  return withTenant(ctx, async tx => {
    await label(tx, job.kind, 'finalize');
    await unit.fenceTx(tx);
    assertToilSweepAuthority(ctx);
    // The fence holds the job row's lock; the marker is written through the kernel (sealed).
    const [row] = await tx.execute<{plan: {final?: R} | null}>(sql`select plan from bulk_job where id=${job.id}::uuid`);
    if (row?.plan?.final !== undefined) return row.plan.final;
    const final = await write(tx);
    await unit.set(tx, {planMerge: {final}});
    return final;
  });
}
const employeesOf = (batches: readonly Batch[]) => batches.reduce((n, b) => n + b.employmentIds.length, 0);
const common = {
  mode: 'per-step' as const,
  chunkBudgetMs: LEAVE_COHORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: LEAVE_COHORT_STEPS_PER_CHUNK,
  transientStepLimit: LEAVE_COHORT_STEP_RETRIES,
  isTransient: isTransientToilSweepError,
  stepRef: (step: {payload: Batch}) => `${step.payload.employmentIds.length}`,
};

// ── Process expirations ───────────────────────────────────────────────────────────────────────────────────────────
type ExpiryInput = {today: string};
type ExpiryPlan = {skippedOutOfScope: number; settles: boolean};
type ExpiryFinal = {result: ToilExpiryResult; failedEmployees: number};
export const toilExpiryJobHandler: BulkJobHandler<Batch> = {
  ...common,
  kind: TOIL_EXPIRY_JOB_KIND,
  async prepare(ctx, job): Promise<BulkJobPrepared | BulkJobRefused> {
    const input = job.input as ExpiryInput;
    let plan: Awaited<ReturnType<typeof planToilExpiryTx>> | undefined;
    const refused = await refusal(async () => { plan = await withTenant(ctx, tx => planToilExpiryTx(tx, ctx, {today: input.today})); });
    if (refused || !plan) return {refused: refused ?? 'The expiry run could not be prepared.'};
    return {steps: stepsOf(plan.employees), counters: {employees: plan.employees.length},
      plan: {skippedOutOfScope: plan.skippedOutOfScope, settles: plan.due > 0} satisfies ExpiryPlan};
  },
  async commitPrepareTx(tx, ctx, _job, prepared) {
    if ('steps' in prepared) await ensureTypeTx(tx, ctx, (prepared.plan as ExpiryPlan).settles);
  },
  async applyStepTx(tx, ctx, job, step) {
    const result = await runToilExpiryBatchTx(tx, ctx, {today: (job.input as ExpiryInput).today}, step.payload.employmentIds);
    return {result, counters: {processed: result.processed}};
  },
  async finalize(ctx, job, unit) {
    const plan = job.plan as ExpiryPlan;
    const final = await finalTx<ExpiryFinal>(ctx, job, unit, async tx => {
      let total = emptyToilExpiryResult();
      for (const part of await appliedResults<ToilExpiryResult>(tx, job)) total = addToilExpiryResults(total, part);
      // Counted once, before any batch, exactly as the synchronous sweep counted it.
      return {result: {...total, skippedOutOfScope: plan.skippedOutOfScope}, failedEmployees: employeesOf(await failedBatches(tx, job))};
    });
    return {result: final.result, counters: {failedEmployees: final.failedEmployees}};
  },
};

// ── Close the replacement-leave year ──────────────────────────────────────────────────────────────────────────────
type CloseInput = {asOf: string};
type ClosePlan = {already?: CloseReplacementYearResult; closedCompanies?: string[]; settles?: boolean};
type CloseFinal = {result: CloseReplacementYearResult; failedEmployees: number; markers: string[]};
export const toilYearCloseJobHandler: BulkJobHandler<Batch> = {
  ...common,
  kind: TOIL_YEAR_CLOSE_JOB_KIND,
  async prepare(ctx, job): Promise<BulkJobPrepared | BulkJobRefused> {
    const input = job.input as CloseInput;
    let plan: Awaited<ReturnType<typeof planReplacementYearCloseTx>> | undefined;
    const refused = await refusal(async () => { plan = await withTenant(ctx, tx => planReplacementYearCloseTx(tx, ctx, {asOf: input.asOf})); });
    if (refused || !plan) return {refused: refused ?? 'The year-end close could not be prepared.'};
    if (plan.alreadyClosed)
      return {steps: [], counters: {employees: 0}, plan: {already: {...emptyToilExpiryResult(), alreadyClosed: true, carriedForward: 0}} satisfies ClosePlan};
    return {steps: stepsOf(plan.employees), counters: {employees: plan.employees.length},
      plan: {closedCompanies: plan.closedCompanies, settles: plan.settles} satisfies ClosePlan};
  },
  async commitPrepareTx(tx, ctx, _job, prepared) {
    if ('steps' in prepared) await ensureTypeTx(tx, ctx, Boolean((prepared.plan as ClosePlan).settles));
  },
  async applyStepTx(tx, ctx, job, step) {
    const plan = job.plan as ClosePlan;
    const result: ReplacementYearCloseBatch = await closeReplacementLeaveYearBatchTx(tx, ctx,
      {asOf: (job.input as CloseInput).asOf, closedCompanies: plan.closedCompanies ?? []}, step.payload.employmentIds);
    return {result, counters: {processed: result.result.processed}};
  },
  async finalize(ctx, job, unit) {
    const plan = job.plan as ClosePlan;
    const asOf = (job.input as CloseInput).asOf;
    const final = await finalTx<CloseFinal>(ctx, job, unit, async tx => {
      if (plan.already) return {result: plan.already, failedEmployees: 0, markers: []};
      const whole = combineReplacementYearCloseBatches(await appliedResults<ReplacementYearCloseBatch>(tx, job));
      const failed = await failedBatches(tx, job);
      // A company with an employee in a batch that was not written gets no marker: its re-run must still find it open.
      const blocked = new Set(failed.flatMap(b => b.companyIds ?? []));
      const markers = await appendReplacementYearClosedMarkersTx(tx, ctx, {asOf}, whole.companies.filter(c => !blocked.has(c.companyId)));
      return {result: whole.result, failedEmployees: employeesOf(failed), markers};
    });
    return {result: final.result, counters: {failedEmployees: final.failedEmployees}};
  },
};
