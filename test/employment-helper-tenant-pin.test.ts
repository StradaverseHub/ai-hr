/**
 * ADR-0174 — the employment helpers and app.company_subtree answer only inside the session tenant
 * (migration 2100).
 *
 * `app.is_admin_for` answers from grants, so before 2100 a group-wide admin of tenant A got `true` from
 * app.can_admin_employment for an employment of tenant B. Every policy also carried a tenant conjunct,
 * so nothing leaked, but the helpers were not safe on their own. They also used
 * `SET search_path = public`, which an ai_hr_app session could defeat with a TEMP `employment` table
 * (pg_temp is searched first unless named; see 0312). Each test drives the database directly as
 * `ai_hr_app` and proves its shadow or foreign id is real before asserting the refusal.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { pgSqlState } from '../lib/db-error';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const HELPERS = ['can_admin_employment', 'can_admin_payroll_employment', 'can_admin_perfcomp_employment'] as const;
const rowsOf = <T>(r: unknown) => r as T[];

const hire = async (b: Base, name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}.${b.tenantId.slice(0, 8)}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const answers = async (ctx: SessionContext, employmentId: string) => {
  const [row] = rowsOf<Record<(typeof HELPERS)[number], boolean>>(await withTenant(ctx, (tx) => tx.execute(sql`
    SELECT app.can_admin_employment(${employmentId}::uuid) AS can_admin_employment,
           app.can_admin_payroll_employment(${employmentId}::uuid) AS can_admin_payroll_employment,
           app.can_admin_perfcomp_employment(${employmentId}::uuid) AS can_admin_perfcomp_employment`)));
  return row;
};

describe('ADR-0174 — tenant-pinned employment helpers', () => {
  let a: Base;
  let b: Base;
  let ownEmployment: string;
  let foreignEmployment: string;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    a = await seedBase();
    b = await seedBase();
    ownEmployment = (await hire(a, 'Own Subject')).employmentId;
    foreignEmployment = (await hire(b, 'Foreign Subject')).employmentId;
  });
  afterAll(async () => {
    await closeAll();
  });

  it("deny a group-wide admin another tenant's employment and still allow its own", async () => {
    const ctx: SessionContext = { ...adminCtx(a), grants: [{ role: 'hr_admin', companyId: null }] };
    // The foreign id is real, and the grant alone still says yes for its company: the tenant pin is
    // what decides, not a missing row or a narrower grant.
    const [owned] = rowsOf<{ tenant: string }>(await owner.db.execute(
      sql`SELECT tenant_id::text AS tenant FROM public.employment WHERE id = ${foreignEmployment}::uuid`));
    const [grant] = rowsOf<{ company_grant: boolean }>(await withTenant(ctx, (tx) => tx.execute(
      sql`SELECT app.is_admin_for(${b.companyId}::uuid) AS company_grant`)));
    expect({ ...owned, ...grant }).toEqual({ tenant: b.tenantId, company_grant: true });

    expect(await answers(ctx, foreignEmployment)).toEqual({ can_admin_employment: false, can_admin_payroll_employment: false, can_admin_perfcomp_employment: false });
    expect(await answers(ctx, ownEmployment)).toEqual({ can_admin_employment: true, can_admin_payroll_employment: true, can_admin_perfcomp_employment: true });
  });

  it('a TEMP employment shadow cannot change a helper answer', async () => {
    const ctx = adminCtx(a);
    // ON COMMIT DROP: pooled connections must not carry the shadow into later tests.
    const result = await withTenant(ctx, async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE employment (id uuid, tenant_id uuid, person_id uuid, company_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO employment (id, tenant_id, company_id)
        VALUES (${foreignEmployment}::uuid, ${a.tenantId}::uuid, ${a.companyId}::uuid)`);
      const [live] = rowsOf<{ shadowed: boolean }>(await tx.execute(
        sql`SELECT 'employment'::regclass <> 'public.employment'::regclass AS shadowed`));
      const [row] = rowsOf<Record<(typeof HELPERS)[number], boolean>>(await tx.execute(sql`
        SELECT app.can_admin_employment(${foreignEmployment}::uuid) AS can_admin_employment,
               app.can_admin_payroll_employment(${foreignEmployment}::uuid) AS can_admin_payroll_employment,
               app.can_admin_perfcomp_employment(${foreignEmployment}::uuid) AS can_admin_perfcomp_employment`));
      return { live: live.shadowed, ...row };
    });
    expect(result).toEqual({ live: true, can_admin_employment: false, can_admin_payroll_employment: false, can_admin_perfcomp_employment: false });
  });

  it('pins every helper search_path with pg_temp last and keeps them SECURITY DEFINER', async () => {
    const rows = rowsOf<{ name: string; definer: boolean; config: string[] }>(await owner.db.execute(sql`
      SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('can_admin_employment', 'can_admin_payroll_employment', 'can_admin_perfcomp_employment', 'company_subtree')
      ORDER BY p.proname`));
    expect(rows.map((r) => r.name)).toEqual(['can_admin_employment', 'can_admin_payroll_employment', 'can_admin_perfcomp_employment', 'company_subtree']);
    for (const r of rows) {
      expect(r.definer, r.name).toBe(true);
      expect(r.config.map((v) => v.replaceAll(' ', '')), r.name).toEqual(['search_path=pg_catalog,public,pg_temp']);
    }
  });

  it('app.company_subtree is no longer callable by ai_hr_app and never walks another tenant', async () => {
    const [privilege] = rowsOf<{ app: boolean; anyone: boolean }>(await owner.db.execute(sql`
      SELECT has_function_privilege('ai_hr_app', 'app.company_subtree(uuid)', 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                     WHERE p.oid = 'app.company_subtree(uuid)'::regprocedure AND x.grantee = 0) AS anyone`));
    expect(privilege).toEqual({ app: false, anyone: false });
    const denied = await withTenant(adminCtx(a), (tx) => tx.execute(sql`SELECT id FROM app.company_subtree(${a.companyId}::uuid)`)).catch((e) => e);
    expect(pgSqlState(denied)).toBe('42501');

    // The owner may still call it; the walk stays inside the session tenant.
    const walk = async (tenant: string, root: string) => owner.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant}, true)`);
      return rowsOf<{ id: string }>(await tx.execute(sql`SELECT id::text AS id FROM app.company_subtree(${root}::uuid)`)).map((r) => r.id);
    });
    expect(await walk(a.tenantId, a.companyId)).toEqual([a.companyId]);
    expect(await walk(a.tenantId, b.companyId)).toEqual([]);
  });
});
