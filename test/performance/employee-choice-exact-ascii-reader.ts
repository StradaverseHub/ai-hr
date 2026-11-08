/** UNINSTALLED exact-ASCII prototype. All unsupported modes use the unchanged legacy reader. */
import {randomUUID} from 'node:crypto';
import * as legacy from './employee-choice-native-purpose-reader';
import {exactAsciiPrototypeRuntime} from './employee-choice-exact-ascii-runtime';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {assertAiPresentationPrincipalTx} from '../../core/ai-principal';
import {isAdmin} from '../../lib/authz-model';
import {isCalendarDate} from '../../lib/calendar-date';
import {organisationFilterChoices} from '../../lib/organisation-choice-label';
import {ALL_ROW_CEILING} from '../../lib/pagination';
import {EMPLOYEE_CHOICE_PAGE_SIZE,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,type EmployeeChoice,type EmployeeChoiceInput,type EmployeeChoicePage,type EmployeeChoiceFilters} from '../../lib/employee-choice';
import type {EmployeeChoicePopulationFilters,EmployeeChoiceServerInput} from '../../core/employee-choice';

export const {EmployeeChoiceInputError,EmployeeChoiceAccessError}=legacy;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const captureContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const normalizeId=(value:string|undefined)=>{if(value&&!uuid.test(value))throw new EmployeeChoiceInputError('Invalid employee filter');return value??'';};
function captureInput(p:EmployeeChoiceServerInput):EmployeeChoiceServerInput{
 if(!Array.isArray(p.companyIds)||p.companyIds.some(id=>!uuid.test(id)))throw new EmployeeChoiceInputError('Invalid server company scope');
 if(p.employmentIds!==undefined&&(!Array.isArray(p.employmentIds)||p.employmentIds.some(id=>!uuid.test(id))))throw new EmployeeChoiceInputError('Invalid server employee population');
 return {...p,companyIds:p.companyIds.slice(),employmentIds:p.employmentIds?.slice()};
}
type Prepared={filters:EmployeeChoiceFilters;offset:number;limit:number;labelMode:'names'|'labels';q:string};
function prepare(p:EmployeeChoiceServerInput,maximum:number):Prepared{
 const filters={query:p.query??'',companyId:normalizeId(p.companyId),businessUnitId:normalizeId(p.businessUnitId),departmentId:normalizeId(p.departmentId),status:p.status??''};
 if(typeof filters.query!=='string'||!['','active','ended'].includes(filters.status)||p.labelMode!==undefined&&!['names','labels'].includes(p.labelMode))throw new EmployeeChoiceInputError('Invalid employee filter');
 const offset=p.offset??0,limit=p.limit??EMPLOYEE_CHOICE_PAGE_SIZE,labelMode=p.labelMode??'names',q=filters.query.trim().toLowerCase();
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>maximum)throw new EmployeeChoiceInputError('Invalid employee page');
 if(p.terminatedAfter!==undefined&&!isCalendarDate(p.terminatedAfter))throw new EmployeeChoiceInputError('Invalid population date');
 return {filters,offset,limit,labelMode,q};
}
const uuidArray=(values:readonly string[]|undefined)=>values===undefined?null:'{'+values.join(',')+'}';
const textArray=(values:readonly string[])=>'{'+values.map(value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',')+'}';
function exactAsciiQuery(ctx:SessionContext,p:EmployeeChoiceServerInput,prepared:Prepared,port:'page'|'ids'){
 const {filters,offset,limit,labelMode,q}=prepared;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})),roles=ctx.roles??Array.from(new Set(grants.map(grant=>grant.role)));
 const marker=port==='page'?sql`/* employee-choice-native:page */`:sql`/* employee-choice-native:ids */`;
 const source=sql`${marker} app.employee_choice_native_prototype(${ctx.tenantId}::uuid,${ctx.userId??null}::uuid,${ctx.personId??null}::uuid,
  ${textArray(roles)}::text[],${JSON.stringify(grants)}::jsonb,${uuidArray(p.companyIds)}::uuid[],${p.terminatedAfter??null}::date,${uuidArray(p.employmentIds)}::uuid[],
  ${filters.companyId||null}::uuid,${filters.departmentId||null}::uuid,${filters.businessUnitId||null}::uuid,${filters.status}::text,'exact-ascii'::text,${q}::text,
  ${port==='page'&&p.selectedId&&uuid.test(p.selectedId)?p.selectedId:null}::uuid,${port==='page'?offset:0}::bigint,${port==='page'?limit:1}::integer,
  ${port==='page'?labelMode:'names'}::text,${port}::text,NULL::uuid[]) f`;
 return port==='ids'?sql`select f."employmentId" from ${source} order by f.name,f."employmentId"`:
  sql`select * from ${source} order by f.phase,case when f.phase between 1 and 3 then f."companyId" end,
   case when f.phase=2 then f."departmentId" end,case when f.phase=3 then f."businessUnitId" end,f.name,f."employmentId"`;
}
function eligible(p:EmployeeChoiceServerInput,prepared:Prepared,signal?:AbortSignal){
 return typeof p.query==='string'&&!p.query.includes('\0')&&prepared.q!==''&&!prepared.q.includes('\0')&&/^[\x01-\x7f]*$/.test(prepared.q)&&exactAsciiPrototypeRuntime(signal);
}
type BoundaryRow={phase:number;kind:'count'|'company'|'department'|'unit'|'selected'|'candidate';employmentId:string|null;name:string|null;employeeCode:string|null;
 companyId:string|null;departmentId:string|null;businessUnitId:string|null;status:'active'|'ended'|null;label:string|null;code:string|null;total:number|null};
type Identity=Pick<EmployeeChoice,'employmentId'|'name'|'employeeCode'|'companyId'|'departmentId'|'businessUnitId'|'status'>;
type Options=Pick<EmployeeChoice,'companyId'|'company'|'departmentId'|'department'|'departmentCode'|'businessUnitId'|'businessUnit'|'businessUnitCode'>;
function identity(row:BoundaryRow):Identity{
 if(!row.employmentId||row.name===null||!row.companyId||row.status!=='active'&&row.status!=='ended')throw Error('Invalid native employee identity');
 return {employmentId:row.employmentId,name:row.name,employeeCode:row.employeeCode,companyId:row.companyId,departmentId:row.departmentId,businessUnitId:row.businessUnitId,status:row.status};
}
export async function readEmployeeChoices(ctx:SessionContext,p:EmployeeChoiceInput&{companyIds:string[]},signal?:AbortSignal):Promise<EmployeeChoicePage>{
 if('terminatedAfter'in p||'employmentIds'in p)throw new EmployeeChoiceInputError('Server population requires an explicit presentation transaction');
 const captured=captureContext(ctx),input=captureInput(p);
 return withTenant(captured,tx=>readPage(tx,captured,input,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,signal),{readOnlySnapshot:true,readSignal:signal});
}
export function readEmployeeChoicesTx(tx:Tx,ctx:SessionContext,p:EmployeeChoiceServerInput,signal?:AbortSignal){
 return readPage(tx,captureContext(ctx),captureInput(p),ALL_ROW_CEILING,signal);
}
async function readPage(tx:Tx,ctx:SessionContext,p:EmployeeChoiceServerInput,maximum:number,signal?:AbortSignal):Promise<EmployeeChoicePage>{
 const prepared=prepare(p,maximum),{filters,offset,limit,labelMode}=prepared;
 signal?.throwIfAborted();
 if(!eligible(p,prepared,signal))return legacy.readEmployeeChoicesTx(tx,ctx,p,signal);
 signal?.throwIfAborted();await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
 if(labelMode==='labels'&&!isAdmin(ctx))throw new EmployeeChoiceAccessError('Employee catalogue labels require current administration access');
 const raw:Identity[]=[],options:Options[]=[],companies=new Map<string,string>(),catalogue:BoundaryRow[]=[];
 const departments=new Map<string,{name:string|null;code:string|null}>(),units=new Map<string,{name:string|null;code:string|null}>();
 let selected:Identity|null=null,total:number|undefined;
 const result=await tx.execute<BoundaryRow>(exactAsciiQuery(ctx,p,prepared,'page'));signal?.throwIfAborted();
 for(const row of result){
  if(row.kind==='count'){if(total!==undefined||row.total===null||!Number.isSafeInteger(row.total)||row.total<0)throw Error('Invalid exact native employee count');total=row.total;}
  else if(row.kind==='candidate')raw.push(identity(row));
  else if(row.kind==='selected'){if(selected!==null)throw Error('Duplicate native selected employee');selected=identity(row);}
  else catalogue.push(row);
 }
 if(total===undefined||raw.length!==Math.min(limit,Math.max(0,total-offset)))throw Error('Exact native employee page incomplete');
 // UUID text returned by PostgreSQL is canonical lowercase; byte-order UUID
 // comparison retains its original catalogue insertion order, without text/name collation.
 const uuidOrder=(a:string|null,b:string|null)=>(a??'')<(b??'')?-1:(a??'')>(b??'')?1:0;
 catalogue.sort((a,b)=>a.phase-b.phase||uuidOrder(a.companyId,b.companyId)||uuidOrder(a.departmentId,b.departmentId)||uuidOrder(a.businessUnitId,b.businessUnitId));
 for(const row of catalogue){
  if(!row.companyId)throw Error('Invalid native employee catalogue');
  if(row.kind==='company'){
   if(row.label===null)throw Error('Invalid native employee company');companies.set(row.companyId,row.label);
   options.push({companyId:row.companyId,company:row.label,departmentId:null,department:null,departmentCode:null,businessUnitId:null,businessUnit:null,businessUnitCode:null});continue;
  }
  const companyName=companies.get(row.companyId);if(companyName===undefined)throw Error('Missing native employee company');
  if(row.kind==='department'&&row.departmentId){
   departments.set(row.departmentId,{name:row.label,code:row.code});
   options.push({companyId:row.companyId,company:companyName,departmentId:row.departmentId,department:row.label,departmentCode:row.code,businessUnitId:null,businessUnit:null,businessUnitCode:null});
  }else if(row.kind==='unit'&&row.businessUnitId){
   units.set(row.businessUnitId,{name:row.label,code:row.code});
   options.push({companyId:row.companyId,company:companyName,departmentId:null,department:null,departmentCode:null,businessUnitId:row.businessUnitId,businessUnit:row.label,businessUnitCode:row.code});
  }else throw Error('Invalid native employee organisation');
 }
 const project=(value:Identity):EmployeeChoice=>{
  const companyName=companies.get(value.companyId);if(companyName===undefined)throw Error('Missing native employee company');
  const d=value.departmentId?departments.get(value.departmentId):undefined,u=value.businessUnitId?units.get(value.businessUnitId):undefined;
  return {...value,company:companyName,department:d?.name??null,departmentCode:d?.code??null,businessUnit:u?.name??null,businessUnitCode:u?.code??null};
 };
 const inCompany=filters.companyId?options.filter(row=>row.companyId===filters.companyId):options;
 return {contextId:randomUUID(),rows:raw.map(project),selected:selected===null?null:project(selected),total,offset,limit,filters,labelMode,
  companyOptions:[...companies].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
  businessUnitOptions:organisationFilterChoices(inCompany.map(row=>({id:row.businessUnitId,name:row.businessUnit,code:row.businessUnitCode}))),
  departmentOptions:organisationFilterChoices(inCompany.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))),
  allDepartmentOptions:organisationFilterChoices(options.map(row=>({id:row.departmentId,name:row.department,code:row.departmentCode}))) };
}
export async function readEmployeeChoiceIdsTx(tx:Tx,ctx:SessionContext,p:EmployeeChoicePopulationFilters,signal?:AbortSignal){
 ctx=captureContext(ctx);const input=captureInput(p),prepared=prepare({...input,offset:0,limit:1,labelMode:'names'},EMPLOYEE_CHOICE_MAX_PAGE_SIZE);
 signal?.throwIfAborted();if(!eligible(input,prepared,signal))return legacy.readEmployeeChoiceIdsTx(tx,ctx,input,signal);
 await assertAiPresentationPrincipalTx(tx,ctx);signal?.throwIfAborted();
 const cursor=sql.identifier('employee_choices_'+randomUUID().replace(/-/g,'')),ids:string[]=[];
 await tx.execute(sql`declare ${cursor} no scroll cursor for ${exactAsciiQuery(ctx,input,prepared,'ids')}`);signal?.throwIfAborted();
 for(;;){
  signal?.throwIfAborted();const batch=await tx.execute<{employmentId:string}>(sql`fetch forward 512 from ${cursor}`);signal?.throwIfAborted();
  for(const row of batch){if(Object.keys(row).length!==1||!uuid.test(row.employmentId))throw Error('Invalid exact native ID-only row');ids.push(row.employmentId);}if(batch.length<512)break;
 }
 await tx.execute(sql`close ${cursor}`);signal?.throwIfAborted();return ids;
}
