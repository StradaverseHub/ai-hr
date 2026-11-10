/**
 * Leave cohort writers in batches of employees: earned accrual, carry-forward expiry and the year-open that Generate
 * Entitlement runs. Each used to be ONE transaction over the whole tenant, holding the tenant's Access lock and every
 * employee's leave-dependency lock until it committed (accrual measured 3.4 s for 1,207 employees; the bulk plan's
 * section 4). Here the unchanged engine runs for one batch of employees per transaction, so a transaction holds those
 * locks for one batch only. Each employee's figures depend only on that employee's own ledger, profile and the
 * tenant's configuration, so a batch computes exactly what the whole-cohort run computed for it; the run then
 * appends the engine's one summary event for the whole cohort.
 *
 * Two drivers share these steps: the background job kernel for the admin screens (core/leave-cohort-worker.ts), and
 * `runLeaveCohortInline` for the owner-run timers, which have no signed-in creator to own a kernel job.
 */
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {appendEvent, actorOf} from '../db/events';
import {publicErrorMessage} from '../lib/public-error';
import {accrueEarnedLeave, expireCarriedLeave, type EarnedAccrualResult, type EarnedAccrualRunInputs} from '../packs/leave/service';
import {isTransientBulkJobError} from './bulk-job-worker';

/** Employees per batch (one batch is one engine call in one transaction). Measured on 3,000 employees on a heavily
 * loaded host (load average 26): about 90 ms per engine call plus about 20 ms per employee, so 5 employees is
 * typically 150-350 ms of tenant-lock time; 20 reached 2.3 s under the same load. */
export const LEAVE_COHORT_BATCH_EMPLOYEES = Math.max(1, Number(process.env.LEAVE_COHORT_BATCH_EMPLOYEES ?? 5));
export type LeaveCohortSummary = Record<string, unknown>;
export type EarnedAccrualRunInput = {asOf: string; companyIds?: string[]; gradeIds?: string[]; leaveTypeIds?: string[]};
export type CarryExpiryRunInput = {today: string};
/** What one batch reports back: the summary payload its engine would have appended (null: that exit appends none). */
export type AccrualBatchOutcome = {summary: LeaveCohortSummary | null; granted: number; forfeits: number;
  pairs: EarnedAccrualResult['pairs']; typeNames: [string, string][]};
export type ExpiryBatchOutcome = {summary: LeaveCohortSummary | null; swept: number; forfeited: number};

export function batchesOf<T>(items: readonly T[], size = LEAVE_COHORT_BATCH_EMPLOYEES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Every employment the run may reach, as the caller sees them (row security), in a stable order. A SUPERSET of
 * each engine's population: the engine applies its own hire/leave/scope rules to every batch, so an employee outside
 * them is simply not reached, exactly as in the whole-cohort run. */
export async function leaveCohortEmploymentIdsTx(tx: Tx, scope: {companyIds?: readonly string[]; gradeIds?: readonly string[]} = {}): Promise<string[]> {
  const companies = (scope.companyIds ?? []).filter(Boolean), grades = (scope.gradeIds ?? []).filter(Boolean);
  const rows = await tx.execute<{id: string}>(sql`select id from employment where true
    ${companies.length ? sql`and company_id = any(${`{${companies.join(',')}}`}::uuid[])` : sql``}
    ${grades.length ? sql`and grade_id = any(${`{${grades.join(',')}}`}::uuid[])` : sql``}
    order by id`);
  return rows.map(row => row.id);
}

/** One batch of earned accrual. The batch is passed as the engine's employee axis; the run's own scope (none for the
 * monthly cron) goes back into the summary event, so the audit log reads exactly as the whole-cohort run's did. */
export async function earnedAccrualBatchTx(tx: Tx, ctx: SessionContext, input: EarnedAccrualRunInput, employmentIds: string[], extra: {leaveTypeIds?: string[]; preload?: EarnedAccrualRunInputs} = {}): Promise<AccrualBatchOutcome> {
  let summary: LeaveCohortSummary | null = null;
  const r = await accrueEarnedLeave(ctx, {asOf: input.asOf, companyIds: input.companyIds, gradeIds: input.gradeIds, leaveTypeIds: extra.leaveTypeIds ?? input.leaveTypeIds, employmentIds},
    {tx, onSummary: payload => { summary = payload; }, preload: extra.preload});
  return {summary, granted: r.granted, forfeits: r.forfeits, pairs: r.pairs, typeNames: [...new Map(r.breakdown.map(g => [g.leaveTypeId, g.leaveTypeName])).entries()]};
}
/** The whole run's `leave.earned-accrual.run` payload, or null when no batch reached the engine's summary. */
export function earnedAccrualRunSummary(outcomes: readonly Pick<AccrualBatchOutcome, 'summary'>[], runEmploymentIds: readonly string[] | null): LeaveCohortSummary | null {
  const reached = outcomes.map(o => o.summary).filter((s): s is LeaveCohortSummary => s !== null);
  if (!reached.length) return null;
  return {...reached[0],
    granted: reached.reduce((n, s) => n + Number(s.granted ?? 0), 0),
    forfeits: reached.reduce((n, s) => n + Number(s.forfeits ?? 0), 0),
    employmentIds: runEmploymentIds ? [...runEmploymentIds] : []};
}

/** One batch of the carry-forward expiry sweep. */
export async function carryExpiryBatchTx(tx: Tx, ctx: SessionContext, input: CarryExpiryRunInput, employmentIds: string[]): Promise<ExpiryBatchOutcome> {
  let summary: LeaveCohortSummary | null = null;
  const r = await expireCarriedLeave(ctx, {today: input.today}, {tx, employmentIds, onSummary: payload => { summary = payload; }});
  return {summary, swept: r.swept, forfeited: r.forfeited};
}
export function carryExpiryRunSummary(outcomes: readonly Pick<ExpiryBatchOutcome, 'summary'>[]): LeaveCohortSummary | null {
  const reached = outcomes.map(o => o.summary).filter((s): s is LeaveCohortSummary => s !== null);
  if (!reached.length) return null;
  let forfeited = 0;
  for (const s of reached) forfeited = round2(forfeited + Number(s.forfeited ?? 0));
  return {...reached[0], swept: reached.reduce((n, s) => n + Number(s.swept ?? 0), 0), forfeited};
}

/** The whole run's year-open payload (`leave-year.opened`). */
export function yearOpenRunSummary(summaries: readonly (LeaveCohortSummary | null)[]): LeaveCohortSummary | null {
  const reached = summaries.filter((s): s is LeaveCohortSummary => s !== null);
  if (!reached.length) return null;
  const sum = (k: string) => reached.reduce((n, s) => n + Number(s[k] ?? 0), 0);
  return {...reached[0], granted: sum('granted'), skipped: sum('skipped'), forfeits: sum('forfeits')};
}

/** The engines' own summary event, appended once for the whole run (same aggregate, type, actor and payload). */
export function appendLeaveCohortSummaryTx(tx: Tx, ctx: SessionContext, eventType: 'leave-year.opened' | 'leave.earned-accrual.run' | 'leave.carry-forward.swept', payload: LeaveCohortSummary) {
  return appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'leave-year', aggregateId: ctx.tenantId, eventType, actor: actorOf(ctx), payload});
}

/** A batch that could not be written. The other batches keep their committed rows. */
export class LeaveCohortRunIncomplete extends Error {
  constructor(readonly failedEmployees: number, first: string) {
    super(`${failedEmployees} employee(s) could not be processed and were left unchanged: ${first}`);
    this.name = 'LeaveCohortRunIncomplete';
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The owner-run timers' driver: each batch in its own short transaction, a temporary refusal (another writer holds an
 * employee right now) retried after a short wait instead of failing the tenant, then the one summary event. A batch
 * that keeps failing is left unchanged and reported (LeaveCohortRunIncomplete) after the others are written; the
 * engine is idempotent, so the next run completes it.
 */
export async function runLeaveCohortInline<O extends {summary: LeaveCohortSummary | null}>(ctx: SessionContext, run: {
  employmentIds: (tx: Tx) => Promise<string[]>;
  batch: (tx: Tx, employmentIds: string[]) => Promise<O>;
  summary: (outcomes: O[]) => LeaveCohortSummary | null;
  eventType: Parameters<typeof appendLeaveCohortSummaryTx>[2];
}, options: {batchSize?: number; maxRetries?: number; onBatch?: (ms: number) => void} = {}): Promise<{outcomes: O[]; failedEmployees: number}> {
  const ids = await withTenant(ctx, tx => run.employmentIds(tx));
  const outcomes: O[] = [];
  let failedEmployees = 0, first = '';
  for (const batch of batchesOf(ids, options.batchSize)) {
    for (let attempt = 0; ; attempt++) {
      try {
        const started = performance.now();
        outcomes.push(await withTenant(ctx, async tx => {
          await tx.execute(sql`select set_config('application_name','aihr-bulk:leave_cohort:batch',true)`);
          return run.batch(tx, batch);
        }));
        options.onBatch?.(performance.now() - started);
        break;
      } catch (error) {
        if (isTransientBulkJobError(error) && attempt < (options.maxRetries ?? 60)) { await sleep(Math.min(2000, 50 * 2 ** Math.min(attempt, 6))); continue; }
        failedEmployees += batch.length;
        first ||= publicErrorMessage(error);
        break;
      }
    }
  }
  const payload = run.summary(outcomes);
  if (payload) await withTenant(ctx, tx => appendLeaveCohortSummaryTx(tx, ctx, run.eventType, payload));
  if (failedEmployees) throw new LeaveCohortRunIncomplete(failedEmployees, first);
  return {outcomes, failedEmployees};
}

/** Monthly earned accrual (scripts/accrue-earned.ts), batched. Returns the engine's own `granted` total. */
export async function accrueEarnedLeaveInBatches(ctx: SessionContext, input: EarnedAccrualRunInput, options?: Parameters<typeof runLeaveCohortInline>[2]) {
  const {outcomes} = await runLeaveCohortInline(ctx, {
    employmentIds: tx => leaveCohortEmploymentIdsTx(tx, input),
    batch: (tx, ids) => earnedAccrualBatchTx(tx, ctx, input, ids),
    summary: o => earnedAccrualRunSummary(o, null),
    eventType: 'leave.earned-accrual.run',
  }, options);
  return {granted: outcomes.reduce((n, o) => n + o.granted, 0), forfeits: outcomes.reduce((n, o) => n + o.forfeits, 0)};
}
/** Yearly carry-forward expiry (scripts/expire-carry.ts), batched. */
export async function expireCarriedLeaveInBatches(ctx: SessionContext, input: CarryExpiryRunInput, options?: Parameters<typeof runLeaveCohortInline>[2]) {
  const {outcomes} = await runLeaveCohortInline(ctx, {
    employmentIds: tx => leaveCohortEmploymentIdsTx(tx),
    batch: (tx, ids) => carryExpiryBatchTx(tx, ctx, input, ids),
    summary: carryExpiryRunSummary,
    eventType: 'leave.carry-forward.swept',
  }, options);
  let forfeited = 0;
  for (const o of outcomes) forfeited = round2(forfeited + o.forfeited);
  return {swept: outcomes.reduce((n, o) => n + o.swept, 0), forfeited};
}
