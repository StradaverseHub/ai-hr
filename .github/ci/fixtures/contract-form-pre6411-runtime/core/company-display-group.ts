import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { businessUnit, company, department, profileOption } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { EMPLOYMENT_LABEL_CATEGORIES } from '../lib/system-label-definition';
import { companyDisplayGroupFields, type CompanyDisplayGroupOption } from '../lib/company-display-group';
import { lockLabelCriteriaTx, visibleLabelIdsCondition } from './system-labels';

const displayGroupInput = z.object({ field: z.enum(companyDisplayGroupFields), id: z.uuid() }).strict();

async function optionsTx(tx: Tx, tenantId: string, companyId?: string): Promise<CompanyDisplayGroupOption[]> {
  const [units, departments, options] = await Promise.all([
    tx.select({ id: businessUnit.id, code: businessUnit.code, label: businessUnit.name }).from(businessUnit)
      .where(and(eq(businessUnit.tenantId, tenantId), isNull(businessUnit.archivedAt),
        companyId ? visibleLabelIdsCondition(businessUnit, 'business_unit', [companyId]) : eq(businessUnit.isGlobal, true))),
    tx.select({ id: department.id, code: department.label, label: department.name }).from(department)
      .where(and(eq(department.tenantId, tenantId), isNull(department.archivedAt),
        companyId ? visibleLabelIdsCondition(department, 'department', [companyId]) : eq(department.isGlobal, true))),
    tx.select({ id: profileOption.id, code: profileOption.value, label: profileOption.label, field: profileOption.category }).from(profileOption)
      .where(and(eq(profileOption.tenantId, tenantId), eq(profileOption.isActive, true),
        inArray(profileOption.category, [...EMPLOYMENT_LABEL_CATEGORIES]))),
  ]);
  return [
    ...units.map(row => ({ ...row, field: 'business_unit' as const })),
    ...departments.map(row => ({ ...row, code: row.code ?? row.label, field: 'department' as const })),
    ...options.flatMap(row => {
      const field = EMPLOYMENT_LABEL_CATEGORIES.find(category => category === row.field);
      return field ? [{ ...row, field }] : [];
    }),
  ].sort((a, b) => a.label.localeCompare(b.label) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}

export function companyDisplayGroupOptions(ctx: SessionContext, companyId?: string) {
  return withTenant(ctx, async tx => {
    const [authority] = await tx.execute<{ allowed: boolean }>(sql`
      select app.principal_snapshot_current() and
        case when ${companyId ?? null}::uuid is null then app.is_group_admin()
             else app.is_admin_for(${companyId ?? null}::uuid) end as allowed
    `);
    if (!authority?.allowed) return [];
    return optionsTx(tx, ctx.tenantId, companyId);
  });
}

export function companyDisplayGroups(ctx: SessionContext) {
  return withTenant(ctx, tx => tx.execute<{
    companyId: string;
    field: import('../lib/company-display-group').CompanyDisplayGroupField;
    id: string;
    code: string | null;
    label: string | null;
  }>(sql`
    select c.id as "companyId", c.display_group_field as field, c.display_group_option_id as id,
           coalesce(b.code, d.label, d.name, p.value) as code,
           coalesce(b.name, d.name, p.label) as label
    from company c
    left join business_unit b on c.display_group_field = 'business_unit'
      and b.id = c.display_group_option_id and b.tenant_id = c.tenant_id and b.archived_at is null
      and (b.is_global or exists (
        select 1 from label_company_assignment l where l.tenant_id = c.tenant_id and l.company_id = c.id
        and l.label_kind = 'business_unit' and l.label_id = b.id))
    left join department d on c.display_group_field = 'department'
      and d.id = c.display_group_option_id and d.tenant_id = c.tenant_id and d.archived_at is null
      and (d.is_global or exists (
        select 1 from label_company_assignment l where l.tenant_id = c.tenant_id and l.company_id = c.id
        and l.label_kind = 'department' and l.label_id = d.id))
    left join profile_option p on p.category = c.display_group_field and p.id = c.display_group_option_id
      and p.tenant_id = c.tenant_id and p.is_active
    where c.tenant_id = app.current_tenant_id() and app.is_admin_for(c.id)
      and c.display_group_field is not null
  `));
}

export async function saveCompanyDisplayGroupTx(tx: Tx, ctx: SessionContext, companyId: string, raw: unknown) {
  const selection = raw === null ? null : displayGroupInput.parse(raw);
  await lockLabelCriteriaTx(tx, ctx.tenantId);
  const [current] = await tx.select({ field: company.displayGroupField, id: company.displayGroupOptionId })
    .from(company)
    .where(and(eq(company.tenantId, ctx.tenantId), eq(company.id, companyId),
      sql`app.principal_snapshot_current() and app.is_admin_for(${company.id})`)).for('update');
  if (!current) throw Error('Company is unavailable.');
  if (current.field === (selection?.field ?? null) && current.id === (selection?.id ?? null)) return;
  if (selection && !(await optionsTx(tx, ctx.tenantId, companyId)).some(row => row.field === selection.field && row.id === selection.id)) {
    throw Error('Choose an available Employment Field value for this company.');
  }
  await tx.update(company).set({
    displayGroupField: selection?.field ?? null,
    displayGroupOptionId: selection?.id ?? null,
  }).where(and(eq(company.tenantId, ctx.tenantId), eq(company.id, companyId)));
  await appendEvent(tx, {
    tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: companyId,
    eventType: 'company.display-group.changed', actor: actorOf(ctx), payload: { before: current, after: selection },
  });
}
