/**
 * Leave work a configuration save starts, as clients of the shared bulk-job kernel (core/bulk-job-worker.ts):
 *
 *  - `leave_recalc`: the entitlement recalculation after a leave-type earning-rule, table or eligibility-rule save
 *    (`reprojectEntitlementForLeaveTypeCohort`). It was already one transaction per employee, best effort, inside
 *    the save request; here it is one employee per step (per-step mode: a step's savepoint is that employee's
 *    transaction), through the unchanged `reprojectEntitlementForEmployment`. A refused employee is recorded on the
 *    job and the others continue, as before.
 *  - `leave_a2c`: the Anniversary-to-Calendar re-projection a Leave Year Type save triggers
 *    (`reprojectA2cEntitlement`). It ran inside the save's transaction, so it was all-or-nothing: here its batches
 *    write STAGED ledger rows (core/leave-stage.ts) and hand each corrected employee's history row and event to the
 *    job; one short transaction re-checks what each batch read, releases every row at once, and the history rows
 *    and events follow in bounded steps. A refused batch discards the stage: nothing of the correction is visible.
 */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {appendEvent} from '../db/events';
import {leaveEntitlementRecalcAudit} from '../db/schema';
import {isAdmin} from '../lib/authz-model';
import {publicErrorMessage} from '../lib/public-error';
import {a2cReprojectionCandidatesTx, assertInformationLeavePeriodTx, leaveTypeCohortRecalcCandidatesTx, reprojectA2cEntitlement, reprojectEntitlementForEmployment,
  type A2cRecalcSink} from '../packs/leave/service';
import {isTransientBulkJobError, type BulkJobHandler, type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {batchesOf} from './leave-cohort-run';
import {LEAVE_A2C_JOB_KIND, LEAVE_RECALC_JOB_KIND, type LeaveA2cJobInput, type LeaveRecalcJobInput} from './leave-cohort-job';
import {discardLeaveStageRows, dropLeaveStageRowsTx, leaveConfigFingerprintTx, leaveStageConflictsTx, leaveStageFingerprintsTx, lockLeaveStageSubjectsTx,
  releaseLeaveStageTx, settleLeaveStages, useLeaveStageTx} from './leave-stage';

const notAdmin = 'Your access changed, so the recalculation was stopped.';
const label = (tx: Tx, kind: string, phase: string) => tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Employees per recalculation chunk at most, within the kernel's chunk budget (each is its own savepoint). */
export const LEAVE_RECALC_STEPS_PER_CHUNK = Math.max(1, Number(process.env.LEAVE_RECALC_STEPS_PER_CHUNK ?? 4));

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; }
  catch (error) { if (isTransientBulkJobError(error)) throw error; return publicErrorMessage(error); }
}

// ── Entitlement recalculation ──────────────────────────────────────────────────────────────────────────────────────
type RecalcStepResult = {affected: number; totalDelta: number};
export const leaveRecalcJobHandler: BulkJobHandler<{employmentId: string}> = {
  kind: LEAVE_RECALC_JOB_KIND,
  mode: 'per-step',
  chunkBudgetMs: 100,
  maxStepsPerChunk: LEAVE_RECALC_STEPS_PER_CHUNK,
  transientStepLimit: 60,
  stepRef: () => '',
  async prepare(ctx, job) {
    if (!isAdmin(ctx)) return {refused: notAdmin};
    const input = job.input as LeaveRecalcJobInput;
    let ids: string[] = [];
    const refused = await refusal(() => withTenant(ctx, async tx => { ids = await leaveTypeCohortRecalcCandidatesTx(tx, input.asOf); }));
    if (refused) return {refused};
    return {steps: ids.map((employmentId, i) => ({kind: 'employee', rowNum: i + 1, payload: {employmentId}})), counters: {employees: ids.length, affected: 0}, plan: {}};
  },
  async applyStepTx(tx, ctx, job, step) {
    const input = job.input as LeaveRecalcJobInput;
    const res = await reprojectEntitlementForEmployment(ctx, {employmentId: step.payload.employmentId, asOf: input.asOf, trigger: input.trigger}, tx);
    return {result: {affected: res.affected, totalDelta: res.totalDelta} satisfies RecalcStepResult, counters: {affected: res.affected}};
  },
  /** What `reprojectEntitlementForLeaveTypeCohort` returned: employees visited, rows written, the summed delta. */
  async finalize(ctx, job) {
    const results = await withTenant(ctx, async tx =>
      (await tx.execute<{result: RecalcStepResult}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and state='applied' order by seq`)).map(r => r.result));
    let affected = 0, totalDelta = 0;
    for (const r of results) { affected += r.affected; totalDelta = round2(totalDelta + r.totalDelta); }
    // Employees the recalculation could not write (each logged and skipped by the synchronous loop).
    const failedEmployees = job.steps_total - results.length;
    return {result: {employees: job.steps_total, affected, totalDelta}, counters: {failedEmployees}};
  },
};

// ── A2C re-projection ──────────────────────────────────────────────────────────────────────────────────────────────
type A2cCorrection = {audit: typeof leaveEntitlementRecalcAudit.$inferInsert; event: Parameters<typeof appendEvent>[1]};
type A2cStepResult = {affected: number; totalDelta: number; packBlocked: unknown[]; corrections: A2cCorrection[];
  fp: Record<string, string>; configFp: string; written?: boolean};
type A2cPlan = {stage?: string; released?: boolean; settled?: boolean; restage?: number[]; releaseAttempts?: number; noop?: boolean};
const a2cPlanOf = (job: BulkJobRow) => (job.plan ?? {}) as A2cPlan;
export const LEAVE_A2C_RELEASE_ATTEMPTS = 40;
/** History rows and events written per follow-up transaction after the release. */
const A2C_HISTORY_PER_UNIT = 200;
const setA2cPlanTx = (tx: Tx, job: BulkJobRow, patch: Partial<A2cPlan>) =>
  tx.execute(sql`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||${JSON.stringify(patch)}::jsonb,updated_at=now() where id=${job.id}::uuid`);
const a2cStepsTx = async (tx: Tx, job: BulkJobRow) =>
  [...await tx.execute<{seq: number; payload: {employmentIds: string[]}; result: A2cStepResult}>(sql`select seq,payload,result from bulk_job_step where job_id=${job.id}::uuid order by seq`)];

/** One batch of the unchanged engine, staged, with what it read and the history it would have written. */
async function a2cBatchTx(tx: Tx, ctx: SessionContext, input: LeaveA2cJobInput, stage: string, employmentIds: string[]): Promise<A2cStepResult> {
  await useLeaveStageTx(tx, stage, [stage]);
  const corrections: A2cCorrection[] = [];
  const sink: A2cRecalcSink = {corrected: (audit, event) => { corrections.push({audit, event}); }};
  const res = await reprojectA2cEntitlement(tx, ctx, {leaveTypeId: input.leaveTypeId, employmentIds, asOf: input.asOf, trigger: input.trigger}, sink);
  return {affected: res.affected, totalDelta: res.totalDelta, packBlocked: res.packBlocked, corrections,
    fp: await leaveStageFingerprintsTx(tx, employmentIds, [stage]), configFp: await leaveConfigFingerprintTx(tx)};
}

async function a2cRestageUnit(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit, seq: number) {
  const plan = a2cPlanOf(job), stage = plan.stage!;
  await withTenant(ctx, async tx => {
    await label(tx, job.kind, 'restage');
    await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    const steps = await a2cStepsTx(tx, job);
    const step = steps.find(s => s.seq === seq)!;
    await useLeaveStageTx(tx, null, [stage]);
    await dropLeaveStageRowsTx(tx, [stage], step.payload.employmentIds);
    const fresh = await a2cBatchTx(tx, ctx, job.input as LeaveA2cJobInput, stage, step.payload.employmentIds);
    await tx.execute(sql`update bulk_job_step set result=${JSON.stringify(fresh)}::jsonb where job_id=${job.id}::uuid and seq=${seq}`);
    await setA2cPlanTx(tx, job, {restage: (plan.restage ?? []).filter(s => s !== seq)});
  });
}
async function a2cReleaseUnit(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit) {
  const plan = a2cPlanOf(job), stage = plan.stage!;
  const started = performance.now();
  await withTenant(ctx, async tx => {
    await label(tx, job.kind, 'release');
    await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    await useLeaveStageTx(tx, null, [stage]);
    const steps = await a2cStepsTx(tx, job);
    await lockLeaveStageSubjectsTx(tx, ctx, steps.flatMap(s => s.payload.employmentIds));
    const configFp = await leaveConfigFingerprintTx(tx);
    const expected: Record<string, string> = {};
    for (const s of steps) Object.assign(expected, s.result.fp);
    const changed = new Set(await leaveStageConflictsTx(tx, expected, [stage]));
    const restage = steps.filter(s => s.result.configFp !== configFp || s.payload.employmentIds.some(id => changed.has(id))).map(s => s.seq);
    if (restage.length) {
      const attempts = (plan.releaseAttempts ?? 0) + 1;
      if (attempts > LEAVE_A2C_RELEASE_ATTEMPTS) throw new Error('The recalculation was stopped because the employees kept changing while it ran. Nothing was changed; save the leave year type again.');
      await setA2cPlanTx(tx, job, {restage, releaseAttempts: attempts});
      return;
    }
    await releaseLeaveStageTx(tx, job.id, stage);
    await setA2cPlanTx(tx, job, {released: true, restage: []});
  });
  unit.metric('releaseTxMs', performance.now() - started);
}
/** After the release: the history rows and events of up to A2C_HISTORY_PER_UNIT corrections, in step order. */
async function a2cHistoryUnit(ctx: SessionContext, job: BulkJobRow, unit: BulkJobUnit): Promise<boolean> {
  return withTenant(ctx, async tx => {
    await label(tx, job.kind, 'history');
    await unit.fenceTx(tx);
    if (!isAdmin(ctx)) throw new Error(notAdmin);
    const pending = [...await tx.execute<{seq: number; result: A2cStepResult}>(sql`select seq,result from bulk_job_step where job_id=${job.id}::uuid
      and coalesce((result->>'written')::boolean,false)=false and jsonb_array_length(result->'corrections')>0 order by seq limit 64`)];
    let written = 0;
    for (const step of pending) {
      if (written && written + step.result.corrections.length > A2C_HISTORY_PER_UNIT) break;
      for (const c of step.result.corrections) {
        await tx.insert(leaveEntitlementRecalcAudit).values(c.audit);
        await appendEvent(tx, c.event);
      }
      written += step.result.corrections.length;
      await tx.execute(sql`update bulk_job_step set result=result||'{"written":true}'::jsonb where job_id=${job.id}::uuid and seq=${step.seq}`);
    }
    return pending.length > 0;
  });
}

export const leaveA2cJobHandler: BulkJobHandler<{employmentIds: string[]}> = {
  kind: LEAVE_A2C_JOB_KIND,
  mode: 'atomic',
  chunkBudgetMs: 100,
  maxStepsPerChunk: 1,
  stepRef: step => `${step.payload.employmentIds.length}`,
  async prepare(ctx, job) {
    if (!isAdmin(ctx)) return {refused: notAdmin};
    const input = job.input as LeaveA2cJobInput;
    let candidates: {isA2c: boolean; employmentIds: string[]} = {isA2c: false, employmentIds: []};
    const refused = await refusal(() => withTenant(ctx, async tx => {
      candidates = await a2cReprojectionCandidatesTx(tx, input);
      // The whole-tenant protected-period check the save's single call made before writing.
      if (candidates.isA2c && candidates.employmentIds.length) await assertInformationLeavePeriodTx(tx, input.asOf, {});
    }));
    if (refused) return {refused};
    const steps = batchesOf(candidates.employmentIds).map((employmentIds, i) => ({kind: 'employees', rowNum: i + 1, payload: {employmentIds}}));
    return {steps, counters: {employees: candidates.employmentIds.length}, plan: {stage: randomUUID(), noop: !steps.length} satisfies A2cPlan};
  },
  async applyStepTx(tx, ctx, job, step) {
    const result = await a2cBatchTx(tx, ctx, job.input as LeaveA2cJobInput, a2cPlanOf(job).stage!, step.payload.employmentIds);
    return {result, counters: {affected: result.affected}};
  },
  async finalize(ctx, job, unit) {
    const plan = a2cPlanOf(job);
    if (!plan.noop) {
      if (!plan.released) {
        if (plan.restage?.length) await a2cRestageUnit(ctx, job, unit, plan.restage[0]);
        else await a2cReleaseUnit(ctx, job, unit);
        return 'more';
      }
      if (!plan.settled) {
        if (await settleLeaveStages(unit.owner, job.tenant_id, [plan.stage!]) === 'more') return 'more';
        await unit.owner`update bulk_job set plan=plan||'{"settled":true}'::jsonb where id=${job.id}::uuid`;
      }
      if (await a2cHistoryUnit(ctx, job, unit)) return 'more';
    }
    const results = await withTenant(ctx, async tx => (await a2cStepsTx(tx, job)).map(s => s.result));
    let affected = 0, totalDelta = 0;
    for (const r of results) { affected += r.affected; totalDelta = round2(totalDelta + r.totalDelta); }
    return {result: {affected, totalDelta, packBlocked: results.flatMap(r => r.packBlocked)}};
  },
  /** Refused or stopped before release: the staged rows are deleted (nobody saw them) and no history is written. */
  async discard(job, unit) {
    const stage = a2cPlanOf(job).stage;
    if (!stage) return 'done';
    const removed = await discardLeaveStageRows(unit.owner, job.tenant_id, [stage]);
    if (removed) return 'more';
    return settleLeaveStages(unit.owner, job.tenant_id, [stage]);
  },
};
