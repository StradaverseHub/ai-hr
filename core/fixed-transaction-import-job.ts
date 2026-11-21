import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { employment } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { parseCsvRecords } from '../lib/csv';
import {
  BulkJobError, bulkJobId, bulkJobProgress, enqueueBulkJobTx, type BulkJobRow,
} from './bulk-job';
import { isTransientBulkJobError, type BulkJobHandler } from './bulk-job-worker';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { lockPayrollInputsTx } from './payroll-inputs-lock';
import { planFixedTxnImport, txnImportReason, writeFixedTxnImportRow, type ResolvedFixed } from './payroll-txn-import';

export const FIXED_TRANSACTION_IMPORT_KIND = 'fixed_transaction_import';
const MAX_CSV_BYTES = 900_000;

type ImportLogRow = {
  rowNum: number;
  employeeId: string;
  payItemCode: string;
  reason?: string;
  detail?: Record<string, string | number>;
};
type Step = { resolved: ResolvedFixed; employeeId: string };
type Plan = { rows: ImportLogRow[] };

function assertActor(ctx: SessionContext, ids: string[]) {
  if (!ctx.userId || ctx.agent || !isAdmin(ctx) || !ids.length) throw new BulkJobError('importAccessDenied', 403);
}

async function assertScope(tx: Tx, ctx: SessionContext, ids: string[]) {
  assertActor(ctx, ids);
  const [scope] = await tx.execute<{ allowed: boolean }>(sql`
    select coalesce(bool_and(app.can_admin_payroll_for(id)), false) as allowed
    from unnest(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]) as company_scope(id)
  `);
  if (!scope.allowed) throw new BulkJobError('importAccessDenied', 403);
}

export async function queueFixedTransactionImport(ctx: SessionContext, p: {
  csv: string; fileName: string; operationKey: string; companyIds: string[]; validationOnly?: boolean;
}) {
  const companyIds = [...new Set(p.companyIds)];
  const content = Buffer.from(p.csv, 'utf8');
  if (!content.length || content.length > MAX_CSV_BYTES) throw new BulkJobError('fileTooLarge');
  if (!/\.xlsx$/i.test(p.fileName) || p.fileName.length > 255) throw new BulkJobError('invalidFormat');
  return withTenant(ctx, async (tx) => {
    await assertScope(tx, ctx, companyIds);
    const { row, existing } = await enqueueBulkJobTx(tx, ctx, {
      kind: FIXED_TRANSACTION_IMPORT_KIND,
      operationKey: p.operationKey,
      companyIds,
      source: { name: p.fileName, content },
      input: { validationOnly: p.validationOnly === true },
    });
    if (existing && (row.source_hash !== createHash('sha256').update(content).digest('hex') ||
      row.source_name !== p.fileName ||
      (row.input != null && ((row.input as {validationOnly?:boolean}).validationOnly === true) !== (p.validationOnly === true)) ||
      row.company_ids.length !== companyIds.length ||
      !row.company_ids.every((id) => companyIds.includes(id)))) throw new BulkJobError('operationChanged', 409);
    return row.id;
  });
}

export function readFixedTransactionImport(ctx: SessionContext, id: string, scopeIds: string[]) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.execute<BulkJobRow>(sql`
      select id,kind,state,phase,source_name,steps_total,steps_done,counters,error,errors,plan,company_ids,
        created_at,updated_at,finished_at,cancel_requested_at
      from bulk_job
      where id=${bulkJobId(id)}::uuid and kind=${FIXED_TRANSACTION_IMPORT_KIND}
    `);
    if (!row || !row.company_ids.every((companyId) => scopeIds.includes(companyId))) throw new BulkJobError('Job unavailable.', 404);
    await assertScope(tx, ctx, row.company_ids);
    return { ...bulkJobProgress(row), rows: fixedTransactionImportRows(row) };
  });
}

export async function listFixedTransactionImports(
  ctx: SessionContext, scopeIds: string[], before?: { at: string; id: string },
) {
  if (!scopeIds.length) return [];
  assertActor(ctx, scopeIds);
  return withTenant(ctx, async (tx) => {
    const jobs = await tx.execute<BulkJobRow>(sql`
      select id,kind,state,phase,source_name,steps_total,steps_done,counters,error,created_at,updated_at,
        finished_at,cancel_requested_at
      from bulk_job job
      where tenant_id=${ctx.tenantId}::uuid and created_by=${ctx.userId}::uuid and kind=${FIXED_TRANSACTION_IMPORT_KIND}
        and company_ids <@ ARRAY[${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)}]
        and not exists(select 1 from unnest(job.company_ids) as scope(id) where not app.can_admin_payroll_for(scope.id))
        ${before ? sql`and (created_at,id) < (${before.at}::timestamptz,${before.id}::uuid)` : sql``}
      order by created_at desc,id desc
      limit 51
    `);
    return jobs.map(bulkJobProgress);
  });
}

function fixedTransactionImportRows(job: BulkJobRow) {
  const plan = job.plan as Plan | null;
  const failed = new Map((job.errors ?? []).map((row) => [row.rowNum, row.message]));
  let remaining = job.steps_done;
  return (plan?.rows ?? []).map((row) => {
    if (row.reason) return { ...row, state: 'invalid' as const };
    const considered = remaining-- > 0;
    const error = failed.get(row.rowNum);
    if (error) {
      const split = error.indexOf(' ');
      const reason = split === -1 ? error : error.slice(0, split);
      if (!/^[a-zA-Z]+$/.test(reason)) return { ...row, reason: 'unexpected', state: 'failed' as const };
      let detail: ImportLogRow['detail'];
      if (split !== -1) {
        try { detail = JSON.parse(error.slice(split + 1)); } catch { detail = undefined; }
      }
      return { ...row, reason, detail, state: 'failed' as const };
    }
    return { ...row, state: considered ? 'imported' as const : 'pending' as const };
  });
}

function safeDetail(reason: string, detail: ImportLogRow['detail']) {
  if (reason === 'amountInvalid') return { value: '' };
  if (reason === 'unexpected') return undefined;
  return detail;
}

export const fixedTransactionImportJobHandler: BulkJobHandler<Step> = {
  kind: FIXED_TRANSACTION_IMPORT_KIND,
  mode: 'per-step',
  chunkBudgetMs: 100,
  maxStepsPerChunk: 8,
  phaseOf: () => 'rows',
  stepRef: ({ payload }) => payload.employeeId,
  async prepare(ctx, job) {
    await withTenant(ctx, (tx) => assertScope(tx, ctx, job.company_ids));
    if (!job.source_content?.length || job.source_content.length > MAX_CSV_BYTES) return { refused: 'fileTooLarge' };
    const { records } = parseCsvRecords(job.source_content.toString('utf8'));
    const { preview, resolved } = await planFixedTxnImport(ctx, { records, scopeIds: job.company_ids });
    if (preview.fileError) return { refused: preview.fileError };
    const plan: Plan = { rows: preview.rows.map((row) => ({
      rowNum: row.rowNum, employeeId: row.employeeId, payItemCode: row.payItemCode,
      ...(row.ok ? {} : { reason: row.reason, detail: safeDetail(row.reason, row.detail) }),
    })) };
    if ((job.input as {validationOnly?:boolean}|null)?.validationOnly) {
      return { refused:'noValidRows', plan, counters:{total:preview.total,invalid:preview.invalid} };
    }
    const steps = preview.rows.flatMap((row) => {
      const target = resolved.get(row.rowNum);
      return target ? [{ kind: 'row', rowNum: row.rowNum, payload: { resolved: target, employeeId: row.employeeId } }] : [];
    });
    return { plan, steps, counters: { total: preview.total, invalid: preview.invalid } };
  },
  async beginChunkTx(tx, ctx, job) {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    await assertScope(tx, ctx, job.company_ids);
  },
  async applyStepTx(tx, ctx, job, { payload }) {
    const row = payload.resolved;
    if (!job.company_ids.includes(row.companyId)) throw new Error('importAccessDenied');
    await lockPayrollInputsTx(tx, { employmentIds: [row.employmentId] });
    const [target] = await tx.select({ id: employment.id }).from(employment).where(and(
      eq(employment.id, row.employmentId), eq(employment.companyId, row.companyId),
      sql`app.can_admin_payroll_for(${employment.companyId})`,
    ));
    if (!target) throw new Error('previewChanged');
    try {
      await writeFixedTxnImportRow(ctx, row, tx);
      return { counters: { written: 1 } };
    } catch (error) {
      if (isTransientBulkJobError(error)) throw error;
      const issue = txnImportReason(error);
      const detail = safeDetail(issue.reason, issue.detail);
      throw new Error(detail ? issue.reason + ' ' + JSON.stringify(detail) : issue.reason);
    }
  },
};
