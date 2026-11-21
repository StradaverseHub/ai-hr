/** Exact event-bound native reminder facts; no app pool, facade or SQL broker. */
import type {TransactionSql} from 'postgres';
import {z} from 'zod';
import {getSetting,toSnapshot} from '../../core/entitlements';
import {assessmentReminderWordsSchema} from '../assessment-reminder-mail';
import {policySchema,tiers} from '../../packs/performance/onehr/model';
import {assessmentReminderRulesSchema,defaultAssessmentReminderRules} from '../../packs/performance/onehr/reminder-model';
import {assessmentReminderProjectionWork,assessmentReminderProjectionRoutes,assessmentReminderProjectionExpiry} from '../../packs/performance/onehr/reminder-projection';
import {assessmentReminderPreparationStart,assessmentReminderPreparationRoute,assessmentReminderPreparationCurrent,assessmentReminderPreparationValue,type ReminderPreparationRefusal} from '../../packs/performance/onehr/reminder-preparation';
const uuid=z.uuid(),timestamp=z.iso.datetime({offset:true}),epochs=z.array(z.object({scopeId:uuid,revision:z.number().int().nonnegative().safe()}).strict()).max(2);
const kpi=z.object({hrOwned:z.boolean(),setting:z.enum(['draft','proposed','approved','returned']),locked:z.boolean(),moderatorEmploymentId:uuid.nullable(),checkIn:z.boolean(),approvalChain:z.array(z.object({employmentId:uuid,at:timestamp.nullable()}).strict()).max(10),settingApprovals:z.array(z.object({action:z.enum(['approved','returned'])}).strict()).max(10)}).strict();
const decision=z.object({tier:z.enum(tiers),performanceLocked:z.boolean(),potentialLocked:z.boolean()}).strict();
const graph=z.object({
 cycle:z.object({id:uuid,companyId:uuid.nullable(),name:z.string(),periodEnd:z.iso.date(),policy:z.object({kind:policySchema.shape.kind,modules:policySchema.shape.modules,windows:policySchema.shape.windows}).strict()}).strict(),
 actors:z.array(z.object({userId:uuid,personId:uuid,name:z.string(),employmentIds:z.array(uuid),cycleAdmin:z.boolean()}).strict()),
 reviews:z.array(z.object({id:uuid,companyId:uuid,employmentId:uuid,personId:uuid,name:z.string(),reviewerEmploymentId:uuid.nullable(),moderatorIds:z.array(uuid),frozen:z.boolean(),facts:z.object({kpis:z.array(kpi),competenciesAssigned:z.boolean(),competencyStatus:z.string(),resultsSubmitted:z.boolean(),managerPerformance:z.string().nullable(),planStatus:z.string().nullable()}).strict()}).strict()),
 panels:z.array(z.object({id:uuid,employmentId:uuid,reviewId:uuid}).strict()),
 sessions:z.array(z.object({id:uuid,companyId:uuid.nullable(),tier:z.enum(tiers),reviewerUserIds:z.array(uuid),adminUserIds:z.array(uuid),lockedAt:timestamp.nullable(),performanceLockedAt:timestamp.nullable(),potentialLockedAt:timestamp.nullable(),entries:z.array(z.object({reviewId:uuid,companyId:uuid,employmentId:uuid,personId:uuid,performanceLocked:z.boolean(),potentialLocked:z.boolean(),performanceReady:z.boolean(),frozen:z.boolean(),decisions:z.array(decision)}).strict())}).strict()),
}).strict();
export const nativeAssessmentReminderFacts=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('unavailable')}).strict(),
 z.object({kind:z.literal('ready'),tenantId:uuid,cycleId:uuid,userId:uuid,employmentId:uuid,mode:z.enum(['automatic','manual','dry']),epochs,graph:graph.nullable(),routes:z.array(z.object({user_id:uuid,employment_id:uuid,company_id:uuid}).strict()),startedAt:timestamp,moduleExpiry:timestamp.nullable(),snapshot:z.object({modules:z.array(z.object({code:z.string(),company:uuid.nullable()}).strict()),settings:z.record(z.string(),z.unknown()),tenant_status:z.string().nullable()}).strict()}).strict(),
]);
const checked=z.object({epochs,checkedAt:timestamp}).strict();
async function facts(tx:TransactionSql,batch:string,event:string,family:'assessment-reminder'|'assessment-reminder-current'|'assessment-reminder-words'|'assessment-reminder-cooldown'){
 const [row]=await tx<{value:unknown}[]>`select notification_worker.facts(${batch}::uuid,${event}::uuid,${family}::text) as value`;return row.value;
}
export async function prepareNativeAssessmentReminder(tx:TransactionSql,batch:string,event:string){
 const first=nativeAssessmentReminderFacts.parse(await facts(tx,batch,event,'assessment-reminder'));
 const apply=async(value:{kind:'noop'}|{kind:'skip';outcome:ReminderPreparationRefusal}|({kind:'prepare'}&ReturnType<typeof assessmentReminderPreparationValue>))=>{
  const [row]=await tx<{recipients:unknown}[]>`select notification_worker.prepare_assessment(${batch}::uuid,${event}::uuid,${tx.json(value)}::jsonb) as recipients`;
  return z.array(uuid).parse(row.recipients);
 };
 if(first.kind==='unavailable')return apply({kind:'noop'});
 const ctx={tenantId:first.tenantId,entitlements:toSnapshot(first.tenantId,first.snapshot)},now=new Date(first.startedAt);
 const current=assessmentReminderProjectionWork(first.graph,ctx,now),actor=current?.recipients.find(row=>row.userId===first.userId);
 let automaticEnabled=true;
 if(first.mode==='automatic'){try{automaticEnabled=assessmentReminderRulesSchema.parse(JSON.parse(getSetting<string>(ctx,'performance.reminder_rules'))).enabled;}catch{automaticEnabled=defaultAssessmentReminderRules.enabled;}}
 const start=assessmentReminderPreparationStart(first.mode,automaticEnabled,first.employmentId,actor);if(start)return apply({kind:'skip',outcome:start});
 if(!actor||!current)throw Error('Canonical reminder preparation actor is unavailable');
 const routes=assessmentReminderProjectionRoutes(first.routes,ctx),route=assessmentReminderPreparationRoute(z.boolean().parse(await facts(tx,batch,event,'assessment-reminder-cooldown')),routes.get(actor.userId),first.employmentId);if(route)return apply({kind:'skip',outcome:route});
 const expiry=assessmentReminderProjectionExpiry(now,current.graph,first.moduleExpiry?new Date(first.moduleExpiry):null),proof=checked.parse(await facts(tx,batch,event,'assessment-reminder-current'));
 if(!assessmentReminderPreparationCurrent(first.epochs,proof.epochs,expiry,Date.parse(proof.checkedAt)))return apply({kind:'skip',outcome:'changed'});
 // Use the proved native current clock for this port's actual preparation interval.
 const preparedAt=new Date(proof.checkedAt),configured=assessmentReminderWordsSchema.nullable().safeParse(await facts(tx,batch,event,'assessment-reminder-words'));
 const value=assessmentReminderPreparationValue({actor,name:current.graph.actors.find(row=>row.userId===actor.userId)!.name,cycleName:current.graph.cycle.name,cycleId:first.cycleId,tenantScope:'00000000-0000-0000-0000-000000000000',epochs:first.epochs,expiresAt:expiry,now:preparedAt,words:configured.success?configured.data:null});
 return apply({kind:'prepare',...value});
}
