import {sql} from 'drizzle-orm';
import type {SessionContext, Tx} from '../db/client';
import {taxBasisNoticeBatchIds, type TaxBasisNoticeReference} from '../lib/payroll-tax-basis-notices';
import {assertModuleGate} from './module-gate';
import {withPayrollHistoryTenant} from './payroll-history-lock';
import {resolvePayrollPermission} from '../packs/payroll/service';
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

async function referencesTx(tx: Tx, ctx: SessionContext, references: unknown): Promise<TaxBasisNoticeReference[]> {
  const ids = taxBasisNoticeBatchIds(references);
  if (!ids.length) return [];
  const rows = await tx.execute<{id: string; companyId: string}>(sql`select id,company_id as "companyId" from payroll_tax_basis_batch
    where tenant_id=${ctx.tenantId}::uuid and id=any(array[${sql.join(ids.map(id => sql`${id}::uuid`),sql`, `)}]::uuid[])`);
  const access = new Map<string, boolean>();
  for (const row of rows) if (!access.has(row.companyId)) access.set(row.companyId, await resolvePayrollPermission(tx, ctx, 'payroll.tax-basis.view', row.companyId));
  const permitted = new Set(rows.filter(row => access.get(row.companyId)).map(row => row.id));
  return ids.map(batchId => ({batchId, reference: 'TAX-'+batchId.toUpperCase(), canOpen: permitted.has(batchId)}));
}

/** References already returned by an authorized calculation/report; log access is checked separately. */
export async function taxBasisNoticeReferences(ctx: SessionContext, references: unknown): Promise<TaxBasisNoticeReference[]> {
  assertModuleGate(ctx, 'payroll');
  if (!taxBasisNoticeBatchIds(references).length) return [];
  return withPayrollHistoryTenant(ctx, tx => referencesTx(tx, ctx, references));
}

/** Read only audit existence beside original working. Never overlays or recalculates its figures.
 * A stale correction must remain discoverable here while corrected-basis consumers refuse it. */
export async function taxBasisNoticesForPayslip(ctx: SessionContext, input: {companyIds: string[]; payslipId: string}) {
  assertModuleGate(ctx, 'payroll');
  const empty = {original: [] as TaxBasisNoticeReference[], applied: [] as TaxBasisNoticeReference[]};
  if (!input.companyIds.length || !uuid.test(input.payslipId) || input.companyIds.some(id => !uuid.test(id))) return empty;
  return withPayrollHistoryTenant(ctx, async tx => {
    const [source] = await tx.execute<{companyId: string; employmentId: string; period: string; statutory: unknown}>(sql`
      select b.company_id as "companyId",p.employment_id as "employmentId",b.pay_period as period,p.statutory
      from payslip p join payroll_batch b on b.id=p.batch_id
      where p.id=${input.payslipId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and b.tenant_id=${ctx.tenantId}::uuid
      and b.company_id=any(array[${sql.join(input.companyIds.map(id => sql`${id}::uuid`),sql`, `)}]::uuid[])`);
    if (!source) return empty;
    const original = await tx.execute<{batchId: string}>(sql`select batch_id as "batchId" from payroll_tax_basis_revision
      where tenant_id=${ctx.tenantId}::uuid and company_id=${source.companyId}::uuid
      and employment_id=${source.employmentId}::uuid and period=${source.period} order by created_at,id`);
    const statutory = source.statutory && typeof source.statutory === 'object' ? source.statutory as Record<string, unknown> : {};
    return {original: await referencesTx(tx, ctx, original), applied: await referencesTx(tx, ctx, statutory.taxBasisCorrections)};
  });
}
