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
const removedFields=['Rows Removed by Filter','Rows Removed by Join Filter','Rows Removed by Index Recheck','Rows Removed by Conflict Filter']as const;
const keys=['employment','person','assignment','company','department','businessUnit']as const;
export function employeeChoicePlanLimits(counts:EmployeeChoiceCardinalities){
 if(keys.some(key=>!Number.isSafeInteger(counts[key])||counts[key]<0))throw Error('Invalid exact native cardinalities');
 const scaleRows=Math.max(1,...keys.map(key=>counts[key]));
 // Linear below the retained50k benchmark scale, capped at its original work/buffer
 // ceilings. A larger future fixture requires review, never an automatic larger budget.
 return{scaleScope:'largest exact whole-owned-fixture base relation, all fixture tenants; not reltuples or authorized output count',scaleRows,
  maxNodeWork:Math.min(1_600_000,32*scaleRows),maxRootSharedBlocks:Math.min(150_000,Math.max(4096,3*scaleRows)),
  metric:'Actual Loops * (Actual Rows + four Rows Removed counters); PostgreSQL per-loop averages may be rounded'};
}
export function employeeChoicePlanWork(plan:Record<string,unknown>,counts:EmployeeChoiceCardinalities){
 const limits=employeeChoicePlanLimits(counts),nodes:Record<string,unknown>[]=[],rejectionReasons:string[]=[];
 const counter=(node:Record<string,unknown>,key:string,required=false)=>{
  const value=node[key]??(required?NaN:0);if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('Invalid actual plan counter: '+key);return value;
 };
 const visit=(node:Record<string,unknown>,path:string)=>{
  const loops=counter(node,'Actual Loops',true),rows=counter(node,'Actual Rows',true),removed=Object.fromEntries(removedFields.map(key=>[key,counter(node,key)]));
  const work=loops*(rows+Object.values(removed).reduce((sum,value)=>sum+value,0));
  if(!Number.isFinite(work)||work>limits.maxNodeWork)rejectionReasons.push(path+':node-work');
  nodes.push({path,nodeType:node['Node Type'],relation:node['Relation Name']??null,index:node['Index Name']??null,cte:node['CTE Name']??null,loops,rows,removed,work});
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Invalid actual plan children');
  for(const [index,child]of ((node.Plans??[])as Record<string,unknown>[]).entries())visit(child,path+'.'+index);
 };
 visit(plan,'root');
 const rootSharedBlocks=counter(plan,'Shared Hit Blocks',true)+counter(plan,'Shared Read Blocks',true);
 if(rootSharedBlocks>limits.maxRootSharedBlocks)rejectionReasons.push('root:shared-blocks');
 return{kind:'DEVELOPMENT_COMPLEXITY_REJECTION_ONLY',limits,rootSharedBlocks,nodes,rejectionReasons};
}
