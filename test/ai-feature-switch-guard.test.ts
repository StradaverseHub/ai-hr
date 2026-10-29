/** Feature-level AI switch guard (0648 replaces 0541's guard). Its accepted set is the settingless part of
 * the AI feature registry that setAiFeature and the management screen use, and a recorded pause for each
 * formerly refused feature reaches the canonical pause check (0621 feature_paused). */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { assertAiActionUnpausedTx } from '../core/ai-governance';
import { setAiFeature } from '../core/ai-management';
import { AI_FEATURES, type AiFeatureId } from '../lib/ai/features';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// Refused by the 0541 guard ("Unknown AI feature") although settingless, paused by 0621 and checked by callers.
const FORMERLY_REFUSED = ['provider_evaluation', 'module_agent_evaluation', 'personnel_import_mapping', 'module_agent_planning'] as const;

let base: Base;
let group: SessionContext;
const check = (feature: AiFeatureId) => withTenant(group, tx => assertAiActionUnpausedTx(tx, group, feature));
const rawSwitch = (feature: string, enabled: boolean) => owner.db.execute(sql`insert into public.ai_control_policy
  (tenant_id,scope_key,kind,feature_id,enabled) values (${base.tenantId}::uuid,${`feature:${feature}`},'feature',${feature},${enabled})`);
// drizzle wraps a driver error (DrizzleQueryError: "Failed query"); the guard's own text is its cause.
const refusal = async (attempt: Promise<unknown>) => {
  try { await attempt; } catch (error) { const e = error as { message?: string; cause?: { message?: string } }; return e.cause?.message ?? e.message ?? ''; }
  return 'accepted';
};
const featureRows = () => owner.db.execute<{ feature_id: string; enabled: boolean }>(sql`select feature_id,enabled
  from public.ai_control_policy where tenant_id=${base.tenantId}::uuid and kind='feature' order by feature_id collate "C"`);

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  group = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
});
afterAll(closeAll);

describe('feature-level AI switch guard', () => {
  it('records a pause for each formerly refused settingless feature and the pause takes effect for that feature only', async () => {
    for (const feature of FORMERLY_REFUSED) expect(AI_FEATURES.find(f => f.id === feature)?.setting, feature).toBeNull();
    for (const feature of FORMERLY_REFUSED) {
      await expect(check(feature), `${feature} starts unpaused`).resolves.toBeUndefined();
      await setAiFeature(group, feature, false);
      await expect(check(feature), `${feature} paused`).rejects.toMatchObject({ reason: 'paused' });
      for (const other of FORMERLY_REFUSED.filter(f => f !== feature)) await expect(check(other), `${other} unaffected`).resolves.toBeUndefined();
      await expect(check('hr_assistant')).resolves.toBeUndefined();
      await setAiFeature(group, feature, true);
      await expect(check(feature), `${feature} resumed`).resolves.toBeUndefined();
    }
    expect((await featureRows()).map(r => [r.feature_id, r.enabled])).toEqual([...FORMERLY_REFUSED].sort().map(f => [f, true]));
  });

  it('accepts exactly the settingless registry at the raw database boundary and keeps every other refusal', async () => {
    const settingless = AI_FEATURES.filter(f => f.setting === null).map(f => f.id);
    expect(settingless.length).toBeGreaterThanOrEqual(9);
    for (const feature of AI_FEATURES) {
      if (feature.id === 'feedback_planning') expect(await refusal(rawSwitch(feature.id, false)), feature.id).toContain('Platform managed feature');
      else if (feature.setting === null) expect(await refusal(rawSwitch(feature.id, false)), feature.id).toBe('accepted');
      // 0692: one switch owner per feature — a setting-backed feature is refused a second (policy-row) switch by name.
      else expect(await refusal(rawSwitch(feature.id, false)), feature.id).toContain('Setting-controlled AI feature');
    }
    expect(await refusal(rawSwitch('injected_feature', false))).toContain('Unknown AI feature');
    expect((await featureRows()).map(r => r.feature_id)).toEqual([...settingless].sort());
    for (const feature of settingless) await expect(check(feature), feature).rejects.toMatchObject({ reason: 'paused' });
  });
});
