import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { company, payComponent } from '../db/schema';
import { companyOnDate } from './employment-company';
import { lockPayComponentCatalogReadTx } from './pay-component-catalog-lock';
import { normalizePayComponentCompanies, payComponentAppliesToCompany } from '../lib/pay-component-company';

export class PayComponentCompanyError extends Error {
  constructor() { super('This Pay Item is not available for the employee’s company on the effective date. Choose an applicable Pay Item.'); this.name = 'PayComponentCompanyError'; }
}

/** The catalogue is tenant-wide: a partial administrator cannot change hidden companies. */
export function payComponentCompanyChoices(ctx: SessionContext) {
  return withTenant(ctx, async tx => {
    const rows = await tx.select({ id: company.id, name: company.legalName,
      editable: sql<boolean>`app.is_admin_for(${company.id})` }).from(company)
      .where(eq(company.tenantId, ctx.tenantId)).orderBy(company.legalName);
    return { canManageAll: rows.length > 0 && rows.every(row => row.editable), companies: rows.filter(row => row.editable).map(({ id, name }) => ({ id, name })) };
  });
}

/** Undefined preserves a saved setting. Changed scopes must be wholly administered. */
export async function preparePayComponentCompaniesTx(tx: Tx, ctx: SessionContext, value: string[] | null | undefined,
  existing?: { appliedCompanyIds: string[] | null }) {
  if (value === undefined) return {};
  const ids = normalizePayComponentCompanies(value);
  const previous = existing?.appliedCompanyIds == null ? null : [...existing.appliedCompanyIds].sort();
  if (existing && JSON.stringify(ids) === JSON.stringify(previous)) return { appliedCompanyIds: ids };
  const rows = await tx.select({ id: company.id, editable: sql<boolean>`app.is_admin_for(${company.id})` })
    .from(company).where(eq(company.tenantId, ctx.tenantId));
  if (ids && ids.some(id => !rows.some(row => row.id === id && row.editable)))
    throw new Error('Select only companies you are allowed to administer.');
  if (existing && rows.some(row => !row.editable))
    throw new Error('A group administrator must change this shared company applicability. Other Pay Item settings can still be saved.');
  return { appliedCompanyIds: ids };
}

/** Entry-time check only. Payroll and historical readers retain their recorded inputs. */
export async function assertPayComponentCompaniesTx(tx: Tx, ctx: SessionContext,
  rows: readonly { componentId?: string | null; employmentId: string; effectiveDate: string }[]) {
  const ids = [...new Set(rows.flatMap(row => row.componentId ? [row.componentId] : []))];
  if (!ids.length) return;
  await lockPayComponentCatalogReadTx(tx, ctx);
  const items = await tx.select({ id: payComponent.id, appliedCompanyIds: payComponent.appliedCompanyIds })
    .from(payComponent).where(and(eq(payComponent.tenantId, ctx.tenantId), inArray(payComponent.id, ids)));
  const byId = new Map(items.map(item => [item.id, item]));
  const dates = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.componentId) continue;
    const item = byId.get(row.componentId);
    if (!item) throw new PayComponentCompanyError();
    if (item.appliedCompanyIds == null) continue;
    const key = `${row.employmentId}:${row.effectiveDate}`;
    if (!dates.has(key)) dates.set(key, await companyOnDate(tx, row.employmentId, row.effectiveDate));
    const companyId = dates.get(key);
    if (!companyId || !payComponentAppliesToCompany(item, companyId)) throw new PayComponentCompanyError();
  }
}
