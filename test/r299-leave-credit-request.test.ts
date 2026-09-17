/**
 * 3fb1a611 (r299) · A LEAVE CREDIT REQUEST EARNS ONLY FOR A REST DAY, OFF DAY OR PUBLIC HOLIDAY.
 *
 * Until this round the employee request path accepted ANY date (core/toil.ts accrueSelfDeclaredToilTx sent a
 * NULL day type), while the roster and auto paths refused an ordinary working day. The day kind is now
 * resolved per line from the employee's schedule — rostered shift → public holiday → rostered rest → default
 * shift's four-way pattern → company working days, the ladder the attendance engine freezes onto a row — at
 * submission (the courtesy) and again at approval (the guarantee), and stamped on the credit.
 *
 * Dates are derived from todayInKualaLumpur(): every worked date is in last calendar month.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { assignDefaultShift, assignShift, createShift, setRestDay } from '../core/roster';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setToilPolicy, ToilOrdinaryWorkingDayError, type ToilPolicyInput } from '../core/toil';
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '../core/replacement-request';

let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
const PERIOD = (() => {
  const [y, m] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
})();
/** The n-th (1-based) date in PERIOD with this ISO weekday (1 = Monday … 7 = Sunday). */
const weekdayOf = (isoWeekday: number, nth = 1) => {
  let seen = 0;
  for (let d = 1; d <= 28; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    if ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === isoWeekday && ++seen === nth) return date;
  }
  throw new Error('unreachable');
};

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
  ...over,
});

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Requester', primaryEmail: `r299q_${Math.random().toString(36).slice(2)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return e.employmentId;
}

const submit = (employmentId: string, dates: string[]) =>
  submitReplacementLeaveRequest(ctx, {
    employmentId,
    unit: 'day',
    lines: dates.map((workedDate) => ({ workedDate, days: 1 })),
    reason: 'Covered the weekend',
    today: TODAY,
  });

const creditsOf = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.toilAccrual)
    .where(eq(schema.toilAccrual.employmentId, employmentId))
    .orderBy(asc(schema.toilAccrual.workedDate));

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
  await setToilPolicy(ctx, policy());
});

describe('Leave Credit request — the day-type gate (3fb1a611 gap 1)', () => {
  it('refuses an ordinary working day at submission, naming every such date, and writes nothing', async () => {
    const employmentId = await hire();
    const mon = weekdayOf(1);
    const tue = weekdayOf(2);
    const sat = weekdayOf(6);
    const refused = submit(employmentId, [sat, mon, tue]);
    await expect(refused).rejects.toBeInstanceOf(ToilOrdinaryWorkingDayError);
    await expect(refused).rejects.toThrow(new RegExp(`${mon}, ${tue} are ordinary working days`));
    const reqs = await owner.db
      .select()
      .from(schema.replacementLeaveRequest)
      .where(eq(schema.replacementLeaveRequest.employmentId, employmentId));
    expect(reqs).toHaveLength(0);
  });

  it('accepts a REST day, an OFF day and a PUBLIC HOLIDAY, and stamps each kind on its credit', async () => {
    const employmentId = await hire();
    // Default shift: Mon–Fri working, Saturday OFF, Sunday REST (in nothing).
    const shift = await createShift(adminCtx(b), {
      name: 'Office with off Saturday',
      code: 'OFF_SAT',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    await assignDefaultShift(adminCtx(b), { employmentId, shiftId: shift.id });
    const offDay = weekdayOf(6);
    const restDay = weekdayOf(7);
    const holiday = weekdayOf(3, 2); // a Wednesday — a working day on the shift — made a public holiday
    await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'MY', holidayDate: holiday, name: 'Test PH' });

    const { requestId } = await submit(employmentId, [offDay, restDay, holiday]);
    const res = await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved' });
    expect(res.granted).toBe(3);

    const credits = await creditsOf(employmentId);
    const byDate = Object.fromEntries(credits.map((c) => [c.workedDate, { kind: c.workedDayKind, dayType: c.dayType }]));
    expect(byDate[offDay]).toEqual({ kind: 'off_day', dayType: null });
    // r299 fix pass — the KIND is stamped on every credit; the valuation day type is not (see toil-expiry).
    expect(byDate[restDay]).toEqual({ kind: 'rest_day', dayType: null });
    expect(byDate[holiday]).toEqual({ kind: 'holiday', dayType: null });
  });

  it('a rostered rest day on a weekday is a rest day; a rostered SHIFT on a Saturday is a working day', async () => {
    const employmentId = await hire();
    const wed = weekdayOf(3);
    const sat = weekdayOf(6, 2);
    await setRestDay(adminCtx(b), { employmentId, shiftDate: wed });
    const shift = await createShift(adminCtx(b), {
      name: 'Weekend cover',
      code: 'WKND',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignShift(adminCtx(b), { employmentId, shiftId: shift.id, shiftDate: sat });

    await expect(submit(employmentId, [sat])).rejects.toBeInstanceOf(ToilOrdinaryWorkingDayError);
    const { requestId } = await submit(employmentId, [wed]);
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved' });
    const [credit] = await creditsOf(employmentId);
    expect(credit.workedDayKind).toBe('rest_day');
  });

  it('is checked AGAIN at approval: a rest day rostered to work in between is refused, and the approval rolls back', async () => {
    const employmentId = await hire();
    const sat = weekdayOf(6);
    const { requestId } = await submit(employmentId, [sat]);
    // Between submission and approval, the employee is rostered to work that Saturday.
    const shift = await createShift(adminCtx(b), {
      name: 'Saturday shift',
      code: 'SAT_SHIFT',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignShift(adminCtx(b), { employmentId, shiftId: shift.id, shiftDate: sat });

    await expect(decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved' })).rejects.toBeInstanceOf(
      ToilOrdinaryWorkingDayError,
    );
    expect(await creditsOf(employmentId)).toHaveLength(0);
    const [req] = await owner.db
      .select({ status: schema.replacementLeaveRequest.status })
      .from(schema.replacementLeaveRequest)
      .where(eq(schema.replacementLeaveRequest.id, requestId));
    expect(req.status).toBe('pending');
  });
});
