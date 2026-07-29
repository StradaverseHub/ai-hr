/**
 * Feedback request 31474452 — "Half Day" work-schedule day type + leave-deduction toggle.
 *
 * A weekday on the company work schedule can now be Full (attendance_policy.workingDays), Half
 * (attendance_policy.halfWorkingDays), or Rest (neither). A new per-company toggle
 * (company.leaveHalfDayFullDeduction, default OFF) controls how much a working_days leave type deducts when
 * the span lands on a Half day: OFF → 0.5, ON → 1.0. Full days are always 1.0, unaffected by the toggle.
 *
 * D2: for ATTENDANCE purposes a Half day still counts as a WORKING day (core/attendance.ts unions
 * workingDays ∪ halfWorkingDays for classification, roster-exclusion, and absence derivation) — only the LEAVE
 * deduction amount differs.
 *
 * Fixture week: Mon 2026-07-27 .. Sat 2026-08-01 (Saturday = 2026-08-01), no public holidays seeded.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { setLeaveHalfDayFullDeduction } from '../core/admin';
import { setAttendancePolicy, checkIn, checkOut, attendanceForDate, attendanceMonthSummary } from '../core/attendance';
import {
  decideLeave,
  decideLeaveCancellation,
  requestLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  splitSpanForCancellation,
  UnpaidConsentRequiredError,
} from '../core/leave';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let annualId: string;
let unpaidId: string;
let emergencyId: string;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `hd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** Mon-Fri Full, Saturday Half (0.5 default). No Sunday marker (rest). */
async function setSaturdayHalf() {
  await setAttendancePolicy(adminCtx(b), {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
    halfWorkingDays: [6],
  });
}

async function grantLedger(employmentId: string, leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

async function insertType(opts: { code: string; paid: boolean; counting: 'calendar_days' | 'working_days' }) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: opts.code, name: opts.code, paid: opts.paid, counting: opts.counting })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // r79 0322 — single- vs multi-step approval is now decided by the company's resolved chain, not by
  // company.leave_multi_approval (which is gone). These cases are whole-request single-approver flows —
  // the shape the old opted-out default produced — so the company is put on an explicit ONE-step chain.
  // Without it the built-in direct_manager → hr_admin fallback applies and an approval stops at step 1.
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  annualId = b.annualLeaveTypeId;
  await owner.db.update(schema.leaveType).set({ counting: 'working_days' }).where(eq(schema.leaveType.id, annualId));
  unpaidId = await insertType({ code: 'UNPAID', paid: false, counting: 'calendar_days' });
  emergencyId = await insertType({ code: 'EMERGENCY', paid: true, counting: 'calendar_days' });
});
afterAll(async () => {
  await closeAll();
});

describe('AC1/AC2 — half-day toggle controls the deducted amount', () => {
  it('AC1 OFF (default): a full_day AL on a Half Saturday deducts 0.5, ledger debits 0.5', async () => {
    await setSaturdayHalf();
    const e = await hire('Sat Off');
    await grantLedger(e.employmentId, annualId, '10.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    expect(r.days).toBe(0.5);
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(e.employmentId, annualId)).toBe(9.5);
  });

  it('AC2 ON: the same fixture with the toggle on deducts 1.0, ledger debits 1.0', async () => {
    await setSaturdayHalf();
    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const e = await hire('Sat On');
    await grantLedger(e.employmentId, annualId, '10.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    expect(r.days).toBe(1);
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(e.employmentId, annualId)).toBe(9);
  });
});

describe('AC3 — full-day leave is unaffected by the toggle', () => {
  it('a normal Monday full-day leave deducts 1.0 under both toggle states', async () => {
    await setSaturdayHalf();
    const e = await hire('Mon');
    await grantLedger(e.employmentId, annualId, '10.00');
    const r1 = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-27',
      endDate: '2026-07-27',
    });
    expect(r1.days).toBe(1);

    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const r2 = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-28',
      endDate: '2026-07-28',
    });
    expect(r2.days).toBe(1);
  });

  it('Mon-Sat range with Sat=half: 5.5 OFF / 6.0 ON', async () => {
    await setSaturdayHalf();
    const e = await hire('Week');
    await grantLedger(e.employmentId, annualId, '20.00');
    const rOff = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-27',
      endDate: '2026-08-01',
    });
    expect(rOff.days).toBe(5.5);

    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const e2 = await hire('Week2');
    await grantLedger(e2.employmentId, annualId, '20.00');
    const rOn = await requestLeave(adminCtx(b), {
      employmentId: e2.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-27',
      endDate: '2026-08-01',
    });
    expect(rOn.days).toBe(6);
  });
});

describe('AC4 — back-compat: empty half_working_days is byte-identical under both toggle states', () => {
  it('no half markers configured, toggle ON has no effect on a Mon-Fri leave', async () => {
    const e = await hire('Compat');
    await grantLedger(e.employmentId, annualId, '10.00');
    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-27',
      endDate: '2026-07-31',
    });
    expect(r.days).toBe(5);
  });
});

describe('Attendance interaction (D2): Half day still counts as a working day', () => {
  it('a previously-FULL Saturday re-marked Half stays workday-class, no rest-day OT reclassification', async () => {
    // First: Saturday is a normal Full working day (6-day week).
    await setAttendancePolicy(adminCtx(b), {
      companyId: b.companyId,
      workStart: '09:00',
      workEnd: '18:00',
      breakMinutes: 60,
      lateAfter: '09:15',
      halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5, 6],
      halfWorkingDays: [],
    });
    const e = await hire('ReMarked');
    // Re-mark Saturday as Half (D2): moves from workingDays to halfWorkingDays.
    await setAttendancePolicy(adminCtx(b), {
      companyId: b.companyId,
      workStart: '09:00',
      workEnd: '18:00',
      breakMinutes: 60,
      lateAfter: '09:15',
      halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5],
      halfWorkingDays: [6],
    });
    await checkIn(adminCtx(b), { employmentId: e.employmentId, date: '2026-08-01', time: '09:00:00' });
    await checkOut(adminCtx(b), { employmentId: e.employmentId, date: '2026-08-01', time: '18:00:00' });
    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, e.employmentId));
    expect(row.dayType).toBe('workday'); // NOT rest_day — no OT premium flip
    expect(row.otMinutes).toBe(0); // scheduled 09:00-18:00 minus 60m break = worked exactly on time
  });

  it('a previously-REST Saturday marked Half becomes workday-class (pinned, known limitation)', async () => {
    await setSaturdayHalf(); // Saturday: half (was rest by default Mon-Fri policy)
    const e = await hire('WasRest');
    await checkIn(adminCtx(b), { employmentId: e.employmentId, date: '2026-08-01', time: '09:00:00' });
    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, e.employmentId));
    expect(row.dayType).toBe('workday'); // half day counts as working for attendance (D2)
  });

  it('monthly absence derivation still covers a Half day (not skipped as non-working)', async () => {
    await setSaturdayHalf();
    const e = await hire('Absence');
    // No attendance row on Saturday 2026-08-01, no leave, no holiday ⇒ should count as absent, not skipped.
    // today is injected past month-end so the whole fixture month is counted (mirrors other test files).
    const rows = await attendanceMonthSummary(adminCtx(b), {
      month: '2026-08',
      companyIds: [b.companyId],
      today: '2026-08-31',
    });
    const mine = rows.find((r) => r.employmentId === e.employmentId)!;
    expect(mine.absent).toBeGreaterThanOrEqual(1);
  });

  it('daily status context: an unmarked half Saturday with no record is not classified rest_day', async () => {
    await setSaturdayHalf();
    const e = await hire('Daily');
    const rows = await attendanceForDate(adminCtx(b), '2026-08-01', [b.companyId]);
    const mine = rows.find((r) => r.employmentId === e.employmentId)!;
    expect(mine.context).not.toBe('rest_day');
  });
});

describe('Emergency leave on half days (weight walk, 4d)', () => {
  it('EL Fri-Mon with Sat=half and ample AL balance: single paid child at weighted days, no spurious unpaid child', async () => {
    await setSaturdayHalf();
    const e = await hire('EL1');
    await grantLedger(e.employmentId, annualId, '20.00');
    // Fri 2026-07-31 .. Mon 2026-08-03: Fri(1) + Sat(half=0.5) + Sun(rest=0) + Mon(1) = 2.5 weighted.
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-31',
      endDate: '2026-08-03',
    });
    expect(r.parentGroupId).toBeTruthy();
    expect(r.children).toHaveLength(1); // no UNPAID child
    expect(r.children[0].code).toBe('ANNUAL');
    expect(r.children[0].days).toBe(2.5);
  });

  it('EL with a balance boundary landing before a half date: correct unpaid remainder + consent figure', async () => {
    await setSaturdayHalf();
    const e = await hire('EL2');
    // Only 1.0 AL — covers Fri fully (weight 1), nothing left for Sat (0.5 half). Unpaid remainder starts Sat.
    await grantLedger(e.employmentId, annualId, '1.00');
    await expect(
      requestLeave(adminCtx(b), {
        employmentId: e.employmentId,
        leaveTypeId: emergencyId,
        startDate: '2026-07-31', // Friday
        endDate: '2026-08-01', // Saturday (half)
      }),
    ).rejects.toThrow(UnpaidConsentRequiredError);

    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-31',
      endDate: '2026-08-01',
      unpaidConsent: true,
    });
    const al = r.children.find((c) => c.code === 'ANNUAL')!;
    const upl = r.children.find((c) => c.code === 'UNPAID')!;
    expect(al.days).toBe(1); // Friday only, full weight
    expect(upl.days).toBe(1); // calendar-days remainder: just Saturday (1 calendar day)
  });

  it('per-child segDays equals the weighted workingDays over the segment', async () => {
    await setSaturdayHalf();
    const e = await hire('EL3');
    await grantLedger(e.employmentId, annualId, '20.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: emergencyId,
      startDate: '2026-07-27', // Monday
      endDate: '2026-08-01', // Saturday (half)
    });
    // Mon-Fri (5 full) + Sat (0.5 half) = 5.5 weighted, single ANNUAL child.
    expect(r.children).toHaveLength(1);
    expect(r.children[0].days).toBe(5.5);
  });
});

describe('Cancellation (4e) — weighted give-back', () => {
  let subject: { personId: string; employmentId: string };
  let subjectCtx: SessionContext;
  let mgrCtx: SessionContext;

  beforeEach(async () => {
    const s = await hire('CancelSubject');
    subject = s;
    const mgr = await hire('CancelMgr');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: s.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const subjectUserId = await createAppUser(b.tenantId, s.personId, 'employee');
    subjectCtx = { tenantId: b.tenantId, userId: subjectUserId, personId: s.personId, roles: ['employee'] };
    const mgrUserId = await createAppUser(b.tenantId, mgr.personId, 'manager');
    mgrCtx = { tenantId: b.tenantId, userId: mgrUserId, personId: mgr.personId, roles: ['manager'] };
  });

  it('cancelling a half date gives back the configured weight: 0.5 OFF / 1.0 ON', async () => {
    await setSaturdayHalf();
    await grantLedger(subject.employmentId, annualId, '20.00');
    const req = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-07-27', // Mon
      endDate: '2026-08-01', // Sat (half)
    });
    expect(req.days).toBe(5.5);
    await decideLeave(adminCtx(b), { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    const balAfterApproval = await ledgerBalance(subject.employmentId, annualId);
    expect(balAfterApproval).toBe(14.5); // 20 - 5.5

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: req.leaveRequestId,
      cancelDates: ['2026-08-01'],
      today: '2026-07-15',
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    // Give back 0.5 (the half Saturday, toggle OFF).
    expect(await ledgerBalance(subject.employmentId, annualId)).toBe(15);
  });

  it('weighted splitSpanForCancellation segments sum correctly (pure)', () => {
    const dates = [
      { date: '2026-07-27', weight: 1 },
      { date: '2026-07-28', weight: 1 },
      { date: '2026-08-01', weight: 0.5 },
    ];
    const r = splitSpanForCancellation(dates, ['2026-07-28']);
    expect(r.segments).toEqual([
      { from: '2026-07-27', to: '2026-07-27', days: 1 },
      { from: '2026-07-28', to: '2026-07-28', days: 1 },
      { from: '2026-08-01', to: '2026-08-01', days: 0.5 },
    ]);
    expect(r.cancelledSegmentIndexes).toEqual([1]);
  });

  it('back-compat: a plain string[] input still defaults every date to weight 1', () => {
    const r = splitSpanForCancellation(['2026-07-27', '2026-07-28'], []);
    expect(r.segments).toEqual([{ from: '2026-07-27', to: '2026-07-28', days: 2 }]);
  });
});

describe('Frozen days (D6) — toggle/schedule flips do not recompute pending or approved requests', () => {
  it('submit under OFF (0.5), flip ON, approve still debits 0.5', async () => {
    await setSaturdayHalf();
    const e = await hire('Frozen');
    await grantLedger(e.employmentId, annualId, '10.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    expect(r.days).toBe(0.5);
    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(e.employmentId, annualId)).toBe(9.5); // still 0.5, not recomputed to 1.0
  });
});

describe('Calendar-days boundary (D7)', () => {
  it('a counting=calendar_days type on a half Saturday deducts 1.0 regardless of marker/toggle', async () => {
    await setSaturdayHalf();
    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const e = await hire('Calendar');
    await grantLedger(e.employmentId, unpaidId, '10.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: unpaidId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    expect(r.days).toBe(1); // calendar_days ignores the half marker entirely
  });
});

describe('Validation', () => {
  it('rejects overlapping working/half arrays', async () => {
    await expect(
      setAttendancePolicy(adminCtx(b), {
        companyId: b.companyId,
        workStart: '09:00',
        workEnd: '18:00',
        breakMinutes: 60,
        lateAfter: '09:15',
        halfDayBefore: '13:00',
        workingDays: [1, 2, 3, 4, 5, 6],
        halfWorkingDays: [6],
      }),
    ).rejects.toThrow(/both a Full working day and a Half working day/);
  });

  it('accepts an all-half schedule (union guard)', async () => {
    await setAttendancePolicy(adminCtx(b), {
      companyId: b.companyId,
      workStart: '09:00',
      workEnd: '18:00',
      breakMinutes: 60,
      lateAfter: '09:15',
      halfDayBefore: '13:00',
      workingDays: [],
      halfWorkingDays: [1, 2, 3, 4, 5],
    });
    const rows = await owner.db
      .select()
      .from(schema.attendancePolicy)
      .where(eq(schema.attendancePolicy.companyId, b.companyId));
    expect(rows[0].halfWorkingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a schedule with neither working nor half days', async () => {
    await expect(
      setAttendancePolicy(adminCtx(b), {
        companyId: b.companyId,
        workStart: '09:00',
        workEnd: '18:00',
        breakMinutes: 60,
        lateAfter: '09:15',
        halfDayBefore: '13:00',
        workingDays: [],
        halfWorkingDays: [],
      }),
    ).rejects.toThrow(/working day/);
  });

  it('rest-day full_day request is still rejected (weight 0)', async () => {
    await setSaturdayHalf(); // Sunday (7) is still rest
    const e = await hire('RestReject');
    await grantLedger(e.employmentId, annualId, '10.00');
    await expect(
      requestLeave(adminCtx(b), {
        employmentId: e.employmentId,
        leaveTypeId: annualId,
        startDate: '2026-08-02', // Sunday
        endDate: '2026-08-02',
      }),
    ).rejects.toThrow();
  });

  it('half_day_am on a half date stays 0.5 with toggle ON (D4)', async () => {
    await setSaturdayHalf();
    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    await owner.db.update(schema.leaveType).set({ durations: ['half_day_am'] }).where(eq(schema.leaveType.id, annualId));
    const e = await hire('HalfDayAm');
    await grantLedger(e.employmentId, annualId, '10.00');
    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      durationType: 'half_day_am',
    });
    expect(r.days).toBe(0.5); // unaffected by the toggle — the toggle governs schedule day type, not chosen duration
  });

  it('previewLeaveDeduction returns exactly what requestLeave would store', async () => {
    await setSaturdayHalf();
    const e = await hire('Preview');
    await grantLedger(e.employmentId, annualId, '10.00');
    const preview = await previewLeaveDeduction(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      durationType: 'full_day',
    });
    expect(preview.days).toBe(0.5);
    expect(preview.balanceAvailable).toBe(10);
    expect(preview.balanceAfter).toBe(9.5);
    expect(preview.hasHalfScheduleDate).toBe(true);

    const r = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: '2026-08-01',
      endDate: '2026-08-01',
    });
    expect(r.days).toBe(preview.days);
  });
});
