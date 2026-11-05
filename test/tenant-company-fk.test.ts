/**
 * ADR-0174 — a company-stamped row must name a company of its OWN tenant (migrations 2101/2102).
 *
 * Before 2101 a tenant-A group admin could INSERT a department in tenant A naming tenant B's company:
 * the department policy asks `app.is_admin_for(company_id)`, which answers from grants alone, and the
 * plain `company(id)` FK accepts any company. Nothing of B was readable, but the row was a dangling
 * cross-tenant reference. These tests assert the database refusal directly as `ai_hr_app`, plus a
 * catalog guard so a future company-stamped table cannot ship without the composite key. 2241/2242 extend the
 * rule to the six company references not called company_id (parent company, reporting-line scope, notice
 * owner, overtime creation company, KPI group) and to teras_chat.company_id, which had no company key at all;
 * the second guard covers every single-column company key.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { terasChat } from '../db/teras-chat-schema';
import { withTenant, type Tx } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompanyParent } from '../core/admin';
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
    expect(tables.length, 'the guard must actually see the company-stamped tables').toBeGreaterThanOrEqual(148);
    expect(tables.map((t) => t.rel)).toEqual(expect.arrayContaining(['department', 'employment', 'payroll_batch', 'role_assignment']));
    const missing = tables.filter((t) => !t.composite || !t.validated || t.composite_action !== t.single_action);
    expect(missing, 'add FOREIGN KEY (company_id, tenant_id) REFERENCES company (id, tenant_id) mirroring ON DELETE').toEqual([]);
  });

  it('every single-column company key on a tenant table has a validated (column, tenant_id) twin with the same delete action', async () => {
    const keys = rowsOf<{ rel: string; col: string; single: string; composite: string | null; validated: boolean | null; same_action: boolean | null }>(
      await owner.db.execute(sql`
        WITH keyed AS (
          SELECT f.conrelid, f.conname, f.convalidated, f.confdeltype,
                 array(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(n, o)
                       JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
                 array(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(n, o)
                       JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.n ORDER BY k.o) AS refcols
          FROM pg_constraint f WHERE f.contype = 'f' AND f.confrelid = 'public.company'::regclass
        )
        SELECT single.conrelid::regclass::text AS rel, single.cols[1] AS col, single.conname AS single,
               composite.conname AS composite, composite.convalidated AS validated,
               composite.confdeltype = single.confdeltype AS same_action
        FROM keyed single
        LEFT JOIN keyed composite ON composite.conrelid = single.conrelid
          AND composite.cols = ARRAY[single.cols[1], 'tenant_id'] AND composite.refcols = ARRAY['id', 'tenant_id']
        WHERE cardinality(single.cols) = 1 AND single.refcols = ARRAY['id']
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = single.conrelid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
        ORDER BY 1, 2`),
    );
    expect(keys.length, 'the guard must actually see every company reference').toBeGreaterThanOrEqual(154);
    expect(keys.map((k) => `${k.rel}.${k.col}`)).toEqual(expect.arrayContaining([
      'company.parent_company_id', 'reporting_line.scope_company_id', 'notice.owner_company_id', 'overtime_pattern.creation_company_id',
      'overtime_pattern_version.creation_company_id', 'performance_kpi_library.group_company_id', 'department.company_id',
    ]));
    const missing = keys.filter((k) => !k.composite || !k.validated || !k.same_action);
    expect(missing, 'add FOREIGN KEY (column, tenant_id) REFERENCES company (id, tenant_id) mirroring ON DELETE').toEqual([]);
    // teras_chat has no single-column key to twin: its only company key is the composite, NO ACTION by owner decision.
    const [chat] = rowsOf<{ definition: string; validated: boolean }>(await owner.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition,
      convalidated AS validated FROM pg_constraint WHERE conrelid = 'public.teras_chat'::regclass AND confrelid = 'public.company'::regclass`));
    expect(chat).toEqual({ definition: 'FOREIGN KEY (company_id, tenant_id) REFERENCES company(id, tenant_id)', validated: true });
  });

  it("refuses a parent company from another tenant through the application's reparent", async () => {
    const err = await setCompanyParent(adminCtx(a), { companyId: a.companyId, parentCompanyId: b.companyId }).catch((e) => e);
    expect(refusal(err)).toEqual({ code: '23503', constraint: 'company_parent_company_tenant_fk' });
    const [kept] = await owner.db.select({ parent: schema.company.parentCompanyId }).from(schema.company).where(eq(schema.company.id, a.companyId));
    expect(kept.parent).toBeNull();
    const [own] = await owner.db.insert(schema.company).values({ tenantId: a.tenantId, legalName: 'Acme Holdings' }).returning({ id: schema.company.id });
    await setCompanyParent(adminCtx(a), { companyId: a.companyId, parentCompanyId: own.id });
    const [moved] = await owner.db.select({ parent: schema.company.parentCompanyId }).from(schema.company).where(eq(schema.company.id, a.companyId));
    expect(moved.parent).toBe(own.id);
  });

  it('refuses every other non-company_id reference to another tenant on its own', async () => {
    const hire = (name: string) => hireEmployee(adminCtx(a), {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}.${a.tenantId.slice(0, 8)}@acme.test` },
      companyId: a.companyId, departmentId: a.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    });
    const [sub, mgr] = [await hire('Line Report'), await hire('Line Manager')];
    const [pattern] = await withTenant(adminCtx(a), (tx) => tx.insert(schema.overtimePattern)
      .values({ tenantId: a.tenantId, kind: 'formula', code: 'OWN', creationCompanyId: a.companyId }).returning({ id: schema.overtimePattern.id }));
    // Notice and overtime rows have guard triggers of their own (the notice guard already refuses a foreign
    // owner company). Each write runs as the owner with the table's USER triggers disabled, so only the key
    // can refuse it; foreign-key triggers are internal and stay on. The rollback restores the triggers.
    const alone = (table: string, write: (tx: Tx) => Promise<unknown>) => owner.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`ALTER TABLE public.${table} DISABLE TRIGGER USER`));
      await write(tx);
      throw new Error(`${table}: the foreign company was accepted`);
    });
    const attempts: [string, string, (tx: Tx) => Promise<unknown>][] = [
      ['notice', 'notice_owner_company_tenant_fk', (tx) => tx.insert(schema.notice).values({ tenantId: a.tenantId, title: 'Foreign', body: 'Body', startOn: '2026-01-01', endOn: '2026-01-31', ownerCompanyId: b.companyId })],
      ['overtime_pattern', 'overtime_pattern_creation_company_tenant_fk', (tx) => tx.insert(schema.overtimePattern).values({ tenantId: a.tenantId, kind: 'formula', code: 'FOREIGN', creationCompanyId: b.companyId })],
      ['overtime_pattern_version', 'overtime_pattern_version_creation_company_tenant_fk', (tx) => tx.insert(schema.overtimePatternVersion).values({ tenantId: a.tenantId, patternId: pattern.id, kind: 'formula', creationCompanyId: b.companyId, ordinal: 1, name: 'Foreign', definition: {}, digest: '0'.repeat(64) })],
      ['performance_kpi_library', 'performance_kpi_library_group_company_tenant_fk', (tx) => tx.insert(schema.performanceKpiLibrary).values({ tenantId: a.tenantId, name: 'Foreign', template: {}, groupCompanyId: b.companyId })],
      ['reporting_line', 'reporting_line_scope_company_tenant_fk', (tx) => tx.insert(schema.reportingLine).values({ tenantId: a.tenantId, subordinateEmploymentId: sub.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2024-01-01', scopeCompanyId: b.companyId })],
      ['teras_chat', 'teras_chat_company_tenant_fk', (tx) => tx.insert(terasChat).values({ id: randomUUID(), tenantId: a.tenantId, appUserId: a.adminUserId, companyId: b.companyId, scopeDigest: '0'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) })],
    ];
    const outcomes = [];
    for (const [table, constraint, write] of attempts) outcomes.push({ constraint, ...refusal(await alone(table, write).catch((e) => e)) });
    expect(outcomes).toEqual(attempts.map(([, constraint]) => ({ constraint, code: '23503' })));
    const [triggers] = rowsOf<{ disabled: number }>(await owner.db.execute(sql`SELECT count(*)::int AS disabled FROM pg_trigger
      WHERE tgrelid IN ('public.notice'::regclass, 'public.overtime_pattern'::regclass, 'public.overtime_pattern_version'::regclass) AND tgenabled = 'D'`));
    expect(triggers.disabled).toBe(0);
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
