/**
 * ADR-0077 slice 2 — the enforcement primitive's semantics.
 *
 * Every branch of `isModuleEnabled` is fail-closed, and each one is asserted here against a REAL
 * snapshot resolved from the database rather than a hand-built object literal — otherwise the tests
 * would be checking my mental model of the query rather than the query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';
import {
  EntitlementsUnresolvedError,
  ModuleNotEnabledError,
  assertModuleEnabled,
  getSetting,
  isModuleEnabled,
  resolveEntitlementsTx,
  type EntitledContext,
} from '../core/entitlements';

/** Resolve a REAL snapshot for a tenant and hand back a context shaped like getSession's output. */
async function ctxFor(tenantId: string): Promise<EntitledContext> {
  const snap = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, tenantId));
  return { tenantId, userId: undefined, roles: ['hr_admin'], entitlements: snap };
}

describe('slice 2 — isModuleEnabled', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.MODULE_KILL;
  });
  afterAll(() => {
    delete process.env.MODULE_KILL;
  });

  it('reflects the seeded default set — enabled where a row exists, disabled where none does', async () => {
    const ctx = await ctxFor(base.tenantId);
    for (const on of ['payroll', 'attendance', 'claims', 'performance', 'notifications']) {
      expect(isModuleEnabled(ctx, on), `${on} should be enabled`).toBe(true);
    }
    for (const off of ['toil', 'multi_cycle_payroll', 'typed_pay_components']) {
      expect(isModuleEnabled(ctx, off), `${off} should be disabled (no row)`).toBe(false);
    }
  });

  it('CORE modules are true without any row — a zero-row tenant keeps Leave and ESS', async () => {
    await owner.db.execute(sql`DELETE FROM tenant_module WHERE tenant_id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.enabledModules).toEqual([]);
    for (const core of ['leave', 'ess', 'employees', 'org', 'approvals', 'knowledge_base']) {
      expect(isModuleEnabled(ctx, core), `${core} is core and must stay on`).toBe(true);
    }
    // …and the billable ones are genuinely off, so the test above is not passing vacuously.
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
  });

  it('an UNKNOWN module code is disabled, not enabled', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'not_a_module')).toBe(false);
  });

  it('a DISABLED row is disabled, and so is a deleted one', async () => {
    await setModule(base.tenantId, 'payroll', 'disabled');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(false);
    await setModule(base.tenantId, 'payroll', null);
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(false);
  });

  it("a TRIAL row is enabled — a trial is access, not a different kind of 'off'", async () => {
    await setModule(base.tenantId, 'toil', 'trial');
    // toil depends on leave (core, always on) + attendance (seeded active), so the closure is satisfied.
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil')).toBe(true);
  });

  it('an EXPIRED row is disabled even while its status still says active — no immortal grants', async () => {
    await setModule(base.tenantId, 'payroll', 'active');
    await owner.db.execute(
      sql`UPDATE tenant_module SET expires_at = now() - interval '1 day'
          WHERE tenant_id = ${base.tenantId} AND module_code = 'payroll'`,
    );
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
    // A FUTURE expiry is still live — proving the check is the comparison, not the column's presence.
    await owner.db.execute(
      sql`UPDATE tenant_module SET expires_at = now() + interval '30 days'
          WHERE tenant_id = ${base.tenantId} AND module_code = 'payroll'`,
    );
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(true);
  });

  it('a lapsed DEPENDENCY disables its dependents', async () => {
    await setModule(base.tenantId, 'toil', 'active');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil'), 'baseline: toil on').toBe(true);
    // toil dependsOn [leave (core), attendance]. Removing attendance must take toil down with it.
    await setModule(base.tenantId, 'attendance', null);
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'attendance')).toBe(false);
    expect(isModuleEnabled(ctx, 'toil'), 'toil must follow its dependency down').toBe(false);
  });

  it('a SUSPENDED tenant loses every billable module but keeps core', async () => {
    await owner.db.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
    expect(isModuleEnabled(ctx, 'leave'), 'core survives suspension — payslip history must stay readable').toBe(true);
  });

  it('MODULE_KILL forces OFF and can never force ON', async () => {
    process.env.MODULE_KILL = 'payroll';
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll'), 'kill beats an active row').toBe(false);
    // The asymmetry: naming a module the tenant does NOT have must not grant it.
    process.env.MODULE_KILL = 'toil';
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil')).toBe(false);
    delete process.env.MODULE_KILL;
  });

  // ── company scoping ───────────────────────────────────────────────────────────────────────────

  it('a COMPANY-SCOPED grant answers true for that company and false for the tenant at large', async () => {
    await setModule(base.tenantId, 'payroll', null); // drop the tenant-wide row
    await setModule(base.tenantId, 'payroll', 'active', base.companyId);
    const ctx = await ctxFor(base.tenantId);

    expect(isModuleEnabled(ctx, 'payroll', base.companyId), 'the scoped company has it').toBe(true);
    // Asking without a company when only a scoped grant exists must be FALSE: the honest answer to
    // "may this tenant use payroll?" when they bought it for one entity is "for which company?".
    expect(isModuleEnabled(ctx, 'payroll'), 'unscoped ask must not inherit a scoped grant').toBe(false);

    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Sibling Sdn Bhd' })
      .returning({ id: schema.company.id });
    expect(isModuleEnabled(ctx, 'payroll', other.id), 'a sibling company must NOT inherit it').toBe(false);
  });

  it('a tenant-wide grant answers true for any company', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'payroll', base.companyId)).toBe(true);
  });

  // ── the no-snapshot contract ───────────────────────────────────────────────────────────────────

  it('a context with NO snapshot THROWS — never silently open, never silently closed', () => {
    const bare = { tenantId: base.tenantId } as EntitledContext;
    expect(() => isModuleEnabled(bare, 'payroll')).toThrow(EntitlementsUnresolvedError);
    expect(() => getSetting(bare, 'payroll.reset_enabled')).toThrow(EntitlementsUnresolvedError);
  });

  it('an EXEMPT context resolves open — provisioning must be able to create a tenant', () => {
    const exempt = { tenantId: base.tenantId, entitlementsExempt: 'provisioning' } as EntitledContext;
    expect(isModuleEnabled(exempt, 'payroll')).toBe(true);
    // …but a kill switch still binds it, so exemption is not a bypass of the incident lever.
    process.env.MODULE_KILL = 'payroll';
    expect(isModuleEnabled(exempt, 'payroll')).toBe(false);
    delete process.env.MODULE_KILL;
  });

  it('assertModuleEnabled throws a typed, named error carrying the module code', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(() => assertModuleEnabled(ctx, 'toil')).toThrow(ModuleNotEnabledError);
    try {
      assertModuleEnabled(ctx, 'toil');
    } catch (e) {
      expect((e as ModuleNotEnabledError).name).toBe('ModuleNotEnabledError');
      expect((e as ModuleNotEnabledError).moduleCode).toBe('toil');
    }
    expect(() => assertModuleEnabled(ctx, 'payroll')).not.toThrow();
  });

  it('a tenant never sees another tenant\'s entitlements through the snapshot', async () => {
    const other = await seedBase();
    await setModule(other.tenantId, 'toil', 'active');
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'toil'), 'the other tenant\'s grant must not leak').toBe(false);
  });
});

describe('slice 2 — getSetting', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });

  it('falls back to the catalog default when the tenant has no row', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(getSetting(ctx, 'payroll.reset_enabled')).toBe(false);
  });

  it('returns the tenant\'s value when a row exists', async () => {
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    expect(getSetting(await ctxFor(base.tenantId), 'payroll.reset_enabled')).toBe(true);
  });

  it('an UNKNOWN key throws rather than returning undefined', async () => {
    // undefined would be read as "off" by any truthiness check at the call site — a typo would
    // silently disable a feature and nobody would learn about it.
    const ctx = await ctxFor(base.tenantId);
    expect(() => getSetting(ctx, 'payroll.reset_enabld')).toThrow(/Unknown setting key/);
  });

  it('a per-tenant value overrides the default in ONE direction only', async () => {
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const mine = await ctxFor(base.tenantId);
    const other = await ctxFor((await seedBase()).tenantId);
    expect(getSetting(mine, 'payroll.reset_enabled')).toBe(true);
    expect(getSetting(other, 'payroll.reset_enabled'), 'another tenant keeps the default').toBe(false);
  });
});

// ONE file-level close. A per-describe afterAll(closeAll) closes the shared connection when the FIRST
// describe finishes, and every later block then fails with CONNECTION_ENDED — which is what happened.
afterAll(async () => {
  await closeAll();
});
