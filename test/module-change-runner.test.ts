/**
 * ADR-0077 slice 5 — the module change runner, the ONLY writer of `tenant_module`.
 *
 * `tenant_module` is SELECT-only to the app role (0313: "a customer may see what they have, never grant
 * it"), so grants happen out of band under the owner role against an intent row. These assertions pin
 * the rules that make that path safe to be the only one.
 *
 * THE ONE THAT MATTERS MOST is reactivation (D4). A customer who disables a module for a month and turns
 * it back on has edited its settings in the meantime. Re-seeding would silently revert their
 * configuration, and it would look like the product losing their work rather than like an install step.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { Tx } from '../db/client';
import { applyModuleChange, assertActivatable, ModuleChangeRefused } from '../scripts/module-change-runner';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

async function defineModule(code: string, o: Partial<typeof schema.module_.$inferInsert> = {}) {
  await owner.db
    .insert(schema.module_)
    .values({ code, name: code, category: 'hr', billable: false, isCore: false, ...o })
    .onConflictDoNothing();
}

function request(o: Partial<typeof schema.moduleChangeRequest.$inferSelect>) {
  return {
    id: randomUUID(),
    tenantId: b.tenantId,
    moduleCode: 'x',
    companyId: null,
    action: 'activate',
    status: 'pending',
    currentStep: null,
    error: null,
    claimedAt: null,
    requestedBy: 'operator@stradaverse.test',
    disposition: null,
    createdAt: new Date(),
    decidedAt: null,
    ...o,
  } as typeof schema.moduleChangeRequest.$inferSelect;
}

const run = (req: ReturnType<typeof request>) =>
  owner.db.transaction((tx) => applyModuleChange(tx as unknown as Tx, req));

const statusOf = async (code: string) => {
  const rows = await owner.db.select().from(schema.tenantModule).where(eq(schema.tenantModule.moduleCode, code));
  return rows[0]?.status ?? null;
};

describe('what the runner refuses, and why refusing beats warning', () => {
  it('refuses a module that is not in the catalog', async () => {
    await expect(run(request({ moduleCode: 'no_such_module' }))).rejects.toThrow(/catalog/i);
  });

  // 0313's trigger already rejects these; failing here NAMES the reason instead of surfacing a trigger.
  it('refuses a CORE module — those are never granted per tenant', async () => {
    await defineModule('core_thing', { isCore: true });
    await expect(run(request({ moduleCode: 'core_thing' }))).rejects.toThrow(/core/i);
  });

  it('refuses an activation whose prerequisites are not active', async () => {
    await defineModule('needs_dep', { dependsOn: ['absent_dep'] });
    await defineModule('absent_dep');
    const err = await run(request({ moduleCode: 'needs_dep' })).catch((e) => e);
    expect(err).toBeInstanceOf(ModuleChangeRefused);
    expect((err as ModuleChangeRefused).step).toBe('depends_on');
    expect((err as Error).message).toMatch(/absent_dep/);
  });

  it('accepts once the prerequisite IS active', async () => {
    await defineModule('dep_ok');
    await defineModule('needs_ok', { dependsOn: ['dep_ok'] });
    await run(request({ moduleCode: 'dep_ok' }));
    await expect(run(request({ moduleCode: 'needs_ok' }))).resolves.toBeTruthy();
  });

  // D-15 — an entitlement is the technical half of a commercial fact.
  it('refuses a BILLABLE module with no subscription line', async () => {
    await defineModule('paid_thing', { billable: true });
    const err = await run(request({ moduleCode: 'paid_thing' })).catch((e) => e);
    expect((err as ModuleChangeRefused).step).toBe('subscription');
  });

  it('accepts a billable module once the line exists', async () => {
    await defineModule('paid_ok', { billable: true });
    await owner.db.insert(schema.subscriptionLine).values({ tenantId: b.tenantId, moduleCode: 'paid_ok' });
    await expect(run(request({ moduleCode: 'paid_ok' }))).resolves.toBeTruthy();
  });

  it('does not require a line for a non-billable module', async () => {
    await defineModule('free_thing', { billable: false });
    await expect(run(request({ moduleCode: 'free_thing' }))).resolves.toBeTruthy();
  });
});

describe('install, reactivate, disable', () => {
  it('first install creates the entitlement and reports itself as a first install', async () => {
    await defineModule('installs');
    const out = await run(request({ moduleCode: 'installs' }));
    expect(await statusOf('installs')).toBe('active');
    expect(out.detail[0]).toMatch(/first install/);
  });

  /**
   * THE D4 RULE. Disable, let the customer change a setting, re-enable: their value must survive. The
   * activators write ON CONFLICT DO NOTHING precisely so this holds, and the outcome REPORTS the skip
   * rather than claiming a clean install.
   */
  it('reactivation preserves a customer-edited setting and says it skipped', async () => {
    await defineModule('reinstalls');
    await owner.db.insert(schema.settingDefinition).values({
      key: 'reinstalls.threshold',
      moduleCode: 'reinstalls',
      scope: 'tenant',
      valueType: 'number',
      defaultValue: 10,
      defaultOnInstall: 10,
    });

    await run(request({ moduleCode: 'reinstalls' }));
    // The customer changes it.
    await owner.db
      .update(schema.tenantSetting)
      .set({ value: 99 })
      .where(eq(schema.tenantSetting.key, 'reinstalls.threshold'));

    await run(request({ moduleCode: 'reinstalls', action: 'deactivate' }));
    expect(await statusOf('reinstalls')).toBe('disabled');

    const out = await run(request({ moduleCode: 'reinstalls' }));
    expect(await statusOf('reinstalls')).toBe('active');
    expect(out.detail[0]).toMatch(/reactivation/);
    expect(out.seeded).toBe(0);
    expect(out.skipped).toBeGreaterThan(0);

    const [setting] = await owner.db
      .select()
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.key, 'reinstalls.threshold'));
    expect(setting.value, 'the customer edit must survive a reinstall').toBe(99);
  });

  it('seeds the settings a purchase needs to arrive usable', async () => {
    await defineModule('seeds_settings');
    await owner.db.insert(schema.settingDefinition).values({
      key: 'seeds_settings.enabled',
      moduleCode: 'seeds_settings',
      scope: 'tenant',
      valueType: 'boolean',
      defaultValue: false,
      defaultOnInstall: true,
    });
    const out = await run(request({ moduleCode: 'seeds_settings' }));
    expect(out.seeded).toBeGreaterThan(0);
    const [row] = await owner.db
      .select()
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.key, 'seeds_settings.enabled'));
    expect(row.value).toBe(true);
  });

  // D-6: disabled means writes refused, history readable. Deletion is not disabling.
  it('disabling removes no data', async () => {
    await defineModule('disables');
    await run(request({ moduleCode: 'disables' }));
    const out = await run(request({ moduleCode: 'disables', action: 'deactivate' }));
    expect(await statusOf('disables')).toBe('disabled');
    expect(out.detail.join(' ')).toMatch(/no data removed/);
  });
});

describe('assertActivatable is the single place a refusal is decided', () => {
  it('is callable on its own, so the console can pre-check before writing an intent row', async () => {
    await defineModule('precheck', { billable: true });
    await owner.db.transaction(async (tx) => {
      await expect(
        assertActivatable(tx as unknown as Tx, request({ moduleCode: 'precheck' })),
      ).rejects.toThrow(/subscription/);
    });
  });
});
