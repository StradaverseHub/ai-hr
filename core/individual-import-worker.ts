import {createHash} from 'node:crypto';
import type postgres from 'postgres';
import type {SessionContext} from '../db/client';
import {readImportFile, ImportFileError} from '../lib/import-file';
import {INDIVIDUAL_IMPORT_MAX_BYTES, type IndividualImportJob} from '../lib/individual-import-job';
import type {IndividualImportMethod} from '../lib/payroll-txn-import-schema';
import {confirmIndividualImport, IndividualImportError, validateIndividualImport} from './individual-txn-import';
import {readIndividualImportJob} from './individual-import-job';

type QueuedJob = IndividualImportJob & {
  context: SessionContext;
  company_ids: string[];
  tenant_id: string;
  method: IndividualImportMethod;
  source_hash: string;
};

export async function runIndividualImportTick(
  owner: postgres.Sql,
  refreshContext: (ctx: SessionContext) => Promise<SessionContext>,
): Promise<boolean> {
  const connection = await owner.reserve();
  try {
    const [lock] = await connection<{ok: boolean}[]>`select pg_try_advisory_lock(hashtextextended('payroll-individual-import-worker', 0)) as ok`;
    if (!lock.ok) return false;
    try {
      const [job] = await connection<QueuedJob[]>`
        select id, tenant_id, created_by, company_ids, context, source_name, source_hash, method, state, attempt_id
        from payroll_individual_import_job where state in ('pending', 'validating', 'confirmed', 'importing')
        order by created_at, id limit 1`;
      if (!job) return false;
      try {
        const ctx = await refreshContext({...job.context, tenantId: job.tenant_id, userId: job.created_by});
        if (!await readIndividualImportJob(ctx, job.id, job.company_ids)) throw new IndividualImportError('importAccessDenied');
        if (job.state === 'pending' || job.state === 'validating') {
          await connection`update payroll_individual_import_job set state = 'validating', started_at = coalesce(started_at, now()) where id = ${job.id}`;
          const [payload] = await connection<{source: Buffer}[]>`select source from payroll_individual_import_job where id = ${job.id}`;
          if (createHash('sha256').update(payload.source).digest('hex') !== job.source_hash) throw new IndividualImportError('fileReadError');
          const {text} = await readImportFile(new File([new Uint8Array(payload.source)], job.source_name), {
            maxFileBytes: INDIVIDUAL_IMPORT_MAX_BYTES, maxCsvBytes: 900_000, maxRows: 2002, maxCells: 100_000,
          });
          const attempt = await validateIndividualImport(ctx, {
            operationId: job.id, sourceName: job.source_name, csv: text, method: job.method, scopeIds: job.company_ids,
          });
          const error = attempt.preview.fileError ?? (attempt.preview.valid ? null : 'noValidRows');
          await connection`update payroll_individual_import_job set attempt_id = ${attempt.id},
            state = ${error ? 'failed' : 'ready'}, error = ${error},
            finished_at = case when ${Boolean(error)} then now() else null end where id = ${job.id}`;
        } else {
          if (!job.attempt_id) throw new IndividualImportError('importFailed');
          await connection`update payroll_individual_import_job set state = 'importing', processed = 0 where id = ${job.id}`;
          const result = await confirmIndividualImport(ctx, {id: job.attempt_id, scopeIds: job.company_ids}, async processed => {
            await connection`update payroll_individual_import_job set processed = ${processed} where id = ${job.id}`;
          });
          await connection`update payroll_individual_import_job set state = 'completed', processed = ${result.outcomes.length}, finished_at = now() where id = ${job.id}`;
        }
      } catch (error) {
        // Driver exceptions may contain payroll values. Persist only bounded application codes.
        const code = error instanceof IndividualImportError ? error.message
          : error instanceof ImportFileError ? error.code === 'FILE_TOO_LARGE' ? 'fileTooLarge' : 'fileReadError'
          : 'importFailed';
        await connection`update payroll_individual_import_job set state = 'failed', error = ${code}, finished_at = now() where id = ${job.id}`;
      }
      return true;
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended('payroll-individual-import-worker', 0))`;
    }
  } finally {
    await connection.release();
  }
}
