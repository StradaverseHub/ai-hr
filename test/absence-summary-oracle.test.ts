/**
 * e2632276 — THE SAFETY PROPERTY, PROVED RATHER THAN ASSERTED.
 *
 * The approved plan promises the reporter, in the mockup they signed off: "All 9 of your companies keep
 * behaving exactly as they do now until you turn it on." `attendanceMonthSummary` is the hard case for
 * that promise, because it is NOT a report — `evaluateAllowancesForPeriod` → `evaluateMonthly`
 * (core/attendance-allowance.ts) reads `present`, `late`, `absent` and `leaveDays` straight off these rows
 * and decides whether a policy's `amount` is transferred onto a payroll batch. A change here is a change
 * to who gets paid, on every company, on day one.
 *
 * So this file does not check a LIST of expected differences — a list is only ever as good as the reading
 * that produced it, and the reading is exactly what went wrong. It runs MAIN'S OWN ALGORITHM, transcribed
 * verbatim below as `mainMonthSummary`, and the branch's `attendanceMonthSummary`, over the SAME database,
 * and asserts the two arrays are deep-equal — every row, every field. Anything the corrected rules change
 * while the switch is off fails this test, whether or not anybody thought to look for it.
 *
 * The fixture is built to make that assertion mean something: every one of the four ways the corrected
 * (`scheduled`) rules differ from the legacy ones is present in it, on its own employee, plus the tally
 * fields (late / half_day / worked minutes / the three OT buckets / the two compliance flags) so a
 * regression in the parts that were NOT meant to move is caught too. The second half of the file then
 * switches the policy on and asserts each difference APPEARS — because a gate that never opens would also
 * pass the first half.
 *
 * MAY 2026: 31 days, 21 Mon–Fri days, 5 Fridays, safely in the past.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { attendance, attendancePolicy, employment, person } from '../db/schema';
import { attendanceForDate, attendanceForEmploymentRange, attendanceMonthSummary } from '../core/attendance';
import { statusOf } from '../core/attendance-derive';
import { holidayDatesFor } from '../core/holidays';
import { approvedLeaveDates } from '../core/leave';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const PERIOD = '2026-05';
/** Past the month end, so the "not yet happened" clamp is inert and the run is deterministic. */
const TODAY = '2026-06-30';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE ORACLE. `core/attendance.ts@main`, `attendanceMonthSummary`, copied without edit except for the
// three module-private helpers it closed over (DEFAULTS.workingDays, unionWorkingDays, isoWeekday), which
// are reproduced here as literal copies. It deliberately imports NOTHING private from the module under
// test: an oracle that shared a helper with the code it audits could not catch a change to that helper.
//
// Provenance:  git show main:core/attendance.ts   →  export function attendanceMonthSummary
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const MAIN_DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
const mainUnionWorkingDays = (workingDays: number[], halfWorkingDays: number[]): number[] => [
  ...new Set([...workingDays, ...halfWorkingDays]),
];
const mainIsoWeekday = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};
const MAIN_OT_CAP_MINUTES = 104 * 60;
const MAIN_WEEK_LIMIT_MINUTES = 45 * 60;

function mainMonthSummary(ctx: SessionContext, p: { month: string; companyIds?: string[]; today: string }) {
  return withTenant(ctx, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const today = p.today;
    const lastCounted = today < monthEnd ? today : monthEnd; // absence only up to today

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return [];
    const empIds = emps.map((e) => e.employmentId);

    const [rows, approvedDates, policies] = await Promise.all([
      tx
        .select({
          employmentId: attendance.employmentId,
          date: attendance.attendanceDate,
          status: attendance.status,
          dayType: attendance.dayType,
          workedMinutes: attendance.workedMinutes,
          otMinutes: attendance.otMinutes,
        })
        .from(attendance)
        .where(
          and(
            inArray(attendance.employmentId, empIds),
            gte(attendance.attendanceDate, monthStart),
            lte(attendance.attendanceDate, monthEnd),
          ),
        ),
      approvedLeaveDates(tx, empIds, monthStart, monthEnd),
      tx
        .select({
          companyId: attendancePolicy.companyId,
          workingDays: attendancePolicy.workingDays,
          halfWorkingDays: attendancePolicy.halfWorkingDays,
        })
        .from(attendancePolicy),
    ]);

    const daysByCompany = new Map(
      policies.map((pp) => [pp.companyId, mainUnionWorkingDays(pp.workingDays, pp.halfWorkingDays)]),
    );
    const holidaysByEmp = new Map<string, Set<string>>();
    for (const e of emps) {
      holidaysByEmp.set(
        e.employmentId,
        await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: monthStart, endDate: monthEnd }),
      );
    }
    const rowsByEmp = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = rowsByEmp.get(r.employmentId);
      if (arr) arr.push(r);
      else rowsByEmp.set(r.employmentId, [r]);
    }

    const MS_DAY = 86_400_000;
    const mondayOf = (iso: string) => {
      const d = new Date(`${iso}T00:00:00Z`);
      const off = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - off * MS_DAY).toISOString().slice(0, 10);
    };

    return emps.map((e) => {
      const myRows = rowsByEmp.get(e.employmentId) ?? [];
      const recorded = new Set(myRows.map((r) => r.date));
      const myLeaveDates = approvedDates.get(e.employmentId) ?? new Set<string>();
      const onLeave = (d: string) => myLeaveDates.has(d);
      const workingDays = daysByCompany.get(e.companyId) ?? MAIN_DEFAULT_WORKING_DAYS;
      const empHolidays = holidaysByEmp.get(e.employmentId) ?? new Set<string>();
      const isHoliday = (d: string) => empHolidays.has(d);

      let present = 0;
      let late = 0;
      let halfDay = 0;
      let workedMinutes = 0;
      let otWorkday = 0;
      let otRestDay = 0;
      let otHoliday = 0;
      const weekMinutes = new Map<string, number>();
      for (const r of myRows) {
        if (r.status === 'late') late += 1;
        else if (r.status === 'half_day') halfDay += 1;
        else present += 1;
        workedMinutes += r.workedMinutes ?? 0;
        const ot = r.otMinutes ?? 0;
        if (r.dayType === 'rest_day') otRestDay += ot;
        else if (r.dayType === 'holiday') otHoliday += ot;
        else otWorkday += ot;
        const wk = mondayOf(r.date);
        weekMinutes.set(wk, (weekMinutes.get(wk) ?? 0) + (r.workedMinutes ?? 0));
      }

      let absent = 0;
      let leaveDays = 0;
      for (let ms = Date.parse(`${monthStart}T00:00:00Z`); ; ms += MS_DAY) {
        const d = new Date(ms).toISOString().slice(0, 10);
        if (d > lastCounted) break;
        if (d < e.hiredOn) continue;
        if (!workingDays.includes(mainIsoWeekday(d))) continue;
        if (isHoliday(d)) continue;
        if (recorded.has(d)) continue;
        if (onLeave(d)) leaveDays += 1;
        else absent += 1;
      }

      const totalOt = otWorkday + otRestDay + otHoliday;
      return {
        employmentId: e.employmentId,
        name: e.name,
        employeeCode: e.employeeCode,
        present,
        late,
        halfDay,
        absent,
        leaveDays,
        workedMinutes,
        otWorkday,
        otRestDay,
        otHoliday,
        otCapExceeded: totalOt > MAIN_OT_CAP_MINUTES,
        over45hWeek: [...weekMinutes.values()].some((v) => v > MAIN_WEEK_LIMIT_MINUTES),
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── fixture
let b: Base;
/** Every employee the fixture builds, by the role they play in the comparison. */
type Cast = Record<string, string>;

const WEEKDAYS = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const iso = `2026-05-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso);
  }
  return out;
})();

async function makeEmp(name: string, hiredOn = '2020-01-01', defaultShiftId: string | null = null) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn, defaultShiftId })
    .returning({ id: schema.employment.id });
  return e.id;
}

const addAttendance = (
  employmentId: string,
  date: string,
  status: 'present' | 'absent' | 'late' | 'half_day',
  extra: { dayType?: 'workday' | 'rest_day' | 'holiday'; workedMinutes?: number; otMinutes?: number } = {},
) =>
  owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId,
    attendanceDate: date,
    status,
    dayType: extra.dayType ?? 'workday',
    workedMinutes: extra.workedMinutes ?? (status === 'absent' ? 0 : 480),
    otMinutes: extra.otMinutes ?? 0,
  });

async function addLeave(
  employmentId: string,
  from: string,
  to: string,
  o: { durationType?: 'full_day' | 'half_day_am' | 'hourly'; days?: number } = {},
) {
  const code = `LT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: true })
    .returning({ id: schema.leaveType.id });
  await owner.db.insert(schema.leaveRequest).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: lt.id,
    startDate: from,
    endDate: to,
    days: String(o.days ?? 1),
    durationType: o.durationType ?? 'full_day',
    status: 'approved',
  });
}

async function makeShift(pattern: number[] | null) {
  const code = `S${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const [s] = await owner.db
    .insert(schema.shift)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      code,
      name: code,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: pattern,
    })
    .returning({ id: schema.shift.id });
  return s.id;
}

/**
 * One company holding every case the corrected rules touch, plus the ones they must NOT touch. Names are
 * prefixed so the fixed `order by full_name` makes the two arrays line up readably in a diff.
 */
async function buildCast(): Promise<Cast> {
  const patternShift = await makeShift([1, 2, 3, 4]); //  Mon–Thu; no Friday
  const weekendShift = await makeShift([1, 2, 3, 4, 5]);

  const cast: Cast = {
    // (a) rows explicitly marked absent — legacy files them under `present` and skips the date.
    markedAbsent: await makeEmp('01 Marked Absent'),
    // (b) a rostered rest day on an ordinary company working day.
    rosteredRest: await makeEmp('02 Rostered Rest'),
    // (c) a rostered SHIFT on a company non-working day (a Saturday).
    rosteredWeekend: await makeEmp('03 Rostered Weekend'),
    // (b′) a default-shift weekly pattern that excludes Fridays.
    patternRest: await makeEmp('04 Pattern Rest', '2020-01-01', patternShift),
    // (d) an approved HALF-DAY leave date with no attendance row at all.
    halfDayLeave: await makeEmp('05 Half Day Leave'),
    // Controls — none of these may move under either rule set.
    fullDayLeave: await makeEmp('06 Full Day Leave'),
    leaveAndRow: await makeEmp('07 Leave And Row'),
    onHoliday: await makeEmp('08 On Holiday'),
    joiner: await makeEmp('09 Mid Month Joiner', '2026-05-18'),
    tally: await makeEmp('10 Tally Statuses'),
    bare: await makeEmp('11 Bare Nothing'),
  };

  await addAttendance(cast.markedAbsent, '2026-05-04', 'absent');
  await addAttendance(cast.markedAbsent, '2026-05-05', 'absent');
  await addAttendance(cast.markedAbsent, '2026-05-06', 'present');

  await owner.db.insert(schema.rosterAssignment).values([
    { tenantId: b.tenantId, employmentId: cast.rosteredRest, shiftDate: '2026-05-04', isRestDay: true },
    { tenantId: b.tenantId, employmentId: cast.rosteredRest, shiftDate: '2026-05-05', isRestDay: true },
    {
      tenantId: b.tenantId,
      employmentId: cast.rosteredWeekend,
      shiftDate: '2026-05-02', // a Saturday
      shiftId: weekendShift,
      isRestDay: false,
    },
  ]);

  await addLeave(cast.halfDayLeave, '2026-05-07', '2026-05-07', { durationType: 'half_day_am', days: 0.5 });
  await addLeave(cast.fullDayLeave, '2026-05-11', '2026-05-12', { days: 2 });
  await addLeave(cast.leaveAndRow, '2026-05-13', '2026-05-13', { days: 1 });
  await addAttendance(cast.leaveAndRow, '2026-05-13', 'present');

  await owner.db
    .insert(schema.holiday)
    .values({ tenantId: b.tenantId, country: 'MY', holidayDate: '2026-05-25', name: 'PH 25 May' });

  // The tally fields: one of each status, OT on all three day types, and a >45h week + >104h OT month so
  // both compliance flags are exercised rather than being trivially false on every row.
  await addAttendance(cast.tally, '2026-05-04', 'late', { workedMinutes: 600, otMinutes: 3000 });
  await addAttendance(cast.tally, '2026-05-05', 'half_day', { workedMinutes: 240, otMinutes: 1500 });
  await addAttendance(cast.tally, '2026-05-06', 'present', { workedMinutes: 700, otMinutes: 1500, dayType: 'rest_day' });
  await addAttendance(cast.tally, '2026-05-07', 'present', { workedMinutes: 700, otMinutes: 500, dayType: 'holiday' });
  return cast;
}

/** Switch the absence deduction ON for the named employments, via a directly-assigned payroll policy. */
async function switchOn(a: SessionContext, employmentIds: string[]) {
  const { id } = await createPolicy(a, {
    companyId: b.companyId,
    name: `Absence ${randomUUID().slice(0, 8)}`,
    policyType: 'monthly',
    config: { leave: { deductAbsentDays: true } },
  });
  for (const employmentId of employmentIds) await assignPolicy(a, { employmentId, policyId: id });
}

const summary = (a: SessionContext) =>
  attendanceMonthSummary(a, { month: PERIOD, companyIds: [b.companyId], today: TODAY });
const oracle = (a: SessionContext) => mainMonthSummary(a, { month: PERIOD, companyIds: [b.companyId], today: TODAY });
const rowFor = <T extends { employmentId: string }>(rows: T[], id: string) => rows.find((r) => r.employmentId === id)!;

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — with the switch OFF the month roll-up is main, field for field', () => {
  it('the fixture really does exercise every case (guard against a vacuous comparison)', async () => {
    const a = await entitledCtx(b);
    const cast = await buildCast();
    const rows = await oracle(a);
    expect(rows).toHaveLength(Object.keys(cast).length);
    // A vacuous fixture — one where the corrected rules happen to have nothing to bite on — would make the
    // deep-equal below pass for the wrong reason. These are the legacy figures the corrections will move.
    // BASELINE = 20: the month's 21 Mon–Fri days less the 25 May public holiday, which is national and so
    // applies to every one of these employees under both rule sets.
    expect(rowFor(rows, cast.markedAbsent).present).toBe(3); //    two of them are explicit no-shows
    expect(rowFor(rows, cast.markedAbsent).absent).toBe(17); //    20 − the 3 recorded dates, absent or not
    expect(rowFor(rows, cast.rosteredRest).absent).toBe(20); //    both rostered rest days charged
    expect(rowFor(rows, cast.rosteredWeekend).absent).toBe(20); // the rostered Saturday NOT charged
    expect(rowFor(rows, cast.patternRest).absent).toBe(20); //     all 5 Fridays charged
    expect(rowFor(rows, cast.halfDayLeave).absent).toBe(20); //    the half-day leave date charged in full
  });

  it('THE DELIVERABLE — attendanceMonthSummary === main, every row, every field', async () => {
    const a = await entitledCtx(b);
    await buildCast();
    const [mine, main] = await Promise.all([summary(a), oracle(a)]);
    // Deep equality over the whole array: present, late, halfDay, absent, leaveDays, workedMinutes, the
    // three OT buckets, otCapExceeded, over45hWeek, and the identity columns — in the same order.
    expect(mine).toEqual(main);
  });

  it('…and still equals main when the month is only half elapsed (the `today` clamp)', async () => {
    const a = await entitledCtx(b);
    await buildCast();
    const mid = { month: PERIOD, companyIds: [b.companyId], today: '2026-05-14' };
    const [mine, main] = await Promise.all([attendanceMonthSummary(a, mid), mainMonthSummary(a, mid)]);
    expect(mine).toEqual(main);
  });

  it('…and when ONE employee of the company is switched on, everybody else is still main', async () => {
    const a = await entitledCtx(b);
    const cast = await buildCast();
    const main = await oracle(a);
    await switchOn(a, [cast.rosteredRest]);
    const mine = await summary(a);
    // The gate is per EMPLOYMENT (it lives on the assigned payroll policy), not per company. Everyone
    // except the one switched-on employee must still match main exactly.
    for (const row of main) {
      if (row.employmentId === cast.rosteredRest) continue;
      expect(rowFor(mine, row.employmentId)).toEqual(row);
    }
    expect(rowFor(mine, cast.rosteredRest).absent).toBe(18); // …and that one did move (20 − 2 rest days)
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — with the switch ON each correction appears (the gate opens)', () => {
  it('all four corrections land, and nothing else does', async () => {
    const a = await entitledCtx(b);
    const cast = await buildCast();
    const main = await oracle(a);
    await switchOn(a, Object.values(cast));
    const mine = await summary(a);

    // Baseline for every employee is 20 scheduled days: 21 Mon–Fri less the 25 May public holiday.
    // (a) an explicitly-marked Absent row is absent, not present.
    expect(rowFor(main, cast.markedAbsent)).toMatchObject({ present: 3, absent: 17 });
    expect(rowFor(mine, cast.markedAbsent)).toMatchObject({ present: 1, absent: 19 });
    // (b) a rostered rest day on a company working day is no longer an absence.
    expect(rowFor(mine, cast.rosteredRest).absent).toBe(18); //   20 − 2 rostered rest days
    // (b′) …nor is a Friday the employee's default-shift pattern excludes.
    expect(rowFor(mine, cast.patternRest).absent).toBe(15); //    20 − the month's 5 Fridays
    // (c) a rostered SHIFT on a company non-working day IS a scheduled day, and so can be absent.
    expect(rowFor(mine, cast.rosteredWeekend).absent).toBe(21); // 20 + the rostered Saturday
    // (d) an approved half-day leave date is not a whole absent day.
    expect(rowFor(mine, cast.halfDayLeave).absent).toBe(19);

    // The controls do not move — under either rule set.
    for (const key of ['fullDayLeave', 'leaveAndRow', 'onHoliday', 'joiner', 'tally', 'bare'] as const) {
      expect(rowFor(mine, cast[key])).toEqual(rowFor(main, cast[key]));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The daily / individual Records loaders read the same scheduling ladder, and `context` is what decides
// whether statusOf prints a red "Absent". It is gated on the same switch, for the same reason: the roster
// fix is real, but shipping it un-asked-for would change what nine companies' Attendance screens say on
// day one — and the month roll-up that pays attendance allowances reads the same rule.
describe('e2632276 — the Records screens are gated on the same switch', () => {
  const rosterRest = async (employmentId: string) =>
    owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });

  it('OFF — a rostered rest day on a company working day still reads the old red Absent', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Gated Daily');
    await rosterRest(e);
    const row = (await attendanceForDate(a, '2026-05-04')).find((r) => r.employmentId === e)!;
    expect(row.context).toBeNull(); //          exactly what main returns for this row
    expect(statusOf(row)).toBe('absent');
    expect(row.isRosterRest).toBe(true); //     the shift COLUMN has always honoured the roster; only the
    //                                          context (and therefore the status pill) did not.
    const [range] = await attendanceForEmploymentRange(a, e, '2026-05-04', '2026-05-04');
    expect(range.context).toBeNull();
    expect(statusOf(range)).toBe('absent');
  });

  it('ON — the same day reads REST on both screens', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Ungated Daily');
    await rosterRest(e);
    await switchOn(a, [e]);
    const row = (await attendanceForDate(a, '2026-05-04')).find((r) => r.employmentId === e)!;
    expect(row.context).toBe('rest_day');
    expect(statusOf(row)).toBe('rest');
    const [range] = await attendanceForEmploymentRange(a, e, '2026-05-04', '2026-05-04');
    expect(range.context).toBe('rest_day');
    expect(statusOf(range)).toBe('rest');
  });

  it('a default-shift pattern rest day is gated too, and reads OFF (not REST) when open', async () => {
    const a = await entitledCtx(b);
    const shiftId = await makeShift([1, 2, 3, 4]); // Mon–Thu
    const e = await makeEmp('Pattern Daily', '2020-01-01', shiftId);
    const before = (await attendanceForDate(a, '2026-05-08')).find((r) => r.employmentId === e)!; // a Friday
    expect(before.context).toBeNull();
    expect(statusOf(before)).toBe('absent');

    await switchOn(a, [e]);
    const after = (await attendanceForDate(a, '2026-05-08')).find((r) => r.employmentId === e)!;
    expect(after.context).toBe('rest_day');
    expect(after.isRosterRest).toBe(false); // a pattern rest day is OFF, not an explicit rostered rest
    expect(statusOf(after)).toBe('off');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The gate is resolved by deductAbsentDaysByEmployment, a BATCHED mirror of resolveAssignedPolicy. If it
// ever disagreed with the kernel's own resolver, a screen would show one thing and the payslip another.
describe('e2632276 — the switch resolves exactly as the payroll kernel resolves it', () => {
  it('an INACTIVE policy is not switched on (it resolves to the monthly default)', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Inactive Policy');
    await switchOn(a, [e]);
    expect((await summary(a)).find((r) => r.employmentId === e)!.absent).toBe(21);
    await owner.db
      .update(schema.payrollPolicy)
      .set({ status: 'inactive' })
      .where(eq(schema.payrollPolicy.companyId, b.companyId));
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });
    // Inactive ⇒ legacy rules ⇒ the rostered rest day is charged again, exactly as the kernel would.
    expect((await summary(a)).find((r) => r.employmentId === e)!.absent).toBe(21);
  });

  it("the COMPANY DEFAULT payroll policy switches on an employment with no direct assignment", async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Company Default');
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });
    expect((await summary(a)).find((r) => r.employmentId === e)!.absent).toBe(21);

    const { id } = await createPolicy(a, {
      companyId: b.companyId,
      name: `Default ${randomUUID().slice(0, 8)}`,
      policyType: 'monthly',
      config: { leave: { deductAbsentDays: true } },
    });
    await owner.db
      .insert(schema.companyPayrollConfig)
      .values({ tenantId: b.tenantId, companyId: b.companyId, defaultPayrollPolicyId: id })
      .onConflictDoUpdate({
        target: schema.companyPayrollConfig.companyId,
        set: { defaultPayrollPolicyId: id },
      });
    expect((await summary(a)).find((r) => r.employmentId === e)!.absent).toBe(20);
  });

  it('RLS: a plain employee resolves a DIRECTLY-ASSIGNED switch, and fails SAFE on a company default', async () => {
    // Two tables answer "is the switch on", and they do not have the same read RLS.
    //   payroll_policy            — tenant-wide SELECT (migration 0128, deliberately: the kernel resolves it
    //                               under the caller's possibly-non-admin session).
    //   company_payroll_config    — app.is_admin_for(company_id) for READ as well as write (migration 0081).
    // So the company-DEFAULT rung is invisible to a non-admin session. `resolveAssignedPolicy` has always
    // had that property; it never mattered because only the payroll kernel called it, and payroll is
    // admin-gated. It matters now that the Records screens read the same switch, so the direction it fails
    // in is pinned here: a non-admin sees LEGACY, which is exactly what production shows today. Never the
    // other way round — a non-admin must not be shown a corrected count an admin would not.
    const a = await entitledCtx(b);
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Self Service', primaryEmail: `self_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
      .returning({ id: schema.employment.id });
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: emp.id,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });
    const uid = await createAppUser(b.tenantId, p.id, 'employee');
    const self = { tenantId: b.tenantId, userId: uid, personId: p.id, roles: ['employee'] } as unknown as SessionContext;
    const contextFor = async (ctx: SessionContext) =>
      (await attendanceForEmploymentRange(ctx, emp.id, '2026-05-04', '2026-05-04'))[0].context;

    // (1) COMPANY DEFAULT — the admin sees the corrected rest day; the employee's own screen does not.
    const { id: defPolicy } = await createPolicy(a, {
      companyId: b.companyId,
      name: `Default ${randomUUID().slice(0, 8)}`,
      policyType: 'monthly',
      config: { leave: { deductAbsentDays: true } },
    });
    await owner.db
      .insert(schema.companyPayrollConfig)
      .values({ tenantId: b.tenantId, companyId: b.companyId, defaultPayrollPolicyId: defPolicy })
      .onConflictDoUpdate({ target: schema.companyPayrollConfig.companyId, set: { defaultPayrollPolicyId: defPolicy } });
    expect(await contextFor(a)).toBe('rest_day');
    expect(await contextFor(self)).toBeNull(); // fails SAFE: today's behaviour, not a corrected one

    // (2) DIRECT ASSIGNMENT — payroll_policy is tenant-wide readable, so both sessions agree.
    await assignPolicy(a, { employmentId: emp.id, policyId: defPolicy });
    expect(await contextFor(a)).toBe('rest_day');
    expect(await contextFor(self)).toBe('rest_day');
  });
});
