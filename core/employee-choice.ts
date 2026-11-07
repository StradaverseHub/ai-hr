import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,person,company,assignment,department,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {organisationFilterChoices} from '../lib/organisation-choice-label';
import {isAdmin} from '../lib/authz-model';
import {EMPLOYEE_CHOICE_PAGE_SIZE,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,type EmployeeChoice,type EmployeeChoiceInput,type EmployeeChoicePage} from '../lib/employee-choice';

export class EmployeeChoiceInputError extends Error{}
export class EmployeeChoiceAccessError extends Error{}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonAscii=(value:SQL)=>sql`${value} ~ '[^ -~]'`;
const from=sql`from ${employment} join ${person} on ${person.id}=${employment.personId}
 join ${company} on ${company.id}=${employment.companyId}
 left join ${assignment} on ${assignment.employmentId}=${employment.id} and ${assignment.validTo} is null and ${assignment.supersededAt} is null
 left join ${department} on ${department.id}=${assignment.departmentId}
 left join ${businessUnit} on ${businessUnit.id}=${assignment.businessUnitId}`;
const normalizeId=(value:string|undefined)=>{
 if(value&&!uuid.test(value))throw new EmployeeChoiceInputError('Invalid employee filter');return value??'';
};
const pattern=(q:string)=>'%'+q.replace(/[\\%_]/g,char=>'\\'+char)+'%';
function columns(labels:boolean){return sql`${employment.id} as "employmentId",${person.fullName} as name,${employment.employeeCode} as "employeeCode",
 ${company.legalName} as company,${employment.companyId} as "companyId",${assignment.departmentId} as "departmentId",
 ${labels?sql`${department.name}`:sql`null::text`} as "departmentCode",${labels?sql`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`:sql`${department.name}`} as department,
 ${assignment.businessUnitId} as "businessUnitId",${labels?sql`${businessUnit.code}`:sql`null::text`} as "businessUnitCode",
 ${labels?sql`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.name}),''),${businessUnit.code})`:sql`${businessUnit.name}`} as "businessUnit",
 case when ${employment.terminatedOn} is null then 'active' else 'ended' end as status`;}

/** Same legacy validTo-NULL population and ordinary table RLS, not the HR-only Workforce picker.
 * companyIds is trusted server scope; an empty list deliberately retains the legacy RLS-only behavior.
 * All SQL, authority, selected lookup and counts share one enforced read-only snapshot. */
export async function readEmployeeChoices(ctx:SessionContext,p:EmployeeChoiceInput&{companyIds:string[]},signal?:AbortSignal):Promise<EmployeeChoicePage>{
 if(!Array.isArray(p.companyIds)||p.companyIds.some(id=>!uuid.test(id)))throw new EmployeeChoiceInputError('Invalid server company scope');
 const filters={query:p.query??'',companyId:normalizeId(p.companyId),businessUnitId:normalizeId(p.businessUnitId),departmentId:normalizeId(p.departmentId),status:p.status??''};
 if(typeof filters.query!=='string'||!['','active','ended'].includes(filters.status)||p.labelMode!==undefined&&!['names','labels'].includes(p.labelMode))throw new EmployeeChoiceInputError('Invalid employee filter');
 const offset=p.offset??0,limit=p.limit??EMPLOYEE_CHOICE_PAGE_SIZE,labelMode=p.labelMode??'names',q=filters.query.trim().toLowerCase();
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>EMPLOYEE_CHOICE_MAX_PAGE_SIZE)throw new EmployeeChoiceInputError('Invalid employee page');
 const scoped=p.companyIds.length?sql`${employment.companyId}=any(${'{'+p.companyIds.join(',')+'}'}::uuid[])`:sql`true`;
 const inCompany=filters.companyId?sql`${employment.companyId}=${filters.companyId}::uuid`:sql`true`;
 const where=sql`${scoped} and ${inCompany}
  and ${filters.businessUnitId?sql`${assignment.businessUnitId}=${filters.businessUnitId}::uuid`:sql`true`}
  and ${filters.departmentId?sql`${assignment.departmentId}=${filters.departmentId}::uuid`:sql`true`}
  and ${filters.status?filters.status==='active'?sql`${employment.terminatedOn} is null`:sql`${employment.terminatedOn} is not null`:sql`true`}`;
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
  if(labelMode==='labels'&&!isAdmin(ctx))throw new EmployeeChoiceAccessError('Employee catalogue labels require current administration access');
  const base=sql`select ${columns(labelMode==='labels')} ${from}`;
  let rows:EmployeeChoice[]=[],total=0;
  if(!q){
   const [count]=await tx.execute<{total:number}>(sql`select count(*)::int as total ${from} where ${where}`);total=count.total;
   rows=await tx.execute<EmployeeChoice>(sql`${base} where ${where} order by ${person.fullName},${employment.id},${assignment.id} limit ${limit} offset ${offset}`);
  }else{
   // PostgreSQL locale lower/ILIKE is not ECMAScript lower/includes. ASCII-only rows
   // admit exact native candidates; every non-ASCII row remains a conservative candidate.
   const unicode=sql`(${nonAscii(sql`${person.fullName}`)} or ${nonAscii(sql`coalesce(${employment.employeeCode},'')`)})`;
   const candidate=q.includes('\0')?sql`false`:/^[\x00-\x7f]*$/.test(q)?sql`(${unicode} or lower(${person.fullName} collate "C") like ${pattern(q)} escape '\\'
     or lower(coalesce(${employment.employeeCode},'') collate "C") like ${pattern(q)} escape '\\')`:unicode;
   await tx.execute(sql`declare employee_choices no scroll cursor for ${base} where ${where} and ${candidate}
    order by ${person.fullName},${employment.id},${assignment.id}`);
   for(;;){
    signal?.throwIfAborted();const batch=await tx.execute<EmployeeChoice>(sql`fetch forward 512 from employee_choices`);
    for(const row of batch)if(row.name.toLowerCase().includes(q)||(row.employeeCode??'').toLowerCase().includes(q)){
     if(total>=offset&&rows.length<limit)rows.push(row);total++;
    }
    if(batch.length<512)break;
   }
   // Transaction completion closes the private cursor, including on error or disconnect.
  }
  signal?.throwIfAborted();
  const selected=p.selectedId&&uuid.test(p.selectedId)?(await tx.execute<EmployeeChoice>(sql`${base} where ${scoped} and ${employment.id}=${p.selectedId}::uuid order by ${person.fullName},${employment.id},${assignment.id} limit 1`))[0]??null:null;
  const options=await readOptions(tx,scoped,labelMode==='labels');
  const inSelectedCompany=filters.companyId?options.filter(row=>row.companyId===filters.companyId):options;
  const companies=new Map(options.map(row=>[row.companyId,row.company]));
  return {contextId:randomUUID(),rows,selected,total,offset,limit,filters,labelMode,
   companyOptions:[...companies].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
   businessUnitOptions:organisationFilterChoices(inSelectedCompany.map(row=>({id:row.businessUnitId,name:row.businessUnit,code:row.businessUnitCode}))),
   departmentOptions:organisationFilterChoices(inSelectedCompany.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))),
   allDepartmentOptions:organisationFilterChoices(options.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))),
  };
 },{readOnlySnapshot:true,readSignal:signal});
}
type ChoiceOptions=Pick<EmployeeChoice,'companyId'|'company'|'departmentId'|'department'|'departmentCode'|'businessUnitId'|'businessUnit'|'businessUnitCode'>;
function readOptions(tx:Tx,scope:SQL,labels:boolean){return tx.execute<ChoiceOptions>(sql`select distinct ${employment.companyId} as "companyId",${company.legalName} as company,
 ${assignment.departmentId} as "departmentId",${labels?sql`${department.name}`:sql`null::text`} as "departmentCode",
 ${labels?sql`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`:sql`${department.name}`} as department,
 ${assignment.businessUnitId} as "businessUnitId",${labels?sql`${businessUnit.code}`:sql`null::text`} as "businessUnitCode",
 ${labels?sql`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.name}),''),${businessUnit.code})`:sql`${businessUnit.name}`} as "businessUnit"
 ${from} where ${scope} order by "companyId","departmentId","businessUnitId"`);}
