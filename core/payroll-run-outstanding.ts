/**
 * a1a80747 (approved plan r2) — THE STORED "STILL OWED PROCESSING" ANSWER BEHIND THE PAYROLL PROCESS LIST.
 *
 * The list has to say "Reprocess Required" (with "N employees affected") whenever anyone on a processed run still needs
 * processing: an employee whose payslip is out of date, a new or pending employee with no payslip yet, or an employee
 * held for income tax review. The rule for that is the one Close already uses (core/payroll.ts `runOutstandingTx` over
 * `closePendingEmployeesTx`), and it is not cheap: it reads the run's readiness checks and, for a possible
 * nothing-payable skip, the run's money. Evaluating it for every run the list shows would be per-run work in the
 * request (SCALE-AND-RELEASE-RULES 2), so the list reads a stored answer instead (`payroll_run_outstanding`, migration
 * 7450) and this module keeps it current:
 *
 *   - `requestPayrollRunOutstandingRefresh` — asked by the list (app/payroll/outstanding-refresh.tsx) for the processed
 *     runs whose answer is missing or older than a minute. It claims those runs (one statement, a refresh asked within
 *     the last minute is not asked again) and queues ONE `payroll_run_outstanding_refresh` job for them, under the
 *     viewing payroll administrator's own authority;
 *   - `payrollRunOutstandingRefreshJobHandler` — the job, on the default worker lane (never in front of payroll
 *     processing), one run per short transaction: it works the run's answer out through the owner and stores it, or
 *     drops it for a run that is no longer processed;
 *   - the run's own state changes (processing, reset, reopen) drop the stored answer in their own transaction
 *     (`forgetRunOutstandingTx`), and the list reads the recalculation mark and payslip presence live
 *     (core/payroll-view.ts `payrollRunOutstandingCounts`), so a reprocess or a removal shows at once.
 *
 * WHY THE LIST ASKS, RATHER THAN EVERY SAVE: an employee, hire, salary or transaction save would otherwise pay for a
 * request it does not need (the owner limit is 2 % on payroll saves), a save by somebody without payroll access could
 * not work the answer out anyway, and nobody needs the answer until a payroll administrator looks at the list. Asking
 * from the list costs the saves nothing and keeps the answer at most about a minute behind whenever the list is open.
 *
 * Nothing here processes anybody, changes a figure or decides eligibility: it stores the owner's answer.
 */
import {randomUUID} from 'node:crypto';
import {eq, sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {payrollBatch, payrollRunOutstanding} from '../db/schema';
import {BulkJobError, bulkJobTx, enqueueBulkJobTx} from './bulk-job';
import type {BulkJobHandler, BulkJobPrepared, BulkJobStep} from './bulk-job-worker';
import {assertModuleGate} from './module-gate';
import {forgetRunOutstandingTx, runOutstandingTx} from './payroll';

export const PAYROLL_RUN_OUTSTANDING_KIND = 'payroll_run_outstanding_refresh';
/** How old a stored answer may be before the list asks for it again, and how long a request is not repeated. */
export const RUN_OUTSTANDING_FRESH_MS = 60_000;
/** Runs one job works out, at most (the list asks for its year's processed runs, the visible ones first). */
export const RUN_OUTSTANDING_MAX_RUNS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Distinct well-formed ids in their given order, capped. Anything else is dropped, never an error. */
export function runOutstandingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !UUID.test(id)) continue;
    const lower = id.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
    if (out.length >= RUN_OUTSTANDING_MAX_RUNS) break;
  }
  return out;
}

export type RunOutstandingRefreshOutcome = 'stored' | 'cleared' | 'skipped';

/**
 * Work out ONE run's answer and store it, inside the caller's transaction (the job step, or a test). Authorised first:
 * the caller must be a current principal with payroll administration for the run's company, or nothing is read or
 * written (`skipped`). A run that is no longer processed has its stored answer dropped (`cleared`). Otherwise the
 * owner's close-pending employees are stored with `refreshed_at` set (`stored`); the mark is not stored, it is read live.
 */
export async function refreshRunOutstandingTx(tx: Tx, ctx: SessionContext, batchId: string): Promise<RunOutstandingRefreshOutcome> {
  if (!UUID.test(batchId)) return 'skipped';
  const [run] = await tx.select({status: payrollBatch.status, companyId: payrollBatch.companyId})
    .from(payrollBatch).where(eq(payrollBatch.id, batchId)).limit(1);
  if (!run) return 'skipped';
  const [access] = await tx.execute<{allowed: boolean}>(sql`
    select app.principal_snapshot_current() and app.can_admin_payroll_for(${run.companyId}::uuid) as allowed`);
  if (!access?.allowed) return 'skipped';
  if (run.status !== 'processed') {
    await forgetRunOutstandingTx(tx, batchId);
    return 'cleared';
  }
  const outstanding = await runOutstandingTx(tx, ctx, batchId);
  const pending = [...new Set(outstanding.pending.map((r) => r.employmentId))].sort();
  await tx.insert(payrollRunOutstanding)
    .values({batchId, tenantId: ctx.tenantId, employmentIds: pending, refreshedAt: sql`now()`})
    .onConflictDoUpdate({target: payrollRunOutstanding.batchId, set: {employmentIds: pending, refreshedAt: sql`now()`}});
  return 'stored';
}

/**
 * The list asks for the given runs to be worked out again. Claims, in ONE statement, the processed runs the caller
 * administers payroll for whose stored answer is missing or older than `RUN_OUTSTANDING_FRESH_MS` and that nobody asked
 * for within that time, then queues one job for exactly those runs in the same transaction (so a refused admission
 * claims nothing). Returns the job id, or null when nothing was due. Payroll module gate; the worker re-authorises each
 * run before it reads anything.
 */
export async function requestPayrollRunOutstandingRefresh(ctx: SessionContext, batchIds: readonly string[]):
  Promise<{jobId: string | null; batchIds: string[]}> {
  assertModuleGate(ctx, 'payroll');
  const wanted = runOutstandingIds(batchIds);
  if (wanted.length === 0 || !ctx.userId) return {jobId: null, batchIds: []};
  return withTenant(ctx, async (tx) => {
    const claimed = await tx.execute<{id: string; companyId: string}>(sql`
     with wanted as (
      select b.id,b.company_id,b.tenant_id,w.ord from ${payrollBatch} b
      join (select value::uuid as id,ord from jsonb_array_elements_text(${JSON.stringify(wanted)}::jsonb) with ordinality t(value,ord)) w on w.id=b.id
      where b.status='processed' and app.principal_snapshot_current() and app.can_admin_payroll_for(b.company_id)),
     due as (
      select w.* from wanted w left join ${payrollRunOutstanding} o on o.batch_id=w.id
      where (o.refreshed_at is null or o.refreshed_at < now() - ${RUN_OUTSTANDING_FRESH_MS}::int * interval '1 millisecond')
       and (o.requested_at is null or o.requested_at < now() - ${RUN_OUTSTANDING_FRESH_MS}::int * interval '1 millisecond')),
     claimed as (
      insert into ${payrollRunOutstanding}(batch_id,tenant_id,requested_at) select id,tenant_id,now() from due
      on conflict (batch_id) do update set requested_at=excluded.requested_at
       where ${payrollRunOutstanding}.requested_at is null
        or ${payrollRunOutstanding}.requested_at < now() - ${RUN_OUTSTANDING_FRESH_MS}::int * interval '1 millisecond'
      returning batch_id)
     select d.id::text as id,d.company_id::text as "companyId" from due d join claimed c on c.batch_id=d.id order by d.ord`);
    if (claimed.length === 0) return {jobId: null, batchIds: []};
    const ids = claimed.map((r) => r.id);
    const {row} = await enqueueBulkJobTx(tx, ctx, {
      kind: PAYROLL_RUN_OUTSTANDING_KIND,
      operationKey: randomUUID(),
      companyIds: [...new Set(claimed.map((r) => r.companyId))],
      input: {batchIds: ids},
    });
    return {jobId: row.id, batchIds: ids};
  });
}

/** Where the caller's own refresh job is: still working, finished, or ended without finishing. Creator-only (row
 * security on the job store); an unknown or foreign job reads as `failed`, never as finished. */
export async function readPayrollRunOutstandingRefresh(ctx: SessionContext, jobId: string): Promise<'running' | 'done' | 'failed'> {
  assertModuleGate(ctx, 'payroll');
  if (!UUID.test(jobId)) return 'failed';
  try {
    return await withTenant(ctx, async (tx) => {
      const row = await bulkJobTx(tx, jobId, {kind: PAYROLL_RUN_OUTSTANDING_KIND});
      return row.state === 'completed' ? 'done' : row.state === 'failed' || row.state === 'cancelled' ? 'failed' : 'running';
    });
  } catch (e) {
    if (e instanceof BulkJobError) return 'failed';
    throw e;
  }
}

type Step = {batchId: string};

/** The refresh job: one step per run, one run per transaction, on the default lane. A run the creator can no longer
 * administer is skipped, not failed; nothing is undone because nothing is staged (each step stores the owner's answer). */
export const payrollRunOutstandingRefreshJobHandler: BulkJobHandler<Step> = {
  kind: PAYROLL_RUN_OUTSTANDING_KIND,
  mode: 'per-step',
  maxStepsPerChunk: 1,
  // A background upkeep job the list waits for on its own: never a notification.
  quietNotice: () => true,
  async prepare(_ctx, job): Promise<BulkJobPrepared> {
    const ids = runOutstandingIds((job.input as {batchIds?: unknown} | null)?.batchIds);
    return {steps: ids.map((batchId) => ({kind: 'run', payload: {batchId}})), plan: {batchIds: ids}};
  },
  async applyStepTx(tx, ctx, _job, step: BulkJobStep<Step>) {
    assertModuleGate(ctx, 'payroll');
    const outcome = await refreshRunOutstandingTx(tx, ctx, step.payload.batchId);
    return {counters: {[outcome]: 1}};
  },
};
