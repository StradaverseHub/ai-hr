import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { getSetting, resolveEntitlementsTx } from '../core/entitlements';
import { setTenantSetting } from '../core/tenant-settings';
import { removeEmployeePayroll, resetProcessedBatch } from '../core/payroll';
import { seedCatalogs } from '../scripts/seed-catalogs';
import { SETTING_CATALOG } from '../packs/catalog';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
const key = 'payroll.reset_enabled';
const group = (): SessionContext => ({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] });
const settingRows = () => owner.db.select().from(schema.tenantSetting).where(eq(schema.tenantSetting.tenantId, base.tenantId));
const events = () => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'tenant-setting.changed'))).orderBy(schema.domainEvent.sequence);
async function resolved(ctx: SessionContext) {
  const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, ctx.tenantId));
  return { ...ctx, entitlements };
}
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

describe('group-admin payroll correction setting', () => {
  it('persists on and off through the app role, resolves customer values and audits the actor', async () => {
    expect(SETTING_CATALOG.find(entry => entry.key === key)).toMatchObject({ scope: 'tenant', defaultValue: false, defaultOnInstall: false });
    expect(getSetting(await resolved(group()), key)).toBe(false);
    for (const value of [true, false]) {
      await setTenantSetting(group(), { key, value });
      expect(getSetting(await resolved(group()), key)).toBe(value);
    }
    expect((await settingRows()).find(row => row.key === key)).toMatchObject({ value: false, source: 'customer' });
    expect((await events()).map(event => ({ actorType: event.actorType, actorId: event.actorId, payload: event.payload }))).toEqual([
      { actorType: 'user', actorId: base.adminUserId, payload: { key, value: true } },
      { actorType: 'user', actorId: base.adminUserId, payload: { key, value: false } },
    ]);
  });

  it('catalog upgrade preserves a platform-enabled override and lets its group admin disable it', async () => {
    await owner.db.update(schema.settingDefinition).set({ scope: 'platform' }).where(eq(schema.settingDefinition.key, key));
    await owner.db.insert(schema.tenantSetting).values({ tenantId: base.tenantId, key, value: true, source: 'platform' });
    const before = await settingRows();
    try {
      await seedCatalogs(owner.db);
      const [definition] = await owner.db.select().from(schema.settingDefinition).where(eq(schema.settingDefinition.key, key));
      expect(definition.scope).toBe('tenant');
    } finally {
      // Restore the shared catalog even when an assertion fails below.
      await owner.db.update(schema.settingDefinition).set({ scope: 'tenant' }).where(eq(schema.settingDefinition.key, key));
    }
    expect(await settingRows()).toEqual(before);
    expect(getSetting(await resolved(group()), key)).toBe(true);
    await setTenantSetting(group(), { key, value: false });
    expect(getSetting(await resolved(group()), key)).toBe(false);
  });

  it('does not change another tenant or the platform-only unlock setting', async () => {
    const other = await seedBase();
    await setTenantSetting(group(), { key, value: true });
    expect(getSetting(await resolved({ ...group(), tenantId: other.tenantId }), key)).toBe(false);
    await expect(setTenantSetting(group(), { key: 'payroll.unlock_enabled', value: true })).rejects.toMatchObject({ reason: 'not_tenant_scoped' });
    expect((await events()).length).toBe(1);
  });

  it.each(['company', 'employee', 'revoked'])('refuses %s authority without a setting or audit change', async mode => {
    const ctx = group();
    if (mode === 'company') ctx.grants = [{ role: 'hr_admin', companyId: base.companyId }];
    if (mode === 'employee') { ctx.roles = ['employee']; ctx.grants = [{ role: 'employee', companyId: null }]; }
    if (mode === 'revoked') await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, base.adminUserId));
    const before = await settingRows();
    await expect(setTenantSetting(ctx, { key, value: true })).rejects.toMatchObject({ reason: 'not_group_admin' });
    expect(await settingRows()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it('keeps database policy blocking company-only writes even if the UI is bypassed', async () => {
    const ctx = { ...group(), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    await expect(withTenant(ctx, tx => tx.execute(sql`INSERT INTO tenant_setting(tenant_id,key,value,source) VALUES(${base.tenantId},${key},'true'::jsonb,'customer')`))).rejects.toThrow();
    expect((await settingRows()).find(row => row.key === key)).toBeUndefined();
  });

  it('disabling blocks both services before they touch payroll, including direct calls', async () => {
    await setTenantSetting(group(), { key, value: true });
    await setTenantSetting(group(), { key, value: false });
    const ctx = await resolved(group());
    const batchId = '11111111-1111-4111-8111-111111111111';
    await expect(resetProcessedBatch(ctx, { batchId, reason: 'fixture' })).rejects.toMatchObject({ settingKey: key });
    await expect(removeEmployeePayroll(ctx, { batchId, employmentIds: [], reason: 'fixture' })).rejects.toMatchObject({ settingKey: key });
  });
});
