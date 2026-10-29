/** WP6 / R10 (D7): one switch owner per AI feature, against the migrated database. A setting-backed feature is
 *  switched by its setting alone (feedback_planning included), a second policy-row switch is refused, and a stale
 *  row that predates the guard is ignored by admission and shown on the management page. */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {AI_FEATURES} from '../lib/ai/features';
import {assertAiActionUnpausedTx} from '../core/ai-governance';
import { aiManagementView, setAiFeature } from '../core/ai-management';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base, group: SessionContext;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); group = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] }; });
afterAll(closeAll);

const unpaused = async (feature: string) => {
  const [row] = await withTenant(group, tx => tx.execute<{ unpaused: boolean }>(sql`select app.ai_action_unpaused(${feature}) as unpaused`));
  return row.unpaused;
};
const admit = async (feature: string) => {
  const [row] = await withTenant(group, tx => tx.execute<{ allowed: boolean; blocked_reason: string | null }>(
    sql`select * from app.ai_admit(${feature},'draft','fixture','never-sent',1)`));
  return row;
};
const store = (key: string, value: boolean, source: 'customer' | 'platform') => owner.db.insert(schema.tenantSetting)
  .values({ tenantId: base.tenantId, key, value, source })
  .onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value, source } });
/** A pre-guard row: written on the owner connection with triggers off for this one transaction only. */
const staleFeatureRow = (featureId: string, enabled: boolean, maxConcurrent: number | null = null) => owner.db.transaction(async tx => {
  await tx.execute(sql`SET LOCAL session_replication_role = replica`);
  await tx.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, kind: 'feature', scopeKey: `feature:${featureId}`, featureId, enabled, maxConcurrent });
});

describe('one switch owner per AI feature (0692)', () => {
  it('seeds the reference table the application can read but not change', async () => {
    const rows = await withTenant(group, tx => tx.execute<{ feature_id: string; setting_key: string }>(sql`select feature_id,setting_key from app.ai_feature_setting order by feature_id`));
    expect(Array.from(rows)).toContainEqual({ feature_id: 'feedback_planning', setting_key: 'feedback.ai_planning_enabled' });
    expect(Array.from(rows).map(r=>[r.feature_id,r.setting_key]).sort()).toEqual(AI_FEATURES.filter(f=>f.setting!==null).map(f=>[f.id,f.setting]).sort());
    await expect(withTenant(group, tx => tx.execute(sql`insert into app.ai_feature_setting(feature_id,setting_key) values('hr_assistant','assistant.launcher_enabled')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withTenant(group, tx => tx.execute(sql`delete from app.ai_feature_setting where feature_id='feedback_planning'`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('honours the feedback_planning setting in the SQL control context', async () => {
    // No stored value: the platform default is off.
    expect(await unpaused('feedback_planning')).toBe(false);
    expect(await admit('feedback_planning')).toMatchObject({ allowed: false, blocked_reason: 'paused' });
    // A customer-written row on a platform-scoped key is not a value (same rule as the TS entitlement snapshot).
    await store('feedback.ai_planning_enabled', true, 'customer');
    expect(await unpaused('feedback_planning')).toBe(false);
    await store('feedback.ai_planning_enabled', true, 'platform');
    expect(await unpaused('feedback_planning')).toBe(true);
    expect(await admit('feedback_planning')).toMatchObject({ allowed: true, blocked_reason: null });
    await store('feedback.ai_planning_enabled', false, 'platform');
    expect(await unpaused('feedback_planning')).toBe(false);
  });

  it('refuses a feature: policy row for every setting-backed feature, in core and in the database', async () => {
    for (const featureId of ['performance_pm', 'claims_triage', 'readiness_reminders']) {
      await expect(withTenant(group, tx => tx.insert(schema.aiControlPolicy).values({ tenantId: base.tenantId, kind: 'feature', scopeKey: `feature:${featureId}`, featureId, enabled: false })))
        .rejects.toMatchObject({ cause: { message: expect.stringContaining('Setting-controlled AI feature') } });
    }
    // The core switch writes the setting, never a policy row.
    await setAiFeature(group, 'performance_pm', true);
    expect(await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.tenantId, base.tenantId))).toEqual([]);
    const [setting] = await owner.db.select().from(schema.tenantSetting)
      .where(and(eq(schema.tenantSetting.tenantId, base.tenantId), eq(schema.tenantSetting.key, 'performance.ai_pm_enabled')));
    expect(setting.value).toBe(true);
    // Settingless features keep their policy-row switch.
    await setAiFeature(group, 'pay_rule_draft', false);
    expect(await unpaused('pay_rule_draft')).toBe(false);
  });

  it('ignores a stale feature row for a setting-backed feature and shows it as an ignored override', async () => {
    await staleFeatureRow('performance_pm', false, 0);
    await store('performance.ai_pm_enabled', true, 'customer');
    // Neither the pause nor the zero concurrency cap of the stale row applies: the setting is the only switch.
    expect(await unpaused('performance_pm')).toBe(true);
    expect(await admit('performance_pm')).toMatchObject({ allowed: true, blocked_reason: null });
    const view = await aiManagementView(group);
    const pm = view.features.find(f => f.id === 'performance_pm')!;
    expect(pm.enabled).toBe(true);
    expect(pm.staleOverride).toMatchObject({ enabled: false });
    expect(view.features.find(f => f.id === 'performance_tc')!.staleOverride).toBeNull();
    // The setting still pauses it.
    await store('performance.ai_pm_enabled', false, 'customer');
    expect(await unpaused('performance_pm')).toBe(false);
    expect(await admit('performance_pm')).toMatchObject({ allowed: false, blocked_reason: 'paused' });
    // A settingless feature's own row is its switch, not a stale override.
    await setAiFeature(group, 'report_insight', false);
    expect((await aiManagementView(group)).features.find(f => f.id === 'report_insight')).toMatchObject({ enabled: false, staleOverride: null });
  });
});

describe('template-only specialist switch mapping grants no model admission',()=>{
 it.each(['approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers'] as const)('%s has one setting owner while SQL and service model admission still refuse',async feature=>{
  const definition=AI_FEATURES.find(f=>f.id===feature)!;expect(definition.setting).toBeTruthy();
  await setAiFeature(group,feature,true);
  const [setting]=await owner.db.select().from(schema.tenantSetting).where(and(eq(schema.tenantSetting.tenantId,base.tenantId),eq(schema.tenantSetting.key,definition.setting!)));expect(setting.value).toBe(true);
  await expect(withTenant(group,tx=>assertAiActionUnpausedTx(tx,group,feature))).rejects.toThrow('no model call');
  await expect(admit(feature)).rejects.toThrow();
  await expect(withTenant(group,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'feature',scopeKey:'feature:'+feature,featureId:feature,enabled:true}))).rejects.toThrow();
 });
});
