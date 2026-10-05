/**
 * f00bd1eb — "company deletion with usage validation and proper authorization".
 *
 * ## The fault, as found
 *
 * ABC Comapny on production could not be deleted. Nobody had ever used it: no employment, no payroll. What
 * it had was the setup every company created on the Organization screen is born with — six payroll cycles
 * (createCompany seeds them), a TOIL policy, a payslip display setting, and five nightly usage records.
 * `deleteCompany` counted three tables (department, employment, child company), the panel's `inUse` asked the
 * same three and said "Not referenced anywhere", the database refused on payroll_cycle, and the raw driver
 * message landed in the address bar. Separately, nothing checked WHO was deleting: the action read the
 * session with getSession, the service checked no role, and the company RLS policy gated DELETE by tenant.
 *
 * ## What this file pins
 *
 * §1 — the declaration in core/company-refs.ts IS the database's: every foreign key to company.id, and every
 *      foreign key into a table deleted with a company, is declared — in both directions (leave-type-refs
 *      pattern). A forty-sixth table referencing `company` fails here until somebody decides what deleting a
 *      company should do about it. Declaring the row IS the fix; never widen the query.
 * §2 — for every disposition, the panel's answer (`companyDeleteStatus`) and the delete itself agree.
 * §3 — the success path through createCompany, with the automatic setup the old test never had.
 * §4 — authorization: requireAdmin, the service check, and migration 0511's policy when the service is bypassed.
 * §5 — every refusal reaches the reader as a sentence, never as SQL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';

let SESSION: SessionContext;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => SESSION,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new RedirectError(p);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync: read } = await import('node:fs');
  const { fileURLToPath: toPath } = await import('node:url');
  const messages = JSON.parse(read(toPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e: unknown) => {
          throw e;
        },
      }),
  };
});

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  COMPANY_CONFIG_DEPENDENTS,
  COMPANY_REFERRERS,
  cascadedReferrers,
  companyDeleteBlockSqlText,
} from '../core/company-refs';
import {
  CompanyDeleteForbiddenError,
  CompanyInUseError,
  createCompany,
  deleteCompany,
} from '../core/admin';
import { companyDeleteStatus } from '../core/read';
import { pgSqlState } from '../lib/db-error';
import { deleteCompanyAction } from '../app/admin/actions';
import { COMPANY_DELETE_BLOCKS, COMPANY_DELETE_REFUSAL_KEY, type CompanyDeleteBlock } from '../lib/company-delete';

const messagesFor = (l: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../messages/${l}.json`, import.meta.url)), 'utf8'));
const ORG_EN = messagesFor('en').admin.organization as Record<string, string>;

let b: Base;
const ADMIN = () => adminCtx(b); // group-wide: withTenant turns bare roles into company-null grants
const scopedAdmin = (companyId: string): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId }],
  entitlements: adminCtx(b).entitlements,
});
const member = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['employee'],
  grants: [{ role: 'employee', companyId: null }],
  entitlements: adminCtx(b).entitlements,
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  SESSION = ADMIN();
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────
/** The SQLSTATE a statement failed with, or 'ok'. */
async function sqlStateOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return pgSqlState(e);
  }
}
/** A company made the way the Organization screen makes one: with its automatic setup. */
const fresh = async (legalName = `Unused ${randomUUID().slice(0, 6)} Sdn Bhd`) =>
  (await createCompany(ADMIN(), { legalName, companyLabel: 'UNUSED', registrationNo: '202601009999' })).id;
/** A bare company row, inserted as the owner: no setup, so no foreign key can be what refuses a delete. */
const bare = async (extra: Partial<typeof schema.company.$inferInsert> = {}) =>
  (
    await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: `Bare ${randomUUID().slice(0, 6)}`, ...extra })
      .returning({ id: schema.company.id })
  )[0].id;
const exists = async (id: string) =>
  (await owner.db.select({ id: schema.company.id }).from(schema.company).where(eq(schema.company.id, id))).length === 1;
const cyclesOf = async (id: string) =>
  (await owner.db.select({ id: schema.payrollCycle.id }).from(schema.payrollCycle).where(eq(schema.payrollCycle.companyId, id)))
    .length;
const verdict = async (ctx: SessionContext, id: string) => (await companyDeleteStatus(ctx, id))?.blockedBy ?? null;
/** Run the delete; the refusal reason, or null when it went through. */
async function attempt(ctx: SessionContext, id: string): Promise<CompanyDeleteBlock | null> {
  try {
    await deleteCompany(ctx, { id });
    return null;
  } catch (e) {
    if (e instanceof CompanyInUseError) return e.reason;
    throw e;
  }
}
async function newPerson() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Fixture Person', primaryEmail: `p_${randomUUID().slice(0, 8)}@t.local` })
    .returning({ id: schema.person.id });
  return p.id;
}
async function usage(companyId: string, counts: { e?: number; u?: number; p?: number }, daysAgo: number) {
  await owner.db.insert(schema.usageSnapshot).values({
    tenantId: b.tenantId,
    companyId,
    capturedOn: sql`current_date - ${daysAgo}::int` as never,
    activeEmployments: counts.e ?? 0,
    activeUsers: counts.u ?? 0,
    payslipsGenerated: counts.p ?? 0,
  });
}
const usageRows = async (id: string) =>
  (await owner.db.select({ id: schema.usageSnapshot.id }).from(schema.usageSnapshot).where(eq(schema.usageSnapshot.companyId, id)))
    .length;

/** The live foreign keys, read the way Postgres stores them: one row per (constraint, referencing column). */
async function liveFks(): Promise<{ table: string; column: string; references: string; refColumn: string; onDelete: string; conname: string }[]> {
  return (await owner.db.execute(sql`
    select src.relname as "table", a.attname as "column", dst.relname as "references", fa.attname as "refColumn",
           c.confdeltype::text as "onDelete", c.conname as "conname"
      from pg_constraint c
      join pg_class src on src.oid = c.conrelid
      join pg_class dst on dst.oid = c.confrelid
      join pg_namespace n on n.oid = dst.relnamespace and n.nspname = 'public'
      join lateral unnest(c.conkey, c.confkey) as k(s, d) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.s
      join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = k.d
     where c.contype = 'f'
  `)) as unknown as { table: string; column: string; references: string; refColumn: string; onDelete: string; conname: string }[];
}

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 the declared referrer set is the live schema', () => {
  it('declares EXACTLY the columns the database points at company.id', async () => {
    const fks = await liveFks();
    const live = [...new Set(fks.filter((f) => f.references === 'company' && f.refColumn === 'id').map((f) => `${f.table}.${f.column}`))].sort();
    const declared = COMPANY_REFERRERS.map((r) => `${r.table}.${r.column}`).sort();
    // Missing => a delete that fails at the last moment with a raw 23503 (the reported fault).
    // Extra   => a cascade aimed at a table that no longer references a company.
    expect(declared, 'core/company-refs.ts must declare every FK to company.id, and no others').toEqual(live);
    expect(live.length, 'non-vacuity: the schema has dozens of them').toBeGreaterThan(40);
  });

  it('every foreign-key constraint to company is accounted for, composite (tenant_id, company_id) keys included', async () => {
    const fks = (await liveFks()).filter((f) => f.references === 'company');
    const byConstraint = new Map<string, typeof fks>();
    for (const f of fks) byConstraint.set(`${f.table}/${f.conname}`, [...(byConstraint.get(`${f.table}/${f.conname}`) ?? []), f]);
    const declared = new Set(COMPANY_REFERRERS.map((r) => `${r.table}.${r.column}`));
    for (const [name, cols] of byConstraint) {
      const idCols = cols.filter((c) => c.refColumn === 'id');
      expect(idCols, `${name} must reference company.id through exactly one column`).toHaveLength(1);
      expect(declared.has(`${idCols[0].table}.${idCols[0].column}`), name).toBe(true);
      // The other half of a composite key is only ever the tenant: it carries no disposition of its own.
      for (const other of cols.filter((c) => c.refColumn !== 'id')) expect(other.refColumn, name).toBe('tenant_id');
    }
  });

  it('declares EXACTLY the foreign keys INTO the tables deleted with a company', async () => {
    const cascaded = new Set(cascadedReferrers().map((r) => r.table));
    const live = [
      ...new Set(
        (await liveFks())
          .filter((f) => cascaded.has(f.references) && f.refColumn === 'id')
          .map((f) => `${f.table}.${f.column} -> ${f.references}`),
      ),
    ].sort();
    const declared = COMPANY_CONFIG_DEPENDENTS.map((d) => `${d.table}.${d.column} -> ${d.references}`).sort();
    expect(declared, 'core/company-refs.ts COMPANY_CONFIG_DEPENDENTS must match the live keys').toEqual(live);
  });

  it('every dependent points INTO a table deleted with the company (the generated SQL joins on it)', () => {
    const cascaded = new Set(cascadedReferrers().map((r) => r.table));
    for (const d of COMPANY_CONFIG_DEPENDENTS) expect(cascaded.has(d.references), `${d.table}.${d.column} -> ${d.references}`).toBe(true);
  });

  it('a part is an ON DELETE CASCADE child, and nothing references a part', async () => {
    const fks = await liveFks();
    for (const d of COMPANY_CONFIG_DEPENDENTS.filter((x) => x.effect === 'part')) {
      const fk = fks.find((f) => f.table === d.table && f.column === d.column && f.references === d.references);
      expect(fk?.onDelete, `${d.table}.${d.column} must cascade to be a part`).toBe('c');
      const third = fks.filter((f) => f.references === d.table && f.refColumn === 'id');
      expect(third.map((f) => `${f.table}.${f.column}`), `${d.table} is deleted by cascade; nothing may hang off it`).toEqual([]);
    }
  });

  it('deletes a child before the parent it references, so no nested foreign key can fire', async () => {
    const order = cascadedReferrers().map((r) => r.table);
    const fks = await liveFks();
    for (const d of COMPANY_CONFIG_DEPENDENTS) {
      if (!order.includes(d.table) || d.table === d.references) continue; // a self-reference goes in one statement
      const fk = fks.find((f) => f.table === d.table && f.column === d.column && f.references === d.references);
      if (fk?.onDelete === 'c' || fk?.onDelete === 'n') continue;
      expect(order.indexOf(d.table), `${d.table} must be deleted before ${d.references}`).toBeLessThan(order.indexOf(d.references));
    }
  });

  it('gives every referrer a disposition and a reason', () => {
    for (const r of COMPANY_REFERRERS) {
      expect(['employees', 'payroll', 'other', 'config', 'config-if-unreferenced'], `${r.table}.${r.column}`).toContain(r.disposition);
      expect(r.note.length, `${r.table} must say WHY`).toBeGreaterThan(20);
    }
    for (const d of COMPANY_CONFIG_DEPENDENTS) expect(d.note.length, `${d.table}.${d.column}`).toBeGreaterThan(20);
  });

  it('never cascades an employee record or a payroll record', () => {
    const cascaded = cascadedReferrers().map((r) => r.table);
    for (const t of ['employment', 'assignment', 'employee_draft', 'payroll_batch', 'pay_period', 'pcb_payment', 'statutory_report', 'back_pay_run']) {
      expect(cascaded, `${t} must never be cascaded`).not.toContain(t);
    }
  });

  it('cascades exactly what ABC Comapny carried: payroll cycles, TOIL policy, payslip setting, zero usage records', () => {
    const cascaded = cascadedReferrers().map((r) => r.table);
    for (const t of ['payroll_cycle', 'toil_policy', 'payslip_information_setting', 'usage_snapshot']) expect(cascaded).toContain(t);
  });

  it('the panel and the delete run the same generated SQL, and it names every refusing table', () => {
    const text = companyDeleteBlockSqlText('company.id');
    // A referrer's own test reads `from "<table>" crN where crN."<column>" = company.id`. (A cascaded table
    // can still appear as a DEPENDENT — `from "<table>" cdN join …` — when it points at another cascaded
    // table; that is the second-level check, not a refusal of the table's own rows.)
    const ownTest = (r: { table: string; column: string }) =>
      new RegExp(`from "${r.table}" cr\\d+ where cr\\d+\\."${r.column}" = company\\.id\\)`);
    for (const r of COMPANY_REFERRERS.filter((x) => x.disposition === 'employees' || x.disposition === 'payroll' || x.disposition === 'other')) {
      expect(text, r.table).toMatch(ownTest(r));
    }
    for (const r of cascadedReferrers().filter((x) => !x.refuseWhere)) {
      expect(text, `${r.table} is setup and its rows must NOT refuse`).not.toMatch(ownTest(r));
    }
    const src = (f: string) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');
    expect(src('core/read.ts')).toContain("companyDeleteBlockSqlText('company.id')");
    expect(src('core/admin.ts')).toContain("companyDeleteBlockSqlText('company.id')");
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
type Case = { name: string; expected: CompanyDeleteBlock | null; setup: (id: string) => Promise<void> };
const CASES: Case[] = [
  { name: 'never used: only its automatic setup', expected: null, setup: async () => {} },
  {
    name: 'a terminated employment',
    expected: 'employees',
    setup: async (id) => {
      await owner.db.insert(schema.employment).values({
        tenantId: b.tenantId,
        personId: await newPerson(),
        companyId: id,
        hiredOn: '2025-01-01',
        terminatedOn: '2025-06-30',
      });
    },
  },
  {
    name: 'an unfinished draft employee',
    expected: 'employees',
    setup: async (id) => {
      await owner.db.insert(schema.employeeDraft).values({ tenantId: b.tenantId, companyId: id, label: 'Draft', data: {} });
    },
  },
  {
    name: 'a payroll period',
    expected: 'payroll',
    setup: async (id) => {
      await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId: id, period: '2026-01' });
    },
  },
  {
    name: 'a payroll run',
    expected: 'payroll',
    setup: async (id) => {
      const [pp] = await owner.db
        .insert(schema.payPeriod)
        .values({ tenantId: b.tenantId, companyId: id, period: '2026-02' })
        .returning({ id: schema.payPeriod.id });
      await owner.db
        .insert(schema.payrollBatch)
        .values({ tenantId: b.tenantId, companyId: id, payPeriod: '2026-02', batchDate: '2026-02-28', payPeriodId: pp.id } as never);
    },
  },
  { name: 'a usage record with employments on it', expected: 'employees', setup: (id) => usage(id, { e: 3, u: 2 }, 1) },
  { name: 'a usage record with payslips on it', expected: 'payroll', setup: (id) => usage(id, { p: 4 }, 1) },
  { name: 'only all-zero usage records', expected: null, setup: (id) => usage(id, {}, 1) },
  {
    name: 'a sub-company',
    expected: 'other',
    setup: async (id) => {
      await bare({ parentCompanyId: id });
    },
  },
  {
    name: 'a user given access to it',
    expected: 'other',
    setup: async (id) => {
      await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: b.adminUserId, companyId: id, role: 'hr_admin' });
    },
  },
  {
    name: 'its department named by ANOTHER company\'s leave approval rule (a shared department)',
    expected: 'other',
    setup: async (id) => {
      const [d] = await owner.db
        .insert(schema.department)
        .values({ tenantId: b.tenantId, companyId: id, name: 'Shared Dept' })
        .returning({ id: schema.department.id });
      await owner.db.insert(schema.leaveApprovalPolicy).values({ tenantId: b.tenantId, companyId: b.companyId, departmentId: d.id });
    },
  },
  {
    name: 'its location used by a clocking geofence (a shared location)',
    expected: 'other',
    setup: async (id) => {
      const [l] = await owner.db
        .insert(schema.location)
        .values({ tenantId: b.tenantId, companyId: id, code: 'LOC1', name: 'Shared Site' })
        .returning({ id: schema.location.id });
      await owner.db.insert(schema.clockingLocation).values({ tenantId: b.tenantId, name: 'Gate', lat: 3.1, lng: 101.6, locationId: l.id } as never);
    },
  },
  {
    name: 'its own org structure, used by nothing outside it (and its own approval rule naming its department)',
    expected: null,
    setup: async (id) => {
      const [bu] = await owner.db
        .insert(schema.businessUnit)
        .values({ tenantId: b.tenantId, companyId: id, code: 'BU1', name: 'Unit' })
        .returning({ id: schema.businessUnit.id });
      const [d] = await owner.db
        .insert(schema.department)
        .values({ tenantId: b.tenantId, companyId: id, name: 'Own Dept', businessUnitId: bu.id } as never)
        .returning({ id: schema.department.id });
      await owner.db.insert(schema.position).values({ tenantId: b.tenantId, companyId: id, title: 'Own Role' });
      await owner.db.insert(schema.costCenter).values({ tenantId: b.tenantId, companyId: id, code: 'OWN', name: 'Own CC' });
      await owner.db.insert(schema.location).values({ tenantId: b.tenantId, companyId: id, code: 'OWN', name: 'Own Site' });
      await owner.db.insert(schema.leaveApprovalPolicy).values({ tenantId: b.tenantId, companyId: id, departmentId: d.id });
    },
  },
];

describe('§2 the panel and the delete guard give the same answer, for every disposition', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expected ?? 'deletable'}`, async () => {
      const id = await fresh();
      await c.setup(id);
      const status = await companyDeleteStatus(ADMIN(), id);
      expect(status?.canDelete).toBe(true);
      expect(status?.blockedBy ?? null, 'what the panel shows').toBe(c.expected);
      expect(await attempt(ADMIN(), id), 'what the delete does').toBe(c.expected);
      if (c.expected) {
        // A refusal deletes NOTHING — not even the setup, which goes in the same transaction or not at all.
        expect(await exists(id)).toBe(true);
        expect(await cyclesOf(id)).toBeGreaterThan(0);
      } else {
        expect(await exists(id)).toBe(false);
        expect(await cyclesOf(id)).toBe(0);
      }
    });
  }

  it('the org structure goes with the company when nothing outside uses it', async () => {
    const id = await fresh();
    await CASES.at(-1)!.setup(id);
    await deleteCompany(ADMIN(), { id });
    for (const t of [schema.department, schema.position, schema.costCenter, schema.location, schema.businessUnit, schema.leaveApprovalPolicy]) {
      expect(await owner.db.select().from(t).where(eq(t.companyId, id)), 'cascaded').toHaveLength(0);
    }
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 an unused company created on the Organization screen deletes cleanly', () => {
  it('row, payroll cycles and zero usage records go; company.created and company.deleted stay, with what it was', async () => {
    const id = await fresh('ABC Comapny');
    expect(await cyclesOf(id), 'createCompany seeded the automatic setup').toBeGreaterThan(0);
    await usage(id, {}, 2);
    await usage(id, {}, 1);

    await deleteCompany(ADMIN(), { id });

    expect(await exists(id)).toBe(false);
    expect(await cyclesOf(id)).toBe(0);
    expect(await usageRows(id)).toBe(0);
    const events = await owner.db
      .select({ type: schema.domainEvent.eventType, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateType, 'company'), eq(schema.domainEvent.aggregateId, id)))
      .orderBy(schema.domainEvent.occurredAt);
    expect(events.map((e) => e.type)).toEqual(['company.created', 'company.deleted']);
    expect(events[1].payload).toEqual({
      legalName: 'ABC Comapny',
      code: 'UNUSED',
      registrationNo: '202601009999',
      usageSnapshotRows: 2,
    });
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§4 only an administrator for the company can delete it', () => {
  it('a member session is turned away by requireAdmin before anything runs', async () => {
    const id = await fresh();
    SESSION = member();
    await expect(deleteCompanyAction(fdOf({ id }))).rejects.toMatchObject({ path: '/' });
    expect(await exists(id)).toBe(true);
  });

  it('company A\'s admin cannot delete company B through the service', async () => {
    const companyB = await bare();
    expect((await companyDeleteStatus(scopedAdmin(b.companyId), companyB))?.canDelete).toBe(false);
    await expect(deleteCompany(scopedAdmin(b.companyId), { id: companyB })).rejects.toBeInstanceOf(CompanyDeleteForbiddenError);
    await expect(deleteCompany(member(), { id: companyB })).rejects.toBeInstanceOf(CompanyDeleteForbiddenError);
    expect(await exists(companyB)).toBe(true);
  });

  it('the database refuses it even when the service check is bypassed (migration 0511)', async () => {
    const companyB = await bare();
    const rawDelete = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.execute(sql`delete from company where id = ${companyB}::uuid returning id`));
    expect(await rawDelete(scopedAdmin(b.companyId)), "company A's admin").toHaveLength(0);
    expect(await rawDelete(member()), 'a member').toHaveLength(0);
    expect(await exists(companyB)).toBe(true);
    // The control: the same statement from an administrator of B removes it, so it was the policy that held.
    expect(await rawDelete(scopedAdmin(companyB)), "B's own admin").toHaveLength(1);
    expect(await exists(companyB)).toBe(false);
  });

  it('a sub-company is deleted by its parent\'s administrator, not by its own', async () => {
    const child = await bare({ parentCompanyId: b.companyId });
    await expect(deleteCompany(scopedAdmin(child), { id: child })).rejects.toBeInstanceOf(CompanyDeleteForbiddenError);
    expect(await exists(child)).toBe(true);
    await deleteCompany(scopedAdmin(b.companyId), { id: child });
    expect(await exists(child)).toBe(false);
  });

  it('usage records stay unwritable by the app role; only 0511\'s function removes them, zero rows only, for an authorised caller', async () => {
    const companyB = await bare();
    await usage(companyB, {}, 1);
    await usage(companyB, { e: 1 }, 2);
    // The table privilege is untouched (0313, test/module-entitlement-rls): even a group admin cannot DELETE.
    expect(
      await sqlStateOf(
        withTenant(ADMIN(), (tx) => tx.execute(sql`delete from usage_snapshot where company_id = ${companyB}::uuid`)),
      ),
    ).toBe('42501');
    const viaFunction = (ctx: SessionContext) =>
      withTenant(ctx, async (tx) => {
        const [r] = (await tx.execute(sql`select app.delete_unused_usage_snapshots(${companyB}::uuid) as n`)) as unknown as { n: number }[];
        return Number(r.n);
      });
    expect(await sqlStateOf(viaFunction(scopedAdmin(b.companyId))), "company A's admin, B's records").toBe('42501');
    expect(await sqlStateOf(viaFunction(member())), 'a member').toBe('42501');
    expect(await usageRows(companyB)).toBe(2);
    expect(await viaFunction(ADMIN()), 'the control: an authorised caller removes the zero row only').toBe(1);
    expect(await usageRows(companyB), 'the row with usage in it survives').toBe(1);
  });

  it('the function is SECURITY DEFINER with a pinned search_path, and only the app role may execute it', async () => {
    const fns = [...new Set(COMPANY_REFERRERS.flatMap((r) => (r.deleteFunction ? [r.deleteFunction] : [])))];
    expect(fns).toEqual(['app.delete_unused_usage_snapshots']);
    const rows = (await owner.db.execute(sql`
      select p.prosecdef, p.proconfig,
             has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') as app_exec,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'delete_unused_usage_snapshots'
    `)) as unknown as { prosecdef: boolean; proconfig: string[]; app_exec: boolean; public_exec: boolean }[];
    expect(rows).toEqual([
      { prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], app_exec: true, public_exec: false },
    ]);
  });
});

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────────────
function fdOf(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function redirectOf(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return new URL(e.path, 'http://x');
    throw e;
  }
  throw new Error('expected a redirect');
}

describe('§5 the action answers every refusal in words, never with the driver message', () => {
  const refusalSetups: Record<CompanyDeleteBlock, (id: string) => Promise<void>> = {
    employees: CASES[1].setup,
    payroll: CASES[3].setup,
    other: CASES[8].setup,
  };
  for (const reason of COMPANY_DELETE_BLOCKS) {
    it(`${reason}: returns to the company with the ${reason} sentence`, async () => {
      const id = await fresh();
      await refusalSetups[reason](id);
      const to = await redirectOf(() => deleteCompanyAction(fdOf({ id, tab: 'general' })));
      expect(to.pathname).toBe(`/admin/organization/${id}`);
      expect(to.searchParams.get('error')).toBe(ORG_EN[COMPANY_DELETE_REFUSAL_KEY[reason]]);
      expect(to.searchParams.get('error')).not.toMatch(/Failed query|select |delete from/i);
    });
  }

  it('success returns to the list with "Company deleted successfully."', async () => {
    const id = await fresh();
    const to = await redirectOf(() => deleteCompanyAction(fdOf({ id })));
    expect(to.pathname).toBe('/admin/organization');
    expect(to.searchParams.get('toast')).toBe('Company deleted successfully.');
  });

  it('an administrator of another company is told they may not, in words', async () => {
    const companyB = await bare();
    SESSION = scopedAdmin(b.companyId);
    const to = await redirectOf(() => deleteCompanyAction(fdOf({ id: companyB })));
    expect(to.searchParams.get('error')).toBe(ORG_EN.deleteForbidden);
    expect(await exists(companyB)).toBe(true);
  });

  it('an unexpected database error becomes the plain sentence with a reference, never SQL', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const to = await redirectOf(() => deleteCompanyAction(fdOf({ id: 'not-a-uuid' })));
      const error = to.searchParams.get('error') ?? '';
      expect(error).toMatch(/Reference /);
      expect(error).not.toMatch(/Failed query|select |company_label|not-a-uuid/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('every new sentence exists in all six locales', () => {
    const keys = ['deleteRefusedTitle', ...Object.values(COMPANY_DELETE_REFUSAL_KEY), 'archiveInstead', 'close', 'deleteForbidden', 'deleteNotFound', 'deletedToast', 'deleteCompanyTitle', 'deleteCompanyDescription'];
    for (const l of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const org = messagesFor(l).admin.organization as Record<string, string>;
      for (const k of keys) expect(org[k]?.trim(), `${l} admin.organization.${k}`).toBeTruthy();
    }
    expect(ORG_EN.deleteCompanyTitle).toBe('Delete Company?');
    expect(ORG_EN.deleteCompanyDescription).toBe(
      'This company has no employee or payroll records. Are you sure you want to delete this company?',
    );
    expect(ORG_EN.deleteRefusedEmployees.startsWith('This company cannot be deleted because employee records have been created under this company.')).toBe(true);
    expect(ORG_EN.deleteRefusedPayroll.startsWith('This company cannot be deleted because payroll records exist for this company.')).toBe(true);
  });
});
