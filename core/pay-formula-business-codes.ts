/** Code-only sources use System Labels' canonical Code columns, never display labels or IDs. */
import {sql,type SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {businessUnit,department,position} from '../db/schema';
import {visibleLabelIdsCondition} from './system-labels';
import {movementReportFactsTx} from './movement';

export const FORMULA_CODE_PAGE_SIZE=50;
const sources=[
 {key:'departmentBusinessCode',table:department,kind:'department',code:sql`${department.name}`,label:sql`${department.label}`,column:'department_id'},
 {key:'positionBusinessCode',table:position,kind:'position',code:sql`${position.title}`,label:sql`${position.label}`,column:'position_id'},
 {key:'businessUnitCode',table:businessUnit,kind:'business_unit',code:sql`${businessUnit.code}`,label:sql`${businessUnit.label}`,column:'business_unit_id'},
] as const;
export const isPersonnelBusinessCode=(key:string)=>sources.some(source=>source.key===key)||key==='jobGradeCode'||key==='companyCode';

/** SQL pagination/count and distinct literal semantics are identical for All companies and one company.
 * Duplicate configured codes are one comparison literal; display descriptions never become the value. */
export async function personnelBusinessCodeChoicesTx(tx:Tx,ctx:SessionContext,companyIds:string[],key:string,search='',offset=0){
 if(!companyIds.length)return {items:[] as {value:string;label:string}[],total:0};
 let source:SQL;
 if(key==='companyCode')source=sql`select c.company_label as value,c.legal_name as label from company c where c.tenant_id=${ctx.tenantId}::uuid and c.id=any(${companyIds}::uuid[]) and c.archived_at is null`;
 else if(key==='jobGradeCode')source=sql`select g.code as value,g.name as label from job_grade g where g.tenant_id=${ctx.tenantId}::uuid and g.archived_at is null and exists(select 1 from unnest(${companyIds}::uuid[]) c(id) where app.system_label_scope_applies(g.scope_company_ids,c.id))`;
 else{
  const picked=sources.find(source=>source.key===key);if(!picked)return {items:[],total:0};
  source=sql`select ${picked.code} as value,${picked.label} as label from ${picked.table} where ${picked.table.tenantId}=${ctx.tenantId}::uuid and ${picked.table.archivedAt} is null and ${visibleLabelIdsCondition(picked.table,picked.kind,companyIds)}`;
 }
 const [row]=await tx.execute<{items:{value:string;label:string}[];total:number}>(sql`
  with source as (${source}),codes as (
   select value,string_agg(distinct nullif(label,''),' / ' order by nullif(label,'')) as description
   from source where nullif(btrim(value),'') is not null group by value
  ),filtered as(select value,value||coalesce(' · '||description,'') as label from codes
   where position(lower(${search.trim().slice(0,100)}) in lower(value||' '||coalesce(description,'')))>0),
  page as(select * from filtered order by value collate "C" limit ${FORMULA_CODE_PAGE_SIZE} offset ${Math.max(0,Math.min(1000000,Math.floor(offset)||0))})
  select coalesce((select jsonb_agg(to_jsonb(page) order by value collate "C") from page),'[]'::jsonb) as items,
   (select count(*)::integer from filtered) as total`);
 return row??{items:[],total:0};
}

/** The caller already holds exact employee/field/company authority. The Movement owner alone
 * adjudicates dated grades, reversals, corrected hires and unknown historical evidence. */
export async function personnelBusinessGradeAtTx(tx:Tx,tenantId:string,employmentId:string,asOf:string){
 const facts=await movementReportFactsTx(tx,tenantId,[employmentId],[asOf]);
 const placement=facts[0]?.placements.find(placement=>placement.date===asOf);
 return placement?.gradeKnown?placement.gradeId:null;
}

export async function personnelBusinessCodeValueTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;companyId:string;asOf:string;key:string}){
 if(input.key==='jobGradeCode'){
  const gradeId=await personnelBusinessGradeAtTx(tx,ctx.tenantId,input.employmentId,input.asOf);
  const [row]=await tx.execute<{id:string;value:string}>(sql`select id,code as value from job_grade where tenant_id=${ctx.tenantId}::uuid and id=${gradeId}::uuid and archived_at is null and app.system_label_scope_applies(scope_company_ids,${input.companyId}::uuid)`);
  return row;
 }
 const source=sources.find(source=>source.key===input.key);if(!source)return undefined;
 // Legacy nullable-company assignments are constrained by the effective company already adjudicated
 // by the runtime; a non-null version company must match that same context.
 const rows=await tx.execute<{id:string;value:string}>(sql`select a.id,${source.code} as value from assignment a
  join ${source.table} on ${source.table.id}=a.${sql.identifier(source.column)} and ${source.table.tenantId}=a.tenant_id
  where a.tenant_id=${ctx.tenantId}::uuid and a.employment_id=${input.employmentId}::uuid
   and (a.company_id is null or a.company_id=${input.companyId}::uuid)
   and a.valid_from<=${input.asOf}::date and (a.valid_to is null or a.valid_to>${input.asOf}::date) and a.superseded_at is null
   and ${source.table.archivedAt} is null and ${visibleLabelIdsCondition(source.table,source.kind,[input.companyId])}`);
 return rows.length===1?rows[0]:undefined;
}
