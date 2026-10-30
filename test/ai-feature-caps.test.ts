/** Retained native per-feature caps. Extracted existing cases from mixed WP14 suite; no provider call. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {AiControlError,setAiFeature,setAiFeatureCap} from '../core/ai-management';
import {saveAiProviderConfig,setActiveProvider,getAiConfigView} from '../core/ai-config';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(closeAll);
const events=(type:string)=>owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,type)));
describe('per-feature caps (WP14)', () => {
  const admit = (ctx: SessionContext, feature: string, reserve = 100) => withTenant(ctx, async tx => (await tx.execute<{ run_id: string; allowed: boolean; blocked_reason: string | null }>(sql`select * from app.ai_admit(${feature},'draft','openai','fixture',${reserve}::bigint)`))[0]);
  const settle = (ctx: SessionContext, run: string, tokens: number) => withTenant(ctx, tx => tx.execute(sql`select app.ai_settle(${run}::uuid,true,${tokens}::bigint)`));

  it('lets a group administrator cap one feature for the whole tenant and ai_admit enforces it', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null, maxConcurrent: null });
    const first = await admit(ctx, 'pay_rule_draft');
    expect(first).toMatchObject({ allowed: true, blocked_reason: null });
    await settle(ctx, first.run_id, 10);
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    expect(await admit(ctx, 'payroll_explanation')).toMatchObject({ allowed: true });
    // Tokens: recorded plus the new reservation must stay within the monthly feature cap.
    await setAiFeatureCap(ctx, { feature: 'report_insight', dailyRequests: null, monthlyTokens: 150 });
    const used = await admit(ctx, 'report_insight', 100); await settle(ctx, used.run_id, 100);
    expect(await admit(ctx, 'report_insight', 60)).toMatchObject({ allowed: false, blocked_reason: 'monthly_limit' });
    expect(await admit(ctx, 'report_insight', 40)).toMatchObject({ allowed: true });
    const [policy] = await owner.db.select().from(schema.aiControlPolicy).where(and(eq(schema.aiControlPolicy.tenantId, base.tenantId), eq(schema.aiControlPolicy.scopeKey, 'feature:pay_rule_draft')));
    expect(policy).toMatchObject({ kind: 'feature', featureId: 'pay_rule_draft', subjectId: null, dailyRequests: 1, monthlyTokens: null, enabled: true });
    const changes = (await events('ai-control.feature-cap-changed')).map(e => e.payload);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(expect.arrayContaining([
      { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null, maxConcurrent: null },
      { feature: 'report_insight', dailyRequests: null, monthlyTokens: 150, maxConcurrent: null }]));
  });

  it('counts every login’s runs of the feature and keeps the feature switch separate from its cap', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    const [someone] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: 'fixture-other-login-' + randomUUID(), personId: null }).returning();
    await owner.db.insert(schema.aiModelRun).values({ tenantId: base.tenantId, userId: someone.id, featureId: 'pay_rule_draft', operation: 'draft', provider: 'openai', model: 'fixture', state: 'completed', reservedTokens: 10, actualTokens: 10 });
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 1, monthlyTokens: null });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    await setAiFeature(ctx, 'pay_rule_draft', false);
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    const scope = () => owner.db.select().from(schema.aiControlPolicy).where(and(eq(schema.aiControlPolicy.tenantId, base.tenantId), eq(schema.aiControlPolicy.scopeKey, 'feature:pay_rule_draft')));
    expect((await scope())[0]).toMatchObject({ enabled: false, dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: false, blocked_reason: 'paused' });
    await setAiFeature(ctx, 'pay_rule_draft', true);
    expect((await scope())[0]).toMatchObject({ enabled: true, dailyRequests: 5, monthlyTokens: 1000, maxConcurrent: 2 });
    expect(await admit(ctx, 'pay_rule_draft')).toMatchObject({ allowed: true });
    await setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: null, monthlyTokens: null, maxConcurrent: null });
    expect((await scope())[0]).toMatchObject({ enabled: true, dailyRequests: null, monthlyTokens: null, maxConcurrent: null });
  });

  it('refuses invalid values and features governed by a module setting, without a write', async () => {
    const ctx = { ...await entitledCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    for (const bad of [-1, 0.5, 1000001]) await expect(setAiFeatureCap(ctx, { feature: 'pay_rule_draft', dailyRequests: bad, monthlyTokens: null })).rejects.toBeInstanceOf(AiControlError);
    for (const feature of ['claims_triage', 'performance_review', 'feedback_planning', 'not_a_feature']) await expect(setAiFeatureCap(ctx, { feature, dailyRequests: 1, monthlyTokens: null })).rejects.toBeInstanceOf(AiControlError);
    expect(await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.tenantId, base.tenantId))).toEqual([]);
    // 0694 relaxed the constraint only for the caps of a well-formed feature row.
    await expect(owner.db.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, scopeKey: 'feature:report_insight', kind: 'feature', featureId: 'report_insight', subjectId: base.companyId, dailyRequests: 1 })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

it('keeps company HR administrators out of provider changes and feature caps',async()=>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'fixture-company-hr-'+randomUUID(),personId:null}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:base.companyId,role:'hr_admin'});
 const hr={...adminCtx(base),userId:user.id,grants:[{role:'hr_admin',companyId:base.companyId}]} as SessionContext;
 await expect(saveAiProviderConfig(hr,{provider:'openai',model:'gpt-5.5',apiKey:'fixture-hr-key'})).rejects.toThrow();
 await expect(setActiveProvider(hr,{provider:'anthropic'})).rejects.toThrow();
 await expect(setAiFeatureCap(hr,{feature:'pay_rule_draft',dailyRequests:1,monthlyTokens:null})).rejects.toBeInstanceOf(AiControlError);
 expect(await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.tenantId,base.tenantId))).toEqual([]);
 expect(await owner.db.select().from(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.tenantId,base.tenantId))).toEqual([]);
});
