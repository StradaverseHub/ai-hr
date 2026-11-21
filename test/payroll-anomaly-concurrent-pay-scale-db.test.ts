import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { employment, payPeriod, payrollBatch, payslip } from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';

const period = '2026-11';
const projection = { id: employment.id, personId: employment.personId };
type PaidEmployment = { id: string; personId: string };

async function existingConcurrentPayRows(tx: Tx) {
  const slips = await tx.select({ employmentId: payslip.employmentId, batchId: payslip.batchId })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(eq(payrollBatch.payPeriod, period));
  const ids = [...new Set(slips.map(row => row.employmentId))];
  const rows = ids.length
    ? await tx.select(projection).from(employment).where(inArray(employment.id, ids))
    : [];
  return { rows, slipCount: slips.length };
}

async function subjectBoundConcurrentPayRows(tx: Tx, personIds: string[]) {
  return tx.select(projection).from(employment).where(and(
    inArray(employment.personId, personIds),
    sql`exists (
      select 1 from ${payslip}
      join ${payrollBatch} on ${payrollBatch.id} = ${payslip.batchId}
      where ${payslip.employmentId} = ${employment.id} and ${payrollBatch.payPeriod} = ${period}
    )`,
  ));
}

const sorted = (rows: PaidEmployment[]) => [...rows].sort((left, right) => left.id.localeCompare(right.id));

async function compare(ctx: SessionContext, personIds: string[]) {
  return withTenant(ctx, async tx => {
    const times = { existing: [] as number[], bounded: [] as number[] };
    const existing = () => existingConcurrentPayRows(tx);
    const bounded = () => subjectBoundConcurrentPayRows(tx, personIds);
    const relevant = new Set(personIds);
    const time = async <T>(run: () => Promise<T>, samples: number[]) => {
      const start = performance.now();
      const result = await run();
      samples.push(performance.now() - start);
      return result;
    };
    const warm = await existing();
    await bounded();
    for (let pair = 0; pair < 8; pair++) {
      const old = () => time(existing, times.existing);
      const next = () => time(bounded, times.bounded);
      let control: Awaited<ReturnType<typeof old>>;
      let candidate: Awaited<ReturnType<typeof next>>;
      if (pair % 2 === 0) {
        control = await old();
        candidate = await next();
      } else {
        candidate = await next();
        control = await old();
      }
      expect(sorted(candidate)).toEqual(sorted(control.rows.filter(row => relevant.has(row.personId))));
    }
    const median = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
    return {
      rows: await bounded(),
      existingPayslips: warm.slipCount,
      existingEmployments: warm.rows.length,
      existingMedianMs: median(times.existing),
      boundedMedianMs: median(times.bounded),
    };
  });
}

afterAll(closeAll);

it('bounds the concurrent-pay check to the evaluated people and preserves visible paid employments', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const { companyIds, employmentIds, personas, singleCompanyId } = await buildScaleFixture(base, { employments: 1025, events: 0 });
  expect(companyIds.length).toBeGreaterThanOrEqual(70);
  const staff = await owner.db.select({ ...projection, companyId: employment.companyId }).from(employment)
    .where(inArray(employment.id, employmentIds));
  expect(staff.length).toBeGreaterThanOrEqual(1000);
  const local = staff.filter(row => row.companyId === singleCompanyId);
  expect(local.length).toBeGreaterThan(1);
  const subject = local[0];
  const [crossCompany] = await owner.db.insert(employment).values({
    tenantId: base.tenantId,
    companyId: base.companyId,
    personId: subject.personId,
    hiredOn: '2024-01-01',
    employeeCode: 'FX-SECOND-PAY',
  }).returning({ ...projection, companyId: employment.companyId });
  const payslipStaff = [...staff, crossCompany];
  const staffedCompanies = [...new Set(payslipStaff.map(row => row.companyId))];
  const periods = await owner.db.insert(payPeriod).values(staffedCompanies.map(companyId => ({
    tenantId: base.tenantId, companyId, period, status: 'open',
  }))).returning({ id: payPeriod.id, companyId: payPeriod.companyId });
  const batches = await owner.db.insert(payrollBatch).values(periods.map(row => ({
    tenantId: base.tenantId, companyId: row.companyId, payPeriodId: row.id, payPeriod: period,
    batchDate: period + '-28', status: 'processed',
  }))).returning({ id: payrollBatch.id, companyId: payrollBatch.companyId });
  const batchByCompany = new Map(batches.map(row => [row.companyId, row.id]));
  for (let start = 0; start < payslipStaff.length; start += 250) {
    await owner.db.insert(payslip).values(payslipStaff.slice(start, start + 250).map(row => ({
      tenantId: base.tenantId, batchId: batchByCompany.get(row.companyId)!, employmentId: row.id,
      basicSalary: '5000', grossPay: '5000', statutory: {}, totalDeductions: '0', netPay: '5000', employerCost: '5000',
    })));
  }
  await owner.db.execute(sql`analyze public.payslip, public.payroll_batch, public.employment`);

  const personIds = local.map(row => row.personId);
  for (const [role, ctx] of Object.entries(personas)) {
    const { rows, ...timing } = await compare(ctx, personIds);
    expect(rows.filter(row => row.personId === subject.personId).map(row => row.id).sort()).toEqual(
      (role === 'single' ? [subject.id] : [subject.id, crossCompany.id]).sort(),
    );
    expect(rows.length).toBe(local.length + (role === 'single' ? 0 : 1));
    if (role === 'group') expect(timing.existingPayslips).toBeGreaterThanOrEqual(1000);
    console.info('Payroll concurrent-pay query proof', JSON.stringify({ role, ...timing, boundedEmployments: rows.length }));
  }
}, 180_000);
