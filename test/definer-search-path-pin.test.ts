/**
 * ADR-0174 follow-up — every SECURITY DEFINER function names pg_temp LAST in its search_path, and the
 * visibility walks answer only inside the session tenant (migration 2400; app.is_company_descendant since 2126).
 *
 * A path that does not name pg_temp still searches the session's temporary schema FIRST for relation and
 * type names, so an ai_hr_app session could put a TEMP `employment` in front of public.employment, or a
 * TEMP table named `jsonb` in front of the jsonb type, inside a definer body. Each shadow test first runs
 * the installed body under its pre-2400 path as a control, proving the shadow is live, before asserting
 * that the installed function ignores it. The catalog guard keeps future definers pinned.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompanyParent } from '../core/admin';
import { pgSqlState } from '../lib/db-error';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const rowsOf = <T>(r: unknown) => r as T[];

const hire = async (b: Base, name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}.${randomUUID().slice(0, 8)}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const employeeCtx = async (b: Base, personId: string): Promise<SessionContext> => ({
  tenantId: b.tenantId,
  userId: await createAppUser(b.tenantId, personId, 'employee'),
  roles: ['employee'],
  personId,
});

/** The body `fn` had before 2400, taken from the latest migration that defined it. */
const migrationBody = (migration: string, fn: string) => {
  const text = readFileSync(`db/migrations/${migration}.sql`, 'utf8');
  const start = text.lastIndexOf(`CREATE OR REPLACE FUNCTION app.${fn}(`);
  const open = text.indexOf('AS $$', start) + 'AS $$'.length;
  const body = text.slice(open, text.indexOf('$$;', open));
  expect(start, fn).toBeGreaterThanOrEqual(0);
  expect(body, `${fn} must be the unqualified pre-2400 body`).toMatch(/FROM employment e/);
  return body;
};

const installedBody = async (fn: string) => {
  const [row] = rowsOf<{ body: string }>(await owner.db.execute(sql`SELECT prosrc AS body FROM pg_proc WHERE oid = ${fn}::regprocedure`));
  expect(row.body.length, fn).toBeGreaterThan(40);
  return row.body;
};

/** `body` as an invoker pg_temp function under the pre-2400 path `public`. A pg_temp function outlives a
 *  committed transaction on a pooled connection, so callers drop it before committing (a rollback removes it). */
const controlOf = (tx: Tx, name: string, args: string, returns: string, body: string) =>
  tx.execute(sql.raw(`CREATE FUNCTION pg_temp.${name}(${args}) RETURNS ${returns} LANGUAGE sql STABLE SET search_path = public AS $control$${body}$control$`));

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

describe('ADR-0174 follow-up — pinned definer search paths', () => {

  it('every definer, and every function with its own search_path, ends that path with pg_temp', async () => {
    const rows = rowsOf<{ fn: string; definer: boolean; config: string[] | null }>(await owner.db.execute(sql`
      SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        AND n.nspname NOT LIKE 'pg\\_toast%' AND (p.prosecdef OR p.proconfig IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`));
    const definers = rows.filter((r) => r.definer).map((r) => r.fn);
    expect(definers.length, 'the guard must actually see the definers').toBeGreaterThan(1700);
    expect(definers).toEqual(expect.arrayContaining([
      'app.can_see_employment(uuid)', 'app.can_see_person(uuid)', 'app.is_admin_report_of(uuid,uuid)',
      'app.heads_department_of(uuid,uuid)', 'app.reward_senior_awards_for_post(uuid)', 'identity_email.letter_job_current(uuid,uuid)',
    ]));
    const offenders = rows.flatMap((r) => {
      const path = (r.config ?? []).find((c) => c.startsWith('search_path='))?.slice('search_path='.length);
      if (path === undefined) return r.definer ? [`${r.fn}: SECURITY DEFINER without its own search_path`] : [];
      const entries = path.split(',').map((e) => e.trim());
      return entries.at(-1) === 'pg_temp' && entries.indexOf('pg_temp') === entries.length - 1 ? [] : [`${r.fn}: ${path}`];
    });
    expect(offenders, 'SET search_path = pg_catalog, public, pg_temp (pg_temp last) and qualify relations').toEqual([]);
  });

  it('a TEMP employment or app_user shadow cannot change can_see_employment or can_see_person', async () => {
    const own = await hire(a, 'Own Person');
    const coworker = await hire(a, 'Coworker Person');
    const ctx = await employeeCtx(a, own.personId);
    const result = await withTenant(ctx, async (tx) => {
      await controlOf(tx, 'old_can_see_employment', 'emp_id uuid', 'boolean', migrationBody('0109_hierarchy_visibility_rls', 'can_see_employment'));
      await controlOf(tx, 'old_can_see_person', 'p_id uuid', 'boolean', migrationBody('0001_rls_grants_constraints', 'can_see_person'));
      // ON COMMIT DROP: pooled connections must not carry the shadows into later tests.
      await tx.execute(sql`CREATE TEMP TABLE employment (id uuid, tenant_id uuid, person_id uuid, company_id uuid, terminated_on date) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO employment (id, tenant_id, person_id, company_id)
        VALUES (${coworker.employmentId}::uuid, ${a.tenantId}::uuid, ${own.personId}::uuid, ${a.companyId}::uuid)`);
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO app_user (id, tenant_id, person_id)
        VALUES (${ctx.userId}::uuid, ${a.tenantId}::uuid, ${own.personId}::uuid), (${ctx.userId}::uuid, ${a.tenantId}::uuid, ${coworker.personId}::uuid)`);
      const [row] = rowsOf<Record<string, boolean>>(await tx.execute(sql`
        SELECT 'employment'::regclass <> 'public.employment'::regclass AND 'app_user'::regclass <> 'public.app_user'::regclass AS shadowed,
               pg_temp.old_can_see_employment(${coworker.employmentId}::uuid) AS old_employment,
               pg_temp.old_can_see_person(${coworker.personId}::uuid) AS old_person,
               app.can_see_employment(${coworker.employmentId}::uuid) AS employment,
               app.can_see_person(${coworker.personId}::uuid) AS person,
               app.can_see_employment(${own.employmentId}::uuid) AS own_employment`));
      await tx.execute(sql`DROP FUNCTION pg_temp.old_can_see_employment(uuid), pg_temp.old_can_see_person(uuid)`);
      return row;
    });
    expect(result).toEqual({ shadowed: true, old_employment: true, old_person: true, employment: false, person: false, own_employment: true });
  });

  it('a TEMP table cannot shadow a relation or a type name inside app.principal', async () => {
    const ctx = adminCtx(a);
    // 2400 changed only this function's path, so the installed body is also the pre-2400 body.
    const body = await installedBody('app.principal(uuid)');
    const control = (tx: Tx) => controlOf(tx, 'old_principal', 'p_user_id uuid', 'TABLE (tenant_id uuid, person_id uuid, grants jsonb)', body);
    const shadowRelation = await withTenant(ctx, async (tx) => {
      await control(tx);
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO app_user (id, tenant_id, person_id) VALUES (${a.adminUserId}::uuid, ${b.tenantId}::uuid, NULL)`);
      const [old] = rowsOf<{ tenant: string }>(await tx.execute(sql`SELECT tenant_id::text AS tenant FROM pg_temp.old_principal(${a.adminUserId}::uuid)`));
      const [now] = rowsOf<{ tenant: string }>(await tx.execute(sql`SELECT tenant_id::text AS tenant FROM app.principal(${a.adminUserId}::uuid)`));
      await tx.execute(sql`DROP FUNCTION pg_temp.old_principal(uuid)`);
      return { old: old.tenant, now: now.tenant };
    });
    expect(shadowRelation).toEqual({ old: b.tenantId, now: a.tenantId });

    // A TEMP table named jsonb also creates a TEMP composite TYPE jsonb, which the old path resolved first:
    // the control's '[]'::jsonb becomes a malformed record. Its transaction fails and rolls the control back.
    const shadowJsonb = (tx: Tx) => tx.execute(sql`CREATE TEMP TABLE jsonb (x int) ON COMMIT DROP`);
    const old = await withTenant(ctx, async (tx) => {
      await control(tx);
      await shadowJsonb(tx);
      return tx.execute(sql`SELECT grants FROM pg_temp.old_principal(${a.adminUserId}::uuid)`);
    }).then(() => 'answered', (e: unknown) => pgSqlState(e));
    expect(old).toBe('22P02');
    const roles = await withTenant(ctx, async (tx) => {
      await shadowJsonb(tx);
      const [now] = rowsOf<{ grants: { role: string }[] }>(await tx.execute(sql`SELECT grants FROM app.principal(${a.adminUserId}::uuid)`));
      return now.grants.map((g) => g.role);
    });
    expect(roles).toEqual(['hr_admin']);
  });
});

describe('ADR-0174 follow-up — visibility walks stay in the session tenant', () => {
  let manager: string;
  let report: string;
  let colleague: string;
  let child: string;
  beforeEach(async () => {
    // Tenant B: report → manager on an administrative line; colleague shares the manager's department.
    manager = (await hire(b, 'Foreign Manager')).employmentId;
    report = (await hire(b, 'Foreign Report')).employmentId;
    colleague = (await hire(b, 'Foreign Colleague')).employmentId;
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: report, managerEmploymentId: manager, lineType: 'administrative', validFrom: '2024-01-01' });
    [{ id: child }] = await owner.db.insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Foreign Subsidiary', parentCompanyId: b.companyId }).returning({ id: schema.company.id });
  });

  const walks = (ctx: SessionContext) => withTenant(ctx, async (tx) => rowsOf<Record<string, boolean>>(await tx.execute(sql`
    SELECT app.is_admin_report_of(${report}::uuid, ${manager}::uuid) AS reports,
           app.heads_department_of(${colleague}::uuid, ${manager}::uuid) AS heads,
           app.is_company_descendant(${child}::uuid, ${b.companyId}::uuid) AS descends`))[0]);

  it("answers inside its own tenant and refuses another tenant's ids", async () => {
    expect(await walks(adminCtx(b))).toEqual({ reports: true, heads: true, descends: true });
    expect(await walks(adminCtx(a))).toEqual({ reports: false, heads: false, descends: false });
  });

  it('the company cycle trigger still refuses a cycle in the session tenant', async () => {
    // 2126 walks only the session tenant, so the cycle check is exercised the way the application writes.
    const cycle = await setCompanyParent(adminCtx(b), { companyId: b.companyId, parentCompanyId: child }).catch((e) => e);
    expect(pgSqlState(cycle)).toBe('23514');
  });
});
