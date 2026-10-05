import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { assignment, businessUnit, company, department, employment, person, position } from '../db/schema';
import { EMPLOYEE_SEARCH_RESULT_CAP, foldEmployeeCode } from '../lib/employee-search';

/** Small identity projection for selectors; never serialize a full employee record. */
export type EmployeeSearchOption = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  companyId: string;
  department: string | null;
  departmentId: string | null;
  businessUnit: string | null;
  businessUnitId: string | null;
  position: string | null;
  terminatedOn: string | null;
};

export type EmployeeOptionFilters = {
  /** Resolved on the server. An empty scope returns no rows, never all companies. */
  companyIds: string[];
  query?: string;
  companyId?: string;
  departmentId?: string;
  businessUnitId?: string;
  status?: 'active' | 'terminated';
};

function currentAssignment() {
  return and(eq(assignment.employmentId, employment.id),
    isNull(assignment.validTo), isNull(assignment.supersededAt));
}

function optionsQuery(tx: Tx) {
  return tx.select({
    employmentId: employment.id, name: person.fullName, employeeCode: employment.employeeCode,
    company: company.legalName, companyId: employment.companyId,
    department: department.name, departmentId: assignment.departmentId,
    businessUnit: businessUnit.name, businessUnitId: assignment.businessUnitId,
    position: position.title, terminatedOn: employment.terminatedOn,
  }).from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(assignment, currentAssignment())
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .leftJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId))
    .leftJoin(position, eq(position.id, assignment.positionId));
}

/** SQL twin of matchEmployees: exact folded ID, ID prefix, name prefix, ID substring, name substring.
 * strpos/starts_with keep '%' and '_' literal, matching the existing client search semantics. */
function searchRank(query: string) {
  const raw = query.trim().toLowerCase();
  if (!raw) return sql<number>`0`;
  const folded = foldEmployeeCode(query);
  const name = sql`lower(${person.fullName})`;
  const code = sql`lower(coalesce(${employment.employeeCode}, ''))`;
  const codeFolded = sql`regexp_replace(${code}, '[[:space:]_.-]', '', 'g')`;
  return sql<number>`case
    when ${folded} <> '' and ${codeFolded} = ${folded} then 0
    when ${folded} <> '' and starts_with(${codeFolded}, ${folded}) then 1
    when starts_with(${name}, ${raw}) then 2
    when strpos(${code}, ${raw}) > 0 or (${folded} <> '' and strpos(${codeFolded}, ${folded}) > 0) then 3
    when strpos(${name}, ${raw}) > 0 then 4
    else null end`;
}

function filters(input: EmployeeOptionFilters) {
  return and(inArray(employment.companyId, input.companyIds),
    input.companyId ? eq(employment.companyId, input.companyId) : undefined,
    input.departmentId ? eq(assignment.departmentId, input.departmentId) : undefined,
    input.businessUnitId ? eq(assignment.businessUnitId, input.businessUnitId) : undefined,
    input.status === 'active' ? isNull(employment.terminatedOn) : undefined,
    input.status === 'terminated' ? isNotNull(employment.terminatedOn) : undefined,
    sql`${searchRank(input.query ?? '')} is not null`);
}

function cap(limit?: number) {
  return Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit!, 50)) : EMPLOYEE_SEARCH_RESULT_CAP;
}

/** Search the entire authorized population BEFORE limiting the response. withTenant enforces RLS;
 * callers additionally resolve their feature permission and selected company scope on every request. */
export async function searchEmployeeOptions(ctx: SessionContext, input: EmployeeOptionFilters & {
  query: string; limit?: number;
}): Promise<EmployeeSearchOption[]> {
  if (!input.query.trim() || input.query.length > 200 || !input.companyIds.length) return [];
  return withTenant(ctx, (tx) => optionsQuery(tx).where(filters(input))
    .orderBy(asc(searchRank(input.query)), asc(person.fullName), asc(employment.id)).limit(cap(input.limit)));
}

/** Browse/search selectors in bounded pages. The count uses the same scope and current assignment. */
export async function listEmployeeOptionsPage(ctx: SessionContext, input: EmployeeOptionFilters & {
  limit: number; offset: number;
}): Promise<{ rows: EmployeeSearchOption[]; total: number }> {
  if ((input.query?.length ?? 0) > 200 || !input.companyIds.length) return { rows: [], total: 0 };
  const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  return withTenant(ctx, async (tx) => {
    const where = filters(input);
    const rows = await optionsQuery(tx).where(where)
      .orderBy(asc(searchRank(input.query ?? '')), asc(person.fullName), asc(employment.id))
      .limit(cap(input.limit)).offset(offset);
    const [count] = await tx.select({ total: sql<number>`count(distinct ${employment.id})::int` })
      .from(employment).innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment()).where(where);
    return { rows, total: count.total };
  });
}

/** A selected URL value may be beyond the current page; resolve it separately under the same scope. */
export async function getEmployeeOption(ctx: SessionContext, companyIds: string[], employmentId: string): Promise<EmployeeSearchOption | null> {
  if (!companyIds.length || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employmentId)) return null;
  return withTenant(ctx, async (tx) => {
    const [row] = await optionsQuery(tx)
      .where(and(inArray(employment.companyId, companyIds), eq(employment.id, employmentId))).limit(1);
    return row ?? null;
  });
}

/** Only org labels represented in the same visible employee population belong in picker facets. */
export async function listEmployeeOptionFacets(ctx: SessionContext, companyIds: string[], companyId?: string): Promise<{
  companies: { id: string; name: string }[];
  businessUnits: { id: string; name: string }[];
  departments: { id: string; name: string }[];
}> {
  if (!companyIds.length) return { companies: [], businessUnits: [], departments: [] };
  return withTenant(ctx, async (tx) => {
    const scope = inArray(employment.companyId, companyIds);
    const narrowed = and(scope, companyId ? eq(employment.companyId, companyId) : undefined);
    const companies = await tx.selectDistinct({ id: company.id, name: company.legalName })
      .from(employment).innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId)).where(scope).orderBy(company.legalName, company.id);
    const businessUnits = await tx.selectDistinct({ id: businessUnit.id, name: businessUnit.name })
      .from(employment).innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(assignment, currentAssignment())
      .innerJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId))
      .where(narrowed).orderBy(businessUnit.name, businessUnit.id);
    const departments = await tx.selectDistinct({ id: department.id, name: department.name })
      .from(employment).innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(assignment, currentAssignment())
      .innerJoin(department, eq(department.id, assignment.departmentId))
      .where(narrowed).orderBy(department.name, department.id);
    return { companies, businessUnits, departments };
  });
}
