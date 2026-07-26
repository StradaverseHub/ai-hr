/**
 * ADR-0077 slice 1 — the entitlement substrate's privilege shape, asserted rather than assumed.
 *
 * WHY THIS FILE IS THE SLICE'S REAL DELIVERABLE
 * ---------------------------------------------
 * `deploy/bootstrap-db.sql:50-54` issues ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/DELETE
 * on every table ai_hr_owner creates to ai_hr_app. So a new table is born FULLY WRITABLE by the
 * application role, and "grant only SELECT by omission" does not exist. Migration 0313 therefore
 * carries an explicit REVOKE per table.
 *
 * And `cleanroom-verify.sh:47-52` reproduces the same ALTER DEFAULT PRIVILEGES — so the clean-room
 * gate MASKS a missing GRANT and can NEVER catch a missing REVOKE. Delete a REVOKE line from 0313 and
 * every other test in the repo still passes while any hr_admin can grant themselves Payroll. This
 * file is the only thing that would notice, which is why it reads information_schema directly instead
 * of inferring privileges from behaviour.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { CORE_MODULE_CODES } from '../packs/catalog';

function pgText(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    for (const k of ['message', 'detail', 'hint', 'constraint_name', 'where']) {
      if (typeof rec[k] === 'string') parts.push(rec[k] as string);
    }
    cur = rec.cause;
  }
  return parts.join(' | ');
}

/** The privileges ai_hr_app actually holds on a table, straight from the catalog. */
async function grantsOn(table: string): Promise<string[]> {
  const rows = (await owner.db.execute(
    sql`SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'ai_hr_app' AND table_name = ${table}`,
  )) as unknown as { privilege_type: string }[];
  return rows.map((r) => r.privilege_type).sort();
}

describe('slice 1 — entitlement substrate privileges and policies', () => {
  let base: Base;
  let admin: SessionContext;
  let employee: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    admin = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    const [eu] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `emp_${crypto.randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: eu.id, companyId: null, role: 'employee' });
    employee = { tenantId: base.tenantId, userId: eu.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  });

  afterAll(async () => {
    await closeAll();
  });

  // ── The privilege matrix — the thing the clean-room structurally cannot check ──────────────────

  it('the app role holds SELECT and nothing else on the catalogs and the entitlement tables', async () => {
    for (const t of ['module', 'setting_definition', 'tenant_module', 'subscription', 'subscription_line', 'usage_snapshot']) {
      expect(await grantsOn(t), `${t} must be SELECT-only to ai_hr_app`).toEqual(['SELECT']);
    }
  });

  it('platform_user is not reachable by the app role at all — no grant, not even SELECT', async () => {
    expect(await grantsOn('platform_user')).toEqual([]);
  });

  it('tenant_setting keeps write privileges — its gate is the scope POLICY, not the grant', async () => {
    // Deliberately different from its siblings: a customer admin genuinely may write tenant-scoped
    // settings. Revoking here would have made the scope policy unreachable and untestable.
    expect(await grantsOn('tenant_setting')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('the 0295 column grant still withholds activation_url while carrying the new intake columns', async () => {
    const rows = (await owner.db.execute(
      sql`SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'ai_hr_app' AND table_name = 'tenant_provision_request' AND privilege_type = 'SELECT'`,
    )) as unknown as { column_name: string }[];
    const cols = rows.map((r) => r.column_name);
    expect(cols, 'country must be readable or the console Retry path breaks').toContain('country');
    expect(cols, 'plan must be readable').toContain('plan');
    expect(cols, 'activation_url must stay unreadable — the point of the column grant').not.toContain('activation_url');
  });

  // ── tenant_module: readable, never writable by a customer ──────────────────────────────────────

  it('an admin can READ their own entitlements', async () => {
    const rows = await withTenant(admin, (tx) =>
      tx.select({ code: schema.tenantModule.moduleCode }).from(schema.tenantModule),
    );
    expect(rows.map((r) => r.code).sort()).toEqual(['attendance', 'claims', 'notifications', 'payroll', 'performance']);
  });

  it('an admin CANNOT grant themselves a module', async () => {
    const err = await withTenant(admin, (tx) =>
      tx.insert(schema.tenantModule).values({ tenantId: base.tenantId, moduleCode: 'toil', status: 'active' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const after = await owner.db
      .select({ code: schema.tenantModule.moduleCode })
      .from(schema.tenantModule)
      .where(and(eq(schema.tenantModule.tenantId, base.tenantId), eq(schema.tenantModule.moduleCode, 'toil')));
    expect(after, 'no toil row may exist').toHaveLength(0);
  });

  it('an admin CANNOT delete or update an entitlement to extend it', async () => {
    const del = await withTenant(admin, (tx) => tx.delete(schema.tenantModule)).catch((e) => e);
    expect(del).toBeInstanceOf(Error);
    const upd = await withTenant(admin, (tx) =>
      tx.update(schema.tenantModule).set({ expiresAt: new Date('2099-01-01') }),
    ).catch((e) => e);
    expect(upd).toBeInstanceOf(Error);
  });

  it('a tenant cannot see another tenant\'s entitlements', async () => {
    const other = await seedBase();
    const rows = await withTenant(admin, (tx) =>
      tx.select({ tid: schema.tenantModule.tenantId }).from(schema.tenantModule),
    );
    expect(rows.every((r) => r.tid === base.tenantId)).toBe(true);
    expect(rows.map((r) => r.tid)).not.toContain(other.tenantId);
  });

  // ── The core-module trigger: binds every writer, including the owner ───────────────────────────

  it('a core module can never be given a row — even by the owner connection', async () => {
    for (const code of CORE_MODULE_CODES) {
      const err = await owner.db
        .insert(schema.tenantModule)
        .values({ tenantId: base.tenantId, moduleCode: code, status: 'active' })
        .catch((e) => e);
      expect(err, `${code} must be refused`).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/core module .* is always enabled/i);
    }
  });

  it('a tenant with ZERO entitlement rows still keeps its core modules (they are not rows)', async () => {
    await owner.db.execute(sql`DELETE FROM tenant_module WHERE tenant_id = ${base.tenantId}`);
    const rows = await owner.db
      .select({ id: schema.tenantModule.id })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, base.tenantId));
    expect(rows).toHaveLength(0);
    // The guarantee is structural: core codes are answered from packs/catalog.ts, never from a row,
    // so an empty table cannot cost a tenant Leave or ESS.
    expect(CORE_MODULE_CODES).toContain('leave');
    expect(CORE_MODULE_CODES).toContain('ess');
  });

  // ── tenant_setting: the scope join is the load-bearing line ────────────────────────────────────

  it('an admin CAN write a tenant-scoped setting', async () => {
    await withTenant(admin, (tx) =>
      tx.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: 'payroll.individual_txn_pay_enabled',
        value: true,
      }),
    );
    const rows = await owner.db
      .select({ v: schema.tenantSetting.value })
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.tenantId, base.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0].v).toBe(true);
  });

  it('an admin CANNOT write a PLATFORM-scoped setting — the audit chain is not theirs to switch off', async () => {
    const err = await withTenant(admin, (tx) =>
      tx.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: 'audit.hash_chain_enabled',
        value: false,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('an admin CANNOT delete or overwrite a platform-scoped setting the platform already set', async () => {
    await owner.db.insert(schema.tenantSetting).values({
      tenantId: base.tenantId,
      key: 'audit.hash_chain_enabled',
      value: true,
      source: 'platform',
    });
    const del = await withTenant(admin, (tx) =>
      tx.delete(schema.tenantSetting).where(eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
    ).catch((e) => e);
    // A DELETE filtered out by USING removes zero rows rather than raising — assert the ROW, which is
    // what actually matters, instead of the error that may or may not appear.
    void del;
    const still = await owner.db
      .select({ v: schema.tenantSetting.value })
      .from(schema.tenantSetting)
      .where(
        and(eq(schema.tenantSetting.tenantId, base.tenantId), eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
      );
    expect(still, 'the platform-scoped row must survive a customer DELETE').toHaveLength(1);
    expect(still[0].v).toBe(true);
  });

  it('a NON-admin cannot write even a tenant-scoped setting', async () => {
    const err = await withTenant(employee, (tx) =>
      tx.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: 'payroll.individual_txn_pay_enabled',
        value: true,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it('an UNKNOWN setting key fails closed — a typo cannot invent a setting', async () => {
    const err = await withTenant(admin, (tx) =>
      tx.insert(schema.tenantSetting).values({ tenantId: base.tenantId, key: 'payroll.reset_enabld', value: true }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it('a customer can READ a platform-scoped setting — visibility is not the boundary', async () => {
    await owner.db.insert(schema.tenantSetting).values({
      tenantId: base.tenantId,
      key: 'audit.hash_chain_enabled',
      value: true,
      source: 'platform',
    });
    const rows = await withTenant(admin, (tx) =>
      tx
        .select({ k: schema.tenantSetting.key })
        .from(schema.tenantSetting)
        .where(eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
    );
    expect(rows, 'the customer must be able to SEE what the platform manages for them').toHaveLength(1);
  });

  // ── the grain ─────────────────────────────────────────────────────────────────────────────────

  it('tenant-wide and company-scoped entitlements are DIFFERENT grains, and each is unique', async () => {
    await setModule(base.tenantId, 'toil', 'active'); // tenant-wide
    await setModule(base.tenantId, 'toil', 'active', base.companyId); // company-scoped
    const rows = await owner.db
      .select({ c: schema.tenantModule.companyId })
      .from(schema.tenantModule)
      .where(and(eq(schema.tenantModule.tenantId, base.tenantId), eq(schema.tenantModule.moduleCode, 'toil')));
    expect(rows).toHaveLength(2);

    const dup = await owner.db
      .insert(schema.tenantModule)
      .values({ tenantId: base.tenantId, moduleCode: 'toil', companyId: base.companyId, status: 'active' })
      .catch((e) => e);
    expect(dup, 'a second row at the same grain must be refused').toBeInstanceOf(Error);
    expect(pgText(dup)).toMatch(/tenant_module_grain_uq/i);
  });
});
