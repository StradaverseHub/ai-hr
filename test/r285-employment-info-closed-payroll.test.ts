/**
 * r285 (feedback a3a3acd6) — the closed-payroll gate on Employment Information.
 *
 * `setEmploymentInfo` had NO closed-period check of any kind: a confirmation date or a resignation date
 * could be typed over inside a payroll month that was already closed, with nothing stopping it, while
 * compensation, recurring pay items and Movement corrections all refuse exactly that. This suite pins the
 * gate that closes it AND — just as hard — the edits it must keep letting through.
 *
 * THE FAILURE MODE THIS SUITE EXISTS TO PREVENT is not the missing refusal. It is the over-broad one: a
 * blanket "this employment has a closed month ⇒ nothing may be saved" would stop somebody editing a
 * contract remark because January is closed. `refuses nothing when the changed field cannot move a closed
 * result` is the assertion that pins it, and it is the reason the gate is written per-threshold rather than
 * per-save.
 *
 * The gate is scoped to the two thresholds the derived Employee Status is built from — the probation
 * threshold (`finalConfirmationDate ?? confirmationDate`) and the lifecycle-end threshold
 * (`least(resignationDate, lastWorkingDate, terminatedOn)`) — and it refuses only when the SPAN between the
 * stored value and the incoming one covers a closed payroll month. So a correction that stays inside an
 * open month is allowed even though a closed month exists on the same employment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createMovementEvent } from '../core/movement';
import * as schema from '../db/schema';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

async function hire(hiredOn = '2026-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Payroll Gate', primaryEmail: `pg_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn,
  });
  return r.employmentId;
}

/** A CLOSED payroll run that paid this employment in `period` ('YYYY-MM') — the same fixture shape
 *  test/movement-corrections.test.ts uses, because `closedPeriodsTx` is the same helper both gates read. */
async function closedPayrollFor(employmentId: string, period: string) {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'closed' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-25`,
      status: 'closed',
    })
    .returning({ id: schema.payrollBatch.id });
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId: batch.id,
    employmentId,
    basicSalary: '4000.00',
    grossPay: '4000.00',
    statutory: {},
    totalDeductions: '0.00',
    netPay: '4000.00',
    employerCost: '4000.00',
  });
}

async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select({
      confirmationDate: schema.employment.confirmationDate,
      finalConfirmationDate: schema.employment.finalConfirmationDate,
      resignationDate: schema.employment.resignationDate,
      lastWorkingDate: schema.employment.lastWorkingDate,
      tenderResignationDate: schema.employment.tenderResignationDate,
      contractRemark: schema.employment.contractRemark,
      probationValue: schema.employment.probationValue,
      resignationNoticeMonths: schema.employment.resignationNoticeMonths,
    })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

describe('setEmploymentInfo — a closed payroll month refuses the dates it relied on', () => {
  it('refuses a confirmation date whose span covers a closed payroll month, and writes nothing', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    // From NULL (never on probation) to 2026-04-01 makes the employee retroactively on probation for every
    // day before April — January included — which is what decided their confirmed_only leave eligibility
    // in the month the closed run priced.
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: id, confirmationDate: '2026-04-01' }),
    ).rejects.toThrow(/closed payroll run relied on this date/i);

    const row = await employmentRow(id);
    expect(row.confirmationDate).toBeNull();
    expect(row.finalConfirmationDate).toBeNull();
  });

  it('gives the same reopen instruction the Movement correction gives', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: id, confirmationDate: '2026-04-01' }),
    ).rejects.toThrow(/Reopen that payroll before correcting/i);
  });

  it('refuses a resignation date that reaches back into a closed payroll month', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');
    // Setting an end date of 2026-01-20 flips the derived status to Resigned from that day ONWARD — an
    // open-ended window, and its first day sits inside the closed month.
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: id, resignationDate: '2026-01-20' }),
    ).rejects.toThrow(/closed payroll run relied on this date/i);
    expect((await employmentRow(id)).resignationDate).toBeNull();
  });

  it('refuses a last working date that reaches back into a closed payroll month', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: id, lastWorkingDate: '2026-01-31' }),
    ).rejects.toThrow(/closed payroll run relied on this date/i);
    expect((await employmentRow(id)).lastWorkingDate).toBeNull();
  });
});

describe('setEmploymentInfo — the gate is scoped by FIELD, so legitimate edits still save', () => {
  /**
   * THE LOAD-BEARING ASSERTION. A blanket refusal keyed on "this employment has a closed month" would fail
   * here, and this is the failure mode the item was built to avoid. The contract remark is free text with no
   * reader but the screen — a closed January cannot possibly depend on it.
   */
  it('refuses nothing when the changed field cannot move a closed result — contract remark', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    await setEmploymentInfo(adminCtx(b), {
      employmentId: id,
      contractRemark: 'Renewable upon performance review',
    });

    expect((await employmentRow(id)).contractRemark).toBe('Renewable upon performance review');
  });

  it('refuses nothing when the changed fields are notice/probation periods — display and import read them, payroll does not', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    await setEmploymentInfo(adminCtx(b), {
      employmentId: id,
      probationValue: 6,
      probationUnit: 'month',
      resignationNoticeMonths: 2,
    });

    const row = await employmentRow(id);
    expect(row.probationValue).toBe(6);
    expect(row.resignationNoticeMonths).toBe(2);
  });

  it('refuses nothing when the tender resignation date moves — it is not one of the three dates least() takes', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    await setEmploymentInfo(adminCtx(b), { employmentId: id, tenderResignationDate: '2026-01-05' });

    expect((await employmentRow(id)).tenderResignationDate).toBe('2026-01-05');
  });

  it('allows a confirmation-date correction whose whole span sits in OPEN months', async () => {
    const id = await hire('2026-01-01');
    // Stored before the month closes, so the correction below moves the threshold only within April.
    await setEmploymentInfo(adminCtx(b), { employmentId: id, confirmationDate: '2026-04-01' });
    await closedPayrollFor(id, '2026-01');

    await setEmploymentInfo(adminCtx(b), { employmentId: id, confirmationDate: '2026-04-15' });

    const row = await employmentRow(id);
    expect(row.confirmationDate).toBe('2026-04-15');
    expect(row.finalConfirmationDate).toBe('2026-04-15');
  });

  it('allows a FUTURE resignation date — the day the status flips is after every closed month', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    await setEmploymentInfo(adminCtx(b), { employmentId: id, resignationDate: '2026-06-30' });

    expect((await employmentRow(id)).resignationDate).toBe('2026-06-30');
  });

  /** The reporter's own case: TEST0015, hired mid-February, zero payslips. Nothing is closed for them, so
   *  nothing about this gate may touch their save. */
  it('allows every date on an employment that no closed payroll run ever paid', async () => {
    const id = await hire('2026-02-14');

    await setEmploymentInfo(adminCtx(b), {
      employmentId: id,
      confirmationDate: '2026-05-14',
      resignationDate: '2026-03-01',
      lastWorkingDate: '2026-03-31',
    });

    const row = await employmentRow(id);
    expect(row.confirmationDate).toBe('2026-05-14');
    expect(row.resignationDate).toBe('2026-03-01');
  });
});

describe('setEmploymentInfo — a MOVEMENT keeps the posture the Movement module already decided', () => {
  /**
   * The gate is deliberately not applied to a tagged save. core/movement.ts refuses a CORRECTION of a
   * state-changing event whose period is closed and only flags a NEW dated event — repeating the refusal in
   * this writer would silently convert an allowed movement into a rejection. Pinned so a later widening of
   * the gate has to argue with this test rather than quietly change how Movement behaves.
   */
  it('still records a Confirmation movement dated inside a closed payroll month', async () => {
    const id = await hire('2026-01-01');
    await closedPayrollFor(id, '2026-01');

    await createMovementEvent(adminCtx(b), {
      employmentId: id,
      kind: 'confirmation',
      effectiveDate: '2026-01-15',
      remarks: 'Confirmed on probation completion',
    });

    const row = await employmentRow(id);
    expect(row.confirmationDate).toBe('2026-01-15');
  });
});
