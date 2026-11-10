/** Admission and creator-scoped progress of the background leave processing jobs on the shared bulk-job kernel
 * (kinds leave_generation and leave_accrual, draft 9900). The request checks authority and enqueues; the protected
 * import worker runs the unchanged engines in batches of employees (core/leave-cohort-worker.ts). */
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {bulkJobActive, type BulkJobState} from '../lib/bulk-job';
import {LEAVE_ACCRUAL_JOB_KIND, LEAVE_GENERATION_JOB_KIND, type LeaveCohortJobKind, type LeaveCohortJobProgress, type LeaveCohortJobState} from '../lib/leave-cohort-job';
import type {LeaveGenerationRequest} from './leave-generation';
import type {EarnedAccrualRunInput} from './leave-cohort-run';
import {BULK_JOB_ALREADY_RUNNING, BulkJobError, bulkJobTx, bulkJobWorkerStatusTx, enqueueBulkJobTx, isBulkJobId, listBulkJobsTx, type BulkJobRow} from './bulk-job';

export {LEAVE_ACCRUAL_JOB_KIND, LEAVE_GENERATION_JOB_KIND};
/** Another administrator's run of the same kind is still going (one per tenant). Translated by the screen. */
export const LEAVE_COHORT_ALREADY_RUNNING = 'leave-cohort-already-running';
const KINDS: readonly string[] = [LEAVE_GENERATION_JOB_KIND, LEAVE_ACCRUAL_JOB_KIND];

const uiState: Record<BulkJobState, LeaveCohortJobState> = {
  queued: 'queued', preparing: 'running', running: 'running', finalizing: 'running', discarding: 'running',
  completed: 'completed', failed: 'failed', cancelled: 'failed',
};
export function leaveCohortJobProgress(row: BulkJobRow, worker: 'running' | 'unavailable' = 'running'): LeaveCohortJobProgress {
  const total = Number(row.counters?.employees ?? 0);
  const done = row.state === 'completed' ? total : row.steps_total > 0 ? Math.min(total, Math.floor(row.steps_done / row.steps_total * total)) : 0;
  return {
    id: row.id, kind: row.kind as LeaveCohortJobKind, state: uiState[row.state], total, done,
    failedEmployees: Number(row.counters?.failedEmployees ?? 0),
    error: row.state === 'completed' ? (row.errors?.[0]?.message ?? null) : row.error,
    updatedAt: new Date(row.updated_at).toISOString(),
    result: row.state === 'completed' ? (row.result as LeaveCohortJobProgress['result']) : null,
    worker: row.state === 'queued' ? worker : 'running',
  };
}
async function progressTx(tx: Tx, row: BulkJobRow) {
  return leaveCohortJobProgress(row, row.state === 'queued' ? await bulkJobWorkerStatusTx(tx, row.kind) : 'running');
}

/** Admit a run after the same authority check its synchronous screen made. The person's own running job of the same
 * kind is rejoined; another administrator's is refused with LEAVE_COHORT_ALREADY_RUNNING (one per tenant). */
async function enqueue(ctx: SessionContext, kind: LeaveCohortJobKind, input: unknown): Promise<LeaveCohortJobProgress> {
  if (!ctx.userId) throw new BulkJobError('Sign in again to run this.', 401);
  if (!isAdmin(ctx)) throw new BulkJobError('Only HR administrators can run leave processing.', 403);
  return withTenant(ctx, async tx => {
    try {
      const {row} = await enqueueBulkJobTx(tx, ctx, {kind, input});
      return progressTx(tx, row);
    } catch (error) {
      if (!(error instanceof BulkJobError) || error.message !== BULK_JOB_ALREADY_RUNNING) throw error;
      const own = (await listBulkJobsTx(tx, ctx, kind, 5)).find(row => bulkJobActive(row.state));
      if (own) return progressTx(tx, own);
      throw new BulkJobError(LEAVE_COHORT_ALREADY_RUNNING, 409);
    }
  });
}
/** Generate Entitlement (year-open plus its earned Annual Leave top-up) in the background. */
export function createLeaveGenerationJob(ctx: SessionContext, request: LeaveGenerationRequest) {
  return enqueue(ctx, LEAVE_GENERATION_JOB_KIND, structuredClone(request));
}
/** Run Earned Accrual in the background, for the scope the review card previewed. */
export function createEarnedAccrualJob(ctx: SessionContext, input: EarnedAccrualRunInput) {
  return enqueue(ctx, LEAVE_ACCRUAL_JOB_KIND, {asOf: input.asOf, companyIds: input.companyIds ?? [], gradeIds: input.gradeIds ?? [], leaveTypeIds: input.leaveTypeIds ?? []});
}

/** One job's progress for the person who started it; row security hides everyone else's. */
export async function readLeaveCohortJob(ctx: SessionContext, id: string): Promise<LeaveCohortJobProgress | null> {
  if (!isBulkJobId(id)) return null;
  return withTenant(ctx, async tx => {
    try {
      const row = await bulkJobTx(tx, id);
      return KINDS.includes(row.kind) ? progressTx(tx, row) : null;
    } catch (error) { if (error instanceof BulkJobError && error.status === 404) return null; throw error; }
  });
}
/** The person's running job of one kind, so a screen can rejoin it after a reload. */
export async function activeLeaveCohortJob(ctx: SessionContext, kind: LeaveCohortJobKind): Promise<LeaveCohortJobProgress | null> {
  return withTenant(ctx, async tx => {
    const row = (await listBulkJobsTx(tx, ctx, kind, 5)).find(r => bulkJobActive(r.state));
    return row ? progressTx(tx, row) : null;
  });
}
