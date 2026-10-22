/** Bounded metadata for the allowance editor. No Personnel grant or pay data is added. */
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { withAttendanceTenant } from './module-gate';
import { company, employment, person, department, businessUnit, position, jobGrade, profileOption } from '../db/schema';
import { visibleLabelIdsCondition } from './system-labels';
import { ALLOWANCE_EMPLOYEE_FIELDS_V4, type AllowanceEmployeeFieldV4 } from '../lib/allowance-employee-expression';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function authorize(tx: Tx, companyId: string) {
  if (!UUID.test(companyId)) throw new Error('Choose a policy company.');
  const [allowed] = await tx.select({ ok: sql<boolean>`app.principal_snapshot_current() AND app.is_admin_for(${company.id})` }).from(company).where(eq(company.id, companyId));
  if (!allowed?.ok) throw new Error('Company administration access is required.');
}
export type AllowanceEmployeePageInput = { companyId: string; query: string; page: number; side: 'available' | 'included'; included: string[] };
export type AllowanceEmployeeOption = { id: string; code: string | null; name: string; department: string | null; businessUnit: string | null };
export async function allowanceEmployeePage(ctx: SessionContext, input: AllowanceEmployeePageInput) {
  if (!['available', 'included'].includes(input.side) || !Array.isArray(input.included) || input.included.length > 2000 || input.included.some(id => !UUID.test(id)) || new Set(input.included).size !== input.included.length || typeof input.query !== 'string' || input.query.length > 150 || !Number.isInteger(input.page) || input.page < 1 || input.page > 100000) throw new Error('Invalid employee search or selection.');
  return withAttendanceTenant(ctx, async tx => {
    await authorize(tx, input.companyId);
    const pattern = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`;
    const ids = input.included.length ? sql`e.id=ANY(${sql`ARRAY[${sql.join(input.included.map(id => sql`${id}::uuid`), sql`, `)}]`})` : sql`false`;
    const condition = sql`e.company_id=${input.companyId}::uuid AND app.can_admin_employment(e.id) AND ${input.side === 'included' ? ids : sql`NOT (${ids})`} AND (p.full_name ILIKE ${pattern} OR e.employee_code ILIKE ${pattern})`;
    const result = await tx.execute(sql`
      SELECT e.id,e.employee_code AS code,p.full_name AS name,d.name AS department,b.name AS "businessUnit",count(*) OVER()::int AS total
      FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
      LEFT JOIN LATERAL (SELECT a.department_id,a.business_unit_id FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id DESC LIMIT 1) a ON true
      LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
      LEFT JOIN public.business_unit b ON b.id=coalesce(a.business_unit_id,d.business_unit_id) AND b.tenant_id=e.tenant_id
      WHERE e.tenant_id=app.current_tenant_id() AND ${condition}
      ORDER BY p.full_name,e.employee_code NULLS LAST,e.id LIMIT 25 OFFSET ${(input.page-1)*25}
    `);
    const reachable = input.side==='included' && input.included.length ? await tx.select({id:employment.id}).from(employment).where(and(eq(employment.companyId,input.companyId),inArray(employment.id,input.included),sql`app.can_admin_employment(${employment.id})`)) : [];
    const unavailable = input.side==='included' ? input.included.filter(id=>!reachable.some(row=>row.id===id)) : [];
    let total=Number((result[0] as unknown as {total?: number})?.total ?? 0);
    if(!result.length&&input.page>1) {
      // Moving the final page into Included can leave an empty page behind. Its window has no row
      // carrying count(*); preserve the real scoped total rather than reporting an empty catalogue.
      const [count]=await tx.execute(sql`SELECT count(*)::int AS total FROM public.employment e
        JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
        WHERE e.tenant_id=app.current_tenant_id() AND ${condition}`) as unknown as {total:number}[];
      total=Number(count?.total??0);
    }
    return { rows: result as unknown as (AllowanceEmployeeOption & { total: number })[], page: input.page, total, unavailable };

  });
}
export async function allowanceEmployeeValues(ctx: SessionContext, input: { companyId: string; field: AllowanceEmployeeFieldV4; query: string; page: number; selected?: string[] }) {
  if (!ALLOWANCE_EMPLOYEE_FIELDS_V4.includes(input.field) || typeof input.query !== 'string' || input.query.length > 150 || !Number.isInteger(input.page) || input.page < 1 || input.page > 100000 || input.selected && (input.selected.length > 2000 || input.selected.some(value => typeof value !== 'string' || value.length > 150))) throw new Error('Invalid employee value search.');
  return withAttendanceTenant(ctx, async tx => {
    await authorize(tx, input.companyId);
    const term = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`, offset = (input.page-1)*25;
    const selected = input.selected ?? [];
    if (input.field === 'status' || input.field === 'employmentType') {
      const values = input.field === 'status' ? ['active', 'terminated'] : ['full_time', 'part_time', 'contract', 'intern'];
      return { rows: values.filter(value => value.includes(input.query)).map(id => ({id,label:id})), hasMore: false };
    }
    if (input.field === 'companyId') {
      const rows = await tx.select({id:company.id,label:company.legalName}).from(company).where(eq(company.id,input.companyId));
      return {rows,hasMore:false};
    }
    if (['departmentId', 'businessUnitId', 'positionId', 'gradeId'].includes(input.field)) {
      const table = input.field === 'departmentId' ? department : input.field === 'businessUnitId' ? businessUnit : input.field === 'positionId' ? position : jobGrade;
      const label = input.field === 'positionId' ? position.title : input.field === 'departmentId' ? department.name : input.field === 'businessUnitId' ? businessUnit.name : jobGrade.name;
      const scope = input.field === 'gradeId' ? undefined : input.field === 'departmentId' ? visibleLabelIdsCondition(department,'department',[input.companyId]) : input.field === 'businessUnitId' ? visibleLabelIdsCondition(businessUnit,'business_unit',[input.companyId]) : visibleLabelIdsCondition(position,'position',[input.companyId]);
      const rows = await tx.select({id:table.id,label}).from(table).where(and(isNull(table.archivedAt),scope,selected.length ? inArray(sql<string>`${table.id}::text`,selected) : ilike(label,term))).orderBy(label,table.id).limit(selected.length?2000:26).offset(selected.length?0:offset);
      return {rows:selected.length?rows:rows.slice(0,25),hasMore:!selected.length&&rows.length>25};
    }
    const category = input.field === 'employmentCategory' ? 'category' : input.field;
    const rows = await tx.select({id:profileOption.value,label:profileOption.label}).from(profileOption).where(and(eq(profileOption.category,category),eq(profileOption.isActive,true),selected.length ? inArray(profileOption.value,selected) : or(ilike(profileOption.label,term),ilike(profileOption.value,term)))).orderBy(profileOption.sortOrder,profileOption.label,profileOption.id).limit(selected.length?2000:26).offset(selected.length?0:offset);
    return {rows:selected.length?rows:rows.slice(0,25),hasMore:!selected.length&&rows.length>25};
  });
}
