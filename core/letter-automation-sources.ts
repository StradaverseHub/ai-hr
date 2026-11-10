/** Purpose-bound discovery only; generation still requires an explicit registered draft job. */
import {createHash} from 'node:crypto';
import {and,asc,eq,gt,gte,inArray,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {employment,letterAutomationRuleVersion,letterJob} from '../db/schema';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {LetterWorkflowError} from '../lib/letter-workflow';
import {confirmationDateSql,employmentStatusSql} from './employment-status-sql';
import {resolveEntitlementsTx,isModuleEnabled} from './entitlements';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {movementAutomationFactsTx} from './movement';
import {assertLetterNotificationConnection} from './letter-notifications';
export type LetterAutomationSource={employmentId:string;sourceKey:string;sourceFingerprint:string;sourceEventId:string|null;sourceSequence:number|null;sourceAsOfDate:string};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Bounded discovery under the real maintenance login. Neither a forged web role nor
 * a borrowed author context can read employee facts through this seam. */
export async function readLetterAutomationSourcesTx(tx:Tx,ctx:SessionContext,ruleId:string,input:{afterEmploymentId?:string;employmentId?:string;limit?:number;today?:string}={}){
 const limit=input.limit??25,today=input.today??todayInKualaLumpur();
 if(ctx.userId||!uuid.test(ctx.tenantId)||!uuid.test(ruleId)||input.afterEmploymentId&&!uuid.test(input.afterEmploymentId)||input.employmentId&&!uuid.test(input.employmentId)||!Number.isInteger(limit)||limit<1||limit>100||!isCalendarDate(today))throw new LetterWorkflowError('invalid','automation');
 await assertLetterNotificationConnection(tx);const [context]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id() is null as ok`);if(!context?.ok)throw new LetterWorkflowError('permission');
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
 const [rule]=await tx.select().from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.id,ruleId),eq(letterAutomationRuleVersion.tenantId,ctx.tenantId),eq(letterAutomationRuleVersion.enabled,true),sql`not exists(select 1 from letter_automation_rule_version newer where newer.tenant_id=${letterAutomationRuleVersion.tenantId} and newer.company_id=${letterAutomationRuleVersion.companyId} and newer.template_id=${letterAutomationRuleVersion.templateId} and newer.trigger=${letterAutomationRuleVersion.trigger} and newer.ordinal>${letterAutomationRuleVersion.ordinal})`));
 if(!rule)return {rule:null,rows:[] as LetterAutomationSource[],nextCursor:null};
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.letter_automation_owner_eligible_at(${ctx.tenantId}::uuid,${rule.createdBy}::uuid,${rule.companyId}::uuid,${rule.confidential}) as ok`);if(!authority?.ok)throw new LetterWorkflowError('permission');
 const entitlements=await resolveEntitlementsTx(tx,ctx.tenantId);if(!isModuleEnabled({...ctx,entitlements},'employees',rule.companyId))throw new LetterWorkflowError('permission');
 return sourcesForRule(tx,ctx,rule,{...input,limit,today},true);
}
async function sourcesForRule(tx:Tx,ctx:SessionContext,rule:typeof letterAutomationRuleVersion.$inferSelect,input:{afterEmploymentId?:string;employmentId?:string;limit:number;today:string},activeOnly:boolean){
 const {limit,today}=input;
 const date=confirmationDateSql(),subjects=await tx.select({id:employment.id,confirmationDate:date}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,rule.companyId),activeOnly?lte(employment.hiredOn,today):undefined,activeOnly?inArray(employmentStatusSql(today),['active','active_serving_notice','probation']):undefined,input.employmentId?eq(employment.id,input.employmentId):undefined,input.afterEmploymentId?gt(employment.id,input.afterEmploymentId):undefined,rule.trigger==='probation_due'?and(gte(date,rule.startOn),lte(date,today)):undefined)).orderBy(asc(employment.id)).limit(limit+1);
 const rows:LetterAutomationSource[]=[];
 for(const subject of subjects.slice(0,limit)){
  if(rule.trigger==='probation_due'){
   if(subject.confirmationDate){const sourceKey='probation:'+subject.id+':'+subject.confirmationDate;rows.push({employmentId:subject.id,sourceKey,sourceFingerprint:fingerprint({sourceKey}),sourceEventId:null,sourceSequence:null,sourceAsOfDate:subject.confirmationDate});}
   continue;
  }
  const kind=rule.trigger==='promotion_applied'?'promotion':'confirmation',facts=await movementAutomationFactsTx(tx,{tenantId:ctx.tenantId,companyId:rule.companyId,employmentId:subject.id,today});
  for(const fact of facts){if(fact.kind!==kind||fact.status!=='applied'||fact.sourceSequence===null||fact.sourceEventId===null||fact.sourceSequence<=rule.afterSequence||fact.effectiveDate<rule.startOn||fact.effectiveDate>today)continue;const sourceKey='movement:'+fact.movementId;rows.push({employmentId:subject.id,sourceKey,sourceFingerprint:fingerprint({sourceKey,kind:fact.kind,effectiveDate:fact.effectiveDate,sourceEventId:fact.sourceEventId,sourceSequence:fact.sourceSequence}),sourceEventId:fact.sourceEventId,sourceSequence:fact.sourceSequence,sourceAsOfDate:fact.effectiveDate});}
 }
 return {rule,rows,nextCursor:subjects.length>limit?subjects[limit-1].id:null};
}

export type LetterAutomationIntent=LetterAutomationSource&{ruleVersionId:string;batchId:string};
export function parseLetterAutomationIntent(value:unknown):LetterAutomationIntent{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new LetterWorkflowError('invalid','automation');
 const data=value as Record<string,unknown>,keys=['employmentId','sourceKey','sourceFingerprint','sourceEventId','sourceSequence','sourceAsOfDate','ruleVersionId','batchId'];
 if(Object.keys(data).length!==keys.length||keys.some(key=>!Object.hasOwn(data,key))||['employmentId','ruleVersionId','batchId'].some(key=>typeof data[key]!=='string'||!uuid.test(data[key] as string))||typeof data.sourceKey!=='string'||data.sourceKey.length>100||typeof data.sourceFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(data.sourceFingerprint)||typeof data.sourceAsOfDate!=='string'||!isCalendarDate(data.sourceAsOfDate)||data.sourceEventId!==null&&(typeof data.sourceEventId!=='string'||!uuid.test(data.sourceEventId))||data.sourceSequence!==null&&(!Number.isSafeInteger(data.sourceSequence)||(data.sourceSequence as number)<1)||(data.sourceEventId===null)!==(data.sourceSequence===null))throw new LetterWorkflowError('invalid','automation');
 if(data.sourceKey!==('probation:'+data.employmentId+':'+data.sourceAsOfDate)&&!(data.sourceKey.startsWith('movement:')&&uuid.test(data.sourceKey.slice(9))))throw new LetterWorkflowError('invalid','automation');
 return data as LetterAutomationIntent;
}
/** Historical source validation is bound to an existing immutable job, not current rule
 * enablement or the creator's later access. It cannot change an issued artifact. */
export async function readRegisteredLetterAutomationSourceTx(tx:Tx,ctx:SessionContext,jobId:string){
 if(ctx.userId||!uuid.test(ctx.tenantId)||!uuid.test(jobId))throw new LetterWorkflowError('permission');await assertLetterNotificationConnection(tx);
 const [context]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id() is null as ok`);if(!context?.ok)throw new LetterWorkflowError('permission');
 const [job]=await tx.select().from(letterJob).where(and(eq(letterJob.id,jobId),eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.kind,'eventDraft')));if(!job)return null;const intent=parseLetterAutomationIntent(job.payload);
 const [rule]=await tx.select().from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.id,intent.ruleVersionId),eq(letterAutomationRuleVersion.tenantId,ctx.tenantId),eq(letterAutomationRuleVersion.companyId,job.companyId)));if(!rule||intent.sourceEventId!==job.sourceEventId)throw new LetterWorkflowError('configuration','automation');
 const facts=await sourcesForRule(tx,ctx,rule,{employmentId:intent.employmentId,limit:1,today:todayInKualaLumpur()},false);
 const current=facts.rows.some(row=>row.sourceKey===intent.sourceKey&&row.sourceFingerprint===intent.sourceFingerprint&&row.sourceEventId===intent.sourceEventId&&row.sourceSequence===intent.sourceSequence&&row.sourceAsOfDate===intent.sourceAsOfDate);
 return {job,rule,intent,current};
}
