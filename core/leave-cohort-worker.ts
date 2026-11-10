/** Generate Entitlement and Run Earned Accrual as clients of the shared bulk-job kernel (core/bulk-job-worker.ts).
 * Per-step: one batch of employees per step, the unchanged engine running for that batch inside the chunk
 * transaction (core/leave-cohort-run.ts). Each employee's result is independent, so a refused batch is recorded and
 * the others continue; cancel keeps what was written. The engine's one summary event (and Generate Entitlement's
 * processing log) is written once at the end, under the creator's re-checked authority. */
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {publicErrorMessage} from '../lib/public-error';
import {applyGenerationAccrual, assertInformationLeavePeriodTx, completeLeaveGeneration, leaveGenerationHandover, openLeaveYear, planLeaveGeneration,
  type EarnedAccrualResult, type LeaveGenerationPlan, type LeaveGenerationRequest, type LeaveGenerationResult, type LeaveYearGrantRow} from '../packs/leave/service';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobPrepared, type BulkJobRefused, type BulkJobStepOutcome, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {LEAVE_ACCRUAL_JOB_KIND, LEAVE_GENERATION_JOB_KIND} from './leave-cohort-job';
import {appendLeaveCohortSummaryTx, batchesOf, earnedAccrualBatchTx, earnedAccrualRunSummary, leaveCohortEmploymentIdsTx, yearOpenRunSummary,
  type AccrualBatchOutcome, type EarnedAccrualRunInput, type LeaveCohortSummary} from './leave-cohort-run';

/** Engine work per chunk transaction before it commits (one or more batches). */
export const LEAVE_COHORT_CHUNK_BUDGET_MS = Number(process.env.LEAVE_COHORT_CHUNK_BUDGET_MS ?? 100);
/** Consecutive temporary refusals of one batch before it is recorded as not processed (the next run completes it). */
export const LEAVE_COHORT_STEP_RETRIES = 60;
type Batch = {employmentIds: string[]};
const notAdmin = 'Your access changed, so leave processing was stopped. Employees already processed keep their figures.';
const label = (tx: Tx, kind: string, phase: string) => tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);

/** A whole-run refusal decided before anything is written (the synchronous run refused the same way). */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; }
  catch (error) { if (isTransientBulkJobError(error)) throw error; return publicErrorMessage(error); }
}
const appliedResults = async <R>(tx: Tx, job: BulkJobRow, kind?: string) =>
  (await tx.execute<{result: R}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and state='applied' ${kind ? sql`and kind=${kind}` : sql``} order by seq`)).map(r => r.result);
/** Employees left unchanged by refused batches, kept on the job for the screen. */
async function failedEmployeesTx(tx: Tx, job: BulkJobRow) {
  const [row] = await tx.execute<{n: number}>(sql`select coalesce(sum(jsonb_array_length(payload->'employmentIds')),0)::int as n from bulk_job_step where job_id=${job.id}::uuid and state='failed' and kind in ('employees','open')`);
  return Number(row?.n ?? 0);
}
/** Exactly once: the work in `write` commits with the job's own marker, under the creator's re-checked authority. */
async function onceTx(ctx: SessionContext, job: BulkJobRow, unit: Pick<BulkJobUnit, 'fenceTx'> | null, marker: string, write: (tx: Tx) => Promise<void>) {
  await withTenant(ctx, async tx => {
    await label(tx, job.kind, 'finalize');
    if (unit) await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    const [row] = await tx.execute<{done: boolean}>(sql`select coalesce((plan->>${marker})::boolean,false) as done from bulk_job where id=${job.id}::uuid for update`);
    if (!row || row.done) return;
    await write(tx);
    await tx.execute(sql`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||jsonb_build_object(${marker}::text,true),updated_at=now() where id=${job.id}::uuid`);
  });
}

// ── Run Earned Accrual ─────────────────────────────────────────────────────────────────────────────────────────────
type AccrualStepResult = Pick<AccrualBatchOutcome, 'summary' | 'granted' | 'forfeits'>;
async function accrualSummaryOnce(ctx: SessionContext, job: BulkJobRow, unit: Pick<BulkJobUnit, 'fenceTx'> | null) {
  await onceTx(ctx, job, unit, 'finalized', async tx => {
    const payload = earnedAccrualRunSummary(await appliedResults<AccrualStepResult>(tx, job), null);
    if (payload) await appendLeaveCohortSummaryTx(tx, ctx, 'leave.earned-accrual.run', payload);
  });
}
export const earnedAccrualJobHandler: BulkJobHandler<Batch> = {
  kind: LEAVE_ACCRUAL_JOB_KIND,
  mode: 'per-step',
  chunkBudgetMs: LEAVE_COHORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: 8,
  transientStepLimit: LEAVE_COHORT_STEP_RETRIES,
  stepRef: step => `${step.payload.employmentIds.length}`,
  async prepare(ctx, job) {
    if (!isAdmin(ctx)) return {refused: notAdmin};
    const input = job.input as EarnedAccrualRunInput;
    let ids: string[] = [];
    const refused = await refusal(() => withTenant(ctx, async tx => {
      // The whole-scope check the synchronous run made before writing (information-only corrections).
      await assertInformationLeavePeriodTx(tx, input.asOf, {companyIds: input.companyIds, gradeIds: input.gradeIds});
      ids = await leaveCohortEmploymentIdsTx(tx, input);
    }));
    if (refused) return {refused};
    return {steps: batchesOf(ids).map((employmentIds, i) => ({kind: 'employees', rowNum: i + 1, payload: {employmentIds}})), counters: {employees: ids.length, granted: 0, forfeits: 0}, plan: {}};
  },
  async applyStepTx(tx, ctx, job, step) {
    const o = await earnedAccrualBatchTx(tx, ctx, job.input as EarnedAccrualRunInput, step.payload.employmentIds);
    const result: AccrualStepResult = {summary: o.summary, granted: o.granted, forfeits: o.forfeits};
    return {result, counters: {granted: o.granted, forfeits: o.forfeits}};
  },
  async finalize(ctx, job, unit) {
    await accrualSummaryOnce(ctx, job, unit);
    const failedEmployees = await withTenant(ctx, async tx => {
      const n = await failedEmployeesTx(tx, job);
      await tx.execute(sql`update bulk_job set counters=counters||jsonb_build_object('failedEmployees',${n}::int) where id=${job.id}::uuid`);
      return n;
    });
    const [row] = await unit.owner<{counters: Record<string, number>}[]>`select counters from bulk_job where id=${job.id}::uuid`;
    return {result: {granted: Number(row.counters.granted ?? 0), forfeits: Number(row.counters.forfeits ?? 0)}, counters: {failedEmployees}};
  },
  /** Stopped or failed after some batches: their summary event is still written once (best effort). */
  async afterTerminal(ctx, job) {
    if (!ctx || job.state === 'completed' || !Number(job.steps_done) || !isAdmin(ctx)) return;
    await accrualSummaryOnce(ctx, job, null);
  },
};

// ── Generate Entitlement ───────────────────────────────────────────────────────────────────────────────────────────
type GenerationStoredPlan = {generation?: LeaveGenerationPlan; empty?: LeaveGenerationResult; finalized?: boolean; eventsWritten?: boolean};
type OpenStepResult = {rows: LeaveYearGrantRow[]; summary: LeaveCohortSummary | null; granted: number; skipped: number; forfeits: number};
type AccrueStepResult = {skip: true; error?: undefined} | {skip?: undefined; error: string} | (AccrualBatchOutcome & {skip?: undefined; error?: undefined});
const isAccrued = (r: AccrueStepResult): r is AccrualBatchOutcome & {skip?: undefined; error?: undefined} => !r.skip && !r.error;
const generationPlanOf = (job: BulkJobRow) => (job.plan ?? {}) as GenerationStoredPlan;

/** Every year-open line written so far, in step order (the accrual hand-over reads the whole run's lines). */
async function openRowsTx(tx: Tx, job: BulkJobRow, cache?: Map<string, unknown>) {
  const cached = cache?.get('openRows') as OpenStepResult[] | undefined;
  if (cached) return cached;
  const rows = await appliedResults<OpenStepResult>(tx, job, 'open');
  cache?.set('openRows', rows);
  return rows;
}
async function generationEventsOnce(ctx: SessionContext, job: BulkJobRow, unit: Pick<BulkJobUnit, 'fenceTx'> | null) {
  const plan = generationPlanOf(job).generation;
  if (!plan) return;
  await onceTx(ctx, job, unit, 'eventsWritten', async tx => {
    const opens = await openRowsTx(tx, job);
    const handover = leaveGenerationHandover(plan, opens.flatMap(o => o.rows));
    const yearOpen = yearOpenRunSummary(opens.map(o => o.summary));
    if (yearOpen) await appendLeaveCohortSummaryTx(tx, ctx, 'leave-year.opened', yearOpen);
    const accrues = (await appliedResults<AccrueStepResult>(tx, job, 'accrue')).filter(isAccrued);
    const accrual = handover.call ? earnedAccrualRunSummary(accrues, handover.call.employmentIds) : null;
    if (accrual) await appendLeaveCohortSummaryTx(tx, ctx, 'leave.earned-accrual.run', accrual);
  });
}

export const leaveGenerationJobHandler: BulkJobHandler<Batch> = {
  kind: LEAVE_GENERATION_JOB_KIND,
  mode: 'per-step',
  chunkBudgetMs: LEAVE_COHORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: 8,
  transientStepLimit: LEAVE_COHORT_STEP_RETRIES,
  stepRef: step => `${step.payload.employmentIds.length}`,
  phaseOf: kind => kind === 'open' ? 'entitlement' : 'earned_accrual',
  /** ③ once, with no write transaction: who is selected, and the facts the earned hand-over needs. */
  async prepare(ctx, job): Promise<BulkJobPrepared | BulkJobRefused> {
    if (!isAdmin(ctx)) return {refused: notAdmin};
    const holder: {planned?: Awaited<ReturnType<typeof planLeaveGeneration>>} = {};
    const refused = await refusal(async () => {
      const planned = holder.planned = await planLeaveGeneration(ctx, job.input as LeaveGenerationRequest);
      const plan = planned.plan;
      // The year-open's whole-scope check, made before anything is written (it refused the whole run).
      if (plan) await withTenant(ctx, tx => assertInformationLeavePeriodTx(tx, `${plan.year}-01-01`, {employmentIds: plan.targets}));
    });
    if (refused || !holder.planned) return {refused: refused ?? 'Leave generation could not be prepared.'};
    const {plan, empty} = holder.planned;
    if (empty) return {steps: [], counters: {employees: 0}, plan: {empty} satisfies GenerationStoredPlan};
    const batches = batchesOf(plan.targets);
    return {
      steps: [...batches.map((employmentIds, i) => ({kind: 'open', rowNum: i + 1, payload: {employmentIds}})),
        ...batches.map((employmentIds, i) => ({kind: 'accrue', rowNum: i + 1, payload: {employmentIds}}))],
      counters: {employees: plan.targets.length, granted: 0, skipped: 0, forfeits: 0},
      plan: {generation: plan} satisfies GenerationStoredPlan,
    };
  },
  async applyStepTx(tx, ctx, job, step, cache): Promise<BulkJobStepOutcome> {
    const plan = generationPlanOf(job).generation!;
    if (step.kind === 'open') {
      let summary: LeaveCohortSummary | null = null;
      const res = await openLeaveYear(ctx, {year: plan.year, leaveTypeIds: plan.leaveTypeIds, employmentIds: step.payload.employmentIds}, {tx, onSummary: p => { summary = p; }});
      const result: OpenStepResult = {rows: res.rows, summary, granted: res.granted, skipped: res.skipped, forfeits: res.forfeits};
      const counters: Record<string, number> = {granted: res.granted, skipped: res.skipped, forfeits: res.forfeits};
      return {result, counters};
    }
    // The hand-over is decided on the WHOLE run's year-open lines, as in the synchronous run; each batch then accrues
    // its own handed employees across the run's handed leave types.
    const handover = leaveGenerationHandover(plan, (await openRowsTx(tx, job, cache)).flatMap(o => o.rows));
    const mine = new Set(step.payload.employmentIds);
    const employmentIds = handover.call?.employmentIds.filter(id => mine.has(id)) ?? [];
    if (!handover.call || !employmentIds.length) return {result: {skip: true} satisfies AccrueStepResult};
    try {
      const o = await tx.transaction(savepoint => earnedAccrualBatchTx(savepoint, ctx, {asOf: handover.call!.asOf}, employmentIds, {leaveTypeIds: handover.call!.leaveTypeIds}));
      const counters: Record<string, number> = {forfeits: o.forfeits};
      return {result: o satisfies AccrueStepResult, counters};
    } catch (error) {
      if (isTransientBulkJobError(error)) throw error;
      // As in the synchronous run, a failed earned part is reported and never undoes the entitlement written above.
      return {result: {error: (error as Error).message || 'Earned accrual failed.'} satisfies AccrueStepResult};
    }
  },
  /** The two engine summary events once, then the processing log with its own event, then the screen's result. */
  async finalize(ctx, job, unit) {
    const stored = generationPlanOf(job);
    if (stored.empty) return {result: stored.empty};
    if (stored.finalized) return {result: (await unit.owner<{result: unknown}[]>`select result from bulk_job where id=${job.id}::uuid`)[0].result};
    await generationEventsOnce(ctx, job, unit);
    const plan = stored.generation!;
    const {opens, accrues, failedEmployees} = await withTenant(ctx, async tx => ({
      opens: await openRowsTx(tx, job), accrues: await appliedResults<AccrueStepResult>(tx, job, 'accrue'), failedEmployees: await failedEmployeesTx(tx, job)}));
    const engineRows = opens.flatMap(o => o.rows);
    const counts = {granted: 0, skipped: 0, forfeits: 0};
    for (const o of opens) { counts.granted += o.granted; counts.skipped += o.skipped; counts.forfeits += o.forfeits; }
    const handover = leaveGenerationHandover(plan, engineRows);
    const written = accrues.filter(isAccrued);
    const failure = accrues.find(r => Boolean(r.error));
    const acc = {pairs: written.flatMap(r => r.pairs) as EarnedAccrualResult['pairs'], forfeits: written.reduce((n, r) => n + r.forfeits, 0),
      breakdown: [...new Map(written.flatMap(r => r.typeNames)).entries()].map(([leaveTypeId, leaveTypeName]) => ({leaveTypeId, leaveTypeName}))};
    // As in the synchronous run: the accrual half from what the engine wrote, and its failure recorded beside it.
    const accrual = handover.accrualStart();
    let accrued: EarnedAccrualResult['pairs'] = [];
    if (accrual && handover.call) {
      accrual.asOf = handover.call.asOf;
      if (written.length || !failure) { accrued = applyGenerationAccrual(accrual, handover, acc); counts.forfeits += acc.forfeits; }
      if (failure) accrual.error = failure.error!;
    }
    let result: unknown = null;
    await completeLeaveGeneration(ctx, plan, engineRows, counts, accrual, accrued, false, async (tx, runId, done) => {
      await unit.fenceTx(tx);
      if (!isAdmin(ctx)) throw new Error(notAdmin);
      result = {...done, runId};
      await tx.execute(sql`update bulk_job set result=${JSON.stringify(result)}::jsonb,plan=plan||'{"finalized":true}'::jsonb,
        counters=counters||jsonb_build_object('failedEmployees',${failedEmployees}::int),updated_at=now() where id=${job.id}::uuid`);
    });
    return {result, counters: {failedEmployees}};
  },
  /** Stopped or failed after the year-open wrote: its summary events are still written once (best effort). The
   * processing log is only written by a run that finished, as before. */
  async afterTerminal(ctx, job) {
    if (!ctx || job.state === 'completed' || !Number(job.steps_done) || !isAdmin(ctx)) return;
    await generationEventsOnce(ctx, job, null);
  },
};
