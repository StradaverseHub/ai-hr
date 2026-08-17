/**
 * a1d82340 STEP 5 — the consolidated pending-money view on a draft run.
 *
 * THE DEFECT THIS PINS. Money reaches a payslip through twelve doors writing five tables. The draft run
 * screen read `payroll_input` and nothing else (core/payroll.ts batchInputRows), so four of the five
 * tables — payroll_batch_component, payroll_individual_txn, employment_pay_component, and the period-keyed
 * individual rows attach-on-generate stamps on later — were INVISIBLE until after generation. An operator
 * pressed Generate without being able to see most of what they were about to pay.
 *
 * Every assertion below is written to fail if a door stops being reported, not merely to observe that the
 * function returns something. The `byDoor` roll-up is asserted against the DOOR SET, so a door silently
 * dropped from the union fails here rather than going quiet in production.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createAdditionalRun, createBatch, setPayrollInput } from '../core/payroll';
import { pendingBatchMoney } from '../core/payroll-view';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import {
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
} from '../core/pay-components';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let b: Base;

/** The context the run screen actually calls with: typed pay components ON and the individual payable
 *  fold ON, which is what makes the four previously-invisible doors reach a payslip at all. */
const payingCtx = async () => {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  await setSetting(b.tenantId, 'payroll.individual_txn_pay_enabled', true);
  return entitledCtx(b);
};

const hire = (a: ReturnType<typeof adminCtx>, name: string) =>
  hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@pm.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const componentId = async (code: string) => {
  const [row] = await owner.db
    .select({ id: schema.payComponent.id })
    .from(schema.payComponent)
    .where(eq(schema.payComponent.code, code))
    .limit(1);
  if (!row) throw new Error(`pay component ${code} not seeded`);
  return row.id;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('a1d82340 step 5 — pendingBatchMoney', () => {
  it('reports every door, not just payroll_input — the four tables the draft screen could not see', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a);
    const { employmentId } = await hire(a, 'Ana Pending');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });

    // Door 7/8/11/12 — payroll_input, the ONLY table the old screen read.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 300, bonusAmount: 1000, tp1Deduction: 150, zakat: 50 });
    // Door 4/5/6 — payroll_batch_component (file import / allowance transfer / shift differential all land here).
    await setPayrollBatchComponent(a, { batchId, employmentId, componentId: await componentId('SHIFT_DIFFERENTIAL'), amount: 220 });
    // Door 3 — payroll_individual_txn, attached to this run.
    await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 400, componentId: await componentId('COMMISSION') });
    // Door 2 — employment_pay_component, the period-active fixed transaction.
    await setEmploymentPayComponent(a, { employmentId, componentId: await componentId('HOUSING'), amount: 800, effectiveFrom: '2026-01-01' });

    const pending = await pendingBatchMoney(await payingCtx(), { batchId });
    const doors = pending.byDoor.map((d) => d.door).sort();

    // The regression guard: all four previously-invisible tables must be represented, alongside payroll_input.
    expect(doors).toEqual(['batchComponent', 'bonus', 'fixedComponent', 'individualTxn', 'overtime', 'tp1', 'zakat'].sort());
    expect(pending.employees).toBe(1);

    const amountOf = (door: string) => pending.byDoor.find((d) => d.door === door)!.total;
    expect(amountOf('overtime')).toBe(300);
    expect(amountOf('bonus')).toBe(1000);
    expect(amountOf('batchComponent')).toBe(220);
    expect(amountOf('individualTxn')).toBe(400);
    expect(amountOf('fixedComponent')).toBe(800);
    // Deductions are SIGNED NEGATIVE, so they can never be summed into the earnings figure by accident.
    expect(amountOf('tp1')).toBe(-150);
    expect(amountOf('zakat')).toBe(-50);
    expect(pending.earnings).toBe(2720);
    expect(pending.deductions).toBe(-200);
    expect(pending.inertRows).toBe(0);
  });

  it('does not report as payable what a switched-off flag stops the kernel paying — it counts it as inert', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a);
    const { employmentId } = await hire(a, 'Ed Gated');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-09' });

    // Written while the flags are off, which is the default posture. Every one of these rows exists and
    // pays NOTHING: generatePayslips never reads them.
    await setPayrollBatchComponent(a, { batchId, employmentId, componentId: await componentId('HOUSING'), amount: 300 });
    await setEmploymentPayComponent(a, { employmentId, componentId: await componentId('COLA'), amount: 150, effectiveFrom: '2026-01-01' });
    await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-09-04', amount: 90 });
    // payroll_input is NOT flag-gated — it pays either way, so it must still be reported.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 75 });

    const pending = await pendingBatchMoney(a, { batchId });
    // The flag-gated rows are counted, and kept OUT of the totals: telling the operator this run will
    // pay RM540 when it will pay RM75 is the exact failure this separation exists to prevent.
    expect(pending.inertRows).toBe(3);
    expect(pending.byDoor).toEqual([{ door: 'overtime', count: 1, total: 75 }]);
    expect(pending.earnings).toBe(75);
  });

  it('counts the period-keyed individual rows a REGULAR run will attach, and marks them as not yet attached', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a);
    const { employmentId } = await hire(a, 'Bo Unattached');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });

    // Keyed with NO batch — the "enter it before the run exists" path (0175). generatePayslips stamps
    // these onto the month's regular run, so the figure the operator checks must already include them.
    await createIndividualTxn(a, {
      companyId: b.companyId,
      payPeriod: '2026-06',
      employmentId,
      kind: 'earning',
      txnDate: '2026-06-05',
      amount: 250,
      componentId: await componentId('COMMISSION'),
    });

    const pending = await pendingBatchMoney(await payingCtx(), { batchId });
    expect(pending.byDoor).toEqual([{ door: 'individualTxn', count: 1, total: 250 }]);
    expect(pending.lines[0].note).toBe('unattached');
  });

  // c11e81aa — STILL TRUE, AND NOW FOR A SHARPER REASON. Attach-on-generate no longer refuses every
  // additional run outright; it refuses to give one a row that did not NAME its cycle. This row names
  // none, so the bonus run must still report nothing — the regular run is going to pay it.
  it('does NOT count period-keyed rows that named no pay cycle for an additional run — the regular run will pay them', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a);
    const { employmentId } = await hire(a, 'Cy Offcycle');
    // The regular run must exist first — an additional run is created alongside it, not instead of it.
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await createIndividualTxn(a, {
      companyId: b.companyId,
      payPeriod: '2026-07',
      employmentId,
      kind: 'earning',
      txnDate: '2026-07-05',
      amount: 900,
      componentId: await componentId('COMMISSION'),
    });

    // An additional run needs the multi-cycle module; without it there is no second run to test against.
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const extra = await createAdditionalRun(await entitledCtx(b), { companyId: b.companyId, payPeriod: '2026-07', runType: 'bonus' });
    // Flags ON deliberately: an empty result must prove the run-type rule, not a switched-off feature.
    const pending = await pendingBatchMoney(await payingCtx(), { batchId: extra.batchId });
    // Reporting it here would tell the operator a bonus run pays money that the regular run will pay.
    expect(pending.lines).toEqual([]);
  });

  it('excludes BASIC, zero-amount rows and record-only leave rows — none of them is a pending transaction', async () => {
    const a = adminCtx(b);
    await seedPayComponentCatalog(a);
    const { employmentId } = await hire(a, 'Di Excluded');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });

    // BASIC as a fixed component is the compensation record restated, not money added through a door.
    await setEmploymentPayComponent(a, { employmentId, componentId: await componentId('BASIC'), amount: 5000, effectiveFrom: '2026-01-01' });
    // A row written with every figure zero is not a queued transaction and must not inflate the count.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 0, bonusAmount: 0, tp1Deduction: 0, zakat: 0 });
    // 'leave' is RECORD-ONLY in v1 — the kernel folds no money from it, so neither may this card.
    await createIndividualTxn(a, { batchId, employmentId, kind: 'leave', txnDate: '2026-08-03', amount: 120 });

    const pending = await pendingBatchMoney(await payingCtx(), { batchId });
    expect(pending.lines).toEqual([]);
    expect(pending.inertRows, 'BASIC is excluded by the rule, not counted as flag-gated').toBe(0);
    expect(pending.employees).toBe(0);
    expect(pending.earnings).toBe(0);
    expect(pending.deductions).toBe(0);
  });
});
