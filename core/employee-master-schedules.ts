/** Report scheduling consumes the existing Notifications owner's explicit report-attachment consent.
 * The browser supplies exact identity pairs, never recipient authority, email addresses or consent.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { customReportSchedule, customReportOccurrence } from '../db/schema';
import { nextMasterScheduleAt, validateMasterSchedule } from '../lib/employee-master-schedule';
import { authorizeEmployeeMasterRun, getEmployeeMasterReport, runEmployeeMasterReport } from './employee-master-reports';
import { serializeEmployeeMaster } from '../lib/employee-master-export';
import { MasterReportAccessError } from './employee-master-access';
import { resolveEmployeeMasterRecipients } from './notification-email';
import type { MasterRecipient, MasterRecipientIdentity, MasterRecipientPolicy, MasterConsentRevision } from './employee-master-recipient-types';
export type { MasterRecipient, MasterRecipientIdentity, MasterRecipientPolicy, MasterConsentRevision } from './employee-master-recipient-types';
const pairSchema=z.object({userId:z.uuid(),employmentId:z.uuid()}).strict();
export async function employeeMasterRecipientOptions(ctx:SessionContext,scopeIds:readonly string[],reportId:string,policy:MasterRecipientPolicy=resolveEmployeeMasterRecipients){
 const report=await getEmployeeMasterReport(ctx,scopeIds,reportId),options:MasterRecipient[]=[];
 for(const recipient of await policy(ctx)){
  if(!report.shared&&recipient.userId!==report.ownerUserId)continue;
  try{await getEmployeeMasterReport(recipient.context,recipient.scopeIds,reportId);options.push(recipient);}catch(error){if(!(error instanceof MasterReportAccessError))throw error;}
 }
 return options;
}
export async function saveEmployeeMasterSchedule(ctx:SessionContext,scopeIds:readonly string[],input:{reportId:string;version:number;enabled:boolean;config:unknown;recipients:MasterRecipientIdentity[]},policy:MasterRecipientPolicy=resolveEmployeeMasterRecipients){
 const report=await getEmployeeMasterReport(ctx,scopeIds,input.reportId);if(!report.canEdit)throw new MasterReportAccessError();if(report.version!==input.version)throw new Error('Review the changed report before scheduling it.');
 const config=validateMasterSchedule(input.config),recipients=z.array(pairSchema).max(100).parse(input.recipients);
 // A user must have one explicit receiving employment. Never infer one from an email or array order.
 if(new Set(recipients.map(pair=>pair.userId)).size!==recipients.length||input.enabled&&!recipients.length)throw new Error('Choose one receiving employment for each opted-in recipient.');
 if(input.enabled){const eligible=await employeeMasterRecipientOptions(ctx,scopeIds,report.id,policy);if(recipients.some(pair=>!eligible.some(recipient=>recipient.userId===pair.userId&&recipient.employmentId===pair.employmentId)))throw new Error('A recipient no longer has report access or explicit report-email consent.');}
 const reviewedDigest=createHash('sha256').update(JSON.stringify({version:report.version,spec:report.spec,roles:report.sharedRoleIds,recipients:[...recipients].sort((a,b)=>a.userId.localeCompare(b.userId)),config})).digest('hex');
 const reviewedRevision=randomUUID();
 const nextRunAt=input.enabled?nextMasterScheduleAt(config,new Date()):null;
 return withTenant(ctx,async tx=>{
  const [row]=await tx.insert(customReportSchedule).values({tenantId:ctx.tenantId,reportId:report.id,enabled:input.enabled,config,recipients,reportVersion:report.version,reviewedDigest,reviewedRevision,nextRunAt}).onConflictDoUpdate({target:customReportSchedule.reportId,set:{enabled:input.enabled,config,recipients,reportVersion:report.version,reviewedDigest,reviewedRevision,nextRunAt,updatedAt:new Date()}}).returning({id:customReportSchedule.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'custom-report',aggregateId:report.id,eventType:'employee-master.schedule-changed',actor:actorOf(ctx),payload:{enabled:input.enabled,reportVersion:report.version,recipientCount:recipients.length}});
  return row;
 });
}
export function getEmployeeMasterSchedule(ctx:SessionContext,reportId:string){return withTenant(ctx,async tx=>{const [row]=await tx.select().from(customReportSchedule).where(eq(customReportSchedule.reportId,reportId)).limit(1);return row?{...row,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),nextRunAt:row.nextRunAt?.toISOString()??null}:null;});}
export function employeeMasterDeliveryHistory(ctx:SessionContext,reportId:string){return withTenant(ctx,tx=>tx.select({id:customReportOccurrence.id,status:customReportOccurrence.status,scheduledFor:customReportOccurrence.scheduledFor,rowCount:customReportOccurrence.rowCount,reason:customReportOccurrence.reason}).from(customReportOccurrence).where(eq(customReportOccurrence.reportId,reportId)).orderBy(desc(customReportOccurrence.scheduledFor),desc(customReportOccurrence.id)).limit(50));}
export function sameMasterConsentRevision(a:MasterConsentRevision,b:MasterConsentRevision){return a.consentAfterSequence===b.consentAfterSequence&&a.policyAfterSequence===b.policyAfterSequence&&a.consentUpdatedAt===b.consentUpdatedAt&&a.policyUpdatedAt===b.policyUpdatedAt&&a.consentVerifiedAt===b.consentVerifiedAt;}
/** Managed sender supplies the frozen occurrence identity+revisions and still checks fresh provider
 * emailVerified before SMTP. A changed/withdrawn binding refuses; an uncertain SMTP result is never retried automatically.
 */
export async function renderEmployeeMasterDelivery(recipientCtx:SessionContext,input:{reportId:string;expectedVersion:number;scopeIds:string[];recipientEmploymentId:string;consentRevision:MasterConsentRevision;scheduleId:string;scheduleRevision:string;reviewedDigest:string}){
 if(!recipientCtx.userId)throw new MasterReportAccessError();
 const checkedRecipient=async()=>{
  const live=await withTenant(recipientCtx,async tx=>{const [schedule]=await tx.select().from(customReportSchedule).where(and(eq(customReportSchedule.id,input.scheduleId),eq(customReportSchedule.reportId,input.reportId))).limit(1);return schedule;});
  if(!live?.enabled||live.reviewedRevision!==input.scheduleRevision||live.reviewedDigest!==input.reviewedDigest||live.reportVersion!==input.expectedVersion||!live.recipients.some(pair=>pair.userId===recipientCtx.userId&&pair.employmentId===input.recipientEmploymentId))throw new MasterReportAccessError();
  const [recipient]=await resolveEmployeeMasterRecipients(recipientCtx,{userId:recipientCtx.userId!,employmentId:input.recipientEmploymentId});
  if(!recipient||!sameMasterConsentRevision(recipient,input.consentRevision))throw new MasterReportAccessError();
  return recipient;
 };
 const recipient=await checkedRecipient();
 if(input.scopeIds.some(id=>!recipient.scopeIds.includes(id)))throw new MasterReportAccessError();
 const run=await runEmployeeMasterReport(recipient.context,input.scopeIds,{id:input.reportId,expectedVersion:input.expectedVersion});
 const file=await serializeEmployeeMaster(run.result,run.spec,run.catalogue,run.name,'xlsx',run.brand);
 const fresh=await checkedRecipient();await authorizeEmployeeMasterRun(fresh.context,input.scopeIds,run);
 // Successful SMTP, rather than generation, is delivery success. Managed worker records the outcome.
 return {...file,rowCount:run.result.totalRows,reportVersion:run.version!,scopeIds:run.spec.companyIds,run,consentRevision:input.consentRevision};
}
