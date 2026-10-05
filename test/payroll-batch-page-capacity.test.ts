import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { client } from '../db/client';
import { batchDetail, batchDetailPage } from '../core/payroll';
import { ALL_ROW_CEILING, parsePageQuery } from '../lib/pagination';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
let otherTenant: Base;
let batchId: string;
let otherCompanyBatchId: string;
let firstPersonId: string;
let firstUserId: string;
const POPULATION = 4001;
// Deliberately distinct from a visible page's sum: these are saved full-run figures, not recomputed UI totals.
const TOTALS = { gross: 987654.32, net: 765432.10, employerCost: 1098765.43 };

async function seedRun(companyId: string, population: number) {
  const [period] = await owner.db.insert(schema.payPeriod).values({
    tenantId: base.tenantId, companyId, period: '2026-01',
  }).returning();
  const [batch] = await owner.db.insert(schema.payrollBatch).values({
    tenantId: base.tenantId, companyId, payPeriodId: period.id, payPeriod: period.period,
    batchDate: '2026-01-31', status: 'processed', employeeCount: population, totals: TOTALS,
  }).returning();
  const people = Array.from({ length: population }, (_, index) => ({
    id: randomUUID(), tenantId: base.tenantId,
    // Duplicate display names exercise the stable id tie-breaker between pages.
    fullName: `Employee ${String(Math.floor(index / 2)).padStart(5, '0')}`,
    primaryEmail: `capacity-${companyId}-${index}@fixture.invalid`,
  }));
  const employees = people.map((person, index) => ({
    id: randomUUID(), tenantId: base.tenantId, companyId, personId: person.id,
    employeeCode: `PAGE-${companyId}-${index}`, hiredOn: '2025-01-01',
  }));
  await owner.db.insert(schema.person).values(people);
  await owner.db.insert(schema.employment).values(employees);
  // Chunk setup only to stay below PostgreSQL's parameter count; the read under test is real app-role SQL.
  for (let from = 0; from < employees.length; from += 500) {
    await owner.db.insert(schema.payslip).values(employees.slice(from, from + 500).map(employee => ({
      tenantId: base.tenantId, batchId: batch.id, employmentId: employee.id,
      basicSalary: '1000.00', grossPay: '1000.00', totalDeductions: '100.00',
      netPay: '900.00', employerCost: '1100.00', statutory: { version: 'fixture', evidence: 'x'.repeat(1024) },
    })));
  }
  return { batchId: batch.id, firstPersonId: people[0].id };
}

describe('payroll batch display at 4,000 employees — bounded rows, complete totals and scope', () => {
  beforeAll(async () => {
    await migrateTestDb();
    await resetDb();
    base = await seedBase();
    otherTenant = await seedBase();
    ({ batchId, firstPersonId } = await seedRun(base.companyId, POPULATION));
    const [employeeUser] = await owner.db.insert(schema.appUser).values({
      tenantId: base.tenantId, personId: firstPersonId, workosUserId: `fixture_${randomUUID()}`,
    }).returning();
    firstUserId = employeeUser.id;
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: firstUserId, role: 'employee' });
    const [otherCompany] = await owner.db.insert(schema.company).values({
      tenantId: base.tenantId, legalName: 'Other Company',
    }).returning();
    ({ batchId: otherCompanyBatchId } = await seedRun(otherCompany.id, 1));
  }, 60_000);
  afterAll(closeAll);

  it('returns 25 rows from a 4,001-slip run with deterministic next-page navigation and full saved totals', async () => {
    const context = adminCtx(base);
    const first = await batchDetailPage(context, batchId, parsePageQuery());
    const next = await batchDetailPage(context, batchId, parsePageQuery({ page: '1' }));
    const repeated = await batchDetailPage(context, batchId, parsePageQuery());
    expect(first!.slipPage.rows).toHaveLength(25);
    expect(next!.slipPage.rows).toHaveLength(25);
    expect(first!.slipPage.rows).toEqual(repeated!.slipPage.rows);
    const firstIds = new Set(first!.slipPage.rows.map(row => row.id));
    expect(next!.slipPage.rows.every(row => !firstIds.has(row.id))).toBe(true);
    expect(first!.slipPage.state).toMatchObject({ total: POPULATION, from: 1, to: 25, hasNext: true });
    expect(next!.slipPage.state).toMatchObject({ total: POPULATION, from: 26, to: 50, hasPrev: true });
    expect(first!.batch.totals).toEqual(TOTALS);
    expect(next!.batch.totals).toEqual(TOTALS);
  });

  it('keeps the last employee reachable and the full count on an empty page', async () => {
    const context = adminCtx(base);
    const last = await batchDetailPage(context, batchId, parsePageQuery({ page: '160' }));
    expect(last!.slipPage.rows).toHaveLength(1);
    expect(last!.slipPage.state).toMatchObject({ total: POPULATION, from: POPULATION, to: POPULATION, hasNext: false });
    const empty = await batchDetailPage(context, batchId, parsePageQuery({ page: '161' }));
    expect(empty!.slipPage.rows).toEqual([]);
    expect(empty!.slipPage.state).toMatchObject({ total: POPULATION, from: 0, to: 0, hasPrev: true });
    expect(empty!.batch.totals).toEqual(TOTALS);
  });

  it('limits the actual SQL row read before transferring statutory snapshots', async () => {
    const connection = client as unknown as { options: { debug?: unknown } };
    const previous = connection.options.debug;
    const reads: string[] = [];
    connection.options.debug = (_id: number, text: string) => {
      if (/from "payslip"/.test(text) && /"statutory"/.test(text)) reads.push(text);
    };
    try {
      await batchDetailPage(adminCtx(base), batchId, parsePageQuery({ page: '1' }));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatch(/\blimit \$\d+ offset \$\d+/i);
    } finally { connection.options.debug = previous; }
  });

  it('caps All honestly and normalizes a forged limit instead of fetching the full run', async () => {
    const context = adminCtx(base);
    const all = await batchDetailPage(context, batchId, parsePageQuery({ size: 'all' }));
    expect(all!.slipPage.rows).toHaveLength(ALL_ROW_CEILING);
    expect(all!.slipPage.state).toMatchObject({ total: POPULATION, truncated: true });
    const forged = await batchDetailPage(context, batchId, { ...parsePageQuery(), limit: 999_999, offset: 999_999 });
    expect(forged!.slipPage.rows).toHaveLength(25);
    expect(forged!.slipPage.state).toMatchObject({ total: POPULATION, limit: 25, offset: 0 });
  });

  it('preserves the complete legacy reader used by processing and exports', async () => {
    const full = await batchDetail(adminCtx(base), batchId);
    expect(full!.slips).toHaveLength(POPULATION);
    expect(Object.keys(full!).sort()).toEqual(['batch', 'slips']);
    expect(full!.batch.totals).toEqual(TOTALS);
    const second = await batchDetailPage(adminCtx(base), batchId, parsePageQuery({ page: '1' }));
    expect(second!.slipPage.rows).toEqual(full!.slips.slice(25, 50));
  });

  it('does not expose rows, counts or batch totals across tenant or company grants', async () => {
    const query = parsePageQuery();
    expect(await batchDetailPage(adminCtx(otherTenant), batchId, query)).toBeNull();
    const scoped = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    expect((await batchDetailPage(scoped, batchId, query))!.slipPage.state.total).toBe(POPULATION);
    expect(await batchDetailPage(scoped, otherCompanyBatchId, query)).toBeNull();
  });

  it('refuses whole-run totals to an employee whose own payslip is visible through RLS', async () => {
    const employee = { ...adminCtx(base), userId: firstUserId, personId: firstPersonId, roles: ['employee'] };
    const own = await batchDetail(employee, batchId);
    expect(own!.slips).toHaveLength(1); // positive witness: refusal below is the administrative gate, not an empty fixture
    expect(await batchDetailPage(employee, batchId, parsePageQuery())).toBeNull();
  });

  it('wires the screen to the bounded reader and uses full counts for headers and Close', () => {
    const page = readFileSync(new URL('../app/payroll/[batchId]/page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('batchDetailPage(s, batchId, parsePageQuery(sp))');
    expect(page).toContain('const slipCount = slipPage.state.total');
    expect(page).toContain("t('closeConfirmBody', { n: slipCount })");
    expect(page).toContain("title={t('payslipsTitle')} count={slipCount}");
    expect(page).not.toMatch(/paginateRows\(slips|\bslips\.length/);
  });
});
