import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,person,company,assignment,department,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {organisationFilterChoices} from '../lib/organisation-choice-label';
import {isAdmin} from '../lib/authz-model';
import {isCalendarDate} from '../lib/calendar-date';
import {ALL_ROW_CEILING} from '../lib/pagination';
import {EMPLOYEE_CHOICE_PAGE_SIZE,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,type EmployeeChoice,type EmployeeChoiceInput,type EmployeeChoicePage} from '../lib/employee-choice';

export class EmployeeChoiceInputError extends Error{}
export class EmployeeChoiceAccessError extends Error{}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonAscii=(value:SQL)=>sql`(${value} collate "C") ~ '[^ -~]'`;
function employeeIdentityFrom(tenantId:string){return sql`from ${employment}
 join ${person} on ${person.id}=${employment.personId} and ${person.tenantId}=${tenantId}::uuid
 join ${company} on ${company.id}=${employment.companyId} and ${company.tenantId}=${tenantId}::uuid`;}
/** Positive native Assignment membership is computed independently of each
 * Employment identity. IS TRUE keeps this as a membership subplan rather than
 * flattening an RLS-underestimated relation into a quadratic population join.
 * The immediate assignment_no_overlap constraint permits at most one matching
 * unsuperseded NULL-ended assignment, so identity membership preserves counts.
 * Current Employment company remains the scope owner; historical Assignment
 * company and valid_from must not narrow this existing navigation relation. */
function organisationMembership(tenantId:string,filters:{departmentId:string;businessUnitId:string}){
 if(!filters.departmentId&&!filters.businessUnitId)return sql`true`;
 return sql`(${employment.id} in(select ${assignment.employmentId} from ${assignment}
  where ${assignment.tenantId}=${tenantId}::uuid and ${assignment.validTo} is null and ${assignment.supersededAt} is null
   and ${filters.departmentId?sql`${assignment.departmentId}=${filters.departmentId}::uuid`:sql`true`}
   and ${filters.businessUnitId?sql`${assignment.businessUnitId}=${filters.businessUnitId}::uuid`:sql`true`})) is true`;
}
const normalizeId=(value:string|undefined)=>{
 if(value&&!uuid.test(value))throw new EmployeeChoiceInputError('Invalid employee filter');return value??'';
};
const pattern=(q:string)=>'%'+q.replace(/[\\%_]/g,char=>'\\'+char)+'%';
/** Server-owned narrowing, never a client grant. Empty company scope retains legacy
 * RLS-only semantics; an explicit empty employmentIds population means no employees. */
export type EmployeeChoicePopulation={companyIds:readonly string[];terminatedAfter?:string;employmentIds?:readonly string[]};
export type EmployeeChoiceServerInput=EmployeeChoiceInput&EmployeeChoicePopulation;
export type EmployeeChoicePopulationFilters=Omit<EmployeeChoiceServerInput,'offset'|'limit'|'selectedId'|'labelMode'>;
const captureContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
function captureInput(p:EmployeeChoiceServerInput):EmployeeChoiceServerInput{
 if(!Array.isArray(p.companyIds)||p.companyIds.some(id=>!uuid.test(id)))throw new EmployeeChoiceInputError('Invalid server company scope');
 if(p.employmentIds!==undefined&&(!Array.isArray(p.employmentIds)||p.employmentIds.some(id=>!uuid.test(id))))throw new EmployeeChoiceInputError('Invalid server employee population');
 return {...p,companyIds:p.companyIds.slice(),employmentIds:p.employmentIds?.slice()};
}
function prepareChoices(ctx:SessionContext,p:EmployeeChoiceServerInput,maximumPageSize:number){
 if(!Array.isArray(p.companyIds)||p.companyIds.some(id=>!uuid.test(id)))throw new EmployeeChoiceInputError('Invalid server company scope');
 const filters={query:p.query??'',companyId:normalizeId(p.companyId),businessUnitId:normalizeId(p.businessUnitId),departmentId:normalizeId(p.departmentId),status:p.status??''};
 if(typeof filters.query!=='string'||!['','active','ended'].includes(filters.status)||p.labelMode!==undefined&&!['names','labels'].includes(p.labelMode))throw new EmployeeChoiceInputError('Invalid employee filter');
 const offset=p.offset??0,limit=p.limit??EMPLOYEE_CHOICE_PAGE_SIZE,labelMode=p.labelMode??'names',q=filters.query.trim().toLowerCase();
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>maximumPageSize)throw new EmployeeChoiceInputError('Invalid employee page');
 const scoped=sql`${employment.tenantId}=${ctx.tenantId}::uuid and ${p.companyIds.length?sql`${employment.companyId}=any(${'{'+p.companyIds.join(',')+'}'}::uuid[])`:sql`true`}`;
 if(p.terminatedAfter!==undefined&&!isCalendarDate(p.terminatedAfter))throw new EmployeeChoiceInputError('Invalid population date');
 if(p.employmentIds!==undefined&&(!Array.isArray(p.employmentIds)||p.employmentIds.some(id=>!uuid.test(id))))throw new EmployeeChoiceInputError('Invalid server employee population');
 let populationScope=scoped;
 if(p.terminatedAfter!==undefined)populationScope=sql`${populationScope} and (${employment.terminatedOn} is null or ${employment.terminatedOn}>${p.terminatedAfter}::date)`;
 if(p.employmentIds!==undefined)populationScope=sql`${populationScope} and ${p.employmentIds.length?sql`${employment.id}=any(${'{'+p.employmentIds.join(',')+'}'}::uuid[])`:sql`false`}`;
 const inCompany=filters.companyId?sql`${employment.companyId}=${filters.companyId}::uuid`:sql`true`;
 const where=sql`${populationScope} and ${inCompany}
  and ${organisationMembership(ctx.tenantId,filters)}
  and ${filters.status?filters.status==='active'?sql`${employment.terminatedOn} is null`:sql`${employment.terminatedOn} is not null`:sql`true`}`;
 return {filters,offset,limit,labelMode,q,scoped:populationScope,where};
}
/** General navigation owns its snapshot and keeps the public transport's 200-row cap. */
export async function readEmployeeChoices(ctx:SessionContext,p:EmployeeChoiceInput&{companyIds:string[]},signal?:AbortSignal):Promise<EmployeeChoicePage>{
 if('terminatedAfter' in p||'employmentIds' in p)throw new EmployeeChoiceInputError('Server population requires an explicit presentation transaction');
 const captured=captureContext(ctx),input=captureInput(p);
 return withTenant(captured,tx=>readChoicePageTx(tx,captured,input,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,signal),{readOnlySnapshot:true,readSignal:signal});
}
/** Borrow only an actual enforced RR/READ ONLY human presentation transaction.
 * The module still admits its own purpose. Its transport must derive population afresh.
 * One coherent native boundary and one bounded page support the shared All ceiling.
 * Await every started reader before the borrowing owner ends its transaction. */
export async function readEmployeeChoicesTx(tx:Tx,ctx:SessionContext,p:EmployeeChoiceServerInput,signal?:AbortSignal):Promise<EmployeeChoicePage>{
 return readChoicePageTx(tx,captureContext(ctx),captureInput(p),ALL_ROW_CEILING,signal);
}
async function readChoicePageTx(tx:Tx,ctx:SessionContext,p:EmployeeChoiceServerInput,maximumPageSize:number,signal?:AbortSignal):Promise<EmployeeChoicePage>{
 const prepared=prepareChoices(ctx,p,maximumPageSize),{filters,offset,limit,labelMode,q}=prepared;
 signal?.throwIfAborted();await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
 if(labelMode==='labels'&&!isAdmin(ctx))throw new EmployeeChoiceAccessError('Employee catalogue labels require current administration access');
 const {rows,selected,total,options}=await readChoiceBoundary(tx,ctx.tenantId,prepared.scoped,{filters,offset,limit,labelMode,q,selectedId:p.selectedId},signal);
 const inSelectedCompany=filters.companyId?options.filter(row=>row.companyId===filters.companyId):options;
 const companies=new Map(options.map(row=>[row.companyId,row.company]));
 return {contextId:randomUUID(),rows,selected,total,offset,limit,filters,labelMode,
  companyOptions:[...companies].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
  businessUnitOptions:organisationFilterChoices(inSelectedCompany.map(row=>({id:row.businessUnitId,name:row.businessUnit,code:row.businessUnitCode}))),
  departmentOptions:organisationFilterChoices(inSelectedCompany.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))),
  allDepartmentOptions:organisationFilterChoices(options.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))),
 };
}
/** Complete identification facts, not command authority. The command owner must
 * independently reauthorize submitted subjects at its current write admission.
 * This read-only helper never clips to a page and retains only IDs, not whole DTOs. */
export async function readEmployeeChoiceIdsTx(tx:Tx,ctx:SessionContext,p:EmployeeChoicePopulationFilters,signal?:AbortSignal):Promise<string[]>{
 ctx=captureContext(ctx);const input=captureInput(p);
 const {q,where}=prepareChoices(ctx,{...input,offset:0,limit:1,labelMode:'names'},EMPLOYEE_CHOICE_MAX_PAGE_SIZE);
 signal?.throwIfAborted();await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
 const ids:string[]=[];
 await visitEmployeeChoiceMatches(tx,sql`select ${employment.id} as "employmentId",${person.fullName} as name,${employment.employeeCode} as "employeeCode"
  ${employeeIdentityFrom(ctx.tenantId)} where ${where} and ${q?choiceCandidate(q):sql`true`}
  order by ${person.fullName},${employment.id}`,q,row=>{ids.push(row.employmentId);},signal);
 return ids;
}

function choiceCandidate(q:string,fields={name:sql`${person.fullName}`,employeeCode:sql`${employment.employeeCode}`}){
 const unicode=sql`(${nonAscii(fields.name)} or ${nonAscii(sql`coalesce(${fields.employeeCode},'')`)})`;
 return q.includes('\0')?sql`false`:/^[\x00-\x7f]*$/.test(q)?sql`(${unicode} or lower(${fields.name} collate "C") like ${pattern(q)} escape '\\'
     or lower(coalesce(${fields.employeeCode},'') collate "C") like ${pattern(q)} escape '\\')`:unicode;
}
type ChoiceIdentity=Pick<EmployeeChoice,'employmentId'|'name'|'employeeCode'>;
async function visitEmployeeChoiceMatches(tx:Tx,query:SQL,q:string,receive:(row:ChoiceIdentity,index:number)=>void,signal?:AbortSignal){
 let total=0;const cursor=sql.identifier('employee_choices_'+randomUUID().replace(/-/g,''));
 await tx.execute(sql`declare ${cursor} no scroll cursor for ${query}`);
 for(;;){
  signal?.throwIfAborted();const batch=await tx.execute<ChoiceIdentity>(sql`fetch forward 512 from ${cursor}`);signal?.throwIfAborted();
  for(const row of batch)if(row.name.toLowerCase().includes(q)||(row.employeeCode??'').toLowerCase().includes(q)){
   receive(row,total);total++;
  }
  if(batch.length<512)break;
 }
 signal?.throwIfAborted();await tx.execute(sql`close ${cursor}`);signal?.throwIfAborted();
 // Rollback/transaction completion also closes it on failure or disconnect.
 return total;
}
type ChoiceOptions=Pick<EmployeeChoice,'companyId'|'company'|'departmentId'|'department'|'departmentCode'|'businessUnitId'|'businessUnit'|'businessUnitCode'>;
type BoundaryKind='count'|'company'|'department'|'unit'|'selected'|'candidate';
type BoundaryIdentity=Pick<EmployeeChoice,'employmentId'|'name'|'employeeCode'|'companyId'|'departmentId'|'businessUnitId'|'status'>;
type BoundaryRow={phase:number;kind:BoundaryKind;employmentId:string|null;name:string|null;employeeCode:string|null;companyId:string|null;
 departmentId:string|null;businessUnitId:string|null;status:'active'|'ended'|null;label:string|null;code:string|null;total:number|null};
type BoundaryFields=Partial<Record<Exclude<keyof BoundaryRow,'phase'|'kind'>,SQL>>;
const field=(alias:string,name:string)=>sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
function boundaryOutput(phase:number,kind:BoundaryKind,fields:BoundaryFields){
 return sql`select ${phase}::int as phase,${kind}::text as kind,
  ${fields.employmentId??sql`null::uuid`} as "employmentId",${fields.name??sql`null::text`} as name,
  ${fields.employeeCode??sql`null::text`} as "employeeCode",${fields.companyId??sql`null::uuid`} as "companyId",
  ${fields.departmentId??sql`null::uuid`} as "departmentId",${fields.businessUnitId??sql`null::uuid`} as "businessUnitId",
  ${fields.status??sql`null::text`} as status,${fields.label??sql`null::text`} as label,
  ${fields.code??sql`null::text`} as code,${fields.total??sql`null::int`} as total`;
}
function identityFields(alias:string):BoundaryFields{return {
 employmentId:field(alias,'employmentId'),name:field(alias,'name'),employeeCode:field(alias,'employeeCode'),
 companyId:field(alias,'companyId'),departmentId:field(alias,'departmentId'),businessUnitId:field(alias,'businessUnitId'),status:field(alias,'status'),
};}
function boundaryIdentity(row:BoundaryRow):BoundaryIdentity{
 if(!row.employmentId||row.name===null||!row.companyId||row.status!=='active'&&row.status!=='ended')throw Error('Invalid native employee identity');
 return {employmentId:row.employmentId,name:row.name,employeeCode:row.employeeCode,companyId:row.companyId,departmentId:row.departmentId,businessUnitId:row.businessUnitId,status:row.status};
}
/** One statement owns the authorized population, independent selection and full
 * represented catalogues. Each base relation retains its native RLS. Positive
 * membership narrows Person/Assignment without flattening authorization into a
 * correlated probe. MATERIALIZED is reuse, not a complexity guarantee: hosted
 * dense/sparse actual plans must also bound every base/CTE scan and buffer cost.
 * Current Employment company owns scope; historical Assignment company and a
 * future valid_from never narrow this legacy open, unsuperseded relationship. */
async function readChoiceBoundary(tx:Tx,tenantId:string,scope:SQL,p:Pick<ReturnType<typeof prepareChoices>,'filters'|'offset'|'limit'|'labelMode'|'q'>&{selectedId?:string},signal?:AbortSignal){
 const {filters,offset,limit,labelMode,q}=p,labels=labelMode==='labels';
 const population='employee_choice_population',matching='employee_choice_matching',result='employee_choice_result';
 const where=sql`${filters.companyId?sql`${field(population,'companyId')}=${filters.companyId}::uuid`:sql`true`}
  and ${filters.departmentId?sql`${field(population,'departmentId')}=${filters.departmentId}::uuid`:sql`true`}
  and ${filters.businessUnitId?sql`${field(population,'businessUnitId')}=${filters.businessUnitId}::uuid`:sql`true`}
  and ${filters.status?sql`${field(population,'status')}=${filters.status}`:sql`true`}`;
 const candidate=choiceCandidate(q,{name:field(matching,'name'),employeeCode:field(matching,'employeeCode')});
 const page=q?sql`select * from employee_choice_matching where ${candidate}`
  :sql`select * from employee_choice_matching order by name,"employmentId" limit ${limit} offset ${offset}`;
 const query=sql`with
 employee_choice_employments as materialized(
  select ${employment.id} as "employmentId",${employment.personId} as "personId",${employment.companyId} as "companyId",${employment.employeeCode} as "employeeCode",
   case when ${employment.terminatedOn} is null then 'active' else 'ended' end as status
  from ${employment} where ${scope}
 ),
 employee_choice_people as materialized(
  select ${person.id} as "personId",${person.fullName} as name from ${person}
  where ${person.tenantId}=${tenantId}::uuid and (${person.id} in(select "personId" from employee_choice_employments)) is true
 ),
 employee_choice_assignments as materialized(
  select ${assignment.employmentId} as "employmentId",${assignment.departmentId} as "departmentId",${assignment.businessUnitId} as "businessUnitId"
  from ${assignment} where ${assignment.tenantId}=${tenantId}::uuid and ${assignment.validTo} is null and ${assignment.supersededAt} is null
   and (${assignment.employmentId} in(select "employmentId" from employee_choice_employments)) is true
 ),
 employee_choice_companies as materialized(
  select ${company.id} as "companyId",${company.legalName} as company from ${company}
  where ${company.tenantId}=${tenantId}::uuid and (${company.id} in(select "companyId" from employee_choice_employments)) is true
 ),
 employee_choice_population as materialized(
  select e."employmentId",p.name,e."employeeCode",e."companyId",c.company,a."departmentId",a."businessUnitId",e.status
  from employee_choice_employments e join employee_choice_people p on p."personId"=e."personId"
   join employee_choice_companies c on c."companyId"=e."companyId"
   left join employee_choice_assignments a on a."employmentId"=e."employmentId"
 ),
 employee_choice_organisation as materialized(
  select distinct "companyId","departmentId","businessUnitId" from employee_choice_population
 ),
 employee_choice_matching as materialized(select * from employee_choice_population where ${where})
 select * from (
  ${boundaryOutput(0,'count',{total:q?sql`null::int`:sql`(select count(*)::int from employee_choice_matching)`})}
  union all
  ${boundaryOutput(1,'company',{companyId:field('c','companyId'),label:sql`c.company`})}
   from (select distinct "companyId",company from employee_choice_population) c
  union all
  select distinct 2::int as phase,${'department'}::text as kind,null::uuid as "employmentId",null::text as name,null::text as "employeeCode",
   o."companyId",${department.id} as "departmentId",null::uuid as "businessUnitId",null::text as status,
   ${labels?sql`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`:sql`${department.name}`} as label,
   ${labels?sql`${department.name}`:sql`null::text`} as code,null::int as total
  from employee_choice_organisation o join ${department} on ${department.id}=o."departmentId" and ${department.tenantId}=${tenantId}::uuid
  union all
  select distinct 3::int as phase,${'unit'}::text as kind,null::uuid as "employmentId",null::text as name,null::text as "employeeCode",
   o."companyId",null::uuid as "departmentId",${businessUnit.id} as "businessUnitId",null::text as status,
   ${labels?sql`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.name}),''),${businessUnit.code})`:sql`${businessUnit.name}`} as label,
   ${labels?sql`${businessUnit.code}`:sql`null::text`} as code,null::int as total
  from employee_choice_organisation o join ${businessUnit} on ${businessUnit.id}=o."businessUnitId" and ${businessUnit.tenantId}=${tenantId}::uuid
  union all
  ${boundaryOutput(4,'selected',identityFields(population))} from employee_choice_population
   where ${p.selectedId&&uuid.test(p.selectedId)?sql`"employmentId"=${p.selectedId}::uuid`:sql`false`}
  union all
  ${boundaryOutput(5,'candidate',identityFields(result))} from (${page}) employee_choice_result
 ) employee_choice_stream order by phase,
  case when phase between 1 and 3 then "companyId" end,
  case when phase=2 then "departmentId" end,case when phase=3 then "businessUnitId" end,name,"employmentId"`;
 const raw:BoundaryIdentity[]=[],options:ChoiceOptions[]=[],companies=new Map<string,string>();
 const departments=new Map<string,{name:string|null;code:string|null}>(),units=new Map<string,{name:string|null;code:string|null}>();
 let selectedRaw:BoundaryIdentity|null=null,total=0;
 const receive=(row:BoundaryRow)=>{
  if(row.kind==='count'){if(!q){if(row.total===null||!Number.isSafeInteger(row.total)||row.total<0)throw Error('Invalid native employee count');total=row.total;}return;}
  if(row.kind==='candidate'){
   const identity=boundaryIdentity(row);
   if(!q){raw.push(identity);return;}
   // SQL only excludes impossible ASCII candidates. Exact matching remains the
   // original ECMAScript lower/includes, including combining marks and literals.
   if(identity.name.toLowerCase().includes(q)||(identity.employeeCode??'').toLowerCase().includes(q)){
    if(total>=offset&&raw.length<limit)raw.push(identity);total++;
   }
   return;
  }
  if(row.kind==='selected'){selectedRaw=boundaryIdentity(row);return;}
  if(!row.companyId)throw Error('Invalid native employee catalogue');
  if(row.kind==='company'){
   if(row.label===null)throw Error('Invalid native employee company');companies.set(row.companyId,row.label);
   options.push({companyId:row.companyId,company:row.label,departmentId:null,department:null,departmentCode:null,businessUnitId:null,businessUnit:null,businessUnitCode:null});return;
  }
  const companyName=companies.get(row.companyId);if(companyName===undefined)throw Error('Missing native employee company');
  if(row.kind==='department'&&row.departmentId){
   departments.set(row.departmentId,{name:row.label,code:row.code});
   options.push({companyId:row.companyId,company:companyName,departmentId:row.departmentId,department:row.label,departmentCode:row.code,businessUnitId:null,businessUnit:null,businessUnitCode:null});
  }else if(row.kind==='unit'&&row.businessUnitId){
   units.set(row.businessUnitId,{name:row.label,code:row.code});
   options.push({companyId:row.companyId,company:companyName,departmentId:null,department:null,departmentCode:null,businessUnitId:row.businessUnitId,businessUnit:row.label,businessUnitCode:row.code});
  }else throw Error('Invalid native employee organisation');
 };
 signal?.throwIfAborted();
 if(!q){const rows=await tx.execute<BoundaryRow>(query);signal?.throwIfAborted();for(const row of rows)receive(row);}
 else{
  const cursor=sql.identifier('employee_choices_'+randomUUID().replace(/-/g,''));
  await tx.execute(sql`declare ${cursor} no scroll cursor for ${query}`);signal?.throwIfAborted();
  for(;;){
   signal?.throwIfAborted();const batch=await tx.execute<BoundaryRow>(sql`fetch forward 512 from ${cursor}`);signal?.throwIfAborted();
   for(const row of batch)receive(row);if(batch.length<512)break;
  }
  signal?.throwIfAborted();await tx.execute(sql`close ${cursor}`);signal?.throwIfAborted();
  // Disconnect/error rollback closes the portal; never issue cleanup SQL after abort.
 }
 const project=(identity:BoundaryIdentity):EmployeeChoice=>{
  const companyName=companies.get(identity.companyId);if(companyName===undefined)throw Error('Missing native employee company');
  const d=identity.departmentId?departments.get(identity.departmentId):undefined,u=identity.businessUnitId?units.get(identity.businessUnitId):undefined;
  // Assignment identifiers remain visible even when the native label relation
  // denies the joined label, exactly like the original left joins.
  return {...identity,company:companyName,department:d?.name??null,departmentCode:d?.code??null,businessUnit:u?.name??null,businessUnitCode:u?.code??null};
 };
 return {rows:raw.map(project),selected:selectedRaw===null?null:project(selectedRaw),total,options};
}
