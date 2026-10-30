/**
 * Employment History — Edit + Rollback, feedback 66a63bd6.
 *
 * 10fcf6df renamed the affordance from "Delete" to "Roll Back": the service below has reversed rather than
 * erased since this suite was written, and the label was the last thing still promising a deletion the
 * system never performed. The behaviour asserted here is unchanged.
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
  MovementClosedPayrollAcknowledgementError,
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
    .select({
      gradeId: schema.employment.gradeId,
      orgDivision: schema.employment.orgDivision,
      // 646355e5 — the termination columns a Termination correction restores.
      terminatedOn: schema.employment.terminatedOn,
      terminationReasonCode: schema.employment.terminationReasonCode,
      lastWorkingDate: schema.employment.lastWorkingDate,
    })
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

describe('reverseMovementEvent — Rollback is recorded as a visible reversal', () => {
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

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: promotion.id, reason: 'Keyed in error' });

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

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: change.id, reason: 'Keyed in error' });

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

  it('refuses the Hired row, and (646355e5) rolls an applied Termination back to the active record', async () => {
    const hire = await hireOne();
    const hired = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'hired')!;
    expect(hired.canReverse).toBe(false);
    await expect(
      reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: hired.id, reason: 'Keyed in error' }),
    ).rejects.toBeInstanceOf(MovementNotCorrectableError);

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'termination',
      effectiveDate: '2026-07-31',
      // ae9350f2 — a coded reason and a last working day are mandatory; 'misconduct' derives 'involuntary',
      // which is what keeps this row a Termination rather than a Resignation.
      endDate: '2026-07-31',
      terminationReasonCode: 'misconduct',
    });
    const term = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'termination')!;
    expect(term.canReverse).toBe(true);
    expect(term.canEdit).toBe(true);
    expect((await employmentRow(hire.employmentId)).terminatedOn).toBe('2026-07-31');
    const closedVersion = await owner.db
      .select({ id: schema.assignment.id })
      .from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), eq(schema.assignment.validTo, '2026-07-31')));
    expect(closedVersion).toHaveLength(1);

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: term.id, reason: 'Terminated the wrong employee' });

    const restored = await employmentRow(hire.employmentId);
    expect(restored.terminatedOn).toBeNull();
    expect(restored.terminationReasonCode).toBeNull();
    expect(restored.lastWorkingDate).toBeNull();
    // The assignment the termination closed is open again — the same version, not a new one.
    expect((await openAssignment(hire.employmentId)).id).toBe(closedVersion[0].id);
    const rolledBack = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === term.id)!;
    expect(rolledBack.reversed).toBeTruthy();
  });

  it('646355e5 — corrects an applied Termination date in place', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'termination',
      effectiveDate: '2026-07-31',
      endDate: '2026-07-31',
      terminationReasonCode: 'misconduct',
    });
    const term = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'termination')!;
    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: term.id,
      kind: 'termination',
      effectiveDate: '2026-07-15',
      endDate: '2026-07-15',
      terminationReasonCode: 'misconduct',
      reason: 'Wrong termination date keyed',
    });
    const row = await employmentRow(hire.employmentId);
    expect(row.terminatedOn).toBe('2026-07-15');
    expect(row.lastWorkingDate).toBe('2026-07-15');
    const live = (await movementHistory(adminCtx(b), hire.employmentId)).filter((r) => r.kind === 'termination' && !r.reversed);
    expect(live.map((r) => r.effectiveDate)).toEqual(['2026-07-15']);
  });

  it('rejects a non-admin caller (defence-in-depth over the writers)', async () => {
    const hire = await hireOne();
    const hired = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'hired')!;
    await expect(
      reverseMovementEvent(
        { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] },
        { employmentId: hire.employmentId, movementId: hired.id, reason: 'Keyed in error' },
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
        reason: 'Re-saved unchanged',
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
      reason: 'Business unit was missed',
    });

    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.businessUnitId).toBe(bu.id);
  });

  it('646355e5 — corrects an OLDER movement and replays the later one on top of it', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'increment',
      effectiveDate: '2026-03-01',
      basicSalary: 5000,
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const older = rows.find((r) => r.kind === 'increment')!;
    expect(older.canEdit).toBe(true);

    const result = await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: older.id,
      kind: 'increment',
      effectiveDate: '2026-03-01',
      basicSalary: 4500,
      reason: 'Wrong amount keyed',
    });
    expect(result.replayed).toBe(1);
    // The corrected salary is in force, and the later transfer still applies on its own date.
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('4500.00');
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);
    expect((await openAssignment(hire.employmentId)).validFrom).toBe('2026-06-01');
    const live = (await movementHistory(adminCtx(b), hire.employmentId)).filter((r) => !r.reversed && r.kind !== 'hired');
    expect(live.map((r) => [r.kind, r.effectiveDate])).toEqual(
      expect.arrayContaining([['increment', '2026-03-01'], ['transfer', '2026-06-01']]),
    );
    expect(live).toHaveLength(2);
  });

  it('refuses an older correction that would make a later movement meaningless, and changes nothing', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: 'increment', effectiveDate: '2026-03-01', basicSalary: 5000 });
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: 'increment', effectiveDate: '2026-06-01', basicSalary: 6000 });
    const older = (await movementHistory(adminCtx(b), hire.employmentId)).filter((r) => r.kind === 'increment')[0];
    expect(older.effectiveDate).toBe('2026-03-01');
    const before = await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, hire.employmentId));
    // Correcting March to 6000 would leave the June increment changing nothing — refused, nothing written.
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: older.id,
        kind: 'increment',
        effectiveDate: '2026-03-01',
        basicSalary: 6000,
        reason: 'Wrong amount',
      }),
    ).rejects.toThrow(/would no longer change anything/i);
    expect(await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, hire.employmentId))).toEqual(before);
    // A corrected date may not jump past the later movement either.
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: older.id,
        kind: 'increment',
        effectiveDate: '2026-07-01',
        basicSalary: 5000,
        reason: 'Wrong date',
      }),
    ).rejects.toThrow(/falls after the later/i);
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

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: moves[0].id, reason: 'Keyed in error' });

    // The later movement still owns the column — rolling back the earlier one must not resurrect its value.
    expect((await employmentRow(hire.employmentId)).orgDivision).toBe('Wholesale');
  });
});

describe('payroll interaction — acknowledge on closed, warn on processed, never reprocess', () => {
  it('646355e5 — a CLOSED run requires an explicit acknowledgement, then corrects without touching the payslip', async () => {
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

    // The closed run is named, and no longer hides the affordances.
    expect(move.payrollLocked).toBe(true);
    expect(move.payrollClosedPeriods).toEqual(['2026-06']);
    expect(move.canReverse).toBe(true);
    expect(move.canEdit).toBe(true);
    const slipsBefore = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, hire.employmentId));

    // Without the acknowledgement: refused, and nothing moved.
    await expect(
      reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: move.id, reason: 'Keyed in error' }),
    ).rejects.toBeInstanceOf(MovementClosedPayrollAcknowledgementError);
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('5000.00');
    // A posted flag on another call does not leak into this one: the edit path refuses the same way.
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: move.id,
        kind: 'increment',
        effectiveDate: '2026-06-01',
        basicSalary: 4500,
        reason: 'Wrong amount keyed',
      }),
    ).rejects.toBeInstanceOf(MovementClosedPayrollAcknowledgementError);
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('5000.00');

    // With it: the correction applies to the record…
    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      kind: 'increment',
      effectiveDate: '2026-06-01',
      basicSalary: 4500,
      reason: 'Wrong amount keyed',
      acknowledgeClosedPayroll: true,
    });
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('4500.00');
    // …the corrected salary starts after the closed month, which keeps the record it was paid on…
    expect((await openCompensation(hire.employmentId)).validFrom).toBe('2026-07-01');
    const june = await owner.db
      .select({ basicSalary: schema.compensation.basicSalary, validTo: schema.compensation.validTo })
      .from(schema.compensation)
      .where(and(eq(schema.compensation.employmentId, hire.employmentId), eq(schema.compensation.validFrom, '2026-06-01'), isNull(schema.compensation.supersededAt)));
    expect(june).toEqual([{ basicSalary: '5000.00', validTo: '2026-07-01' }]);
    // …the closed payslip is byte-for-byte what was issued, and its document metadata is retained…
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, hire.employmentId))).toEqual(slipsBefore);
    const retained = await owner.db
      .select({ payslipId: schema.informationPayslipSnapshot.payslipId })
      .from(schema.informationPayslipSnapshot)
      .where(eq(schema.informationPayslipSnapshot.employmentId, hire.employmentId));
    expect(retained.map((r) => r.payslipId)).toEqual(slipsBefore.map((s) => s.id));
    // …and the audit trail records the acknowledged periods with the reason.
    const [reversal] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.subjectEmploymentId, hire.employmentId), eq(schema.domainEvent.eventType, 'employment.movement.reversed')));
    expect(reversal.payload).toMatchObject({
      corrected: true,
      reason: 'Wrong amount keyed',
      closedPayrollPeriods: ['2026-06'],
      closedPayrollAcknowledged: true,
      snapshotCount: 1,
    });
  });

  it('requires acknowledgement and retains issued payroll when a record-only event becomes a salary change in a closed month',async()=>{
    const hire=await hireOne(),ctx=adminCtx(b);
    await setCompensation(ctx,{employmentId:hire.employmentId,basicSalary:4000,effectiveFrom:'2026-01-01'});
    await createMovementEvent(ctx,{employmentId:hire.employmentId,kind:'secondment',effectiveDate:'2026-07-01',remarks:'Fictional wrongly classified event'});
    await closedPayrollFor(hire.employmentId,'2026-06');
    const original=(await movementHistory(ctx,hire.employmentId)).find(row=>row.kind==='secondment')!;
    expect(original.payrollLocked).toBe(false);
    const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId,hire.employmentId));
    const input={employmentId:hire.employmentId,movementId:original.id,kind:'salaryAdjustment',effectiveDate:'2026-06-01',basicSalary:4500,reason:'Fictional wrong event type and date'};
    await expect(editMovementEvent(ctx,input)).rejects.toBeInstanceOf(MovementClosedPayrollAcknowledgementError);
    expect((await movementHistory(ctx,hire.employmentId)).find(row=>row.id===original.id)?.status).toBe('applied');
    await editMovementEvent(ctx,{...input,acknowledgeClosedPayroll:true});
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId,hire.employmentId))).toEqual(slips);
    expect((await openCompensation(hire.employmentId)).validFrom).toBe('2026-07-01');
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('4500.00');
    const snapshots=await owner.db.select().from(schema.informationPayslipSnapshot).where(eq(schema.informationPayslipSnapshot.employmentId,hire.employmentId));
    expect(snapshots).toHaveLength(1);
    const reversals=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,hire.employmentId),eq(schema.domainEvent.eventType,'employment.movement.reversed')));
    expect(reversals.map(row=>row.payload)).toContainEqual(expect.objectContaining({movementId:original.id,closedPayrollPeriods:['2026-06'],closedPayrollAcknowledged:true,closedPayrollCorrectedOn:expect.any(String)}));
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

    await reverseMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: move.id, reason: 'Keyed in error' });
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
