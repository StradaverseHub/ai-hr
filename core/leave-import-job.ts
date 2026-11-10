/** Durable leave ledger import jobs. The request only enqueues; core/leave-import-worker.ts writes. */
import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import type {LeaveImportJobProgress, LeaveImportJobState} from '../lib/leave-import-job';
import type {LeaveImportRecord, LeaveImportResult, LeaveImportSource} from '../lib/leave-import-schema';
import type {LeaveImportPlanRow} from '../packs/leave/service';

export type LeaveImportJobRow = {
  id: string; tenant_id: string; created_by: string; context: SessionContext; records: LeaveImportRecord[];
  source: LeaveImportSource | null; plan: LeaveImportPlanRow[]; state: LeaveImportJobState; batch_id: string;
  total: number; next_index: number; imported: number; skipped: number;
  failed: LeaveImportResult['failed']; retries: number; error: string | null; updated_at: string;
};

export function leaveImportJobProgress(job: LeaveImportJobRow): LeaveImportJobProgress {
  const done = job.state === 'queued' ? 0 : job.next_index + job.total - job.plan.length;
  return {
    id: job.id, state: job.state, total: job.total, done, updatedAt: new Date(job.updated_at).toISOString(),
    result: job.state === 'completed'
      ? {imported: job.imported, failed: job.failed, skipped: job.skipped, totalRows: job.total}
      : null,
  };
}

export async function leaveImportJobTx(tx: Tx, id: string, lock = false): Promise<LeaveImportJobRow | null> {
  const [row] = await tx.execute<LeaveImportJobRow>(sql`select * from leave_import_job where id=${id}::uuid ${lock ? sql`for update` : sql``}`);
  return row ?? null;
}

/** Enqueues the import. A person's second submission rejoins their running job. */
export async function createLeaveImportJob(ctx: SessionContext, input: {records: LeaveImportRecord[]; source?: LeaveImportSource}): Promise<LeaveImportJobProgress> {
  if (!ctx.userId) throw new Error('Sign in again to import leave.');
  return withTenant(ctx, async tx => {
    try {
      await tx.transaction(async nested => {
        await nested.execute(sql`insert into leave_import_job(tenant_id,created_by,context,records,source)
          values(${ctx.tenantId}::uuid,${ctx.userId!}::uuid,'{}'::jsonb,${JSON.stringify(input.records)}::jsonb,${input.source ? JSON.stringify(input.source) : null}::jsonb)`);
      });
    } catch (error) {
      if (pgSqlState(error) !== '23505') throw error;
    }
    const [job] = await tx.execute<LeaveImportJobRow>(sql`select * from leave_import_job
      where created_by=${ctx.userId!}::uuid and state in ('queued','importing') order by created_at desc limit 1`);
    return leaveImportJobProgress(job);
  });
}

/** Progress for the person who started the import; row security hides everyone else's. */
export async function readLeaveImportJob(ctx: SessionContext, id: string): Promise<LeaveImportJobProgress | null> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
  return withTenant(ctx, async tx => {
    const job = await leaveImportJobTx(tx, id);
    return job ? leaveImportJobProgress(job) : null;
  });
}

/** The person's running job, so the screen can rejoin it after a reload. */
export async function activeLeaveImportJob(ctx: SessionContext): Promise<LeaveImportJobProgress | null> {
  return withTenant(ctx, async tx => {
    const [job] = await tx.execute<LeaveImportJobRow>(sql`select * from leave_import_job
      where created_by=${ctx.userId ?? null}::uuid and state in ('queued','importing') order by created_at desc limit 1`);
    return job ? leaveImportJobProgress(job) : null;
  });
}
