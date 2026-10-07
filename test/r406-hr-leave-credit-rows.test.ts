/**
 * r406 952129bb · HR's + ADD LEAVE CREDIT AS THE EMPLOYEE'S FORM — `grantLeaveCreditRows`, against a real roster.
 *
 * ⚠️ MONEY. A Leave Credit suppresses the worked day's overtime pay (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS)
 * and, for a First-Schedule employee, converts to cash on expiry. What is pinned:
 *
 *  (1) PARITY — for identical rows on identical rosters, the days HR grants EQUAL the days the employee's own
 *      request is approved for, date by date, with the same `ot_minutes` basis and the same expiry; and both
 *      equal the owner's ladder written out as literals (rest 4h → 0.5, off day 8h → 1, an ordinary day floored
 *      at the 14:00 shift end). The literals are what make the parity non-vacuous: two paths that agreed on a
 *      WRONG figure would still fail here. And a company that moves its threshold moves BOTH paths.
 *  (2) THE REFUSALS — own record, outside service, overtime + payroll started, duplicate (twice, and within one
 *      post), day-type mismatch, an ordinary day without the switch, below threshold — each writing NOTHING,
 *      because the grant is one transaction; and a company with employee requests OFF still allows HR.
 *  (3) THE AUDIT — `toil.accrued` per credit names HR as the actor, source `hr_manual_grant`, and carries the
 *      window, the counted minutes and the overtime it suppressed.
 *
 * Non-vacuity of the SHARING (r406 report): `leaveCreditWindowCredit`'s ladder was changed in a scratch edit
 * and both the employee and the HR expectations in (1) failed; restored before commit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection } from '../core/attendance';
import { ClaimOverlapError } from '../core/credit-ot-overlap';
import { assignDefaultShift, assignShift, createShift, setRestDay } from '../core/roster';
import { createBatch } from '../core/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  grantLeaveCreditRows,
  leaveCreditGrantContext,
  leaveCreditGrantDayFacts,
  LeaveCreditError,
  setToilPolicy,
  ToilExtendedHoursBelowThresholdError,
  ToilOrdinaryWorkingDayError,
  ToilSweepForbiddenError,
  type ToilPolicyInput,
} from '../core/toil';
import { LeaveCreditDayTypeMismatchError, submitLeaveCreditRequest, type LeaveCreditRowInput } from '../core/leave-credit-request';
import { decideReplacementLeaveRequest, ReplacementRequestDisabledError } from '../core/replacement-request';
import type { SessionContext } from '../db/client';

let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
const monthBefore = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const PERIOD = monthBefore(TODAY);
const weekdayIn = (isoWeekday: number, nth = 1) => {
  let seen = 0;
  for (let d = 1; d <= 28; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    if ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === isoWeekday && ++seen === nth) return date;
  }
  throw new Error('unreachable');
};
/** Wednesday — an ordinary working day on the Mon–Fri 06:00–14:00 shift, clocked out at 22:00. */
const WORKDAY = weekdayIn(3);
/** Saturday — in the shift's own off pattern ⇒ the roster says OFF day. */
const OFF_DAY = weekdayIn(6);
/** Sunday — explicitly rostered as a rest day. */
const REST_DAY = weekdayIn(7);
/** A second Sunday, no attendance at all ⇒ no overtime on it. */
const QUIET_REST_DAY = weekdayIn(7, 2);
/** One approval instant for both paths, so the expiry is comparable. */
const APPROVED = new Date();

const uniqEmail = () => `r406_${Math.random().toString(36).slice(2)}@t.local`;
const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  extendedHoursEnabled: true,
  extendedHalfDayMinutes: 240,
  extendedFullDayMinutes: 480,
  extendedBreakMinutes: 0,
  extendedGraceMinutes: 0,
  ...over,
});

/** r343's roster: rest Sunday, off Saturday, Wednesday worked 06:00–22:00 on a shift ending 14:00. */
async function hire(name = 'Leave Credit Worker') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 9000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  const shift = await createShift(a, {
    companyId: b.companyId,
    name: `Day ${Math.random().toString(36).slice(2, 7)}`,
    code: `D_${Math.random().toString(36).slice(2, 8)}`,
    startTime: '06:00:00',
    endTime: '14:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    offPattern: [6],
  });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: shift.id });
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: QUIET_REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
  await checkIn(a, { employmentId: e.employmentId, date: OFF_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: OFF_DAY, time: '17:00:00' });
  await assignShift(a, { employmentId: e.employmentId, shiftDate: WORKDAY, shiftId: shift.id });
  await checkIn(a, { employmentId: e.employmentId, date: WORKDAY, time: '06:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: WORKDAY, time: '22:00:00' });
  return e;
}

/** The SAME rows posted down both paths. */
const ROWS: LeaveCreditRowInput[] = [
  // a rest day, four hours: the half-day tier
  { workedDate: REST_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '13:00' },
  // an off day, eight hours: the full day
  { workedDate: OFF_DAY, dayType: 'off_day', claimStart: '09:00', claimEnd: '17:00' },
  // an ordinary day, 12:00–18:00 claimed: floored at the 14:00 shift end ⇒ 240 counted ⇒ half a day
  { workedDate: WORKDAY, dayType: 'workday', claimStart: '12:00', claimEnd: '18:00' },
];
/** The owner's ladder, written out — what both paths must equal, not merely each other. */
const EXPECTED = new Map([
  [REST_DAY, { days: 0.5, minutes: 240 }],
  [OFF_DAY, { days: 1, minutes: 480 }],
  [WORKDAY, { days: 0.5, minutes: 240 }],
]);

const accruals = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.toilAccrual)
    .where(eq(schema.toilAccrual.employmentId, employmentId))
    .orderBy(asc(schema.toilAccrual.workedDate));

/** Employee path end to end: submit the single-table request, then a line manager (here: admin) approves. */
async function employeeApproved(employmentId: string, rows = ROWS) {
  const { requestId } = await submitLeaveCreditRequest(ctx, { employmentId, rows, reason: 'Covered the stock take', today: TODAY });
  await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: APPROVED });
  return accruals(employmentId);
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (err: Error) => err);

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  ctx = await entitledCtx(b);
});

describe('r406 · parity — a day worked earns the same credit whoever enters it', () => {
  it('HR-granted days == employee-approved days, date by date, and both equal the ladder', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const viaEmployee = await hire('Asks For It');
    const viaHr = await hire('HR Enters It');

    const emp = await employeeApproved(viaEmployee.employmentId);
    const hr = await grantLeaveCreditRows(ctx, {
      employmentId: viaHr.employmentId,
      rows: ROWS,
      reason: 'Covered the stock take',
      today: TODAY,
      approvedOn: APPROVED,
    });
    const hrRows = await accruals(viaHr.employmentId);

    expect(emp.map((r) => r.workedDate)).toEqual([...EXPECTED.keys()].sort());
    expect(hrRows.map((r) => r.workedDate)).toEqual([...EXPECTED.keys()].sort());
    for (const date of EXPECTED.keys()) {
      const e = emp.find((r) => r.workedDate === date)!;
      const h = hrRows.find((r) => r.workedDate === date)!;
      const want = EXPECTED.get(date)!;
      expect.soft(Number(e.daysCredited), `employee path ${date}`).toBe(want.days);
      expect.soft(Number(h.daysCredited), `HR path ${date}`).toBe(want.days);
      expect(h.daysCredited, `parity ${date}`).toBe(e.daysCredited);
      // ⚠️ MONEY — the same minutes basis on both, and `day_type` NULL on both (the ORP fallback on expiry).
      expect(h.otMinutes, `ot_minutes ${date}`).toBe(want.minutes);
      expect(h.otMinutes).toBe(e.otMinutes);
      expect(h.dayType).toBeNull();
      expect(e.dayType).toBeNull();
      expect(h.workedDayKind).toBe(e.workedDayKind);
      expect(h.expiresOn, `expiry ${date}`).toBe(e.expiresOn);
      expect(e.source).toBe('employee_request');
      expect(h.source).toBe('hr_manual_grant');
    }
    expect(hr.totalDays).toBe(2);
    expect(hr.rows.map((r) => r.daysCredited).sort()).toEqual([0.5, 0.5, 1]);
  });

  it('a company that MOVES its half-day threshold moves both paths together', async () => {
    // Half a day now needs five hours: the rest day's four-hour window earns nothing on EITHER path.
    await setToilPolicy(adminCtx(b), policy({ extendedHalfDayMinutes: 300 }));
    const viaEmployee = await hire('Asks For It');
    const viaHr = await hire('HR Enters It');
    const rest = [ROWS[0]];
    const e = await refusal(submitLeaveCreditRequest(ctx, { employmentId: viaEmployee.employmentId, rows: rest, reason: 'x', today: TODAY }));
    const h = await refusal(grantLeaveCreditRows(ctx, { employmentId: viaHr.employmentId, rows: rest, reason: 'x', today: TODAY }));
    expect(e).toBeInstanceOf(ToilExtendedHoursBelowThresholdError);
    expect(h).toBeInstanceOf(ToilExtendedHoursBelowThresholdError);
    // …and the full-day row still credits one day on both.
    const off = [ROWS[1]];
    await employeeApproved(viaEmployee.employmentId, off);
    await grantLeaveCreditRows(ctx, { employmentId: viaHr.employmentId, rows: off, reason: 'x', today: TODAY, approvedOn: APPROVED });
    expect((await accruals(viaEmployee.employmentId)).map((r) => Number(r.daysCredited))).toEqual([1]);
    expect((await accruals(viaHr.employmentId)).map((r) => Number(r.daysCredited))).toEqual([1]);
  });

  it('⚠️ the overtime each credit suppresses is returned, per row and in total', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const facts = await leaveCreditGrantDayFacts(ctx, { employmentId: e.employmentId, workedDate: REST_DAY });
    expect(facts.kind).toBe('rest_day');
    expect(facts.overtimeMinutes, 'the fixture really records overtime on the rest day').toBeGreaterThan(0);
    const res = await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[0]], reason: 'x', today: TODAY });
    expect(res.rows[0].overtimeSuppressedMinutes).toBe(facts.overtimeMinutes);
    expect(res.overtimeSuppressedMinutes).toBe(facts.overtimeMinutes);
    expect(res.overtimeDates).toEqual([REST_DAY]);
    expect((await leaveCreditGrantDayFacts(ctx, { employmentId: e.employmentId, workedDate: REST_DAY })).alreadyCredited).toBe(true);
  });
});

describe('r406 · HR refusals — each writes nothing', () => {
  it('own record', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire('HR Themself');
    const self: SessionContext = { ...ctx, personId: e.personId };
    const err = await refusal(grantLeaveCreditRows(self, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'Mine', today: TODAY }));
    expect(err).toBeInstanceOf(ToilSweepForbiddenError);
    expect(err!.message).toMatch(/own record/);
    expect((await leaveCreditGrantContext(self, { employmentId: e.employmentId, today: TODAY })).ownRecord).toBe(true);
    expect(await accruals(e.employmentId)).toHaveLength(0);
  });

  it('outside the employment’s service', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const err = await refusal(
      grantLeaveCreditRows(ctx, {
        employmentId: e.employmentId,
        rows: [ROWS[1], { workedDate: '2023-12-31', dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }],
        reason: 'Before hire',
        today: TODAY,
      }),
    );
    expect(err).toBeInstanceOf(LeaveCreditError);
    expect(err!.message).toMatch(/within this employee's service.*2023-12-31/);
    expect(await accruals(e.employmentId)).toHaveLength(0);
  });

  it('⚠️ overtime + payroll started — and the WHOLE grant rolls back, including the row with no overtime', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    const rows: LeaveCreditRowInput[] = [
      { workedDate: QUIET_REST_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' },
      ROWS[0],
    ];
    const err = await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows, reason: 'Late', today: TODAY }));
    expect(err).toBeInstanceOf(LeaveCreditError);
    expect(err!.message).toMatch(/payroll for that month has already been started/);
    expect(err!.message).toContain(REST_DAY);
    expect(err!.message).not.toContain(QUIET_REST_DAY);
    expect(await accruals(e.employmentId)).toHaveLength(0);
    // CONTROL — the row with no overtime on its own is not a payroll question and goes through.
    const ok = await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [rows[0]], reason: 'Cover', today: TODAY });
    expect(ok.overtimeSuppressedMinutes).toBe(0);
    expect(await accruals(e.employmentId)).toHaveLength(1);
  });

  it('⚠️ a PENDING overtime claim or Leave Credit request on the date refuses the grant (verify D1/D3)', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const asEmployee: SessionContext = { ...ctx, personId: e.personId };
    // A pending overtime claim is not in attendance yet: no per-row warning, no payroll check — refused.
    await requestAttendanceCorrection(asEmployee, { employmentId: e.employmentId, date: OFF_DAY, requestedOtMinutes: 120, reason: 'Stayed late' });
    const ot = await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'Cover', today: TODAY }));
    expect(ot).toBeInstanceOf(ClaimOverlapError);
    expect(ot!.message).toContain(OFF_DAY);
    // A pending Leave Credit request of the employee's own — its approval would fail on the double-bank guard.
    await submitLeaveCreditRequest(ctx, { employmentId: e.employmentId, rows: [ROWS[0]], reason: 'Mine', today: TODAY });
    const own = await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[0]], reason: 'Cover', today: TODAY }));
    expect(own).toBeInstanceOf(ClaimOverlapError);
    expect(own!.message).toContain(REST_DAY);
    expect(await accruals(e.employmentId)).toHaveLength(0);
    // CONTROL — a date with neither goes through.
    const ok = await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [{ workedDate: QUIET_REST_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }], reason: 'Cover', today: TODAY });
    expect(ok.totalDays).toBe(1);
  });

  it('⚠️ after an HR credit, overtime can no longer be claimed for that date (it would be approved and never paid)', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const asEmployee: SessionContext = { ...ctx, personId: e.personId };
    await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'Cover', today: TODAY });
    const err = await refusal(requestAttendanceCorrection(asEmployee, { employmentId: e.employmentId, date: OFF_DAY, requestedOtMinutes: 120, reason: 'Stayed late' }));
    expect(err).toBeInstanceOf(ClaimOverlapError);
    expect(err!.message).toMatch(/already credited/);
    // CONTROL — another date is still claimable.
    await expect(requestAttendanceCorrection(asEmployee, { employmentId: e.employmentId, date: QUIET_REST_DAY, requestedOtMinutes: 120, reason: 'Stayed late' })).resolves.toBeDefined();
  });

  it('duplicate — a date already credited, and a date posted twice', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'First', today: TODAY });
    const again = await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[0], ROWS[1]], reason: 'Again', today: TODAY }));
    expect(again).toBeInstanceOf(LeaveCreditError);
    expect(again!.message).toMatch(new RegExp(`already has a Leave Credit for ${OFF_DAY}`));
    const twice = await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[0], ROWS[0]], reason: 'Twice', today: TODAY }));
    expect(twice).toBeInstanceOf(LeaveCreditError);
    expect(twice!.message).toMatch(/only once/);
    expect((await accruals(e.employmentId)).map((r) => r.workedDate)).toEqual([OFF_DAY]);
  });

  it('day-type mismatch — a rest day posted for the roster’s off day', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const err = await refusal(
      grantLeaveCreditRows(ctx, {
        employmentId: e.employmentId,
        rows: [{ workedDate: OFF_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }],
        reason: 'Tampered',
        today: TODAY,
      }),
    );
    expect(err).toBeInstanceOf(LeaveCreditDayTypeMismatchError);
    expect(err!.message).toMatch(/roster has Off day/);
    expect(await accruals(e.employmentId)).toHaveLength(0);
  });

  it('an ordinary day without the extended-hours switch, and a window below the threshold', async () => {
    await setToilPolicy(adminCtx(b), policy({ extendedHoursEnabled: false }));
    const e = await hire();
    expect(await refusal(grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[2]], reason: 'x', today: TODAY }))).toBeInstanceOf(
      ToilOrdinaryWorkingDayError,
    );
    const short = await refusal(
      grantLeaveCreditRows(ctx, {
        employmentId: e.employmentId,
        rows: [ROWS[1], { workedDate: REST_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '12:00' }],
        reason: 'x',
        today: TODAY,
      }),
    );
    expect(short, 'one short row refuses the whole grant').toBeInstanceOf(ToilExtendedHoursBelowThresholdError);
    expect(await accruals(e.employmentId)).toHaveLength(0);
  });

  it('a future date, an empty window, no reason, and no module', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const base = { employmentId: e.employmentId, reason: 'x', today: TODAY };
    expect(
      (await refusal(grantLeaveCreditRows(ctx, { ...base, rows: [{ ...ROWS[0], workedDate: '2999-01-03' }] })))!.message,
    ).toMatch(/future/);
    expect((await refusal(grantLeaveCreditRows(ctx, { ...base, rows: [{ ...ROWS[0], claimEnd: '09:00' }] })))!.message).toMatch(/are the same/);
    expect((await refusal(grantLeaveCreditRows(ctx, { ...base, reason: '  ', rows: [ROWS[0]] })))!.message).toMatch(/reason is required/);
    await setModule(b.tenantId, 'toil', 'disabled');
    const off = await entitledCtx(b);
    expect(await refusal(grantLeaveCreditRows(off, { ...base, rows: [ROWS[0]] }))).not.toBeNull();
    expect(await accruals(e.employmentId)).toHaveLength(0);
  });
});

describe('r406 · a company with employee requests OFF still allows HR', () => {
  it('the employee is refused; HR grants', async () => {
    await setToilPolicy(adminCtx(b), policy({ employeeRequestEnabled: false }));
    const e = await hire();
    // CONTROL — the switch really is off for the employee path.
    expect(
      await refusal(submitLeaveCreditRequest(ctx, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'x', today: TODAY })),
    ).toBeInstanceOf(ReplacementRequestDisabledError);
    const res = await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[1]], reason: 'Approved by management', today: TODAY });
    expect(res.totalDays).toBe(1);
    expect(await accruals(e.employmentId)).toHaveLength(1);
  });
});

describe('r406 · the audit names HR and the source', () => {
  it('toil.accrued per credit: HR as the actor, hr_manual_grant, the reason, the window and the suppressed overtime', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const e = await hire();
    const res = await grantLeaveCreditRows(ctx, { employmentId: e.employmentId, rows: [ROWS[0], ROWS[2]], reason: 'Approved by management', today: TODAY });
    const ids = res.rows.map((r) => r.accrualId);
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.eventType, 'toil.accrued'), inArray(schema.domainEvent.aggregateId, ids)))
      .orderBy(asc(schema.domainEvent.occurredAt), asc(schema.domainEvent.id));
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.actorType).toBe('user');
      expect(ev.actorId).toBe(b.adminUserId);
      expect(ev.subjectEmploymentId).toBe(e.employmentId);
      const p = ev.payload as Record<string, unknown>;
      expect(p.source).toBe('hr_manual_grant');
      expect(p.note).toBe('Approved by management');
      const row = res.rows.find((r) => r.accrualId === ev.aggregateId)!;
      const posted = [ROWS[0], ROWS[2]].find((r) => r.workedDate === row.workedDate)!;
      expect(p.hrGrant).toEqual({
        claimStart: posted.claimStart,
        claimEnd: posted.claimEnd,
        eligibleMinutes: EXPECTED.get(row.workedDate)!.minutes,
        overtimeSuppressedMinutes: row.overtimeSuppressedMinutes,
      });
    }
    const rows = await accruals(e.employmentId);
    expect(rows.every((r) => r.source === 'hr_manual_grant' && r.note === 'Approved by management')).toBe(true);
  });
});
