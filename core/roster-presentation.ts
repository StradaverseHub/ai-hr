/** Roster presentation only. Population/count/page precede canonical date-cell hydration.
 * Whole exports, templates and domain commands continue through their existing owners. */
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assignment,department,businessUnit,position} from '../db/schema';
import {readEmployeeChoicesTx,readEmployeeChoiceIdsTx} from './employee-choice';
import {assertAiPresentationPrincipalTx} from './ai-principal';
import {boundPersonnelStatementTx} from './personnel-read-bounds';
import {assertRosterWindow,hydrateRosterWindow,listShiftsForTenant,type RosterMonthEmployee} from './roster';
import {datesBetween} from '../lib/roster-month';
import {todayInKualaLumpur} from '../lib/hr-date';
import {organisationFilterChoices} from '../lib/organisation-choice-label';
import {ALL_ROW_CEILING} from '../lib/pagination';

export type RosterPopulation = {
 companyIds:string[];businessUnitId?:string;departmentId?:string;q?:string;employmentIds?:string[];
};
export type RosterChoicePage={
 rows: RosterMonthEmployee[];total:number;offset:number;limit:number;
 businessUnitOptions:{id:string;name:string}[];departmentOptions:{id:string;name:string}[];
};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const capturePopulation=<T extends RosterPopulation>(p:T):T=>({...p,companyIds:p.companyIds.slice(),employmentIds:p.employmentIds?.slice()});
const captureSession=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

/** The trusted server scope is never read from a posted picker envelope. */
export async function rosterEmployeePageTx(tx:Tx,ctx:SessionContext,p:RosterPopulation&{offset:number;limit:number}):Promise<RosterChoicePage>{
 if(!Number.isSafeInteger(p.offset)||p.offset<0||!Number.isInteger(p.limit)||p.limit<1||p.limit>ALL_ROW_CEILING)throw new Error('Invalid roster page');
 const normalizeFilter=(id:string|undefined)=>id&&!uuid.test(id)?'00000000-0000-0000-0000-000000000000':id;
 const input={companyIds:p.companyIds,query:p.q,businessUnitId:normalizeFilter(p.businessUnitId),departmentId:normalizeFilter(p.departmentId),
  terminatedAfter:todayInKualaLumpur(),...(p.employmentIds?{employmentIds:p.employmentIds.filter(id=>uuid.test(id))}:{}),offset:p.offset,limit:p.limit};
 const first=await readEmployeeChoicesTx(tx,ctx,input);
 const rows=[...first.rows];
 const ids=rows.map(row=>row.employmentId);
 const occupations=ids.length?await tx.select({employmentId:assignment.employmentId,occupation:position.title}).from(assignment)
  .leftJoin(position,eq(position.id,assignment.positionId)).where(and(inArray(assignment.employmentId,ids),isNull(assignment.validTo),isNull(assignment.supersededAt))):[];
 const occupationById=new Map(occupations.map(row=>[row.employmentId,row.occupation]));
 const departmentIds=first.departmentOptions.map(row=>row.id),unitIds=first.businessUnitOptions.map(row=>row.id);
 const departments=departmentIds.length?await tx.select({id:department.id,name:sql<string>`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`,code:department.name}).from(department).where(inArray(department.id,departmentIds)):[];
 const units=unitIds.length?await tx.select({id:businessUnit.id,name:sql<string>`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.name}),''),${businessUnit.code})`,code:businessUnit.code}).from(businessUnit).where(inArray(businessUnit.id,unitIds)):[];
 const departmentById=new Map(departments.map(row=>[row.id,row])),unitById=new Map(units.map(row=>[row.id,row]));
 return {rows:rows.map(row=>({employmentId:row.employmentId,name:row.name,code:row.employeeCode,
  department:row.department,departmentId:row.departmentId,departmentLabel:row.departmentId?departmentById.get(row.departmentId)?.name:null,departmentCode:row.department,
  businessUnit:row.businessUnit,businessUnitId:row.businessUnitId,businessUnitLabel:row.businessUnitId?unitById.get(row.businessUnitId)?.name:null,businessUnitCode:row.businessUnitId?unitById.get(row.businessUnitId)?.code:null,
  occupation:occupationById.get(row.employmentId)??null,company:row.company,companyId:row.companyId})),
  total:first.total,offset:p.offset,limit:p.limit,businessUnitOptions:organisationFilterChoices(units),departmentOptions:organisationFilterChoices(departments)};
}

export function rosterEmployeePage(ctx:SessionContext,p:RosterPopulation&{offset:number;limit:number},signal?:AbortSignal){
 ctx=captureSession(ctx);p=capturePopulation(p);
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);await boundPersonnelStatementTx(tx);
  return rosterEmployeePageTx(tx,ctx,p);
 },{readOnlySnapshot:true,readSignal:signal});
}

export function rosterWindowPage(ctx:SessionContext,p:RosterPopulation&{from:string;to:string;offset:number;limit:number}){
 assertRosterWindow(p.from,p.to);
 ctx=captureSession(ctx);p=capturePopulation(p);
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);await boundPersonnelStatementTx(tx);
  const population=await rosterEmployeePageTx(tx,ctx,p);
  const shifts=await listShiftsForTenant(ctx,undefined,tx);
  const view=await hydrateRosterWindow(ctx,{from:p.from,to:p.to,dates:datesBetween(p.from,p.to),employees:population.rows,allEmployees:[],shiftRows:shifts},tx);
  return {...view,total:population.total,businessUnitOptions:population.businessUnitOptions,departmentOptions:population.departmentOptions};
 },{readOnlySnapshot:true});
}

/** Explicit complete command target resolution: no page ceiling, and no cells or workbook hydration. */
export function rosterPopulationIds(ctx:SessionContext,p:RosterPopulation,signal?:AbortSignal){
 ctx=captureSession(ctx);p=capturePopulation(p);
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);await boundPersonnelStatementTx(tx);
  return readEmployeeChoiceIdsTx(tx,ctx,{companyIds:p.companyIds,query:p.q,businessUnitId:p.businessUnitId,departmentId:p.departmentId,
   terminatedAfter:todayInKualaLumpur(),...(p.employmentIds?{employmentIds:p.employmentIds.filter(id=>uuid.test(id))}:{})},signal);
 },{readOnlySnapshot:true,readSignal:signal});
}
