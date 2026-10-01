import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company, payslipInformationSetting } from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { canManagePayroll } from '../lib/authz';
import { PAYSLIP_INFORMATION_FIELDS, payslipInformationFields } from './payslip-information';

export async function getPayslipInformationSettings(ctx: SessionContext, companyId: string) {
  if (!canManagePayroll(ctx, companyId)) throw new Error('Forbidden');
  return withTenant(ctx, async tx => {
    const [owned] = await tx.select({id: company.id}).from(company)
      .where(and(eq(company.id, companyId), eq(company.tenantId, ctx.tenantId)));
    if (!owned) throw new Error('Forbidden');
    const [row] = await tx.select().from(payslipInformationSetting).where(eq(payslipInformationSetting.companyId, companyId));
    return payslipInformationFields(row?.fields);
  });
}
export async function setPayslipInformationSettings(ctx: SessionContext, companyId: string, fields: string[]) {
  if (!canManagePayroll(ctx, companyId)) throw new Error('Forbidden');
  if (fields.some(k => !(PAYSLIP_INFORMATION_FIELDS as readonly string[]).includes(k))) throw new Error('Unknown payslip field');
  const ordered = [...payslipInformationFields(fields)];
  return withTenant(ctx, async tx => {
    const [owned] = await tx.select({id: company.id}).from(company)
      .where(and(eq(company.id, companyId), eq(company.tenantId, ctx.tenantId)));
    if (!owned) throw new Error('Forbidden');
    await tx.insert(payslipInformationSetting).values({tenantId: ctx.tenantId, companyId, fields: ordered})
      .onConflictDoUpdate({target: payslipInformationSetting.companyId, set: {fields: ordered}});
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: companyId,
      eventType: 'payslip-information.changed', actor: actorOf(ctx), payload: {fields: ordered}});
    return ordered;
  });
}
