import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant, type SessionContext} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {INDIVIDUAL_IMPORT_MAX_BYTES, type IndividualImportJob} from '../lib/individual-import-job';
import type {IndividualImportMethod} from '../lib/payroll-txn-import-schema';
import {IndividualImportError} from './individual-txn-import';

const uuid = z.uuid();
const metadata = sql`job.id, job.source_name, job.created_by, job.created_at, job.started_at, job.finished_at,
  job.attempt_id, job.state, job.processed, job.error, job.method,
  coalesce((attempt.preview->>'total')::int, 0) as total, coalesce(attempt.written, 0) as written,
  case when attempt.state in ('completed', 'reverted') then jsonb_array_length(attempt.outcomes) - attempt.written
    else coalesce((attempt.preview->>'invalid')::int, 0) end as failed_rows`;
const jobWithAttempt = sql`payroll_individual_import_job job
  left join payroll_txn_import_attempt attempt on attempt.id = job.attempt_id`;
const selection = (ids: string[]) => sql`job.company_ids <@ ${JSON.stringify(ids)}::jsonb`;

export async function submitIndividualImportJob(ctx: SessionContext, input: {
  id: string; name: string; content: Buffer; method: IndividualImportMethod; scopeIds: string[];
}) {
  if (!uuid.safeParse(input.id).success) throw new IndividualImportError('operationChanged');
  if (!ctx.userId || ctx.agent || !isAdmin(ctx) || !input.scopeIds.length) throw new IndividualImportError('importAccessDenied');
  if (input.method !== 'monthly' && input.method !== 'daily') throw new IndividualImportError('templateMismatch');
  if (!input.name.toLowerCase().endsWith('.xlsx') || input.name.length > 255) throw new IndividualImportError('invalidFormat');
  if (input.content.length > INDIVIDUAL_IMPORT_MAX_BYTES) throw new IndividualImportError('fileTooLarge');
  if (!input.content.length) throw new IndividualImportError('emptyFile');
  const hash = createHash('sha256').update(input.content).digest('hex');
  const companyIds = [...new Set(input.scopeIds)].sort();
  return withTenant(ctx, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'individual-import:' + ctx.tenantId + ':' + ctx.userId}, 0))`);
    const [existing] = await tx.execute<{same: boolean}>(sql`
      select created_by = ${ctx.userId}::uuid and source_hash = ${hash} and method = ${input.method}
        and company_ids = ${JSON.stringify(companyIds)}::jsonb as same
      from payroll_individual_import_job where id = ${input.id}::uuid`);
    if (existing) {
      if (!existing.same) throw new IndividualImportError('operationChanged');
      return input.id;
    }
    const [limit] = await tx.execute<{count: number}>(sql`
      select count(*)::int as count from payroll_individual_import_job
      where created_by = ${ctx.userId}::uuid and state in ('pending', 'validating', 'confirmed', 'importing')`);
    if (limit.count >= 3) throw new IndividualImportError('queueFull');
    await tx.execute(sql`
      insert into payroll_individual_import_job
        (id, tenant_id, created_by, company_ids, context, source_name, source_hash, source, method)
      values (${input.id}::uuid, ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${JSON.stringify(companyIds)}::jsonb,
        ${JSON.stringify({tenantId: ctx.tenantId, userId: ctx.userId, personId: ctx.personId, grants: ctx.grants, roles: ctx.roles})}::jsonb,
        ${input.name}, ${hash}, ${input.content}, ${input.method})`);
    return input.id;
  });
}

export async function readIndividualImportJob(ctx: SessionContext, id: string, scopeIds: string[]) {
  uuid.parse(id);
  return withTenant(ctx, async tx => {
    const [job] = await tx.execute<IndividualImportJob>(sql`
      select ${metadata} from ${jobWithAttempt} where job.id = ${id}::uuid and ${selection(scopeIds)}`);
    return job;
  });
}

export async function listIndividualImportJobs(ctx: SessionContext, scopeIds: string[], before?: {at: string; id: string}) {
  if (before) { z.iso.datetime().parse(before.at); uuid.parse(before.id); }
  return withTenant(ctx, async tx => [...await tx.execute<IndividualImportJob>(sql`
    select ${metadata} from ${jobWithAttempt} where ${selection(scopeIds)}
    ${before ? sql`and (job.created_at, job.id) < (${before.at}::timestamptz, ${before.id}::uuid)` : sql``}
    order by job.created_at desc, job.id desc limit 101`)]);
}

export async function readIndividualImportWorkbook(ctx: SessionContext, id: string, scopeIds: string[]) {
  uuid.parse(id);
  return withTenant(ctx, async tx => {
    const [workbook] = await tx.execute<{source: Buffer; source_name: string}>(sql`
      select source, source_name from payroll_individual_import_job job where id = ${id}::uuid and ${selection(scopeIds)}`);
    return workbook;
  });
}

export async function queueIndividualImportConfirmation(ctx: SessionContext, id: string, scopeIds: string[]) {
  uuid.parse(id);
  return withTenant(ctx, async tx => {
    const [job] = await tx.execute<{id: string}>(sql`
      update payroll_individual_import_job job set state = 'confirmed'
      where id = ${id}::uuid and ${selection(scopeIds)} and state = 'ready'
        and exists (select 1 from payroll_txn_import_attempt where id = attempt_id and (preview->>'valid')::int > 0)
      returning id`);
    return Boolean(job);
  });
}
