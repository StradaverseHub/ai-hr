/** Employee Master templates and execution. Every entry re-resolves scoped field access; a shared
 * definition grants no data. Stored projections use one explicit read-only Repeatable Read snapshot.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { customReport, customReportSchedule, companyLogo, roleAssignment, type CustomReportSpec } from '../db/schema';
import { legacyEmployeeMasterSpec } from '../lib/employee-master-legacy';
import { todayInKualaLumpur } from '../lib/hr-date';
import { masterSpecFields, runEmployeeMasterProjection, validateEmployeeMasterSpec, MASTER_PREVIEW_ROWS, type EmployeeMasterSpec, type EmployeeMasterResult } from '../lib/employee-master-report';
import { masterReportFieldsTx, MasterReportAccessError } from './employee-master-access';
import { employeeMasterSubjectsTx } from './employee-master-projection';

export type MasterTemplate={id:string;name:string;description:string;ownerUserId:string|null;ownerName:string|null;shared:boolean;sharedRoleIds:string[];version:number;lastRunAt:string|null;scheduleEnabled:boolean;updatedAt:string;spec:EmployeeMasterSpec;canEdit:boolean};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assertScope=(companies:string[],scope:readonly string[])=>{if(!companies.length||companies.some(id=>!scope.includes(id)))throw new MasterReportAccessError();};
const templateSpec=(spec:EmployeeMasterSpec):CustomReportSpec=>({datasetId:'master',columns:spec.columns.map(column=>column.field),employeeMaster:spec});
async function visibleTx(tx:Tx,id:string){const [row]=await tx.select().from(customReport).where(and(eq(customReport.id,id),eq(customReport.datasetId,'master'))).limit(1);if(!row)throw new MasterReportAccessError();return row;}
async function editableTx(tx:Tx,ctx:SessionContext,row:{createdByUserId:string|null}){const [access]=await tx.execute(sql`select app.is_admin() as admin`) as unknown as {admin:boolean}[];if(row.createdByUserId!==ctx.userId&&!access?.admin)throw new MasterReportAccessError();}
async function checkedTx(tx:Tx,ctx:SessionContext,raw:unknown,scopeIds:readonly string[]){
  // Company UUIDs are schema-validated before they reach SQL. Full validation uses the scoped catalogue.
  const input=raw as Partial<EmployeeMasterSpec>;if(!z.array(z.uuid()).min(1).max(100).safeParse(input?.companyIds).success)throw new MasterReportAccessError();
  assertScope(input.companyIds!,scopeIds);
  const catalogue=await masterReportFieldsTx(tx,ctx,input.companyIds!);
  const spec=validateEmployeeMasterSpec(raw,catalogue,todayInKualaLumpur());
  return {spec,catalogue,fields:catalogue.filter(field=>masterSpecFields(spec).includes(field.id))};
}
export async function masterReportRoles(ctx:SessionContext){return withTenant(ctx,async tx=>(await tx.selectDistinct({id:roleAssignment.role}).from(roleAssignment).orderBy(asc(roleAssignment.role))).map(row=>row.id));}
export async function saveEmployeeMasterReport(ctx:SessionContext,scopeIds:readonly string[],input:{id?:string;version?:number;name:string;description:string;sharedRoleIds:string[];spec:unknown}):Promise<{id:string;version:number}>{
  if(!ctx.userId)throw new MasterReportAccessError();const name=input.name.trim(),description=input.description.trim();
  if(!name||name.length>150||description.length>1000)throw new Error('Enter a report name up to 150 characters and a description up to 1,000 characters.');
  return withTenant(ctx,async tx=>{
    const {spec}=await checkedTx(tx,ctx,input.spec,scopeIds);
    const roles=await tx.selectDistinct({id:roleAssignment.role}).from(roleAssignment);
    const sharedRoleIds=[...new Set(input.sharedRoleIds)];if(sharedRoleIds.some(id=>!roles.some(role=>role.id===id)))throw new MasterReportAccessError();
    const values={name,description,spec:templateSpec(spec),shared:sharedRoleIds.length>0,sharedRoleIds,updatedAt:new Date()};
    let row:{id:string;version:number}|undefined;
    if(input.id){const old=await visibleTx(tx,input.id);await editableTx(tx,ctx,old);if(old.version!==input.version)throw new Error('This report changed. Reopen it before saving.');
      [row]=await tx.update(customReport).set(values).where(and(eq(customReport.id,old.id),eq(customReport.version,old.version))).returning({id:customReport.id,version:customReport.version});
    }else [row]=await tx.insert(customReport).values({...values,tenantId:ctx.tenantId,createdByUserId:ctx.userId,category:'master',datasetId:'master'}).returning({id:customReport.id,version:customReport.version});
    if(!row)throw new Error('This report changed. Reopen it before saving.');
    // Definition changes invalidate a reviewed delivery, even when its field count remains the same.
    await tx.update(customReportSchedule).set({enabled:false,updatedAt:new Date()}).where(eq(customReportSchedule.reportId,row.id));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'custom-report',aggregateId:row.id,eventType:input.id?'custom-report.updated':'custom-report.created',actor:actorOf(ctx),payload:{datasetId:'master',columnCount:spec.columns.length,shared:values.shared,version:row.version}});
    return row;
  });
}
export async function getEmployeeMasterReport(ctx:SessionContext,scopeIds:readonly string[],id:string):Promise<MasterTemplate>{return withTenant(ctx,async tx=>{
  const row=await visibleTx(tx,id);const {spec}=await checkedTx(tx,ctx,legacyEmployeeMasterSpec(row.spec,[...scopeIds],todayInKualaLumpur()),scopeIds);
  const [admin]=await tx.execute(sql`select app.is_admin() as admin`) as unknown as {admin:boolean}[];
  const names=await tx.execute(sql`select p.full_name as name from app_user u left join person p on p.id=u.person_id where u.id=${row.createdByUserId}::uuid`) as unknown as {name:string|null}[];
  const [schedule]=await tx.select({enabled:customReportSchedule.enabled}).from(customReportSchedule).where(eq(customReportSchedule.reportId,row.id)).limit(1);
  return {id:row.id,name:row.name,description:row.description,ownerUserId:row.createdByUserId,ownerName:names[0]?.name??null,shared:row.shared,sharedRoleIds:row.sharedRoleIds,version:row.version,lastRunAt:row.lastRunAt?.toISOString()??null,scheduleEnabled:schedule?.enabled??false,updatedAt:row.updatedAt.toISOString(),spec,canEdit:row.createdByUserId===ctx.userId||!!admin?.admin};
});}
export async function listEmployeeMasterReports(ctx:SessionContext,scopeIds:readonly string[],input:{all?:boolean;search?:string}={}):Promise<MasterTemplate[]>{
  const ids=await withTenant(ctx,async tx=>(await tx.select({id:customReport.id,name:customReport.name}).from(customReport).where(and(eq(customReport.datasetId,'master'),sql`${customReport.spec} ? 'employeeMaster'`)).orderBy(sql`${customReport.lastRunAt} desc nulls last`,desc(customReport.updatedAt),asc(customReport.id))).filter(row=>!input.search||row.name.toLocaleLowerCase().includes(input.search.toLocaleLowerCase())).map(row=>row.id));
  const reports:MasterTemplate[]=[];for(const id of ids){try{reports.push(await getEmployeeMasterReport(ctx,scopeIds,id));}catch(error){if(!(error instanceof MasterReportAccessError))throw error;}if(!input.all&&reports.length===5)break;}return reports;
}
export async function duplicateEmployeeMasterReport(ctx:SessionContext,scopeIds:readonly string[],id:string){const source=await getEmployeeMasterReport(ctx,scopeIds,id);return saveEmployeeMasterReport(ctx,scopeIds,{name:source.name+' (copy)',description:source.description,sharedRoleIds:[],spec:source.spec});}
export async function deleteEmployeeMasterReport(ctx:SessionContext,id:string){return withTenant(ctx,async tx=>{const row=await visibleTx(tx,id);await editableTx(tx,ctx,row);await tx.delete(customReport).where(eq(customReport.id,id));await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'custom-report',aggregateId:id,eventType:'custom-report.deleted',actor:actorOf(ctx),payload:{datasetId:'master'}});});}
export type MasterRun={result:EmployeeMasterResult;spec:EmployeeMasterSpec;reportId:string|null;version:number|null;name:string;catalogue:Awaited<ReturnType<typeof masterReportFieldsTx>>;fingerprint:string;brand?:{content:string;mimeType:string}};
export async function runEmployeeMasterReport(ctx:SessionContext,scopeIds:readonly string[],input:{id?:string;spec?:unknown;expectedVersion?:number;includeWithoutCompany?:boolean}):Promise<MasterRun>{
  return withTenant(ctx,async tx=>{
    const row=input.id?await visibleTx(tx,input.id):null;
    if(input.expectedVersion!==undefined&&row?.version!==input.expectedVersion)throw new Error('This report changed. Review it before running.');
    const {spec,catalogue,fields}=await checkedTx(tx,ctx,row?legacyEmployeeMasterSpec(row.spec,[...scopeIds],todayInKualaLumpur()):input.spec,scopeIds);
    const subjects=await employeeMasterSubjectsTx(tx,ctx,spec,fields,catalogue,{includeWithoutCompany:input.includeWithoutCompany});
    const logos=spec.pdf.logo&&spec.companyIds.length===1?await tx.select({content:companyLogo.content,mimeType:companyLogo.mimeType}).from(companyLogo).where(eq(companyLogo.companyId,spec.companyIds[0])).limit(1):[];
    const brand=logos[0]?{content:Buffer.from(logos[0].content).toString('base64'),mimeType:logos[0].mimeType}:undefined;
    const result=runEmployeeMasterProjection(spec,fields,subjects,todayInKualaLumpur());
    return {result,spec,reportId:row?.id??null,version:row?.version??null,name:row?.name??'Employee Master',catalogue,brand,fingerprint:digest({user:ctx.userId,roles:ctx.roles,grants:ctx.grants,companies:spec.companyIds,fields:catalogue.map(f=>f.id),spec,version:row?.version})};
  },{readOnlySnapshot:true});
}
/** Re-authorize after generation before handing bytes/preview to the caller. No row cache crosses users. */
export async function authorizeEmployeeMasterRun(ctx:SessionContext,scopeIds:readonly string[],run:MasterRun){return withTenant(ctx,async tx=>{
  const row=run.reportId?await visibleTx(tx,run.reportId):null;if(row&&row.version!==run.version)throw new Error('This report changed. Run it again.');
  const {spec,catalogue}=await checkedTx(tx,ctx,run.spec,scopeIds);
  const fingerprint=digest({user:ctx.userId,roles:ctx.roles,grants:ctx.grants,companies:spec.companyIds,fields:catalogue.map(f=>f.id),spec,version:row?.version});
  if(fingerprint!==run.fingerprint)throw new MasterReportAccessError();
});}
export async function recordEmployeeMasterRun(ctx:SessionContext,run:MasterRun,kind:'preview'|'run'|'export'|'delivery',format:'xlsx'|'csv'|'pdf'|null,outcome:'success'|'failed'|'skipped'='success'){
  return withTenant(ctx,tx=>tx.execute(sql`select app.record_custom_report_run(${run.reportId}::uuid,${run.version}::integer,${kind},${format},${sql`ARRAY[${sql.join(run.spec.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]`},${outcome==='success'?run.result.totalRows:0},${outcome},${outcome==='success'?null:'generation-failed'})`));
}
export function masterPreview(run:MasterRun):MasterRun{return {...run,result:{...run.result,sections:run.result.sections.map(section=>({...section,rows:section.rows.slice(0,MASTER_PREVIEW_ROWS)}))}};}
