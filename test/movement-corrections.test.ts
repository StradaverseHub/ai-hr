/**
 * Employment History — Edit + Delete (Rollback), feedback 66a63bd6.
 *
 * The reporter's answer to decision item 9064cffb chose corrections recorded as VISIBLE REVERSALS, never a
 * hard delete. Employment History is a projection over the append-only domain_event ledger, so this suite
 * proves the shape that follows from it:
 *   • a rollback restores the previous valid state across EVERY leg of a movement (dated assignment,
 *     compensation, reporting line, plus the flat grade / org columns) and the row STAYS, marked reversed;
 *   • an edit is a replay — roll back, then re-apply through the same writers — and replaying an UNCHANGED
 *     movement writes nothing at all (the assertion the plan asks for before the changed case is trusted);
 *   • business_unit_id survives a correction (the transferEmployee class of bug, pinned by
 *     test/transfer-preserves-business-unit.test.ts, must not reappear in a new writer);
 *   • a closed payroll run blocks the correction, and a merely PROCESSED one only warns — nothing is ever
 *     reprocessed automatically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBusinessUnit, createJobGrade } from '../core/admin';
import {
  createMovementEvent,
  editMovementEvent,
  movementHistory,
  MovementNoChangeError,
  MovementNotCorrectableError,
  reverseMovementEvent,
} from '../core/movement';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `mvc_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne(p?: { managerEmploymentId?: string }) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Correction Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    reportingManagerEmploymentId: p?.managerEmploymentId,
  });
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

async function openCompensation(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.compensation)
    .where(
      and(
        eq(schema.compensation.employmentId, employmentId),
        isNull(schema.compensation.validTo),
        isNull(schema.compensation.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select({ gradeId: schema.employment.gradeId, orgDivision: schema.employment.orgDivision })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

/** A CLOSED payroll run that paid this employment in `period` ('YYYY-MM'). */
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

describe('reverseMovementEvent — Delete is a rollback recorded as a visible reversal', () => {
  it('restores the previous department and keeps the row on the history, marked reversed', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      remarks: 'Wrong department',
    });
    const before = await movementHistory(adminCtx(b), hire.employmentId);
    const transfer = before.find((r) => r.kind === 'transfer')!;
    expect(transfer.canReverse).toBe(true);
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);

    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: transfer.id,
      reason: 'Keyed against the wrong employee',
    });

    // The employee is back on the hire-time assignment, and it is OPEN again (no gap in the timeline).
    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptA);
    expect(open.validTo).toBeNull();

    // The row is still there — reversed, not gone.
    const after = await movementHistory(adminCtx(b), hire.employmentId);
    const same = after.find((r) => r.id === transfer.id)!;
    expect(same).toBeTruthy();
    expect(same.reversed?.corrected).toBe(false);
    expect(same.reversed?.reason).toBe('Keyed against the wrong employee');
    expect(same.canReverse).toBe(false);
    expect(same.canEdit).toBe(false);
    // Exactly ONE line for the movement: the compensating writes are companion legs, not new events.
    expect(after.filter((r) => r.kind === 'transfer')).toHaveLength(1);
  });

  it('rolls back every leg of a multi-leg movement — org, grade, flat column and pay together', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
      rank: 4,
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      gradeId: grade.id,
      orgDivision: 'Retail',
      basicSalary: 5200,
    });
    const promotion = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'promotion')!;

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: promotion.id });

    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptA);
    const emp = await employmentRow(hire.employmentId);
    expect(emp.gradeId).toBeNull();
    expect(emp.orgDivision).toBeNull();
    const comp = await openCompensation(hire.employmentId);
    expect(comp.basicSalary).toBe('4000.00');
    expect(comp.validTo).toBeNull();
  });

  it('restores the previous Direct Superior', async () => {
    const mgrA = await hireOne();
    const mgrB = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgrA.employmentId });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'reportingLineChange',
      effectiveDate: '2026-06-01',
      managerEmploymentId: mgrB.employmentId,
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const change = rows.filter((r) => r.kind === 'reportingLineChange').pop()!;

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: change.id });

    const [line] = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(
        and(
          eq(schema.reportingLine.subordinateEmploymentId, hire.employmentId),
          eq(schema.reportingLine.lineType, 'administrative'),
          isNull(schema.reportingLine.validTo),
          isNull(schema.reportingLine.supersededAt),
        ),
      )
      .limit(1);
    expect(line.managerEmploymentId).toBe(mgrA.employmentId);
  });

  it('refuses the Hired row and a Termination — those are not corrections this screen owns', async () => {
    const hire = await hireOne();
    const hired = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'hired')!;
    expect(hired.canReverse).toBe(false);
    await expect(
      reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: hired.id }),
    ).rejects.toBeInstanceOf(MovementNotCorrectableError);

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'termination',
      effectiveDate: '2026-07-31',
      terminationType: 'involuntary',
    });
    const term = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'termination')!;
    expect(term.canReverse).toBe(false);
  });

  it('rejects a non-admin caller (defence-in-depth over the writers)', async () => {
    const hire = await hireOne();
    const hired = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'hired')!;
    await expect(
      reverseMovementEvent(
        { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] },
        { employmentId: hire.employmentId, movementId: hired.id },
      ),
    ).rejects.toThrow(/only an admin/i);
  });
});

describe('editMovementEvent — a correction is a replay through the same writers', () => {
  it('replaying an UNCHANGED movement writes nothing at all', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      remarks: 'Reorg',
    });
    const transfer = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    const assignmentsBefore = await owner.db
      .select({ id: schema.assignment.id })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    const eventsBefore = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.subjectEmploymentId, hire.employmentId));

    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: transfer.id,
        kind: 'transfer',
        effectiveDate: '2026-06-01',
        remarks: 'Reorg',
        departmentId: b.deptB,
      }),
    ).rejects.toBeInstanceOf(MovementNoChangeError);

    // No rollback, no re-apply, no ledger churn — the whole point of asserting the no-op first.
    const assignmentsAfter = await owner.db
      .select({ id: schema.assignment.id })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    const eventsAfter = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.subjectEmploymentId, hire.employmentId));
    expect(assignmentsAfter).toHaveLength(assignmentsBefore.length);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.find((r) => r.id === transfer.id)?.reversed).toBeNull();
  });

  it('corrects the department and the effective date, marking the original as corrected', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const transfer = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    expect(transfer.canEdit).toBe(true);

    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: transfer.id,
      kind: 'promotion',
      effectiveDate: '2026-07-01',
      remarks: 'Should have been a promotion',
      departmentId: b.deptB,
      reason: 'Wrong event type at entry',
    });

    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.validFrom).toBe('2026-07-01');

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const original = rows.find((r) => r.id === transfer.id)!;
    expect(original.reversed?.corrected).toBe(true);
    expect(original.reversed?.reason).toBe('Wrong event type at entry');
    const corrected = rows.find((r) => r.kind === 'promotion')!;
    expect(corrected.effectiveDate).toBe('2026-07-01');
    expect(corrected.remarks).toBe('Should have been a promotion');
  });

  it('keeps the Business Unit through a correction (the transferEmployee class of bug must not return)', async () => {
    const bu = await createBusinessUnit(adminCtx(b), {
      companyId: b.companyId,
      code: `BU${randomUUID().slice(0, 6).toUpperCase()}`,
      name: `BU ${randomUUID().slice(0, 5)}`,
    });
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-05-01',
      businessUnitId: bu.id,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find(
      (r) => r.kind === 'orgAssignmentChange',
    )!;

    // Correct only the department; the Business Unit is resubmitted unchanged and must survive the replay.
    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-05-01',
      departmentId: b.deptB,
      businessUnitId: bu.id,
    });

    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.businessUnitId).toBe(bu.id);
  });

  it('refuses an in-place edit of an older movement, and names the way out', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-03-01',
      departmentId: b.deptB,
    });
    // 941c9dac — this used to read 2026-09-01, a date that was in the FUTURE when the test was written.
    // It passed only because a future-dated movement applied on save, which is the fault that item fixed;
    // such a movement is now Pending and changes nothing, so it could no longer be the "later movement"
    // this test needs. The date moves into the past: the rule under test (only the most recent
    // state-changing movement may be corrected in place) is about ORDER, not about future dating.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptA,
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const older = rows.filter((r) => r.kind === 'transfer')[0];
    const newer = rows.filter((r) => r.kind === 'transfer')[1];
    expect(older.canEdit).toBe(false);
    expect(older.canReverse).toBe(true); // a rollback of a middle movement is still safe
    expect(newer.canEdit).toBe(true);

    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: older.id,
        kind: 'transfer',
        effectiveDate: '2026-03-01',
        departmentId: b.deptA,
      }),
    ).rejects.toThrow(/most recent movement/i);
  });

  it('leaves a later movement alone when an earlier one is rolled back (last write wins on flat columns)', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-03-01',
      orgDivision: 'Retail',
    });
    // 941c9dac — was 2026-09-01, future at the time of writing (see the note in the test above). The
    // last-write-wins rule this asserts is about which movement wrote the flat column LAST, so the date
    // simply has to be later than the first movement's and already in effect.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'orgAssignmentChange',
      effectiveDate: '2026-06-01',
      orgDivision: 'Wholesale',
    });
    const moves = (await movementHistory(adminCtx(b), hire.employmentId)).filter(
      (r) => r.kind === 'orgAssignmentChange',
    );

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: moves[0].id });

    // The later movement still owns the column — rolling back the earlier one must not resurrect its value.
    expect((await employmentRow(hire.employmentId)).orgDivision).toBe('Wholesale');
  });
});

describe('payroll interaction — block on closed, warn on processed, never reprocess', () => {
  it('refuses a correction whose window a CLOSED payroll run relied on', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'increment',
      effectiveDate: '2026-06-01',
      basicSalary: 5000,
    });
    await closedPayrollFor(hire.employmentId, '2026-06');
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'increment')!;

    expect(move.payrollLocked).toBe(true);
    expect(move.canReverse).toBe(false);
    expect(move.canEdit).toBe(false);
    await expect(
      reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: move.id }),
    ).rejects.toThrow(/closed payroll/i);
    // Nothing moved: the salary in force is still the one the closed run paid against.
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('5000.00');
  });

  it('only WARNS when a processed (not yet closed) run covered the period — the correction still applies', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    // 941c9dac — was 2026-08-01, future at the time of writing, so the increment would now be Pending and
    // write no compensation row for the correction to warn about. Dated in the past instead; the payroll
    // period below stays 2026-08 because the guard measures the window from the effective date FORWARD,
    // so a July increment still overlaps an August run — which is exactly the overlap under test.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'increment',
      effectiveDate: '2026-07-01',
      basicSalary: 5000,
    });
    // pay_period is unique per (company, period), so this case uses its own month.
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period: '2026-08', status: 'open' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        payPeriodId: pp.id,
        payPeriod: '2026-08',
        batchDate: '2026-08-25',
        status: 'processed',
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: hire.employmentId,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '5000.00',
      employerCost: '5000.00',
    });

    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'increment')!;
    expect(move.payrollLocked).toBe(false);
    expect(move.payrollWarning).toBe(true);
    expect(move.canReverse).toBe(true);

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: move.id });
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('4000.00');
    // The payslip is evidence of what was paid — a correction never rewrites it.
    const [slip] = await owner.db
      .select({ basicSalary: schema.payslip.basicSalary })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batch.id))
      .limit(1);
    expect(slip.basicSalary).toBe('5000.00');
  });
});
