/** Online native request receipt. The existing event ledger owns replay evidence, not another leave table. */
import { createHash } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { domainEvent } from '../db/schema';
import { actorOf,appendEvent } from '../db/events';
import { myEmployments } from './read';
import { requestLeave } from '../packs/leave/service';
import { LeaveResult,type LeaveCommand } from '../lib/mobile-api/contract';
import { todayInKualaLumpur } from '../lib/hr-date';
import {abandonSubmissionTx,submissionAbandonedTx} from './mobile-submission-state';
export class MobileLeaveReplayConflict extends Error{constructor(){super('This submission reference already recorded a different request. Review request history before creating a new application.');}}
export class MobileLeaveAbandoned extends Error{constructor(){super('This submission was discarded before it recorded. Review your request before creating a new application.');}}
const validRequest=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
/** Recover only the original actor's receipt, independently of paged request history or its current status. */
export async function ownMobileLeaveReceipt(ctx:SessionContext,employmentId:string,requestId:string){
  return (await ownMobileLeaveDisposition(ctx,employmentId,requestId)).receipt;
}
async function mobileLeaveReceiptTx(tx:Tx,ctx:SessionContext,employmentId:string,requestId:string){
    if(!ctx.userId)return null;
    const [row]=await tx.select({payload:domainEvent.payload}).from(domainEvent).where(and(
      eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'mobile-leave-command'),
      eq(domainEvent.aggregateId,requestId),eq(domainEvent.actorId,ctx.userId!),
      eq(domainEvent.subjectEmploymentId,employmentId),eq(domainEvent.eventType,'mobile.leave.submitted'),
    )).limit(1);
    if(!row)return null;
    const response=LeaveResult.parse((row.payload as {response:unknown}).response);
    if(response.outcome!=='accepted')throw new Error('Invalid persisted leave receipt');
    return response;
}
export async function ownMobileLeaveDisposition(ctx:SessionContext,employmentId:string,requestId:string){
  if(!ctx.userId||!validRequest(requestId)||!(await myEmployments(ctx)).some(e=>e.employmentId===employmentId))return {receipt:null};
  return withTenant(ctx,async tx=>{
    const receipt=await mobileLeaveReceiptTx(tx,ctx,employmentId,requestId);
    const abandoned=!receipt&&await submissionAbandonedTx(tx,ctx,employmentId,'leave',requestId);
    return {receipt,...(abandoned?{abandoned:true as const}:{})};
  });
}
export async function abandonMobileLeave(ctx:SessionContext,employmentId:string,requestId:string){
  if(!ctx.userId||!validRequest(requestId)||!(await myEmployments(ctx)).some(e=>e.employmentId===employmentId))throw new Error('Own active employment required');
  return withTenant(ctx,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-leave:'+ctx.userId+':'+requestId},0))`);
    const receipt=await mobileLeaveReceiptTx(tx,ctx,employmentId,requestId);
    if(receipt)return {receipt,abandoned:false};
    await abandonSubmissionTx(tx,ctx,employmentId,'leave',requestId);
    return {receipt:null,abandoned:true};
  });
}
export async function submitMobileLeave(ctx:SessionContext,employmentId:string,command:LeaveCommand,document?:{fileName:string;mimeType:string;content:Buffer}){
  if(!ctx.userId||!(await myEmployments(ctx)).some(e=>e.employmentId===employmentId))throw new Error('Own active employment required');
  const {requestId,...intent}=command;
  const digest=createHash('sha256').update(JSON.stringify(intent)).update(document?JSON.stringify([document.fileName,document.mimeType,createHash('sha256').update(document.content).digest('hex')]):'').digest('hex');
  return withTenant(ctx,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-leave:'+ctx.userId+':'+requestId},0))`);
    if(await submissionAbandonedTx(tx,ctx,employmentId,'leave',requestId))throw new MobileLeaveAbandoned();
    const [prior]=await tx.select({payload:domainEvent.payload,employmentId:domainEvent.subjectEmploymentId}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'mobile-leave-command'),eq(domainEvent.aggregateId,requestId),eq(domainEvent.actorId,ctx.userId!),eq(domainEvent.eventType,'mobile.leave.submitted'))).limit(1);
    if(prior){const payload=prior.payload as {digest?:unknown;response?:unknown};if(prior.employmentId!==employmentId||payload?.digest!==digest)throw new MobileLeaveReplayConflict();return LeaveResult.parse(payload.response);}
    const result=await requestLeave(ctx,{...intent,employmentId,document,today:todayInKualaLumpur()},tx);
    const response=LeaveResult.parse({outcome:'accepted',id:result.leaveRequestId,days:result.days,maternityAllowanceWarning:!!result.maternityAllowanceWarning,holidayWarning:!!result.holidayWarnings?.length});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-leave-command',aggregateId:requestId,eventType:'mobile.leave.submitted',actor:actorOf(ctx),subjectEmploymentId:employmentId,payload:{digest,response}});
    return response;
  });
}
