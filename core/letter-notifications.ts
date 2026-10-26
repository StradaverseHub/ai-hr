/** Durable Letters jobs project into the canonical bell. No web principal is borrowed by the sweep. */
import {and,asc,eq,inArray,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {letterJob,letterRecord,letterPolicyVersion,letterGenerationBatch,letterApprovalDecision,letterArtifact,letterRecipientEvent,domainEvent,notification,appUser,employment} from '../db/schema';
import type {NotificationSweepConnection} from './notice-projection';
import {validateLetterPolicy} from '../lib/letter-workflow';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {letterStageEnteredAt} from './letter-stage-clock';
import {resolveEntitlementsTx,isModuleEnabled} from './entitlements';

async function assertConnection(tx:Tx){
 const [proof]=await tx.execute<{ok:boolean}>(sql`select app.letter_notification_storage_owner() as ok`);
 if(proof?.ok!==true)throw Error('Letters notification projection requires its maintenance connection.');
}
async function recipientEligible(tx:Tx,userId:string,companyId:string,confidential:boolean){
 const [target]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${userId}::uuid,${companyId}::uuid,'read') and app.letter_permission_for_user(${userId}::uuid,${companyId}::uuid,'approve')
  and (not ${confidential} or app.grants_payroll_admin_for((select jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)) from role_assignment r where r.tenant_id=app.current_tenant_id() and r.app_user_id=${userId}::uuid),${companyId}::uuid)) as ok`);
 return target?.ok===true;
}
async function projectJob(tx:Tx,ctx:SessionContext,id:string){
 await assertConnection(tx);await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
 const [job]=await tx.select().from(letterJob).where(and(eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.id,id),inArray(letterJob.status,['queued','failed']),lte(letterJob.dueAt,sql`now()`))).for('update');
 if(!job)return {created:0,cancelled:0,deferredEmail:0};
 const cancel=async()=>{await tx.update(letterJob).set({status:'cancelled',lastError:null,leaseToken:null,leaseUntil:null}).where(eq(letterJob.id,id));return {created:0,cancelled:1,deferredEmail:0};};
 if(!job.letterId||!job.sourceEventId||!job.recipientUserId||job.kind==='eventDraft')return cancel();
 const [record]=await tx.select().from(letterRecord).where(and(eq(letterRecord.id,job.letterId),eq(letterRecord.tenantId,ctx.tenantId),eq(letterRecord.companyId,job.companyId)));
 const [source]=await tx.select().from(domainEvent).where(and(eq(domainEvent.id,job.sourceEventId),eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'letter'),eq(domainEvent.aggregateId,job.letterId)));
 if(!record||!source)return cancel();
 const entitlements=await resolveEntitlementsTx(tx,ctx.tenantId);if(!isModuleEnabled({...ctx,entitlements},'notifications',record.companyId))return cancel();
 const [configuration]=await tx.select({policy:letterPolicyVersion.policy}).from(letterGenerationBatch).innerJoin(letterPolicyVersion,and(eq(letterPolicyVersion.id,letterGenerationBatch.policyVersionId),eq(letterPolicyVersion.tenantId,letterGenerationBatch.tenantId))).where(and(eq(letterGenerationBatch.id,record.batchId),eq(letterGenerationBatch.tenantId,ctx.tenantId)));
 if(!configuration)return cancel();const policy=validateLetterPolicy(configuration.policy);
 if(!policy.portalNotifications&&!policy.emailNotifications)return cancel();
 const sourcePayload=source.payload as Record<string,unknown>|null;
 let kind:'approval'|'approvalReminder'|'escalation'|'issued'|'acknowledgementReminder',dueAt:Date|null=null;
 if(job.payload.artifactId){
  if(!['notification','acknowledgementReminder'].includes(job.kind)||record.state!=='issued'||source.eventType!=='letter.issued'||sourcePayload?.artifactId!==job.payload.artifactId)return cancel();
  const [artifact]=await tx.select().from(letterArtifact).where(and(eq(letterArtifact.id,String(job.payload.artifactId)),eq(letterArtifact.letterId,record.id),eq(letterArtifact.revisionId,record.currentRevisionId!)));
  const [recipient]=await tx.select({id:appUser.id}).from(appUser).innerJoin(employment,and(eq(employment.personId,appUser.personId),eq(employment.tenantId,appUser.tenantId))).where(and(eq(appUser.id,job.recipientUserId),eq(appUser.tenantId,ctx.tenantId),eq(employment.id,record.employmentId),sql`${appUser.archivedAt} is null and not app.login_blocked(${appUser.id})`));
  if(!artifact||!recipient)return cancel();
  kind=job.kind==='notification'?'issued':'acknowledgementReminder';
  if(job.dedupeKey!==`${record.id}:${artifact.id}:issued:${job.recipientUserId}${kind==='acknowledgementReminder'?':acknowledgement':''}`)return cancel();
  if(kind==='acknowledgementReminder'){
   if(policy.acknowledgement==='none')return cancel();
   const [confirmed]=await tx.select({id:letterRecipientEvent.id}).from(letterRecipientEvent).where(and(eq(letterRecipientEvent.artifactId,artifact.id),eq(letterRecipientEvent.tenantId,ctx.tenantId),eq(letterRecipientEvent.kind,policy.acknowledgement==='signature'?'signed':'acknowledged'))).limit(1);if(confirmed)return cancel();
   const [clock]=await tx.execute<{due_at:string|Date}>(sql`select issued_at+${policy.acknowledgementDueDays}*interval '1 day' as due_at from letter_record stage_clock where stage_clock.id=${record.id}::uuid`);dueAt=clock?.due_at?new Date(clock.due_at):null;
  }
 }else{
  if(record.state!=='submitted'||job.payload.revisionId!==record.currentRevisionId||job.payload.stageIndex!==record.stageIndex||sourcePayload?.revisionId!==record.currentRevisionId||!['notification','approvalReminder','escalation'].includes(job.kind))return cancel();
  const [delegation]=await tx.select().from(letterApprovalDecision).where(and(eq(letterApprovalDecision.revisionId,record.currentRevisionId!),eq(letterApprovalDecision.stageIndex,record.stageIndex),eq(letterApprovalDecision.action,'delegate'))).orderBy(sql`${letterApprovalDecision.createdAt} desc`,sql`${letterApprovalDecision.id} desc`).limit(1);
  const suffix=delegation?':delegation:'+delegation.id:'';
  if(delegation){if(source.eventType!=='letter.approval.delegated'||sourcePayload?.decisionId!==delegation.id)return cancel();}
  else if(record.stageIndex===0){if(source.eventType!=='letter.submitted')return cancel();}
  else{
   const [previous]=await tx.select({id:letterApprovalDecision.id}).from(letterApprovalDecision).where(and(eq(letterApprovalDecision.revisionId,record.currentRevisionId!),eq(letterApprovalDecision.stageIndex,record.stageIndex-1),eq(letterApprovalDecision.action,'approve')));
   if(!previous||source.eventType!=='letter.approval.approve'||sourcePayload?.decisionId!==previous.id)return cancel();
  }
  kind=job.kind==='notification'?'approval':job.kind as 'approvalReminder'|'escalation';
  const audience=delegation?[delegation.delegatedTo]:policy.stages[record.stageIndex]?.userIds??[];
  if(kind==='escalation'?policy.escalationUserId!==job.recipientUserId:job.recipientUserId===record.createdBy||!audience.includes(job.recipientUserId))return cancel();
  if(!await recipientEligible(tx,job.recipientUserId,record.companyId,record.confidential))return cancel();
  const key=kind==='escalation'?`${record.id}:${record.currentRevisionId}:${record.stageIndex}:escalation${suffix}`:`${record.id}:${record.currentRevisionId}:stage:${record.stageIndex}:${job.recipientUserId}${suffix}${kind==='approvalReminder'?':reminder':''}`;
  if(job.dedupeKey!==key)return cancel();
  if(kind!=='approval'){
   const [clock]=await tx.execute<{due_at:string|Date}>(sql`select ${letterStageEnteredAt(sql`stage_clock.stage_index`,sql`stage_clock.submitted_at`,sql`stage_clock.current_revision_id`)}+${kind==='escalation'?policy.approvalDueHours:policy.reminderHours}*interval '1 hour' as due_at from letter_record stage_clock where stage_clock.id=${record.id}::uuid`);dueAt=clock?.due_at?new Date(clock.due_at):null;
  }
 }
 if(dueAt){const [clock]=await tx.execute<{pending:boolean}>(sql`select ${dueAt.toISOString()}::timestamptz>now() as pending`);if(clock?.pending){await tx.update(letterJob).set({dueAt,lastError:null}).where(eq(letterJob.id,id));return {created:0,cancelled:0,deferredEmail:0};}}
 else if(['approvalReminder','escalation','acknowledgementReminder'].includes(kind))return cancel();
 let created=0;
 if(policy.portalNotifications){
  const rows=await tx.insert(notification).values({tenantId:ctx.tenantId,recipientUserId:job.recipientUserId,letterJobId:job.id,companyId:record.companyId,kind:'letter.'+kind,title:'letters.notifications.'+kind,body:'letters.notifications.body',sourceEventId:source.id,linkPath:(kind==='issued'||kind==='acknowledgementReminder'?'/me/letters/':'/letters/approval/')+record.id,severity:kind==='issued'?'info':'action'}).onConflictDoNothing().returning({id:notification.id});created=rows.length;
 }
 // Email consent and private sender support are a separate delivery gate. Never call a portal
 // projection "sent", and never drop a queued email obligation after merely creating a bell row.
 await tx.update(letterJob).set({status:policy.emailNotifications?'queued':'completed',attempts:job.attempts+1,lastError:policy.emailNotifications?'emailTransportUnavailable':null,dueAt:policy.emailNotifications?sql`now()+interval '5 minutes'`:job.dueAt,leaseToken:null,leaseUntil:null}).where(eq(letterJob.id,id));
 return {created,cancelled:0,deferredEmail:policy.emailNotifications?1:0};
}
export async function projectLetterNotificationsFromSweep(ctx:SessionContext,connection:NotificationSweepConnection,limit=100){
 if(ctx.userId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ctx.tenantId)||!Number.isInteger(limit)||limit<1||limit>500)throw Error('Letters projection requires a tenant-bound maintenance context.');
 const ids=await connection.withTenant(ctx,async tx=>{await assertConnection(tx);return tx.select({id:letterJob.id}).from(letterJob).where(and(eq(letterJob.tenantId,ctx.tenantId),inArray(letterJob.status,['queued','failed']),lte(letterJob.dueAt,sql`now()`),sql`${letterJob.kind}<>'eventDraft'`)).orderBy(asc(letterJob.dueAt),asc(letterJob.id)).limit(limit);},{readOnlySnapshot:true});
 const result={created:0,cancelled:0,deferredEmail:0,failed:0};
 for(const {id}of ids){try{const outcome=await connection.withTenant(ctx,tx=>projectJob(tx,ctx,id));result.created+=outcome.created;result.cancelled+=outcome.cancelled;result.deferredEmail+=outcome.deferredEmail;}catch{
  result.failed++;await connection.withTenant(ctx,async tx=>{await assertConnection(tx);await tx.update(letterJob).set({status:'failed',attempts:sql`${letterJob.attempts}+1`,lastError:'projectionUnavailable',dueAt:sql`now()+interval '5 minutes'`}).where(and(eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.id,id),inArray(letterJob.status,['queued','failed'])));});
 }}return result;
}
