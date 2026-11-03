/**
 * ADR-0174 — a company-stamped row must name a company of its OWN tenant (migrations 1501/1502).
 *
 * Before 1501 a tenant-A group admin could INSERT a department in tenant A naming tenant B's company:
 * the department policy asks `app.is_admin_for(company_id)`, which answers from grants alone, and the
 * plain `company(id)` FK accepts any company. Nothing of B was readable, but the row was a dangling
 * cross-tenant reference. These tests assert the database refusal directly as `ai_hr_app`, plus a
 * catalog guard so a future company-stamped table cannot ship without the composite key.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

type Refusal = { code?: string; constraint?: string };
function refusal(e: unknown): Refusal {
  let cur = e as { code?: unknown; constraint_name?: unknown; cause?: unknown } | null;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++) {
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code))
      return { code: cur.code, constraint: typeof cur.constraint_name === 'string' ? cur.constraint_name : undefined };
    cur = cur.cause as typeof cur;
  }
  return {};
}

const rowsOf = <T>(r: unknown) => r as T[];

describe('ADR-0174 — company/tenant composite keys', () => {
  let a: Base;
  let b: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    a = await seedBase();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('every tenant-scoped table with a company FK carries a validated (company_id, tenant_id) key with the same delete action', async () => {
    const tables = rowsOf<{ rel: string; single: string; composite: string | null; validated: boolean | null; single_action: string; composite_action: string | null }>(
      await owner.db.execute(sql`
        WITH shaped AS (
          SELECT c.oid, c.oid::regclass::text AS rel
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
            AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'company_id' AND NOT x.attisdropped)
        ), keyed AS (
          SELECT f.conrelid, f.conname, f.convalidated, f.confdeltype::text AS action,
                 array(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(n, o)
                       JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
                 array(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(n, o)
                       JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.n ORDER BY k.o) AS refcols
          FROM pg_constraint f WHERE f.contype = 'f' AND f.confrelid = 'public.company'::regclass
        )
        SELECT s.rel, single.conname AS single, single.action AS single_action,
               composite.conname AS composite, composite.convalidated AS validated, composite.action AS composite_action
        FROM shaped s
        JOIN keyed single ON single.conrelid = s.oid AND single.cols = ARRAY['company_id'] AND single.refcols = ARRAY['id']
        LEFT JOIN keyed composite ON composite.conrelid = s.oid
          AND composite.cols = ARRAY['company_id', 'tenant_id'] AND composite.refcols = ARRAY['id', 'tenant_id']
        ORDER BY s.rel`),
    );
    expect(tables.length, 'the guard must actually see the company-stamped tables').toBeGreaterThanOrEqual(146);
    expect(tables.map((t) => t.rel)).toEqual(expect.arrayContaining(['department', 'employment', 'payroll_batch', 'role_assignment']));
    const missing = tables.filter((t) => !t.composite || !t.validated || t.composite_action !== t.single_action);
    expect(missing, 'add FOREIGN KEY (company_id, tenant_id) REFERENCES company (id, tenant_id) mirroring ON DELETE').toEqual([]);
  });

  it("refuses a group admin's department that names another tenant's company, and keeps its own", async () => {
    const ctx = adminCtx(a);
    const err = await withTenant(ctx, (tx) =>
      tx.insert(schema.department).values({ tenantId: a.tenantId, companyId: b.companyId, name: 'Foreign Finance' }),
    ).catch((e) => e);
    expect(refusal(err)).toEqual({ code: '23503', constraint: 'department_company_tenant_fk' });

    const [own] = await withTenant(ctx, (tx) =>
      tx.insert(schema.department).values({ tenantId: a.tenantId, companyId: a.companyId, name: 'Own Finance' }).returning({ id: schema.department.id }),
    );
    expect(own.id).toMatch(/^[0-9a-f-]{36}$/);
    const foreign = await owner.db.select({ id: schema.department.id }).from(schema.department)
      .where(eq(schema.department.name, 'Foreign Finance'));
    expect(foreign).toEqual([]);
  });

  it('refuses re-pointing an existing row at another tenant’s company', async () => {
    // location has no guard triggers of its own, so the key is the only thing that can refuse this, and
    // its policy (0111) asks only `app.is_admin_for(company_id)`, which a group-wide grant satisfies.
    const ctx = adminCtx(a);
    const [site] = await withTenant(ctx, (tx) =>
      tx.insert(schema.location).values({ tenantId: a.tenantId, companyId: a.companyId, code: 'HQ', name: 'Head office' })
        .returning({ id: schema.location.id }),
    );
    const err = await withTenant(ctx, (tx) =>
      tx.update(schema.location).set({ companyId: b.companyId }).where(eq(schema.location.id, site.id)),
    ).catch((e) => e);
    expect(refusal(err)).toEqual({ code: '23503', constraint: 'location_company_tenant_fk' });
    const [kept] = await owner.db.select({ companyId: schema.location.companyId }).from(schema.location)
      .where(eq(schema.location.id, site.id));
    expect(kept.companyId).toBe(a.companyId);
  });

  it('holds for writers that bypass RLS, and still allows a group-wide NULL company', async () => {
    const err = await owner.db.insert(schema.costCenter)
      .values({ tenantId: a.tenantId, companyId: b.companyId, code: 'X1', name: 'Foreign' }).catch((e) => e);
    expect(refusal(err)).toEqual({ code: '23503', constraint: 'cost_center_company_tenant_fk' });

    const grants = await owner.db.select({ companyId: schema.roleAssignment.companyId }).from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, a.adminUserId));
    expect(grants).toEqual([{ companyId: null }]);
    const scoped = await owner.db.insert(schema.roleAssignment)
      .values({ tenantId: a.tenantId, appUserId: a.adminUserId, companyId: b.companyId, role: 'manager' }).catch((e) => e);
    expect(refusal(scoped)).toEqual({ code: '23503', constraint: 'role_assignment_company_tenant_fk' });
  });
});
