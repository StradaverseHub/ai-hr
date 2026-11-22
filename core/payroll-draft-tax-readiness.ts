import {and, eq, inArray, like, lt, sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {compensation, employment, payrollBatch, payslip} from '../db/schema';
import {bulkJobId, bulkJobWorkerStatusTx, enqueueBulkJobTx} from './bulk-job';
import type {BulkJobHandler, BulkJobPrepared, BulkJobStepInput} from './bulk-job-worker';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {settingEnabled} from './entitlements';
import {assertModuleGate} from './module-gate';
import {resolveBatchScopeFilter, type BatchScope} from './payroll';
import {outstandingPaymentPredicate, payrollCompensationEffectiveOn, payrollEmploymentPredicate} from './payroll-employment-eligibility';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {importedTaxReviewPeriod} from './payroll-run-group-result';
import {readTaxBasisFailureDetailsTx} from './payroll-tax-basis-read';

const KIND = 'payroll_draft_tax_readiness';
const EMPLOYEES_PER_STEP = 24;
export const DRAFT_TAX_PAGE_SIZE = 30;

export type DraftTaxBlocker = {
  employmentId: string;
  period: string;
  kind: 'importedHistory' | 'savedHistory';
};
type DraftTaxRow = DraftTaxBlocker & {employeeCode: string | null; name: string};
export type DraftTaxStatus = {
  state: 'waiting' | 'checking' | 'done' | 'failed';
  checked: number;
  total: number;
  blockers: number;
  rows: DraftTaxRow[];
  canReviewTax: boolean;
};

function unavailable() { return new Error('Draft tax readiness is unavailable.'); }

async function requireDraft(tx: Tx, ctx: SessionContext, batchId: string) {
  assertModuleGate(ctx, 'payroll');
  await lockAccessConfigurationReadTx(tx, ctx.tenantId);
  const [batch] = await tx.select().from(payrollBatch).where(and(
    eq(payrollBatch.id, bulkJobId(batchId)), eq(payrollBatch.tenantId, ctx.tenantId),
    eq(payrollBatch.status, 'draft'),
  )).limit(1);
  if (!batch?.payPeriodId) throw unavailable();
  const [access] = await tx.execute<{allowed: boolean; canReviewTax: boolean}>(sql`
    select app.principal_snapshot_current() and app.can_admin_payroll_for(${batch.companyId}::uuid) as allowed,
      app.payroll_tax_basis_permission(${batch.companyId}::uuid,'payroll.tax-basis.view')
      and app.payroll_tax_basis_permission(${batch.companyId}::uuid,'payroll.tax-basis.recalculate') as "canReviewTax"`);
  if (!access?.allowed) throw unavailable();
  return {batch: {...batch, payPeriodId: batch.payPeriodId}, canReviewTax: access.canReviewTax};
}

export async function requestDraftTaxReadiness(ctx: SessionContext, batchId: string, operationKey: string) {
  return withTenant(ctx, async tx => {
    const {batch} = await requireDraft(tx, ctx, batchId);
    const [active] = await tx.execute<{id: string}>(sql`
      select id from bulk_job where tenant_id=${ctx.tenantId}::uuid and created_by=${ctx.userId ?? null}::uuid
       and kind=${KIND} and input->>'batchId'=${batch.id}
       and state in ('queued','preparing','running','finalizing') order by created_at desc limit 1`);
    if (active) return active.id;
    const {row} = await enqueueBulkJobTx(tx, ctx, {kind: KIND, operationKey, companyIds: [batch.companyId], input: {batchId: batch.id}});
    return row.id;
  });
}

export async function readDraftTaxReadiness(ctx: SessionContext, batchId: string, id: string, offset: number): Promise<DraftTaxStatus> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw unavailable();
  return withTenant(ctx, async tx => {
    const {batch, canReviewTax} = await requireDraft(tx, ctx, batchId);
    const [job] = await tx.execute<{state: string; steps_done: number; steps_total: number; blockers: number}>(sql`
      select state,steps_done,steps_total,coalesce(jsonb_array_length(result->'blockers'),0) as blockers
      from bulk_job where id=${bulkJobId(id)}::uuid and tenant_id=${ctx.tenantId}::uuid
        and created_by=${ctx.userId ?? null}::uuid and kind=${KIND}
        and company_ids=array[${batch.companyId}::uuid]
        and coalesce(plan->>'batchId',input->>'batchId')=${batch.id}`);
    if (!job) throw unavailable();
    const base = {checked: job.steps_done, total: job.steps_total, blockers: job.blockers, canReviewTax, rows: []};
    if (job.state === 'failed' || job.state === 'cancelled') return {...base, state: 'failed'};
    if (job.state !== 'completed') {
      const waiting = job.state === 'queued' && await bulkJobWorkerStatusTx(tx, KIND) === 'unavailable';
      return {...base, state: waiting ? 'waiting' : 'checking'};
    }
    const rows = await tx.execute<DraftTaxRow>(sql`
      select e.id as "employmentId",e.employee_code as "employeeCode",p.full_name as name,
        r.value->>'period' as period,r.value->>'kind' as kind
      from bulk_job j cross join lateral jsonb_array_elements(j.result->'blockers') with ordinality r(value,ord)
      join employment e on e.id=(r.value->>'employmentId')::uuid and e.tenant_id=j.tenant_id
      join person p on p.id=e.person_id and p.tenant_id=j.tenant_id
      where j.id=${id}::uuid order by r.ord offset ${offset} limit ${DRAFT_TAX_PAGE_SIZE}`);
    return {...base, state: 'done', rows: [...rows]};
  });
}

type Step = {employmentIds: string[]; sameMonth: boolean};

export const draftTaxReadinessJobHandler: BulkJobHandler<Step> = {
  kind: KIND,
  mode: 'atomic',
  quietNotice: () => true,
  onFailure: () => 'fail',
  discard: async () => 'done',
  maxStepsPerChunk: 1,
  async prepare(ctx, job): Promise<BulkJobPrepared> {
    return withTenant(ctx, async tx => {
      await lockPayrollHistoryReadTx(tx, ctx.tenantId);
      const {batch} = await requireDraft(tx, ctx, (job.input as {batchId: string}).batchId);
      const enabled = settingEnabled(ctx, 'payroll.individual_txn_pay_enabled');
      const {filter} = await resolveBatchScopeFilter(tx, batch.scope as BatchScope | null);
      const members = await tx.selectDistinct({
        id: employment.id,
        outstanding: sql<boolean>`${outstandingPaymentPredicate(batch, enabled)}`,
      }).from(employment).innerJoin(compensation, and(
        eq(compensation.employmentId, employment.id), payrollCompensationEffectiveOn(batch.payPeriod),
      )).where(and(payrollEmploymentPredicate(batch, enabled), filter)).orderBy(employment.id);
      const steps: BulkJobStepInput[] = [];
      for (let i = 0; i < members.length; i += EMPLOYEES_PER_STEP) {
        steps.push({kind: 'prior', payload: {employmentIds: members.slice(i, i + EMPLOYEES_PER_STEP).map(row => row.id), sameMonth: false}});
      }
      // Processing reads the company's earlier cycles if this run needs its same-month history.
      if (batch.runType !== 'regular' || batch.runSeq > 1 || members.some(row => row.outstanding)) {
        const earlier = await tx.selectDistinct({id: payslip.employmentId}).from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(and(eq(payrollBatch.companyId, batch.companyId), eq(payrollBatch.payPeriodId, batch.payPeriodId),
            lt(payrollBatch.runSeq, batch.runSeq))).orderBy(payslip.employmentId);
        for (let i = 0; i < earlier.length; i += EMPLOYEES_PER_STEP) {
          steps.push({kind: 'earlier', payload: {employmentIds: earlier.slice(i, i + EMPLOYEES_PER_STEP).map(row => row.id), sameMonth: true}});
        }
      }
      return {steps, plan: {batchId: batch.id}};
    });
  },
  async applyStepTx(tx, ctx, job, step) {
    await lockPayrollHistoryReadTx(tx, ctx.tenantId);
    const {batch} = await requireDraft(tx, ctx, (job.plan as {batchId: string}).batchId);
    const {employmentIds, sameMonth} = step.payload;
    const slips = await tx.select({id: payslip.id}).from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(and(inArray(payslip.employmentId, employmentIds), eq(payrollBatch.companyId, batch.companyId),
        sameMonth
          ? and(eq(payrollBatch.payPeriodId, batch.payPeriodId), lt(payrollBatch.runSeq, batch.runSeq))
          : and(like(payrollBatch.payPeriod, batch.payPeriod.slice(0, 4) + '-%'), lt(payrollBatch.payPeriod, batch.payPeriod))));
    const failures = await readTaxBasisFailureDetailsTx(tx, ctx, slips.map(row => row.id), {includeImported: true, sameMonth});
    const blockers: DraftTaxBlocker[] = [...failures].map(([employmentId, {period, reason}]) => ({
      employmentId, period, kind: importedTaxReviewPeriod(reason) ? 'importedHistory' : 'savedHistory',
    }));
    return {result: blockers};
  },
  async finalize(ctx, job) {
    return withTenant(ctx, async tx => {
      await requireDraft(tx, ctx, (job.plan as {batchId: string}).batchId);
      const [result] = await tx.execute<{blockers: DraftTaxBlocker[]}>(sql`
        select coalesce(jsonb_agg(b.value order by b.value->>'period',b.value->>'employmentId'),'[]'::jsonb) as blockers
        from (
          select distinct on (r.value->>'employmentId') r.value
          from bulk_job_step s cross join lateral jsonb_array_elements(s.result) r(value)
          where s.job_id=${job.id}::uuid and s.state='applied'
          order by r.value->>'employmentId',s.seq
        ) b`);
      return {result};
    });
  },
};
