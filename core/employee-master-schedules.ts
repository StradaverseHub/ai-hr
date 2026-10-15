/** Report scheduling consumes the existing notification owner's explicit report-mail consent policy.
 * The policy supplies fresh user/person/active employment identity; a browser cannot assert consent.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, employment, customReportSchedule } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { nextMasterScheduleAt, validateMasterSchedule } from '../lib/employee-master-schedule';
import { authorizeEmployeeMasterRun, getEmployeeMasterReport, recordEmployeeMasterRun, runEmployeeMasterReport } from './employee-master-reports';
import { serializeEmployeeMaster } from '../lib/employee-master-export';
import { MasterReportAccessError } from './employee-master-access';
export type MasterDeliveryRecipient={userId:string;employmentId:string;label:string;context:SessionContext;scopeIds:string[]};
/** Only the existing notification consent/verified identity owner may implement this server seam. */
export type MasterRecipientPolicy=(ctx:SessionContext)=>Promise<readonly MasterDeliveryRecipient[]>;
export async function employeeMasterRecipientOptions(ctx:SessionContext,scopeIds:readonly string[],reportId:string,policy:MasterRecipientPolicy){
 const report=await getEmployeeMasterReport(ctx,scopeIds,reportId),options:MasterDeliveryRecipient[]=[];
 for(const recipient of await policy(ctx)){
  if(!report.shared&&recipient.userId!==report.ownerUserId)continue;
  try{await getEmployeeMasterReport(recipient.context,recipient.scopeIds,reportId);options.push(recipient);}catch(error){if(!(error instanceof MasterReportAccessError))throw error;}
 }
 return options;
}
export async function saveEmployeeMasterSchedule(ctx:SessionContext,scopeIds:readonly string[],input:{reportId:string;version:number;enabled:boolean;config:unknown;recipientUserIds:string[]},policy:MasterRecipientPolicy){
 const report=await getEmployeeMasterReport(ctx,scopeIds,input.reportId);if(!report.canEdit)throw new MasterReportAccessError();if(report.version!==input.version)throw new Error('Review the changed report before scheduling it.');
 const config=validateMasterSchedule(input.config),ids=[...new Set(input.recipientUserIds)];if(ids.length>100||input.enabled&&!ids.length)throw new Error('Choose between one and 100 opted-in recipients.');
 const eligible=await employeeMasterRecipientOptions(ctx,scopeIds,report.id,policy);if(ids.some(id=>!eligible.some(recipient=>recipient.userId===id)))throw new Error('A recipient no longer has report access or explicit report-email consent.');
 const reviewedDigest=createHash('sha256').update(JSON.stringify({version:report.version,spec:report.spec,roles:report.sharedRoleIds,recipients:ids.sort(),config})).digest('hex');
 return withTenant(ctx,async tx=>{const [row]=await tx.insert(customReportSchedule).values({tenantId:ctx.tenantId,reportId:report.id,enabled:input.enabled,config,recipientUserIds:ids,reportVersion:report.version,reviewedDigest,nextRunAt:input.enabled?nextMasterScheduleAt(config,new Date()):null}).onConflictDoUpdate({target:customReportSchedule.reportId,set:{enabled:input.enabled,config,recipientUserIds:ids,reportVersion:report.version,reviewedDigest,nextRunAt:input.enabled?nextMasterScheduleAt(config,new Date()):null,updatedAt:new Date()}}).returning({id:customReportSchedule.id});return row;});
}
export function getEmployeeMasterSchedule(ctx:SessionContext,reportId:string){return withTenant(ctx,async tx=>{const [row]=await tx.select().from(customReportSchedule).where(eq(customReportSchedule.reportId,reportId)).limit(1);return row?{...row,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),nextRunAt:row.nextRunAt?.toISOString()??null}:null;});}
/** Parent-managed sender calls only with a freshly consent-resolved recipient context. It checks
 * explicit consent immediately before SMTP as well; no address/body/bytes come from a web IPC request.
 */
export async function renderEmployeeMasterDelivery(recipientCtx:SessionContext,input:{reportId:string;expectedVersion:number;scopeIds:string[];recipientEmploymentId:string}){
 const today=todayInKualaLumpur();
 await withTenant(recipientCtx,async tx=>{
  const [identity]=await tx.select({id:employment.id}).from(employment).innerJoin(appUser,and(eq(appUser.personId,employment.personId),eq(appUser.id,recipientCtx.userId??''))).where(and(eq(employment.id,input.recipientEmploymentId),eq(employment.personId,recipientCtx.personId??''),isNull(appUser.archivedAt),lte(employment.hiredOn,today),or(isNull(employment.terminatedOn),sql`${employment.terminatedOn}>${today}::date`))).limit(1);
  if(!identity)throw new MasterReportAccessError();
 });
 const run=await runEmployeeMasterReport(recipientCtx,input.scopeIds,{id:input.reportId,expectedVersion:input.expectedVersion});
 const file=await serializeEmployeeMaster(run.result,run.spec,run.catalogue,run.name,'xlsx',run.brand);
 await authorizeEmployeeMasterRun(recipientCtx,input.scopeIds,run);
 // Successful SMTP, rather than generation alone, is the delivery success audit; managed worker records it.
 return {...file,rowCount:run.result.totalRows,reportVersion:run.version!,scopeIds:run.spec.companyIds,run};
}
