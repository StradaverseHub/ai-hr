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
 * ── TWO RULE SETS, AND WHY THE OLD ONE IS STILL HERE ────────────────────────────────────────────────
 *
 * The corrections below are REAL corrections, and every one of them moves a number that
 * `core/attendance-allowance.ts` turns into money (`evaluateMonthly` gates a policy's `amount` on
 * `absent`, `present`, `late` and `leaveDays`). The reporter was promised, in the mockup they approved,
 * that "all 9 of your companies keep behaving exactly as they do now until you turn it on". A correction
 * that lands un-gated on day one breaks that promise even when it is a correction — an employee who is
 * failing `maxAbsentDays` today because their ROSTERED REST DAY is miscounted would start qualifying for
 * an allowance nobody decided to start paying.
 *
 * So `rules` is not a nicety, it is the safety property:
 *
 *   'legacy'    — EXACTLY what main's `attendanceMonthSummary` day loop did: the company weekday pattern
 *                 alone, any attendance row (whatever its status) means the day is spoken for, and a
 *                 partial-day leave date is an absence. Wrong in the three ways below, and byte-identical
 *                 to production. This is what every surface uses until the policy switch is ticked, and
 *                 `test/absence-deduction.test.ts` pins it against a literal transcription of main's loop
 *                 over the same fixtures, field by field.
 *   'scheduled' — the corrected count described below, used for the money and (once the switch is on)
 *                 for the screens that report it, so the two can never drift.
 *
 * The switch is `leave.deductAbsentDays` on the employment's ASSIGNED PAYROLL POLICY —
 * `deductAbsentDaysByEmployment` below resolves it in three set-based queries, mirroring
 * `resolveAssignedPolicy`'s precedence (direct assignment → company default → none) without its
 * one-employment-at-a-time round trips.
 *
 * ── WHAT COUNTS AS AN ABSENT DAY UNDER 'scheduled' ──────────────────────────────────────────────────
 *
 * A SCHEDULED WORKING DAY on which the employee either has no attendance row at all, or has a row
 * explicitly marked `status='absent'`. Nothing else. In particular:
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
 * TENURE AND THE FUTURE (both rule sets). Dates before `hired_on` and after `terminated_on` are skipped,
 * so a leaver's final month does not charge every scheduled day after their last day. Dates after `until`
 * (default: today in Kuala Lumpur) are skipped too — a run prepared mid-month must never bill the days
 * that have not happened yet. For a completed month `until` is past `periodEnd` and the clamp is inert.
 * (`attendanceMonthSummary` selects only employments with a NULL `terminated_on`, so the termination clamp
 * is provably inert on the legacy path and cannot make it differ from main's loop.)
 *
 * DISJOINT FROM UNPAID LEAVE BY CONSTRUCTION. An approved full-day unpaid-leave date is an approved
 * full-day leave date, so it is excluded here while `unpaidDaysByEmployment` counts it. The two figures
 * can therefore be added without double-charging a day. Pinned by test rather than left to the reading.
 */
import { and, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';

import type { Tx } from '../db/client';
import {
  assignment,
  attendance,
  attendancePolicy,
  companyPayrollConfig,
  employment,
  leaveRequest,
  payrollPolicy,
  rosterAssignment,
  shift,
  type PayrollPolicyConfig,
} from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { holidayDatesFor, holidayMemoKey } from './holidays';
// b8aa3466 — the ONE four-way weekday resolver; absence derivation must read the same schedule the engine
// does. ADR-0080 D9: attendance is a PACK, so this comes through the FACADE, exactly as the approved-leave
// dates below do. Importing core/attendance directly turns test/attendance-pack-drift.test.ts red, and the
// fix is never test/pack-drift-allowlist.json — that list is audited kernel-contract debt and only shrinks.
import { isWorkingDayKind, shiftDayKindFor } from '../packs/attendance/service';
// ADR-0080 D9 — leave is a PACK, and this module is spine (attendance and payroll both read it), so the
// approved-leave dates come through the pack FACADE rather than reaching into `core/leave` directly. The
// audited leak list in test/pack-drift-allowlist.json only ever shrinks; a new consumer joins by using
// the facade, which is what packs/leave/service exists for. `core/holidays` is deliberately NOT a pack
// boundary (shared spine, see packs/leave/index.ts) and is imported directly.
import { approvedLeaveDates } from '../packs/leave/service';

const MS_DAY = 86_400_000;

/** ISO weekday (1=Mon … 7=Sun). Local copy, kept deliberately.
 *
 *  This header used to say the module was "deliberately free of core/attendance". That stopped being true
 *  in b8aa3466, which had to read the ONE four-way weekday resolver so absence derivation and the engine
 *  cannot disagree about what a working day is — see the facade import above. The ORIGINAL reason for the
 *  local copy still stands though, and is why this is not replaced by the imported helper: this is the
 *  MONEY count, and a plain weekday lookup that cannot be changed by an edit to the screens' module is
 *  worth more here than one fewer duplicated line. */
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

/**
 * Which definition of "absent day" to apply. See the header — this is the gate, not a tuning knob.
 * `legacy` reproduces main's `attendanceMonthSummary` loop exactly; `scheduled` is the corrected count.
 * There is deliberately NO default: every call site states which semantics it is entitled to, so a new
 * caller cannot silently opt all nine companies into the corrected numbers.
 */
export type AbsenceRules = 'legacy' | 'scheduled';

export type AbsenceBreakdown = {
  /** Scheduled working days with no attendance row, or (under `scheduled`) a row explicitly marked absent. */
  absentDays: number;
  /** Scheduled working days covered by an APPROVED FULL-DAY leave request AND carrying no attendance row.
   *  A leave date the employee also has an attendance row for is spoken for by that row (the month
   *  roll-up counts it under `present`), exactly as the loop this replaced had it — see the day loop. */
  leaveDays: number;
};

type RosterDay = { isRestDay: boolean; hasShift: boolean };

/**
 * e2632276 — WHICH EMPLOYMENTS HAVE THE ABSENCE DEDUCTION SWITCHED ON, in three set-based queries.
 *
 * Mirrors `resolveAssignedPolicy` (core/payroll-policy.ts) exactly — directly-assigned policy → the
 * company's default payroll policy → none — but batched. The per-employment resolver issues two or three
 * round trips PER EMPLOYMENT, which is fine inside the payslip loop (which already calls it) and is not
 * fine on an Attendance screen listing a whole company.
 *
 * Only `status='active'` policies count, exactly as the kernel's resolver has it: an inactive or draft
 * policy resolves to the monthly default, which has no absence deduction.
 *
 * ── ONE ASYMMETRY, AND THE DIRECTION IT FAILS IN ────────────────────────────────────────────────────
 * The two tables consulted here do NOT share a read policy:
 *   payroll_policy         — tenant-wide SELECT (migration 0128, deliberately, so the kernel can resolve a
 *                            policy under a non-admin session instead of silently downgrading to monthly).
 *   company_payroll_config — `app.is_admin_for(company_id)` for READ as well as write (migration 0081).
 * So the company-DEFAULT rung is invisible to a non-admin session. `resolveAssignedPolicy` has always had
 * that property; it never showed because only the payroll kernel called it and payroll is admin-gated. It
 * shows now that the Attendance screens read the same switch: an employment switched on ONLY through the
 * company default resolves ON for an admin and OFF for the employee's own screen. OFF is legacy, i.e.
 * exactly what production renders today, so the failure is in the safe direction — a non-admin is never
 * shown a corrected figure an admin would not be — and it cannot reach money, because both the deduction
 * and the attendance-allowance transfer run admin-gated. Pinned in test/absence-summary-oracle.test.ts
 * ("RLS: a plain employee resolves a DIRECTLY-ASSIGNED switch, and fails SAFE on a company default").
 * A DIRECTLY-ASSIGNED policy resolves identically for every session; the fix for the other rung is a
 * tenant-wide SELECT policy on company_payroll_config, which needs a migration number of its own.
 *
 * Returns the SET of employmentIds that are switched on. Absent from the set ⇒ off ⇒ legacy behaviour
 * everywhere, which is what all nine companies get until somebody ticks the box.
 */
export async function deductAbsentDaysByEmployment(tx: Tx, employmentIds: string[]): Promise<Set<string>> {
  const on = new Set<string>();
  const ids = [...new Set(employmentIds)].filter(Boolean);
  if (ids.length === 0) return on;

  const emps = await tx
    .select({ employmentId: employment.id, companyId: employment.companyId, policyId: employment.payrollPolicyId })
    .from(employment)
    .where(inArray(employment.id, ids));
  if (emps.length === 0) return on;

  // The company DEFAULT policy, for employments carrying no direct assignment (the fallback the kernel's
  // resolver applies). One query for every company in the set.
  const needDefault = [...new Set(emps.filter((e) => e.policyId == null).map((e) => e.companyId))];
  const defaultByCompany = new Map<string, string | null>();
  if (needDefault.length > 0) {
    const cfgs = await tx
      .select({ companyId: companyPayrollConfig.companyId, def: companyPayrollConfig.defaultPayrollPolicyId })
      .from(companyPayrollConfig)
      .where(inArray(companyPayrollConfig.companyId, needDefault));
    for (const c of cfgs) defaultByCompany.set(c.companyId, c.def ?? null);
  }

  const resolved = new Map<string, string>(); // employmentId → policyId
  for (const e of emps) {
    const pid = e.policyId ?? defaultByCompany.get(e.companyId) ?? null;
    if (pid) resolved.set(e.employmentId, pid);
  }
  const policyIds = [...new Set(resolved.values())];
  if (policyIds.length === 0) return on;

  const pols = await tx
    .select({ id: payrollPolicy.id, status: payrollPolicy.status, config: payrollPolicy.config })
    .from(payrollPolicy)
    .where(inArray(payrollPolicy.id, policyIds));
  const flagByPolicy = new Map(
    pols.map((p) => [
      p.id,
      p.status === 'active' && (p.config as PayrollPolicyConfig | null)?.leave?.deductAbsentDays === true,
    ]),
  );
  for (const [employmentId, policyId] of resolved) {
    if (flagByPolicy.get(policyId)) on.add(employmentId);
  }
  return on;
}

/**
 * The full per-employment breakdown: absence days AND the leave days that were excluded from them.
 * `attendanceMonthSummary` needs both (they are the two figures its month roll-up prints); payroll needs
 * only the first and reads it through `absentDaysByEmployment` below.
 *
 * `rules` picks the definition — see `AbsenceRules`. `until` clamps the last date counted (default: today
 * in Kuala Lumpur) — see the header.
 */
export async function absenceBreakdownByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  employmentIds: string[],
  opts: { rules: AbsenceRules; until?: string | null },
): Promise<Map<string, AbsenceBreakdown>> {
  const out = new Map<string, AbsenceBreakdown>();
  const ids = [...new Set(employmentIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const scheduled = opts.rules === 'scheduled';
  const until = opts.until ?? todayInKualaLumpur();
  const lastCounted = periodEnd < until ? periodEnd : until;

  const emps = await tx
    .select({
      employmentId: employment.id,
      companyId: employment.companyId,
      hiredOn: employment.hiredOn,
      terminatedOn: employment.terminatedOn,
      defaultShiftId: employment.defaultShiftId,
      // Only ever read to KEY the holiday memo below — never to resolve a calendar here. See holidayKeyOf.
      workState: employment.workState,
      holidayGroupId: employment.holidayGroupId,
    })
    .from(employment)
    .where(inArray(employment.id, ids));
  if (emps.length === 0) return out;
  const empIds = emps.map((e) => e.employmentId);

  const [rows, approved, partialLeave, policies, rosterRows, defaultShifts, openAssignments] = await Promise.all([
    // Every attendance row in the window — its PRESENCE says the day is accounted for, and (under the
    // `scheduled` rules) an explicit 'absent' status says the opposite of that: an admin marking a
    // no-show, which core/attendance-derive statusOf has always shown in red but the legacy count
    // silently filed under `present`.
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
    // caller loop below; a partial request is almost always one day. `scheduled` only: the legacy count
    // treated a partial-leave date with no attendance row as a plain absence, and legacy must not move.
    scheduled
      ? tx
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
          )
      : Promise.resolve([] as { employmentId: string; startDate: string; endDate: string }[]),
    tx
      .select({
        companyId: attendancePolicy.companyId,
        workingDays: attendancePolicy.workingDays,
        halfWorkingDays: attendancePolicy.halfWorkingDays,
      })
      .from(attendancePolicy),
    // The roster, batched. A row with is_rest_day=false but no resolvable shift times is NOT a scheduled
    // shift — scheduleFor requires start AND end before it treats the row as work — so it falls through to
    // the rostered-rest branch exactly as scheduleFor does. `scheduled` only: the legacy count never
    // looked at the roster at all.
    scheduled
      ? tx
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
          )
      : Promise.resolve([] as { employmentId: string; shiftDate: string; isRestDay: boolean; start: string | null; end: string | null }[]),
    // ec4cbf63 — the employee's DEFAULT shift and its weekly pattern, which decides working-vs-rest BEFORE
    // the flat company policy. A pattern-less shift has no working days (deliberate; see scheduleFor).
    // `scheduled` only, for the same reason as the roster.
    scheduled
      ? tx
          .select({
            employmentId: employment.id,
            pattern: shift.weeklyPattern,
            // b8aa3466 — the four-way row, so absence derivation reads the same schedule scheduleFor does.
            halfPattern: shift.halfPattern,
            offPattern: shift.offPattern,
          })
          .from(employment)
          .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
          .where(inArray(employment.id, empIds))
      : Promise.resolve(
          [] as { employmentId: string; pattern: number[] | null; halfPattern: number[]; offPattern: number[] }[],
        ),
    // The OPEN assignment's location — the last input the holiday resolver keys on. See holidayKeyOf.
    tx
      .select({ employmentId: assignment.employmentId, locationId: assignment.locationId })
      .from(assignment)
      .where(
        and(
          inArray(assignment.employmentId, empIds),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      ),
  ]);

  const daysByCompany = new Map(policies.map((p) => [p.companyId, unionDays(p.workingDays, p.halfWorkingDays)]));
  // b8aa3466 — keep the whole four-way row, not just the Full list, so the scheduled test below can tell a
  // Half day (a WORKING day, so a missing row on it IS an absence) from an Off day (not scheduled).
  const patternByEmp = new Map(
    defaultShifts.map((d) => [d.employmentId, { pattern: d.pattern, halfPattern: d.halfPattern, offPattern: d.offPattern }]),
  );

  // ── The holiday memo ────────────────────────────────────────────────────────────────────────────────
  // `holidayDatesFor` is single-employment and costs 3–4 round trips a call; a company-wide month roll-up
  // was paying that PER EMPLOYEE, sequentially, on one connection. Its result is a pure function of four
  // employment inputs plus the window, all of which we already have in hand:
  //   companyId  → company.country, company.default_work_state, and the is_company_descendant chain
  //   workState  → employment.work_state (the `ws` rung of the state precedence)
  //   holidayGroupId → the directly-assigned group, its archetype, states and parent
  //   locationId → the open assignment's location: its state, its mapped calendar, and that calendar's parent
  // Employments sharing all four resolve to the SAME set, so one call answers for the whole group — in
  // practice one call per company. An employment with MORE THAN ONE open assignment row is excluded from
  // the memo and resolved on its own, because `holidayDatesFor` takes an arbitrary one via `.limit(1)`
  // and we must not pick a different one than it would.
  const openCount = new Map<string, number>();
  const locationByEmp = new Map<string, string | null>();
  for (const a of openAssignments) {
    openCount.set(a.employmentId, (openCount.get(a.employmentId) ?? 0) + 1);
    locationByEmp.set(a.employmentId, a.locationId ?? null);
  }
  // 0fe1ca2e — the key itself is `holidayMemoKey` in core/holidays.ts, NOT a second expression of the
  // four inputs written out here. This file and holidayDatesByEmployment used to spell the same key two
  // different ways; a determining input could then leave one and stay in the other, and the memo would
  // hand one employee another's public holidays. Read that function's header before changing what a
  // calendar depends on.
  const holidayKeyOf = (e: (typeof emps)[number]): string | null =>
    (openCount.get(e.employmentId) ?? 0) > 1
      ? null // ambiguous open assignment — resolve this one alone rather than guess which row wins
      : holidayMemoKey({
          companyId: e.companyId,
          workState: e.workState,
          holidayGroupId: e.holidayGroupId,
          locationId: locationByEmp.get(e.employmentId) ?? null,
        });
  const holidayMemo = new Map<string, Set<string>>();

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
  // `leaveDays` figure (whole days) is unchanged — this set only says "not an absence". Empty under legacy.
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
    // ADR-0055 — the resolver is single-employment; memoized on its four determining inputs (above), so a
    // company whose staff share a calendar costs ONE call instead of one per head. Sequential because
    // every call shares this transaction's one connection.
    const key = holidayKeyOf(e);
    let holidays = key === null ? undefined : holidayMemo.get(key);
    if (!holidays) {
      holidays = await holidayDatesFor(tx, {
        employmentId: e.employmentId,
        startDate: periodStart,
        endDate: lastCounted,
      });
      if (key !== null) holidayMemo.set(key, holidays);
    }
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
      // (Both rule sets: main's loop tested the company weekday first and the holiday second, which
      // reaches the same `continue`.)
      if (holidays.has(d)) continue;

      if (!scheduled) {
        // ── LEGACY: main's loop, transcribed. Company weekday pattern only; ANY attendance row means the
        //    day is spoken for (so an explicitly-Absent row is NOT an absence, and the month roll-up's
        //    tally files it under `present`); an approved FULL-DAY leave date with no row is a leave day;
        //    everything else scheduled and unrecorded is an absence. Partial-day leave is invisible here,
        //    so a half-day leave date with no clock-in counts as a whole absent day — wrong, and exactly
        //    what production does today.
        if (!companyDays.includes(isoWeekdayOf(d))) continue;
        if (recorded.has(d)) continue;
        if (onLeave.has(d)) leaveDays += 1;
        else absentDays += 1;
        continue;
      }

      // ── SCHEDULED: the scheduleFor precedence, exactly — rostered shift → rostered rest →
      //    default-shift pattern → company working days. Only a SCHEDULED WORKING day can be an absence.
      const ra = roster?.get(d);
      let isScheduled: boolean;
      if (ra) isScheduled = !ra.isRestDay && ra.hasShift;
      else if (hasDefaultShift) isScheduled = pattern != null && isWorkingDayKind(shiftDayKindFor(pattern, d));
      else isScheduled = companyDays.includes(isoWeekdayOf(d));
      if (!isScheduled) continue;

      if (onLeave.has(d)) {
        // A leave date that ALSO carries an attendance row is NOT a leave DAY in this tally. The legacy
        // loop tested `recorded.has(d)` BEFORE the on-leave test, so such a date was reported as neither
        // leave nor absence — the attendance row spoke for it, and the tally above filed it under
        // `present`. Dropping that ordering would report the SAME date as both present and leave (22
        // accounted days in a 21-working-day month) and `leaveDays` is not cosmetic: evaluateMonthly gates
        // an attendance allowance on `leaveDays <= maxTotalLeaveDays` (core/attendance-allowance.ts
        // 181-182), so an inflated count withholds a real payment. Only the REPORTING tally is preserved
        // here; the absence exclusion is unchanged, so an on-leave date is still never an absence.
        if (!recorded.has(d)) leaveDays += 1;
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
 *
 * Always the `scheduled` rules: the deduction only ever runs for an employment whose policy has already
 * switched it on, and the corrected count is the whole point of switching it on. Callers must do the
 * gating (both do — see core/payroll.ts) rather than passing unswitched employments in here.
 */
export async function absentDaysByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  employmentIds: string[],
  opts?: { until?: string | null },
): Promise<Map<string, number>> {
  const breakdown = await absenceBreakdownByEmployment(tx, periodStart, periodEnd, employmentIds, {
    rules: 'scheduled',
    until: opts?.until ?? null,
  });
  return new Map([...breakdown].map(([k, v]) => [k, v.absentDays]));
}
