import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { aiControlPolicy, aiModelRun, appUser, company, person, assistantBudget } from '../db/schema';
import { isAdmin, isGroupAdmin } from '../lib/authz-model';
import { AI_FEATURES, isAiFeature, type AiFeatureId } from '../lib/ai/features';
import { resolveEntitlementsTx, isModuleEnabled, getSetting } from './entitlements';
import { SETTING_CATALOG } from '../packs/catalog';
import { getAiConfigView, resolveActiveAiConfig } from './ai-config';
import { grantAssistant, revokeAssistant } from './assistant-grant';
import { setTenantSetting } from './tenant-settings';
import { assertAiPrincipalTx } from './ai-principal';
import { isZeroCapped } from './ai-zero-cap';
import {aiSpendStatusTx} from './ai-spend-management';

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
      const setting = f.setting ? SETTING_CATALOG.find(s => s.key === f.setting) : undefined;
      const enabled = setting ? (fresh.entitlements.settings[f.setting!] ?? setting.defaultValue) === true : policies.find(p => p.scopeKey === `feature:${f.id}`)?.enabled !== false;
      const effective = enabled && (!setting || getSetting(fresh,f.setting!) === true);
      const moduleHeld = f.module == null || isModuleEnabled(fresh, f.module);
      const state = !enabled ? 'paused' : !moduleHeld ? 'module' : !effective ? 'restricted' : !selectedProvider && f.id !== 'readiness_reminders' ? 'provider' : 'ready';
      return {...f,enabled,state,mayWrite:isGroupAdmin(ctx)&&f.kind!=='platform'};
    });
    const companyRows = await tx.select({id:company.id,label:company.legalName}).from(company)
      .where(sql`app.is_admin_for(${company.id})`).orderBy(asc(company.legalName),asc(company.id));
    const companyUsage = Array.from(await tx.execute<AiUsageSummary & {company_id:string}>(sql`select * from app.ai_company_usage() order by company_id,feature_id`));
    const usage = await tx.execute<AiUsageSummary>(sql`select * from app.ai_feature_usage() order by feature_id`);
    const companies = companyRows.map(c=>{
      const rows=companyUsage.filter(u=>u.company_id===c.id),sum=(k:keyof AiUsageSummary)=>rows.reduce((a,r)=>a+Number(r[k]),0);
      return {...c,blocked:sum('blocked'),failed:sum('failed'),...allowanceUse(sum('daily_requests'),sum('monthly_tokens'),sum('held_tokens'),policies.find(p=>p.scopeKey===`company:${c.id}`))};
    });
    const userDefault = policies.find(p=>p.scopeKey==='user_default') ?? null;
    // An individual policy REPLACES the tenant default for its login; the two never stack.
    const effectiveUserPolicy = (id:string) => {
      const own = policies.find(p=>p.scopeKey===`user:${id}`);
      return own ? {source:'individual' as const,policy:own} : userDefault ? {source:'default' as const,policy:userDefault} : {source:null,policy:undefined};
    };
    const toUser = (r:UserUsageRow) => {const {source,policy}=effectiveUserPolicy(r.id);return {id:r.id,label:r.label,source,...allowanceUse(Number(r.daily_requests),Number(r.monthly_tokens),Number(r.held_tokens),policy)};};
    const pattern = `%${search.trim().slice(0,100).replace(/[\\%_]/g, '\\$&')}%`;
    // Heaviest users first, computed over every matching login rather than an alphabetical first page.
    const userRows = isGroupAdmin(ctx) ? Array.from(await tx.execute<UserUsageRow & {assistant_granted:boolean}>(sql`
      select u.id,coalesce(p.full_name,u.workos_user_id) as label,
      exists(select 1 from assistant_grant g where g.tenant_id=${ctx.tenantId}::uuid and g.app_user_id=u.id and g.revoked_at is null) as assistant_granted,
      coalesce(a.daily_requests,0) as daily_requests,coalesce(a.monthly_tokens,0) as monthly_tokens,coalesce(a.held_tokens,0) as held_tokens,0 as blocked_today,null as last_reason
      from app_user u left join person p on p.id=u.person_id
      left join lateral(select count(*) filter(where r.started_at>=${DAY_START}) as daily_requests,coalesce(sum(r.actual_tokens),0) as monthly_tokens,
        coalesce(sum(r.reserved_tokens) filter(where r.actual_tokens is null),0) as held_tokens
        from ai_model_run r where r.tenant_id=u.tenant_id and r.user_id=u.id and r.state<>'blocked' and r.started_at>=${MONTH_START}) a on true
      where u.tenant_id=${ctx.tenantId}::uuid and(p.full_name ilike ${pattern} or u.workos_user_id ilike ${pattern})
      order by coalesce(a.monthly_tokens+a.held_tokens,0) desc,coalesce(a.daily_requests,0) desc,p.full_name asc,u.id asc limit 51`)) : [];
    const users = userRows.slice(0,50).map(r=>({...toUser(r),assistantGranted:r.assistant_granted===true}));
    // Every login active this month, so attention is never limited to the visible page.
    const activity = isGroupAdmin(ctx) ? Array.from(await tx.execute<UserUsageRow>(sql`
      select r.user_id as id,coalesce(p.full_name,u.workos_user_id) as label,
      count(*) filter(where r.state<>'blocked' and r.started_at>=${DAY_START}) as daily_requests,
      coalesce(sum(r.actual_tokens) filter(where r.state<>'blocked'),0) as monthly_tokens,
      coalesce(sum(r.reserved_tokens) filter(where r.state<>'blocked' and r.actual_tokens is null),0) as held_tokens,
      count(*) filter(where r.state='blocked' and r.started_at>=${DAY_START}) as blocked_today,
      (array_agg(r.reason order by r.started_at desc,r.id desc) filter(where r.state='blocked' and r.started_at>=${DAY_START}))[1] as last_reason
      from ai_model_run r join app_user u on u.id=r.user_id left join person p on p.id=u.person_id
      where r.tenant_id=${ctx.tenantId}::uuid and r.started_at>=${MONTH_START}
      group by r.user_id,u.workos_user_id,p.full_name order by r.user_id`)) : [];
    // A login paused by its own zero cap belongs in attention even if it never tried a call this month,
    // so it is not found only through this month's activity. Bounded by the individual policies saved.
    const quietCapped = isGroupAdmin(ctx) ? policies.filter(p=>p.scopeKey.startsWith('user:')&&p.enabled!==false&&isZeroCapped({daily:{limit:p.dailyRequests},tokens:{limit:p.monthlyTokens},maxConcurrent:p.maxConcurrent??null}))
      .map(p=>p.scopeKey.slice(5)).filter(id=>!activity.some(r=>r.id===id)) : [];
    const quietRows = quietCapped.length ? Array.from(await tx.execute<UserUsageRow>(sql`
      select u.id,coalesce(p.full_name,u.workos_user_id) as label,0 as daily_requests,0 as monthly_tokens,0 as held_tokens,0 as blocked_today,null as last_reason
      from app_user u left join person p on p.id=u.person_id
      where u.tenant_id=${ctx.tenantId}::uuid and u.id::text = any(${quietCapped}::text[]) order by u.id`)) : [];
    const runs = isGroupAdmin(ctx) ? await tx.select({id:aiModelRun.id,actor:sql<string|null>`coalesce(${person.fullName},${appUser.workosUserId})`,feature:aiModelRun.featureId,operation:aiModelRun.operation,provider:aiModelRun.provider,model:aiModelRun.model,state:aiModelRun.state,reason:aiModelRun.reason,actual:aiModelRun.actualTokens,reserved:aiModelRun.reservedTokens,startedAt:aiModelRun.startedAt,finishedAt:aiModelRun.finishedAt,reportedCredits:aiModelRun.openrouterAccountCostCredits,roundTripMs:aiModelRun.observedRoundTripMs,observationStatus:aiModelRun.providerObservationStatus})
      .from(aiModelRun).leftJoin(appUser,eq(aiModelRun.userId,appUser.id)).leftJoin(person,eq(appUser.personId,person.id))
      .where(and(runFilter.state?eq(aiModelRun.state,runFilter.state):undefined,runFilter.feature?eq(aiModelRun.featureId,runFilter.feature):undefined))
      .orderBy(desc(aiModelRun.startedAt),desc(aiModelRun.id)).limit(50) : [];
    const legacyBudgets = isGroupAdmin(ctx) ? await tx.select({monthly:assistantBudget.monthlyTokenCeiling,daily:assistantBudget.perUserDailyQuestions,effectiveFrom:assistantBudget.effectiveFrom}).from(assistantBudget).where(and(eq(assistantBudget.tenantId,ctx.tenantId),sql`${assistantBudget.archivedAt} is null`,sql`${assistantBudget.effectiveFrom} <= (now() at time zone 'UTC')::date`)).orderBy(desc(assistantBudget.effectiveFrom),desc(assistantBudget.id)).limit(1) : [];
    // Company administrators see only their own companies' aggregates here: no login identities.
    const attention = {
      companies: companies.filter(pressing),
      users: [...activity,...quietRows].map(toUser).filter(pressing).sort((a,b)=>b.tokens.used-a.tokens.used||b.daily.used-a.daily.used||a.label.localeCompare(b.label)),
      blocked: activity.filter(r=>Number(r.blocked_today)>0).map(r=>({id:r.id,label:r.label,count:Number(r.blocked_today),reason:r.last_reason}))
        .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label)),
    };
    return {spend:await aiSpendStatusTx(tx,ctx),features,policies,userDefault,companies,companyUsage,usage:Array.from(usage),users,moreUsers:userRows.length>50,attention,runs,runFilter,provider:selectedProvider,mayWriteUsers:isGroupAdmin(ctx),legacyBudget:legacyBudgets[0]??null};
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
