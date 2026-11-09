/** Test-only represented Department pairs. Runs through the caller's native Tx. */
import {sql,type SQL} from 'drizzle-orm';
import type {readEmployeeChoicesTx} from '../../core/employee-choice';

type Scope=Pick<Parameters<typeof readEmployeeChoicesTx>[2],'companyIds'|'employmentIds'|'terminatedAfter'|'labelMode'>;
const uuidArray=(ids:readonly string[])=>'{'+ids.join(',')+'}';
export const isDepartmentFacet=(text:string)=>text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "department"');

export function departmentFacetBinds(tenant:string,input:Scope){
 return [tenant,tenant,tenant,tenant,tenant,...(input.companyIds.length?[uuidArray(input.companyIds)]:[]),
  ...(input.terminatedAfter===undefined?[]:[input.terminatedAfter]),...(input.employmentIds?.length?[uuidArray(input.employmentIds)]:[])];
}

/** The caller builds this only after the unchanged reader admits and compiles the original scope. */
export function representedDepartmentFacet(tenant:string,input:Scope){
 const {companyIds,employmentIds,terminatedAfter,labelMode}=input;
 const sparse=employmentIds!==undefined&&employmentIds.length<=25;
 const scope=sql`e.tenant_id=${tenant}::uuid
  ${companyIds.length?sql`and e.company_id=any(${uuidArray(companyIds)}::uuid[])`:sql``}
  ${terminatedAfter===undefined?sql``:sql`and (e.terminated_on is null or e.terminated_on>${terminatedAfter}::date)`}
  ${employmentIds===undefined?sql``:employmentIds.length?sql`and e.id=any(${uuidArray(employmentIds)}::uuid[])`:sql`and false`}`;
 const open=sql`a.tenant_id=${tenant}::uuid and a.valid_to is null and a.superseded_at is null and a.department_id is not null`;
 const assignmentKeys=sparse?sql``:sql`open_assignment_keys as materialized (
  select a.employment_id,a.department_id from public.assignment a where ${open}
 ),`;
 const membership=sparse?sql`join lateral (
  select a.department_id from public.assignment a where a.employment_id=m.employment_id and ${open} offset 0
 ) k on true`:sql`join open_assignment_keys k on k.employment_id=m.employment_id`;
 const labels=labelMode==='labels';
 return sql`with authorized_members as materialized (
  select e.id as employment_id,e.company_id from public.employment e
  join public.person p on p.id=e.person_id and p.tenant_id=${tenant}::uuid where ${scope}
 ), ${assignmentKeys} represented_department_pairs as materialized (
  select m.company_id,k.department_id from authorized_members m ${membership} group by m.company_id,k.department_id
 ) select c.id as "companyId",c.legal_name as company,d.id as "departmentId",
  ${labels?sql`d.name`:sql`null::text`} as "departmentCode",
  ${labels?sql`coalesce(nullif(trim(d.label),''),nullif(trim(d.description),''),d.name)`:sql`d.name`} as department,
  null::uuid as "businessUnitId",null::text as "businessUnitCode",null::text as "businessUnit"
 from represented_department_pairs r
 join public.company c on c.id=r.company_id and c.tenant_id=${tenant}::uuid
 join public.department d on d.id=r.department_id and d.tenant_id=${tenant}::uuid
 order by "companyId","departmentId"`;
}
