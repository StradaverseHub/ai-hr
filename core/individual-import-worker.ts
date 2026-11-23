import {createHash} from 'node:crypto';
import type postgres from 'postgres';
import type {SessionContext} from '../db/client';
import {readIndividualImportWorkbook, IndividualImportReadFailure} from '../lib/individual-import-read';
import type {IndividualImportJob} from '../lib/individual-import-job';
import type {IndividualImportMethod} from '../lib/payroll-txn-import-schema';
import {
  confirmIndividualImportStep, handBackIndividualImportRevert, individualImportErrorCode, IndividualImportError,
  revertIndividualImportStep, stopIndividualImport, validateIndividualImport, type IndividualImportProgress,
} from './individual-txn-import';
import {readIndividualImportJob} from './individual-import-job';

type QueuedJob = IndividualImportJob & {
  context: SessionContext;
  revert_context: SessionContext | null;
  company_ids: string[];
  tenant_id: string;
  method: IndividualImportMethod;
  source_hash: string;
  template_version: number;
};

/** Board 0ec0ee00 — test seams; production passes none. */
export type IndividualImportTickOptions = {
  /** Called before each attempt at a confirm or revert step (a throw counts as that attempt failing). */
  beforeStep?: (job: {id: string; state: string}) => Promise<void> | void;
  /** Wait between attempts at a step that failed for a reason other than its own data. */
  retryDelayMs?: number;
};
/** A step is tried this many times before the batch is stopped; a refusal of its own data is not retried. */
const STEP_ATTEMPTS = 3;

async function withRetries<T>(run: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof IndividualImportError || attempt >= STEP_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * One bounded unit of the Individual Transaction queue per call: validating one workbook, or ONE step of about 250
 * rows of a confirmed import or of a revert, so a 10,000-row batch never holds the shared runner loop
 * (scripts/bank-import-runner.ts) for longer than one step. Every step commits on its own; a restarted worker
 * resumes after the last committed step and the outcome table and payroll_individual_txn_source_ref_uq keep any row
 * from being written twice. A step that keeps failing stops the batch, keeping the rows already written.
 */
export async function runIndividualImportTick(
  owner: postgres.Sql,
  refreshContext: (ctx: SessionContext) => Promise<SessionContext>,
  options: IndividualImportTickOptions = {},
): Promise<boolean> {
  const retryDelayMs = options.retryDelayMs ?? 250;
  const connection = await owner.reserve();
  try {
    const [lock] = await connection<{ok: boolean}[]>`select pg_try_advisory_lock(hashtextextended('payroll-individual-import-worker', 0)) as ok`;
    if (!lock.ok) return false;
    try {
      const [job] = await connection<QueuedJob[]>`
        select id, tenant_id, created_by, company_ids, context, revert_context, source_name, source_hash, method, template_version, state, attempt_id
        from payroll_individual_import_job where state in ('pending', 'validating', 'confirmed', 'importing', 'reverting')
        order by created_at, id limit 1`;
      if (!job) return false;
      if (job.state === 'reverting') {
        await revertTick(connection, job, refreshContext, options, retryDelayMs);
        return true;
      }
      let ctx: SessionContext | null = null;
      try {
        ctx = await refreshContext({...job.context, tenantId: job.tenant_id, userId: job.created_by});
        if (!await readIndividualImportJob(ctx, job.id, job.company_ids)) throw new IndividualImportError('importAccessDenied');
        if (job.state === 'pending' || job.state === 'validating') {
          await connection`update payroll_individual_import_job set state = 'validating', started_at = coalesce(started_at, now()) where id = ${job.id}`;
          const [payload] = await connection<{source: Buffer}[]>`select source from payroll_individual_import_job where id = ${job.id}`;
          if (createHash('sha256').update(payload.source).digest('hex') !== job.source_hash) throw new IndividualImportError('fileReadError');
          // 0ec0ee00 — only the transaction sheet is measured and read; the template's reference sheets are ignored.
          const text = await readIndividualImportWorkbook(new Uint8Array(payload.source), job.source_name, job.method);
          const attempt = await validateIndividualImport(ctx, {
            operationId: job.id, sourceName: job.source_name, csv: text, method: job.method, scopeIds: job.company_ids,
            allowPreviousDaily: job.template_version === 1,
          });
          const error = attempt.preview.fileError ?? (attempt.preview.valid ? null : 'noValidRows');
          await connection`update payroll_individual_import_job set attempt_id = ${attempt.id},
            state = ${error ? 'failed' : 'ready'}, error = ${error},
            finished_at = case when ${Boolean(error)} then now() else null end where id = ${job.id}`;
          return true;
        }
        if (!job.attempt_id) throw new IndividualImportError('importFailed');
        if (job.state === 'confirmed') await connection`update payroll_individual_import_job set state = 'importing', processed = 0 where id = ${job.id}`;
        const stepCtx = ctx;
        const progress: IndividualImportProgress = await withRetries(async () => {
          await options.beforeStep?.({id: job.id, state: 'importing'});
          return confirmIndividualImportStep(stepCtx, {id: job.attempt_id!, scopeIds: job.company_ids});
        }, retryDelayMs);
        if (progress.state === 'completed') {
          await connection`update payroll_individual_import_job set state = 'completed', processed = ${progress.processed}, finished_at = now() where id = ${job.id}`;
        } else if (progress.state === 'stopped') {
          await connection`update payroll_individual_import_job set state = 'stopped', processed = ${progress.processed}, error = coalesce(error, 'importStopped'), finished_at = now() where id = ${job.id}`;
        } else {
          await connection`update payroll_individual_import_job set processed = ${progress.processed} where id = ${job.id}`;
        }
      } catch (error) {
        // Driver exceptions may contain payroll values. Persist only bounded application codes.
        const code = error instanceof IndividualImportReadFailure ? error.code : individualImportErrorCode(error, 'importFailed');
        if ((job.state === 'confirmed' || job.state === 'importing') && job.attempt_id) {
          // Rows written by earlier steps stay written (and revertable); the batch says it stopped.
          const state = ctx ? await stopIndividualImport(ctx, {id: job.attempt_id, scopeIds: job.company_ids, reason: code}).catch(() => 'stopped') : 'stopped';
          await connection`update payroll_individual_import_job set state = ${state === 'completed' ? 'completed' : 'stopped'},
            error = ${state === 'completed' ? null : code}, finished_at = now() where id = ${job.id}`;
        } else {
          await connection`update payroll_individual_import_job set state = 'failed', error = ${code}, finished_at = now() where id = ${job.id}`;
        }
      }
      return true;
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended('payroll-individual-import-worker', 0))`;
    }
  } finally {
    await connection.release();
  }
}

/** One revert step, under the session of the administrator who asked for it. */
async function revertTick(
  connection: postgres.ReservedSql, job: QueuedJob, refreshContext: (ctx: SessionContext) => Promise<SessionContext>,
  options: IndividualImportTickOptions, retryDelayMs: number,
) {
  let ctx: SessionContext | null = null;
  const p = {id: job.attempt_id!, scopeIds: job.company_ids};
  try {
    if (!job.attempt_id || !job.revert_context?.userId) throw new IndividualImportError('revertUnavailable');
    ctx = await refreshContext({...job.revert_context, tenantId: job.tenant_id});
    if (!await readIndividualImportJob(ctx, job.id, job.company_ids)) throw new IndividualImportError('importAccessDenied');
    const stepCtx = ctx;
    const progress = await withRetries(async () => {
      await options.beforeStep?.({id: job.id, state: 'reverting'});
      return revertIndividualImportStep(stepCtx, p);
    }, retryDelayMs);
    if (progress.state !== 'reverting') {
      // Reverted, or handed back by someone else meanwhile.
      await connection`update payroll_individual_import_job set state = ${progress.state === 'reverted' ? 'reverted' : progress.state === 'completed' ? 'completed' : 'stopped'},
        finished_at = now() where id = ${job.id}`;
    }
  } catch (error) {
    const code = individualImportErrorCode(error, 'revertFailed');
    const back = ctx ? await handBackIndividualImportRevert(ctx, p, error).catch(() => null) : null;
    await connection`update payroll_individual_import_job set state = ${back === 'completed' ? 'completed' : back === 'reverted' ? 'reverted' : 'stopped'},
      error = ${back === 'reverted' ? null : code}, finished_at = now() where id = ${job.id}`;
  }
}
