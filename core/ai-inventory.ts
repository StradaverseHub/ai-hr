/** WP12 — the one AI inventory (R8), its alerts (R20) and the provider data register (R21) for AI management.
 *
 * ACCESS (ADR-0151 §4.7; permissions listed in lib/permissions.ts for /control-tower/agents/inventory):
 *   - group administrator: the full inventory — switches, allowances,
 *     pause keys and pause state, last run, 30-day use and reported cost, outcome rates, ai-control audit events,
 *     alerts, run history and the data register; and may pause/resume one agent action;
 *   - company HR administrator: the read-only registry/tier view (kind, module, tier, category, pause key and
 *     whether it is paused) — no runs, cost, people, provider or audit facts;
 *   - anyone else: refused.
 * "Group administrator" means all three, checked in the reading transaction: the session claims a group-wide grant
 * (isGroupAdmin); assertAiPrincipalTx proves that claim is CURRENT (the login is active and the claimed grants match
 * the principal's stored grants, app.principal_snapshot_current) — that is where freshness comes from; and
 * app.is_group_admin() agrees for this transaction's claim. A stale claim fails assertAiPrincipalTx and is refused.
 * The 30-day figures use the run history's Kuala Lumpur calendar window (the last 30 KL days, today inclusive).
 * Tenant isolation is the database's: every read runs in withTenant under RLS (ai_model_run, domain_event and job_run
 * read policies are group-administrator-only; app.ai_agent_action_pause rows are group-administrator-only and other
 * sessions see (action_id, paused) through app.ai_agent_action_pauses(); the outcome summary is a
 * definer that counts only the caller's scope). Nothing here calls a model or writes HR data.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {isAdmin,isGroupAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {AI_FEATURES,isAiFeature,type AiFeatureId} from '../lib/ai/features';
import {agentActionById,agentActionPauseKey} from '../lib/ai/agent-action-registry';
import {AI_DATA_REGISTER,AI_RUN_PAGE_SIZE,aiInventoryComponents,aiRunPageOffset,aiRunRangeBounds,evaluateAiAlerts,parseAiRunRange,
 registryRow,switchDrift,type AiAlert,type AiInventoryComponent,type AiRegistryRow,type AiRunRange} from '../lib/ai/ai-inventory';
import {assertAiPrincipalTx} from './ai-principal';
import {AiControlError,type aiManagementView,type AiRunFilter} from './ai-management';

type ManagementView=Awaited<ReturnType<typeof aiManagementView>>;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
/** Call only AFTER assertAiPrincipalTx in the same transaction (which is what makes the claim current). */
async function groupAdminClaimTx(tx:Tx,ctx:SessionContext){
 if(!isGroupAdmin(ctx))return false;
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);
 return row?.allowed===true;
}
/** Group administrators read the full rows; everyone else only (action_id, paused) through the narrow definer. */
async function pausesTx(tx:Tx,group:boolean){
 const rows=group?await tx.execute<{action_id:string;paused:boolean}>(sql`select action_id,paused from app.ai_agent_action_pause order by action_id`)
  :await tx.execute<{action_id:string;paused:boolean}>(sql`select action_id,paused from app.ai_agent_action_pauses()`);
 return new Map(Array.from(rows).map(r=>[r.action_id,{paused:r.paused===true}]));
}
/** The run history's default window: the last 30 Kuala Lumpur calendar days, today inclusive. */
const window30=()=>aiRunRangeBounds(parseAiRunRange({},todayInKualaLumpur())).fromTs;

export type AiInventoryRuntime=Readonly<{
 switch:Readonly<{kind:'setting'|'policy'|'platform'|'module'|'none';on:boolean|null;state:string|null}>;
 actionPaused:boolean|null;
 allowance:Readonly<{dailyRequests:number|null;monthlyTokens:number|null}>|null;
 lastRun:Date|null;
 use30:Readonly<{runs:number;failed:number;blocked:number;tokens:number;reportedCredits:number|null}>|null;
 outcomes:Readonly<{prepared:number;completed:number;refused:number;discarded:number;expired:number;reversed:number|null}>|null;
 audit:Readonly<{count:number;latestAt:Date|null}>;
}>;
export type AiInventoryFullRow=AiInventoryComponent&{runtime:AiInventoryRuntime};
export type AiInventoryView=
 | Readonly<{scope:'registry';rows:readonly (AiRegistryRow&{actionPaused:boolean|null})[]}>
 | Readonly<{scope:'full';rows:readonly AiInventoryFullRow[];alerts:readonly AiAlert[];
   register:readonly {featureId:AiFeatureId;entry:(typeof AI_DATA_REGISTER)[AiFeatureId]}[];provider:{provider:string;model:string}|null}>;

type FeatureUse={feature_id:string;runs:string;failed:string;blocked:string;tokens:string;credits:string|null;last_run:string|Date|null};
type Outcome={action_kind:string;prepared:number;completed:number;refused:number;discarded:number;expired:number;reversed:number|null};
type AuditRow={key:string;count:string;latest:string|Date|null};

/** Alert metrics for one tenant session; shared shape with scripts/ai-alerts.ts (which reads them as the owner). */
async function runAlertMetricsTx(tx:Tx){
 const [r]=await tx.execute<{admitted:string;failed:string;principal:string}>(sql`select
   count(*) filter(where state<>'blocked') as admitted,count(*) filter(where state='failed') as failed,
   count(*) filter(where state='blocked' and user_id is null) as principal
  from ai_model_run where operation<>'probe' and started_at>=now()-interval '24 hours'`);
 return {admitted:Number(r?.admitted??0),failed:Number(r?.failed??0),principal:Number(r?.principal??0)};
}

/** Alerts for the AI management banner (group administrators). Company administrators get none: the inputs are
 * tenant-wide run and spend facts they may not see. */
export function aiAlertsFromView(view:ManagementView,metrics:{admitted:number;failed:number;principal:number}):AiAlert[]{
 const meters=[...view.attention.companies,...view.attention.users];
 const levelOf=(u:(typeof meters)[number])=>u.daily.level==='at'||u.tokens.level==='at'?'at':u.daily.level??u.tokens.level;
 return evaluateAiAlerts({runs24h:{admitted:metrics.admitted,failed:metrics.failed},principalRefusals24h:metrics.principal,
  // The app role cannot read this month's private USD ledger; the banner uses the breach flag and the token and
  // request meters, and scripts/ai-alerts.ts (owner connection) adds the monthly USD comparison.
  spend:null,spendBreached:view.spend?.breached===true,
  allowancesAt:meters.filter(u=>levelOf(u)==='at').length,allowancesNear:meters.filter(u=>levelOf(u)==='near').length,
  drift:switchDrift(view.features,view.agentSwitches)});
}

export async function aiInventoryView(supplied:SessionContext,view:ManagementView):Promise<AiInventoryView>{
 const ctx=capture(supplied);
 if(!isAdmin(ctx))throw new AiControlError('Only HR administrators may view the AI inventory.');
 const components=aiInventoryComponents();
 return withTenant(ctx,async tx=>{
  await assertAiPrincipalTx(tx,ctx);
  const group=await groupAdminClaimTx(tx,ctx),pauses=await pausesTx(tx,group),from=window30();
  const paused=(c:AiInventoryComponent)=>c.kind==='action'?pauses.get(c.id)?.paused===true:null;
  if(!group)return {scope:'registry',rows:components.map(c=>({...registryRow(c),actionPaused:paused(c)}))};
  const use=new Map(Array.from(await tx.execute<FeatureUse>(sql`select feature_id,
    count(*) filter(where state<>'blocked') as runs,count(*) filter(where state='failed') as failed,count(*) filter(where state='blocked') as blocked,
    coalesce(sum(actual_tokens),0) as tokens,
    sum(openrouter_account_cost_credits)::text as credits,max(started_at) as last_run
   from ai_model_run where operation<>'probe' and started_at>=${from}::timestamptz group by feature_id`)).map(r=>[r.feature_id,r]));
  const lastEver=new Map(Array.from(await tx.execute<{feature_id:string;last_run:string|Date}>(sql`select feature_id,max(started_at) as last_run from ai_model_run where operation<>'probe' group by feature_id`)).map(r=>[r.feature_id,new Date(r.last_run)]));
  const outcomes=new Map(Array.from(await tx.execute<Outcome>(sql`select * from app.assistant_action_outcome_summary(${from}::timestamptz)`)).map(r=>[r.action_kind,r]));
  // ai-control.* events keyed by what they changed, plus the tenant-setting changes that ARE the switch of a
  // setting-backed feature (one switch owner, 0692).
  const settingKeys=AI_FEATURES.flatMap(f=>f.setting?[f.setting]:[]);
  const audit=new Map(Array.from(await tx.execute<AuditRow>(sql`select key,count(*) as count,max(occurred_at) as latest from (
    select coalesce(payload->>'feature',payload->>'actionId','tenant') as key,occurred_at from domain_event
     where aggregate_type='ai-control' and event_type like 'ai-control.%' and occurred_at>=${from}::timestamptz
    union all
    select 'setting:'||(payload->>'key'),occurred_at from domain_event
     where event_type='tenant-setting.changed' and payload->>'key' in (${sql.join(settingKeys.map(k=>sql`${k}`),sql`,`)}) and occurred_at>=${from}::timestamptz
   ) e group by key`)).map(r=>[r.key,{count:Number(r.count),latestAt:r.latest?new Date(r.latest):null}]));
  const jobs=new Map(Array.from(await tx.execute<{job_key:string;ran_at:string|Date}>(sql`select job_key,max(ran_at) as ran_at from job_run where job_key in ('review.sweep','ai.alerts') group by job_key`)).map(r=>[r.job_key,new Date(r.ran_at)]));
  const [pass]=await tx.execute<{at:string|Date|null}>(sql`select max(occurred_at) as at from domain_event where aggregate_type='hr_orchestrator' and event_type='orchestrator.pass-finished'`);
  const metrics=await runAlertMetricsTx(tx);
  const feature=(id:string|null)=>id?view.features.find(f=>f.id===id)??null:null;
  const allowance=view.userDefault?{dailyRequests:view.userDefault.dailyRequests,monthlyTokens:view.userDefault.monthlyTokens}:null;
  const rows=components.map((c):AiInventoryFullRow=>{
   const f=feature(c.featureId),u=c.featureId?use.get(c.featureId):undefined,o=c.kind==='action'?outcomes.get(c.id):undefined;
   const defn=c.featureId?AI_FEATURES.find(x=>x.id===c.featureId):undefined;
   const switchKind=c.outOfBand||defn?.kind==='platform'?'platform':defn?.setting?'setting':defn?'policy':'none';
   const auditKey=c.kind==='action'?c.id:defn?.setting?`setting:${defn.setting}`:c.featureId??'';
   const auditOwn=audit.get(auditKey),auditFeature=c.kind!=='action'&&defn&&!defn.setting?audit.get(defn.id):undefined;
   const shownUse=c.kind==='action'||c.kind==='read_binding'?null:u?{runs:Number(u.runs),failed:Number(u.failed),blocked:Number(u.blocked),tokens:Number(u.tokens),reportedCredits:u.credits==null?null:Number(u.credits)}:c.featureId?{runs:0,failed:0,blocked:0,tokens:0,reportedCredits:null}:null;
   const lastRun=c.kind==='scheduled_job'&&c.jobKey?(jobs.get(c.jobKey)??null):c.kind==='orchestrator_step'?(pass?.at?new Date(pass.at):null):c.kind==='action'||!c.featureId?null:lastEver.get(c.featureId)??null;
   return {...c,runtime:{
    switch:{kind:switchKind,on:f?f.enabled:null,state:f?f.state:null},
    actionPaused:paused(c),
    allowance:c.featureId&&c.kind!=='action'&&switchKind!=='platform'?allowance:null,
    lastRun,use30:shownUse,
    outcomes:c.kind==='action'&&c.tier!=='automatic'?{prepared:o?.prepared??0,completed:o?.completed??0,refused:o?.refused??0,discarded:o?.discarded??0,expired:o?.expired??0,reversed:o?o.reversed:null}:null,
    audit:auditOwn??auditFeature??{count:0,latestAt:null},
   }};
  });
  return {scope:'full',rows,alerts:aiAlertsFromView(view,metrics),
   register:AI_FEATURES.map(f=>({featureId:f.id,entry:AI_DATA_REGISTER[f.id]})),provider:view.provider};
 });
}

export type AiAlertBanner=Readonly<{status:'not_shown'}|{status:'ok';alerts:readonly AiAlert[]}|{status:'unavailable'}>;
/** Alerts for the banner on every AI management page. Group administrators only. A failed check is logged with its
 * error class only (never its message, SQL or values) and shown as "could not be checked", never as "all clear". */
export async function aiManagementAlerts(supplied:SessionContext,view:ManagementView):Promise<AiAlertBanner>{
 const ctx=capture(supplied);
 if(!isGroupAdmin(ctx))return {status:'not_shown'};
 try{
  return await withTenant(ctx,async tx=>{
   await assertAiPrincipalTx(tx,ctx);
   if(!await groupAdminClaimTx(tx,ctx))return {status:'not_shown'} as const;
   return {status:'ok',alerts:aiAlertsFromView(view,await runAlertMetricsTx(tx))} as const;
  });
 }catch(error){
  console.error(`ai-alerts: banner check unavailable (${error instanceof Error?error.name:'unknown'})`);
  return {status:'unavailable'};
 }
}

/** Group administrators pause or resume ONE agent action under hr_assistant. The SQL writer re-checks the group
 * role, tenant, actor and action and takes the ai-control lock; the event records the key and the new state. */
export async function setAgentActionPause(supplied:SessionContext,actionId:unknown,paused:unknown){
 const ctx=capture(supplied);
 if(!isAdmin(ctx)||!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may pause an agent action.');
 const action=agentActionById(actionId);
 if(!action||typeof paused!=='boolean')throw new AiControlError('Unknown agent action.');
 await withTenant(ctx,async tx=>{
  await assertAiPrincipalTx(tx,ctx);
  if(!await groupAdminClaimTx(tx,ctx))throw new AiControlError('Current AI administration access could not be confirmed.');
  await tx.execute(sql`select app.ai_agent_action_pause_set(${action.id},${paused})`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:ctx.tenantId,eventType:'ai-control.action-pause-changed',actor:actorOf(ctx),
   payload:{actionId:action.id,pauseKey:agentActionPauseKey(action),paused}});
 });
}

export type AiRunHistoryRow={id:string;actor:string|null;feature:string;operation:string;provider:string;model:string;state:string;reason:string|null;
 actual:number|null;reserved:number;startedAt:Date;reportedCredits:string|null;roundTripMs:number|null;observationStatus:string|null};
/** Run history, newest first, AI_RUN_PAGE_SIZE per page within an inclusive Kuala Lumpur date range.
 * Group administrators only (ai_model_run's read policy says the same). */
export async function aiRunHistory(supplied:SessionContext,input:{from?:unknown;to?:unknown;page?:unknown},filter:AiRunFilter={}):Promise<{range:AiRunRange;rows:AiRunHistoryRow[];hasMore:boolean}>{
 const ctx=capture(supplied);
 if(!isAdmin(ctx)||!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may view AI runs.');
 const range=parseAiRunRange(input,todayInKualaLumpur());
 const state=filter.state==='blocked'||filter.state==='failed'?filter.state:null,feature=filter.feature&&isAiFeature(filter.feature)?filter.feature:null;
 const {fromTs,toTs}=aiRunRangeBounds(range);
 return withTenant(ctx,async tx=>{
  await assertAiPrincipalTx(tx,ctx);
  if(!await groupAdminClaimTx(tx,ctx))throw new AiControlError('Current AI administration access could not be confirmed.');
  const rows=Array.from(await tx.execute<{id:string;actor:string|null;feature:string;operation:string;provider:string;model:string;state:string;reason:string|null;
   actual:string|null;reserved:string;started_at:string|Date;credits:string|null;round_trip:number|null;observation:string|null}>(sql`
   select r.id,coalesce(p.full_name,u.workos_user_id) as actor,r.feature_id as feature,r.operation,r.provider,r.model,r.state,r.reason,
    r.actual_tokens as actual,r.reserved_tokens as reserved,r.started_at,r.openrouter_account_cost_credits::text as credits,
    r.observed_round_trip_ms as round_trip,r.provider_observation_status as observation
   from ai_model_run r left join app_user u on u.id=r.user_id left join person p on p.id=u.person_id
   where r.started_at>=${fromTs}::timestamptz and r.started_at<${toTs}::timestamptz
    and (${state}::text is null or r.state=${state}) and (${feature}::text is null or r.feature_id=${feature})
   order by r.started_at desc,r.id desc limit ${AI_RUN_PAGE_SIZE+1} offset ${aiRunPageOffset(range)}`));
  return {range,hasMore:rows.length>AI_RUN_PAGE_SIZE,rows:rows.slice(0,AI_RUN_PAGE_SIZE).map(r=>({id:r.id,actor:r.actor,feature:r.feature,operation:r.operation,provider:r.provider,model:r.model,
   state:r.state,reason:r.reason,actual:r.actual==null?null:Number(r.actual),reserved:Number(r.reserved),startedAt:new Date(r.started_at),reportedCredits:r.credits,roundTripMs:r.round_trip==null?null:Number(r.round_trip),observationStatus:r.observation}))};
 });
}
