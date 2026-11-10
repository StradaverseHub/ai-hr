/** Configured events create drafts only. The existing Letters job ledger owns retries and provenance. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,gt,inArray,lte,or,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {letterAutomationRuleVersion,letterJob,letterGenerationBatch,letterRecord} from '../db/schema';
import type {NotificationSweepConnection} from './notice-projection';
import {assertLetterNotificationConnection} from './letter-notifications';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {readLetterAutomationSourcesTx,readRegisteredLetterAutomationSourceTx} from './letter-automation-sources';
import {createAutomaticLetterDraftTx} from './letters';
async function locks(tx:Tx,ctx:SessionContext){
 await assertLetterNotificationConnection(tx);const [proof]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id() is null as ok`);if(!proof?.ok)throw Error('Letter automation requires its tenant-bound maintenance connection.');
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
}
async function invalidate(tx:Tx,ctx:SessionContext,jobId:string){
 await locks(tx,ctx);const source=await readRegisteredLetterAutomationSourceTx(tx,ctx,jobId);if(!source||source.job.status!=='completed')return 'skipped';
 const [row]=await tx.select({record:letterRecord}).from(letterGenerationBatch).innerJoin(letterRecord,and(eq(letterRecord.batchId,letterGenerationBatch.id),eq(letterRecord.tenantId,letterGenerationBatch.tenantId))).where(and(eq(letterGenerationBatch.tenantId,ctx.tenantId),eq(letterGenerationBatch.operationKey,jobId),eq(letterGenerationBatch.id,source.intent.batchId))).for('update');
 if(!row||row.record.employmentId!==source.intent.employmentId||row.record.state==='withdrawn'||['sourceChanged','issuedSourceChanged'].includes(source.job.lastError??''))return 'skipped';
 if(source.current){if(source.job.lastError)await tx.update(letterJob).set({lastError:null,dueAt:sql`now()`}).where(eq(letterJob.id,jobId));return 'skipped';}
 const preserved=['issued','void'].includes(row.record.state),lastError=preserved?'issuedSourceChanged':'sourceChanged';
 await tx.update(letterJob).set({lastError,leaseToken:randomUUID(),leaseUntil:sql`now()+interval '2 minutes'`}).where(eq(letterJob.id,jobId));
 if(!preserved){
  await tx.update(letterRecord).set({state:'withdrawn',stageIndex:0,lockVersion:row.record.lockVersion+1}).where(eq(letterRecord.id,row.record.id));
  await tx.update(letterJob).set({status:'cancelled',lastError:null,leaseToken:null,leaseUntil:null}).where(and(eq(letterJob.letterId,row.record.id),inArray(letterJob.status,['queued','failed'])));
 }
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'letter',aggregateId:row.record.id,eventType:'letter.automation.source-invalidated',actor:actorOf(ctx),subjectEmploymentId:row.record.employmentId,payload:{jobId,ruleVersionId:source.rule.id,sourceEventId:source.job.sourceEventId,sourceFingerprint:source.intent.sourceFingerprint,responsibleUserId:source.rule.createdBy,issuedArtifactPreserved:preserved}});
 await tx.update(letterJob).set({leaseToken:null,leaseUntil:null}).where(eq(letterJob.id,jobId));return preserved?'flagged':'withdrawn';
}
export async function sweepLetterAutomationFromSweep(ctx:SessionContext,connection:NotificationSweepConnection){
 if(ctx.userId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ctx.tenantId))throw Error('Letter automation requires a maintenance context.');
 // This is the canonical maintenance role, authenticated by the storage-owner proof,
 // not a user identity or an adopted rule-author session. Audit actors remain SYSTEM.
 const system:SessionContext={...ctx,roles:['hr_admin']},result={registered:0,created:0,cancelled:0,withdrawn:0,flagged:0,failed:0,cappedOut:false};
 await connection.withTenant(system,tx=>locks(tx,system));
 let ruleCursor:string|undefined;
 do{
  const rules=await connection.withTenant(system,async tx=>{await assertLetterNotificationConnection(tx);return tx.select({id:letterAutomationRuleVersion.id}).from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.tenantId,ctx.tenantId),eq(letterAutomationRuleVersion.enabled,true),ruleCursor?gt(letterAutomationRuleVersion.id,ruleCursor):undefined,sql`not exists(select 1 from letter_automation_rule_version newer where newer.tenant_id=${letterAutomationRuleVersion.tenantId} and newer.company_id=${letterAutomationRuleVersion.companyId} and newer.template_id=${letterAutomationRuleVersion.templateId} and newer.trigger=${letterAutomationRuleVersion.trigger} and newer.ordinal>${letterAutomationRuleVersion.ordinal})`)).orderBy(asc(letterAutomationRuleVersion.id)).limit(50);});
  for(const rule of rules){let afterEmploymentId:string|undefined;try{do{
   const page=await connection.withTenant(system,async tx=>{
    const page=await readLetterAutomationSourcesTx(tx,system,rule.id,{afterEmploymentId,limit:100});if(!page.rule)return {registered:0,nextCursor:null};let registered=0;
    for(const source of page.rows){const inserted=await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:page.rule.companyId,kind:'eventDraft',recipientUserId:page.rule.createdBy,sourceEventId:source.sourceEventId,dedupeKey:`automation:${page.rule.templateId}:${page.rule.trigger}:${source.employmentId}:${source.sourceFingerprint}:${page.rule.id}`,payload:{...source,ruleVersionId:page.rule.id,batchId:randomUUID()},dueAt:sql`now()`}).onConflictDoNothing().returning({id:letterJob.id});registered+=inserted.length;}
    return {registered,nextCursor:page.nextCursor};
   });result.registered+=page.registered;afterEmploymentId=page.nextCursor??undefined;
  }while(afterEmploymentId);}catch{result.failed++;}}
  ruleCursor=rules.length===50?rules.at(-1)!.id:undefined;
 }while(ruleCursor);
 const pending=await connection.withTenant(system,async tx=>{await assertLetterNotificationConnection(tx);return tx.select({id:letterJob.id}).from(letterJob).where(and(eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.kind,'eventDraft'),inArray(letterJob.status,['queued','failed']),lte(letterJob.dueAt,sql`now()`),or(isNull(letterJob.leaseUntil),lte(letterJob.leaseUntil,sql`now()`)))).orderBy(asc(letterJob.dueAt),asc(letterJob.createdAt),asc(letterJob.id)).limit(100);});
 result.cappedOut=pending.length===100;
 for(const job of pending){try{const outcome=await connection.withTenant(system,tx=>createAutomaticLetterDraftTx(tx,system,job.id));if(outcome.cancelled)result.cancelled++;else if(outcome.batchId&&!outcome.alreadyCreated)result.created++;}catch{
  result.failed++;await connection.withTenant(system,async tx=>{await locks(tx,system);await tx.update(letterJob).set({status:'failed',attempts:sql`${letterJob.attempts}+1`,lastError:'automationUnavailable',dueAt:sql`now()+interval '5 minutes'`,leaseToken:null,leaseUntil:null}).where(and(eq(letterJob.id,job.id),eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.kind,'eventDraft'),inArray(letterJob.status,['queued','failed'])));});
 }}
 let jobCursor:string|undefined;
 do{
  const completed=await connection.withTenant(system,async tx=>{await assertLetterNotificationConnection(tx);return tx.select({id:letterJob.id}).from(letterJob).innerJoin(letterGenerationBatch,and(eq(letterGenerationBatch.operationKey,letterJob.id),eq(letterGenerationBatch.tenantId,letterJob.tenantId))).innerJoin(letterRecord,and(eq(letterRecord.batchId,letterGenerationBatch.id),eq(letterRecord.tenantId,letterJob.tenantId))).where(and(eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.kind,'eventDraft'),eq(letterJob.status,'completed'),lte(letterJob.dueAt,sql`now()`),jobCursor?gt(letterJob.id,jobCursor):undefined,sql`${letterRecord.state}<>'withdrawn' and coalesce(${letterJob.lastError},'') not in ('sourceChanged','issuedSourceChanged')`)).orderBy(asc(letterJob.id)).limit(100);});
  for(const job of completed){try{const state=await connection.withTenant(system,tx=>invalidate(tx,system,job.id));if(state==='flagged')result.flagged++;else if(state==='withdrawn')result.withdrawn++;}catch{
   result.failed++;await connection.withTenant(system,async tx=>{await locks(tx,system);await tx.update(letterJob).set({lastError:'sourceCheckUnavailable',attempts:sql`${letterJob.attempts}+1`,dueAt:sql`now()+interval '5 minutes'`,leaseToken:null,leaseUntil:null}).where(and(eq(letterJob.id,job.id),eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.status,'completed')));});
  }}
  jobCursor=completed.length===100?completed.at(-1)!.id:undefined;
 }while(jobCursor);
 return result;
}
