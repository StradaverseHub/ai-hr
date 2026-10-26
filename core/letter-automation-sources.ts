/** Purpose-bound discovery only; generation still requires an explicit registered draft job. */
import {createHash} from 'node:crypto';
import {and,asc,eq,gt,gte,inArray,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {employment,letterAutomationRuleVersion} from '../db/schema';
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
export async function readLetterAutomationSourcesTx(tx:Tx,ctx:SessionContext,ruleId:string,input:{afterEmploymentId?:string;limit?:number;today?:string}={}){
 const limit=input.limit??25,today=input.today??todayInKualaLumpur();
 if(ctx.userId||!uuid.test(ctx.tenantId)||!uuid.test(ruleId)||input.afterEmploymentId&&!uuid.test(input.afterEmploymentId)||!Number.isInteger(limit)||limit<1||limit>100||!isCalendarDate(today))throw new LetterWorkflowError('invalid','automation');
 await assertLetterNotificationConnection(tx);const [context]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id() is null as ok`);if(!context?.ok)throw new LetterWorkflowError('permission');
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
 const [rule]=await tx.select().from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.id,ruleId),eq(letterAutomationRuleVersion.tenantId,ctx.tenantId),eq(letterAutomationRuleVersion.enabled,true),sql`not exists(select 1 from letter_automation_rule_version newer where newer.tenant_id=${letterAutomationRuleVersion.tenantId} and newer.company_id=${letterAutomationRuleVersion.companyId} and newer.template_id=${letterAutomationRuleVersion.templateId} and newer.trigger=${letterAutomationRuleVersion.trigger} and newer.ordinal>${letterAutomationRuleVersion.ordinal})`));
 if(!rule)return {rule:null,rows:[] as LetterAutomationSource[],nextCursor:null};
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.letter_automation_owner_eligible_at(${ctx.tenantId}::uuid,${rule.createdBy}::uuid,${rule.companyId}::uuid,${rule.confidential}) as ok`);if(!authority?.ok)throw new LetterWorkflowError('permission');
 const entitlements=await resolveEntitlementsTx(tx,ctx.tenantId);if(!isModuleEnabled({...ctx,entitlements},'employees',rule.companyId))throw new LetterWorkflowError('permission');
 const date=confirmationDateSql(),subjects=await tx.select({id:employment.id,confirmationDate:date}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,rule.companyId),lte(employment.hiredOn,today),inArray(employmentStatusSql(today),['active','active_serving_notice','probation']),input.afterEmploymentId?gt(employment.id,input.afterEmploymentId):undefined,rule.trigger==='probation_due'?and(gte(date,rule.startOn),lte(date,today)):undefined)).orderBy(asc(employment.id)).limit(limit+1);
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
