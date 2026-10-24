/** Acceptance authored for the coordinated ai-action-controls migration. Runtime remains UNRUN;
 * the SQL draft must join the migration journal before this file is eligible for verification. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { assertAiActionUnpausedTx } from '../core/ai-governance';
import { clearUserAllowance, setAiAllowance, setAiFeature } from '../core/ai-management';
import { hireEmployee } from '../core/org';
import { setTenantSetting } from '../core/tenant-settings';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let group: SessionContext;
const check = (ctx = group) => withTenant(ctx, tx => assertAiActionUnpausedTx(tx, ctx, 'hr_assistant'));
const policies = (kind: 'company' | 'user' | 'user_default', enabled: boolean, subjectId?: string,
  dailyRequests: number | null = null, monthlyTokens: number | null = null) =>
  setAiAllowance(group, { kind, subjectId, enabled, dailyRequests, monthlyTokens });
const runs = () => owner.db.select().from(schema.aiModelRun)
  .where(eq(schema.aiModelRun.tenantId, base.tenantId))
  .orderBy(schema.aiModelRun.startedAt, schema.aiModelRun.id);

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  group = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
});
afterAll(closeAll);

async function employee() {
  const hired = await hireEmployee(group, {
    person: { fullName: 'Action controls fixture', primaryEmail: `controls-${randomUUID()}@example.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    paymentMethod: 'cash',
  } as never);
  const userId = await createAppUser(base.tenantId, hired.personId, 'employee');
  const ctx: SessionContext = { ...group, userId, roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }] };
  return { ctx, ...hired };
}

describe('non-admitting AI pause prerequisite', () => {
  it('ignores spent/zero quotas without reserving, settling or rewriting model usage', async () => {
    await policies('user', true, group.userId!, 0, 0);
    await owner.db.insert(schema.aiModelRun).values({ tenantId: base.tenantId, userId: group.userId,
      companyIds: [base.companyId], featureId: 'hr_assistant', operation: 'conversation',
      provider: 'fixture', model: 'never-sent', state: 'pending', reservedTokens: 123 });
    const before = await runs();
    expect(before).toHaveLength(1);
    for (let i = 0; i < 3; i++) await expect(check()).resolves.toBeUndefined();
    expect(await runs()).toEqual(before);
    // The model admission is still refused by the unchanged quota owner.
    const [admission] = await withTenant(group, tx => tx.execute<{ allowed: boolean; blocked_reason: string }>(
      sql`select * from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)`));
    expect(admission).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    expect((await runs()).filter(r => r.state === 'pending')).toEqual(before);
    expect((await runs()).filter(r => r.state === 'blocked')).toHaveLength(1);
  });

  it('refuses a feature pause and returns no policy identity or new model run', async () => {
    await setAiFeature(group, 'hr_assistant', false);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    expect(await runs()).toEqual([]);
    await setAiFeature(group, 'hr_assistant', true);
    await expect(check()).resolves.toBeUndefined();
  });

  it('preserves model-admission refusal precedence while action checks consider every explicit pause', async () => {
    await policies('company', true, base.companyId, 0);
    await setAiFeature(group, 'hr_assistant', false);
    const admit = () => withTenant(group, tx => tx.execute<{ allowed: boolean; blocked_reason: string }>(
      sql`select * from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)`));
    expect((await admit())[0]).toMatchObject({ allowed: false, blocked_reason: 'paused' });
    await setAiFeature(group, 'hr_assistant', true);
    await policies('user', false, group.userId!);
    // Company precedes user in the original scope_key quota loop. Preserve its recorded reason.
    expect((await admit())[0]).toMatchObject({ allowed: false, blocked_reason: 'daily_limit' });
    const before = await runs();
    expect(before).toHaveLength(2);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    expect(await runs()).toEqual(before);
  });

  it('sees an applicable company pause that ordinary employee RLS hides', async () => {
    const { ctx } = await employee();
    await policies('company', false, base.companyId);
    const visible = await withTenant(ctx, tx => tx.select().from(schema.aiControlPolicy)
      .where(eq(schema.aiControlPolicy.scopeKey, `company:${base.companyId}`)));
    expect(visible).toEqual([]);
    // Non-vacuity: the paused row really exists; an empty scoped query cannot mean unpaused.
    const stored = await owner.db.select().from(schema.aiControlPolicy)
      .where(eq(schema.aiControlPolicy.scopeKey, `company:${base.companyId}`));
    expect(stored).toHaveLength(1);
    expect(stored[0].enabled).toBe(false);
    await expect(check(ctx)).rejects.toMatchObject({ reason: 'paused' });
    expect(await runs()).toEqual([]);
    await policies('company', true, base.companyId);
    await expect(check(ctx)).resolves.toBeUndefined();
  });

  it('uses the full admission company scope rather than a nominated action company', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId,
      legalName: 'Other authorized company' }).returning();
    await policies('company', true, base.companyId);
    await policies('company', false, other.id);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    const scoped = { ...group, grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    await expect(check(scoped)).resolves.toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('replaces the disabled default with the individual policy, then resumes the default on removal', async () => {
    await policies('user_default', false);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    await policies('user', true, group.userId!, 0, 0);
    await expect(check()).resolves.toBeUndefined();
    await clearUserAllowance(group, group.userId!);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    await policies('user_default', true);
    await policies('user', false, group.userId!);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    expect(await runs()).toEqual([]);
  });

  it('does not apply a login default to an anonymous system context or another tenant', async () => {
    await policies('user_default', false);
    await expect(check({ ...group, userId: undefined })).resolves.toBeUndefined();
    const foreign = await seedBase();
    await expect(check({ ...adminCtx(foreign), grants: [{ role: 'hr_admin', companyId: null }] }))
      .resolves.toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('keeps private full-policy selectors inaccessible to the application role', async () => {
    await expect(withTenant(group, tx => tx.execute(
      sql`select * from app._ai_control_context('hr_assistant',false)`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withTenant(group, tx => tx.execute(
      sql`select * from app._ai_applicable_policies('hr_assistant',array[${base.companyId}::uuid])`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('holds the canonical policy lock until the enclosing command transaction ends', async () => {
    await policies('user', true, group.userId!);
    await withTenant(group, async tx => {
      await assertAiActionUnpausedTx(tx, group, 'hr_assistant');
      // Exercise actual policy UPDATE/DELETE triggers under the app role. An advisory-lock probe
      // alone could pass while a legacy writer ignored the lock. Each failed writer rolls back.
      for (const operation of ['update', 'delete'] as const) {
        await expect(withTenant(group, async competing => {
          await competing.execute(sql`set local lock_timeout='250ms'`);
          const target = eq(schema.aiControlPolicy.scopeKey, `user:${group.userId}`);
          if (operation === 'update') await competing.update(schema.aiControlPolicy).set({ enabled: false }).where(target);
          else await competing.delete(schema.aiControlPolicy).where(target);
        })).rejects.toMatchObject({ cause: { code: '55P03' } });
      }
    });
    // The same ordinary policy service completes after the checked transaction releases the lock.
    await policies('user', false, group.userId!);
    await expect(check()).rejects.toMatchObject({ reason: 'paused' });
    expect(await runs()).toEqual([]);
  });

  it('refuses an older report snapshot instead of calling its controls fresh', async () => {
    await expect(withTenant(group, tx => assertAiActionUnpausedTx(tx, group, 'hr_assistant'),
      { readOnlySnapshot: true })).rejects.toThrow();
    expect(await runs()).toEqual([]);
  });

  it('rejects an unknown capability through both the typed and raw database boundary', async () => {
    await expect(withTenant(group, tx => assertAiActionUnpausedTx(tx, group, 'injected' as never)))
      .rejects.toThrow('Unknown AI feature');
    await expect(withTenant(group, tx => tx.execute(sql`select app.ai_action_unpaused('injected')`)))
      .rejects.toThrow();
    await expect(withTenant(group, tx => tx.execute(sql`select app.ai_action_unpaused(null)`)))
      .rejects.toThrow();
    expect(await runs()).toEqual([]);
  });

  it('uses the existing setting and platform kill owner without trusting a stale context', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    await setTenantSetting(group, { key: 'notifications.readiness_nudge_enabled', value: true });
    const settingCheck = () => withTenant(group, tx =>
      assertAiActionUnpausedTx(tx, group, 'readiness_reminders'));
    await expect(settingCheck()).resolves.toBeUndefined();
    await setTenantSetting(group, { key: 'notifications.readiness_nudge_enabled', value: false });
    await expect(settingCheck()).rejects.toMatchObject({ reason: 'paused' });
    await setTenantSetting(group, { key: 'notifications.readiness_nudge_enabled', value: true });
    vi.stubEnv('SETTING_KILL', 'notifications.readiness_nudge_enabled');
    try { await expect(settingCheck()).rejects.toMatchObject({ reason: 'paused' }); }
    finally { vi.unstubAllEnvs(); }
    expect(await runs()).toEqual([]);
  });
});
