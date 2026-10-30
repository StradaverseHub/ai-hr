import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { aiControlPolicy, aiModelRun, appUser, assistantGrant, company, person, assistantBudget } from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import { isAdmin, isGroupAdmin } from '../lib/authz-model';
import { AI_FEATURES, isAiFeature, type AiFeatureId } from '../lib/ai/features';
import { resolveEntitlementsTx, isModuleEnabled, getSetting } from './entitlements';
import { SETTING_CATALOG } from '../packs/catalog';
import { getAiConfigView, resolveActiveAiConfig } from './ai-config';
import { grantAssistant, revokeAssistant } from './assistant-grant';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { setTenantSetting } from './tenant-settings';
import { assertAiPrincipalTx } from './ai-principal';
import { isZeroCapped } from './ai-zero-cap';
import {aiSpendStatusTx} from './ai-spend-management';
import { agentSwitchStatesTx, type AgentFeature } from './agent-principal';

export class AiControlError extends Error {}
const assertAdmin = (ctx: SessionContext) => { if (!isAdmin(ctx)) throw new AiControlError('Only HR administrators may manage AI.'); };
const captureControlContext = (ctx: SessionContext): SessionContext => ({ ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) });
async function currentControlAdminTx(tx: Tx, ctx: SessionContext, groupOnly: boolean) {
  await assertAiPrincipalTx(tx, ctx);
  if (groupOnly) {
    const [row] = await tx.execute<{ allowed: boolean }>(sql`select app.is_group_admin() as allowed`);
    if (row?.allowed !== true) throw new AiControlError('Current AI administration access could not be confirmed.');
  }
}
type ScheduledAgentFeature=Extract<typeof AI_FEATURES[number],{kind:'agent'}>;
const isScheduledAgentFeature=(feature:typeof AI_FEATURES[number]):feature is ScheduledAgentFeature=>feature.kind==='agent';
/** Shared with the management screen. A switch is not runtime eligibility or a successful run. */
function scheduledAgentFeatureStatus(ctx:SessionContext,feature:ScheduledAgentFeature){
 const setting=SETTING_CATALOG.find(row=>row.key===feature.setting);
 const enabled=(ctx.entitlements?.settings[feature.setting]??setting?.defaultValue)===true;
 const moduleHeld=isModuleEnabled(ctx,feature.module),effective=enabled&&getSetting(ctx,feature.setting)===true;
 const state=!enabled?'paused' as const:!moduleHeld?'module' as const:!effective?'restricted' as const:
  feature.id==='readiness_reminders'?'templates' as const:'scheduled' as const;
 return {enabled,effective:effective&&moduleHeld,state};
}
export const ASSISTANT_AGENT_MANAGEMENT_HREF='/control-tower/agents/features#ai-features' as const;
/** Minimal administrator-only read. Deliberately never resolves provider configuration, keys, usage,
 * policies or user labels. Runs inside the caller's existing read-only Assistant transaction. */
export async function assistantAgentStatusTx(tx:Tx,supplied:SessionContext){
 const ctx=captureControlContext(supplied);assertAdmin(ctx);await currentControlAdminTx(tx,ctx,false);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 const switches=await agentSwitchStatesTx(tx,fresh);
 const agents=AI_FEATURES.filter(isScheduledAgentFeature).map(feature=>{
  const status=scheduledAgentFeatureStatus(fresh,feature),attribution=switches.find(row=>row.feature===feature.id)?.state??'not_applicable';
  // Only the two named-principal specialists require recorded switch attribution. In particular,
  // 'scheduled' still means scheduled AI is unavailable, even when these switch prerequisites pass.
  return Object.freeze({feature:feature.id,switchOn:status.enabled,effectiveSwitchOn:status.effective&&attribution!=='off'&&attribution!=='unattributed',state:status.state,attribution});
 });
 return Object.freeze({total:agents.length,switchesOn:agents.filter(row=>row.switchOn).length,
  effectiveSwitchesOn:agents.filter(row=>row.effectiveSwitchOn).length,agents:Object.freeze(agents),
  ...(isGroupAdmin(fresh)?{managementHref:ASSISTANT_AGENT_MANAGEMENT_HREF}:{})});
}
export function parseAiAllowance(value: string, maximum: number): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim())) throw new AiControlError('Enter a whole number of zero or more, or leave blank for no additional cap.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > maximum) throw new AiControlError(`The allowance must be at most ${maximum}.`);
  return n;
}
export type AiUsageSummary = {feature_id:string;daily_requests:string;monthly_tokens:string;held_tokens:string;blocked:string;failed:string};
export type AiAllowanceLevel = 'near'|'at';
/** Near from 80% and at from 100% of a cap. A zero cap is already at its limit; blank is no cap. */
export function allowanceLevel(used:number,limit:number|null|undefined):AiAllowanceLevel|null{
  if(limit==null)return null;
  return used>=limit?'at':used>=limit*0.8?'near':null;
}
export type AiMeter = {used:number;limit:number|null;level:AiAllowanceLevel|null};
const meter=(used:number,limit:number|null|undefined):AiMeter=>({used,limit:limit??null,level:allowanceLevel(used,limit)});
/** Daily requests and monthly tokens, the latter counting held reservations exactly as admission does. */
export type AiAllowanceUse = {daily:AiMeter;tokens:AiMeter;recorded:number;held:number;enabled:boolean;maxConcurrent:number|null};
const allowanceUse=(daily:number,recorded:number,held:number,policy?:{enabled:boolean;dailyRequests:number|null;monthlyTokens:number|null;maxConcurrent?:number|null}):AiAllowanceUse=>
  ({daily:meter(daily,policy?.dailyRequests),tokens:meter(recorded+held,policy?.monthlyTokens),recorded,held,enabled:policy?.enabled!==false,maxConcurrent:policy?.maxConcurrent??null});
/** Attention lists pressure on a cap (usage at 80% or more) and scopes paused by a zero cap, even before
 *  anyone tries a call. A subject paused by its access switch is not listed. */
const pressing=(u:AiAllowanceUse)=>u.enabled&&(isZeroCapped(u)||(u.daily.level!==null&&u.daily.used>0)||(u.tokens.level!==null&&u.tokens.used>0));
export const AI_RUN_STATE_FILTERS = ['blocked','failed'] as const;
export type AiRunFilter = {state?:typeof AI_RUN_STATE_FILTERS[number];feature?:AiFeatureId};
const DAY_START=sql`(date_trunc('day',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur')`;
const MONTH_START=sql`(date_trunc('month',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur')`;
type UserUsageRow = {id:string;label:string;daily_requests:string;monthly_tokens:string;held_tokens:string;blocked_today:string;last_reason:string|null};
export const AI_GROUP_KINDS = ['group_department','group_company','group_role'] as const;
export type AiGroupKind = (typeof AI_GROUP_KINDS)[number];
const isGroupKind = (kind:string): kind is AiGroupKind => (AI_GROUP_KINDS as readonly string[]).includes(kind);
type PolicyLimits = {enabled:boolean;dailyRequests:number|null;monthlyTokens:number|null;maxConcurrent?:number|null};
/** Every row of one group tier binds, so for display the strictest value of each limit applies. */
const strictest = (rows:readonly PolicyLimits[]):PolicyLimits => {
  const least = (values:(number|null|undefined)[]) => { const set = values.filter((v):v is number=>v!=null); return set.length ? Math.min(...set) : null; };
  return {enabled:rows.every(r=>r.enabled),dailyRequests:least(rows.map(r=>r.dailyRequests)),monthlyTokens:least(rows.map(r=>r.monthlyTokens)),maxConcurrent:least(rows.map(r=>r.maxConcurrent))};
};
export async function aiManagementView(ctx: SessionContext, search = '', runFilter: AiRunFilter = {}) {
  ctx=captureControlContext(ctx);assertAdmin(ctx);
  // Tenant key/routing configuration needs fresh group-wide authority (getAiConfigView). A company
  // administrator still manages its own scope here and sees only the provider/model its resolved
  // configuration would use, never the tenant configuration view.
  const provider = isGroupAdmin(ctx) ? await getAiConfigView(ctx) : null;
  return withTenant(ctx, async tx => {
    await currentControlAdminTx(tx,ctx,false);
    const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
    const policies = await tx.select().from(aiControlPolicy).orderBy(asc(aiControlPolicy.scopeKey));
    const activeProvider = provider?.providers.find(p => p.isActive);
    let resolved: Pick<NonNullable<Awaited<ReturnType<typeof resolveActiveAiConfig>>>,'provider'|'model'> | null = null;
    try { const cfg = await resolveActiveAiConfig(tx,ctx); resolved = cfg ? {provider:cfg.provider,model:cfg.model} : null; } catch { /* Render an unavailable state; never expose key/decryption errors. */ }
    const usable = resolved !== null;
    const selectedProvider = !usable ? null : provider ? activeProvider ? {provider:activeProvider.provider,model:activeProvider.model} : provider.envFallback : resolved;
    // Only provider/model metadata crosses to the view, after checking that its key can be resolved.
    const features = AI_FEATURES.map(f => {
      if(isScheduledAgentFeature(f)){const status=scheduledAgentFeatureStatus(fresh,f);return {...f,enabled:status.enabled,state:status.state,mayWrite:isGroupAdmin(ctx)};}
      const setting = f.setting ? SETTING_CATALOG.find(s => s.key === f.setting) : undefined;
      const enabled = setting ? (fresh.entitlements.settings[f.setting!] ?? setting.defaultValue) === true : policies.find(p => p.scopeKey === `feature:${f.id}`)?.enabled !== false;
      const effective = enabled && (!setting || getSetting(fresh,f.setting!) === true);
      const moduleHeld = f.module == null || isModuleEnabled(fresh, f.module);
      // A configured provider does not admit scheduled model spend. This is a runtime-status mirror,
      // never an allowance or a grant to the principal.
      const state = !enabled ? 'paused' : !moduleHeld ? 'module' : !effective ? 'restricted'
        : !selectedProvider ? 'provider' : 'ready';
      return {...f,enabled,state,mayWrite:isGroupAdmin(ctx)&&f.kind!=='platform'};
    });
    // ADR-0151 §4.5 — the switch-on each agent specialist runs under, and who made it. An agent that is on
    // without a named administrator does not run until somebody switches it off and on again.
    const switches = await agentSwitchStatesTx(tx, fresh);
    const switchedBy = switches.flatMap(s => s.state === 'attributed' ? [s.userId] : []);
    const switchNames = new Map(switchedBy.length ? Array.from(await tx.execute<{id:string;label:string}>(sql`
      select u.id,coalesce(p.full_name,u.workos_user_id) as label from app_user u left join person p on p.id=u.person_id
      where u.tenant_id=${ctx.tenantId}::uuid and u.id in (${sql.join(switchedBy.map(id=>sql`${id}::uuid`),sql`,`)})`)).map(r=>[r.id,r.label]) : []);
    const agentSwitches: Partial<Record<AgentFeature,{state:'attributed';by:string|null;at:Date}|{state:'unattributed'|'off'}>> =
      Object.fromEntries(switches.map(s => [s.feature, s.state === 'attributed' ? {state:s.state,by:switchNames.get(s.userId)??null,at:s.at} : {state:s.state}]));
    const companyRows = await tx.select({id:company.id,label:company.legalName}).from(company)
      .where(sql`app.is_admin_for(${company.id})`).orderBy(asc(company.legalName),asc(company.id));
    const companyUsage = Array.from(await tx.execute<AiUsageSummary & {company_id:string}>(sql`select * from app.ai_company_usage() order by company_id,feature_id`));
    const usage = await tx.execute<AiUsageSummary>(sql`select * from app.ai_feature_usage() order by feature_id`);
    const companies = companyRows.map(c=>{
      const rows=companyUsage.filter(u=>u.company_id===c.id),sum=(k:keyof AiUsageSummary)=>rows.reduce((a,r)=>a+Number(r[k]),0);
      return {...c,blocked:sum('blocked'),failed:sum('failed'),...allowanceUse(sum('daily_requests'),sum('monthly_tokens'),sum('held_tokens'),policies.find(p=>p.scopeKey===`company:${c.id}`))};
    });
    const userDefault = policies.find(p=>p.scopeKey==='user_default') ?? null;
    // Display mirror of app._ai_applicable_policies (0662), which admission applies: an individual policy;
    // else the most specific matching group tier (department, company, role), every row of that tier
    // binding so the strictest limit wins; else the tenant default. They never stack.
    const groups = policies.filter(p=>isGroupKind(p.kind));
    let memberships = new Map<string,{roles:string[];departments:string[];companies:string[]}>();
    const effectiveUserPolicy = (id:string) => {
      const own = policies.find(p=>p.scopeKey===`user:${id}`);
      if (own) return {source:'individual' as const,policy:own,group:null};
      const m = memberships.get(id);
      if (m) for (const [kind,subjects] of [['group_department',m.departments],['group_company',m.companies],['group_role',m.roles.map(role=>`role:${role}`)]] as const) {
        const tier = groups.filter(g=>g.kind===kind&&(kind==='group_role'?subjects.includes(g.scopeKey.slice('group_'.length)):subjects.includes(g.subjectId??'')));
        if (tier.length) return {source:'group' as const,policy:strictest(tier),group:{kind,count:tier.length,scopeKey:tier[0].scopeKey}};
      }
      return userDefault ? {source:'default' as const,policy:userDefault,group:null} : {source:null,policy:undefined,group:null};
    };
    const toUser = (r:UserUsageRow) => {const {source,policy,group}=effectiveUserPolicy(r.id);return {id:r.id,label:r.label,source,group,...allowanceUse(Number(r.daily_requests),Number(r.monthly_tokens),Number(r.held_tokens),policy)};};
    const pattern = `%${search.trim().slice(0,100).replace(/[\\%_]/g, '\\$&')}%`;
    // Heaviest users first, computed over every matching login rather than an alphabetical first page.
    const userRows = isGroupAdmin(ctx) ? Array.from(await tx.execute<UserUsageRow & {assistant_granted:boolean}>(sql`
      select u.id,coalesce(p.full_name,u.workos_user_id) as label,
      exists(select 1 from assistant_grant g where g.tenant_id=${ctx.tenantId}::uuid and g.app_user_id=u.id and g.revoked_at is null) as assistant_granted,
      coalesce(a.daily_requests,0) as daily_requests,coalesce(a.monthly_tokens,0) as monthly_tokens,coalesce(a.held_tokens,0) as held_tokens,0 as blocked_today,null as last_reason
      from app_user u left join person p on p.id=u.person_id
      left join lateral(select count(*) filter(where r.started_at>=${DAY_START}) as daily_requests,coalesce(sum(r.actual_tokens),0) as monthly_tokens,
        coalesce(sum(r.reserved_tokens) filter(where r.actual_tokens is null),0) as held_tokens
        from ai_model_run r where r.tenant_id=u.tenant_id and r.user_id=u.id and r.operation<>'probe' and r.state<>'blocked' and r.started_at>=${MONTH_START}) a on true
      where u.tenant_id=${ctx.tenantId}::uuid and(p.full_name ilike ${pattern} or u.workos_user_id ilike ${pattern})
      order by coalesce(a.monthly_tokens+a.held_tokens,0) desc,coalesce(a.daily_requests,0) desc,p.full_name asc,u.id asc limit 51`)) : [];
    // Every login active this month, so attention is never limited to the visible page.
    const activity = isGroupAdmin(ctx) ? Array.from(await tx.execute<UserUsageRow>(sql`
      select r.user_id as id,coalesce(p.full_name,u.workos_user_id) as label,
      count(*) filter(where r.operation<>'probe' and r.state<>'blocked' and r.started_at>=${DAY_START}) as daily_requests,
      coalesce(sum(r.actual_tokens) filter(where r.operation<>'probe' and r.state<>'blocked'),0) as monthly_tokens,
      coalesce(sum(r.reserved_tokens) filter(where r.operation<>'probe' and r.state<>'blocked' and r.actual_tokens is null),0) as held_tokens,
      count(*) filter(where r.state='blocked' and r.started_at>=${DAY_START}) as blocked_today,
      (array_agg(r.reason order by r.started_at desc,r.id desc) filter(where r.state='blocked' and r.started_at>=${DAY_START}))[1] as last_reason
      from ai_model_run r join app_user u on u.id=r.user_id left join person p on p.id=u.person_id
      where r.operation<>'probe' and r.tenant_id=${ctx.tenantId}::uuid and r.started_at>=${MONTH_START}
      group by r.user_id,u.workos_user_id,p.full_name order by r.user_id`)) : [];
    // A login paused by its own zero cap belongs in attention even if it never tried a call this month,
    // so it is not found only through this month's activity. Bounded by the individual policies saved.
    const quietCapped = isGroupAdmin(ctx) ? policies.filter(p=>p.scopeKey.startsWith('user:')&&p.enabled!==false&&isZeroCapped({daily:{limit:p.dailyRequests},tokens:{limit:p.monthlyTokens},maxConcurrent:p.maxConcurrent??null}))
      .map(p=>p.scopeKey.slice(5)).filter(id=>!activity.some(r=>r.id===id)) : [];
    const quietRows = quietCapped.length ? Array.from(await tx.execute<UserUsageRow>(sql`
      select u.id,coalesce(p.full_name,u.workos_user_id) as label,0 as daily_requests,0 as monthly_tokens,0 as held_tokens,0 as blocked_today,null as last_reason
      from app_user u left join person p on p.id=u.person_id
      where u.tenant_id=${ctx.tenantId}::uuid and u.id in (${sql.join(quietCapped.map(id=>sql`${id}::uuid`),sql`,`)}) order by u.id`)) : [];
    // Group memberships for every login shown or listed in attention, read the way 0662 admission reads them.
    const shownIds = [...new Set([...userRows.slice(0,50),...activity,...quietRows].map(r=>r.id))];
    if (groups.length && shownIds.length) memberships = new Map(Array.from(await tx.execute<{id:string;roles:string[];departments:string[];companies:string[]}>(sql`
      select u.id,
       array(select r.role::text from role_assignment r where r.tenant_id=u.tenant_id and r.app_user_id=u.id order by 1) as roles,
       array(select a.department_id::text from employment e join assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id
        where e.tenant_id=u.tenant_id and e.person_id=u.person_id and a.superseded_at is null and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date
        and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date) order by 1) as departments,
       array(select coalesce(a.company_id,e.company_id)::text from employment e join assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id
        where e.tenant_id=u.tenant_id and e.person_id=u.person_id and a.superseded_at is null and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date
        and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date) order by 1) as companies
      from app_user u where u.tenant_id=${ctx.tenantId}::uuid and u.id in (${sql.join(shownIds.map(id=>sql`${id}::uuid`),sql`,`)})`)).map(r=>[r.id,{roles:r.roles??[],departments:r.departments??[],companies:r.companies??[]}]));
    const users = userRows.slice(0,50).map(r=>({...toUser(r),assistantGranted:r.assistant_granted===true}));
    const runs = isGroupAdmin(ctx) ? await tx.select({id:aiModelRun.id,actor:sql<string|null>`coalesce(${person.fullName},${appUser.workosUserId})`,feature:aiModelRun.featureId,operation:aiModelRun.operation,provider:aiModelRun.provider,model:aiModelRun.model,state:aiModelRun.state,reason:aiModelRun.reason,actual:aiModelRun.actualTokens,reserved:aiModelRun.reservedTokens,startedAt:aiModelRun.startedAt,finishedAt:aiModelRun.finishedAt,reportedCredits:aiModelRun.openrouterAccountCostCredits,roundTripMs:aiModelRun.observedRoundTripMs,observationStatus:aiModelRun.providerObservationStatus})
      .from(aiModelRun).leftJoin(appUser,eq(aiModelRun.userId,appUser.id)).leftJoin(person,eq(appUser.personId,person.id))
      .where(and(runFilter.state?eq(aiModelRun.state,runFilter.state):undefined,runFilter.feature?eq(aiModelRun.featureId,runFilter.feature):undefined))
      .orderBy(desc(aiModelRun.startedAt),desc(aiModelRun.id)).limit(50) : [];
    const legacyBudgets = isGroupAdmin(ctx) ? await tx.select({monthly:assistantBudget.monthlyTokenCeiling,daily:assistantBudget.perUserDailyQuestions,effectiveFrom:assistantBudget.effectiveFrom}).from(assistantBudget).where(and(eq(assistantBudget.tenantId,ctx.tenantId),sql`${assistantBudget.archivedAt} is null`,sql`${assistantBudget.effectiveFrom} <= ${todayInKualaLumpur()}::date`)).orderBy(desc(assistantBudget.effectiveFrom),desc(assistantBudget.id)).limit(1) : [];
    // Company administrators see only their own companies' aggregates here: no login identities.
    const attention = {
      companies: companies.filter(pressing),
      users: [...activity,...quietRows].map(toUser).filter(pressing).sort((a,b)=>b.tokens.used-a.tokens.used||b.daily.used-a.daily.used||a.label.localeCompare(b.label)),
      blocked: activity.filter(r=>Number(r.blocked_today)>0).map(r=>({id:r.id,label:r.label,count:Number(r.blocked_today),reason:r.last_reason}))
        .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label)),
    };
    return {spend:await aiSpendStatusTx(tx,ctx),features,agentSwitches,policies,userDefault,companies,companyUsage,usage:Array.from(usage),users,moreUsers:userRows.length>50,attention,groups:isGroupAdmin(ctx)?groups:[],runs,runFilter,provider:selectedProvider,mayWriteUsers:isGroupAdmin(ctx),legacyBudget:legacyBudgets[0]??null};
  });
}

export async function setAiFeature(ctx: SessionContext, feature: AiFeatureId, enabled: boolean) {
  ctx = captureControlContext(ctx);
  assertAdmin(ctx);
  if (!isGroupAdmin(ctx)) throw new AiControlError('Only a group administrator may change shared AI features.');
  if (!isAiFeature(feature) || typeof enabled !== 'boolean') throw new AiControlError('Unknown AI feature.');
  const entry = AI_FEATURES.find(f=>f.id===feature)!;
  if(entry.kind==='platform') throw new AiControlError('This feature is managed by the platform.');
  // Existing switches remain authoritative, including the deterministic reminder fallback.
  if(entry.setting) return withTenant(ctx, async tx => {
    await currentControlAdminTx(tx, ctx, true);
    await setTenantSetting(ctx, { key: entry.setting!, value: enabled }, tx);
  });
  await withTenant(ctx,async tx=>{
    await currentControlAdminTx(tx, ctx, true);
    await tx.insert(aiControlPolicy).values({tenantId:ctx.tenantId,scopeKey:`feature:${feature}`,kind:'feature',featureId:feature,enabled,updatedByUserId:ctx.userId??null})
      .onConflictDoUpdate({target:[aiControlPolicy.tenantId,aiControlPolicy.scopeKey],set:{enabled,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`}});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:ctx.tenantId,eventType:'ai-control.feature-changed',actor:actorOf(ctx),payload:{feature,enabled}});
  });
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type AiAllowanceKind = 'company'|'user'|'user_default';
/** `user_default` is the tenant-wide allowance for every login without an individual policy; it has no subject. */
export async function setAiAllowance(ctx:SessionContext,p:{kind:AiAllowanceKind;subjectId?:string|null;dailyRequests:number|null;monthlyTokens:number|null;maxConcurrent?:number|null;enabled:boolean}){
  ctx = captureControlContext(ctx);
  p = { kind: p.kind, subjectId: p.subjectId, dailyRequests: p.dailyRequests, monthlyTokens: p.monthlyTokens, maxConcurrent:p.maxConcurrent??null, enabled: p.enabled };
  assertAdmin(ctx);
  if(!['company','user','user_default'].includes(p.kind)||(p.kind!=='user_default'&&!UUID.test(p.subjectId??''))||typeof p.enabled!=='boolean')throw new AiControlError('Unknown allowance scope.');
  for(const [value,max] of [[p.dailyRequests,1000000],[p.monthlyTokens,1000000000000],[p.maxConcurrent??null,1000000]] as const){if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>max))throw new AiControlError('Invalid AI allowance.');}
  // The session role answers a company administrator plainly, as setAiFeature does; the fresh database
  // check below still refuses a stale group session. Both are required; neither widens the other.
  if(p.kind==='user'&&!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change user allowances.');
  if(p.kind==='user_default'&&!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change the default user allowance.');
  await withTenant(ctx,async tx=>{
    await currentControlAdminTx(tx, ctx, p.kind !== 'company');
    const subjectId=p.kind==='user_default'?null:p.subjectId!;
    if(subjectId){
      const [target]=p.kind==='company'
        ?await tx.select({id:company.id}).from(company).where(and(eq(company.id,subjectId),eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id})`))
        :await tx.select({id:appUser.id}).from(appUser).where(and(eq(appUser.id,subjectId),eq(appUser.tenantId,ctx.tenantId)));
      if(!target)throw new AiControlError('This user or company is outside your administrative scope.');
    }
    const values={enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens,maxConcurrent:p.maxConcurrent??null,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`};
    await tx.insert(aiControlPolicy).values({tenantId:ctx.tenantId,scopeKey:subjectId?`${p.kind}:${subjectId}`:'user_default',kind:p.kind,subjectId,...values})
      .onConflictDoUpdate({target:[aiControlPolicy.tenantId,aiControlPolicy.scopeKey],set:values});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:subjectId??ctx.tenantId,eventType:'ai-control.allowance-changed',actor:actorOf(ctx),payload:{kind:p.kind,enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens,maxConcurrent:p.maxConcurrent??null}});
  });
}
/** Returns a login to the tenant default by removing its individual policy; the removed values stay in the event history. */
export async function clearUserAllowance(ctx:SessionContext,userId:string){
  ctx = captureControlContext(ctx);
  assertAdmin(ctx);
  if(!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change user allowances.');
  if(!UUID.test(userId))throw new AiControlError('Unknown user.');
  await withTenant(ctx,async tx=>{
    await currentControlAdminTx(tx, ctx, true);
    const [removed]=await tx.delete(aiControlPolicy).where(and(eq(aiControlPolicy.tenantId,ctx.tenantId),eq(aiControlPolicy.scopeKey,`user:${userId}`),eq(aiControlPolicy.kind,'user'))).returning();
    if(!removed)throw new AiControlError('This login already follows the default allowance.');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:userId,eventType:'ai-control.allowance-cleared',actor:actorOf(ctx),payload:{kind:'user',enabled:removed.enabled,dailyRequests:removed.dailyRequests,monthlyTokens:removed.monthlyTokens,maxConcurrent:removed.maxConcurrent}});
  });
}

/** Reuses the existing grant owner; allowances themselves never grant a feature permission. */
export async function setAssistantPermission(ctx:SessionContext,userId:string,enabled:boolean){
 assertAdmin(ctx);
 if(!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change shared AI permissions.');
 if(typeof enabled!=='boolean'||!UUID.test(userId))throw new AiControlError('Unknown user.');
 const [target]=await withTenant(ctx,tx=>tx.select({id:appUser.id}).from(appUser).where(and(eq(appUser.id,userId),eq(appUser.tenantId,ctx.tenantId))));
 if(!target)throw new AiControlError('This user is outside your administrative scope.');
 if(enabled)await grantAssistant(ctx,{appUserId:target.id});else await revokeAssistant(ctx,{appUserId:target.id});
}

/** Bulk HR assistant access: everyone in one company, one department or one role, or an explicit list of
 * logins (the user list's multi-select / "all matching this search"). Membership is the CURRENT
 * assignment (not superseded, valid today) for company and department (an older assignment without its
 * own company falls back to the employment's company), and a live role assignment for a
 * role. Only active logins (not archived, not login-blocked) are counted. Group administrators only,
 * exactly like the single-login control; a grant still never bypasses the module entitlement or the
 * person's own permissions, which the Assistant re-checks on every question. */
export type BulkAssistantScope =
  | { kind: 'company'; companyId: string }
  | { kind: 'department'; departmentId: string }
  | { kind: 'role'; role: string }
  | { kind: 'users'; userIds: string[] }
  | { kind: 'search'; q: string };
export type BulkAssistantPreview = { matched: number; changing: number };
const BULK_ROLES = ['employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner'] as const;
function bulkScope(value: unknown): BulkAssistantScope {
  const v = value as Record<string, unknown> | null;
  if (v?.kind === 'company' && typeof v.companyId === 'string' && UUID.test(v.companyId)) return { kind: 'company', companyId: v.companyId };
  if (v?.kind === 'department' && typeof v.departmentId === 'string' && UUID.test(v.departmentId)) return { kind: 'department', departmentId: v.departmentId };
  if (v?.kind === 'role' && typeof v.role === 'string' && (BULK_ROLES as readonly string[]).includes(v.role)) return { kind: 'role', role: v.role };
  if (v?.kind === 'users' && Array.isArray(v.userIds) && v.userIds.length > 0 && v.userIds.length <= 5000 && v.userIds.every(id => typeof id === 'string' && UUID.test(id))) return { kind: 'users', userIds: [...new Set(v.userIds as string[])] };
  if (v?.kind === 'search' && typeof v.q === 'string' && v.q.trim().length > 0) return { kind: 'search', q: v.q.trim().slice(0, 100) };
  throw new AiControlError('Choose who this change is for.');
}
async function bulkTargetsTx(tx: Tx, ctx: SessionContext, scope: BulkAssistantScope, enabled: boolean) {
  const member = scope.kind === 'company'
    ? sql`exists(select 1 from public.employment e join public.assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id
        where e.tenant_id=u.tenant_id and e.person_id=u.person_id and coalesce(a.company_id,e.company_id)=${scope.companyId}::uuid and a.superseded_at is null
        and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date))`
    : scope.kind === 'department'
    ? sql`exists(select 1 from public.employment e join public.assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id
        where e.tenant_id=u.tenant_id and e.person_id=u.person_id and a.department_id=${scope.departmentId}::uuid and a.superseded_at is null
        and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (a.valid_to is null or a.valid_to>=(now() at time zone 'Asia/Kuala_Lumpur')::date))`
    : scope.kind === 'role'
    ? sql`exists(select 1 from public.role_assignment r where r.tenant_id=u.tenant_id and r.app_user_id=u.id and r.role::text=${scope.role})`
    : scope.kind === 'users'
    ? sql`u.id in (${sql.join(scope.userIds.map(id => sql`${id}::uuid`), sql`,`)})`
    // The same match the user list's search applies, so "all matching this search" means exactly that.
    : sql`exists(select 1 from public.person p where p.id=u.person_id and p.full_name ilike ${`%${scope.q.replace(/[\\%_]/g, '\\$&')}%`}) or u.workos_user_id ilike ${`%${scope.q.replace(/[\\%_]/g, '\\$&')}%`}`;
  const rows = await tx.execute<{ id: string; live: boolean }>(sql`select u.id,
      exists(select 1 from public.assistant_grant g where g.tenant_id=u.tenant_id and g.app_user_id=u.id and g.revoked_at is null) as live
    from public.app_user u where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) and (${member})
    order by u.id`);
  const matched = Array.from(rows);
  return { matched, changing: matched.filter(row => row.live !== enabled).map(row => row.id) };
}
/** How many logins the change covers, and how many it would actually change. Read-only. */
export async function previewBulkAssistantAccess(ctx: SessionContext, scopeValue: unknown, enabled: boolean): Promise<BulkAssistantPreview> {
  assertAdmin(ctx);
  if (!isGroupAdmin(ctx)) throw new AiControlError('Only a group administrator may change shared AI permissions.');
  const scope = bulkScope(scopeValue);
  return withTenant(ctx, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertAiPrincipalTx(tx, ctx);
    const { matched, changing } = await bulkTargetsTx(tx, ctx, scope, enabled);
    return { matched: matched.length, changing: changing.length };
  });
}
/** Applies the change the admin confirmed. If the number of logins that would change differs from the
 * confirmed count (someone joined, left or changed meanwhile), nothing is written and the admin is asked
 * to review the new count. One transaction: each login gets its own grant row or revocation stamp and its
 * own event (individually traceable), plus one bulk event carrying the scope and the count. */
export async function applyBulkAssistantAccess(ctx: SessionContext, scopeValue: unknown, enabled: boolean, confirmedChanging: number): Promise<{ changed: number }> {
  assertAdmin(ctx);
  if (!isGroupAdmin(ctx)) throw new AiControlError('Only a group administrator may change shared AI permissions.');
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(confirmedChanging) || confirmedChanging < 0) throw new AiControlError('Review the change again.');
  const scope = bulkScope(scopeValue);
  return withTenant(ctx, async tx => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    await assertAiPrincipalTx(tx, ctx);
    const [group] = await tx.execute<{ allowed: boolean }>(sql`select app.is_group_admin() as allowed`);
    if (group?.allowed !== true) throw new AiControlError('Only a group administrator may change shared AI permissions.');
    const { changing } = await bulkTargetsTx(tx, ctx, scope, enabled);
    if (changing.length !== confirmedChanging) throw new AiControlError('The number of people changed since you reviewed it. Review the new count and confirm again.');
    for (const appUserId of changing) {
      if (enabled) {
        const [row] = await tx.insert(assistantGrant).values({ tenantId: ctx.tenantId, appUserId, grantedByUserId: ctx.userId ?? null }).onConflictDoNothing().returning({ id: assistantGrant.id });
        if (row) await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'assistant-grant', aggregateId: row.id, eventType: 'assistant-grant.granted', actor: actorOf(ctx), payload: { appUserId, bulk: true } });
      } else {
        const rows = await tx.update(assistantGrant).set({ revokedAt: new Date(), revokedByUserId: ctx.userId ?? null })
          .where(and(eq(assistantGrant.appUserId, appUserId), eq(assistantGrant.tenantId, ctx.tenantId), isNull(assistantGrant.revokedAt))).returning({ id: assistantGrant.id });
        for (const row of rows) await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'assistant-grant', aggregateId: row.id, eventType: 'assistant-grant.revoked', actor: actorOf(ctx), payload: { appUserId, bulk: true } });
      }
    }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'assistant-grant-bulk', aggregateId: ctx.tenantId, eventType: enabled ? 'assistant-grant.bulk-granted' : 'assistant-grant.bulk-revoked', actor: actorOf(ctx),
      payload: { scope: scope.kind === 'users' ? { kind: 'users', count: scope.userIds.length } : scope.kind === 'search' ? { kind: 'search' } : scope, changed: changing.length } });
    return { changed: changing.length };
  });
}

/** Choices for the bulk control: companies (from the AI management view) and active departments. */
export async function bulkAssistantDepartments(ctx: SessionContext): Promise<{ id: string; label: string }[]> {
  assertAdmin(ctx);
  if (!isGroupAdmin(ctx)) return [];
  return withTenant(ctx, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const rows = await tx.execute<{ id: string; label: string }>(sql`select d.id, coalesce(nullif(trim(d.label),''),d.name)||' · '||c.legal_name as label
      from public.department d join public.company c on c.id=d.company_id and c.tenant_id=d.tenant_id
      where d.tenant_id=${ctx.tenantId}::uuid and d.archived_at is null order by c.legal_name, coalesce(nullif(trim(d.label),''),d.name), d.id limit 500`);
    return Array.from(rows);
  });
}

/** A group allowance: one per role, company or department, applied to each login in it (0662). Group
 * administrators only; the database write policy and guard re-check the scope and the subject. */
const groupScopeKey = (kind:AiGroupKind,subject:string) => `${kind}:${subject}`;
function groupTarget(kind:unknown,subject:unknown):{kind:AiGroupKind;subject:string}{
  if (kind==='group_role' && typeof subject==='string' && (BULK_ROLES as readonly string[]).includes(subject)) return {kind,subject};
  if ((kind==='group_company'||kind==='group_department') && typeof subject==='string' && UUID.test(subject)) return {kind,subject:subject.toLowerCase()};
  throw new AiControlError('Unknown allowance scope.');
}
export async function setGroupAllowance(ctx:SessionContext,p:{kind:unknown;subject:unknown;dailyRequests:number|null;monthlyTokens:number|null;maxConcurrent?:number|null;enabled:boolean}){
  ctx = captureControlContext(ctx);
  assertAdmin(ctx);
  if(!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change group allowances.');
  const target = groupTarget(p.kind,p.subject);
  if(typeof p.enabled!=='boolean')throw new AiControlError('Unknown allowance scope.');
  for(const [value,max] of [[p.dailyRequests,1000000],[p.monthlyTokens,1000000000000],[p.maxConcurrent??null,1000000]] as const){if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>max))throw new AiControlError('Invalid AI allowance.');}
  await withTenant(ctx,async tx=>{
    await currentControlAdminTx(tx, ctx, true);
    if(target.kind!=='group_role'){
      const [found]=await tx.execute<{ok:boolean}>(target.kind==='group_company'
        ?sql`select exists(select 1 from public.company where id=${target.subject}::uuid and tenant_id=${ctx.tenantId}::uuid) as ok`
        :sql`select exists(select 1 from public.department where id=${target.subject}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null) as ok`);
      if(found?.ok!==true)throw new AiControlError('This company or department is outside your administrative scope.');
    }
    const values={enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens,maxConcurrent:p.maxConcurrent??null,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`};
    await tx.insert(aiControlPolicy).values({tenantId:ctx.tenantId,scopeKey:groupScopeKey(target.kind,target.subject),kind:target.kind,subjectId:target.kind==='group_role'?null:target.subject,...values})
      .onConflictDoUpdate({target:[aiControlPolicy.tenantId,aiControlPolicy.scopeKey],set:values});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:target.kind==='group_role'?ctx.tenantId:target.subject,eventType:'ai-control.allowance-changed',actor:actorOf(ctx),payload:{kind:target.kind,subject:target.subject,enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens,maxConcurrent:p.maxConcurrent??null}});
  });
}
/** Removes a group allowance; its logins fall back to the next tier. The values stay in the event history. */
export async function clearGroupAllowance(ctx:SessionContext,p:{kind:unknown;subject:unknown}){
  ctx = captureControlContext(ctx);
  assertAdmin(ctx);
  if(!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change group allowances.');
  const target = groupTarget(p.kind,p.subject);
  await withTenant(ctx,async tx=>{
    await currentControlAdminTx(tx, ctx, true);
    const [removed]=await tx.delete(aiControlPolicy).where(and(eq(aiControlPolicy.tenantId,ctx.tenantId),eq(aiControlPolicy.scopeKey,groupScopeKey(target.kind,target.subject)),eq(aiControlPolicy.kind,target.kind))).returning();
    if(!removed)throw new AiControlError('There is no allowance for this group.');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:target.kind==='group_role'?ctx.tenantId:target.subject,eventType:'ai-control.allowance-cleared',actor:actorOf(ctx),payload:{kind:target.kind,subject:target.subject,enabled:removed.enabled,dailyRequests:removed.dailyRequests,monthlyTokens:removed.monthlyTokens,maxConcurrent:removed.maxConcurrent}});
  });
}
