import { and,asc,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant,type SessionContext,type Tx } from '../../../db/client';
import { actorOf,appendEvent } from '../../../db/events';
import { assessmentReminderEpoch,assessmentReminderRecipient,assessmentReminderRun,domainEvent,onehrCycle,reviewCycle } from '../../../db/schema';
import { getSetting,isModuleEnabled,resolveEntitlementsTx } from '../../../core/entitlements';
import { setTenantSetting } from '../../../core/tenant-settings';
import { isGroupAdmin } from '../../../lib/authz';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { assessmentReminderDue,assessmentReminderRulesSchema,defaultAssessmentReminderRules,nextAssessmentReminder } from './reminder-model';
import { assessmentReminderWork,type ReminderWorkGraph } from './reminder-work';

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
async function work(tx:Tx,cycleId:string,ctx:SessionContext,now=new Date()){
 await access(tx,cycleId);
 const [row]=await tx.execute<{value:ReminderWorkGraph|null}>(sql`select app.assessment_pending_work(${cycleId}::uuid) as value`),graph=row?.value;
 if(!graph)return null;
 const companies=new Set(graph.reviews.map(r=>r.companyId));for(const s of graph.sessions){if(s.companyId)companies.add(s.companyId);for(const e of s.entries)companies.add(e.companyId);}
 const enabled=new Set([...companies].filter(companyId=>isModuleEnabled(ctx,'performance',companyId)));if(!enabled.size)return null;
 return {graph,recipients:assessmentReminderWork(graph,enabled,now)};
}
async function routes(tx:Tx,cycleId:string,ctx:SessionContext){
 const rows=await tx.execute<{user_id:string;employment_id:string;company_id:string}>(sql`select * from app.assessment_reminder_mail_routes(${cycleId}::uuid)`);
 const byUser=new Map<string,string>();for(const row of rows)if(!byUser.has(row.user_id)&&isModuleEnabled(ctx,'notifications',row.company_id))byUser.set(row.user_id,row.employment_id);
 return byUser;
}
async function cooling(tx:Tx,cycleId:string,userId:string,except?:string){
 const [row]=await tx.execute<{ok:boolean}>(sql`select exists(
  select 1 from performance_assessment_reminder_recipient r join performance_assessment_reminder_run run on run.id=r.run_id and run.tenant_id=r.tenant_id
  left join notification_delivery d on d.source_event_id=r.source_event_id and d.recipient_user_id=r.user_id and d.channel='email'
  where r.tenant_id=app.current_tenant_id() and run.cycle_id=${cycleId}::uuid and r.user_id=${userId}::uuid and (${except??null}::uuid is null or r.id<>${except??null}::uuid)
   and ((d.status='sent' and d.sent_at>now()-interval '20 hours') or d.status='pending' or d.last_error='uncertain'
    or r.outcome='queued' and d.id is null and r.created_at>now()-interval '20 hours')
 ) as ok`);return !!row?.ok;
}

export async function saveAssessmentReminderRules(ctx:SessionContext,raw:unknown){
 if(!isGroupAdmin(ctx))throw Error('Only group HR administrators may change the reminder schedule.');
 const parsed=assessmentReminderRulesSchema.parse(raw);
 await withTenant(ctx,async tx=>{const state=await fresh(tx,ctx.tenantId);if(!isModuleEnabled(state,'performance')&&!(state.entitlements.scopedModules.performance??[]).some(companyId=>isModuleEnabled(state,'performance',companyId)))throw Error('Performance is not enabled.');});
 await setTenantSetting(ctx,{key:'performance.reminder_rules',value:JSON.stringify(parsed)});
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
    count(*) filter(where r.outcome in ('cooldown','noConsent','noPendingWork') or d.status='skipped')::integer as skipped,
    count(*) filter(where r.outcome='dry')::integer as dry
   from (select * from performance_assessment_reminder_run where cycle_id=${cycleId}::uuid and tenant_id=app.current_tenant_id() order by created_at desc,id desc limit 8) run
   left join performance_assessment_reminder_recipient r on r.run_id=run.id and r.tenant_id=run.tenant_id
   left join notification_delivery d on d.source_event_id=r.source_event_id and d.recipient_user_id=r.user_id and d.channel='email'
   group by run.id,run.mode,run.created_at order by run.created_at desc,run.id desc`);
  const taskCounts:Record<string,number>={};for(const recipient of current?.recipients??[])for(const task of recipient.tasks)taskCounts[task.key]=(taskCounts[task.key]??0)+1;
  return {rules:configured,mayWrite:isGroupAdmin(ctx),waiting:current?.recipients.length??0,mailEligible:current?.recipients.filter(r=>mailRoutes.has(r.userId)).length??0,
   taskCounts,
   next:current?nextAssessmentReminder(current.graph.cycle.policy,current.graph.cycle.periodEnd,configured):null,runs};
 });
}

/** Automatic runs claim a Malaysia calendar day once, even when nothing is pending. Manual sends obey cooldown. */
export async function queueAssessmentReminders(ctx:SessionContext,cycleId:string,mode:'automatic'|'manual'|'dry',limit=1000){
 z.enum(['automatic','manual','dry']).parse(mode);z.number().int().min(1).max(5000).parse(limit);
 if(mode!=='automatic'&&!ctx.userId)throw Error('A signed-in administrator is required.');
 return withTenant(ctx,async tx=>{
  await access(tx,cycleId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`assessment-reminders:${ctx.tenantId}:${cycleId}`},0))`);
  const state=await fresh(tx,ctx.tenantId),current=await work(tx,cycleId,state),now=new Date();
  if(!current)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:false};
  const due=assessmentReminderDue(current.graph.cycle.policy,current.graph.cycle.periodEnd,rules(state),now);
  if(mode==='automatic'&&!due.due)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:false};
  const [run]=await tx.insert(assessmentReminderRun).values({tenantId:ctx.tenantId,cycleId,mode,sendDay:mode==='automatic'?due.day:null,actorUserId:ctx.userId??null,reasons:mode==='automatic'?due.reasons:[]}).onConflictDoNothing().returning();
  if(!run)return {queued:0,skipped:0,dry:0,nothing:0,duplicate:true};
  const mailRoutes=await routes(tx,cycleId,state);let queued=0,skipped=0,dry=0;
  for(const recipient of current.recipients.slice(0,limit)){
   const employmentId=mailRoutes.get(recipient.userId),cooldown=await cooling(tx,cycleId,recipient.userId);
   const outcome=!employmentId?'noConsent':cooldown?'cooldown':mode==='dry'?'dry':'queued';
   const [row]=await tx.insert(assessmentReminderRecipient).values({tenantId:ctx.tenantId,runId:run.id,userId:recipient.userId,employmentId:employmentId??null,outcome,tasks:mode==='dry'?recipient.tasks:[]}).returning({id:assessmentReminderRecipient.id});
   if(outcome==='queued'){
    const [event]=await tx.insert(domainEvent).values({tenantId:ctx.tenantId,aggregateType:'assessment-reminder',aggregateId:row.id,eventType:'assessment.reminder-queued',actorType:actorOf(ctx).type,actorId:ctx.userId??null}).returning({id:domainEvent.id});
    await tx.update(assessmentReminderRecipient).set({sourceEventId:event.id}).where(eq(assessmentReminderRecipient.id,row.id));queued++;
   }else if(outcome==='dry')dry++;else skipped++;
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
 const epochs=await tx.select().from(assessmentReminderEpoch).where(and(eq(assessmentReminderEpoch.tenantId,recipient.run.tenantId),sql`${assessmentReminderEpoch.scopeId} in (${tenantScope}::uuid,${recipient.run.cycleId}::uuid)`));
 const state=await fresh(tx,recipient.run.tenantId);if(recipient.run.mode==='automatic'&&!rules(state).enabled)return [];
 const current=await work(tx,recipient.run.cycleId,state),actor=current?.recipients.find(r=>r.userId===recipient.recipient.userId);
 if(!actor||!actor.employmentIds.includes(recipient.recipient.employmentId)||await cooling(tx,recipient.run.cycleId,actor.userId,recipientId))return [];
 const mailRoutes=await routes(tx,recipient.run.cycleId,state);if(mailRoutes.get(actor.userId)!==recipient.recipient.employmentId)return [];
 const checked=await tx.select().from(assessmentReminderEpoch).where(and(eq(assessmentReminderEpoch.tenantId,recipient.run.tenantId),sql`${assessmentReminderEpoch.scopeId} in (${tenantScope}::uuid,${recipient.run.cycleId}::uuid)`));
 if(checked.length!==epochs.length||checked.some(row=>epochs.find(e=>e.scopeId===row.scopeId)?.revision!==row.revision))return [];
 const now=new Date(),midnight=new Date(`${todayInKualaLumpur(now)}T23:59:59.999+08:00`);
 const [expiry]=await tx.execute<{until:Date|null}>(sql`select min(expires_at) as until from tenant_module where tenant_id=app.current_tenant_id() and expires_at>now()`);
 const until=new Date(Math.min(now.getTime()+60_000,midnight.getTime(),expiry?.until?new Date(expiry.until).getTime():Infinity));
 await tx.update(assessmentReminderRecipient).set({tasks:actor.tasks,preparedAt:now,preparedUntil:until,tenantEpoch:epochs.find(e=>e.scopeId===tenantScope)?.revision??0,cycleEpoch:epochs.find(e=>e.scopeId===recipient.run.cycleId)?.revision??0}).where(eq(assessmentReminderRecipient.id,recipientId));
 return [recipient.recipient.employmentId];
}

export async function sweepAssessmentReminders(ctx:SessionContext){
 if(ctx.userId)throw Error('The scheduled Performance dispatcher has no human user ID.');
 const cycles=await withTenant(ctx,tx=>tx.select({id:reviewCycle.id}).from(reviewCycle).innerJoin(onehrCycle,eq(onehrCycle.cycleId,reviewCycle.id)).where(sql`${reviewCycle.status} in ('open','calibration')`).orderBy(asc(reviewCycle.id)));
 const results=[];for(const cycle of cycles)results.push(await queueAssessmentReminders(ctx,cycle.id,'automatic'));return results;
}
