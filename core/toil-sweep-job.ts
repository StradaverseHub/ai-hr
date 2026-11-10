/** Admission and creator-scoped progress of the two replacement-leave sweeps on the shared bulk-job kernel (kinds
 * toil_expiry and toil_year_close, draft 5033). The request checks the same authority the synchronous sweep checked
 * and enqueues; the protected import worker settles the credits in batches of employees (core/toil-sweep-worker.ts). */
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {bulkJobActive, type BulkJobState} from '../lib/bulk-job';
import {TOIL_EXPIRY_JOB_KIND, TOIL_YEAR_CLOSE_JOB_KIND, isToilSweepJobKind, type ToilSweepJobKind, type ToilSweepJobProgress, type ToilSweepJobState} from '../lib/toil-sweep-job';
import {BULK_JOB_ALREADY_RUNNING, BulkJobError, bulkJobTx, bulkJobWorkerStatusTx, enqueueBulkJobTx, isBulkJobId, listBulkJobsTx, type BulkJobRow} from './bulk-job';
import {assertToilSweepAuthority} from '../packs/leave/service';

export {TOIL_EXPIRY_JOB_KIND, TOIL_YEAR_CLOSE_JOB_KIND};
/** Another administrator's run of the same sweep is still going (one per tenant). Translated by the screen. */
export const TOIL_SWEEP_ALREADY_RUNNING = 'toil-sweep-already-running';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const uiState: Record<BulkJobState, ToilSweepJobState> = {
  queued: 'queued', preparing: 'running', running: 'running', finalizing: 'running', discarding: 'running',
  completed: 'completed', failed: 'failed', cancelled: 'failed',
};
export function toilSweepJobProgress(row: BulkJobRow, worker: 'running' | 'unavailable' = 'running'): ToilSweepJobProgress {
  const total = Number(row.counters?.employees ?? 0);
  const done = row.state === 'completed' ? total : row.steps_total > 0 ? Math.min(total, Math.floor(row.steps_done / row.steps_total * total)) : 0;
  return {
    id: row.id, kind: row.kind as ToilSweepJobKind, state: uiState[row.state], total, done,
    failedEmployees: Number(row.counters?.failedEmployees ?? 0),
    error: row.state === 'completed' ? (row.errors?.[0]?.message ?? null) : row.error,
    updatedAt: new Date(row.updated_at).toISOString(),
    result: row.state === 'completed' ? (row.result as ToilSweepJobProgress['result']) : null,
    worker: row.state === 'queued' ? worker : 'running',
  };
}
async function progressTx(tx: Tx, row: BulkJobRow) {
  return toilSweepJobProgress(row, row.state === 'queued' ? await bulkJobWorkerStatusTx(tx, row.kind) : 'running');
}

/** Admit a sweep after the authority check the synchronous sweep made (`ToilSweepForbiddenError`). The person's own
 * running sweep of the same kind is rejoined; another administrator's is refused with TOIL_SWEEP_ALREADY_RUNNING. */
async function enqueue(ctx: SessionContext, kind: ToilSweepJobKind, input: {today: string} | {asOf: string}): Promise<ToilSweepJobProgress> {
  if (!ctx.userId) throw new BulkJobError('Sign in again to run this.', 401);
  assertToilSweepAuthority(ctx);
  if (!ISO_DATE.test(Object.values(input)[0])) throw new BulkJobError('Invalid date.', 400);
  return withTenant(ctx, async tx => {
    try {
      const {row} = await enqueueBulkJobTx(tx, ctx, {kind, input});
      return progressTx(tx, row);
    } catch (error) {
      if (!(error instanceof BulkJobError) || error.message !== BULK_JOB_ALREADY_RUNNING) throw error;
      const own = (await listBulkJobsTx(tx, ctx, kind, 5)).find(row => bulkJobActive(row.state));
      if (own) return progressTx(tx, own);
      throw new BulkJobError(TOIL_SWEEP_ALREADY_RUNNING, 409);
    }
  });
}
/** Process expirations (`runToilExpiry`) for `today` in the background. */
export function createToilExpiryJob(ctx: SessionContext, p: {today: string}) {
  return enqueue(ctx, TOIL_EXPIRY_JOB_KIND, {today: p.today});
}
/** Close the replacement-leave year (`closeReplacementLeaveYear`) at `asOf` in the background. */
export function createReplacementYearCloseJob(ctx: SessionContext, p: {asOf: string}) {
  return enqueue(ctx, TOIL_YEAR_CLOSE_JOB_KIND, {asOf: p.asOf});
}

/** One sweep's progress for the person who started it; row security hides everyone else's. */
export async function readToilSweepJob(ctx: SessionContext, id: string): Promise<ToilSweepJobProgress | null> {
  if (!isBulkJobId(id)) return null;
  return withTenant(ctx, async tx => {
    try {
      const row = await bulkJobTx(tx, id);
      return isToilSweepJobKind(row.kind) ? progressTx(tx, row) : null;
    } catch (error) { if (error instanceof BulkJobError && error.status === 404) return null; throw error; }
  });
}
/** The person's running sweep of one kind, so the page can rejoin it after a reload. */
export async function activeToilSweepJob(ctx: SessionContext, kind: ToilSweepJobKind): Promise<ToilSweepJobProgress | null> {
  return withTenant(ctx, async tx => {
    const row = (await listBulkJobsTx(tx, ctx, kind, 5)).find(r => bulkJobActive(r.state));
    return row ? progressTx(tx, row) : null;
  });
}
