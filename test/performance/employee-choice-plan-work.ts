import {employeeChoicePlanLimits as nativeLimits,employeeChoicePlanWork as nativeWork} from '../../.github/ci/employee-native-log-codec.mjs';
/** Development rejection envelopes, not runtime acceptance or a query-shape contract. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
export type EmployeeChoiceCardinalities={employment:number;person:number;assignment:number;company:number;department:number;businessUnit:number};
/** Exact counts in the caller's real session. The owner captures the whole owned
 * fictional database; an application session captures independently visible rows. */
export async function employeeChoiceActualCardinalities(tx:Pick<Tx,'execute'>){
 const [row]=await tx.execute<EmployeeChoiceCardinalities>(sql`select
  (select count(*)::int from public.employment) as employment,(select count(*)::int from public.person) as person,
  (select count(*)::int from public.assignment) as assignment,(select count(*)::int from public.company) as company,
  (select count(*)::int from public.department) as department,(select count(*)::int from public.business_unit) as "businessUnit"`);
 if(!row)throw Error('Native fixture cardinalities missing');return row;
}
/** Independent native server-population facts; no browser search/status/facet/page
 * filters and no candidate CTE. Person, Company and Assignment retain their own RLS. */
export async function employeeChoiceAuthorizedPopulationFacts(tx:Tx,tenantId:string,companyIds:readonly string[]){
 const where=sql`e.tenant_id=${tenantId}::uuid and ${companyIds.length?sql`e.company_id=any(${'{'+companyIds.join(',')+'}'}::uuid[])`:sql`true`}`;
 const identity=sql`from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=${tenantId}::uuid
  join public.company c on c.id=e.company_id and c.tenant_id=${tenantId}::uuid`;
 const [population]=await tx.execute<{identities:number;companies:number;departmentPairs:number;unitPairs:number}>(sql`select
  (select count(*)::int ${identity} where ${where}) as identities,
  (select count(distinct e.company_id)::int ${identity} where ${where}) as companies,
  (select count(distinct(e.company_id,a.department_id))::int ${identity} join public.assignment a on a.employment_id=e.id
   and a.tenant_id=${tenantId}::uuid and a.valid_to is null and a.superseded_at is null where ${where} and a.department_id is not null) as "departmentPairs",
  (select count(distinct(e.company_id,a.business_unit_id))::int ${identity} join public.assignment a on a.employment_id=e.id
   and a.tenant_id=${tenantId}::uuid and a.valid_to is null and a.superseded_at is null where ${where} and a.business_unit_id is not null) as "unitPairs"`);
 if(!population)throw Error('Native server population facts missing');
 return{scope:{tenantId,companyIds:[...companyIds]},visibleRelationCounts:await employeeChoiceActualCardinalities(tx),population};
}
export function employeeChoicePlanLimits(counts:EmployeeChoiceCardinalities):{scaleScope:string;scaleRows:number;maxNodeWork:number;maxRootSharedBlocks:number;metric:string}{return nativeLimits(counts);}
export function employeeChoicePlanWork(plan:Record<string,unknown>,counts:EmployeeChoiceCardinalities):{kind:string;limits:ReturnType<typeof employeeChoicePlanLimits>;rootSharedBlocks:number;maximumNodeWork:number;nodes:Record<string,unknown>[];rejectionReasons:string[]}{return nativeWork(plan,counts);}
