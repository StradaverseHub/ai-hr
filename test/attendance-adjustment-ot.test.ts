/**
 * ADR-0069 Attendance Request Management — overtime request on attendance_correction + the company-level
 * OT-approval-calculation setting. Asserts:
 *  • all submission shapes: clock-only, OT-only (relaxed proposed_check_in constraint), combined, and the
 *    application-level rejections (at-least-one, clock-out-needs-clock-in, mandatory reason, negative OT);
 *  • all 3 OT-calculation outcomes (requested | system_calculated | smaller_of) against worked examples;
 *  • the pinned, tested decision that TOIL auto-accrual reads the POLICY-ADJUSTED attendance.otMinutes (not the
 *    raw engine figure) when an OT approval and a rest-day/holiday auto-accrual coincide;
 *  • payroll OT prefill picks up the approved value;
 *  • the one-pending-request-per-(employment,date) rule.
 *
 * ADR-0077 slice 3 — TOIL is a PER-TENANT ENTITLEMENT ROW now, not TOIL_ENABLED. The auto-accrual test
 * below therefore does two things instead of one env write:
 *   - ON is `await setModule(b.tenantId, 'toil', 'active')`; OFF is the ABSENCE of the row (C7), which
 *     is what seedBase leaves behind — `toil` is not in LEGACY_ENABLED_MODULE_CODES, so no test tenant
 *     carries the row unless the test writes it.
 *   - the calls under test must run on `entitledCtx(b)`, a REAL snapshot resolved from this tenant's
 *     rows, built AFTER the `setModule` call (a snapshot is a point-in-time read). `adminCtx` derives
 *     its snapshot from `legacyEnabledModulesIn(process.env)`, and that helper filters
 *     LEGACY_ENABLED_MODULE_CODES — which omits `toil` entirely. So `adminCtx` can NEVER report toil as
 *     entitled, no matter what env says, and driving the accrual through it would silently assert the
 *     gated-OFF path while claiming to test the gated-ON one. Fixture work that is not the thing under
 *     test (hiring, compensation) keeps using `adminCtx`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  checkIn,
  checkOut,
  requestAttendanceCorrection,
  decideAttendanceCorrection,
  setAttendancePolicy,
  resolveApprovedOt,
  type OtApprovalMethod,
} from '../core/attendance';
import { setRestDay } from '../core/roster';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';

let b: Base;
const DATE = '2026-07-01'; // Wednesday, default workday
const REST_DAY = '2026-07-04'; // Saturday; setRestDay makes it a rostered rest day
const uniqEmail = () => `otreq_${Math.random().toString(36).slice(2)}@t.local`;

const BASE_POLICY = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

async function hire(basic = 5000) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'OT Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return { a, employmentId: e.employmentId };
}

const otMinutesOf = async (employmentId: string, date: string): Promise<number | null> => {
  const [row] = await owner.db
    .select({ ot: schema.attendance.otMinutes })
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row?.ot ?? null;
};

const correctionRow = async (correctionId: string) =>
  (await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, correctionId)))[0];

const toilPolicy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: true,
  carryForwardAtYearEnd: false,
  ...over,
});

const replacementBalance = async (employmentId: string): Promise<number> => {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
};

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
// No afterEach: the TOIL gate used to be an env var that had to be unset between tests. It is a
// tenant_module ROW now, and beforeEach's resetDb() TRUNCATEs tenant_module before seeding a brand-new
// tenant — so the "off" state is restored by construction and there is nothing left to clean up.

describe('resolveApprovedOt (pure) — worked examples', () => {
  const cases: [OtApprovalMethod, number, number | null, number][] = [
    // [method, requested, system, expected]
    ['requested', 120, 90, 120],
    ['system_calculated', 120, 90, 90],
    ['smaller_of', 120, 90, 90],
    ['smaller_of', 60, 90, 60],
    ['system_calculated', 120, null, 0], // no derivable system figure ⇒ 0, never a phantom approval
    ['requested', -5, 90, 0], // clamped to 0
  ];
  it.each(cases)('%s(req=%d, sys=%s) → %d', (method, requested, system, expected) => {
    expect(resolveApprovedOt(requested, system, method)).toBe(expected);
  });
});

describe('attendance OT request — submission shapes + validation', () => {
  it('OT-only request is allowed (relaxed proposed_check_in) and needs no punches', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      requestedOtMinutes: 120,
      reason: 'Worked late off the clock',
    });
    const row = await correctionRow(correctionId);
    expect(row.proposedCheckIn).toBeNull();
    expect(row.proposedCheckOut).toBeNull();
    expect(row.requestedOtMinutes).toBe(120);
    expect(row.reason).toBe('Worked late off the clock');
  });

  it('rejects an empty request (no clock-in / clock-out / OT)', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, reason: 'x' }),
    ).rejects.toThrow(/at least one/i);
  });

  it('rejects a clock-out with no clock-in', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, checkOut: '18:00', reason: 'x' }),
    ).rejects.toThrow(/clock-in/i);
  });

  it('rejects a missing reason (application-level mandatory)', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, checkIn: '09:00', reason: '   ' }),
    ).rejects.toThrow(/reason is required/i);
  });

  it('rejects negative overtime minutes', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, requestedOtMinutes: -30, reason: 'x' }),
    ).rejects.toThrow(/non-negative/i);
  });

  it('one-pending-request-per-date: a second pending request for the same date is rejected', async () => {
    const { a, employmentId } = await hire();
    await requestAttendanceCorrection(a, { employmentId, date: DATE, checkIn: '09:00', reason: 'fix' });
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, requestedOtMinutes: 60, reason: 'ot' }),
    ).rejects.toThrow();
  });
});

describe('attendance OT approval — 3 calculation settings', () => {
  // The employee clocked 09:00→20:00 = 660 span − 60 break = 600 worked; scheduled 480 ⇒ engine OT = 120.
  // They REQUEST 180 minutes. Each setting resolves the approved figure differently.
  async function setup(method: OtApprovalMethod) {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: method });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '20:00',
      requestedOtMinutes: 180,
      reason: 'Overran the shift',
    });
    return { a, employmentId, correctionId };
  }

  it('requested: approved OT = the employee figure (180)', async () => {
    const { a, employmentId, correctionId } = await setup('requested');
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(await otMinutesOf(employmentId, DATE)).toBe(180);
    const row = await correctionRow(correctionId);
    expect(row.approvedOtMinutes).toBe(180);
    expect(row.otApprovalMethod).toBe('requested');
  });

  it('system_calculated: approved OT = the engine figure (120)', async () => {
    const { a, employmentId, correctionId } = await setup('system_calculated');
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(await otMinutesOf(employmentId, DATE)).toBe(120);
    expect((await correctionRow(correctionId)).approvedOtMinutes).toBe(120);
  });

  it('smaller_of: approved OT = min(180, 120) = 120', async () => {
    const { a, employmentId, correctionId } = await setup('smaller_of');
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(await otMinutesOf(employmentId, DATE)).toBe(120);
  });

  it('default (no policy row) is system_calculated', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '20:00',
      requestedOtMinutes: 180,
      reason: 'Overran',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(await otMinutesOf(employmentId, DATE)).toBe(120); // system figure, not the requested 180
    expect((await correctionRow(correctionId)).otApprovalMethod).toBe('system_calculated');
  });
});

describe('TOIL auto-accrual reads the POLICY-ADJUSTED approved OT (ADR-0069 pinned decision)', () => {
  it('rest-day OT approval with requested-method credits RL off the APPROVED figure, not the raw engine figure', async () => {
    const { employmentId } = await hire(); // hiring is fixture work — it runs on adminCtx inside hire()
    // TOIL ON for this tenant, then resolve the snapshot: `entitledCtx` is a point-in-time read, so the
    // row must exist first. Everything from here runs on `a`, the entitled context.
    await setModule(b.tenantId, 'toil', 'active');
    const a = await entitledCtx(b);
    // requested-method policy: the approved OT will be the employee's REQUESTED figure.
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await setToilPolicy(a, toilPolicy(b.companyId)); // autoAccrueOnApproval on
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    // A rest-day OT-only request: employee requests a FULL standard day (480 min) of OT.
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: REST_DAY,
      checkIn: '08:00',
      checkOut: '17:00', // 540 span − 60 break = 480 worked; rest_day ⇒ engine OT = 480
      requestedOtMinutes: 240, // employee only claims 4h; requested-method makes THAT the approved figure
      reason: 'Weekend cover',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    // attendance.otMinutes is the approved (requested) figure, 240 — NOT the engine's 480.
    expect(await otMinutesOf(employmentId, REST_DAY)).toBe(240);
    // The RL credit is 240/480 = 0.5 day (hours_worked basis) — proving auto-accrual consumed the APPROVED OT.
    expect(await replacementBalance(employmentId)).toBe(0.5);
  });
});

describe('payroll OT prefill picks up the approved value', () => {
  it('an approved OT figure flows to the payroll overtime prefill', async () => {
    // ≤ ceiling ⇒ statutory OT pay applies, so the day is monetised by the prefill (a > ceiling employee is
    // "ineligible" and skipped — that is the ORP-eligibility gate, not this feature's concern).
    const { a, employmentId } = await hire(3000);
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '20:00',
      requestedOtMinutes: 180,
      reason: 'Overran',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    // A July batch: the approved workday OT (>0) is monetised for this employee.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(a, { batchId })).applied).toBe(1);
  });
});
