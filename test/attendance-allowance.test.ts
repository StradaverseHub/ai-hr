/**
 * ADR-0072 — Attendance Allowance (Monthly, v1).
 *
 *  A. Pure predicate evaluateMonthly for each of the five criteria + requirePerfectAttendance, including
 *     the request's COMPUTABLE worked example (Absent <= 0 with 0 -> pass; Leave <= 1 with 1 -> pass).
 *  B. Service + RLS: CRUD appends the right events; a non-admin write is denied; the scope post-filter
 *     awards only in-scope employees (the department/BU join actually filters); archive hides from the
 *     active list.
 *  C. Transfer: with TYPED_PAY_COMPONENTS_ENABLED=true creates one payroll_batch_component per qualified
 *     in-scope employee at amount = policy.amount; idempotent on re-run; refuses a non-draft batch; returns
 *     gated:true (and writes nothing) with the flag off; throws UnsupportedBatchComponentError for a
 *     PCB-only component; REVERSAL: after a correction disqualifies an employee, re-transfer removes the row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, setAttendancePolicy } from '../core/attendance';
import { createBatch } from '../core/payroll';
import { seedPayComponentCatalog } from '../core/pay-components';
import { UnsupportedBatchComponentError } from '../core/pay-components';
import {
  archiveAllowancePolicy,
  createAllowancePolicy,
  evaluateAllowancesForPeriod,
  evaluateMonthly,
  setAllowancePolicyStatus,
  transferAllowancesToBatch,
  updateAllowancePolicy,
} from '../core/attendance-allowance';
import { listAllowancePolicies } from '../core/read';

let b: Base;
const uniqEmail = () => `aa_${Math.random().toString(36).slice(2)}@t.local`;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterEach(() => {
  delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
});

/** The seeded ATTENDANCE component (EPF+SOCSO+PCB, payable) — a SUPPORTED transfer target. */
async function attendanceComponentId(a: SessionContext): Promise<string> {
  await seedPayComponentCatalog(a);
  const [row] = await owner.db
    .select({ id: schema.payComponent.id })
    .from(schema.payComponent)
    .where(and(eq(schema.payComponent.tenantId, b.tenantId), eq(schema.payComponent.code, 'ATTENDANCE')));
  return row.id;
}

/** A PCB-taxable, non-EPF, non-SOCSO, non-payable component (BIK) — UNSUPPORTED for a batch component. */
async function unsupportedComponentId(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.payComponent)
    .values({
      tenantId: b.tenantId,
      code: `BIK_${randomUUID().slice(0, 6)}`,
      name: 'Benefit in kind',
      kind: 'allowance',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: true,
      isNonPayable: true,
    })
    .returning({ id: schema.payComponent.id });
  return row.id;
}

// ─────────────────────────── A. Pure predicate ───────────────────────────

describe('evaluateMonthly (pure)', () => {
  const zero = { present: 0, late: 0, halfDay: 0, absent: 0, leaveDays: 0 };

  it('maxAbsentDays: 0 absences <= 0 -> pass; 1 absence <= 0 -> fail (the request worked example)', () => {
    expect(evaluateMonthly({ ...zero, present: 20 }, { maxAbsentDays: 0 }).qualified).toBe(true);
    const fail = evaluateMonthly({ ...zero, present: 19, absent: 1 }, { maxAbsentDays: 0 });
    expect(fail.qualified).toBe(false);
    expect(fail.reasons).toEqual(['attendanceAllowance.reason.maxAbsentDays']);
  });

  it('maxTotalLeaveDays: 1 leave day <= 1 -> pass (the request worked example)', () => {
    expect(evaluateMonthly({ ...zero, present: 19, leaveDays: 1 }, { maxTotalLeaveDays: 1 }).qualified).toBe(true);
    expect(evaluateMonthly({ ...zero, present: 18, leaveDays: 2 }, { maxTotalLeaveDays: 1 }).qualified).toBe(false);
  });

  it('minAttendanceDays: present + late + halfDay >= threshold', () => {
    expect(evaluateMonthly({ ...zero, present: 18, late: 1, halfDay: 1 }, { minAttendanceDays: 20 }).qualified).toBe(true);
    expect(evaluateMonthly({ ...zero, present: 18, late: 1 }, { minAttendanceDays: 20 }).qualified).toBe(false);
  });

  it('maxLateCount: count of late-status days', () => {
    expect(evaluateMonthly({ ...zero, present: 18, late: 2 }, { maxLateCount: 2 }).qualified).toBe(true);
    expect(evaluateMonthly({ ...zero, present: 17, late: 3 }, { maxLateCount: 2 }).qualified).toBe(false);
  });

  it('requirePerfectAttendance: absent == 0 && late == 0', () => {
    expect(evaluateMonthly({ ...zero, present: 20 }, { requirePerfectAttendance: true }).qualified).toBe(true);
    expect(evaluateMonthly({ ...zero, present: 19, late: 1 }, { requirePerfectAttendance: true }).qualified).toBe(false);
    expect(evaluateMonthly({ ...zero, present: 19, absent: 1 }, { requirePerfectAttendance: true }).qualified).toBe(false);
  });

  it('AND-combines multiple criteria; per-criterion detail exposes pass/fail', () => {
    const ev = evaluateMonthly({ ...zero, present: 20, absent: 0, leaveDays: 2 }, { maxAbsentDays: 0, maxTotalLeaveDays: 1 });
    expect(ev.qualified).toBe(false);
    expect(ev.perCriterion.find((c) => c.key === 'maxAbsentDays')!.pass).toBe(true);
    expect(ev.perCriterion.find((c) => c.key === 'maxTotalLeaveDays')!.pass).toBe(false);
    expect(ev.reasons).toEqual(['attendanceAllowance.reason.maxTotalLeaveDays']);
  });

  it('empty criteria bag qualifies everyone (no conditions to fail)', () => {
    expect(evaluateMonthly({ ...zero, absent: 5 }, {}).qualified).toBe(true);
  });
});

// ─────────────────────────── B. Service + RLS ───────────────────────────

describe('attendance-allowance policy CRUD + RLS', () => {
  it('create/update/status/archive append the right events; archive hides from the active list', async () => {
    const a = adminCtx(b);
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId,
      code: 'ATT200',
      name: 'Perfect attendance',
      amount: 200,
      payComponentId: componentId,
      effectiveFrom: '2026-07-01',
      criteria: { maxAbsentDays: 0 },
    });
    await updateAllowancePolicy(a, { id, name: 'Perfect attendance (v2)', amount: 250 });
    await setAllowancePolicyStatus(a, { id, status: 'inactive' });

    const events = await eventTypesFor(b.tenantId, id);
    expect(events).toContain('attendance-allowance-policy.created');
    expect(events).toContain('attendance-allowance-policy.updated');
    expect(events).toContain('attendance-allowance-policy.status-changed');

    let active = await listAllowancePolicies(a);
    expect(active.map((r) => r.id)).toContain(id);
    await archiveAllowancePolicy(a, { id });
    expect((await eventTypesFor(b.tenantId, id))).toContain('attendance-allowance-policy.archived');
    active = await listAllowancePolicies(a);
    expect(active.map((r) => r.id)).not.toContain(id);
    const all = await listAllowancePolicies(a, { includeArchived: true });
    expect(all.map((r) => r.id)).toContain(id);
  });

  it('rejects a duplicate code (case-insensitive) among live rows', async () => {
    const a = adminCtx(b);
    const componentId = await attendanceComponentId(a);
    await createAllowancePolicy(a, { companyId: b.companyId, code: 'ATT', name: 'A', amount: 100, payComponentId: componentId, effectiveFrom: '2026-07-01' });
    await expect(
      createAllowancePolicy(a, { companyId: b.companyId, code: 'att', name: 'B', amount: 100, payComponentId: componentId, effectiveFrom: '2026-07-01' }),
    ).rejects.toThrow();
  });

  it('a non-admin write is denied by RLS', async () => {
    const a = adminCtx(b);
    const componentId = await attendanceComponentId(a);
    // an ordinary employee session (no admin role) — RLS WITH CHECK requires is_admin_for(company)
    const emp = await hireEmployee(a, {
      person: { fullName: 'Emp', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    const [person] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, emp.employmentId));
    const empUserId = await createAppUser(b.tenantId, person.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: empUserId, roles: ['employee'] };
    await expect(
      createAllowancePolicy(empCtx, { companyId: b.companyId, code: 'X', name: 'X', amount: 100, payComponentId: componentId, effectiveFrom: '2026-07-01' }),
    ).rejects.toThrow();
  });
});

// ─────────────── Shared setup: 2 employees in dept A, 1 in dept B ───────────────
// A "worked every working day" employee (perfect) and an "absent" one. July 2026: Mon–Fri policy.
async function seedEmployeesAndAttendance() {
  const a = adminCtx(b);
  await setAttendancePolicy(a, {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
  });
  const perfect = await hireEmployee(a, {
    person: { fullName: 'Perfect', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const absentee = await hireEmployee(a, {
    person: { fullName: 'Absentee', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const otherDept = await hireEmployee(a, {
    person: { fullName: 'OtherDept', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptB,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: perfect.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setCompensation(a, { employmentId: absentee.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setCompensation(a, { employmentId: otherDept.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });

  // All working days in July 2026 (Mon–Fri).
  const workdays: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const iso = `2026-07-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    if (dow >= 1 && dow <= 5) workdays.push(iso);
  }
  // Perfect + OtherDept work every day; Absentee is absent on the FIRST two working days (2 absences).
  // Absences at the start of the month are always <= "today" for any realistic clock, so the monthly
  // summary counts them regardless of the current date (it only counts absence up to min(today, monthEnd)).
  for (const [emp, skipFirst] of [
    [perfect.employmentId, 0],
    [otherDept.employmentId, 0],
    [absentee.employmentId, 2],
  ] as const) {
    for (let i = skipFirst; i < workdays.length; i++) {
      await checkIn(a, { employmentId: emp, date: workdays[i], time: '09:00:00' });
      await checkOut(a, { employmentId: emp, date: workdays[i], time: '18:00:00' });
    }
  }
  return { a, perfect: perfect.employmentId, absentee: absentee.employmentId, otherDept: otherDept.employmentId };
}

describe('evaluate + scope filter', () => {
  it('scope post-filter awards only in-scope employees (dept A) and excludes dept B', async () => {
    const { a, perfect, absentee, otherDept } = await seedEmployeesAndAttendance();
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId,
      code: 'ATT200',
      name: 'Perfect attendance',
      amount: 200,
      payComponentId: componentId,
      effectiveFrom: '2026-07-01',
      criteria: { maxAbsentDays: 0 },
      scope: { departmentIds: [b.deptA] }, // only dept A
    });
    const { rows } = await evaluateAllowancesForPeriod(a, { policyId: id, month: '2026-07', today: '2026-07-31' });
    const ids = rows.map((r) => r.employmentId);
    expect(ids).toContain(perfect);
    expect(ids).toContain(absentee);
    expect(ids).not.toContain(otherDept); // dept B out of scope

    const perfectRow = rows.find((r) => r.employmentId === perfect)!;
    const absentRow = rows.find((r) => r.employmentId === absentee)!;
    expect(perfectRow.qualified).toBe(true);
    expect(perfectRow.amount).toBe('200.00');
    expect(absentRow.qualified).toBe(false);
    expect(absentRow.amount).toBe('0.00');
    expect(absentRow.reasons).toContain('attendanceAllowance.reason.maxAbsentDays');
  });
});

// ─────────────────────────── C. Transfer ───────────────────────────

describe('transferAllowancesToBatch', () => {
  it('gated off: returns gated:true and writes nothing', async () => {
    const { a } = await seedEmployeesAndAttendance();
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId, code: 'ATT200', name: 'P', amount: 200, payComponentId: componentId, effectiveFrom: '2026-07-01', criteria: { maxAbsentDays: 0 },
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    const r = await transferAllowancesToBatch(a, { batchId, policyId: id });
    expect(r).toMatchObject({ applied: 0, gated: true });
    const rows = await owner.db
      .select()
      .from(schema.payrollBatchComponent)
      .where(eq(schema.payrollBatchComponent.batchId, batchId));
    expect(rows).toHaveLength(0);
  });

  it('flag on: one component per qualified in-scope employee at policy.amount; idempotent', async () => {
    const { a, perfect, absentee } = await seedEmployeesAndAttendance();
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId, code: 'ATT200', name: 'P', amount: 200, payComponentId: componentId, effectiveFrom: '2026-07-01', criteria: { maxAbsentDays: 0 },
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    const r1 = await transferAllowancesToBatch(a, { batchId, policyId: id });
    expect(r1.gated).toBe(false);
    // No scope on this policy ⇒ all 3 employees are candidates. Perfect + OtherDept worked every day
    // (qualify); Absentee has 2 absences (ineligible).
    expect(r1.applied).toBe(2);
    expect(r1.ineligible).toBe(1);

    const perfectAmount = await componentAmount(batchId, perfect, componentId);
    expect(perfectAmount).toBe(200);
    expect(await componentAmount(batchId, absentee, componentId)).toBeNull();

    // idempotent — re-run leaves one row per qualified employee at the same amount.
    const r2 = await transferAllowancesToBatch(a, { batchId, policyId: id });
    expect(r2.applied).toBe(2);
    const rows = await owner.db
      .select()
      .from(schema.payrollBatchComponent)
      .where(and(eq(schema.payrollBatchComponent.batchId, batchId), eq(schema.payrollBatchComponent.componentId, componentId)));
    expect(rows).toHaveLength(2);
  });

  it('refuses a non-draft batch', async () => {
    const { a } = await seedEmployeesAndAttendance();
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId, code: 'ATT200', name: 'P', amount: 200, payComponentId: componentId, effectiveFrom: '2026-07-01', criteria: { maxAbsentDays: 0 },
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await expect(transferAllowancesToBatch(a, { batchId, policyId: id })).rejects.toThrow();
  });

  it('throws UnsupportedBatchComponentError for a PCB-only non-payable component', async () => {
    const { a } = await seedEmployeesAndAttendance();
    const bad = await unsupportedComponentId();
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId, code: 'BADATT', name: 'P', amount: 200, payComponentId: bad, effectiveFrom: '2026-07-01', criteria: { maxAbsentDays: 0 },
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await expect(transferAllowancesToBatch(a, { batchId, policyId: id })).rejects.toBeInstanceOf(UnsupportedBatchComponentError);
  });

  it('REVERSAL: qualified -> transferred -> correction disqualifies -> re-transfer removes the row', async () => {
    const { a, perfect } = await seedEmployeesAndAttendance();
    const componentId = await attendanceComponentId(a);
    const { id } = await createAllowancePolicy(a, {
      companyId: b.companyId, code: 'ATT200', name: 'P', amount: 200, payComponentId: componentId, effectiveFrom: '2026-07-01', criteria: { maxAbsentDays: 0 },
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await transferAllowancesToBatch(a, { batchId, policyId: id });
    expect(await componentAmount(batchId, perfect, componentId)).toBe(200);

    // Correction: delete the perfect employee's EARLIEST attendance row -> now 1 absence (on a start-of-
    // month date, always counted) -> disqualified.
    const [oneRow] = await owner.db
      .select({ id: schema.attendance.id })
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, perfect))
      .orderBy(schema.attendance.attendanceDate)
      .limit(1);
    await owner.db.delete(schema.attendance).where(eq(schema.attendance.id, oneRow.id));

    const r = await transferAllowancesToBatch(a, { batchId, policyId: id });
    expect(r.reversed).toBeGreaterThanOrEqual(1);
    expect(await componentAmount(batchId, perfect, componentId)).toBeNull();
  });
});

async function componentAmount(batchId: string, employmentId: string, componentId: string): Promise<number | null> {
  const [row] = await owner.db
    .select({ amount: schema.payrollBatchComponent.amount })
    .from(schema.payrollBatchComponent)
    .where(
      and(
        eq(schema.payrollBatchComponent.batchId, batchId),
        eq(schema.payrollBatchComponent.employmentId, employmentId),
        eq(schema.payrollBatchComponent.componentId, componentId),
      ),
    );
  return row ? Number(row.amount) : null;
}
