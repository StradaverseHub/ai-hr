import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { aiControlPolicy, aiModelRun, appUser, company, person, assistantBudget } from '../db/schema';
import { isAdmin, isGroupAdmin } from '../lib/authz';
import { AI_FEATURES, isAiFeature, type AiFeatureId } from '../lib/ai/features';
import { resolveEntitlementsTx, isModuleEnabled, getSetting } from './entitlements';
import { SETTING_CATALOG } from '../packs/catalog';
import { getAiConfigView, resolveActiveAiConfig } from './ai-config';
import { grantAssistant, revokeAssistant } from './assistant-grant';
import { setTenantSetting } from './tenant-settings';

export class AiControlError extends Error {}
const assertAdmin = (ctx: SessionContext) => { if (!isAdmin(ctx)) throw new AiControlError('Only HR administrators may manage AI.'); };
export function parseAiAllowance(value: string, maximum: number): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim())) throw new AiControlError('Enter a whole number of zero or more, or leave blank for no additional cap.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > maximum) throw new AiControlError(`The allowance must be at most ${maximum}.`);
  return n;
}
export type AiUsageSummary = {feature_id:string;daily_requests:string;monthly_tokens:string;held_tokens:string;blocked:string;failed:string};
export async function aiManagementView(ctx: SessionContext, search = '') {
  assertAdmin(ctx);
  const provider = await getAiConfigView(ctx);
  return withTenant(ctx, async tx => {
    const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
    const policies = await tx.select().from(aiControlPolicy).orderBy(asc(aiControlPolicy.scopeKey));
    const activeProvider = provider.providers.find(p => p.isActive);
    let usable = false;
    try { usable = !!await resolveActiveAiConfig(tx,ctx); } catch { /* Render an unavailable state; never expose key/decryption errors. */ }
    const selectedProvider = usable ? activeProvider ? {provider:activeProvider.provider,model:activeProvider.model} : provider.envFallback : null;
    // Only provider/model metadata crosses to the view, after checking that its key can be resolved.
    const features = AI_FEATURES.map(f => {
      const setting = f.setting ? SETTING_CATALOG.find(s => s.key === f.setting) : undefined;
      const enabled = setting ? (fresh.entitlements.settings[f.setting!] ?? setting.defaultValue) === true : policies.find(p => p.scopeKey === `feature:${f.id}`)?.enabled !== false;
      const effective = enabled && (!setting || getSetting(fresh,f.setting!) === true);
      const moduleHeld = f.module == null || isModuleEnabled(fresh, f.module);
      const state = !enabled ? 'paused' : !moduleHeld ? 'module' : !effective ? 'restricted' : !selectedProvider && f.id !== 'readiness_reminders' ? 'provider' : 'ready';
      return {...f,enabled,state,mayWrite:isGroupAdmin(ctx)&&f.kind!=='platform'};
    });
    const companies = await tx.select({id:company.id,label:company.legalName}).from(company)
      .where(sql`app.is_admin_for(${company.id})`).orderBy(asc(company.legalName),asc(company.id));
    const companyUsage = await tx.execute<AiUsageSummary & {company_id:string}>(sql`select * from app.ai_company_usage() order by company_id,feature_id`);
    const usage = await tx.execute<AiUsageSummary>(sql`select * from app.ai_feature_usage() order by feature_id`);
    const pattern = `%${search.trim().slice(0,100).replace(/[\\%_]/g, '\\$&')}%`;
    const users = isGroupAdmin(ctx) ? await tx.select({id:appUser.id,label:sql<string>`coalesce(${person.fullName},${appUser.workosUserId})`,assistantGranted:sql<boolean>`exists(select 1 from assistant_grant g where g.tenant_id=${ctx.tenantId}::uuid and g.app_user_id=${appUser.id} and g.revoked_at is null)`})
      .from(appUser).leftJoin(person,eq(appUser.personId,person.id))
      .where(and(eq(appUser.tenantId,ctx.tenantId),or(ilike(person.fullName,pattern),ilike(appUser.workosUserId,pattern))))
      .orderBy(asc(person.fullName),asc(appUser.id)).limit(51) : [];
    const userUsage = isGroupAdmin(ctx) ? await tx.execute<{user_id:string;daily_requests:string;monthly_tokens:string;held_tokens:string}>(sql`
      select user_id,count(*) filter(where started_at>=date_trunc('day',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur') as daily_requests,
      coalesce(sum(actual_tokens),0) as monthly_tokens,coalesce(sum(reserved_tokens) filter(where actual_tokens is null),0) as held_tokens
      from ai_model_run where tenant_id=${ctx.tenantId}::uuid and state<>'blocked'
      and user_id=any(array[${sql.join(users.slice(0,50).map(u=>sql`${u.id}::uuid`),sql`, `)}]::uuid[])
      and started_at>=date_trunc('month',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur' group by user_id order by user_id`) : [];
    const runs = isGroupAdmin(ctx) ? await tx.select({id:aiModelRun.id,actor:sql<string|null>`coalesce(${person.fullName},${appUser.workosUserId})`,feature:aiModelRun.featureId,operation:aiModelRun.operation,provider:aiModelRun.provider,model:aiModelRun.model,state:aiModelRun.state,reason:aiModelRun.reason,actual:aiModelRun.actualTokens,reserved:aiModelRun.reservedTokens,startedAt:aiModelRun.startedAt,finishedAt:aiModelRun.finishedAt})
      .from(aiModelRun).leftJoin(appUser,eq(aiModelRun.userId,appUser.id)).leftJoin(person,eq(appUser.personId,person.id)).orderBy(desc(aiModelRun.startedAt),desc(aiModelRun.id)).limit(50) : [];
    const legacyBudgets = isGroupAdmin(ctx) ? await tx.select({monthly:assistantBudget.monthlyTokenCeiling,daily:assistantBudget.perUserDailyQuestions,effectiveFrom:assistantBudget.effectiveFrom}).from(assistantBudget).where(and(eq(assistantBudget.tenantId,ctx.tenantId),sql`${assistantBudget.archivedAt} is null`,sql`${assistantBudget.effectiveFrom} <= (now() at time zone 'UTC')::date`)).orderBy(desc(assistantBudget.effectiveFrom),desc(assistantBudget.id)).limit(1) : [];
    return {features,policies,companies,companyUsage:Array.from(companyUsage),usage:Array.from(usage),users:users.slice(0,50),moreUsers:users.length>50,userUsage:Array.from(userUsage),runs,provider:selectedProvider,mayWriteUsers:isGroupAdmin(ctx),legacyBudget:legacyBudgets[0]??null};
  });
}

export async function setAiFeature(ctx: SessionContext, feature: AiFeatureId, enabled: boolean) {
  assertAdmin(ctx);
  if (!isGroupAdmin(ctx)) throw new AiControlError('Only a group administrator may change shared AI features.');
  if (!isAiFeature(feature) || typeof enabled !== 'boolean') throw new AiControlError('Unknown AI feature.');
  const entry = AI_FEATURES.find(f=>f.id===feature)!;
  if(entry.kind==='platform') throw new AiControlError('This feature is managed by the platform.');
  // Existing switches remain authoritative, including the deterministic reminder fallback.
  if(entry.setting) return setTenantSetting(ctx,{key:entry.setting,value:enabled});
  await withTenant(ctx,async tx=>{
    await tx.insert(aiControlPolicy).values({tenantId:ctx.tenantId,scopeKey:`feature:${feature}`,kind:'feature',featureId:feature,enabled,updatedByUserId:ctx.userId??null})
      .onConflictDoUpdate({target:[aiControlPolicy.tenantId,aiControlPolicy.scopeKey],set:{enabled,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`}});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:ctx.tenantId,eventType:'ai-control.feature-changed',actor:actorOf(ctx),payload:{feature,enabled}});
  });
}
export async function setAiAllowance(ctx:SessionContext,p:{kind:'company'|'user';subjectId:string;dailyRequests:number|null;monthlyTokens:number|null;enabled:boolean}){
  assertAdmin(ctx);
  if(!['company','user'].includes(p.kind)||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(p.subjectId)||typeof p.enabled!=='boolean')throw new AiControlError('Unknown allowance scope.');
  for(const [value,max] of [[p.dailyRequests,1000000],[p.monthlyTokens,1000000000000]] as const){if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>max))throw new AiControlError('Invalid AI allowance.');}
  await withTenant(ctx,async tx=>{
    if(p.kind==='user'&&!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change user allowances.');
    const [target]=p.kind==='company'
      ?await tx.select({id:company.id}).from(company).where(and(eq(company.id,p.subjectId),eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id})`))
      :await tx.select({id:appUser.id}).from(appUser).where(and(eq(appUser.id,p.subjectId),eq(appUser.tenantId,ctx.tenantId)));
    if(!target)throw new AiControlError('This user or company is outside your administrative scope.');
    const values={enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens,updatedByUserId:ctx.userId??null,updatedAt:sql`now()`};
    await tx.insert(aiControlPolicy).values({tenantId:ctx.tenantId,scopeKey:`${p.kind}:${p.subjectId}`,kind:p.kind,subjectId:p.subjectId,...values})
      .onConflictDoUpdate({target:[aiControlPolicy.tenantId,aiControlPolicy.scopeKey],set:values});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:p.subjectId,eventType:'ai-control.allowance-changed',actor:actorOf(ctx),payload:{kind:p.kind,enabled:p.enabled,dailyRequests:p.dailyRequests,monthlyTokens:p.monthlyTokens}});
  });
}

/** Reuses the existing grant owner; allowances themselves never grant a feature permission. */
export async function setAssistantPermission(ctx:SessionContext,userId:string,enabled:boolean){
 assertAdmin(ctx);
 if(!isGroupAdmin(ctx))throw new AiControlError('Only a group administrator may change shared AI permissions.');
 if(typeof enabled!=='boolean'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))throw new AiControlError('Unknown user.');
 const [target]=await withTenant(ctx,tx=>tx.select({id:appUser.id}).from(appUser).where(and(eq(appUser.id,userId),eq(appUser.tenantId,ctx.tenantId))));
 if(!target)throw new AiControlError('This user is outside your administrative scope.');
 if(enabled)await grantAssistant(ctx,{appUserId:target.id});else await revokeAssistant(ctx,{appUserId:target.id});
}
