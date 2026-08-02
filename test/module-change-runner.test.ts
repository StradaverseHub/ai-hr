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
import { inArray } from 'drizzle-orm';
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
  // resetDb() FIRST, and this ordering is the whole trick: resetDb runs in beforeEach, so the LAST
  // test's tenant_module rows are still present here — and tenant_module.module_code has an FK to
  // module.code. Deleting the catalog rows without clearing the dependants raises a foreign-key
  // violation inside afterAll, which vitest reports as the whole FILE failing with no failed test.
  if (created.length > 0 || createdSettings.length > 0) {
    // ORDER MATTERS TWICE OVER. resetDb() first, because it runs in beforeEach and the LAST test's
    // tenant_module rows are still here, and those FK to module.code. Then setting_definition, which
    // ALSO FKs to module.code (setting_definition_module_code_fkey) and is ALSO installation-wide —
    // that one is easy to miss because it is a catalog the tests write to only incidentally.
    await resetDb();
    if (createdSettings.length > 0) {
      await owner.db.delete(schema.settingDefinition).where(inArray(schema.settingDefinition.key, createdSettings));
    }
    if (created.length > 0) {
      await owner.db.delete(schema.module_).where(inArray(schema.module_.code, created));
    }
  }
  await closeAll();
});

/**
 * `module` and `setting_definition` are INSTALLATION-wide, not tenant-scoped, so resetDb() does not
 * clear them and a fixture with a fixed code collides with the row a previous run left behind. Every
 * code and key here is therefore unique per run — the alternative, ON CONFLICT DO NOTHING, would
 * silently keep the OLD row's flags and quietly test something other than what the test says.
 */
const uniq = (base: string) => `${base}_${randomUUID().slice(0, 8)}`;

/**
 * Every catalog code this file creates, so it can put the catalog back.
 *
 * `module` is INSTALLATION-wide — resetDb() does not touch it — so a fixture row survives the test that
 * made it AND every later run in the same worker database. Unique codes stopped fixtures colliding with
 * each other and, left there, quietly accumulated: test/module-catalog-drift.test.ts asserts the database
 * carries no module the code does not know about, and it began failing with a list of this file's
 * leftovers. Creating rows in a shared catalog obliges you to remove them.
 */
const created: string[] = [];
/** Setting definitions are installation-wide too, and they FK to module.code — so they clear first. */
const createdSettings: string[] = [];

async function defineModule(code: string, o: Partial<typeof schema.module_.$inferInsert> = {}) {
  created.push(code);
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
    const code = uniq('core_thing');
    await defineModule(code, { isCore: true });
    await expect(run(request({ moduleCode: code }))).rejects.toThrow(/core/i);
  });

  it('refuses an activation whose prerequisites are not active', async () => {
    const dep = uniq('absent_dep');
    const code = uniq('needs_dep');
    await defineModule(code, { dependsOn: [dep] });
    await defineModule(dep);
    const err = await run(request({ moduleCode: code })).catch((e) => e);
    expect(err).toBeInstanceOf(ModuleChangeRefused);
    expect((err as ModuleChangeRefused).step).toBe('depends_on');
    expect((err as Error).message).toMatch(new RegExp(dep));
  });

  it('accepts once the prerequisite IS active', async () => {
    const dep = uniq('dep_ok');
    const code = uniq('needs_ok');
    await defineModule(dep);
    await defineModule(code, { dependsOn: [dep] });
    await run(request({ moduleCode: dep }));
    await expect(run(request({ moduleCode: code }))).resolves.toBeTruthy();
  });

  // D-15 — an entitlement is the technical half of a commercial fact.
  it('refuses a BILLABLE module with no subscription line', async () => {
    const code = uniq('paid_thing');
    await defineModule(code, { billable: true });
    const err = await run(request({ moduleCode: code })).catch((e) => e);
    expect((err as ModuleChangeRefused).step).toBe('subscription');
  });

  it('accepts a billable module once the line exists', async () => {
    const code = uniq('paid_ok');
    await defineModule(code, { billable: true });
    await owner.db.insert(schema.subscriptionLine).values({ tenantId: b.tenantId, moduleCode: code });
    await expect(run(request({ moduleCode: code }))).resolves.toBeTruthy();
  });

  it('does not require a line for a non-billable module', async () => {
    const code = uniq('free_thing');
    await defineModule(code, { billable: false });
    await expect(run(request({ moduleCode: code }))).resolves.toBeTruthy();
  });
});

describe('install, reactivate, disable', () => {
  it('first install creates the entitlement and reports itself as a first install', async () => {
    const code = uniq('installs');
    await defineModule(code);
    const out = await run(request({ moduleCode: code }));
    expect(await statusOf(code)).toBe('active');
    expect(out.detail[0]).toMatch(/first install/);
  });

  /**
   * THE D4 RULE. Disable, let the customer change a setting, re-enable: their value must survive. The
   * activators write ON CONFLICT DO NOTHING precisely so this holds, and the outcome REPORTS the skip
   * rather than claiming a clean install.
   */
  it('reactivation preserves a customer-edited setting and says it skipped', async () => {
    const code = uniq('reinstalls');
    const key = `${code}.threshold`;
    await defineModule(code);
    createdSettings.push(key);
    await owner.db.insert(schema.settingDefinition).values({
      key,
      moduleCode: code,
      scope: 'tenant',
      valueType: 'number',
      defaultValue: 10,
      defaultOnInstall: 10,
    });

    await run(request({ moduleCode: code }));
    // The customer changes it.
    await owner.db
      .update(schema.tenantSetting)
      .set({ value: 99 })
      .where(eq(schema.tenantSetting.key, key));

    await run(request({ moduleCode: code, action: 'deactivate' }));
    expect(await statusOf(code)).toBe('disabled');

    const out = await run(request({ moduleCode: code }));
    expect(await statusOf(code)).toBe('active');
    expect(out.detail[0]).toMatch(/reactivation/);
    expect(out.seeded).toBe(0);
    expect(out.skipped).toBeGreaterThan(0);

    const [setting] = await owner.db
      .select()
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.key, key));
    expect(setting.value, 'the customer edit must survive a reinstall').toBe(99);
  });

  it('seeds the settings a purchase needs to arrive usable', async () => {
    const code = uniq('seeds_settings');
    const key = `${code}.enabled`;
    await defineModule(code);
    createdSettings.push(key);
    await owner.db.insert(schema.settingDefinition).values({
      key,
      moduleCode: code,
      scope: 'tenant',
      valueType: 'boolean',
      defaultValue: false,
      defaultOnInstall: true,
    });
    const out = await run(request({ moduleCode: code }));
    expect(out.seeded).toBeGreaterThan(0);
    const [row] = await owner.db
      .select()
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.key, key));
    expect(row.value).toBe(true);
  });

  // D-6: disabled means writes refused, history readable. Deletion is not disabling.
  it('disabling removes no data', async () => {
    const code = uniq('disables');
    await defineModule(code);
    await run(request({ moduleCode: code }));
    const out = await run(request({ moduleCode: code, action: 'deactivate' }));
    expect(await statusOf(code)).toBe('disabled');
    expect(out.detail.join(' ')).toMatch(/no data removed/);
  });
});

describe('assertActivatable is the single place a refusal is decided', () => {
  it('is callable on its own, so the console can pre-check before writing an intent row', async () => {
    const code = uniq('precheck');
    await defineModule(code, { billable: true });
    await owner.db.transaction(async (tx) => {
      await expect(
        assertActivatable(tx as unknown as Tx, request({ moduleCode: code })),
      ).rejects.toThrow(/subscription/);
    });
  });
});
