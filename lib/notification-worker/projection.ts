import {prepareNativeAssessmentReminder} from './reminder';
/** Uncommissioned fixed-API prototype. No application pool, service facade or Drizzle carrier. */
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import {createNotificationRegistry,type EventRef,type NotificationRecipientReaders,type NotificationSpec} from '../../core/notification-registry';
import type {NativeNotificationEvent} from './lifecycle';

export class UnsupportedNotificationFacts extends Error{
 constructor(){super('Canonical notification recipient facts are not implemented for this event');}
}
const uuid=z.uuid(),audience=z.object({employmentIds:z.array(uuid)}).strict();
const meta=z.object({known:z.boolean(),implemented:z.boolean(),obsolete:z.boolean()}).strict();
const payload=z.record(z.string(),z.unknown()).nullable();
type Reader={tx:TransactionSql;batch:string};
async function facts(reader:Reader,event:EventRef,family:string){
 if(!event.id)throw new UnsupportedNotificationFacts();
 const [row]=await reader.tx<{value:unknown}[]>`select notification_worker.facts(${reader.batch}::uuid,${event.id}::uuid,${family}::text) as value`;
 return row.value;
}
async function ids(reader:Reader,event:EventRef,family:string){return audience.parse(await facts(reader,event,family)).employmentIds;}
const unsupported=async()=>{throw new UnsupportedNotificationFacts();};
const nativeReaders:NotificationRecipientReaders<Reader>={
 probation:unsupported,
 contract:(r,e)=>ids(r,e,'contract-audience'),
 onboardingDigest:(r,e)=>ids(r,e,'onboarding-audience'),
 assessmentReminder:(r,e)=>{if(!e.id)throw new UnsupportedNotificationFacts();return prepareNativeAssessmentReminder(r.tx,r.batch,e.id);},
 rewardSuspension:(r,e)=>ids(r,e,'rewards-audience'),
 rewardUploadChecker:(r,e)=>ids(r,e,'rewards-audience'),
 rewardUploadReady:(r,e)=>ids(r,e,'rewards-audience'),
 rewardRouted:(r,e)=>ids(r,e,'rewards-audience'),
 // Preparation has distinct current-file and checker authority; no native fact owner yet.
 rewardPreparationReleased:unsupported,
 rewardPreparationChanged:unsupported,
 rewardPreparationInvalidated:unsupported,
 rewardPoolChanged:(r,e)=>ids(r,e,'rewards-audience'),
 rewardApproved:(r,e)=>ids(r,e,'rewards-audience'),
 // Configuration notices have no native fact owner yet.
 rewardConfigChanged:unsupported,
 rewardLimitsReapplied:unsupported,
 leaveSubmitted:unsupported,
 leaveCancellationSubmitted:unsupported,
 overtimeSubmitted:unsupported,
 readinessNudge:unsupported,
 peerFeedback:unsupported,
 assessmentReviewTask:unsupported,
 assessmentKpiApproval:unsupported,
 legacyReviewStarted:unsupported,
 legacyReviewEvaluated:unsupported,
 legacyReviewDecidedLetter:unsupported,
 legacyReviewReminder:unsupported,
 delegationStarted:(r,e)=>ids(r,e,'org-approvers'),
 delegationEnded:(r,e)=>ids(r,e,'org-approvers'),
 leaveEscalation:unsupported,
 automaticReviewChase:unsupported,
 missingClockFollowup:unsupported,
 passportFollowup:unsupported,
 lifecycleFollowup:unsupported,
 employeeLoopDigest:unsupported,
 noticePublished:(r,e)=>ids(r,e,'notice-audience'),
 payrollClosed:(r,e)=>ids(r,e,'payroll-audience'),
 approvalChase:()=>unsupported,
 bulkJobInitiator:unsupported,
};
/** Closed source-owned support, not permission or an installation receipt.
 * Unknown/missing metadata never falls back to subject audience. */
export const nativeNotificationReaderSupport:Readonly<Record<keyof NotificationRecipientReaders<Reader>,boolean>>=Object.freeze({
 probation:false,
 contract:true,
 onboardingDigest:true,
 assessmentReminder:true,
 rewardSuspension:true,
 rewardUploadChecker:true,
 rewardUploadReady:true,
 rewardRouted:true,
 rewardPreparationReleased:false,
 rewardPreparationChanged:false,
 rewardPreparationInvalidated:false,
 rewardPoolChanged:true,
 rewardApproved:true,
 rewardConfigChanged:false,
 rewardLimitsReapplied:false,
 leaveSubmitted:false,
 leaveCancellationSubmitted:false,
 overtimeSubmitted:false,
 readinessNudge:false,
 peerFeedback:false,
 assessmentReviewTask:false,
 assessmentKpiApproval:false,
 legacyReviewStarted:false,
 legacyReviewEvaluated:false,
 legacyReviewDecidedLetter:false,
 legacyReviewReminder:false,
 delegationStarted:true,
 delegationEnded:true,
 leaveEscalation:false,
 automaticReviewChase:false,
 missingClockFollowup:false,
 passportFollowup:false,
 lifecycleFollowup:false,
 employeeLoopDigest:false,
 noticePublished:true,
 payrollClosed:true,
 approvalChase:false,
 bulkJobInitiator:false,
});
export function nativeNotificationRecipeImplemented(spec:Pick<NotificationSpec<Reader>,'recipientAudience'|'recipientPort'>,version:2|3){
 if(spec.recipientAudience==='subject'||spec.recipientAudience==='none')return true;
 return spec.recipientAudience==='reader'&&spec.recipientPort!==undefined&&nativeNotificationReaderSupport[spec.recipientPort]===true
  &&(spec.recipientPort!=='assessmentReminder'||version===3);
}
const registry=createNotificationRegistry(nativeReaders);
/** Owner-installed closed metadata, derived from the single canonical registry.
 * The service has no installation API or authority to alter this contract. */
function projectionContract(version:2|3){return Object.entries(registry).flatMap(([eventType,entry])=>(Array.isArray(entry)?entry:[entry]).map(spec=>({
 eventType,kind:spec.kind,category:spec.category,recipientPort:spec.recipientPort??null,
 audience:spec.recipientAudience,guard:spec.recipientGuard??null,
 implemented:nativeNotificationRecipeImplemented(spec,version),
})));}
export const notificationWorkerProjectionContract=projectionContract(2);
export const notificationWorkerAssessmentContract=projectionContract(3);

/** Commit is awaited before native counters leave this method. Unsupported facts
 * and any project/preparation/settlement error roll back the complete admission. */
export function notificationWorkerProjection(connection:Sql){
 if(connection.options.max!==1)throw Error('Notification projection requires one dedicated physical connection');
 return {
  async projectBatch(run:string,tenant:string,count=100){
   return connection.begin(async tx=>{
    const [opened]=await tx<{id:string}[]>`select notification_worker.open_batch(${run}::uuid,${tenant}::uuid,${count}::integer) as id`;
    const events=await tx<NativeNotificationEvent[]>`select * from notification_worker.events(${opened.id}::uuid)`;
    const reader={tx,batch:opened.id};
    for(const ev of events){
     const event:EventRef={id:ev.event_id,aggregateId:ev.aggregate_id,subjectEmploymentId:ev.subject_employment_id};
     const entry=registry[ev.event_type],specs=Array.isArray(entry)?entry:entry?[entry]:[];
     // The commissioned sweep owns digest delivery until the native receipt can prove current AI and case authority.
     if(specs.some(spec=>spec.recipientPort==='employeeLoopDigest'&&!nativeNotificationReaderSupport.employeeLoopDigest))throw new UnsupportedNotificationFacts();
     const admission=meta.parse(await facts(reader,event,'meta'));
     if(admission.known!==!!entry)throw new UnsupportedNotificationFacts();
     if(!entry||admission.obsolete){await tx`select notification_worker.finish_event(${opened.id}::uuid,${ev.event_id}::uuid,'ignored')`;continue;}
     if(!admission.implemented)throw new UnsupportedNotificationFacts();
     if(ev.event_type==='reward-access.suspended')await tx`select notification_worker.project_reward_account(${opened.id}::uuid,${ev.event_id}::uuid)`;
     const value=payload.parse(ev.payload);
     for(const spec of specs){
      const recipients=spec.recipients?await spec.recipients(reader,event,value):event.subjectEmploymentId?[event.subjectEmploymentId]:[];
      if(!recipients.length)continue;
      const rendered=spec.render(value,event);
      for(const recipient of recipients)await tx`select * from notification_worker.project(${opened.id}::uuid,${ev.event_id}::uuid,${spec.kind}::text,${recipient}::uuid,${tx.json(rendered)}::jsonb,${spec.category}::text)`;
     }
     await tx`select notification_worker.finish_event(${opened.id}::uuid,${ev.event_id}::uuid,'processed')`;
    }
    const [result]=await tx<{processed:number;created:number}[]>`select * from notification_worker.finish_batch(${opened.id}::uuid)`;
    return result;
   });
  },
 };
}
