import {assertAgentActionUnpausedTx} from './agent-action-pause';
import {AiAllowanceError} from '../lib/ai/types';
/** WP13 c/d/e. Fixed-template, principal-only reminders. This module never calls a model, writes clocks,
 * changes documents or completes lifecycle work. Sources disclose only ids/dates and lifecycle rule facts. */
import {and,desc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent} from '../db/events';
import {domainEvent} from '../db/schema';
import {agentActor,agentHolds,agentSpecialistCurrentTx,agentStamp,isAgentContext} from './agent-principal';
import {isModuleEnabled,resolveEntitlementsTx,settingEnabled} from './entitlements';
import {agentActionsByTier} from '../lib/ai/agent-action-registry';
import {assertAgentActionTier} from '../lib/ai/agent-action-tier-guard';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso,elapsedWorkingDaysTx,localDate} from '../packs/leave/service';
import {buildStepViews,defaultStepDefs,type StepDef} from '../packs/lifecycle/service';
import {AutomaticChaserRefusal,type ChaseCounts,type ChaserRunOptions} from './automatic-chasers';

export const FOLLOWUP_EVENT='automatic-chase.followup-raised';
export const FOLLOWUP_ACTIONS=agentActionsByTier('automatic').filter(a=>a.automatic.source==='missing_clock'||a.automatic.source==='passport_expiry'||a.automatic.source==='lifecycle_step');
type FollowupAction=typeof FOLLOWUP_ACTIONS[number];
type Specialist='clock_reminders'|'document_reminders'|'lifecycle_chasers';
type Source='missing_clock'|'passport_expiry'|'lifecycle_step';
const switches:Record<Specialist,(ctx:SessionContext)=>boolean>={
 clock_reminders:ctx=>settingEnabled(ctx,'notifications.missing_clock_reminders_enabled'),
 document_reminders:ctx=>settingEnabled(ctx,'notifications.passport_expiry_reminders_enabled'),
 lifecycle_chasers:ctx=>settingEnabled(ctx,'notifications.lifecycle_step_chasers_enabled'),
};
function specialistOf(action:FollowupAction):Specialist{const s=action.automatic.specialist;if(s!=='clock_reminders'&&s!=='document_reminders'&&s!=='lifecycle_chasers')throw new AutomaticChaserRefusal('unknown_action');return s;}
function sourceOf(action:FollowupAction):Source{const s=action.automatic.source;if(s!=='missing_clock'&&s!=='passport_expiry'&&s!=='lifecycle_step')throw new AutomaticChaserRefusal('unknown_action');return s;}
const moduleOf=(source:Source)=>source==='missing_clock'?'attendance':source==='lifecycle_step'?'lifecycle':'employees';
export async function assertAutomaticFollowupTx(tx:Tx,ctx:SessionContext,actionId:string){
 const action=FOLLOWUP_ACTIONS.find(a=>a.id===actionId);if(!action)throw new AutomaticChaserRefusal('unknown_action');
 assertAgentActionTier(action.id,'automatic');if(!isAgentContext(ctx))throw new AutomaticChaserRefusal('not_agent');
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined};const specialist=specialistOf(action);
 if(!switches[specialist](fresh)||!await agentSpecialistCurrentTx(tx,fresh,specialist))throw new AutomaticChaserRefusal('switched_off');
 try{await assertAgentActionUnpausedTx(tx,action.id);}catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')throw new AutomaticChaserRefusal('switched_off');throw error;}
 if(!isModuleEnabled(fresh,'notifications')||!isModuleEnabled(fresh,moduleOf(sourceOf(action))))throw new AutomaticChaserRefusal('module_off');
 return{action,fresh};
}
const Ref=z.object({itemId:z.guid(),employmentId:z.guid(),companyId:z.guid()});
const Dated=Ref.extend({stage:z.string(),waitingOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict();
const Lifecycle=Ref.extend({kind:z.enum(['onboarding','offboarding']),status:z.literal('in_progress'),laptopRequired:z.boolean(),carparkRequired:z.boolean(),outcome:z.enum(['pending','accepted','rejected']),transitionAt:z.string(),defs:z.array(z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),phase:z.number().int(),rule:z.enum(['always','carpark','laptop','outcome_accepted','outcome_rejected']),sort:z.number().int(),active:z.boolean()}).strict()),records:z.array(z.object({key:z.string(),done:z.boolean()}).strict())}).strict();
export type FollowupItem=z.infer<typeof Dated>;
const ids=(values:readonly string[]|null)=>values?sql`ARRAY[${sql.join(values.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`:sql`null::uuid[]`;
/** Uses lifecycle's actual applicability/phase owner. Only workflow transitions restart this clock;
 * notes/other metadata edits do not. This measures case age since transition, not a nonexistent step due date. */
export async function followupItemsTx(tx:Tx,source:Source,today:string,only:readonly string[]|null=null):Promise<FollowupItem[]>{
 const rows=await tx.execute<{facts:unknown}>(sql`select value as facts from app.automatic_followup_facts(${source},${today}::date,${ids(only)},2000) AS source(value)`);
 if(source!=='lifecycle_step')return rows.map(row=>Dated.parse(row.facts));
 return rows.flatMap(row=>{
  const c=Lifecycle.parse(row.facts),done=new Set(c.records.filter(r=>r.done).map(r=>r.key));
  const defs:StepDef[]=c.defs.length?c.defs.filter(d=>d.active||done.has(d.key)).map(d=>({...d,label:'',ownerTeam:'',hrms:false})):defaultStepDefs(c.kind);
  const transition=new Date(c.transitionAt);if(!Number.isFinite(+transition))throw Error('Lifecycle reminder source unavailable');
  return buildStepViews(defs,c.records,c).filter(step=>!step.blocked).map(step=>({itemId:c.itemId,employmentId:c.employmentId,companyId:c.companyId,stage:step.key+':'+Math.floor(+transition/1000),waitingOn:localDate(transition)}));
 });
}
export type FollowupRunResult={sent:number;stopped:boolean;byAction:Record<string,ChaseCounts>};
async function sendOne(tx:Tx,ctx:SessionContext,action:FollowupAction,item:FollowupItem,today:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId}),hashtext(${action.id+':'+item.itemId+':'+item.stage}))`);
 const {fresh}=await assertAutomaticFollowupTx(tx,ctx,action.id),source=sourceOf(action);
 const current=(await followupItemsTx(tx,source,today,[item.itemId])).find(r=>r.stage===item.stage);
 if(!current||JSON.stringify(current)!==JSON.stringify(item))return 'changed' as const;
 const prior=await tx.select({at:domainEvent.occurredAt}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.eventType,FOLLOWUP_EVENT),eq(domainEvent.aggregateType,'automatic-chase'),eq(domainEvent.aggregateId,item.itemId),sql`${domainEvent.payload}->>'action'=${action.id}`,sql`${domainEvent.payload}->>'stage'=${item.stage}`)).orderBy(desc(domainEvent.occurredAt),desc(domainEvent.sequence));
 if(prior.length>=action.automatic.maxPerItem)return 'exhausted' as const;
 if(prior[0]&&localDate(prior[0].at)>addDaysIso(today,-action.automatic.cooldownDays))return 'cooled' as const;
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'automatic-chase',aggregateId:item.itemId,eventType:FOLLOWUP_EVENT,actor:agentActor(fresh),subjectEmploymentId:item.employmentId,
  payload:{action:action.id,source,stage:item.stage,companyId:item.companyId,waitingOn:item.waitingOn,eligibleOn:today,chaseNumber:prior.length+1,...agentStamp(fresh,[specialistOf(action)])}});
 return 'sent' as const;
}
export async function runAutomaticFollowups(ctx:SessionContext,opts:ChaserRunOptions):Promise<FollowupRunResult>{
 if(!isAgentContext(ctx))throw new AutomaticChaserRefusal('not_agent');if(typeof opts.calendar!=='function')throw Error('Follow-ups need the engine calendar');
 const today=opts.today??todayInKualaLumpur(),result:FollowupRunResult={sent:0,stopped:false,byAction:{}};
 for(const action of FOLLOWUP_ACTIONS){const specialist=specialistOf(action),source=sourceOf(action);
  if(!agentHolds(ctx,specialist)||!switches[specialist](ctx))continue;
  const counts:ChaseCounts={sent:0,cooled:0,exhausted:0,changed:0,noWorkingDays:0,cappedOut:false};result.byAction[action.id]=counts;
  let items:FollowupItem[];
  try{items=await withTenant(ctx,async tx=>{await assertAutomaticFollowupTx(tx,ctx,action.id);return followupItemsTx(tx,source,today);});}catch(e){if(e instanceof AutomaticChaserRefusal)continue;throw e;}
  for(const item of items){
   if(counts.sent>=action.automatic.maxPerRun){counts.cappedOut=true;break;}
   if(source==='missing_clock'){const working=await opts.calendar(item.employmentId,addDaysIso(item.waitingOn,-1),item.waitingOn);if(working==null||working<1){counts.noWorkingDays++;continue;}}
   if(source==='lifecycle_step'){const working=await opts.calendar(item.employmentId,item.waitingOn,today);if(working==null){counts.noWorkingDays++;continue;}if(working<action.automatic.overdueAfterDays)continue;}
   try{const outcome=await withTenant(ctx,tx=>sendOne(tx,ctx,action,item,today));counts[outcome]++;if(outcome==='sent')result.sent++;}catch(e){if(e instanceof AutomaticChaserRefusal){result.stopped=true;return result;}throw e;}
  }
 }
 return result;
}
/** Notification/email projection re-resolves the same source and current recipients. No stale source,
 * phase transition or renewed passport is described as still needing attention. */
export async function currentFollowupTargetsTx(tx:Tx,source:Source,itemId:string,stage:string,subjectId:string):Promise<string[]>{
 const today=todayInKualaLumpur(),item=(await followupItemsTx(tx,source,today,[itemId])).find(r=>r.stage===stage&&r.employmentId===subjectId);if(!item)return[];
 if(source==='missing_clock'){
  if((await elapsedWorkingDaysTx(tx,item.employmentId,addDaysIso(item.waitingOn,-1),item.waitingOn)??0)<1)return[];
  return[item.employmentId];
 }
 const staff=await tx.execute<{id:string}>(sql`select id from app.automatic_followup_staff(${item.companyId}::uuid,${source==='lifecycle_step'}) as id`);
 return [...new Set([...(source==='passport_expiry'?[item.employmentId]:[]),...staff.map(r=>r.id)])];
}

/** Observe chased lifecycle stages through the SAME native rule/phase owner as reminder dispatch.
 * A stage no longer actionable is no longer waiting; this never claims that a human completed it. */
export async function lifecycleChaseOutcomeTx(tx:Tx,references:unknown):Promise<{acted:number;waiting:number}>{
 const refs=z.array(z.object({itemId:z.guid(),stage:z.string()}).strict()).parse(references),keys=new Set(refs.map(r=>r.itemId+':'+r.stage));
 const uniqueIds=[...new Set(refs.map(r=>r.itemId))],current=new Set<string>(),today=todayInKualaLumpur();
 for(let offset=0;offset<uniqueIds.length;offset+=2000)for(const row of await followupItemsTx(tx,'lifecycle_step',today,uniqueIds.slice(offset,offset+2000)))current.add(row.itemId+':'+row.stage);
 const waiting=[...keys].filter(key=>current.has(key)).length;return{waiting,acted:keys.size-waiting};
}
