/** Test-only first-witness reference for the native sparse Department comparison. */
import {sql} from 'drizzle-orm';
import type {readEmployeeChoicesTx} from '../../core/employee-choice';
import {assignment,company,department,employment,person} from '../../db/schema';

type Scope=Pick<Parameters<typeof readEmployeeChoicesTx>[2],'companyIds'|'employmentIds'|'terminatedAfter'|'labelMode'>;
const uuidArray=(ids:readonly string[])=>'{'+ids.join(',')+'}';
export const isDepartmentFacet=(text:string)=>text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "department"');

export function departmentFacetBinds(tenant:string,input:Scope){
 return [tenant,tenant,tenant,tenant,tenant,...(input.companyIds.length?[uuidArray(input.companyIds)]:[]),
  ...(input.terminatedAfter===undefined?[]:[input.terminatedAfter]),...(input.employmentIds?.length?[uuidArray(input.employmentIds)]:[])];
}

export const isSparseDepartmentFacet=(text:string)=>text.startsWith('with authorized_members as materialized (')&&
 text.includes('), represented_department_pairs as materialized (')&&text.includes('join lateral (');

export function sparseDepartmentFacetBinds(tenant:string,input:Scope){
 return [tenant,tenant,...departmentFacetBinds(tenant,input).slice(5),tenant,tenant,tenant];
}

/** Exact a293 first-witness statement and captured server-scope layout. */
export function firstWitnessDepartmentFacet(tenantId:string,input:Scope){
 const {companyIds,employmentIds,terminatedAfter,labelMode}=input,labels=labelMode==='labels';
 let scope=sql`${employment.tenantId}=${tenantId}::uuid and ${companyIds.length?sql`${employment.companyId}=any(${uuidArray(companyIds)}::uuid[])`:sql`true`}`;
 if(terminatedAfter!==undefined)scope=sql`${scope} and (${employment.terminatedOn} is null or ${employment.terminatedOn}>${terminatedAfter}::date)`;
 if(employmentIds!==undefined)scope=sql`${scope} and ${employmentIds.length?sql`${employment.id}=any(${uuidArray(employmentIds)}::uuid[])`:sql`false`}`;
 return sql`select ${company.id} as "companyId",${company.legalName} as company,${department.id} as "departmentId",${labels?sql`${department.name}`:sql`null::text`} as "departmentCode",
  ${labels?sql`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`:sql`${department.name}`} as department,
  null::uuid as "businessUnitId",null::text as "businessUnitCode",null::text as "businessUnit"
 from ${company} cross join ${department}
 where ${company.tenantId}=${tenantId}::uuid and ${department.tenantId}=${tenantId}::uuid
  and exists(select 1 from ${assignment}
   where ${assignment.tenantId}=${tenantId}::uuid and ${assignment.validTo} is null
    and ${assignment.supersededAt} is null and ${assignment.departmentId}=${department.id}
    and exists(select 1 from ${employment} join ${person}
     on ${person.id}=${employment.personId} and ${person.tenantId}=${tenantId}::uuid
     where ${employment.id}=${assignment.employmentId} and ${scope} and ${employment.companyId}=${company.id}
     offset 0)
   offset 0) order by "companyId","departmentId"`;
}
