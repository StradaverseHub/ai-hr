/** Durable leave ledger imports on the shared bulk-job kernel (core/bulk-job.ts, kind `leave_ledger`, migration
 * 5030). The request only checks authority and enqueues; core/leave-import-worker.ts writes, one row per step. */
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {bulkJobActive, type BulkJobState} from '../lib/bulk-job';
import type {LeaveImportJobProgress, LeaveImportJobState} from '../lib/leave-import-job';
import type {LeaveImportRecord, LeaveImportResult, LeaveImportSource} from '../lib/leave-import-schema';
import {BULK_JOB_ALREADY_RUNNING, BulkJobError, bulkJobTx, bulkJobWorkerStatusTx, enqueueBulkJobTx, isBulkJobId, listBulkJobsTx, type BulkJobRow} from './bulk-job';

export const LEAVE_LEDGER_IMPORT_KIND = 'leave_ledger';
/** What the worker reads back. Removed from the job once it finishes. The kind's declared input shape (migration
 * 5030: records array, source object?, companyId string?) admits no JSON null, so an import without a source
 * carries no `source` key and the worker reads that as null. */
export type LeaveImportJobInput = {records: LeaveImportRecord[]; source?: LeaveImportSource | null; companyId?: string};
const jobInputOf = (input: {records: LeaveImportRecord[]; source?: LeaveImportSource; companyId?: string}): LeaveImportJobInput =>
  ({records: input.records.map(record => ({...record})), ...(input.source ? {source: input.source} : {}), ...(input.companyId ? {companyId: input.companyId} : {})});

const uiState: Record<BulkJobState, LeaveImportJobState> = {
  queued: 'queued', preparing: 'importing', running: 'importing', finalizing: 'importing', discarding: 'importing',
  completed: 'completed', failed: 'failed', cancelled: 'failed',
};
export function leaveImportJobProgress(row: BulkJobRow, worker: 'running' | 'unavailable' = 'running'): LeaveImportJobProgress {
  const total = Number(row.counters?.total ?? 0);
  // Rows that need no write (invalid, already imported) count as processed once the file is validated.
  const planned = row.state === 'queued' || row.state === 'preparing' ? 0 : Math.max(0, total - row.steps_total) + row.steps_done;
  return {
    id: row.id, state: uiState[row.state], total, done: Math.min(total, planned), updatedAt: new Date(row.updated_at).toISOString(),
    result: row.state === 'completed' ? (row.result as LeaveImportResult) : null,
    worker: row.state === 'queued' ? worker : 'running',
  };
}
async function progressTx(tx: Tx, row: BulkJobRow) {
  return leaveImportJobProgress(row, row.state === 'queued' ? await bulkJobWorkerStatusTx(tx, LEAVE_LEDGER_IMPORT_KIND) : 'running');
}
async function activeTx(tx: Tx, ctx: SessionContext) {
  return (await listBulkJobsTx(tx, ctx, LEAVE_LEDGER_IMPORT_KIND, 5)).find(row => bulkJobActive(row.state)) ?? null;
}

/** Enqueues the import after the same authority check the synchronous import made. A person's second submission
 * while one is running rejoins the running job instead of importing twice. */
export async function createLeaveImportJob(ctx: SessionContext, input: {records: LeaveImportRecord[]; source?: LeaveImportSource; companyId?: string}): Promise<LeaveImportJobProgress> {
  if (!ctx.userId) throw new BulkJobError('Sign in again to import leave.', 401);
  if (!isAdmin(ctx)) throw new BulkJobError('Only HR administrators can import leave records.', 403);
  const jobInput = jobInputOf(input);
  return withTenant(ctx, async tx => {
    try {
      // A full scope returns no row (ON CONFLICT DO NOTHING), so this transaction stays usable for the rejoin read.
      const {row} = await enqueueBulkJobTx(tx, ctx, {kind: LEAVE_LEDGER_IMPORT_KIND, input: jobInput});
      return progressTx(tx, row);
    } catch (error) {
      if (!(error instanceof BulkJobError) || error.message !== BULK_JOB_ALREADY_RUNNING) throw error;
      const running = await activeTx(tx, ctx);
      if (!running) throw error;
      return progressTx(tx, running);
    }
  });
}

/** A chat-confirmed import (core/chat-import/confirm.ts): admitted once for the card's own operation key, and
 * `started: false` (nothing admitted) while another of the person's leave imports is still running, so the card
 * never silently joins a different file. */
export async function startLeaveImportJobOnce(ctx: SessionContext, input: {records: LeaveImportRecord[]; source?: LeaveImportSource; companyId?: string}, operationKey: string): Promise<{started: boolean; job: LeaveImportJobProgress | null}> {
  if (!ctx.userId) throw new BulkJobError('Sign in again to import leave.', 401);
  if (!isAdmin(ctx)) throw new BulkJobError('Only HR administrators can import leave records.', 403);
  const jobInput = jobInputOf(input);
  return withTenant(ctx, async tx => {
    try {
      const {row} = await enqueueBulkJobTx(tx, ctx, {kind: LEAVE_LEDGER_IMPORT_KIND, operationKey, input: jobInput});
      return {started: true, job: await progressTx(tx, row)};
    } catch (error) {
      if (!(error instanceof BulkJobError) || error.message !== BULK_JOB_ALREADY_RUNNING) throw error;
      return {started: false, job: null};
    }
  });
}

/** Progress for the person who started the import; row security hides everyone else's. */
export async function readLeaveImportJob(ctx: SessionContext, id: string): Promise<LeaveImportJobProgress | null> {
  if (!isBulkJobId(id)) return null;
  return withTenant(ctx, async tx => {
    try { return await progressTx(tx, await bulkJobTx(tx, id, {kind: LEAVE_LEDGER_IMPORT_KIND})); }
    catch (error) { if (error instanceof BulkJobError && error.status === 404) return null; throw error; }
  });
}

/** The person's running job, so the screen can rejoin it after a reload. */
export async function activeLeaveImportJob(ctx: SessionContext): Promise<LeaveImportJobProgress | null> {
  return withTenant(ctx, async tx => {
    const row = await activeTx(tx, ctx);
    return row ? progressTx(tx, row) : null;
  });
}
