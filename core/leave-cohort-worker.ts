/** Generate Entitlement and Run Earned Accrual as clients of the shared bulk-job kernel (core/bulk-job-worker.ts).
 * Per-step: one batch of employees per step, the unchanged engine running for that batch inside the chunk
 * transaction (core/leave-cohort-run.ts). Each employee's result is independent, so a refused batch is recorded and
 * the others continue; cancel keeps what was written. The engine's one summary event (and Generate Entitlement's
 * processing log) is written once at the end, under the creator's re-checked authority. */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {publicErrorMessage} from '../lib/public-error';
import {applyGenerationAccrual, assertInformationLeavePeriodTx, readEarnedAccrualRunInputsTx, type EarnedAccrualRunInputs, completeLeaveGeneration, leaveGenerationHandover, openLeaveYear, planLeaveGeneration,
  type EarnedAccrualResult, type LeaveGenerationPlan, type LeaveGenerationRequest, type LeaveGenerationResult, type LeaveYearGrantRow} from '../packs/leave/service';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobPrepared, type BulkJobRefused, type BulkJobStepOutcome, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {LEAVE_ACCRUAL_JOB_KIND, LEAVE_GENERATION_JOB_KIND} from './leave-cohort-job';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockLeaveDependencyReadConfigurationTx} from './leave-dependency-lock';
import {discardLeaveStageRows, dropLeaveStageRowsTx, leaveConfigFingerprintTx, leaveRunInputFingerprintsTx, leaveStageConflictsTx, leaveStageFingerprintsTx, lockLeaveStageSubjectsTx,
  releaseLeaveStageTx, settleLeaveStages, useLeaveStageTx} from './leave-stage';
import {appendLeaveCohortSummaryTx, batchesOf, earnedAccrualBatchTx, earnedAccrualRunSummary, leaveCohortEmploymentIdsTx, yearOpenRunSummary,
  type AccrualBatchOutcome, type EarnedAccrualRunInput, type LeaveCohortSummary} from './leave-cohort-run';

/** Engine work per chunk transaction before it commits (one or more batches). */
export const LEAVE_COHORT_CHUNK_BUDGET_MS = Number(process.env.LEAVE_COHORT_CHUNK_BUDGET_MS ?? 100);
/** Batches per chunk transaction at most. One: a chunk then holds the tenant's locks for one batch only. */
export const LEAVE_COHORT_STEPS_PER_CHUNK = Math.max(1, Number(process.env.LEAVE_COHORT_STEPS_PER_CHUNK ?? 1));
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
/**
 * The run's once-per-run reads (leave types, tables in force, the template resolver for every employee), made once
 * per run in `prepare` (its own READ ONLY snapshot, no transaction or tenant lock held; at 3,000 employees about a
 * second) and reused by every batch while they are still current, instead of again in every batch's lock hold.
 * Before each batch, under the same first locks the engine takes (the tenant's Access lock, which every workforce
 * writer takes too, and the leave configuration shared), one statement re-checks the configuration and the batch's
 * employment and assignment rows against what the reads saw; anything changed and the batch reads for itself. Kept
 * in this worker process: a batch run by another process (after a restart) simply reads for itself. Never built
 * inside a chunk: a second transaction opened while the chunk holds its connection is refused by background
 * admission, and the step would retry for ever.
 */
type AccrualRunCache = {inputs: EarnedAccrualRunInputs; configFp: string; orgFp: Record<string, string>};
const accrualRunInputs = new Map<string, AccrualRunCache>();
async function readAccrualRunInputs(ctx: SessionContext, input: EarnedAccrualRunInput, employmentIds: string[]): Promise<AccrualRunCache> {
  return withTenant(ctx, async read => {
    const fresh = await leaveRunInputFingerprintsTx(read, employmentIds);
    const inputs = await readEarnedAccrualRunInputsTx(read, {asOf: input.asOf, leaveTypeIds: input.leaveTypeIds, employmentIds, periodChecked: true});
    return {inputs, configFp: fresh.configFp, orgFp: fresh.orgFp};
  }, {readOnlySnapshot: true});
}
async function accrualRunInputsTx(tx: Tx, ctx: SessionContext, job: BulkJobRow, batch: string[]): Promise<EarnedAccrualRunInputs | undefined> {
  const held = accrualRunInputs.get(job.id);
  if (!held) return undefined;
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  await lockLeaveDependencyReadConfigurationTx(tx, ctx.tenantId);
  const now = await leaveRunInputFingerprintsTx(tx, batch);
  // The configuration moved: this batch and every later one read for themselves.
  if (held.configFp !== now.configFp) { accrualRunInputs.delete(job.id); return undefined; }
  return batch.every(id => held.orgFp[id] !== undefined && held.orgFp[id] === now.orgFp[id]) ? held.inputs : undefined;
}
export const earnedAccrualJobHandler: BulkJobHandler<Batch> = {
  kind: LEAVE_ACCRUAL_JOB_KIND,
  mode: 'per-step',
  chunkBudgetMs: LEAVE_COHORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: LEAVE_COHORT_STEPS_PER_CHUNK,
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
    accrualRunInputs.set(job.id, await readAccrualRunInputs(ctx, input, ids));
    return {steps: batchesOf(ids).map((employmentIds, i) => ({kind: 'employees', rowNum: i + 1, payload: {employmentIds}})), counters: {employees: ids.length, granted: 0, forfeits: 0}, plan: {}};
  },
  async applyStepTx(tx, ctx, job, step) {
    const input = job.input as EarnedAccrualRunInput;
    const preload = await accrualRunInputsTx(tx, ctx, job, step.payload.employmentIds);
    const o = await earnedAccrualBatchTx(tx, ctx, input, step.payload.employmentIds, {preload});
    const result: AccrualStepResult = {summary: o.summary, granted: o.granted, forfeits: o.forfeits};
    return {result, counters: {granted: o.granted, forfeits: o.forfeits}};
  },
  async finalize(ctx, job, unit) {
    accrualRunInputs.delete(job.id);
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
    accrualRunInputs.delete(job.id);
    if (!ctx || job.state === 'completed' || !Number(job.steps_done) || !isAdmin(ctx)) return;
    await accrualSummaryOnce(ctx, job, null);
  },
};

// ── Generate Entitlement ───────────────────────────────────────────────────────────────────────────────────────────
// All-or-nothing, as the synchronous run was: its year-open was one transaction and its earned Annual Leave part a
// second one, and a failure in either wrote nothing of that part. Here every batch writes STAGED rows
// (core/leave-stage.ts): the year-open's under one stage, the earned part's under another, both visible to the
// job's own transactions only. A year-open batch that is refused stops the job and discards both stages (the old
// run threw before writing). An earned batch that is refused marks the earned part failed: the remaining earned
// batches are skipped and, at release, its stage is dropped while the year-open is released, so the entitlement
// stays and the earned part reads as not run, exactly as the old run reported it. Release is one short transaction
// under every selected employee's lock that first re-checks what each batch read; a changed employee is computed
// again before release is tried again. The two summary events are written in the release transaction, with the rows.
type GenerationStage = {open: string; accrue: string};
type GenerationStoredPlan = {generation?: LeaveGenerationPlan; empty?: LeaveGenerationResult; finalized?: boolean;
  stage?: GenerationStage; released?: boolean; settled?: boolean; restage?: number[]; releaseAttempts?: number};
type OpenStepResult = {rows: LeaveYearGrantRow[]; summary: LeaveCohortSummary | null; granted: number; skipped: number; forfeits: number;
  /** What the batch read (core/leave-stage.ts), compared at release. */
  fp?: Record<string, string>; configFp?: string};
type AccrueStepResult = {skip: true; error?: undefined} | {skip?: undefined; error: string} | (AccrualBatchOutcome & {skip?: undefined; error?: undefined});
const isAccrued = (r: AccrueStepResult): r is AccrualBatchOutcome & {skip?: undefined; error?: undefined} => !r.skip && !r.error;
const generationPlanOf = (job: BulkJobRow) => (job.plan ?? {}) as GenerationStoredPlan;
/** Release attempts before the job gives up because the selected employees keep changing (then nothing is kept). */
export const LEAVE_STAGE_RELEASE_ATTEMPTS = 40;
const stagesOf = (s: GenerationStage) => [s.open, s.accrue];

/** Every year-open line written so far, in step order (the accrual hand-over reads the whole run's lines). */
async function openRowsTx(tx: Tx, job: BulkJobRow, cache?: Map<string, unknown>) {
  const cached = cache?.get('openRows') as OpenStepResult[] | undefined;
  if (cached) return cached;
  const rows = await appliedResults<OpenStepResult>(tx, job, 'open');
  cache?.set('openRows', rows);
  return rows;
}
/** Whether an earned batch was refused (the earned part then fails as a whole, as the single accrual call did). */
async function accrualFailedTx(tx: Tx, job: BulkJobRow) {
  const [row] = await tx.execute<{failed: boolean}>(sql`select exists(select 1 from bulk_job_step where job_id=${job.id}::uuid and kind='accrue' and result ? 'error') as failed`);
  return Boolean(row?.failed);
}
const handoverKey = (call: ReturnType<typeof leaveGenerationHandover>['call']) => call ? JSON.stringify([call.asOf, [...call.leaveTypeIds].sort()]) : '';

/** One year-open batch, staged, with what it read. */
async function openBatchTx(tx: Tx, ctx: SessionContext, plan: LeaveGenerationPlan, stage: GenerationStage, employmentIds: string[]): Promise<OpenStepResult> {
  await useLeaveStageTx(tx, stage.open, stagesOf(stage));
  let summary: LeaveCohortSummary | null = null;
  const res = await openLeaveYear(ctx, {year: plan.year, leaveTypeIds: plan.leaveTypeIds, employmentIds}, {tx, onSummary: p => { summary = p; }});
  const fp = await leaveStageFingerprintsTx(tx, employmentIds, stagesOf(stage));
  return {rows: res.rows, summary, granted: res.granted, skipped: res.skipped, forfeits: res.forfeits, fp, configFp: await leaveConfigFingerprintTx(tx)};
}
/** One earned batch, staged: the batch's own handed employees across the run's handed leave types. A refusal is
 * returned (its writes rolled back by the savepoint), never thrown: it fails the earned part only. */
async function accrueBatchTx(tx: Tx, ctx: SessionContext, plan: LeaveGenerationPlan, stage: GenerationStage, opens: OpenStepResult[], batch: string[]): Promise<AccrueStepResult> {
  // The hand-over is decided on the WHOLE run's year-open lines, as in the synchronous run.
  const handover = leaveGenerationHandover(plan, opens.flatMap(o => o.rows));
  const mine = new Set(batch);
  const employmentIds = handover.call?.employmentIds.filter(id => mine.has(id)) ?? [];
  if (!handover.call || !employmentIds.length) return {skip: true};
  await useLeaveStageTx(tx, stage.accrue, stagesOf(stage));
  try {
    return await tx.transaction(savepoint => earnedAccrualBatchTx(savepoint, ctx, {asOf: handover.call!.asOf}, employmentIds, {leaveTypeIds: handover.call!.leaveTypeIds}));
  } catch (error) {
    if (isTransientBulkJobError(error)) throw error;
    // As in the synchronous run, a failed earned part is reported and never undoes the entitlement.
    return {error: (error as Error).message || 'Earned accrual failed.'};
  }
}
const stepRowsTx = async <R>(tx: Tx, job: BulkJobRow, kind: string) =>
  [...await tx.execute<{seq: number; payload: Batch; result: R}>(sql`select seq,payload,result from bulk_job_step where job_id=${job.id}::uuid and kind=${kind} order by seq`)];
const setPlanTx = (tx: Tx, job: BulkJobRow, patch: Partial<GenerationStoredPlan>) =>
  tx.execute(sql`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||${JSON.stringify(patch)}::jsonb,updated_at=now() where id=${job.id}::uuid`);

/** One changed batch computed again: its staged rows dropped, its year-open and earned part re-run. */
async function restageUnit(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit, seq: number) {
  const stored = generationPlanOf(job), plan = stored.generation!, stage = stored.stage!;
  await withTenant(ctx, async tx => {
    await label(tx, job.kind, 'restage');
    await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    await useLeaveStageTx(tx, null, stagesOf(stage));
    const opens = await stepRowsTx<OpenStepResult>(tx, job, 'open');
    const index = opens.findIndex(o => o.seq === seq);
    const batch = opens[index].payload.employmentIds;
    const before = handoverKey(leaveGenerationHandover(plan, opens.flatMap(o => o.result.rows)).call);
    await dropLeaveStageRowsTx(tx, stagesOf(stage), batch);
    const fresh = await openBatchTx(tx, ctx, plan, stage, batch);
    await tx.execute(sql`update bulk_job_step set result=${JSON.stringify(fresh)}::jsonb where job_id=${job.id}::uuid and seq=${seq}`);
    opens[index] = {...opens[index], result: fresh};
    const results = opens.map(o => o.result);
    const accrueSeq = opens.length + index;
    let restage = (stored.restage ?? []).filter(s => s !== seq);
    if (handoverKey(leaveGenerationHandover(plan, results.flatMap(r => r.rows)).call) !== before) {
      // The run's handed leave types moved, which changes every earned batch: compute them all again.
      restage = opens.map(o => o.seq).filter(s => s !== seq);
    }
    if (!await accrualFailedTx(tx, job)) {
      const acc = await accrueBatchTx(tx, ctx, plan, stage, results, batch);
      await tx.execute(sql`update bulk_job_step set result=${JSON.stringify(acc)}::jsonb where job_id=${job.id}::uuid and seq=${accrueSeq}`);
    }
    await setPlanTx(tx, job, {restage});
  });
}

/** The release: every selected employee's lock, the re-check, then the stages and the two summary events at once. */
async function releaseUnit(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit) {
  const stored = generationPlanOf(job), plan = stored.generation!, stage = stored.stage!;
  const started = performance.now();
  await withTenant(ctx, async tx => {
    await label(tx, job.kind, 'release');
    await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    await useLeaveStageTx(tx, null, stagesOf(stage));
    await lockLeaveStageSubjectsTx(tx, ctx, plan.targets);
    const opens = await stepRowsTx<OpenStepResult>(tx, job, 'open');
    const configFp = await leaveConfigFingerprintTx(tx);
    const expected: Record<string, string> = {};
    for (const o of opens) Object.assign(expected, o.result.fp ?? {});
    const changed = new Set(await leaveStageConflictsTx(tx, expected, stagesOf(stage)));
    const restage = opens.filter(o => o.result.configFp !== configFp || o.payload.employmentIds.some(id => changed.has(id))).map(o => o.seq);
    if (restage.length) {
      const attempts = (stored.releaseAttempts ?? 0) + 1;
      if (attempts > LEAVE_STAGE_RELEASE_ATTEMPTS) throw new Error('Leave generation was stopped because the selected employees kept changing while it ran. Nothing was changed; run it again.');
      await setPlanTx(tx, job, {restage, releaseAttempts: attempts});
      return;
    }
    const accrueFailed = await accrualFailedTx(tx, job);
    if (accrueFailed) await dropLeaveStageRowsTx(tx, [stage.accrue]);
    await releaseLeaveStageTx(tx, job.id, stage.open);
    if (!accrueFailed) await releaseLeaveStageTx(tx, job.id, stage.accrue);
    const results = opens.map(o => o.result);
    const yearOpen = yearOpenRunSummary(results.map(o => o.summary));
    if (yearOpen) await appendLeaveCohortSummaryTx(tx, ctx, 'leave-year.opened', yearOpen);
    const handover = leaveGenerationHandover(plan, results.flatMap(o => o.rows));
    const accrues = (await appliedResults<AccrueStepResult>(tx, job, 'accrue')).filter(isAccrued);
    const accrual = handover.call && !accrueFailed ? earnedAccrualRunSummary(accrues, handover.call.employmentIds) : null;
    if (accrual) await appendLeaveCohortSummaryTx(tx, ctx, 'leave.earned-accrual.run', accrual);
    await setPlanTx(tx, job, {released: true, restage: []});
  });
  unit.metric('releaseTxMs', performance.now() - started);
}

export const leaveGenerationJobHandler: BulkJobHandler<Batch> = {
  kind: LEAVE_GENERATION_JOB_KIND,
  mode: 'atomic',
  chunkBudgetMs: LEAVE_COHORT_CHUNK_BUDGET_MS,
  maxStepsPerChunk: LEAVE_COHORT_STEPS_PER_CHUNK,
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
      plan: {generation: plan, stage: {open: randomUUID(), accrue: randomUUID()}} satisfies GenerationStoredPlan,
    };
  },
  async applyStepTx(tx, ctx, job, step, cache): Promise<BulkJobStepOutcome> {
    const stored = generationPlanOf(job), plan = stored.generation!, stage = stored.stage!;
    if (step.kind === 'open') {
      const result = await openBatchTx(tx, ctx, plan, stage, step.payload.employmentIds);
      return {result, counters: {granted: result.granted, skipped: result.skipped, forfeits: result.forfeits}};
    }
    if (cache.get('accrueFailed') || await accrualFailedTx(tx, job)) { cache.set('accrueFailed', true); return {result: {skip: true} satisfies AccrueStepResult}; }
    const result = await accrueBatchTx(tx, ctx, plan, stage, await openRowsTx(tx, job, cache), step.payload.employmentIds);
    if (result.error) cache.set('accrueFailed', true);
    return {result, counters: isAccrued(result) ? {forfeits: result.forfeits} : {}};
  },
  /** Release (re-checking and re-computing changed batches first), settle, then the processing log and result. */
  async finalize(ctx, job, unit) {
    const stored = generationPlanOf(job);
    if (stored.empty) return {result: stored.empty};
    if (stored.finalized) return {result: (await unit.owner<{result: unknown}[]>`select result from bulk_job where id=${job.id}::uuid`)[0].result};
    if (!stored.released) {
      if (stored.restage?.length) await restageUnit(ctx, job, unit, stored.restage[0]);
      else await releaseUnit(ctx, job, unit);
      return 'more';
    }
    if (!stored.settled) {
      if (await settleLeaveStages(unit.owner, job.tenant_id, stagesOf(stored.stage!)) === 'more') return 'more';
      await unit.owner`update bulk_job set plan=plan||'{"settled":true}'::jsonb where id=${job.id}::uuid`;
    }
    const plan = stored.generation!;
    const {opens, accrues} = await withTenant(ctx, async tx => ({opens: await openRowsTx(tx, job), accrues: await appliedResults<AccrueStepResult>(tx, job, 'accrue')}));
    const engineRows = opens.flatMap(o => o.rows);
    const counts = {granted: 0, skipped: 0, forfeits: 0};
    for (const o of opens) { counts.granted += o.granted; counts.skipped += o.skipped; counts.forfeits += o.forfeits; }
    const handover = leaveGenerationHandover(plan, engineRows);
    const failure = accrues.find(r => Boolean(r.error));
    const written = failure ? [] : accrues.filter(isAccrued);
    const acc = {pairs: written.flatMap(r => r.pairs) as EarnedAccrualResult['pairs'], forfeits: written.reduce((n, r) => n + r.forfeits, 0),
      breakdown: [...new Map(written.flatMap(r => r.typeNames)).entries()].map(([leaveTypeId, leaveTypeName]) => ({leaveTypeId, leaveTypeName}))};
    // As in the synchronous run: the accrual half from what the engine wrote, or its failure (and nothing of it).
    const accrual = handover.accrualStart();
    let accrued: EarnedAccrualResult['pairs'] = [];
    if (accrual && handover.call) {
      accrual.asOf = handover.call.asOf;
      if (failure) accrual.error = failure.error!;
      else { accrued = applyGenerationAccrual(accrual, handover, acc); counts.forfeits += acc.forfeits; }
    }
    let result: unknown = null;
    await completeLeaveGeneration(ctx, plan, engineRows, counts, accrual, accrued, false, async (tx, runId, done) => {
      await unit.fenceTx(tx);
      if (!isAdmin(ctx)) throw new Error(notAdmin);
      result = {...done, runId};
      await tx.execute(sql`update bulk_job set result=${JSON.stringify(result)}::jsonb,plan=plan||'{"finalized":true}'::jsonb,updated_at=now() where id=${job.id}::uuid`);
    });
    return {result, counters: {failedEmployees: 0}};
  },
  /** Failed or stopped before release: the staged rows are deleted (nobody saw them). After a release (the log
   * failed), the released stages are only settled. */
  async discard(job, unit) {
    const stage = generationPlanOf(job).stage;
    if (!stage) return 'done';
    const removed = await discardLeaveStageRows(unit.owner, job.tenant_id, stagesOf(stage));
    unit.metric('discardedRows', removed);
    if (removed) return 'more';
    return settleLeaveStages(unit.owner, job.tenant_id, stagesOf(stage));
  },
};
