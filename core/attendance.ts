/**
 * Attendance — generic, jurisdiction-neutral time engine (ADR-0011).
 *
 * One row per employee per day. Check-in classifies the day (workday / rest day /
 * holiday, frozen on the row); check-out derives worked + overtime minutes from the
 * company work schedule. Absence is implicit (no row) and contextualized at read time
 * (approved leave / holiday / rest day are not "absent"). Each mutation appends a
 * domain event (ADR-0006).
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import {
  assignment,
  attendance,
  attendanceCorrection,
  attendancePolicy,
  company,
  employeeStatutoryMy,
  employment,
  holiday,
  holidayGroup,
  leaveRequest,
  location,
  person,
  rosterAssignment,
  shift,
} from '../db/schema';
import { parseAttendanceCsv } from '../lib/attendance-csv';

export class AlreadyCheckedInError extends Error {
  constructor() {
    super('Already checked in today');
    this.name = 'AlreadyCheckedInError';
  }
}

export type DayType = 'workday' | 'rest_day' | 'holiday';

const DEFAULTS = {
  lateAfter: '09:15:00',
  halfDayBefore: '13:00:00',
  workStart: '09:00:00',
  workEnd: '18:00:00',
  breakMinutes: 60,
  workingDays: [1, 2, 3, 4, 5], // ISO: Mon–Fri
};

const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** ISO weekday (1=Mon … 7=Sun) of a YYYY-MM-DD date. */
export const isoWeekday = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

type Policy = typeof DEFAULTS & { country: string; states: string[] };

/**
 * The holiday-state set for an employee (ADR-0054), resolved in priority order
 *   location.state (open assignment) → holiday_group states → employment.work_state →
 *   company.default_work_state → national-only.
 * This is the SAME precedence core/leave.ts resolves (resolveHolidaySet), with `location.state` as a thin
 * overlay on top, so leave and attendance can never disagree on a state-specific holiday. An empty array
 * ⇒ national-only, identical to today's location-blind behaviour. Mirrors the leave UNION predicate
 * `or(isNull(holiday.state), inArray(holiday.state, states))` (leave.ts:286).
 */
function resolveStates(row: {
  locationState: string | null;
  groupStates: unknown;
  workState: string | null;
  defaultWorkState: string | null;
}): string[] {
  if (row.locationState) return [row.locationState];
  if (Array.isArray(row.groupStates) && row.groupStates.length) return row.groupStates as string[];
  if (row.workState) return [row.workState];
  if (row.defaultWorkState) return [row.defaultWorkState];
  return [];
}

async function policyFor(tx: Tx, employmentId: string): Promise<Policy> {
  const [row] = await tx
    .select({
      lateAfter: attendancePolicy.lateAfter,
      halfDayBefore: attendancePolicy.halfDayBefore,
      workStart: attendancePolicy.workStart,
      workEnd: attendancePolicy.workEnd,
      breakMinutes: attendancePolicy.breakMinutes,
      workingDays: attendancePolicy.workingDays,
      country: company.country,
      workState: employment.workState,
      defaultWorkState: company.defaultWorkState,
      groupStates: holidayGroup.states,
      // Location override comes from the employee's OPEN assignment row (the same predicate org.ts uses).
      locationState: location.state,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .leftJoin(location, eq(location.id, assignment.locationId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    lateAfter: row?.lateAfter ?? DEFAULTS.lateAfter,
    halfDayBefore: row?.halfDayBefore ?? DEFAULTS.halfDayBefore,
    workStart: row?.workStart ?? DEFAULTS.workStart,
    workEnd: row?.workEnd ?? DEFAULTS.workEnd,
    breakMinutes: row?.breakMinutes ?? DEFAULTS.breakMinutes,
    workingDays: row?.workingDays ?? DEFAULTS.workingDays,
    country: row?.country ?? 'MY',
    states: row
      ? resolveStates({
          locationState: row.locationState ?? null,
          groupStates: row.groupStates,
          workState: row.workState ?? null,
          defaultWorkState: row.defaultWorkState ?? null,
        })
      : [],
  };
}

/** Net scheduled minutes of a normal working day (span minus break). */
const scheduledMinutes = (pol: Policy) =>
  Math.max(0, toMinutes(pol.workEnd) - toMinutes(pol.workStart) - pol.breakMinutes);

/**
 * Worked minutes for a raw in→out span: the full break is deducted once the span
 * reaches 6h (a deliberate, conservative simplification — ADR-0011).
 */
const workedFromSpan = (spanMinutes: number, breakMinutes: number) =>
  Math.max(0, spanMinutes - (spanMinutes >= 360 ? breakMinutes : 0));

const MINS_PER_DAY = 1440;
const fmtTime = (mins: number): string =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;
const addGrace = (t: string, grace: number): string => fmtTime((toMinutes(t) + grace) % MINS_PER_DAY);

/** In→out span in minutes, cross-midnight aware: a check-out time-of-day earlier than check-in means the
 *  shift ran past midnight (e.g. 22:00 → 06:00 = 480m), so add a day. For same-day spans this is identical
 *  to (out − in), so non-rostered days are unchanged. */
const spanMinutes = (checkInAt: string, checkOutAt: string): number => {
  const ci = toMinutes(checkInAt);
  const co = toMinutes(checkOutAt);
  return co >= ci ? co - ci : co + MINS_PER_DAY - ci;
};

const shiftSpan = (start: string, end: string, crosses: boolean): number =>
  crosses ? toMinutes(end) + MINS_PER_DAY - toMinutes(start) : toMinutes(end) - toMinutes(start);

// ADR-0032 Phase C: the schedule the engine derives against for one (employee, date) — resolved from the
// employee's roster when present, else the company policy (today's behaviour, byte-identical).
type ResolvedSchedule = {
  dayType: DayType;
  lateAfter: string; // time-of-day after which check-in is "late" (shift start + policy grace, or policy)
  halfDayBefore: string; // checkout before this on a workday ⇒ half-day (policy / shift midpoint)
  scheduledMinutes: number; // net scheduled work minutes (workday OT = worked − this)
  breakMinutes: number;
  crossesMidnight: boolean;
  source: 'policy' | 'roster-shift' | 'roster-rest';
};

/** Resolve the schedule for one employee+date: holiday (calendar) > rostered shift/rest-day > company
 *  policy. No roster row ⇒ the policy branch, which reproduces the pre-Phase-C engine exactly. */
async function scheduleFor(tx: Tx, employmentId: string, date: string): Promise<ResolvedSchedule> {
  const pol = await policyFor(tx, employmentId);
  const grace = Math.max(0, toMinutes(pol.lateAfter) - toMinutes(pol.workStart)); // 15m by default
  // ADR-0054: match national holidays UNION the employee's resolved state holidays — byte-identical to the
  // leave engine's predicate (leave.ts:286). No resolved state ⇒ national-only = today's behaviour.
  const [hol] = await tx
    .select({ id: holiday.id })
    .from(holiday)
    .where(
      and(
        eq(holiday.holidayDate, date),
        eq(holiday.country, pol.country),
        pol.states.length
          ? or(isNull(holiday.state), inArray(holiday.state, pol.states))
          : isNull(holiday.state),
      ),
    )
    .limit(1);
  const [ra] = await tx
    .select({
      isRestDay: rosterAssignment.isRestDay,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
    })
    .from(rosterAssignment)
    .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
    .where(and(eq(rosterAssignment.employmentId, employmentId), eq(rosterAssignment.shiftDate, date)))
    .limit(1);

  const policyBranch = (dayType: DayType): ResolvedSchedule => ({
    dayType,
    lateAfter: pol.lateAfter,
    halfDayBefore: pol.halfDayBefore,
    scheduledMinutes: scheduledMinutes(pol),
    breakMinutes: pol.breakMinutes,
    crossesMidnight: false,
    source: 'policy',
  });

  // A rostered shift defines the schedule even on a calendar holiday or weekend; the day TYPE still comes
  // from the calendar (holiday) so OT is classified at the right premium.
  if (ra && !ra.isRestDay && ra.start && ra.end) {
    const sched = Math.max(0, shiftSpan(ra.start, ra.end, ra.crosses!) - ra.brk!);
    return {
      dayType: hol ? 'holiday' : 'workday',
      lateAfter: addGrace(ra.start, grace),
      halfDayBefore: fmtTime((toMinutes(ra.start) + Math.floor(shiftSpan(ra.start, ra.end, ra.crosses!) / 2)) % MINS_PER_DAY),
      scheduledMinutes: sched,
      breakMinutes: ra.brk!,
      crossesMidnight: ra.crosses!,
      source: 'roster-shift',
    };
  }
  if (hol) return policyBranch('holiday');
  if (ra?.isRestDay) return { ...policyBranch('rest_day'), source: 'roster-rest' };
  // No roster for this employee+date ⇒ company policy (working-days → workday/rest_day).
  return policyBranch(pol.workingDays.includes(isoWeekday(date)) ? 'workday' : 'rest_day');
}

/** Derive status + worked/OT minutes against a resolved schedule — the shared rule that check-in/out apply
 *  incrementally and a correction applies in one shot. Cross-midnight aware via spanMinutes(). */
function deriveAttendance(
  s: ResolvedSchedule,
  checkInAt: string,
  checkOutAt: string | null,
): { status: 'present' | 'late' | 'half_day'; workedMinutes: number | null; otMinutes: number | null } {
  let status: 'present' | 'late' | 'half_day' =
    s.dayType === 'workday' && toMinutes(checkInAt) > toMinutes(s.lateAfter) ? 'late' : 'present';
  if (!checkOutAt) return { status, workedMinutes: null, otMinutes: null };
  // Half-day is a day-shift concept; skip it for cross-midnight shifts (checkout time-of-day is next-day).
  if (
    s.dayType === 'workday' &&
    !s.crossesMidnight &&
    status !== 'late' &&
    toMinutes(checkOutAt) < toMinutes(s.halfDayBefore)
  ) {
    status = 'half_day';
  }
  const workedMinutes = workedFromSpan(spanMinutes(checkInAt, checkOutAt), s.breakMinutes);
  const otMinutes = s.dayType === 'workday' ? Math.max(0, workedMinutes - s.scheduledMinutes) : workedMinutes;
  return { status, workedMinutes, otMinutes };
}

export async function checkIn(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string },
) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);
    if (existing) throw new AlreadyCheckedInError();

    const sched = await scheduleFor(tx, p.employmentId, p.date);
    const dayType = sched.dayType;
    // "Late" only means something against a schedule — rest-day/holiday work is just present.
    const status =
      dayType === 'workday' && toMinutes(p.time) > toMinutes(sched.lateAfter) ? 'late' : 'present';
    const [row] = await tx
      .insert(attendance)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        checkInAt: p.time,
        status,
        dayType,
      })
      .returning({ id: attendance.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: row.id,
      eventType: 'attendance.checked-in',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, date: p.date, time: p.time, status, dayType },
    });
    return { attendanceId: row.id, status, dayType };
  });
}

export async function checkOut(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string },
) {
  return withTenant(ctx, async (tx) => {
    const [rec] = await tx
      .select()
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);
    if (!rec) throw new Error('No check-in recorded for this day');
    if (rec.checkOutAt) throw new Error('Already checked out');
    const checkInAt = rec.checkInAt ?? p.time;

    // Resolve the roster/policy schedule, then freeze the day-type stamped at check-in (tolerating legacy
    // rows). On a non-cross-midnight schedule check-out must be after check-in; a cross-midnight shift may
    // legitimately check out at an earlier time-of-day (next day) — but never at the exact check-in time.
    const sched0 = await scheduleFor(tx, p.employmentId, p.date);
    const sched: ResolvedSchedule = rec.dayType ? { ...sched0, dayType: rec.dayType } : sched0;
    if (!sched.crossesMidnight && toMinutes(p.time) <= toMinutes(checkInAt)) {
      throw new Error('Check-out must be after check-in');
    }
    if (toMinutes(p.time) === toMinutes(checkInAt)) {
      throw new Error('Check-out must differ from check-in');
    }

    // Workday OT = beyond the scheduled net day; rest-day/holiday work is OT-class in full (EA 1955 pays it
    // at premium rates — classification here, monetization in payroll). spanMinutes() is cross-midnight aware.
    const { status, workedMinutes, otMinutes } = deriveAttendance(sched, checkInAt, p.time);
    const dayType = sched.dayType;

    await tx
      .update(attendance)
      .set({ checkOutAt: p.time, status, dayType, workedMinutes, otMinutes })
      .where(eq(attendance.id, rec.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: rec.id,
      eventType: 'attendance.checked-out',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        date: p.date,
        time: p.time,
        status,
        dayType,
        workedMinutes,
        otMinutes,
      },
    });
    return { status, dayType, workedMinutes, otMinutes };
  });
}

export type DayContext = 'on_leave' | 'holiday' | 'rest_day' | null;

/**
 * Every active employee with their attendance row for `date` (null = no row), plus the
 * context that explains a missing row: approved leave > public holiday > rest day.
 */
export function attendanceForDate(ctx: SessionContext, date: string, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        companyCountry: company.country,
        companyId: employment.companyId,
        // ADR-0054: per-employee holiday-state inputs, resolved like the leave engine + location overlay.
        workState: employment.workState,
        defaultWorkState: company.defaultWorkState,
        groupStates: holidayGroup.states,
        locationState: location.state,
        attendanceId: attendance.id,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(location, eq(location.id, assignment.locationId))
      .leftJoin(
        attendance,
        and(eq(attendance.employmentId, employment.id), eq(attendance.attendanceDate, date)),
      )
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName);

    const empIds = rows.map((r) => r.employmentId);
    const [onLeave, holidays, policies] = await Promise.all([
      empIds.length
        ? tx
            // ADR-0048: only full_day leave suppresses the day's attendance signal. A half-day / hourly
            // leave still expects (and can record) attendance for the worked portion, so it is excluded here.
            .select({ employmentId: leaveRequest.employmentId })
            .from(leaveRequest)
            .where(
              and(
                eq(leaveRequest.status, 'approved'),
                eq(leaveRequest.durationType, 'full_day'),
                lte(leaveRequest.startDate, date),
                gte(leaveRequest.endDate, date),
                inArray(leaveRequest.employmentId, empIds),
              ),
            )
        : Promise.resolve([]),
      // ADR-0054: key holidays by country + (state | '') so a state-holiday is contextualized only for the
      // employees whose resolved state matches — agreeing with what checkIn stamps.
      tx.select({ country: holiday.country, state: holiday.state }).from(holiday).where(eq(holiday.holidayDate, date)),
      tx
        .select({ companyId: attendancePolicy.companyId, workingDays: attendancePolicy.workingDays })
        .from(attendancePolicy),
    ]);
    const leaveSet = new Set(onLeave.map((l) => l.employmentId));
    // country|state key set (state '' = national). An employee resolves to a holiday if EITHER the national
    // (country|'') key OR any of their resolved-state keys is present.
    const holidayKeys = new Set(holidays.map((h) => `${h.country}|${h.state ?? ''}`));
    const daysByCompany = new Map(policies.map((p) => [p.companyId, p.workingDays]));
    const dow = isoWeekday(date);

    return rows.map(({ companyCountry, companyId, workState, defaultWorkState, groupStates, locationState, ...r }) => {
      let context: DayContext = null;
      if (!r.attendanceId) {
        const states = resolveStates({ locationState, groupStates, workState, defaultWorkState });
        // National holiday (country|'') OR any resolved-state holiday for this employee.
        const isHoliday =
          holidayKeys.has(`${companyCountry}|`) ||
          states.some((st) => holidayKeys.has(`${companyCountry}|${st}`));
        if (leaveSet.has(r.employmentId)) context = 'on_leave';
        else if (isHoliday) context = 'holiday';
        else if (!(daysByCompany.get(companyId) ?? DEFAULTS.workingDays).includes(dow))
          context = 'rest_day';
      }
      return { ...r, context };
    });
  });
}

export type MonthSummaryRow = {
  employmentId: string;
  name: string;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  leaveDays: number;
  workedMinutes: number;
  otWorkday: number;
  otRestDay: number;
  otHoliday: number;
  /** EA 1955 limitation-of-overtime regs: > 104 OT hours in the month. */
  otCapExceeded: boolean;
  /** Indicative: some Mon–Sun week in the month exceeded 45 worked hours. */
  over45hWeek: boolean;
};

const OT_CAP_MINUTES = 104 * 60;
const WEEK_LIMIT_MINUTES = 45 * 60;

/** Per-employee month roll-up: status counts, hours, OT split by day type, compliance flags. */
export function attendanceMonthSummary(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[]; today?: string },
): Promise<MonthSummaryRow[]> {
  return withTenant(ctx, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const today = p.today ?? new Date().toISOString().slice(0, 10);
    const lastCounted = today < monthEnd ? today : monthEnd; // absence only up to today

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        companyId: employment.companyId,
        country: company.country,
        hiredOn: employment.hiredOn,
        // ADR-0054: per-employee holiday-state inputs (location overlay over work_state / default).
        workState: employment.workState,
        defaultWorkState: company.defaultWorkState,
        groupStates: holidayGroup.states,
        locationState: location.state,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(location, eq(location.id, assignment.locationId))
      .where(
        and(
          isNull(employment.terminatedOn),
          p.companyIds && p.companyIds.length
            ? inArray(employment.companyId, p.companyIds)
            : undefined,
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return [];
    const empIds = emps.map((e) => e.employmentId);

    const [rows, hols, leaves, policies] = await Promise.all([
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
      tx
        .select({ country: holiday.country, state: holiday.state, date: holiday.holidayDate })
        .from(holiday)
        .where(and(gte(holiday.holidayDate, monthStart), lte(holiday.holidayDate, monthEnd))),
      tx
        // ADR-0048: only full_day leave counts as a full leave day in the monthly summary. A half-day /
        // hourly leave is a worked (partial) day — it must not increment leaveDays — so it is excluded here.
        .select({
          employmentId: leaveRequest.employmentId,
          startDate: leaveRequest.startDate,
          endDate: leaveRequest.endDate,
        })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.status, 'approved'),
            eq(leaveRequest.durationType, 'full_day'),
            lte(leaveRequest.startDate, monthEnd),
            gte(leaveRequest.endDate, monthStart),
            inArray(leaveRequest.employmentId, empIds),
          ),
        ),
      tx
        .select({ companyId: attendancePolicy.companyId, workingDays: attendancePolicy.workingDays })
        .from(attendancePolicy),
    ]);

    // ADR-0054: key holidays by country|state|date (state '' = national), so the absence loop counts a
    // state-holiday only for employees whose resolved state matches — agreeing with the stored dayType.
    const holidaySet = new Set(hols.map((h) => `${h.country}|${h.state ?? ''}|${h.date}`));
    const daysByCompany = new Map(policies.map((pp) => [pp.companyId, pp.workingDays]));
    const rowsByEmp = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = rowsByEmp.get(r.employmentId);
      if (arr) arr.push(r);
      else rowsByEmp.set(r.employmentId, [r]);
    }
    const leaveByEmp = new Map<string, { startDate: string; endDate: string }[]>();
    for (const l of leaves) {
      const arr = leaveByEmp.get(l.employmentId);
      if (arr) arr.push(l);
      else leaveByEmp.set(l.employmentId, [l]);
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
      const myLeaves = leaveByEmp.get(e.employmentId) ?? [];
      const onLeave = (d: string) => myLeaves.some((l) => l.startDate <= d && d <= l.endDate);
      const workingDays = daysByCompany.get(e.companyId) ?? DEFAULTS.workingDays;
      // ADR-0054: the employee's resolved holiday states. A date is a holiday for them if the national
      // key (country|'') OR any of their resolved-state keys matches — agreeing with what checkIn stamps.
      const states = resolveStates({
        locationState: e.locationState ?? null,
        groupStates: e.groupStates,
        workState: e.workState ?? null,
        defaultWorkState: e.defaultWorkState ?? null,
      });
      const isHoliday = (d: string) =>
        holidaySet.has(`${e.country}||${d}`) || states.some((st) => holidaySet.has(`${e.country}|${st}|${d}`));

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
        if (!workingDays.includes(isoWeekday(d))) continue;
        if (isHoliday(d)) continue;
        if (recorded.has(d)) continue;
        if (onLeave(d)) leaveDays += 1;
        else absent += 1;
      }

      const totalOt = otWorkday + otRestDay + otHoliday;
      return {
        employmentId: e.employmentId,
        name: e.name,
        present,
        late,
        halfDay,
        absent,
        leaveDays,
        workedMinutes,
        otWorkday,
        otRestDay,
        otHoliday,
        otCapExceeded: totalOt > OT_CAP_MINUTES,
        over45hWeek: [...weekMinutes.values()].some((v) => v > WEEK_LIMIT_MINUTES),
      };
    });
  });
}

// ───────────────────── Corrections (ADR-0011 Phase B) ─────────────────────

/** Raise a correction request for a day's punches. RLS confines who an employment is
 *  visible to (self / manager / admin), so a peer cannot file for someone else. */
export async function requestAttendanceCorrection(
  ctx: SessionContext,
  p: { employmentId: string; date: string; checkIn: string; checkOut?: string | null; reason?: string },
) {
  return withTenant(ctx, async (tx) => {
    if (p.checkOut && toMinutes(p.checkOut) <= toMinutes(p.checkIn)) {
      throw new Error('Check-out must be after check-in');
    }
    const [row] = await tx
      .insert(attendanceCorrection)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        proposedCheckIn: p.checkIn,
        proposedCheckOut: p.checkOut ?? null,
        reason: p.reason ?? null,
      })
      .returning({ id: attendanceCorrection.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: row.id,
      eventType: 'attendance-correction.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        date: p.date,
        checkIn: p.checkIn,
        checkOut: p.checkOut ?? null,
        reason: p.reason ?? null,
      },
    });
    return { correctionId: row.id };
  });
}

/** Decide a correction. Approval upserts the attendance row with the proposed punches,
 *  re-derived through the time engine (so corrected OT flows to payroll). No self-approval. */
export async function decideAttendanceCorrection(
  ctx: SessionContext,
  p: { correctionId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cor] = await tx
      .select()
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!cor) throw new Error('correction request not found (or not visible)');
    if (cor.status !== 'pending') throw new Error(`correction request is already ${cor.status}`);

    await assertCanDecide(tx, ctx, cor.employmentId, 'attendance correction');

    if (p.decision === 'approved') {
      const sched = await scheduleFor(tx, cor.employmentId, cor.attendanceDate);
      const dayType = sched.dayType;
      const d = deriveAttendance(sched, cor.proposedCheckIn, cor.proposedCheckOut);
      const [amended] = await tx
        .insert(attendance)
        .values({
          tenantId: ctx.tenantId,
          employmentId: cor.employmentId,
          attendanceDate: cor.attendanceDate,
          checkInAt: cor.proposedCheckIn,
          checkOutAt: cor.proposedCheckOut,
          status: d.status,
          dayType,
          workedMinutes: d.workedMinutes,
          otMinutes: d.otMinutes,
          remarks: 'Corrected',
        })
        .onConflictDoUpdate({
          target: [attendance.employmentId, attendance.attendanceDate],
          set: {
            checkInAt: cor.proposedCheckIn,
            checkOutAt: cor.proposedCheckOut,
            status: d.status,
            dayType,
            workedMinutes: d.workedMinutes,
            otMinutes: d.otMinutes,
            remarks: 'Corrected',
          },
        })
        .returning({ id: attendance.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'attendance',
        aggregateId: amended.id,
        eventType: 'attendance.amended',
        actor: actorOf(ctx),
        subjectEmploymentId: cor.employmentId,
        payload: {
          correctionId: cor.id,
          date: cor.attendanceDate,
          checkIn: cor.proposedCheckIn,
          checkOut: cor.proposedCheckOut,
          status: d.status,
          dayType,
          workedMinutes: d.workedMinutes,
          otMinutes: d.otMinutes,
        },
      });
    }

    await tx
      .update(attendanceCorrection)
      .set({
        status: p.decision,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
      })
      .where(eq(attendanceCorrection.id, cor.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: cor.id,
      eventType: `attendance-correction.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: cor.employmentId,
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}

/** Correction inbox — RLS trims to what the viewer may see (admin all in scope, manager
 *  their reports, employee their own). Recent first. */
export function listAttendanceCorrections(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendanceCorrection.id,
        employmentId: attendanceCorrection.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        reason: attendanceCorrection.reason,
        status: attendanceCorrection.status,
        createdAt: attendanceCorrection.createdAt,
      })
      .from(attendanceCorrection)
      .innerJoin(employment, eq(employment.id, attendanceCorrection.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(attendanceCorrection.createdAt))
      .limit(100),
  );
}

/** An employee's own recent corrections (the /me history). */
export function myAttendanceCorrections(ctx: SessionContext, employmentId: string, limit = 5) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        status: attendanceCorrection.status,
        createdAt: attendanceCorrection.createdAt,
      })
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.employmentId, employmentId))
      .orderBy(desc(attendanceCorrection.createdAt))
      .limit(limit),
  );
}

// ─── ADR-0032 C7 · attendance policy (the no-roster default schedule the engine resolves against) ─────
export type AttendancePolicyView = {
  companyId: string;
  workStart: string;
  workEnd: string;
  breakMinutes: number;
  lateAfter: string;
  halfDayBefore: string;
  workingDays: number[];
  isDefault: boolean; // true ⇒ no row saved yet; the form shows engine defaults
};

/** Each requested company's saved attendance policy, falling back to the engine defaults (DEFAULTS) where
 *  none exists yet — so the editor always renders a complete, sensible schedule to start from. */
export function listAttendancePolicies(
  ctx: SessionContext,
  companyIds: string[],
): Promise<AttendancePolicyView[]> {
  return withTenant(ctx, async (tx) => {
    if (companyIds.length === 0) return [];
    const rows = await tx
      .select({
        companyId: attendancePolicy.companyId,
        workStart: attendancePolicy.workStart,
        workEnd: attendancePolicy.workEnd,
        breakMinutes: attendancePolicy.breakMinutes,
        lateAfter: attendancePolicy.lateAfter,
        halfDayBefore: attendancePolicy.halfDayBefore,
        workingDays: attendancePolicy.workingDays,
      })
      .from(attendancePolicy)
      .where(inArray(attendancePolicy.companyId, companyIds));
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    return companyIds.map((companyId) => {
      const r = byCompany.get(companyId);
      return r
        ? { ...r, isDefault: false }
        : {
            companyId,
            workStart: DEFAULTS.workStart,
            workEnd: DEFAULTS.workEnd,
            breakMinutes: DEFAULTS.breakMinutes,
            lateAfter: DEFAULTS.lateAfter,
            halfDayBefore: DEFAULTS.halfDayBefore,
            workingDays: DEFAULTS.workingDays,
            isDefault: true,
          };
    });
  });
}

const asTime = (v: string, label: string): string => {
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(v)) throw new Error(`${label} must be HH:MM.`);
  return v.length === 5 ? `${v}:00` : v;
};

/** Upsert one company's attendance policy (one row per company; RLS gates write to admins of that company).
 *  Validates the schedule is coherent, then appends attendance-policy.updated. This is the fallback schedule
 *  the time engine uses whenever an employee has no roster row for a date. */
export async function setAttendancePolicy(
  ctx: SessionContext,
  p: {
    companyId: string;
    workStart: string;
    workEnd: string;
    breakMinutes: number;
    lateAfter: string;
    halfDayBefore: string;
    workingDays: number[];
  },
) {
  const workStart = asTime(p.workStart, 'Work start');
  const workEnd = asTime(p.workEnd, 'Work end');
  const lateAfter = asTime(p.lateAfter, 'Late-after');
  const halfDayBefore = asTime(p.halfDayBefore, 'Half-day-before');
  if (toMinutes(workEnd) <= toMinutes(workStart)) throw new Error('Work end must be after work start.');
  if (toMinutes(lateAfter) < toMinutes(workStart)) throw new Error('Late-after must be at or after work start.');
  const breakMinutes = Math.trunc(p.breakMinutes);
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 480)
    throw new Error('Break minutes must be between 0 and 480.');
  if (toMinutes(workEnd) - toMinutes(workStart) <= breakMinutes)
    throw new Error('The working span must exceed the break.');
  const workingDays = [...new Set(p.workingDays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  if (workingDays.length === 0) throw new Error('Select at least one working day.');

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(attendancePolicy)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        workStart,
        workEnd,
        breakMinutes,
        lateAfter,
        halfDayBefore,
        workingDays,
      })
      .onConflictDoUpdate({
        target: attendancePolicy.companyId,
        set: { workStart, workEnd, breakMinutes, lateAfter, halfDayBefore, workingDays },
      })
      .returning({ id: attendancePolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-policy',
      aggregateId: row.id,
      eventType: 'attendance-policy.updated',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, workStart, workEnd, breakMinutes, lateAfter, halfDayBefore, workingDays },
    });
    return row;
  });
}

// ─── ADR-0032 C6 · biometric / terminal punch import ──────────────────────────────────────────────────
// Reconcile raw clock punches (CSV) into attendance rows. Roster-aware: a rostered shift defines a window
// (shift start..end, +1 day when it crosses midnight, ± a buffer) and every punch inside it belongs to that
// shift's business day — so a 22:00→06:00 night shift becomes ONE row keyed to the shift's start date with
// check-in 22:00 / check-out 06:00 (the engine's spanMinutes() handles the wrap). Employees with no roster
// fall back to calendar-day grouping (the pre-Phase-C behaviour). check-in = earliest punch by full datetime,
// check-out = latest; a lone punch records check-in only. Dry-run computes the same preview without writing.
const PUNCH_WINDOW_BUFFER_MIN = 180; // ± window around a rostered shift to still attribute an early/late punch
const dayIndex = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dtMinutes = (date: string, time: string): number => dayIndex(date) * MINS_PER_DAY + toMinutes(time);
const onlyDigits = (s: string): string => s.replace(/\D/g, '');

export type PunchImportPreviewRow = {
  employmentId: string;
  name: string;
  date: string;
  checkIn: string;
  checkOut: string | null;
  status: 'present' | 'late' | 'half_day';
  dayType: DayType;
  workedMinutes: number | null;
  otMinutes: number | null;
  punchCount: number;
  source: ResolvedSchedule['source'];
};
export type PunchImportResult = {
  parseErrors: string[];
  unmatchedRefs: string[];
  matchedPunches: number;
  reconciledDays: number;
  imported: number;
  dryRun: boolean;
  preview: PunchImportPreviewRow[];
};

export async function importAttendancePunches(
  ctx: SessionContext,
  p: { csvText: string; dryRun: boolean },
): Promise<PunchImportResult> {
  const parsed = parseAttendanceCsv(p.csvText);
  return withTenant(ctx, async (tx) => {
    // 1 · Match keys for every active employee the caller may see (RLS-scoped): employee code + IC number.
    const emps = await tx
      .select({
        id: employment.id,
        code: employment.employeeCode,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(isNull(employment.terminatedOn));
    const byRef = new Map<string, { id: string; name: string }>();
    for (const e of emps) {
      if (e.code) byRef.set(e.code.toLowerCase(), { id: e.id, name: e.name });
      if (e.ic) byRef.set(onlyDigits(e.ic), { id: e.id, name: e.name });
    }
    const matchRef = (ref: string) =>
      byRef.get(ref.toLowerCase()) ?? (onlyDigits(ref) ? byRef.get(onlyDigits(ref)) : undefined);

    // 2 · Match punches → employments; unmatched refs are reported, never guessed.
    type MP = { employmentId: string; name: string; date: string; time: string };
    const matched: MP[] = [];
    const unmatched = new Set<string>();
    for (const pu of parsed.punches) {
      const m = matchRef(pu.employeeRef);
      if (!m) {
        unmatched.add(pu.employeeRef);
        continue;
      }
      matched.push({ employmentId: m.id, name: m.name, date: pu.date, time: pu.time });
    }
    const empty: PunchImportResult = {
      parseErrors: parsed.errors,
      unmatchedRefs: [...unmatched],
      matchedPunches: 0,
      reconciledDays: 0,
      imported: 0,
      dryRun: p.dryRun,
      preview: [],
    };
    if (matched.length === 0) return empty;

    // 3 · Rostered shift windows for the matched employees over the punch range (± a day for cross-midnight
    //     tails). Each window maps a real-time span to one business day; sort by start so the earlier shift
    //     claims a boundary punch (a night-shift checkout at 06:00 belongs to the prior day, not that morning).
    const dates = matched.map((m) => m.date).sort();
    const from = addDays(dates[0], -1);
    const to = addDays(dates[dates.length - 1], 1);
    const empIds = [...new Set(matched.map((m) => m.employmentId))];
    const ras = await tx
      .select({
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        start: shift.startTime,
        end: shift.endTime,
        crosses: shift.crossesMidnight,
      })
      .from(rosterAssignment)
      .innerJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          inArray(rosterAssignment.employmentId, empIds),
          gte(rosterAssignment.shiftDate, from),
          lte(rosterAssignment.shiftDate, to),
        ),
      );
    type Win = { day: string; startDt: number; endDt: number };
    const windowsByEmp = new Map<string, Win[]>();
    for (const r of ras) {
      const endDay = r.crosses ? addDays(r.shiftDate, 1) : r.shiftDate;
      const arr = windowsByEmp.get(r.employmentId) ?? [];
      arr.push({
        day: r.shiftDate,
        startDt: dtMinutes(r.shiftDate, r.start) - PUNCH_WINDOW_BUFFER_MIN,
        endDt: dtMinutes(endDay, r.end) + PUNCH_WINDOW_BUFFER_MIN,
      });
      windowsByEmp.set(r.employmentId, arr);
    }
    for (const arr of windowsByEmp.values()) arr.sort((a, b) => a.startDt - b.startDt);

    // 4 · Assign each punch to a business day: the rostered window it falls in, else its own calendar day.
    type Grp = { employmentId: string; name: string; day: string; punches: { time: string; dt: number }[] };
    const groups = new Map<string, Grp>();
    for (const m of matched) {
      const pDt = dtMinutes(m.date, m.time);
      const win = (windowsByEmp.get(m.employmentId) ?? []).find((w) => pDt >= w.startDt && pDt <= w.endDt);
      const day = win ? win.day : m.date;
      const key = `${m.employmentId}|${day}`;
      const g = groups.get(key) ?? { employmentId: m.employmentId, name: m.name, day, punches: [] };
      g.punches.push({ time: m.time, dt: pDt });
      groups.set(key, g);
    }

    // 5 · Per (employee, business day): earliest punch = check-in, latest = check-out (ordered by full
    //     datetime, so a cross-midnight pair orders correctly). Derive against the schedule, then upsert.
    const preview: PunchImportPreviewRow[] = [];
    let imported = 0;
    for (const g of groups.values()) {
      const ordered = [...g.punches].sort((a, b) => a.dt - b.dt);
      const checkIn = ordered[0].time;
      const checkOut = ordered.length > 1 ? ordered[ordered.length - 1].time : null;
      const sched = await scheduleFor(tx, g.employmentId, g.day);
      const d = deriveAttendance(sched, checkIn, checkOut);
      preview.push({
        employmentId: g.employmentId,
        name: g.name,
        date: g.day,
        checkIn,
        checkOut,
        status: d.status,
        dayType: sched.dayType,
        workedMinutes: d.workedMinutes,
        otMinutes: d.otMinutes,
        punchCount: g.punches.length,
        source: sched.source,
      });
      if (!p.dryRun) {
        const [row] = await tx
          .insert(attendance)
          .values({
            tenantId: ctx.tenantId,
            employmentId: g.employmentId,
            attendanceDate: g.day,
            checkInAt: checkIn,
            checkOutAt: checkOut,
            status: d.status,
            dayType: sched.dayType,
            workedMinutes: d.workedMinutes,
            otMinutes: d.otMinutes,
            remarks: 'Imported (terminal)',
          })
          .onConflictDoUpdate({
            target: [attendance.employmentId, attendance.attendanceDate],
            set: {
              checkInAt: checkIn,
              checkOutAt: checkOut,
              status: d.status,
              dayType: sched.dayType,
              workedMinutes: d.workedMinutes,
              otMinutes: d.otMinutes,
              remarks: 'Imported (terminal)',
            },
          })
          .returning({ id: attendance.id });
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'attendance',
          aggregateId: row.id,
          eventType: 'attendance.imported',
          actor: actorOf(ctx),
          subjectEmploymentId: g.employmentId,
          payload: { date: g.day, checkIn, checkOut, source: 'terminal', punchCount: g.punches.length },
        });
        imported += 1;
      }
    }
    preview.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    return {
      parseErrors: parsed.errors,
      unmatchedRefs: [...unmatched],
      matchedPunches: matched.length,
      reconciledDays: groups.size,
      imported,
      dryRun: p.dryRun,
      preview,
    };
  });
}
