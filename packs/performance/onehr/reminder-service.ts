import {assessmentReminderWordsSchema,fillAssessmentReminderWords} from '../../../lib/assessment-reminder-mail';
import { randomUUID } from 'node:crypto';
import { and,asc,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant,type SessionContext,type Tx } from '../../../db/client';
import { actorOf,appendEvent } from '../../../db/events';
import { assessmentReminderEpoch,assessmentReminderRecipient,assessmentReminderRun,domainEvent,onehrCycle,reviewCycle,employment,person } from '../../../db/schema';
import { getSetting,isModuleEnabled,resolveEntitlementsTx } from '../../../core/entitlements';
import { setTenantSetting } from '../../../core/tenant-settings';
import { isGroupAdmin } from '../../../lib/authz';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { assessmentReminderDue,assessmentReminderRulesSchema,defaultAssessmentReminderRules,nextAssessmentReminder } from './reminder-model';
import { assessmentReminderWork,type ReminderWorkGraph,type ReminderWorkRecipient } from './reminder-work';

const tenantScope='00000000-0000-0000-0000-000000000000';
async function access(tx:Tx,cycleId:string){
 z.uuid().parse(cycleId);const [scope]=await tx.execute<{ok:boolean}>(sql`select app.assessment_dispatcher_scope() or app.onehr_cycle_admin(${cycleId}::uuid) as ok`);
 if(!scope?.ok)throw Error('Performance administrator access is required.');
}
async function fresh(tx:Tx,tenantId:string){return {tenantId,roles:['hr_admin'],entitlements:await resolveEntitlementsTx(tx,tenantId)} satisfies SessionContext;}
function rules(ctx:SessionContext){
 // Malformed operator data fails closed; the public settings writer always stores a validated value.
 try{return assessmentReminderRulesSchema.parse(JSON.parse(getSetting<string>(ctx,'performance.reminder_rules')));}catch{return defaultAssessmentReminderRules;}
}
function words(ctx:SessionContext){try{return assessmentReminderWordsSchema.nullable().parse(JSON.parse(getSetting<string>(ctx,'performance.reminder_words')));}catch{return null;}}
async function work(tx:Tx,cycleId:string,ctx:SessionContext,now=new Date()){
 await access(tx,cycleId);
 const [row]=await tx.execute<{value:ReminderWorkGraph|null}>(sql`select app.assessment_pending_work(${cycleId}::uuid) as value`),graph=row?.value;
 if(!graph)return null;
 const companies=new Set(graph.reviews.map(r=>r.companyId));if(graph.cycle.companyId)companies.add(graph.cycle.companyId);for(const s of graph.sessions){if(s.companyId)companies.add(s.companyId);for(const e of s.entries)companies.add(e.companyId);}
 const enabled=new Set([...companies].filter(companyId=>isModuleEnabled(ctx,'performance',companyId)));if(!enabled.size&&!isModuleEnabled(ctx,'performance'))return null;
 return {graph,recipients:assessmentReminderWork(graph,enabled,now)};
}
async function routes(tx:Tx,cycleId:string,ctx:SessionContext){
 const rows=await tx.execute<{user_id:string;employment_id:string;company_id:string}>(sql`select * from app.assessment_reminder_mail_routes(${cycleId}::uuid)`);
 const byUser=new Map<string,string>();for(const row of rows)if(!byUser.has(row.user_id)&&isModuleEnabled(ctx,'notifications',row.company_id))byUser.set(row.user_id,row.employment_id);
 return byUser;
}
async function cooldowns(tx:Tx,cycleId:string,userIds:string[],except?:string){
 if(!userIds.length)return new Set<string>();
 const rows=await tx.execute<{userId:string}>(sql`select distinct r.user_id as "userId"
  from performance_assessment_reminder_recipient r join performance_assessment_reminder_run run on run.id=r.run_id and run.tenant_id=r.tenant_id
  left join notification_delivery d on d.source_event_id=r.source_event_id and d.recipient_user_id=r.user_id and d.channel='email'
  where r.tenant_id=app.current_tenant_id() and run.cycle_id=${cycleId}::uuid and r.user_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(userIds)}::jsonb)) and (${except??null}::uuid is null or r.id<>${except??null}::uuid)
   and ((d.status='sent' and d.sent_at>now()-interval '20 hours') or d.status='pending' or d.last_error='uncertain'
    or r.outcome='queued' and d.id is null and r.created_at>now()-interval '20 hours')`);
 return new Set(rows.map(row=>row.userId));
}
async function cooling(tx:Tx,cycleId:string,userId:string,except?:string){return (await cooldowns(tx,cycleId,[userId],except)).has(userId);}

// A dispatcher transaction can contain thousands of reminders from the same cycle. Cache only inside
// that actual transaction and only while both database invalidation tokens and wall-clock gates match.
// Each email lease opens a new transaction, so SMTP never adopts a previous dispatcher's snapshot.
type ReminderProjection={
 state:Awaited<ReturnType<typeof fresh>>;current:Awaited<ReturnType<typeof work>>;
 actors:Map<string,ReminderWorkRecipient>;
 mailRoutes:Map<string,string>;expiresAt:number;
};
const projectionCache=new WeakMap<Tx,Map<string,Promise<ReminderProjection>>>();
async function projection(tx:Tx,tenantId:string,cycleId:string,epochs:typeof assessmentReminderEpoch.$inferSelect[]){
 const version=(scope:string)=>epochs.find(row=>row.scopeId===scope)?.revision??0;
 const key=`${tenantId}:${cycleId}:${version(tenantScope)}:${version(cycleId)}:${process.env.MODULE_KILL??''}:${process.env.SETTING_KILL??''}`;
 const cache=projectionCache.get(tx)??new Map<string,Promise<ReminderProjection>>();projectionCache.set(tx,cache);
 const prior=cache.get(key);if(prior){const result=await prior;if(result.expiresAt>Date.now())return result;cache.delete(key);}
 const pending=(async()=>{
  const now=new Date(),state=await fresh(tx,tenantId),current=await work(tx,cycleId,state,now),mailRoutes=current?await routes(tx,cycleId,state):new Map<string,string>();
  const [expiry]=await tx.execute<{until:Date|null}>(sql`select min(expires_at) as until from tenant_module where tenant_id=app.current_tenant_id() and expires_at>now()`);
  const boundaries=Object.values(current?.graph.cycle.policy.windows??{}).flatMap(window=>[window?.opensAt,window?.closesAt]).filter((value):value is string=>!!value).map(Date.parse).filter(time=>time>now.getTime());
  const expiresAt=Math.min(now.getTime()+60_000,new Date(`${todayInKualaLumpur(now)}T23:59:59.999+08:00`).getTime(),expiry?.until?new Date(expiry.until).getTime():Infinity,...boundaries);
  return {state,current,mailRoutes,actors:new Map((current?.recipients??[]).map(actor=>[actor.userId,actor])),expiresAt};
 })();cache.set(key,pending);return pending;
}

export async function saveAssessmentReminderRules(ctx:SessionContext,raw:unknown){
 if(!isGroupAdmin(ctx))throw Error('Only group HR administrators may change the reminder schedule.');
 const parsed=assessmentReminderRulesSchema.parse(raw);
 await withTenant(ctx,async tx=>{const state=await fresh(tx,ctx.tenantId);if(!isModuleEnabled(state,'performance')&&!(state.entitlements.scopedModules.performance??[]).some(companyId=>isModuleEnabled(state,'performance',companyId)))throw Error('Performance is not enabled.');});
 await setTenantSetting(ctx,{key:'performance.reminder_rules',value:JSON.stringify(parsed)});
}

/** Wording has its own central setting, so changing the schedule cannot erase a template. */
export async function saveAssessmentReminderWords(ctx:SessionContext,raw:unknown){
 if(!isGroupAdmin(ctx))throw Error('Only group HR administrators may change reminder wording.');
 const parsed=assessmentReminderWordsSchema.nullable().parse(raw);
 await withTenant(ctx,async tx=>{const state=await fresh(tx,ctx.tenantId);if(!isModuleEnabled(state,'performance')&&!(state.entitlements.scopedModules.performance??[]).some(companyId=>isModuleEnabled(state,'performance',companyId)))throw Error('Performance is not enabled.');});
 await setTenantSetting(ctx,{key:'performance.reminder_words',value:JSON.stringify(parsed)});
}
/** Same current work and template as delivery, without queuing mail or borrowing the recipient's identity. */
export async function previewAssessmentReminder(ctx:SessionContext,cycleId:string,employeeCode:string){
 const code=z.string().trim().min(1).max(100).parse(employeeCode);
 if(!ctx.userId)throw Error('Sign in to preview a reminder.');
 return withTenant(ctx,async tx=>{
  await access(tx,cycleId);const state=await fresh(tx,ctx.tenantId),current=await work(tx,cycleId,state);
  const [employee]=await tx.select({id:employment.id,name:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(eq(employment.employeeCode,code),sql`app.onehr_admin(${employment.companyId})`));
  if(!current||!employee||!current.graph.actors.some(actor=>actor.employmentIds.includes(employee.id)))throw Error('No employee with that ID is available in this cycle and your scope.');
  const actors=current.graph.actors.filter(actor=>actor.employmentIds.includes(employee.id));if(actors.length!==1)throw Error('This employee has more than one active account. Review the account mapping before previewing.');
  const actor=actors[0],recipient=current.recipients.find(recipient=>recipient.userId===actor.userId),tasks=recipient?.tasks??[];
  const mailRoutes=await routes(tx,cycleId,state);
  return {employee:employee.name,employeeCode:code,eligible:mailRoutes.has(actor.userId),mail:{tasks,words:fillAssessmentReminderWords(words(state),actor.name,current.graph.cycle.name,tasks.length)}};
 });
}

/** Counts and SMTP outcomes are projections of the current graph and the existing delivery ledger. */
export async function getAssessmentReminders(ctx:SessionContext,cycleId:string){
 return withTenant(ctx,async tx=>{
  await access(tx,cycleId);const state=await fresh(tx,ctx.tenantId),configured=rules(state),current=await work(tx,cycleId,state),mailRoutes=current?await routes(tx,cycleId,state):new Map<string,string>();
  const runs=await tx.execute<{id:string;mode:string;createdAt:string;sent:number;failed:number;pending:number;skipped:number;dry:number}>(sql`
   select run.id,run.mode,run.created_at as "createdAt",
    count(*) filter(where d.status='sent')::integer as sent,
    count(*) filter(where d.status='failed')::integer as failed,
    count(*) filter(where r.outcome='queued' and (d.status='pending' or d.id is null))::integer as pending,
    count(*) filter(where r.outcome in ('cooldown','noConsent','noPendingWork','changed') or d.status='skipped')::integer as skipped,
    count(*) filter(where r.outcome='dry')::integer as dry
   from (select * from performance_assessment_reminder_run where cycle_id=${cycleId}::uuid and tenant_id=app.current_tenant_id() order by created_at desc,id desc limit 8) run
   left join performance_assessment_reminder_recipient r on r.run_id=run.id and r.tenant_id=run.tenant_id
   left join notification_delivery d on d.source_event_id=r.source_event_id and d.recipient_user_id=r.user_id and d.channel='email'
   group by run.id,run.mode,run.created_at order by run.created_at desc,run.id desc`);
  const taskCounts:Record<string,number>={};for(const recipient of current?.recipients??[])for(const task of recipient.tasks)taskCounts[task.key]=(taskCounts[task.key]??0)+1;
  return {rules:configured,words:words(state),mayWrite:isGroupAdmin(ctx),waiting:current?.recipients.length??0,mailEligible:current?.recipients.filter(r=>mailRoutes.has(r.userId)).length??0,
   taskCounts,
   next:current?nextAssessmentReminder(current.graph.cycle.policy,current.graph.cycle.periodEnd,configured):null,runs};
 });
}

/** Automatic runs claim a Malaysia calendar day once, even when nothing is pending. Manual sends obey cooldown. */
export async function queueAssessmentReminders(ctx:SessionContext,cycleId:string,mode:'automatic'|'manual'|'dry',limit=0){
 z.enum(['automatic','manual','dry']).parse(mode);z.number().int().min(0).max(100000).parse(limit);
 if(mode!=='automatic'&&!ctx.userId)throw Error('A signed-in administrator is required.');
 return withTenant(ctx,async tx=>{
  await access(tx,cycleId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`assessment-reminders:${ctx.tenantId}:${cycleId}`},0))`);
  const state=await fresh(tx,ctx.tenantId),current=await work(tx,cycleId,state),now=new Date();
  if(!current)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:false};
  const due=assessmentReminderDue(current.graph.cycle.policy,current.graph.cycle.periodEnd,rules(state),now);
  if(mode==='automatic'&&!due.due)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:false};
  const [run]=await tx.insert(assessmentReminderRun).values({tenantId:ctx.tenantId,cycleId,mode,sendDay:mode==='automatic'?due.day:null,actorUserId:ctx.userId??null,reasons:mode==='automatic'?due.reasons:[]}).onConflictDoNothing().returning();
  if(!run)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:true};
  const mailRoutes=await routes(tx,cycleId,state),blocked=await cooldowns(tx,cycleId,current.recipients.map(r=>r.userId));let queued=0,skipped=0,dry=0;
  const recipients:typeof assessmentReminderRecipient.$inferInsert[]=[];
  for(const recipient of current.recipients){
   const employmentId=mailRoutes.get(recipient.userId),outcome=!employmentId?'noConsent':blocked.has(recipient.userId)?'cooldown':mode==='dry'?'dry':'queued';
   // The source limit counts eligible attempts; skipped accounts cannot consume another person's slot.
   if((outcome==='queued'||outcome==='dry')&&limit>0&&queued+dry>=limit)break;
   if(outcome==='queued')queued++;else if(outcome==='dry')dry++;else skipped++;
   recipients.push({id:randomUUID(),tenantId:ctx.tenantId,runId:run.id,userId:recipient.userId,employmentId:employmentId??null,outcome,tasks:mode==='dry'?recipient.tasks:[]});
  }
  // Bound statement parameters even when an automatic run includes every eligible account.
  for(let offset=0;offset<recipients.length;offset+=1000){
   const batch=recipients.slice(offset,offset+1000),pending=batch.filter(row=>row.outcome==='queued');
   if(pending.length){
    const events=await tx.insert(domainEvent).values(pending.map(row=>({tenantId:ctx.tenantId,aggregateType:'assessment-reminder',aggregateId:row.id!,eventType:'assessment.reminder-queued',actorType:actorOf(ctx).type,actorId:ctx.userId??null}))).returning({id:domainEvent.id,aggregateId:domainEvent.aggregateId});
    const ids=new Map(events.map(event=>[event.aggregateId,event.id]));for(const row of pending)row.sourceEventId=ids.get(row.id!);
   }
   await tx.insert(assessmentReminderRecipient).values(batch);
  }
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'assessment-reminder-run',aggregateId:run.id,eventType:'assessment.reminder-run',actor:actorOf(ctx),payload:{cycleId,mode,queued,skipped,dry,limit}});
  return {runId:run.id,queued,skipped,dry,nothing:current.graph.actors.length-current.recipients.length,duplicate:false};
 });
}

/** Registry and pre-lease checks share this live resolver. Old event payloads cannot choose recipients or text. */
export async function assessmentReminderRecipientsTx(tx:Tx,recipientId:string){
 z.uuid().parse(recipientId);
 const [recipient]=await tx.select({recipient:assessmentReminderRecipient,run:assessmentReminderRun}).from(assessmentReminderRecipient).innerJoin(assessmentReminderRun,eq(assessmentReminderRun.id,assessmentReminderRecipient.runId)).where(eq(assessmentReminderRecipient.id,recipientId));
 if(!recipient||recipient.recipient.outcome!=='queued'||!recipient.recipient.employmentId)return [];
 const skip=async(outcome:'changed'|'noPendingWork'|'noConsent'|'cooldown')=>{await tx.update(assessmentReminderRecipient).set({outcome,tasks:[],mailWords:null,preparedAt:null,preparedUntil:null}).where(eq(assessmentReminderRecipient.id,recipientId));return [];};
 const epochs=await tx.select().from(assessmentReminderEpoch).where(and(eq(assessmentReminderEpoch.tenantId,recipient.run.tenantId),sql`${assessmentReminderEpoch.scopeId} in (${tenantScope}::uuid,${recipient.run.cycleId}::uuid)`));
 const prepared=await projection(tx,recipient.run.tenantId,recipient.run.cycleId,epochs),{state,mailRoutes}=prepared;
 if(recipient.run.mode==='automatic'&&!rules(state).enabled)return skip('changed');
 const actor=prepared.actors.get(recipient.recipient.userId);
 if(!actor||!actor.employmentIds.includes(recipient.recipient.employmentId))return skip('noPendingWork');
 if(await cooling(tx,recipient.run.cycleId,actor.userId,recipientId))return skip('cooldown');
 if(mailRoutes.get(actor.userId)!==recipient.recipient.employmentId)return skip('noConsent');
 const checked=await tx.select().from(assessmentReminderEpoch).where(and(eq(assessmentReminderEpoch.tenantId,recipient.run.tenantId),sql`${assessmentReminderEpoch.scopeId} in (${tenantScope}::uuid,${recipient.run.cycleId}::uuid)`));
 if(checked.length!==epochs.length||checked.some(row=>epochs.find(e=>e.scopeId===row.scopeId)?.revision!==row.revision)||prepared.expiresAt<=Date.now())return skip('changed');
 const now=new Date(),until=new Date(Math.min(now.getTime()+60_000,prepared.expiresAt));
 await tx.update(assessmentReminderRecipient).set({tasks:actor.tasks,mailWords:fillAssessmentReminderWords(words(state),prepared.current!.graph.actors.find(person=>person.userId===actor.userId)!.name,prepared.current!.graph.cycle.name,actor.tasks.length),preparedAt:now,preparedUntil:until,tenantEpoch:epochs.find(e=>e.scopeId===tenantScope)?.revision??0,cycleEpoch:epochs.find(e=>e.scopeId===recipient.run.cycleId)?.revision??0}).where(eq(assessmentReminderRecipient.id,recipientId));
 return [recipient.recipient.employmentId];
}

export async function sweepAssessmentReminders(ctx:SessionContext){
 if(ctx.userId)throw Error('The scheduled Performance dispatcher has no human user ID.');
 const cycles=await withTenant(ctx,tx=>tx.select({id:reviewCycle.id}).from(reviewCycle).innerJoin(onehrCycle,eq(onehrCycle.cycleId,reviewCycle.id)).where(sql`${reviewCycle.status} in ('open','calibration')`).orderBy(asc(reviewCycle.id)));
 const results=[];for(const cycle of cycles)results.push(await queueAssessmentReminders(ctx,cycle.id,'automatic'));return results;
}
