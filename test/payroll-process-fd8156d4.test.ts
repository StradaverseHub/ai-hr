/**
 * fd8156d4 — Payroll > Payroll Process: opens on the latest created payroll period, sorts by period then
 * company A to Z then run, shows configured Payroll Cycle names, and the run View page searches the whole
 * run by name or Employee ID.
 *
 * The reads are exercised at the shape of a real group (SCALE-AND-RELEASE-RULES rule 3): 71 companies and
 * 1,000 employments, under "All companies", under one company and under a company-scoped administrator,
 * each compared with an independent oracle built from the previous reader (same rows, same counts).
 * Display and ordering only — nothing here writes a run, a period or a cycle through the product.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown as SessionContext, scopeIds: [] as string[] } }));

vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('notFound() — a route gate closed; the fixture is wrong, not the assertion');
  },
  redirect: (u: string) => {
    throw new Error(`redirect(${u})`);
  },
}));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/cache', async (orig) => ({
  ...(await orig<typeof import('next/cache')>()),
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock('next-intl/server', async (orig) => ({
  ...(await orig<typeof import('next-intl/server')>()),
  getTranslations: async () =>
    Object.assign((k: string) => k, {
      rich: (k: string) => k,
      markup: (k: string) => k,
      raw: (k: string) => k,
      has: () => true,
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/lib/scope', async (orig) => ({
  ...(await orig<typeof import('../lib/scope')>()),
  scopedAdmin: async () => ({ s: scope.s, scopeIds: scope.scopeIds }),
}));
vi.mock('@/lib/authz', async (orig) => ({
  ...(await orig<typeof import('../lib/authz')>()),
  requireAdmin: async () => scope.s,
  requireModule: async () => scope.s,
}));
vi.mock('@/lib/session', async (orig) => ({
  ...(await orig<typeof import('../lib/session')>()),
  getSession: async () => scope.s,
}));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  batchDetail,
  createBatch,
  generatePayslips,
  latestPayrollDashboardPeriod,
  listBatches,
  payrollDashboardCycleNames,
  payrollRunRegisterPage,
} from '../core/payroll';
import {
  applyFilters,
  currentTenantMonth,
  cycleFilterOptions,
  dashboardCycleKey,
  dashboardCycleLabel,
  hasExplicitPeriod,
  periodsForYear,
  resolveDashboardPeriod,
} from '../app/payroll/dashboard-logic';
import { DashboardFilterBar } from '../app/payroll/dashboard-filters';
import { Pager } from '../components/pager';
import PayrollListPage from '../app/payroll/page';
import BatchPage from '../app/payroll/[batchId]/page';
import { matchesEmployeeSearch } from '../lib/employee-search';
import { paginateRows, parsePageQuery } from '../lib/pagination';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const RUN_TYPE_LABELS = { regular: 'Regular', off_cycle: 'Off Cycle', bonus: 'Bonus', adjustment: 'Adjustment' };

// ───────────────────────────────────── pure logic ─────────────────────────────────────

describe('fd8156d4 — the default period, cycle keys and labels (pure)', () => {
  it('a bare first entry opens on the latest created period, whatever today is', () => {
    expect(hasExplicitPeriod({})).toBe(false);
    expect(resolveDashboardPeriod({}, '2026-09', 2026, 11)).toEqual({ year: 2026, months: [9] });
    // A period in another year moves the year too.
    expect(resolveDashboardPeriod({}, '2024-12', 2026, 11)).toEqual({ year: 2024, months: [12] });
    // Nothing created (or an unreadable value): the tenant's current month, exactly as before.
    expect(resolveDashboardPeriod({}, null, 2026, 11)).toEqual({ year: 2026, months: [11] });
    expect(resolveDashboardPeriod({}, '2026-13', 2026, 11)).toEqual({ year: 2026, months: [11] });
  });

  it('any explicit ?year or ?m wins over the latest period — including ?m=all and the Back round trip', () => {
    expect(resolveDashboardPeriod({ year: '2025', m: ['3', '4'] }, '2026-09', 2026, 11)).toEqual({ year: 2025, months: [3, 4] });
    expect(resolveDashboardPeriod({ year: '2025' }, '2026-09', 2026, 11)).toEqual({ year: 2025, months: [11] });
    expect(resolveDashboardPeriod({ m: 'all' }, '2026-09', 2026, 11)).toEqual({ year: 2026, months: [] });
    expect(hasExplicitPeriod({ year: '' })).toBe(true);
  });

  it('a configured cycle files under its name; a run with none under its run type', () => {
    expect(dashboardCycleKey({ runType: 'regular', payrollCycleName: ' Monthly ' })).toBe('name:monthly');
    expect(dashboardCycleKey({ runType: 'regular', payrollCycleName: '   ' })).toBe('type:regular');
    expect(dashboardCycleKey({ runType: 'adjustment', filterRunType: 'regular', payrollCycleName: null })).toBe('type:regular');
  });

  it('the column shows the cycle name, keeps the run-type word and remarks without one, and keeps "By Import"', () => {
    expect(dashboardCycleLabel({ runType: 'regular', payrollCycleName: 'Monthly' }, 'Regular')).toBe('Monthly');
    expect(dashboardCycleLabel({ runType: 'off_cycle', payrollCycleName: 'Mid-Month Advance', remarks: 'Mid-Month Advance' }, 'Off Cycle')).toBe('Mid-Month Advance');
    expect(dashboardCycleLabel({ runType: 'off_cycle', payrollCycleName: 'Advances', remarks: 'Advance Salary' }, 'Off Cycle')).toBe('Advances — Advance Salary');
    expect(dashboardCycleLabel({ runType: 'off_cycle', payrollCycleName: null, remarks: 'Advance Salary' }, 'Off Cycle')).toBe('Off Cycle — Advance Salary');
    expect(dashboardCycleLabel({ runType: 'regular', payrollCycleName: null }, 'Regular')).toBe('Regular');
    expect(
      dashboardCycleLabel(
        { runType: 'adjustment', payrollCycleName: 'Monthly', historyImportAttemptId: randomUUID(), historyImportCycleName: 'Monthly', remarks: 'x' },
        'Adjustment',
      ),
    ).toBe('Monthly - By Import');
  });

  it('options: configured names, other names on runs, run-type fallbacks, then an old selected value', () => {
    const rows = [
      { runType: 'regular', payrollCycleName: 'Monthly' },
      { runType: 'regular', payrollCycleName: 'Retired Name' },
      { runType: 'bonus', payrollCycleName: null },
      { runType: 'regular', payrollCycleName: null },
    ];
    expect(cycleFilterOptions(['Monthly', 'monthly', 'Mid-Month Advance'], rows, ['regular'], RUN_TYPE_LABELS)).toEqual([
      { value: 'name:monthly', label: 'Monthly' },
      { value: 'name:mid-month advance', label: 'Mid-Month Advance' },
      { value: 'name:retired name', label: 'Retired Name' },
      { value: 'type:regular', label: 'Regular' },
      { value: 'type:bonus', label: 'Bonus' },
      { value: 'regular', label: 'Regular' },
    ]);
  });

  it('applyFilters: name and type values match the new keys; a bare old run type still filters by run type', () => {
    const rows = [
      { id: 'a', payPeriod: '2026-05', companyId: 'c1', runType: 'regular', payrollCycleName: 'Monthly', status: 'processed' },
      { id: 'b', payPeriod: '2026-05', companyId: 'c2', runType: 'regular', payrollCycleName: null, status: 'processed' },
      { id: 'c', payPeriod: '2026-05', companyId: 'c2', runType: 'bonus', payrollCycleName: null, status: 'processed' },
    ];
    const f = (cycles: string[]) =>
      applyFilters(rows, { periods: ['2026-05'], companyIds: [], cycles, statuses: [] }).map((r) => r.id);
    expect(f(['name:monthly'])).toEqual(['a']);
    expect(f(['type:regular'])).toEqual(['b']);
    expect(f(['regular'])).toEqual(['a', 'b']);
    expect(f(['type:bonus'])).toEqual(['c']);
  });
});

// ───────────────────────────── group-shaped fixture (DB) ─────────────────────────────

type Fixture = {
  base: Base;
  root: SessionContext;
  allCompanyIds: string[];
  groupCompanyIds: string[]; // sorted by legal name
  emptyCompanyId: string;
  latestCompanies: string[];
  runBatchId: string;
  otherRunBatchId: string;
  scoped: SessionContext;
  scopedCompanyId: string;
};
let fx: Fixture;

beforeAll(async () => {
  await migrateTestDb();
  fx = await buildFixture();
}, 300_000);
afterAll(async () => {
  await closeAll();
});

const pad = (n: number) => String(n).padStart(3, '0');

async function buildFixture(): Promise<Fixture> {
  await resetDb();
  const base = await seedBase();
  const a = await entitledCtx(base);
  const root: SessionContext = { ...adminCtx(base), entitlements: a.entitlements };

  // 69 group companies, inserted in a shuffled order so the SQL order is not insertion order.
  const indices = Array.from({ length: 69 }, (_, i) => i + 1);
  const shuffled = indices.map((i) => (i * 37) % 69 || 69);
  expect(new Set(shuffled).size).toBe(69);
  const idByIndex = new Map<number, string>();
  for (const i of shuffled) {
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: `Fictional Group Co ${pad(i)}` })
      .returning({ id: schema.company.id });
    idByIndex.set(i, c.id);
  }
  const [empty] = await owner.db
    .insert(schema.company)
    .values({ tenantId: base.tenantId, legalName: 'Fictional Empty Co' })
    .returning({ id: schema.company.id });

  // Cycles: every group company has a live "Monthly"; company 7 also "Mid-Month Advance"; company 8 an
  // ARCHIVED "Retired Cycle" that must not be offered.
  const monthly = new Map<number, string>();
  let midMonth = '';
  for (const i of indices) {
    const companyId = idByIndex.get(i)!;
    const [c] = await owner.db
      .insert(schema.payrollCycle)
      .values({ tenantId: base.tenantId, companyId, name: 'Monthly', runType: 'regular', sortOrder: 0 })
      .returning({ id: schema.payrollCycle.id });
    monthly.set(i, c.id);
  }
  {
    const [c] = await owner.db
      .insert(schema.payrollCycle)
      .values({ tenantId: base.tenantId, companyId: idByIndex.get(7)!, name: 'Mid-Month Advance', runType: 'off_cycle', remarks: 'Mid-Month Advance', sortOrder: 1 })
      .returning({ id: schema.payrollCycle.id });
    midMonth = c.id;
    await owner.db.insert(schema.payrollCycle).values({
      tenantId: base.tenantId, companyId: idByIndex.get(8)!, name: 'Retired Cycle', runType: 'bonus', sortOrder: 2, archivedAt: new Date('2025-01-01'),
    });
  }

  // Runs: every group company has 2025-06 and 2025-07 regular runs; every 5th a 2025-07 bonus; companies 12
  // and 37 a 2025-09 run (the latest period). Every 10th company's regular runs carry NO configured cycle.
  const latestCompanies = [idByIndex.get(12)!, idByIndex.get(37)!];
  for (const i of indices) {
    const companyId = idByIndex.get(i)!;
    const periods = i === 12 || i === 37 ? ['2025-06', '2025-07', '2025-09'] : ['2025-06', '2025-07'];
    for (const period of periods) {
      const [pp] = await owner.db
        .insert(schema.payPeriod)
        .values({ tenantId: base.tenantId, companyId, period, status: 'open' })
        .returning({ id: schema.payPeriod.id });
      const runs: (typeof schema.payrollBatch.$inferInsert)[] = [{
        tenantId: base.tenantId, companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-28`,
        runType: 'regular', runSeq: 1, status: 'processed', employeeCount: 3,
        payrollCycleId: i % 10 === 0 ? null : monthly.get(i)!,
      }];
      if (period === '2025-07' && i % 5 === 0) {
        runs.push({ tenantId: base.tenantId, companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-15`, runType: 'bonus', runSeq: 2, status: 'draft', employeeCount: 0 });
      }
      if (period === '2025-07' && i === 7) {
        runs.push({ tenantId: base.tenantId, companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-15`, runType: 'off_cycle', runSeq: 2, status: 'closed', closedAt: new Date('2025-07-20'), releasedAt: new Date('2025-07-20'), employeeCount: 1, payrollCycleId: midMonth, remarks: 'Mid-Month Advance' });
      }
      await owner.db.insert(schema.payrollBatch).values(runs);
    }
  }

  // 1,000 employments: 400 on the base company's processed 2025-08 run (one real, 399 cloned payslips),
  // the rest spread across the group so the tenant has the shape of a real group.
  const real = await hireEmployee(a, {
    person: { fullName: 'Fictional Payee 0000', primaryEmail: `fd-real-${randomUUID()}@example.invalid` },
    companyId: base.companyId, departmentId: base.deptA, employeeCode: 'EMP-0000', employmentType: 'full_time', hiredOn: '2025-01-01',
  });
  await setCompensation(a, { employmentId: real.employmentId, basicSalary: 3000, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId: real.personId, icNumber: '900101015551' });
  const { batchId: runBatchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2025-08' });
  await generatePayslips(a, { batchId: runBatchId });
  const [actual] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, runBatchId));
  expect(actual).toBeTruthy();

  const members = Array.from({ length: 999 }, (_, k) => {
    const n = k + 1;
    const onRun = n < 400;
    const name = n === 399 ? 'Zainab Fictional' : n === 398 ? 'Yusuf Other' : `Fictional Payee ${String(n).padStart(4, '0')}`;
    const code = n === 399 ? 'ZF-9001' : n === 398 ? 'YO-7001' : `EMP-${String(n).padStart(4, '0')}`;
    return {
      personId: randomUUID(), employmentId: randomUUID(), name, code, onRun,
      companyId: onRun ? base.companyId : idByIndex.get((n % 69) + 1)!,
    };
  });
  for (let i = 0; i < members.length; i += 100) {
    const chunk = members.slice(i, i + 100);
    await owner.db.insert(schema.person).values(chunk.map((m) => ({ id: m.personId, tenantId: base.tenantId, fullName: m.name, primaryEmail: `${m.personId}@example.invalid` })));
    await owner.db.insert(schema.employment).values(chunk.map((m) => ({ id: m.employmentId, tenantId: base.tenantId, personId: m.personId, companyId: m.companyId, employeeCode: m.code, hiredOn: '2025-01-01' })));
    // Yusuf is on ANOTHER run of the company (below), not on this one.
    const slips = chunk.filter((m) => m.onRun && m.name !== 'Yusuf Other');
    if (slips.length) await owner.db.insert(schema.payslip).values(slips.map((m) => ({ ...actual, id: randomUUID(), employmentId: m.employmentId })));
  }
  // Another run of the same company (an earlier month), holding only Yusuf.
  const [otherPeriod] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: base.tenantId, companyId: base.companyId, period: '2025-05', status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [otherRun] = await owner.db
    .insert(schema.payrollBatch)
    .values({ tenantId: base.tenantId, companyId: base.companyId, payPeriodId: otherPeriod.id, payPeriod: '2025-05', batchDate: '2025-05-28', runType: 'regular', runSeq: 1, status: 'processed', employeeCount: 1 })
    .returning({ id: schema.payrollBatch.id });
  const otherRunBatchId = otherRun.id;
  const yusuf = members.find((m) => m.name === 'Yusuf Other')!;
  await owner.db.insert(schema.payslip).values({ ...actual, id: randomUUID(), batchId: otherRunBatchId, employmentId: yusuf.employmentId });
  for (const t of ['person', 'employment', 'payslip', 'payroll_batch', 'pay_period', 'payroll_cycle', 'company']) await owner.client.unsafe('analyze public.' + t);

  // A company-scoped administrator for company 9.
  const scopedCompanyId = idByIndex.get(9)!;
  const userId = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.db.update(schema.roleAssignment).set({ companyId: scopedCompanyId }).where(eq(schema.roleAssignment.appUserId, userId));
  const scoped: SessionContext = { ...root, userId, grants: [{ role: 'hr_admin', companyId: scopedCompanyId }] };

  const groupCompanyIds = indices.map((i) => idByIndex.get(i)!);
  return {
    base, root, allCompanyIds: [base.companyId, ...groupCompanyIds, empty.id], groupCompanyIds,
    emptyCompanyId: empty.id, latestCompanies, runBatchId, otherRunBatchId, scoped, scopedCompanyId,
  };
}

/** Elements of a rendered server tree that satisfy `pick`, depth first. */
function findAll(node: unknown, pick: (el: { type?: unknown; key?: unknown; props?: Record<string, unknown> }) => boolean, acc: unknown[] = []): unknown[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pick, acc);
    return acc;
  }
  const el = node as { type?: unknown; key?: unknown; props?: Record<string, unknown> };
  if (pick(el)) acc.push(el);
  if (el.props) for (const v of Object.values(el.props)) findAll(v, pick, acc);
  return acc;
}
/** Every string child in a rendered server tree (the identity translator renders keys as text). */
function strings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) for (const n of node) strings(n, acc);
  else if (node && typeof node === 'object') {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const v of Object.values(props)) strings(v, acc);
  }
  return acc;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rowIds = (tree: unknown) =>
  (findAll(tree, (el) => el.type === 'tr' && typeof el.key === 'string' && UUID.test(el.key)) as { key: string }[]).map((el) => el.key);
const filterBar = (tree: unknown) =>
  (findAll(tree, (el) => el.type === DashboardFilterBar)[0] as { props: { filters: { year: number; months: number[] }; cycleOptions: { value: string; label: string }[] } }).props;

type BatchRow = Awaited<ReturnType<typeof listBatches>>[number];
const dashboardOrder = (a: BatchRow, b: BatchRow) =>
  (a.payPeriod < b.payPeriod ? 1 : a.payPeriod > b.payPeriod ? -1 : 0) ||
  (a.company < b.company ? -1 : a.company > b.company ? 1 : 0) ||
  a.runSeq - b.runSeq ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe('fd8156d4 — dashboard reads at group shape (71 companies, 1,000 employments)', () => {

  it('latest created period: All companies, one company, a scoped administrator and an empty scope', async () => {
    const all = await listBatches(fx.root, fx.allCompanyIds);
    const oracle = (rows: BatchRow[]) => rows.reduce<string | null>((m, r) => (m == null || r.payPeriod > m ? r.payPeriod : m), null);
    expect(await latestPayrollDashboardPeriod(fx.root, fx.allCompanyIds)).toBe('2025-09');
    expect(await latestPayrollDashboardPeriod(fx.root, fx.allCompanyIds)).toBe(oracle(all));
    expect(await latestPayrollDashboardPeriod(fx.root, [fx.groupCompanyIds[0]])).toBe('2025-07');
    expect(await latestPayrollDashboardPeriod(fx.root, [fx.base.companyId])).toBe('2025-08');
    expect(await latestPayrollDashboardPeriod(fx.root, [fx.emptyCompanyId])).toBeNull();
    // The scoped administrator sees only company 9, whatever scope is asked for.
    expect(await latestPayrollDashboardPeriod(fx.scoped, fx.allCompanyIds)).toBe(oracle(await listBatches(fx.scoped, fx.allCompanyIds)));
    expect(await latestPayrollDashboardPeriod(fx.scoped, fx.allCompanyIds)).toBe('2025-07');
  });

  it('sort: period desc, company A to Z, run — the same rows and counts as the previous reader, every scope and role', async () => {
    for (const [ctx, companies] of [
      [fx.root, fx.allCompanyIds],
      [fx.root, [fx.groupCompanyIds[6]]],
      [fx.scoped, fx.allCompanyIds],
      [fx.scoped, [fx.scopedCompanyId]],
    ] as const) {
      const previous = await listBatches(ctx, [...companies], periodsForYear(2025));
      const sorted = await listBatches(ctx, [...companies], periodsForYear(2025), undefined, 'company');
      expect(sorted.length).toBeGreaterThan(0);
      expect(sorted).toHaveLength(previous.length);
      expect(sorted).toEqual([...previous].sort(dashboardOrder));
    }
    const july = (await listBatches(fx.root, fx.allCompanyIds, ['2025-07'], undefined, 'company'));
    // Two companies in one period are A to Z, and within a company the runs follow their sequence.
    expect(july[0].company).toBe('Fictional Group Co 001');
    expect(july.at(-1)!.company).toBe('Fictional Group Co 069');
    const co5 = july.filter((r) => r.companyId === fx.groupCompanyIds[4]).map((r) => [r.runSeq, r.runType]);
    expect(co5).toEqual([[1, 'regular'], [2, 'bonus']]);
    // The default order other callers rely on is unchanged.
    const legacy = await listBatches(fx.root, fx.allCompanyIds, ['2025-07']);
    expect(legacy.map((r) => r.runSeq)).toEqual([...legacy].sort((a, b) => a.runSeq - b.runSeq).map((r) => r.runSeq));
  });

  it('cycle names: live names in scope, de-duplicated across seventy companies, archived names left out', async () => {
    expect(await payrollDashboardCycleNames(fx.root, fx.allCompanyIds)).toEqual(['Monthly', 'Mid-Month Advance']);
    expect(await payrollDashboardCycleNames(fx.root, [fx.groupCompanyIds[0]])).toEqual(['Monthly']);
    expect(await payrollDashboardCycleNames(fx.root, [fx.emptyCompanyId])).toEqual([]);
    expect(await payrollDashboardCycleNames(fx.scoped, fx.allCompanyIds)).toEqual(['Monthly']);
  });

  it('cycle filter: every run is reachable, names match configured runs, and an old ?cycle=regular keeps its meaning', async () => {
    const rows = await listBatches(fx.root, fx.allCompanyIds, periodsForYear(2025), undefined, 'company');
    const names = await payrollDashboardCycleNames(fx.root, fx.allCompanyIds);
    const options = cycleFilterOptions(names, rows, [], RUN_TYPE_LABELS);
    const f = (cycles: string[]) => applyFilters(rows, { periods: periodsForYear(2025), companyIds: [], cycles, statuses: [] });
    for (const r of rows) expect(options.some((o) => f([o.value]).includes(r)), `run ${r.id} must be filterable`).toBe(true);
    expect(f(['name:monthly']).every((r) => r.payrollCycleName === 'Monthly')).toBe(true);
    expect(f(['name:monthly'])).toHaveLength(rows.filter((r) => r.payrollCycleName === 'Monthly').length);
    expect(f(['name:mid-month advance']).map((r) => r.runType)).toEqual(['off_cycle']);
    expect(f(['type:regular']).every((r) => r.runType === 'regular' && r.payrollCycleName == null)).toBe(true);
    expect(f(['type:regular']).length).toBeGreaterThan(0);
    // Old link: exactly the rows the previous filter (run type) returned.
    expect(f(['regular'])).toEqual(rows.filter((r) => (r.filterRunType ?? r.runType) === 'regular'));
  });

  it('the page opens on the latest created period under All companies, sorted, with cycle names in the dropdown', async () => {
    scope.s = fx.root;
    scope.scopeIds = fx.allCompanyIds;
    const tree = await PayrollListPage({ searchParams: Promise.resolve({}) });
    const bar = filterBar(tree);
    expect(bar.filters.year).toBe(2025);
    expect(bar.filters.months).toEqual([9]);
    // Not the calendar month: the fixture's latest period is in a past year.
    expect(`${bar.filters.year}-${bar.filters.months[0]}`).not.toBe(`${todayInKualaLumpur().slice(0, 4)}-${currentTenantMonth()}`);
    const sep = (await listBatches(fx.root, fx.allCompanyIds, ['2025-09'])).filter((r) => fx.latestCompanies.includes(r.companyId));
    expect(rowIds(tree)).toEqual([...sep].sort(dashboardOrder).map((r) => r.id));
    expect(bar.cycleOptions.slice(0, 2)).toEqual([
      { value: 'name:monthly', label: 'Monthly' },
      { value: 'name:mid-month advance', label: 'Mid-Month Advance' },
    ]);
  });

  it('the page: one company opens on that company\'s latest period; explicit params win; an empty scope falls back', async () => {
    scope.s = fx.root;
    scope.scopeIds = fx.allCompanyIds;
    let bar = filterBar(await PayrollListPage({ searchParams: Promise.resolve({ company: fx.base.companyId }) }));
    expect([bar.filters.year, bar.filters.months]).toEqual([2025, [8]]);
    bar = filterBar(await PayrollListPage({ searchParams: Promise.resolve({ year: '2025', m: '6' }) }));
    expect([bar.filters.year, bar.filters.months]).toEqual([2025, [6]]);
    scope.scopeIds = [fx.emptyCompanyId];
    bar = filterBar(await PayrollListPage({ searchParams: Promise.resolve({}) }));
    expect([bar.filters.year, bar.filters.months]).toEqual([Number(todayInKualaLumpur().slice(0, 4)), [currentTenantMonth()]]);
  });

  it('the page: a full page of July 2025 under All companies is the SQL order, and a cycle name filters it', async () => {
    scope.s = fx.root;
    scope.scopeIds = fx.allCompanyIds;
    const july = await listBatches(fx.root, fx.allCompanyIds, ['2025-07']);
    const tree = await PayrollListPage({ searchParams: Promise.resolve({ year: '2025', m: '7', size: '50' }) });
    expect(rowIds(tree)).toEqual([...july].sort(dashboardOrder).slice(0, 50).map((r) => r.id));
    const named = await PayrollListPage({ searchParams: Promise.resolve({ year: '2025', m: '7', cycle: 'name:mid-month advance' }) });
    expect(rowIds(named)).toEqual(july.filter((r) => r.payrollCycleName === 'Mid-Month Advance').map((r) => r.id));
  });
});

describe('fd8156d4 — run View page search over the whole run', () => {
  const oracle = async (q: string, raw: { page?: string; size?: string } = {}) => {
    const detail = await batchDetail(fx.root, fx.runBatchId);
    const rows = detail!.slips
      .filter((s) => matchesEmployeeSearch(s, q))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
      .map(({ totalDeductions: _d, employerCost: _c, ...row }) => row);
    return paginateRows(rows, parsePageQuery(raw));
  };

  it('finds by name and by Employee ID with and without separators, on any page, and counts the matches', async () => {
    const all = await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery());
    expect(all!.runPayslipCount).toBe(399);
    expect(all!.slipPage.state.total).toBe(399);
    // Zainab sorts LAST, so she is never on the first page of the unfiltered register.
    expect(all!.slipPage.rows.some((r) => r.name === 'Zainab Fictional')).toBe(false);
    for (const q of ['zainab', 'ZAINAB fict', 'ZF-9001', 'zf9001', 'ZF 9001', 'zf_9001', 'f-90']) {
      const r = await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery(), q);
      expect(r!.slipPage.rows.map((x) => x.name), q).toEqual(['Zainab Fictional']);
      expect(r!.slipPage.state.total, q).toBe(1);
      expect(r!.runPayslipCount, q).toBe(399);
    }
  });

  it('matches lib/employee-search exactly, with paging over the filtered population', async () => {
    for (const [q, raw] of [
      ['Fictional Payee 03', {}],
      ['Fictional Payee 03', { page: '3', size: '25' }],
      ['emp01', { size: '50' }],
      ['EMP 0', { page: '7', size: '25' }],
      ['  payee  ', { size: 'all' }],
      ['', {}],
    ] as const) {
      const r = await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery(raw), q);
      expect(r!.slipPage, JSON.stringify([q, raw])).toEqual(await oracle(q, raw));
    }
    const payee03 = await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery(), 'Fictional Payee 03');
    // 0300 … 0397: 0398 and 0399 are Yusuf (another run) and Zainab.
    expect(payee03!.slipPage.state.total).toBe(98);
    expect(payee03!.slipPage.rows).toHaveLength(25);
  });

  it('LIKE wildcards are literal, the search is confined to the run, and other tenants see nothing', async () => {
    for (const q of ['%', '_', 'Payee%03', '\\']) {
      const r = await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery(), q);
      expect(r!.slipPage.state.total, q).toBe(0);
      expect(r!.slipPage.rows, q).toEqual([]);
    }
    expect((await payrollRunRegisterPage(fx.root, fx.runBatchId, parsePageQuery(), 'yusuf'))!.slipPage.state.total).toBe(0);
    const other = await payrollRunRegisterPage(fx.root, fx.otherRunBatchId, parsePageQuery(), 'yusuf');
    expect(other!.slipPage.rows.map((r) => r.name)).toEqual(['Yusuf Other']);
    const foreign = adminCtx(await seedBase());
    expect(await payrollRunRegisterPage(foreign, fx.runBatchId, parsePageQuery(), 'zainab')).toBeNull();
    expect(await payrollRunRegisterPage(fx.scoped, fx.runBatchId, parsePageQuery(), 'zainab')).toBeNull();
  });

  it('the page carries ?q through the pager, shows the match count and a clear link, and keeps the run actions on the run', async () => {
    scope.s = fx.root;
    scope.scopeIds = fx.allCompanyIds;
    const from = '/payroll?year=2025&m=8';
    const tree = await BatchPage({
      params: Promise.resolve({ batchId: fx.runBatchId }),
      searchParams: Promise.resolve({ q: 'zf9001', from }),
    });
    const pager = findAll(tree, (el) => el.type === Pager && el.props?.basePath === `/payroll/${fx.runBatchId}`)[0] as {
      props: { state: { total: number }; params: Record<string, unknown> };
    };
    expect(pager.props.state.total).toBe(1);
    expect(pager.props.params).toMatchObject({ q: 'zf9001', from });
    const search = findAll(tree, (el) => el.type === 'input' && el.props?.name === 'q')[0] as { props: { defaultValue: string } };
    expect(search.props.defaultValue).toBe('zf9001');
    const clearHref = `/payroll/${fx.runBatchId}?from=${encodeURIComponent(from)}`;
    expect(findAll(tree, (el) => el.props?.href === clearHref)).toHaveLength(1);
    const words = strings(tree);
    expect(words).toContain('registerSearchSummary');
    expect(words).toContain('registerSearchClear');
    const plain = await BatchPage({ params: Promise.resolve({ batchId: fx.runBatchId }), searchParams: Promise.resolve({}) });
    const plainPager = findAll(plain, (el) => el.type === Pager && el.props?.basePath === `/payroll/${fx.runBatchId}`)[0] as { props: { state: { total: number }; params: Record<string, unknown> } };
    expect(plainPager.props.state.total).toBe(399);
    expect(plainPager.props.params.q).toBeUndefined();
    expect(strings(plain)).not.toContain('registerSearchSummary');
    // Nothing about the run changed.
    const [run] = await owner.db.select({ status: schema.payrollBatch.status, employeeCount: schema.payrollBatch.employeeCount }).from(schema.payrollBatch).where(and(eq(schema.payrollBatch.id, fx.runBatchId)));
    expect(run.status).toBe('processed');
  });
});
