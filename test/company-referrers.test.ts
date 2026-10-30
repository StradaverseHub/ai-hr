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
import type { SessionContext,Tx } from '../db/client';

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
import { defaultPolicy } from '../packs/rewards/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { withTenant } from '../db/client';
import { hireEmployee,transferEmploymentCompanyTx } from '../core/org';
import * as costAllocations from '../core/employment-cost-allocations';
import {costAllocationMaintenanceReviews} from '../core/assistant-actions/cost-allocation-maintenance-review-store';
import {grantAssistant} from '../core/assistant-grant';
import { createMovementEvent } from '../core/movement';
import {setCompensation} from '../core/comp';
import {savePayFormula,testPayFormula,setPayFormulaActive,loadActiveFormulaProgramTx,recordFormulaEvaluationTx,getPayFormula,getFormulaEvaluation} from '../core/pay-formula';
import {seedPayComponentCatalog,createBatch,deleteDraftBatch} from '../packs/payroll/service';
import { saveReplacementHolidayPolicy } from '../core/holiday-replacements';
import { saveOvertimePatternDraft } from '../packs/attendance/service';
import { adminCtx, entitledCtx, setModule, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
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
  createDepartment,
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
    const declared = COMPANY_CONFIG_DEPENDENTS.filter(d=>d.referenceKind!=='uuid-array').map((d) => `${d.table}.${d.column} -> ${d.references}`).sort();
    expect(declared, 'core/company-refs.ts COMPANY_CONFIG_DEPENDENTS must match the live keys').toEqual(live);
  });

  it('a retained array declaration names a real UUID array and its owner enforces retention',async()=>{
    const arrays=COMPANY_CONFIG_DEPENDENTS.filter(d=>d.referenceKind==='uuid-array');
    expect(arrays.map(d=>`${d.table}.${d.column} -> ${d.references}`)).toContain('attendance_rotation.allowed_shift_ids -> shift');
    for(const d of arrays){
      const rows=await owner.db.execute(sql`select udt_name from information_schema.columns where table_schema='public' and table_name=${d.table} and column_name=${d.column}`) as unknown as {udt_name:string}[];
      expect(rows,`${d.table}.${d.column} must be a real UUID array, not a hidden foreign key`).toEqual([{udt_name:'_uuid'}]);
      expect(d.effect).toBe('blocks');
    }
    const migration=readFileSync(fileURLToPath(new URL('../db/migrations/0531_attendance_rotation.sql',import.meta.url)),'utf8');
    expect(migration).toContain('BEFORE DELETE ON shift');
    expect(migration).toContain('OLD.id=ANY(allowed_shift_ids)');
    expect(companyDeleteBlockSqlText('company.id')).toMatch(/join "shift" co\d+ on co\d+\.id = ANY\(cd\d+\."allowed_shift_ids"\)/);
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

  it('retains Attendance workflow history while deleting only unused enablement configuration', () => {
    const expected = [
      ['attendance_workflow_template', 'other'],
      ['attendance_workflow_setting', 'config'],
      ['attendance_workflow_request', 'employees'],
    ];
    for (const [table, disposition] of expected) {
      expect(COMPANY_REFERRERS.filter(r => r.table === table).map(r => [r.column,r.disposition])).toEqual([['company_id',disposition]]);
    }
  });

  it('never cascades an employee record or a payroll record', () => {
    const cascaded = cascadedReferrers().map((r) => r.table);
    for (const t of ['employment', 'assignment', 'employee_draft', 'payroll_batch', 'pay_period', 'pcb_payment', 'statutory_report', 'back_pay_run', 'pay_formula_test', 'pay_formula_evaluation']) {
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
      if (r.existsFunction) expect(text, r.table).toContain(`${r.existsFunction}(company.id)`);
      else expect(text, r.table).toMatch(ownTest(r));
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
  { name: 'a published replacement holiday policy', expected: 'other', setup: async id => {
    await saveReplacementHolidayPolicy(ADMIN(), { companyId: id, effectiveFrom: todayInKualaLumpur(),
      regime: 'company_confirmed', confirmed: true, restMode: 'scheduled_rest', halfEligible: false,
      searchDays: 30, reason: 'Fictional retained company policy.' });
  } },
  ...(['origin', 'scope'] as const).map(kind => ({ name: `retained overtime ${kind} company`, expected: 'payroll' as const, setup: async (id: string) => {
    await saveOvertimePatternDraft(ADMIN(), { draft: { code: 'RET_' + randomUUID().slice(0, 8),
      creationCompanyId: kind === 'origin' ? id : b.companyId, companyIds: [id], name: 'Retained draft',
      definition: { v: 1, currency: { code: 'MYR', minorScale: 2 }, definitions: [], eligibilityBasis: 'day',
        durationAllocation: 'earliest', eligibility: { id: 'eligible', type: 'constant', value: false },
        eligibleMinutes: null, durationCap: null, durationRounding: null, deductions: [], rates: [],
        paymentCap: null, moneyRounding: { stage: 'dayMapping', mode: 'halfUp' } } } });
  } })),
  {name:'a dated attendance correction retains company-owned shift history',expected:'other',setup:async(id)=>{
    const personId=await newPerson();
    const [employment]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId,companyId:b.companyId,hiredOn:'2020-01-01'}).returning();
    const [shift]=await owner.db.insert(schema.shift).values({tenantId:b.tenantId,companyId:id,name:'Retained date-only shift',startTime:'08:00',endTime:'17:00'}).returning();
    await owner.db.insert(schema.attendanceDayAdjustment).values({tenantId:b.tenantId,employmentId:employment.id,attendanceDate:todayInKualaLumpur(),shiftId:shift.id,reason:'Retain the correction basis',updatedBy:b.adminUserId});
  }},
  ...(['rule','shift'] as const).map(source=>({
    name:`retained schedule rotation ${source}`,expected:'other' as const,setup:async(id:string)=>{
      // This is a retained legacy company-owned group; current creation UI creates global groups.
      // Supply the real admin transaction so its immutable overtime snapshot owner has authority.
      const [rule]=await withTenant(ADMIN(),tx=>tx.insert(schema.attendanceRule).values({tenantId:b.tenantId,companyId:source==='rule'?id:null,name:`Rotation ${source} ${randomUUID()}`}).returning());
      const [shift]=await owner.db.insert(schema.shift).values({tenantId:b.tenantId,companyId:source==='shift'?id:null,name:`Rotation source ${randomUUID()}`,startTime:'08:00',endTime:'17:00'}).returning();
      const date=new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
      await owner.db.insert(schema.attendanceRotation).values({tenantId:b.tenantId,ruleId:rule.id,effectiveFrom:date,anchorDate:date,unit:'day',length:1,allowedShiftIds:[shift.id],days:[{kind:'full',shiftId:shift.id}],createdBy:b.adminUserId});
    }
  })),
  {
    name: 'an unposted reward review', expected: 'payroll', setup: async (id) => {
      const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
      const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: id, code: 'REWARD', name: 'Rewards unit' }).returning();
      // Minimal fictional People rows satisfy the real creation guard. No payroll/allocation
      // history is authored here: this case isolates retention by the review itself.
      const [department]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:id,name:'Review prerequisite'}).returning();
      const [member]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,companyId:id,personId:await newPerson(),hiredOn:'2020-01-01'}).returning();
      await owner.db.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:member.id,companyId:id,departmentId:department.id,businessUnitId:bu.id,employmentType:'full_time',validFrom:'2020-01-01'});
      const [cycle] = await owner.db.insert(schema.rewardCycle).values({ tenantId: b.tenantId, name: 'Annual rewards', year, createdBy: b.adminUserId }).returning();
      await withTenant(ADMIN(),tx=>tx.insert(schema.rewardUnit).values({ tenantId: b.tenantId, createdBy: b.adminUserId, cycleId: cycle.id, companyId: id, businessUnitId: bu.id, policy: defaultPolicy(year), snapshotDate: today }));
      // Retained review after the fictional subject moves away: isolate the financial retention
      // guard without an employment/assignment still pointing at the old company. No guard is disabled.
      await owner.db.update(schema.employment).set({companyId:b.companyId}).where(eq(schema.employment.id,member.id));
      await owner.db.update(schema.assignment).set({companyId:b.companyId,departmentId:b.deptA,businessUnitId:null}).where(eq(schema.assignment.employmentId,member.id));
    },
  },
  {
    name: 'retained manual account enrollment', expected: 'other', setup: async (id) => {
      const personId=await newPerson();
      await owner.client`insert into app_manual_identity_enrollment(id,tenant_id,person_id,created_by,issuer,username,email,role,company_id)
        values(${randomUUID()}::uuid,${b.tenantId}::uuid,${personId}::uuid,${b.adminUserId}::uuid,'https://identity.test/realms/hr','company-test','company-test@example.test','employee',${id}::uuid)`;
    },
  },
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
    // r423 (migration 0517) — clocking_location_company is `config`: a company deleted (it has no employees,
    // or the employees disposition refuses first) stops being one the location is open to. The LINK goes;
    // the shared location, open to another company too, stays.
    name: 'a shared clocking location is open to it (r423: the link goes with it, the location stays)',
    expected: null,
    setup: async (id) => {
      const [cl] = await owner.db
        .insert(schema.clockingLocation)
        .values({ tenantId: b.tenantId, name: 'Open Gate', lat: 3.1, lng: 101.6, radiusM: 100 })
        .returning({ id: schema.clockingLocation.id });
      await owner.db.insert(schema.clockingLocationCompany).values([
        { tenantId: b.tenantId, clockingLocationId: cl.id, companyId: id },
        { tenantId: b.tenantId, clockingLocationId: cl.id, companyId: b.companyId },
      ]);
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

describe('Formula evidence retains a company independently of its current employees and runs',()=>{
  it.each([['test',true],['test',false],['evaluation',true]] as const)('refuses native company deletion for retained formula %s (passed=%s), including hidden receipts',async(kind,passed)=>{
    await setModule(b.tenantId,'typed_pay_components','active');
    const ctx=await entitledCtx(b),target=await fresh('Retained Formula paying company');
    await seedPayComponentCatalog(ctx);
    const [department]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:target,name:'Fictional former assignment'}).returning();
    // Evaluation activates a test for the other company so its retained target-company evaluation
    // is the ONLY payroll referrer. The test-only case has no payroll run or evaluation at all.
    const testCompany=kind==='test'?target:b.companyId;
    const employee=await hireEmployee(ctx,{person:{fullName:'Fictional retained Formula subject',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
    await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:3000,effectiveFrom:'2026-01-01'});
    // Start under the other employer so the hire's separate tax-selection owner does not itself
    // retain target. Fixture the dated target assignment for the actual saved native test.
    if(kind==='test'){
      await owner.db.update(schema.employment).set({companyId:target}).where(eq(schema.employment.id,employee.employmentId));
      await owner.db.update(schema.assignment).set({companyId:target,departmentId:department.id}).where(eq(schema.assignment.employmentId,employee.employmentId));
    }
    const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:b.tenantId,companyId:testCompany,name:'Fictional Formula test cycle',code:'FORMULA_RETENTION',runType:'regular'}).returning();
    const privateValue='Fictional private retained nationality';
    await owner.db.update(schema.person).set({nationality:privateValue}).where(eq(schema.person.id,employee.personId));
    const saved=await savePayFormula(ctx,{formulaId:'RETAINED_COMPANY',description:'Retained native calculation evidence',method:'write',source:'{#Explain}({#EmployeeInformation}("nationality"))\n'+(passed?'Return 1':'Return 100 / {#Input}')});
    const tested=await testPayFormula(ctx,{...saved,context:{companyId:testCompany,employmentId:employee.employmentId,period:'2026-05',asOf:'2026-05-31',cycleId:cycle.id,currentCode:'OVERTIME',input:'0'}});
    expect(tested.passed,tested.error??'saved native result').toBe(passed);
    if(passed){expect(tested.amount).toBe('1');expect(tested.explanations).toContain(privateValue);}
    else{expect(tested.error).toMatch(/division by zero/i);expect(tested.amount).toBeNull();}
    expect(tested.readRequirements.categories).toContain('identity');
    let evaluationId:string|undefined;
    if(kind==='evaluation'){
      await setPayFormulaActive(ctx,{...saved,testId:tested.id,active:true});
      await owner.db.update(schema.employment).set({companyId:target}).where(eq(schema.employment.id,employee.employmentId));
      await owner.db.update(schema.assignment).set({companyId:target,departmentId:department.id}).where(eq(schema.assignment.employmentId,employee.employmentId));
      const {batchId}=await createBatch(ctx,{companyId:target,payPeriod:'2026-05'});
      // Exercise the real protected evaluation writer/identity trigger, not an owner INSERT or
      // disabled RLS. Its exact constant amount comes from the saved successful native test.
      await withTenant(ctx,async tx=>{
        const formula=await loadActiveFormulaProgramTx(tx,ctx,'RETAINED_COMPANY');
        evaluationId=await recordFormulaEvaluationTx(tx,ctx,{formula,employmentId:employee.employmentId,companyId:target,batchId,componentCode:'OVERTIME',period:'2026-05',amount:tested.amount!,explanations:tested.explanations,reads:[],sources:[],readRequirements:tested.readRequirements});
      });
      // Canonical draft deletion deliberately retains immutable evaluation evidence without a batch FK.
      await deleteDraftBatch(ctx,{batchId});
    }
    // Fixture a later transfer without erasing or editing any retained Formula receipt. This isolates
    // the historical financial blocker from the existing employment/assignment deletion blockers.
    await owner.db.update(schema.employment).set({companyId:b.companyId}).where(eq(schema.employment.id,employee.employmentId));
    await owner.db.update(schema.assignment).set({companyId:b.companyId,departmentId:b.deptA}).where(eq(schema.assignment.employmentId,employee.employmentId));
    expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.companyId,target))).toHaveLength(0);
    expect(await owner.db.select().from(schema.assignment).where(eq(schema.assignment.companyId,target))).toHaveLength(0);
    expect(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.companyId,target))).toHaveLength(0);
    expect(await owner.db.select().from(schema.payPeriod).where(eq(schema.payPeriod.companyId,target))).toHaveLength(0);
    expect(await owner.db.select().from(schema.employmentTaxSelectionMy).where(eq(schema.employmentTaxSelectionMy.companyId,target))).toHaveLength(0);
    const evidence=async()=>kind==='test'
      ? owner.db.select().from(schema.payFormulaTest).where(eq(schema.payFormulaTest.companyId,target))
      : owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.companyId,target));
    const before=await evidence();expect(before).toHaveLength(1);
    const other=kind==='test'
      ? await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.companyId,target))
      : await owner.db.select().from(schema.payFormulaTest).where(eq(schema.payFormulaTest.companyId,target));
    expect(other).toHaveLength(0);
    expect(await verdict(ctx,target),'panel must report financial history rather than unused setup').toBe('payroll');
    expect(await attempt(ctx,target),'native delete must refuse before FK/immutable-trigger errors').toBe('payroll');
    expect(await exists(target)).toBe(true);expect(await evidence()).toEqual(before);
    const retention=async(actor:SessionContext,wanted:string|null)=>withTenant(actor,async tx=>{
      const [row]=await tx.execute<{retained:boolean}>(sql`select app.pay_formula_company_in_use(${wanted}::uuid) as retained`);
      return row.retained;
    });
    expect(await retention(ctx,target)).toBe(true);
    const readPrivate=()=>withTenant(ctx,async tx=>kind==='test'
      ? await tx.select().from(schema.payFormulaTest).where(eq(schema.payFormulaTest.companyId,target))
      : await tx.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.companyId,target)));
    expect(await readPrivate()).toHaveLength(1);
    const readNativeReceipt=async()=>{
      if(kind==='test'){
        const view=await getPayFormula(ctx,saved.id);expect(view).not.toBeNull();
        const matching=view!.tests.filter(receipt=>receipt.id===tested.id);expect(matching).toHaveLength(1);
        const receipt=matching[0];
        expect(receipt).toMatchObject({id:tested.id,revisionId:saved.revisionId,passed,amount:tested.amount,error:tested.error,
          context:tested.context,sourceFingerprint:tested.sourceFingerprint,dependencyFingerprint:tested.dependencyFingerprint,
          readRequirements:tested.readRequirements,explanations:tested.explanations});
        expect(receipt.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.dependencyFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.readRequirements.categories).toContain('identity');
        expect(receipt.readRequirements.fieldIds.length).toBeGreaterThan(0);
        if(passed)expect(receipt.explanations).toContain(privateValue);
        else expect(receipt.error).toMatch(/division by zero/i);
        return receipt;
      }
      const receipt=await getFormulaEvaluation(ctx,evaluationId!);expect(receipt).not.toBeNull();
      expect(receipt).toMatchObject({id:evaluationId,formulaId:'RETAINED_COMPANY',revisionId:saved.revisionId,
        companyId:target,employmentId:employee.employmentId,componentCode:'OVERTIME',period:'2026-05',amount:'1',
        payload:{explanations:tested.explanations,reads:[],sources:[]}});
      expect(receipt!.payload.explanations).toContain(privateValue);
      expect(receipt!.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt!.payload).toMatchObject({contentHash:receipt!.contentHash});
      return receipt;
    };
    const nativeBefore=await readNativeReceipt();
    // Revoke the real private category while retaining current company administration. The actor
    // must demonstrably lose BOTH direct RLS and service trace access, but keep the boolean guard.
    await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:target,role:'hr_admin',permissionKey:'report.read.identity',allowed:false});
    expect(await readPrivate()).toHaveLength(0);
    if(kind==='test')expect((await getPayFormula(ctx,saved.id))?.tests).toEqual([]);
    else expect(await getFormulaEvaluation(ctx,evaluationId!)).toBeNull();
    expect(await retention(ctx,target)).toBe(true);
    expect(await companyDeleteStatus(ctx,target)).toEqual({canDelete:true,blockedBy:'payroll'});
    expect(await attempt(ctx,target)).toBe('payroll');
    expect(await exists(target)).toBe(true);expect(await evidence()).toEqual(before);
    // A read-only snapshot may read this retention fact, but the helper itself has no side effects.
    const [readOnly]=await withTenant(ctx,tx=>tx.execute<{retained:boolean;mode:string}>(sql`select app.pay_formula_company_in_use(${target}::uuid) as retained,current_setting('transaction_read_only') as mode`),{readOnlySnapshot:true});
    expect(readOnly).toEqual({retained:true,mode:'on'});expect(await evidence()).toEqual(before);
    await owner.db.delete(schema.payrollPermissionGrant).where(and(eq(schema.payrollPermissionGrant.companyId,target),eq(schema.payrollPermissionGrant.permissionKey,'report.read.identity')));
    expect(await readPrivate()).toHaveLength(1);expect(await evidence()).toEqual(before);
    expect(await readNativeReceipt(),'native private receipt must return unchanged after scope restoration').toEqual(nativeBefore);

    if(kind==='test'&&passed){
      const user=async(role:'employee'|'payroll_partner'|'hr_admin',companyId:string|null,personId:string|null=null):Promise<SessionContext>=>{
        const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,personId,workosUserId:'retention-'+randomUUID()}).returning();
        await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
        return {tenantId:b.tenantId,userId:u.id,personId:personId??undefined,roles:[role],grants:[{role,companyId}],entitlements:ctx.entitlements};
      };
      const sibling=await bare(),scoped=await user('hr_admin',target),outside=await user('hr_admin',sibling);
      expect(await retention(scoped,target)).toBe(true);expect(await retention(outside,target)).toBe(false);
      await owner.db.update(schema.company).set({parentCompanyId:sibling}).where(eq(schema.company.id,target));
      expect(await retention(outside,target),'existing ancestor grant covers its descendant').toBe(true);
      await owner.db.update(schema.company).set({parentCompanyId:null}).where(eq(schema.company.id,target));
      expect(await retention(outside,target)).toBe(false);
      const foreign=await seedBase();expect(await retention(adminCtx(foreign),target)).toBe(false);
      expect(await retention(ctx,foreign.companyId)).toBe(false);
      expect(await retention(ctx,null)).toBe(false);expect(await retention(ctx,randomUUID())).toBe(false);
      for(const role of ['employee','payroll_partner'] as const){
        const actor=await user(role,target);expect(await retention(actor,target)).toBe(false);
        await expect(deleteCompany(actor,{id:target})).rejects.toBeInstanceOf(CompanyDeleteForbiddenError);
      }
      const claimed={...outside,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:target}]};
      expect(await withTenant(claimed,async tx=>{const [r]=await tx.execute<{fresh:boolean}>(sql`select app.principal_snapshot_current() as fresh`);return r.fresh;})).toBe(false);
      expect(await retention(claimed,target)).toBe(false);
      await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,scoped.userId!));
      expect(await retention(scoped,target),'revoked admin grant cannot be replayed').toBe(false);
      const archived=await user('hr_admin',target);
      await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,archived.userId!));
      expect(await retention(archived,target)).toBe(false);
      const blocked=await user('hr_admin',target,employee.personId);
      await owner.db.update(schema.employment).set({blacklistedAt:todayInKualaLumpur()}).where(eq(schema.employment.id,employee.employmentId));
      expect(await withTenant(blocked,async tx=>{const [r]=await tx.execute<{blocked:boolean}>(sql`select app.login_blocked(${blocked.userId!}::uuid) as blocked`);return r.blocked;})).toBe(true);
      expect(await retention(blocked,target)).toBe(false);
      expect(await retention({...ctx,userId:undefined,roles:[],grants:[]},target)).toBe(false);
      expect(await retention({...ctx,userId:randomUUID()},target)).toBe(false);
      const [agent]=await owner.db.execute<{id:string}>(sql`insert into app.ai_agent_principal(tenant_id) values(${b.tenantId}::uuid) on conflict(tenant_id) do update set tenant_id=excluded.tenant_id returning id`);
      const agentCtx:SessionContext={tenantId:b.tenantId,roles:[],grants:[],agent:{principalId:agent.id,enablements:[]},entitlements:ctx.entitlements};
      expect(await withTenant(agentCtx,async tx=>{const [r]=await tx.execute<{id:string|null}>(sql`select app.current_agent_principal() as id`);return r.id;})).toBe(agent.id);
      expect(await retention(agentCtx,target)).toBe(false);
      expect(await withTenant(agentCtx,tx=>tx.select().from(schema.payFormulaTest).where(eq(schema.payFormulaTest.companyId,target)))).toHaveLength(0);
      const [foreignAgent]=await owner.db.execute<{id:string}>(sql`insert into app.ai_agent_principal(tenant_id) values(${foreign.tenantId}::uuid) on conflict(tenant_id) do update set tenant_id=excluded.tenant_id returning id`);
      expect(await retention({...agentCtx,agent:{principalId:foreignAgent.id,enablements:[]}},target)).toBe(false);
      await expect(retention({...agentCtx,userId:ctx.userId},target)).rejects.toThrow(/cannot also carry a login/);
      expect(await exists(target)).toBe(true);expect(await evidence()).toEqual(before);
    }

  });
});

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

  it('a scoped old-company administrator receives only the retained holiday boolean after an entity transfer', async () => {
    const original = await fresh(), destination = b.companyId, today = todayInKualaLumpur();
    const day = (delta: number) => new Date(Date.parse(today + 'T00:00:00Z') + delta * 86_400_000).toISOString().slice(0, 10);
    const department = await createDepartment(ADMIN(), { companyId: original, name: 'Retained holiday origin' });
    const hired = await hireEmployee(ADMIN(), { companyId: original, departmentId: department.id,
      person: { fullName: 'Transferred holiday subject', primaryEmail: randomUUID() + '@retention.test' },
      employmentType: 'full_time', hiredOn: day(-366) });
    const [holiday] = await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, companyId: original,
      country: 'MY', holidayDate: day(-2), name: 'Retained source holiday' }).returning();
    const allocation = await withTenant(ADMIN(), async tx => {
      const [row] = await tx.insert(schema.replacementHoliday).values({ tenantId: b.tenantId, employmentId: hired.employmentId,
        companyId: original, sourceHolidayId: holiday.id, sourceDate: day(-2), sourceName: holiday.name,
        inputDigest: 'retention-fixture', status: 'review', reason: 'Retain historical employee allocation.' }).returning();
      await tx.insert(schema.replacementHolidayRevision).values({ tenantId: b.tenantId, allocationId: row.id,
        employmentId: hired.employmentId, companyId: original, snapshot: { after: row }, createdBy: b.adminUserId });
      return row;
    });
    await createMovementEvent(ADMIN(), { employmentId: hired.employmentId, kind: 'entityTransfer',
      effectiveDate: today, companyId: destination, departmentId: b.deptA });
    // Restrict the actual administrator role as well as the request grants. Old-company data remains
    // protected by current employment visibility; the helper must expose no employee/holiday payload.
    await owner.db.update(schema.roleAssignment).set({ companyId: original }).where(eq(schema.roleAssignment.appUserId, b.adminUserId));
    const context = scopedAdmin(original);
    expect(await withTenant(context, tx => tx.select().from(schema.replacementHoliday).where(eq(schema.replacementHoliday.id, allocation.id)))).toEqual([]);
    expect(await withTenant(context, tx => tx.select().from(schema.replacementHolidayRevision).where(eq(schema.replacementHolidayRevision.allocationId, allocation.id)))).toEqual([]);
    const used = (ctx: SessionContext, id: string) => withTenant(ctx, async tx => {
      const [row] = await tx.execute(sql`select app.replacement_holiday_company_in_use(${id}::uuid) as used`) as unknown as { used: boolean }[];
      return row.used;
    });
    expect(await used(context, original)).toBe(true);
    expect(await companyDeleteStatus(context, original)).toEqual({ canDelete: true, blockedBy: 'employees' });
    expect(await attempt(context, original)).toBe('employees');
    expect(await exists(original)).toBe(true);
    expect((await owner.db.select().from(schema.replacementHoliday).where(eq(schema.replacementHoliday.id, allocation.id)))).toEqual([allocation]);
    expect(await owner.db.select().from(schema.replacementHolidayRevision).where(eq(schema.replacementHolidayRevision.allocationId, allocation.id))).toHaveLength(1);
    for (const denied of [member(), scopedAdmin(destination), { ...context, tenantId: randomUUID() }]) {
      expect(await used(denied, original)).toBe(false);
    }
    const [otherTenant] = await owner.db.insert(schema.tenant).values({ name: 'Other retention tenant', workosOrgId: randomUUID() }).returning();
    const [otherTenantCompany] = await owner.db.insert(schema.company).values({ tenantId: otherTenant.id, legalName: 'Foreign retention company' }).returning();
    expect(await used(ADMIN(), otherTenantCompany.id)).toBe(false);
  });

  it('retains another company’s source holiday without exposing its transferred employee allocation', async () => {
    const allocationCompany = await fresh(), adminScope = await bare(), destination = b.companyId;
    const sourceCompany = await bare({ parentCompanyId: adminScope });
    const today = todayInKualaLumpur();
    const day = (delta: number) => new Date(Date.parse(today + 'T00:00:00Z') + delta * 86_400_000).toISOString().slice(0, 10);
    const department = await createDepartment(ADMIN(), { companyId: allocationCompany, name: 'Cross-company source origin' });
    const hired = await hireEmployee(ADMIN(), { companyId: allocationCompany, departmentId: department.id,
      person: { fullName: 'Hidden cross-company holiday subject', primaryEmail: randomUUID() + '@retention.test' },
      employmentType: 'full_time', hiredOn: day(-366) });
    const [holiday] = await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, companyId: sourceCompany,
      country: 'MY', holidayDate: day(-2), name: 'Source owned by another company' }).returning();
    // The allocation owns its dated employment company; the source FK preserves the original holiday.
    // The real validator permits this same-tenant provenance without requiring company equality.
    const allocation = await withTenant(ADMIN(), async tx => {
      const [row] = await tx.insert(schema.replacementHoliday).values({ tenantId: b.tenantId, employmentId: hired.employmentId,
        companyId: allocationCompany, sourceHolidayId: holiday.id, sourceDate: day(-2), sourceName: holiday.name,
        inputDigest: 'cross-company-source-retention', status: 'review', reason: 'Preserve cross-company original source.' }).returning();
      await tx.insert(schema.replacementHolidayRevision).values({ tenantId: b.tenantId, allocationId: row.id,
        employmentId: hired.employmentId, companyId: allocationCompany, snapshot: { after: row }, createdBy: b.adminUserId });
      return row;
    });
    await createMovementEvent(ADMIN(), { employmentId: hired.employmentId, kind: 'entityTransfer',
      effectiveDate: today, companyId: destination, departmentId: b.deptA });
    // Administer B through a separate parent D. A direct role grant to B would itself block B's
    // deletion and could conceal a missing source-retention check. A and destination C are outside D.
    await owner.db.update(schema.roleAssignment).set({ companyId: adminScope }).where(eq(schema.roleAssignment.appUserId, b.adminUserId));
    const context = scopedAdmin(adminScope);
    expect(await withTenant(context, tx => tx.select().from(schema.replacementHoliday).where(eq(schema.replacementHoliday.id, allocation.id)))).toEqual([]);
    expect(await withTenant(context, tx => tx.select().from(schema.replacementHolidayRevision).where(eq(schema.replacementHolidayRevision.allocationId, allocation.id)))).toEqual([]);
    const used = (ctx: SessionContext, id: string) => withTenant(ctx, async tx => {
      const [row] = await tx.execute(sql`select app.replacement_holiday_company_in_use(${id}::uuid) as own,
        app.replacement_holiday_source_company_in_use(${id}::uuid) as source`) as unknown as { own: boolean; source: boolean }[];
      return row;
    });
    // This must be the incoming source link, not the direct allocation-company check masking it.
    expect(await used(context, sourceCompany)).toEqual({ own: false, source: true });
    expect(await companyDeleteStatus(context, sourceCompany)).toEqual({ canDelete: true, blockedBy: 'other' });
    expect(await attempt(context, sourceCompany)).toBe('other');
    expect(await exists(sourceCompany)).toBe(true);
    expect(await owner.db.select().from(schema.holiday).where(eq(schema.holiday.id, holiday.id))).toEqual([holiday]);
    expect(await owner.db.select().from(schema.replacementHoliday).where(eq(schema.replacementHoliday.id, allocation.id))).toEqual([allocation]);
    expect(await owner.db.select().from(schema.replacementHolidayRevision).where(eq(schema.replacementHolidayRevision.allocationId, allocation.id))).toHaveLength(1);
    for (const denied of [member(), scopedAdmin(destination), { ...context, tenantId: randomUUID() }]) {
      expect(await used(denied, sourceCompany)).toEqual({ own: false, source: false });
    }
    const [otherTenant] = await owner.db.insert(schema.tenant).values({ name: 'Foreign source retention tenant', workosOrgId: randomUUID() }).returning();
    const [otherTenantCompany] = await owner.db.insert(schema.company).values({ tenantId: otherTenant.id, legalName: 'Foreign source retention company' }).returning();
    expect(await used(ADMIN(), otherTenantCompany.id)).toEqual({ own: false, source: false });
  });

  it('retains a hidden group-cycle opening-company snapshot after an employee transfers', async () => {
    const original = await bare({ parentCompanyId: b.companyId });
    const destination = await bare();
    const [cycle] = await owner.db.insert(schema.reviewCycle).values({ tenantId: b.tenantId, name: 'Group OneHR', periodStart: '2026-01-01', periodEnd: '2026-12-31', ratingScale: [] }).returning();
    await owner.db.insert(schema.onehrCycle).values({ tenantId: b.tenantId, cycleId: cycle.id, policy: {} });
    const [employment] = await owner.db.insert(schema.employment).values({ tenantId: b.tenantId, personId: await newPerson(), companyId: original, hiredOn: '2025-01-01' }).returning();
    const [review] = await owner.db.insert(schema.performanceReview).values({ tenantId: b.tenantId, cycleId: cycle.id, employmentId: employment.id }).returning();
    await owner.db.insert(schema.onehrReview).values({ tenantId: b.tenantId, cycleId: cycle.id, reviewId: review.id, employmentId: employment.id, companyId: original, grade: '12' });
    await owner.db.update(schema.employment).set({ companyId: destination }).where(eq(schema.employment.id, employment.id));
    // A parent-company administrator can manage the old company but cannot read a group cycle.
    await owner.db.update(schema.roleAssignment).set({ companyId: b.companyId }).where(eq(schema.roleAssignment.appUserId, b.adminUserId));
    const ctx = scopedAdmin(b.companyId);
    expect(await withTenant(ctx, tx => tx.select().from(schema.onehrReview))).toEqual([]);
    expect(await withTenant(ctx, tx => tx.select().from(schema.employment).where(eq(schema.employment.id, employment.id)))).toEqual([]);
    expect(await companyDeleteStatus(ctx, original)).toEqual({ canDelete: true, blockedBy: 'other' });
    expect(await attempt(ctx, original)).toBe('other');
    expect(await exists(original)).toBe(true);
    const [retained] = await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, review.id));
    expect(retained.companyId).toBe(original);
    // The boolean cannot be used as an assessment or cross-company discovery endpoint.
    const [outside] = await withTenant(scopedAdmin(destination), tx => tx.execute(sql`select app.onehr_review_company_in_use(${original}::uuid) as used`));
    expect(outside.used).toBe(false);
    const [employee] = await withTenant(member(), tx => tx.execute(sql`select app.onehr_review_company_in_use(${original}::uuid) as used`));
    expect(employee.used).toBe(false);
  });

  it('retains an otherwise empty calibration company scope in a group cycle', async () => {
    const original = await bare();
    const [cycle] = await owner.db.insert(schema.reviewCycle).values({ tenantId: b.tenantId, name: 'Group calibration', periodStart: '2026-01-01', periodEnd: '2026-12-31', ratingScale: [] }).returning();
    await owner.db.insert(schema.onehrCycle).values({ tenantId: b.tenantId, cycleId: cycle.id, policy: {} });
    await withTenant(ADMIN(), tx => tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId: cycle.id, companyId: original, name: 'Retained cohort scope', tier: 'bu', reviewerUserIds: [b.adminUserId] }));
    expect(await companyDeleteStatus(ADMIN(), original)).toEqual({ canDelete: true, blockedBy: 'other' });
    expect(await attempt(ADMIN(), original)).toBe('other');
    expect(await exists(original)).toBe(true);
    const [outside] = await withTenant(scopedAdmin(b.companyId), tx => tx.execute(sql`select app.onehr_calibration_company_in_use(${original}::uuid) as used`));
    expect(outside.used).toBe(false);
  });

  it.each(['catalogue','profit'] as const)('retains a company used only by a group-cycle %s without exposing its data', async kind => {
    const original=await bare(),day=todayInKualaLumpur();
    const [cycle]=await owner.db.insert(schema.reviewCycle).values({tenantId:b.tenantId,name:'Group assessment setup',periodStart:day,periodEnd:day,ratingScale:[]}).returning();
    await owner.db.insert(schema.onehrCycle).values({tenantId:b.tenantId,cycleId:cycle.id,policy:{}});
    if(kind==='catalogue')await withTenant(ADMIN(),tx=>tx.insert(schema.assessmentCatalogue).values({tenantId:b.tenantId,scopeKey:original,companyId:original,catalogue:{profiles:[],skills:[],careerRoutes:[]},sourceCycleId:cycle.id,updatedBy:b.adminUserId}));
    else await withTenant(ADMIN(),tx=>tx.insert(schema.assessmentProfitAchievement).values({tenantId:b.tenantId,cycleId:cycle.id,companyId:original,achievementPct:'95',updatedBy:b.adminUserId}));
    const context=scopedAdmin(original);
    expect(await companyDeleteStatus(context,original)).toEqual({canDelete:true,blockedBy:'other'});
    expect(await attempt(context,original)).toBe('other');expect(await exists(original)).toBe(true);
    const query=kind==='catalogue'?sql`select app.assessment_catalogue_company_in_use(${original}::uuid) as used`:sql`select app.assessment_profit_company_in_use(${original}::uuid) as used`;
    for(const ctx of [scopedAdmin(b.companyId),member()]){const [outside]=await withTenant(ctx,tx=>tx.execute(query));expect(outside.used).toBe(false);}
  });

  it.each(['company','group'] as const)('retains the KPI library %s scope without exposing it outside admin scope',async kind=>{
    const original=await bare();
    await owner.db.insert(schema.performanceKpiLibrary).values({tenantId:b.tenantId,name:'Retained KPI',template:{},...(kind==='company'?{companyId:original}:{groupCompanyId:original})});
    const context=scopedAdmin(original);
    expect(await companyDeleteStatus(context,original)).toEqual({canDelete:true,blockedBy:'other'});
    expect(await attempt(context,original)).toBe('other');expect(await exists(original)).toBe(true);
    const query=kind==='company'?sql`select app.performance_kpi_library_company_in_use(${original}::uuid) as used`:sql`select app.performance_kpi_library_group_in_use(${original}::uuid) as used`;
    for(const ctx of [scopedAdmin(b.companyId),member()]){const [outside]=await withTenant(ctx,tx=>tx.execute(query));expect(outside.used).toBe(false);}
  });

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
    employees: CASES.find(c => c.name === 'a terminated employment')!.setup,
    payroll: CASES.find(c => c.name === 'a payroll period')!.setup,
    other: CASES.find(c => c.name === 'a sub-company')!.setup,
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


describe('retained policy company metadata',()=>{
 it('blocks company deletion without exposing private epoch rows or another company retention fact',async()=>{
  const id=await bare(),other=await bare();
  await owner.db.execute(sql`insert into app.attendance_policy_company_epoch(tenant_id,company_id,epoch) values(${b.tenantId}::uuid,${id}::uuid,0)`);
  const retained=async(ctx:SessionContext,companyId:string)=>withTenant(ctx,async tx=>{
   const rows=await tx.execute(sql`select app.retained_company_history_in_use(${companyId}::uuid) as retained`) as unknown as {retained:boolean}[];
   return rows[0].retained;
  });
  expect(await retained(scopedAdmin(id),id)).toBe(true);
  expect(await retained(scopedAdmin(other),id)).toBe(false);
  expect(await retained(member(),id)).toBe(false);
  expect(await retained({...ADMIN(),tenantId:randomUUID()},id)).toBe(false);
  expect(await verdict(ADMIN(),id)).toBe('other');
  expect(await attempt(ADMIN(),id)).toBe('other');
  expect(await exists(id)).toBe(true);
  expect(await sqlStateOf(withTenant(ADMIN(),tx=>tx.execute(sql`select * from app.attendance_policy_company_epoch`)))).toBe('42501');
 });
});

// Board 3 adds retained company/org links. The ordinary app must not receive the hidden rows
// merely because the company-deletion owner needs to know that they exist.
describe('Board 3 retained company records', () => {
  const used = (ctx: SessionContext, name: 'job' | 'allocation' | 'source', id: string) =>
    withTenant(ctx, async tx => {
      const fn = { job: 'board3_job_company_in_use', allocation: 'board3_allocation_company_in_use', source: 'board3_source_company_in_use' }[name];
      const [row] = await tx.execute(sql`select ${sql.raw('app.' + fn)}(${id}::uuid) as used`) as unknown as { used: boolean }[];
      return row.used;
    });
  async function job(companyId: string, org: Record<string,string> = {}) {
    return withTenant(ADMIN(), async tx => {
      const [master] = await tx.execute(sql`insert into job_document(tenant_id,company_id,job_code,normalized_code,created_by)
        values(${b.tenantId}::uuid,${companyId}::uuid,'RETENTION','retention',${b.adminUserId}::uuid) returning id`) as unknown as {id:string}[];
      await tx.execute(sql`insert into job_document_revision(tenant_id,job_id,version,title,definition,org,prepared_by,last_edited_by)
        values(${b.tenantId}::uuid,${master.id}::uuid,1,'Retained job','{}'::jsonb,${JSON.stringify(org)}::jsonb,${b.adminUserId}::uuid,${b.adminUserId}::uuid)`);
      return master.id;
    });
  }
  it.each(['document','form'] as const)('refuses deletion for a retained %s and preserves it', async kind => {
    const id = await bare();
    if (kind === 'document') await job(id);
    else await withTenant(ADMIN(), tx => tx.execute(sql`insert into job_document_form(tenant_id,company_id,version,definition,created_by)
      values(${b.tenantId}::uuid,${id}::uuid,1,'{}'::jsonb,${b.adminUserId}::uuid)`));
    expect(await used(ADMIN(),'job',id)).toBe(true);
    expect(await verdict(ADMIN(),id)).toBe('other');
    expect(await attempt(ADMIN(),id)).toBe('other');
    expect(await exists(id)).toBe(true);
    expect(await used(member(),'job',id)).toBe(false);
    expect(await used({...ADMIN(),tenantId:randomUUID()},'job',id)).toBe(false);
    expect(await used(scopedAdmin(b.companyId),'job',id)).toBe(false);
    const [count] = await owner.db.execute(sql`select count(*)::int as n from ${sql.raw(kind==='document'?'job_document':'job_document_form')} where company_id=${id}::uuid`);
    expect(count.n).toBe(1);
  });
  it.each(['businessUnit','department','location','position','reportsTo'] as const)('retains a hidden job revision’s %s source without widening app reads', async field => {
    const source = await bare(), destination = await bare();
    const table = {businessUnit:'business_unit',department:'department',location:'location',position:'position',reportsTo:'position'}[field];
    const labelColumn = table==='position'?'title':'name';
    const codeColumn = table==='business_unit'||table==='location' ? ',code' : '';
    const codeValue = codeColumn ? ",'RET-SOURCE'" : '';
    const [org] = await owner.db.execute(sql`insert into ${sql.raw(table)}(tenant_id,company_id,${sql.raw(labelColumn+codeColumn)})
      values(${b.tenantId}::uuid,${source}::uuid,'Retained source'${sql.raw(codeValue)}) returning id`) as unknown as {id:string}[];
    const id=await job(destination,{[field]:org.id});
    await owner.db.update(schema.roleAssignment).set({companyId:source}).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
    const context=scopedAdmin(source);
    expect(await withTenant(context,tx=>tx.execute(sql`select id from job_document_revision where job_id=${id}::uuid`))).toHaveLength(0);
    expect(await used(context,'source',source)).toBe(true);
    expect(await verdict(context,source)).toBe('other');
    expect(await attempt(context,source)).toBe('other');
    expect(await exists(source)).toBe(true);
    const [retained] = await owner.db.execute(sql`select org from job_document_revision where job_id=${id}::uuid`);
    expect(retained.org).toEqual({[field]:org.id});
    for(const denied of [member(),scopedAdmin(destination),{...context,tenantId:randomUUID()}])
      expect(await used(denied,'source',source)).toBe(false);
  });
  it('retains allocation company and cost-centre history after transfer while employee rows stay hidden',async()=>{
    const {createCostCenter}=await import('../core/admin');
    const {previewEmploymentCostAllocations,saveEmploymentCostAllocations}=await import('../core/employment-cost-allocations');
    const original=await bare(),today=todayInKualaLumpur();
    const before=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    const department=await createDepartment(ADMIN(),{companyId:original,name:'Old department'});
    const hired=await hireEmployee(ADMIN(),{companyId:original,departmentId:department.id,person:{fullName:'Retained allocation employee',primaryEmail:randomUUID()+'@retention.test'},employmentType:'full_time',hiredOn:before});
    const center=await createCostCenter(ADMIN(),{companyId:original,code:'RET-COST',name:'Retained allocation cost centre'});
    for(const [revision,date,rows] of [[0,before,[{costCenterId:center.id,percentage:'100'}]],[1,today,[]]] as const){
      const input={employmentId:hired.employmentId,effectiveDate:date,expectedRevision:revision,operation:rows.length?'replace' as const:'clear' as const,rows:[...rows]};
      const preview=await previewEmploymentCostAllocations(ADMIN(),input);
      await saveEmploymentCostAllocations(ADMIN(),input,{digest:preview.digest});
    }
    await createMovementEvent(ADMIN(),{employmentId:hired.employmentId,kind:'entityTransfer',effectiveDate:today,companyId:b.companyId,departmentId:b.deptA});
    const history=await owner.db.select().from(schema.employmentCostAllocationSet).where(eq(schema.employmentCostAllocationSet.employmentId,hired.employmentId));
    await owner.db.update(schema.roleAssignment).set({companyId:original}).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
    const context=scopedAdmin(original);
    expect(await withTenant(context,tx=>tx.select().from(schema.employmentCostAllocationSet).where(eq(schema.employmentCostAllocationSet.employmentId,hired.employmentId)))).toEqual([]);
    for(const kind of ['allocation','source'] as const){
      expect(await used(context,kind,original)).toBe(true);
      for(const denied of [member(),scopedAdmin(b.companyId),{...context,tenantId:randomUUID()}])expect(await used(denied,kind,original)).toBe(false);
    }
    expect(await verdict(context,original)).toBe('employees');
    expect(await attempt(context,original)).toBe('employees');
    expect(await owner.db.select().from(schema.employmentCostAllocationSet).where(eq(schema.employmentCostAllocationSet.employmentId,hired.employmentId))).toEqual(history);
  });
});

// Retention-only fictional rows deliberately isolate each physical FK on an otherwise unused
// company. They are owner-arranged valid metadata, not a claim of a native reviewed action.
// No guard/RLS is disabled and no raw app privilege is installed.
describe('Assistant effective-company and promotion retention',()=>{
 const retained=(ctx:SessionContext,id:string)=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{used:boolean}>(sql`select app.ai_assistance_company_in_use(${id}::uuid) as used`);return row.used;});
 async function metadata(companyId:string,kind:'allocation'|'promotion',terminal:boolean){
  const id=randomUUID();
  if(kind==='allocation'){
   const target=await hireEmployee(ADMIN(),{companyId:b.companyId,departmentId:b.deptA,person:{fullName:'Fictional retained review subject',primaryEmail:randomUUID()+'@retention.test'},employmentType:'full_time',hiredOn:'2024-01-01'});
   await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,allocation_effective_date,allocation_effective_company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
    values('employees.cost_allocation.maintain',${id}::uuid,${b.tenantId}::uuid,${b.adminUserId}::uuid,NULL,${target.employmentId}::uuid,${b.companyId}::uuid,${target.personId}::uuid,'employment',${target.employmentId}::uuid,'2025-01-01'::date,${companyId}::uuid,${terminal?null:'a'.repeat(64)},${terminal?null:'b'.repeat(64)},${terminal?'discarded':'awaiting_confirmation'},now(),now()+interval '10 minutes')`);
  }else{
   const [author]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'retention_'+randomUUID()}).returning({id:schema.appUser.id});
   await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:author.id,role:'employee',companyId:null});
   const candidate=randomUUID(),digest='a'.repeat(64);
   await owner.db.execute(sql`insert into public.ai_agent_candidate(id,tenant_id,owner_user_id,author_user_id,module_code,version,kind,configuration,candidate_digest,baseline_digest,source_digest,engine_digest,policy_digest,input_digest)
    values(${candidate}::uuid,${b.tenantId}::uuid,${author.id}::uuid,${author.id}::uuid,'org',1,'canonical_specialist_v1','{"kind":"canonical_specialist_v1","module":"org","playbook":"canonical_domain_v1"}'::jsonb,${digest},${digest},${digest},${digest},${digest},${digest})`);
   await owner.db.execute(sql`insert into public.ai_agent_promotion(id,tenant_id,candidate_id,owner_user_id,module_code,approver_user_id,receipt,max_jobs,used_jobs,created_at,expires_at,scope,company_id)
    values(${id}::uuid,${b.tenantId}::uuid,${candidate}::uuid,${author.id}::uuid,'org',${b.adminUserId}::uuid,'Fictional retention metadata',1,0,now()-interval '2 hours',${terminal?sql`now()-interval '1 hour'`:sql`now()+interval '1 hour'`},'company',${companyId}::uuid)`);
  }
  return id;
 }
 async function snapshot(id:string,kind:'allocation'|'promotion'){
  const [row]=await owner.db.execute<{value:unknown}>(sql`select jsonb_build_object('retained',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from ${sql.raw(kind==='allocation'?'app.assistant_own_leave_review':'public.ai_agent_promotion')} s where s.id=${id}::uuid),'events',(select jsonb_agg(to_jsonb(e) order by e.id) from public.domain_event e where e.tenant_id=${b.tenantId}::uuid)) as value`);return row.value;
 }
 for(const kind of ['allocation','promotion'] as const)for(const terminal of [false,true])it(`retains ${kind} ${terminal?'retired or expired':'pending or active'} company metadata without revealing hidden rows`,async()=>{
  const id=await bare(),other=await bare(),context=scopedAdmin(id);
  expect(await retained(context,id)).toBe(false);expect(await verdict(ADMIN(),id)).toBeNull();
  const ref=await metadata(id,kind,terminal),before=await snapshot(ref,kind);
  expect(await retained(context,id)).toBe(true);
  for(const denied of [member(),scopedAdmin(other),{...context,tenantId:randomUUID()}])expect(await retained(denied,id)).toBe(false);
  expect(await retained(context,randomUUID())).toBe(false);
  if(kind==='allocation')expect(await sqlStateOf(withTenant(context,tx=>tx.execute(sql`select * from app.assistant_own_leave_review where id=${ref}::uuid`)))).toBe('42501');
  else expect(await withTenant(context,tx=>tx.execute(sql`select id from public.ai_agent_promotion where id=${ref}::uuid`))).toHaveLength(0);
  // Shared reader must refuse before DELETE; a hidden FK fallback alone is insufficient.
  expect(await verdict(context,id)).toBe('other');expect(await attempt(context,id)).toBe('other');
  expect(await exists(id)).toBe(true);expect(await snapshot(ref,kind)).toEqual(before);
 });
 it('pins the exact boolean owner and app isolation without granting private reads',async()=>{
  const [proof]=await owner.db.execute<{forced:boolean;definer:boolean;appLedger:boolean;appFunction:boolean;publicFunction:boolean;policyApp:boolean;ownerMatches:boolean;appMember:boolean;appInherit:boolean;appSet:boolean;exactOwnerGuard:boolean}>(sql`select c.relforcerowsecurity as forced,p.prosecdef as definer,
   has_table_privilege('ai_hr_app','app.assistant_own_leave_review','SELECT') as "appLedger",has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as "appFunction",
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as "publicFunction",
   exists(select 1 from pg_policy pol join pg_roles a on a.oid=any(pol.polroles) where pol.polrelid=c.oid and pol.polname='ai_agent_promotion_company_retention' and a.rolname='ai_hr_app') as "policyApp",
   p.proowner=c.relowner and p.proowner=(select relowner from pg_class where oid='app.assistant_own_leave_review'::regclass) as "ownerMatches",
   pg_has_role('ai_hr_app',p.proowner,'MEMBER') as "appMember",pg_has_role('ai_hr_app',p.proowner,'USAGE') as "appInherit",pg_has_role('ai_hr_app',p.proowner,'SET') as "appSet",
   exists(select 1 from pg_policy pol where pol.polrelid=c.oid and pol.polname='ai_agent_promotion_company_retention' and pol.polroles=array[c.relowner] and pg_get_expr(pol.polqual,pol.polrelid) like '%CURRENT_USER = pg_get_userbyid%') as "exactOwnerGuard"
   from pg_proc p join pg_roles r on r.oid=p.proowner join pg_class c on c.oid='public.ai_agent_promotion'::regclass where p.oid='app.ai_assistance_company_in_use(uuid)'::regprocedure`);
  // Universal migration topology supports privileged disposable owners; genuine restricted-owner proof is separately mandatory.
  expect(proof).toEqual({forced:true,definer:true,appLedger:false,appFunction:true,publicFunction:false,policyApp:false,ownerMatches:true,appMember:false,appInherit:false,appSet:false,exactOwnerGuard:true});
  const id=await bare();await metadata(id,'promotion',true);expect(await retained(scopedAdmin(id),id)).toBe(true);
 });

 type ActorRun=<T>(who:SessionContext,work:(tx:Tx)=>Promise<T>)=>Promise<T>;
 // Driver-scoped nested transaction: any expected SQL error escapes this scope before callers classify it.
 // A raw SQL savepoint would leave postgres-js's outer scoped error tracker poisoned.
 const retentionActorRun=(base:Tx):ActorRun=>async(who,fn)=>base.transaction(async inner=>{
  await inner.execute(sql`set local role ai_hr_app`);
  await inner.execute(sql`select set_config('app.tenant_id',${who.tenantId},true),set_config('app.user_id',${who.userId??''},true),set_config('app.roles',${(who.roles??[]).join(',')},true),set_config('app.grants',${JSON.stringify(who.grants??(who.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true)`);
  const result=await fn(inner);await inner.execute(sql`reset role`);return result;
 });
 async function retentionCatalog(tx:Pick<Tx,'execute'>){const [row]=await tx.execute<{value:unknown}>(sql`select jsonb_build_object(
  'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c where c.oid in('public.ai_agent_promotion'::regclass,'app.assistant_own_leave_review'::regclass,'public.company'::regclass,'public.personnel_import_assistance_attempt'::regclass,'public.employee_import_evaluation_attempt'::regclass,'public.employee_import_evaluation_run_membership'::regclass)),
  'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,pg_get_functiondef(p.oid)) order by p.oid) from pg_proc p where p.oid in('app.ai_assistance_company_in_use(uuid)'::regprocedure,'app.current_tenant_id()'::regprocedure,'app.current_user_id()'::regprocedure,'app.principal_snapshot_current()'::regprocedure,'app.is_admin_for(uuid)'::regprocedure)),
  'policies',(select jsonb_agg(jsonb_build_array(p.oid,p.polrelid,p.polname,p.polroles,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.oid) from pg_policy p where p.polrelid in('public.ai_agent_promotion'::regclass,'app.assistant_own_leave_review'::regclass)),
  'schemas',(select jsonb_agg(jsonb_build_array(n.oid,n.nspowner,n.nspacl) order by n.oid) from pg_namespace n where n.nspname in('app','public')),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r where r.rolname in('ai_hr_owner','ai_hr_app')),
  'edges',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m where m.roleid in(select oid from pg_roles where rolname in('ai_hr_owner','ai_hr_app')) or m.member in(select oid from pg_roles where rolname in('ai_hr_owner','ai_hr_app')))) as value`);return row.value;}
 async function restrictedProjection(work:(run:ActorRun,read:Tx)=>Promise<void>){
  const before=await retentionCatalog(owner.db),rollback='Fictional restricted retention projection rollback';
  await expect(owner.db.transaction(async tx=>{
   const [role]=await tx.execute<{superuser:boolean;bypass:boolean;createRole:boolean}>(sql`select rolsuper as superuser,rolbypassrls as bypass,rolcreaterole as "createRole" from pg_roles where rolname='ai_hr_owner'`);expect(role).toEqual({superuser:false,bypass:false,createRole:false});
   await tx.execute(sql`alter table public.ai_agent_promotion owner to ai_hr_owner`);
   await tx.execute(sql`alter table app.assistant_own_leave_review owner to ai_hr_owner`);
   await tx.execute(sql`alter function app.ai_assistance_company_in_use(uuid) owner to ai_hr_owner`);
   // Same exact owner predicate; only bind its TO role to the projected physical owner, as0865 does.
   const [qual]=await tx.execute<{predicate:string}>(sql`select pg_get_expr(polqual,polrelid) as predicate from pg_policy where polrelid='public.ai_agent_promotion'::regclass and polname='ai_agent_promotion_company_retention'`);
   await tx.execute(sql`alter policy ai_agent_promotion_company_retention on public.ai_agent_promotion to ai_hr_owner`);
   const [after]=await tx.execute<{predicate:string}>(sql`select pg_get_expr(polqual,polrelid) as predicate from pg_policy where polrelid='public.ai_agent_promotion'::regclass and polname='ai_agent_promotion_company_retention'`);expect(after).toEqual(qual);
   // Fixture-only closed dependency privileges to restricted owner, NEVER to app; entire catalog rolls back.
   await tx.execute(sql`grant usage on schema app,public to ai_hr_owner`);
   await tx.execute(sql`grant select on public.company,public.personnel_import_assistance_attempt,public.employee_import_evaluation_attempt,public.employee_import_evaluation_run_membership to ai_hr_owner`);
   await tx.execute(sql`grant execute on function app.current_tenant_id(),app.current_user_id(),app.principal_snapshot_current(),app.is_admin_for(uuid) to ai_hr_owner`);
   const run=retentionActorRun(tx);
   const [identity]=await tx.execute<{owner:string;promotion:string;review:string;forced:boolean;superuser:boolean;bypass:boolean;appMember:boolean;appInherit:boolean;appSet:boolean;appRaw:boolean;exactPolicyRole:boolean}>(sql`select pg_get_userbyid(p.proowner) as owner,pg_get_userbyid(c.relowner) as promotion,pg_get_userbyid(l.relowner) as review,c.relforcerowsecurity as forced,r.rolsuper as superuser,r.rolbypassrls as bypass,pg_has_role('ai_hr_app',p.proowner,'MEMBER') as "appMember",pg_has_role('ai_hr_app',p.proowner,'USAGE') as "appInherit",pg_has_role('ai_hr_app',p.proowner,'SET') as "appSet",has_table_privilege('ai_hr_app','app.assistant_own_leave_review','SELECT') as "appRaw",exists(select 1 from pg_policy pol where pol.polrelid=c.oid and pol.polname='ai_agent_promotion_company_retention' and pol.polroles=array[c.relowner]) as "exactPolicyRole" from pg_proc p join pg_roles r on r.oid=p.proowner join pg_class c on c.oid='public.ai_agent_promotion'::regclass join pg_class l on l.oid='app.assistant_own_leave_review'::regclass where p.oid='app.ai_assistance_company_in_use(uuid)'::regprocedure`);
   expect(identity).toEqual({owner:'ai_hr_owner',promotion:'ai_hr_owner',review:'ai_hr_owner',forced:true,superuser:false,bypass:false,appMember:false,appInherit:false,appSet:false,appRaw:false,exactPolicyRole:true});
   await work(run,tx);throw new Error(rollback);
  })).rejects.toThrow(rollback);
  expect(await retentionCatalog(owner.db)).toEqual(before);
 }
 for(const topology of ['ordinary','restricted-projection'] as const)it(`keeps every promotion-dependent row and admission private to a noncreator personless company administrator (${topology})`,async()=>{
  const companyId=await bare(),other=await bare(),promotion=await metadata(companyId,'promotion',false),context=scopedAdmin(companyId);
  await owner.db.update(schema.roleAssignment).set({companyId}).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
  const grants=await owner.db.select({role:schema.roleAssignment.role,companyId:schema.roleAssignment.companyId}).from(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));expect(grants).toEqual([{role:'hr_admin',companyId}]);
  const [p]=await owner.db.execute<{candidate:string;author:string}>(sql`select candidate_id as candidate,owner_user_id as author from public.ai_agent_promotion where id=${promotion}::uuid`);
  const [otherAdmin]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'retention_other_admin_'+randomUUID()}).returning({id:schema.appUser.id});await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:otherAdmin.id,role:'hr_admin',companyId:other});
  const otherContext:SessionContext={...adminCtx(b),userId:otherAdmin.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:other}]};
  const job=randomUUID(),use=randomUUID(),rollback=randomUUID(),digest='a'.repeat(64);
  await owner.db.execute(sql`insert into public.ai_agent_candidate_provenance(candidate_id,tenant_id,owner_user_id,refs,native_refs,receipt) values(${p.candidate}::uuid,${b.tenantId}::uuid,${p.author}::uuid,'[]'::jsonb,'[]'::jsonb,'Fictional signal-free provenance')`);
  await owner.db.execute(sql`insert into public.ai_agent_rollback(id,tenant_id,promotion_id,actor_user_id,reason) values(${rollback}::uuid,${b.tenantId}::uuid,${promotion}::uuid,${p.author}::uuid,'human')`);
  await owner.db.execute(sql`insert into public.ai_agent_job_receipt(id,tenant_id,user_id,promotion_id,receipt) values(${job}::uuid,${b.tenantId}::uuid,${p.author}::uuid,${promotion}::uuid,'Fictional private job')`);
  await owner.db.execute(sql`insert into public.ai_assistant_answer_strategy_use(id,tenant_id,user_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt) values(${use}::uuid,${b.tenantId}::uuid,${p.author}::uuid,${promotion}::uuid,${digest},${digest},${digest},'Fictional private strategy use')`);
  let reader:Pick<Tx,'execute'>=owner.db;
  const allRows=async()=>{const [r]=await reader.execute<{value:unknown}>(sql`select jsonb_build_object(
   'promotion',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_agent_promotion s where s.id=${promotion}::uuid),
   'candidate',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_agent_candidate s where s.id=${p.candidate}::uuid),
   'provenance',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_agent_candidate_provenance s where s.candidate_id=${p.candidate}::uuid),
   'rollback',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_agent_rollback s where s.id=${rollback}::uuid),
   'job',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_agent_job_receipt s where s.id=${job}::uuid),
   'answerUse',(select to_jsonb(s)||jsonb_build_object('_xmin',s.xmin::text) from public.ai_assistant_answer_strategy_use s where s.id=${use}::uuid)) as value`);return r.value;};
  const before=await allRows();
  // SET denial is from a TRUE app LOGIN, never the projection's privileged fixture session.
  expect(await sqlStateOf(withTenant(context,async tx=>{const [login]=await tx.execute<{session:string;current:string}>(sql`select session_user as session,current_user as current`);expect(login).toEqual({session:'ai_hr_app',current:'ai_hr_app'});await tx.execute(sql`set local role ai_hr_owner`);}))).toBe('42501');
  const foreign=await seedBase();
  const exercise=async(run:ActorRun,read:Pick<Tx,'execute'|'transaction'>)=>{reader=read;const retained=(who:SessionContext,id:string)=>run(who,async tx=>{const [r]=await tx.execute<{used:boolean}>(sql`select app.ai_assistance_company_in_use(${id}::uuid) as used`);return r.used;});
expect(before).toMatchObject({promotion:{used_jobs:0},candidate:{id:p.candidate},provenance:{refs:[],native_refs:[]},rollback:{id:rollback},job:{id:job},answerUse:{id:use}});
  await run(context,async tx=>{
   const [identity]=await tx.execute<{app:string;principal:boolean;group:boolean;person:string|null;employed:boolean}>(sql`select current_user as app,app.principal_snapshot_current() as principal,app.is_group_admin() as "group",u.person_id as person,exists(select 1 from public.employment e where e.person_id=u.person_id and e.company_id=${companyId}::uuid) as employed from public.app_user u where u.id=${b.adminUserId}::uuid`);
   expect(identity).toEqual({app:'ai_hr_app',principal:true,group:false,person:null,employed:false});
  });
  expect(p.author).not.toBe(context.userId);expect(await retained(context,companyId)).toBe(true);
  const hidden=async(who:SessionContext)=>run(who,async tx=>{
   for(const [table,column,id] of [['ai_agent_promotion','id',promotion],['ai_agent_candidate','id',p.candidate],['ai_agent_candidate_provenance','candidate_id',p.candidate],['ai_agent_rollback','id',rollback],['ai_agent_job_receipt','id',job],['ai_assistant_answer_strategy_use','id',use]])expect(await tx.execute(sql`select * from ${sql.identifier(table)} where ${sql.identifier(column)}=${id}::uuid`)).toHaveLength(0);
   const [signals]=await tx.execute<{candidate:boolean;feedback:boolean;native:boolean}>(sql`select app.agent_candidate_signals_current(${p.candidate}::uuid) as candidate,app.agent_signal_custody_visible('job',${job}::uuid,${b.tenantId}::uuid,${p.author}::uuid) as feedback,app.agent_native_signal_custody_visible('job',${job}::uuid,${b.tenantId}::uuid,${p.author}::uuid) as native`);expect(signals).toEqual({candidate:false,feedback:false,native:false});
  });
  await hidden(context);await hidden(otherContext);await hidden({...adminCtx(foreign)});
  expect(await retained(otherContext,other)).toBe(false);expect(await retained(otherContext,companyId)).toBe(false);expect(await retained(adminCtx(foreign),companyId)).toBe(false);
  const [unusedIdentity]=await run(otherContext,tx=>tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`));expect(unusedIdentity.current).toBe(true);
  await run(context,async tx=>{const [absent]=await tx.execute<{empty:boolean;unknown:boolean}>(sql`select app.ai_assistance_company_in_use(NULL::uuid) as empty,app.ai_assistance_company_in_use(${randomUUID()}::uuid) as unknown`);expect(absent).toEqual({empty:false,unknown:false});});
  if(topology==='restricted-projection'){
   const rollback='Fictional stale retention principal rollback';
   await expect(read.transaction(async inner=>{
    await inner.execute(sql`update public.app_user set archived_at=now() where id=${context.userId}::uuid`);
    const [stale]=await retentionActorRun(inner)(context,actor=>actor.execute<{current:boolean;used:boolean}>(sql`select app.principal_snapshot_current() as current,app.ai_assistance_company_in_use(${companyId}::uuid) as used`));expect(stale).toEqual({current:false,used:false});
    throw new Error(rollback);
   })).rejects.toThrow(rollback);
  }
  expect(await run(context,tx=>tx.execute(sql`update public.ai_agent_promotion set used_jobs=used_jobs+1 where id=${promotion}::uuid returning id`))).toHaveLength(0);
  expect(await sqlStateOf(run(context,tx=>tx.execute(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,reason) values(${b.tenantId}::uuid,${promotion}::uuid,${context.userId}::uuid,'source_changed')`)))).toBe('42501');
  expect(await sqlStateOf(run(context,tx=>tx.execute(sql`insert into public.ai_agent_job_receipt(tenant_id,user_id,promotion_id,receipt) values(${b.tenantId}::uuid,${context.userId}::uuid,${promotion}::uuid,'Fictional denied job')`)))).toBe('42501');
  expect(await sqlStateOf(run(context,tx=>tx.execute(sql`insert into public.ai_assistant_answer_strategy_use(id,tenant_id,user_id,person_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt) values(${randomUUID()}::uuid,${b.tenantId}::uuid,${context.userId}::uuid,NULL,${promotion}::uuid,${digest},${digest},${digest},'Fictional denied strategy')`)))).toBe('42501');
  // Existing own-user visibility remains, without inventing a company employment requirement.
  const author:SessionContext={...adminCtx(b),userId:p.author,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  expect(await retained(author,companyId)).toBe(false);
  await run(author,async tx=>{for(const [table,id] of [['ai_agent_promotion',promotion],['ai_agent_candidate',p.candidate],['ai_agent_job_receipt',job],['ai_assistant_answer_strategy_use',use]])expect(await tx.execute(sql`select id from ${sql.identifier(table)} where id=${id}::uuid`)).toHaveLength(1);});
  expect(await allRows()).toEqual(before);
  };
  if(topology==='restricted-projection')await restrictedProjection(exercise);else await exercise(withTenant,owner.db);
  reader=owner.db;expect(await allRows()).toEqual(before);
 });
 it('counts a real sealed cost review for its historical company after native transfer without exposing its ledger',async()=>{
  vi.stubEnv('AI_CONFIG_SECRET','fictional-company-retention-native-review');
  try{
   await setModule(b.tenantId,'assistant','active');const actor={...ADMIN(),grants:[{role:'hr_admin' as const,companyId:null}]};await grantAssistant(actor,{appUserId:b.adminUserId});
   const target=await hireEmployee(actor,{companyId:b.companyId,departmentId:b.deptA,person:{fullName:'Fictional dated retention employee',primaryEmail:randomUUID()+'@retention.test'},employmentType:'full_time',hiredOn:'2024-01-01'});
   await costAllocations.saveEmploymentCostAllocations(actor,{employmentId:target.employmentId,effectiveDate:'2024-01-01',expectedRevision:0,operation:'replace',rows:[{costCenterId:b.costCenterId,percentage:'100'}]});
   await costAllocations.saveEmploymentCostAllocations(actor,{employmentId:target.employmentId,effectiveDate:'2025-01-01',expectedRevision:1,operation:'clear',rows:[]});
   const destination=await createCompany(actor,{legalName:'Fictional retention destination',country:'MY'}),department=await createDepartment(actor,{companyId:destination.id,name:'Fictional destination department'});
   await withTenant(actor,tx=>transferEmploymentCompanyTx(tx,actor,{employmentId:target.employmentId,newCompanyId:destination.id,effectiveDate:'2025-01-01',placement:{departmentId:department.id},movement:{type:'entityTransfer'}}));
   const review=(await costAllocationMaintenanceReviews.prepare(actor,{action:'employees.cost_allocation.maintain',contractVersion:1,employmentId:target.employmentId,subjectId:target.employmentId,effectiveCompanyId:b.companyId,effectiveDate:'2024-06-01',expectedRevision:2,operation:'replace',rows:[{costCenterId:b.costCenterId,percentage:'100'}]})).review;
   const [row]=await owner.db.execute<{original:string;effective:string;person:string|null;bodies:number}>(sql`select company_id as original,allocation_effective_company_id as effective,person_id as person,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${review.actionId}::uuid`);
   expect(row).toEqual({original:destination.id,effective:b.companyId,person:null,bodies:1});
   expect(await retained(scopedAdmin(b.companyId),b.companyId)).toBe(true);
   expect(await sqlStateOf(withTenant(scopedAdmin(b.companyId),tx=>tx.execute(sql`select * from app.assistant_own_leave_review where id=${review.actionId}::uuid`)))).toBe('42501');
   // Native historical references also exist here; isolated deletion attribution is proved by the four metadata cases above.
   expect(await retained(scopedAdmin(destination.id),b.companyId)).toBe(false);
   const sealed=async()=>{const [r]=await owner.db.execute<{value:unknown}>(sql`select jsonb_build_object('ledger',(select to_jsonb(r)||jsonb_build_object('_xmin',r.xmin::text) from app.assistant_own_leave_review r where id=${review.actionId}::uuid),'body',(select to_jsonb(c) from app.assistant_own_leave_review_content c where action_id=${review.actionId}::uuid)) as value`);return r.value;};
   const before=await sealed();
   await restrictedProjection(async run=>{
    const selected=scopedAdmin(b.companyId);
    const [used]=await run(selected,tx=>tx.execute<{used:boolean}>(sql`select app.ai_assistance_company_in_use(${b.companyId}::uuid) as used`));expect(used.used).toBe(true);
    expect(await sqlStateOf(run(selected,tx=>tx.execute(sql`select * from app.assistant_own_leave_review where id=${review.actionId}::uuid`)))).toBe('42501');
    const [denied]=await run(scopedAdmin(destination.id),tx=>tx.execute<{used:boolean}>(sql`select app.ai_assistance_company_in_use(${b.companyId}::uuid) as used`));expect(denied.used).toBe(false);
   });
   expect(await sealed()).toEqual(before);
  }finally{vi.unstubAllEnvs();}
 });

 it('returns false for null and unknown companies and a genuinely stale principal snapshot',async()=>{
  const id=await bare(),context=scopedAdmin(id);await metadata(id,'promotion',false);expect(await retained(context,id)).toBe(true);
  await withTenant(context,async tx=>{const [row]=await tx.execute<{used:boolean}>(sql`select app.ai_assistance_company_in_use(NULL::uuid) as used`);expect(row.used).toBe(false);});
  expect(await retained(context,randomUUID())).toBe(false);
  await owner.db.update(schema.roleAssignment).set({role:'employee'}).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
  await withTenant(context,async tx=>{const [row]=await tx.execute<{current:boolean;used:boolean}>(sql`select app.principal_snapshot_current() as current,app.ai_assistance_company_in_use(${id}::uuid) as used`);expect(row).toEqual({current:false,used:false});});
 });
 for(const kind of ['header','evaluation','membership'] as const)it(`preserves the existing ${kind} import retention branch without exposing its private rows`,async()=>{
  const id=await bare(),context=scopedAdmin(id),digest='a'.repeat(64),header=randomUUID(),evaluation=randomUUID(),run=randomUUID();
  const [author]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'old_retention_'+randomUUID()}).returning({id:schema.appUser.id});
  expect(await retained(context,id)).toBe(false);
  if(kind==='header')await owner.db.execute(sql`insert into public.personnel_import_assistance_attempt(id,tenant_id,user_id,company_id,operation_nonce,source_revision,registry_digest,headers_digest,input_digest,header_indexes,mode) values(${header}::uuid,${b.tenantId}::uuid,${author.id}::uuid,${id}::uuid,${randomUUID()}::uuid,${digest},${digest},${digest},${digest},'[0]'::jsonb,'deterministic')`);
  else{
   await owner.db.execute(sql`insert into public.employee_import_evaluation_attempt(id,tenant_id,user_id,company_id,cohort_id,operation_nonce,mode,binding_ciphertext) values(${evaluation}::uuid,${b.tenantId}::uuid,${author.id}::uuid,${id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,'assisted','Fictional retained import binding')`);
   if(kind==='membership'){
    await owner.db.execute(sql`insert into public.ai_model_run(id,tenant_id,user_id,feature_id,operation,provider,model,state,reserved_tokens) values(${run}::uuid,${b.tenantId}::uuid,${author.id}::uuid,'personnel_import_mapping','draft','fictional','fictional','pending',0)`);
    await owner.db.execute(sql`insert into public.employee_import_evaluation_run_membership(ai_run_id,evaluation_id,evaluation_version,slot,tenant_id,user_id,company_id,header_attempt_id) values(${run}::uuid,${evaluation}::uuid,1,1,${b.tenantId}::uuid,${author.id}::uuid,${id}::uuid,${header}::uuid)`);
   }
  }
  expect(await retained(context,id)).toBe(true);expect(await retained(member(),id)).toBe(false);
  const table={header:'personnel_import_assistance_attempt',evaluation:'employee_import_evaluation_attempt',membership:'employee_import_evaluation_run_membership'}[kind];
  expect(await withTenant(context,tx=>tx.execute(sql`select * from ${sql.identifier(table)} where company_id=${id}::uuid`))).toHaveLength(0);
  expect(await verdict(context,id)).toBe('other');expect(await attempt(context,id)).toBe('other');expect(await exists(id)).toBe(true);
  // Membership legitimately co-retains its evaluation. Exact preserved SQL branch identity is independently reviewed; this case does not claim isolated membership attribution.
 });

 for(const failure of ['wrong-owner','app-membership'] as const)it(`refuses the actual0865 preflight for ${failure} and restores the entire fixture topology`,async()=>{
  const source=readFileSync(fileURLToPath(new URL('../db/migrations/0865_assistant_company_retention_references.sql',import.meta.url)),'utf8'),preflight=source.split('--> statement-breakpoint')[0];
  expect(preflight).toContain("DO $retention$");const before=await retentionCatalog(owner.db);
  let caught:unknown;
  try{await owner.db.transaction(async tx=>{
   if(failure==='wrong-owner'){const [own]=await tx.execute<{name:string}>(sql`select pg_get_userbyid(proowner) as name from pg_proc where oid='app.ai_assistance_company_in_use(uuid)'::regprocedure`);await tx.execute(sql`alter function app.ai_assistance_company_in_use(uuid) owner to ${sql.identifier(own.name==='ai_hr_owner'?'postgres':'ai_hr_owner')}`);}
   else{
    // Isolated universal-topology counterexample, not a role profile or restricted proof.
    // All four changes roll back; no app query is executed while this unsafe edge exists.
    await tx.execute(sql`alter table public.ai_agent_promotion owner to postgres`);await tx.execute(sql`alter table app.assistant_own_leave_review owner to postgres`);await tx.execute(sql`alter function app.ai_assistance_company_in_use(uuid) owner to postgres`);
    await tx.execute(sql`grant postgres to ai_hr_app`);
   }
   await tx.execute(sql.raw(preflight));throw new Error('Fictional invalid retention topology was accepted');
  });}catch(error){caught=error;}
  expect(pgSqlState(caught)).toBe('P0001');
  // Exact migration guard, not duplicate-policy or fixture-setup refusal.
  const chain=(caught as {cause?:{message?:string}})?.cause;expect(chain?.message??(caught as Error)?.message).toBe('Company retention exact owner or app boundary unavailable');
  expect(await retentionCatalog(owner.db)).toEqual(before);
 });

});
