/**
 * e2632276 — ABSENCE DAYS, counted once, for the screens AND for the money.
 *
 * WHY ITS OWN MODULE. Before this, three places counted absence and two of them disagreed:
 * `attendanceMonthSummary` derived it from the COMPANY weekday pattern alone, `statusOf`
 * (core/attendance-derive.ts) derived the daily/individual screens' red "Absent" from the resolved
 * schedule, and payroll counted nothing at all — the deduction only ever valued approved UNPAID LEAVE.
 * Making a day cost real money is exactly the wrong moment to keep three definitions, so there is now one:
 * this file. `attendanceMonthSummary` and the payroll kernel both call it; the daily screens read the same
 * precedence through `resolveShiftDisplay`.
 *
 * WHAT COUNTS AS AN ABSENT DAY. A SCHEDULED WORKING DAY on which the employee either has no attendance row
 * at all, or has a row explicitly marked `status='absent'`. Nothing else. In particular:
 *
 *   • A PUBLIC HOLIDAY never counts — resolved per employee through the unified calendar (business-group →
 *     state → national), the same one leave and check-in use.
 *   • ANY APPROVED-LEAVE date never counts, and the PARTIAL-day case needs saying out loud.
 *     `approvedLeaveDates` (ADR-0068 §4A) returns FULL-DAY dates only, so it does not see a half-day or
 *     hourly request at all. A partial-day absence is nonetheless an ACCOUNTED-FOR day: HR approved it,
 *     and its unpaid portion is already valued by `unpaidDaysByEmployment` (with its own time-off
 *     divisor). Counting the same date as a whole day's absence on top would charge 1.5 days for half a
 *     day off — the exact double-charge this item exists to avoid — so partial-day approved leave is
 *     excluded here too. It is NOT reported as a `leaveDays` figure: the month roll-up's leave count has
 *     always meant whole days, and this changes only what is NOT an absence.
 *   • A REST DAY never counts, and THE ROSTER WINS. The exclusion ladder mirrors `scheduleFor` exactly —
 *     rostered shift → rostered rest → default-shift weekly pattern → company working days — because the
 *     old company-pattern-only test charged a day's pay to an employee the employer had personally
 *     rostered to rest. That was already visible as a wrong red "Absent" on the Attendance screens; under
 *     the deduction it would have been wrong money.
 *
 * TENURE AND THE FUTURE. Dates before `hired_on` and after `terminated_on` are skipped, so a leaver's
 * final month does not charge every scheduled day after their last day. Dates after `until` (default:
 * today in Kuala Lumpur) are skipped too — a run prepared mid-month must never bill the days that have not
 * happened yet. For a completed month `until` is past `periodEnd` and the clamp is inert.
 *
 * DISJOINT FROM UNPAID LEAVE BY CONSTRUCTION. An approved full-day unpaid-leave date is an approved
 * full-day leave date, so it is excluded here while `unpaidDaysByEmployment` counts it. The two figures
 * can therefore be added without double-charging a day. Pinned by test rather than left to the reading.
 */
import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { attendance, attendancePolicy, employment, leaveRequest, rosterAssignment, shift } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { holidayDatesFor } from './holidays';
// ADR-0080 D9 — leave is a PACK, and this module is spine (attendance and payroll both read it), so the
// approved-leave dates come through the pack FACADE rather than reaching into `core/leave` directly. The
// audited leak list in test/pack-drift-allowlist.json only ever shrinks; a new consumer joins by using
// the facade, which is what packs/leave/service exists for. `core/holidays` is deliberately NOT a pack
// boundary (shared spine, see packs/leave/index.ts) and is imported directly.
import { approvedLeaveDates } from '../packs/leave/service';

const MS_DAY = 86_400_000;

/** ISO weekday (1=Mon … 7=Sun). Local copy: this module is deliberately free of core/attendance so the
 *  money count cannot be broken by an edit to the screens' module (and so the import graph stays a tree). */
const isoWeekdayOf = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

/** Mon–Fri — the engine default when a company has saved no attendance policy (mirrors core/attendance DEFAULTS). */
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/** D2 (feedback 31474452): a "Half Day" schedule marker is still a WORKING day for absence derivation. */
const unionDays = (workingDays: number[], halfWorkingDays: number[]): number[] => [
  ...new Set([...workingDays, ...halfWorkingDays]),
];

export type AbsenceBreakdown = {
  /** Scheduled working days with no attendance row, or a row explicitly marked absent. */
  absentDays: number;
  /** Scheduled working days covered by an APPROVED FULL-DAY leave request. */
  leaveDays: number;
};

type RosterDay = { isRestDay: boolean; hasShift: boolean };

/**
 * The full per-employment breakdown: absence days AND the leave days that were excluded from them.
 * `attendanceMonthSummary` needs both (they are the two figures its month roll-up prints); payroll needs
 * only the first and reads it through `absentDaysByEmployment` below.
 *
 * `until` clamps the last date counted (default: today in Kuala Lumpur) — see the header.
 */
export async function absenceBreakdownByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  employmentIds: string[],
  opts?: { until?: string | null },
): Promise<Map<string, AbsenceBreakdown>> {
  const out = new Map<string, AbsenceBreakdown>();
  const ids = [...new Set(employmentIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const until = opts?.until ?? todayInKualaLumpur();
  const lastCounted = periodEnd < until ? periodEnd : until;

  const emps = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      hiredOn: employment.hiredOn,
      terminatedOn: employment.terminatedOn,
      defaultShiftId: employment.defaultShiftId,
    })
    .from(employment)
    .where(inArray(employment.id, ids));
  if (emps.length === 0) return out;
  const empIds = emps.map((e) => e.employmentId);

  const [rows, approved, partialLeave, policies, rosterRows, defaultShifts] = await Promise.all([
    // Every attendance row in the window — its PRESENCE says the day is accounted for, and an explicit
    // 'absent' status says the opposite of that (an admin marking a no-show, which core/attendance-derive
    // statusOf has always shown in red but the old month count silently filed under `present`).
    tx
      .select({
        employmentId: attendance.employmentId,
        date: attendance.attendanceDate,
        status: attendance.status,
      })
      .from(attendance)
      .where(
        and(
          inArray(attendance.employmentId, empIds),
          gte(attendance.attendanceDate, periodStart),
          lte(attendance.attendanceDate, lastCounted),
        ),
      ),
    // ADR-0068 §4A — effectively-approved FULL-DAY leave dates (a per-date request's rejected interior date
    // is not on leave, and so IS an absence if nothing was recorded).
    approvedLeaveDates(tx, empIds, periodStart, lastCounted),
    // The PARTIAL-day approved requests (half-day AM/PM, hourly) the resolver above deliberately filters
    // out. Read straight off leave_request — per-date approval rows are only ever created for full-day
    // requests (§4C), so the request's own status is the whole answer here. Spans are expanded by the
    // caller loop below; a partial request is almost always one day.
    tx
      .select({
        employmentId: leaveRequest.employmentId,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
      })
      .from(leaveRequest)
      .where(
        and(
          inArray(leaveRequest.employmentId, empIds),
          eq(leaveRequest.status, 'approved'),
          ne(leaveRequest.durationType, 'full_day'),
          lte(leaveRequest.startDate, lastCounted),
          gte(leaveRequest.endDate, periodStart),
        ),
      ),
    tx
      .select({
        companyId: attendancePolicy.companyId,
        workingDays: attendancePolicy.workingDays,
        halfWorkingDays: attendancePolicy.halfWorkingDays,
      })
      .from(attendancePolicy),
    // The roster, batched. A row with is_rest_day=false but no resolvable shift times is NOT a scheduled
    // shift — scheduleFor requires start AND end before it treats the row as work — so it falls through to
    // the rostered-rest branch exactly as scheduleFor does.
    tx
      .select({
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        isRestDay: rosterAssignment.isRestDay,
        start: shift.startTime,
        end: shift.endTime,
      })
      .from(rosterAssignment)
      .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          inArray(rosterAssignment.employmentId, empIds),
          gte(rosterAssignment.shiftDate, periodStart),
          lte(rosterAssignment.shiftDate, lastCounted),
        ),
      ),
    // ec4cbf63 — the employee's DEFAULT shift and its weekly pattern, which decides working-vs-rest BEFORE
    // the flat company policy. A pattern-less shift has no working days (deliberate; see scheduleFor).
    tx
      .select({ employmentId: employment.id, pattern: shift.weeklyPattern })
      .from(employment)
      .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
      .where(inArray(employment.id, empIds)),
  ]);

  const daysByCompany = new Map(policies.map((p) => [p.companyId, unionDays(p.workingDays, p.halfWorkingDays)]));
  const patternByEmp = new Map(defaultShifts.map((d) => [d.employmentId, d.pattern]));

  const recordedByEmp = new Map<string, Set<string>>();
  const markedAbsentByEmp = new Map<string, Set<string>>();
  for (const r of rows) {
    let rec = recordedByEmp.get(r.employmentId);
    if (!rec) recordedByEmp.set(r.employmentId, (rec = new Set()));
    rec.add(r.date);
    if (r.status === 'absent') {
      let ab = markedAbsentByEmp.get(r.employmentId);
      if (!ab) markedAbsentByEmp.set(r.employmentId, (ab = new Set()));
      ab.add(r.date);
    }
  }

  // Partial-day approved leave, expanded to dates. Kept separate from `approved` so the month roll-up's
  // `leaveDays` figure (whole days) is unchanged — this set only says "not an absence".
  const partialByEmp = new Map<string, Set<string>>();
  for (const r of partialLeave) {
    let set = partialByEmp.get(r.employmentId);
    if (!set) partialByEmp.set(r.employmentId, (set = new Set()));
    const lo = r.startDate < periodStart ? periodStart : r.startDate;
    const hi = r.endDate > lastCounted ? lastCounted : r.endDate;
    for (let t = Date.parse(`${lo}T00:00:00Z`); t <= Date.parse(`${hi}T00:00:00Z`); t += MS_DAY) {
      set.add(new Date(t).toISOString().slice(0, 10));
    }
  }

  const rosterByEmp = new Map<string, Map<string, RosterDay>>();
  for (const rr of rosterRows) {
    let m = rosterByEmp.get(rr.employmentId);
    if (!m) rosterByEmp.set(rr.employmentId, (m = new Map()));
    m.set(rr.shiftDate, { isRestDay: rr.isRestDay, hasShift: !!(rr.start && rr.end) });
  }

  for (const e of emps) {
    // ADR-0055 — one resolver call per employee (the resolver is single-employment); sequential because
    // every call shares this transaction's one connection. Same shape attendanceMonthSummary already used.
    const holidays = await holidayDatesFor(tx, {
      employmentId: e.employmentId,
      startDate: periodStart,
      endDate: lastCounted,
    });
    const onLeave = approved.get(e.employmentId) ?? new Set<string>();
    const onPartialLeave = partialByEmp.get(e.employmentId) ?? new Set<string>();
    const recorded = recordedByEmp.get(e.employmentId) ?? new Set<string>();
    const markedAbsent = markedAbsentByEmp.get(e.employmentId) ?? new Set<string>();
    const roster = rosterByEmp.get(e.employmentId);
    const pattern = patternByEmp.get(e.employmentId);
    const hasDefaultShift = e.defaultShiftId != null && patternByEmp.has(e.employmentId);
    const companyDays = daysByCompany.get(e.companyId) ?? DEFAULT_WORKING_DAYS;

    const from = e.hiredOn > periodStart ? e.hiredOn : periodStart;
    const to = e.terminatedOn && e.terminatedOn < lastCounted ? e.terminatedOn : lastCounted;

    let absentDays = 0;
    let leaveDays = 0;
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += MS_DAY) {
      const d = new Date(t).toISOString().slice(0, 10);
      // A public holiday is never an absence and never a leave day, whatever else the day carries.
      if (holidays.has(d)) continue;

      // The scheduleFor precedence, exactly: rostered shift → rostered rest → default-shift pattern →
      // company working days. Only a SCHEDULED WORKING day can be an absence.
      const ra = roster?.get(d);
      let scheduled: boolean;
      if (ra) scheduled = !ra.isRestDay && ra.hasShift;
      else if (hasDefaultShift) scheduled = pattern?.includes(isoWeekdayOf(d)) ?? false;
      else scheduled = companyDays.includes(isoWeekdayOf(d));
      if (!scheduled) continue;

      if (onLeave.has(d)) {
        leaveDays += 1;
        continue;
      }
      // An approved HALF-DAY or HOURLY absence accounts for the day. Its unpaid portion is deducted by
      // the unpaid-leave path with its own divisor; charging a whole absent day on top would bill 1.5
      // days for half a day off. Not counted as a leave DAY either — see the header.
      if (onPartialLeave.has(d)) continue;
      // Counted when the day was explicitly marked Absent, or when nothing was recorded at all.
      if (markedAbsent.has(d) || !recorded.has(d)) absentDays += 1;
    }
    out.set(e.employmentId, { absentDays, leaveDays });
  }
  return out;
}

/**
 * e2632276 — the absence days payroll deducts for a period, by employment. The money-facing wrapper around
 * `absenceBreakdownByEmployment`; deliberately the same shape as `unpaidDaysByEmployment` (core/payroll.ts)
 * because the kernel adds the two counts at the same daily rate.
 */
export async function absentDaysByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  employmentIds: string[],
  opts?: { until?: string | null },
): Promise<Map<string, number>> {
  const breakdown = await absenceBreakdownByEmployment(tx, periodStart, periodEnd, employmentIds, opts);
  return new Map([...breakdown].map(([k, v]) => [k, v.absentDays]));
}
