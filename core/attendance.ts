/**
 * Attendance — generic, jurisdiction-neutral time engine (ADR-0011).
 *
 * One row per employee per day. Check-in classifies the day (workday / rest day /
 * holiday, frozen on the row); check-out derives worked + overtime minutes from the
 * company work schedule. Absence is implicit (no row) and contextualized at read time
 * (approved leave / holiday / rest day are not "absent"). Each mutation appends a
 * domain event (ADR-0006).
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import { applyOtRuleRows, resolveRuleTx, type ResolvedAttendanceRule } from './attendance-rule';
import { holidayDatesFor } from './holidays';
import { approvedLeaveDates } from './leave';
import { maybeAutoAccrueOnApprovalTx } from './toil';
import {
  assignment,
  attendance,
  attendanceCorrection,
  attendancePolicy,
  clockingLocation,
  employeeClockingLocation,
  employeeStatutoryMy,
  employment,
  leaveRequest,
  person,
  rosterAssignment,
  shift,
  type ShiftOtRule,
} from '../db/schema';
import { parseAttendanceCsv } from '../lib/attendance-csv';

// ADR-0070: two aliases of clocking_location so attendanceForDate can resolve BOTH the check-in and
// check-out matched-site names in one query (mirrors core/read.ts myAttendance).
const dayCheckInSite = alias(clockingLocation, 'day_check_in_site');
const dayCheckOutSite = alias(clockingLocation, 'day_check_out_site');

export class AlreadyCheckedInError extends Error {
  constructor() {
    super('Already checked in today');
    this.name = 'AlreadyCheckedInError';
  }
}

// ─── Clocking Location & Geofencing (ADR-0070) ─────────────────────────────────────────────────────

/** Haversine great-circle distance in metres between two lat/lng pairs. Pure function — columns are
 *  `double precision`, so drizzle already returns numbers (no string-math surprise). */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // mean Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Thrown when geofencing is enabled but the browser supplied no coordinates. Client-side precondition —
 *  nothing happened in the domain, so no event is appended for it (ADR-0070 §5). */
export class GeolocationRequiredError extends Error {
  constructor() {
    super('Your location is required to clock in or out at this workplace. Please allow location access and try again.');
    this.name = 'GeolocationRequiredError';
  }
}

/** Thrown when geofencing is enabled and the employee's current position is outside every assigned
 *  site's radius (or they have zero active assigned sites — fail-closed). Carries enough context for the
 *  caller to write the attendance.geofence.blocked event in a SEPARATE transaction after this one rolls
 *  back (ADR-0070 §3 — the blocked-event mechanism). */
export class OutsideGeofenceError extends Error {
  constructor(
    public readonly info: {
      employmentId: string;
      date: string;
      time: string;
      lat: number;
      lng: number;
      nearestLocationId: string | null;
      distanceM: number | null;
      radiusM: number;
      punch: 'in' | 'out';
    },
  ) {
    super(
      'You are currently outside your authorized clocking location. Please proceed to your assigned work location before clocking in or out.',
    );
    this.name = 'OutsideGeofenceError';
  }
}

type GeofenceCheck =
  | { enforced: false; lat: number | null; lng: number | null }
  | {
      enforced: true;
      lat: number;
      lng: number;
      clockingLocationId: string | null;
      distanceM: number | null;
      radiusM: number;
    };

/**
 * Resolve the geofence outcome for one punch. When geofencing is OFF, never queries the assignment
 * join or computes a distance (ADR-0070 §8 — keeps the non-enforced hot path lean); stamps raw
 * coordinates only. When ON: loads the employment's active assigned sites, finds the nearest, and
 * either returns the passing match or THROWS OutsideGeofenceError (zero sites or outside every radius
 * — fail-closed). Missing coordinates while enforced THROWS GeolocationRequiredError before any query.
 */
async function resolveGeofence(
  tx: Tx,
  p: { employmentId: string; date: string; time: string; lat?: number; lng?: number; punch: 'in' | 'out' },
): Promise<GeofenceCheck> {
  const [emp] = await tx
    .select({ geofencingEnabled: employment.geofencingEnabled, geofenceRadiusM: employment.geofenceRadiusM })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  const enabled = emp?.geofencingEnabled ?? false;

  if (!enabled) {
    return { enforced: false, lat: p.lat ?? null, lng: p.lng ?? null };
  }
  if (p.lat == null || p.lng == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
    throw new GeolocationRequiredError();
  }
  const radiusM = emp!.geofenceRadiusM!; // CHECK constraint guarantees this is set + positive while enabled

  const sites = await tx
    .select({ id: clockingLocation.id, lat: clockingLocation.lat, lng: clockingLocation.lng })
    .from(employeeClockingLocation)
    .innerJoin(clockingLocation, eq(clockingLocation.id, employeeClockingLocation.clockingLocationId))
    .where(and(eq(employeeClockingLocation.employmentId, p.employmentId), isNull(clockingLocation.archivedAt)));

  let nearest: { id: string; distanceM: number } | null = null;
  for (const s of sites) {
    const d = haversineMetres(p.lat, p.lng, s.lat, s.lng);
    if (!nearest || d < nearest.distanceM) nearest = { id: s.id, distanceM: d };
  }

  if (!nearest || nearest.distanceM > radiusM) {
    throw new OutsideGeofenceError({
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.lat,
      lng: p.lng,
      nearestLocationId: nearest?.id ?? null,
      distanceM: nearest ? Math.round(nearest.distanceM) : null,
      radiusM,
      punch: p.punch,
    });
  }
  return {
    enforced: true,
    lat: p.lat,
    lng: p.lng,
    clockingLocationId: nearest.id,
    distanceM: Math.round(nearest.distanceM),
    radiusM,
  };
}

/** Append the attendance.geofence.blocked event in its OWN transaction, called AFTER the write
 *  transaction rolled back (ADR-0070 §3 — the fix for the fatal "event never commits" flaw: an event can
 *  never survive inside a transaction that itself rolls back). subjectEmploymentId is always the
 *  server-resolved employment id, never client input (ADR-0015). */
async function appendGeofenceBlockedEvent(ctx: SessionContext, err: OutsideGeofenceError): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-geofence',
      aggregateId: err.info.employmentId,
      eventType: 'attendance.geofence.blocked',
      actor: actorOf(ctx),
      subjectEmploymentId: err.info.employmentId,
      payload: { ...err.info },
    });
  });
}

export type DayType = 'workday' | 'rest_day' | 'holiday';

const DEFAULTS = {
  lateAfter: '09:15:00',
  halfDayBefore: '13:00:00',
  workStart: '09:00:00',
  workEnd: '18:00:00',
  breakMinutes: 60,
  workingDays: [1, 2, 3, 4, 5], // ISO: Mon–Fri
  halfWorkingDays: [] as number[], // Feedback 31474452: no half-day schedule markers by default
};

/** Feedback 31474452 (D2): for ATTENDANCE purposes a "Half Day" schedule marker is still a WORKING day — the
 *  engine has no notion yet of a half day's shorter hours (flagged follow-up), so classification, roster
 *  generation and absence derivation all read the UNION of workingDays ∪ halfWorkingDays. Only the LEAVE
 *  deduction amount (core/leave.ts) distinguishes Full vs Half. This prevents a re-marked rest day silently
 *  losing its rest-day OT premium, and re-marking an existing FULL day as Half changes nothing here. */
const unionWorkingDays = (workingDays: number[], halfWorkingDays: number[]): number[] => [
  ...new Set([...workingDays, ...halfWorkingDays]),
];

const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** ISO weekday (1=Mon … 7=Sun) of a YYYY-MM-DD date. */
export const isoWeekday = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

type Policy = typeof DEFAULTS;

/**
 * The fallback work schedule for an employee: the company's saved attendance policy, or the engine
 * DEFAULTS where none exists yet. Holiday resolution no longer lives here — it is delegated to the unified
 * resolver `holidayDatesFor` (ADR-0055), so attendance classifies the same calendar leave does and the
 * country/state inputs that used to be carried on the Policy are gone.
 */
async function policyFor(tx: Tx, employmentId: string): Promise<Policy & { companyId: string | null }> {
  const [row] = await tx
    .select({
      companyId: employment.companyId,
      lateAfter: attendancePolicy.lateAfter,
      halfDayBefore: attendancePolicy.halfDayBefore,
      workStart: attendancePolicy.workStart,
      workEnd: attendancePolicy.workEnd,
      breakMinutes: attendancePolicy.breakMinutes,
      workingDays: attendancePolicy.workingDays,
      halfWorkingDays: attendancePolicy.halfWorkingDays,
    })
    .from(employment)
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    companyId: row?.companyId ?? null,
    lateAfter: row?.lateAfter ?? DEFAULTS.lateAfter,
    halfDayBefore: row?.halfDayBefore ?? DEFAULTS.halfDayBefore,
    workStart: row?.workStart ?? DEFAULTS.workStart,
    workEnd: row?.workEnd ?? DEFAULTS.workEnd,
    breakMinutes: row?.breakMinutes ?? DEFAULTS.breakMinutes,
    workingDays: row?.workingDays ?? DEFAULTS.workingDays,
    halfWorkingDays: row?.halfWorkingDays ?? DEFAULTS.halfWorkingDays,
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
// R17 3e8350db — early-leave grace: a checkout before (shift end − grace) is short. Cross-midnight safe
// (the +MINS_PER_DAY keeps the modulo positive when the subtraction underflows).
const subGrace = (t: string, grace: number): string => fmtTime((toMinutes(t) - grace + MINS_PER_DAY) % MINS_PER_DAY);

/** In→out span in minutes, cross-midnight aware: a check-out time-of-day earlier than check-in means the
 *  shift ran past midnight (e.g. 22:00 → 06:00 = 480m), so add a day. For same-day spans this is identical
 *  to (out − in), so non-rostered days are unchanged. */
const spanMinutes = (checkInAt: string, checkOutAt: string): number => {
  const ci = toMinutes(checkInAt);
  const co = toMinutes(checkOutAt);
  return co >= ci ? co - ci : co + MINS_PER_DAY - ci;
};

/** Gross span of a shift in minutes, cross-midnight aware. SHARED shift-time math (R7 Phase 1): exported so
 *  core/roster.ts validates against the same span the engine derives with — do NOT fork this into roster. */
export const shiftSpan = (start: string, end: string, crosses: boolean): number =>
  crosses ? toMinutes(end) + MINS_PER_DAY - toMinutes(start) : toMinutes(end) - toMinutes(start);

/** Net scheduled minutes of a shift: span − break. The SHARED auto normal-hours figure (R7 Phase 1) — the
 *  shift form's auto readout and the engine's scheduledMinutes are this one expression, never persisted. */
export const netScheduledMinutes = (start: string, end: string, crosses: boolean, breakMinutes: number): number =>
  Math.max(0, shiftSpan(start, end, crosses) - breakMinutes);

// ADR-0032 Phase C: the schedule the engine derives against for one (employee, date) — resolved from the
// employee's roster when present, else the company policy (today's behaviour, byte-identical).
type ResolvedSchedule = {
  dayType: DayType;
  lateAfter: string; // time-of-day after which check-in is "late" (shift start + policy grace, or policy)
  halfDayBefore: string; // checkout before this on a workday ⇒ half-day (policy / shift midpoint)
  scheduledMinutes: number; // net scheduled work minutes (workday OT = worked − this, unless overridden)
  breakMinutes: number;
  // R7 Multi-Shift Phase 1: the shift's manual normal-hours override. When set it is the shift's normal
  // working minutes — the workday OT threshold in deriveAttendance — instead of scheduledMinutes. Only a
  // rostered shift can carry one; the policy branch is always null (byte-identical legacy behaviour).
  normalMinutesOverride: number | null;
  // R17 3e8350db — the resolved shift's per-shift OT rule (eligibility / minimum block / daily cap). Shapes
  // WORKDAY OT accrual only (deriveAttendance); statutory rest/holiday premium is untouched. Null on the
  // policy branch and whenever the shift carries no rule ⇒ byte-identical legacy OT.
  otRule: ShiftOtRule | null;
  // 88e94371 — the resolved attendance rule ("Lateness, Early Out & Overtime Settings"): the shift's rule_id
  // when set, else the employee's-company Standard rule, else null (⇒ legacy behaviour). Its OT rows drive
  // OT-minute rounding + early-OT inclusion in deriveAttendance; its grace periods feed the late/early
  // thresholds below (as a fallback UNDER any explicit per-shift grace, so existing shifts stay identical).
  rule: ResolvedAttendanceRule | null;
  crossesMidnight: boolean;
  // ec4cbf63: 'default-shift' / 'default-shift-rest' = resolved from employment.default_shift_id (no roster
  // row for the date). Diagnostic only — nothing downstream branches on source for pay except the hourly
  // clamp (payableHoursForCycle), which resolves roster/default-shift itself.
  source: 'policy' | 'roster-shift' | 'roster-rest' | 'default-shift' | 'default-shift-rest';
};

/** Resolve the schedule for one employee+date: rostered shift > holiday (calendar) > rostered rest-day >
 *  DEFAULT shift (employment.default_shift_id, ec4cbf63 — its weekly_pattern decides working vs rest) >
 *  company policy. No roster row and no default shift ⇒ the policy branch, which reproduces the
 *  pre-Phase-C engine exactly. */
async function scheduleFor(tx: Tx, employmentId: string, date: string): Promise<ResolvedSchedule> {
  const pol = await policyFor(tx, employmentId);
  const grace = Math.max(0, toMinutes(pol.lateAfter) - toMinutes(pol.workStart)); // 15m by default
  // ADR-0055: the day-type holiday flag comes from the unified resolver — business-group → state →
  // national, single-winner replacement — the SAME calendar the leave engine resolves (leave.ts
  // resolveHolidaySet), so attendance OT day-type classification can never disagree with leave. A
  // business-group override REPLACES nat+state; no company/state rows ⇒ national-only = today's behaviour.
  const isHoliday = (await holidayDatesFor(tx, { employmentId, startDate: date, endDate: date })).has(date);
  // 88e94371 — the employee's-company Standard ("Lateness, Early Out & Overtime Settings") rule. Used by the
  // policy/rest branches AND as the fallback when a resolved shift carries no explicit rule_id. Null when the
  // company has no rule yet ⇒ byte-identical legacy behaviour.
  const companyRule = await resolveRuleTx(tx, { ruleId: null, companyId: pol.companyId });
  // The effective late/early grace for a shift branch: an explicit per-shift grace wins (R17, unchanged); else
  // the rule's grace-period section; else the policy-derived grace / midpoint heuristic (null ⇒ legacy).
  const ruleFor = (ruleId: string | null): Promise<ResolvedAttendanceRule | null> =>
    ruleId ? resolveRuleTx(tx, { ruleId, companyId: pol.companyId }) : Promise.resolve(companyRule);
  const [ra] = await tx
    .select({
      isRestDay: rosterAssignment.isRestDay,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      override: shift.normalMinutesOverride,
      lateGrace: shift.lateGraceMinutes,
      earlyLeaveGrace: shift.earlyLeaveGraceMinutes,
      otRule: shift.otRule,
      ruleId: shift.ruleId,
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
    normalMinutesOverride: null,
    otRule: null,
    rule: companyRule,
    crossesMidnight: false,
    source: 'policy',
  });

  // A rostered shift defines the schedule even on a calendar holiday or weekend; the day TYPE still comes
  // from the calendar (holiday) so OT is classified at the right premium.
  if (ra && !ra.isRestDay && ra.start && ra.end) {
    const sched = netScheduledMinutes(ra.start, ra.end, ra.crosses!, ra.brk!);
    const rule = await ruleFor(ra.ruleId);
    // 88e94371 — grace precedence: explicit per-shift grace (R17) → rule grace section → policy-derived grace
    // / midpoint. The Standard rule's late grace is seeded to equal the policy grace, so a shift with no
    // explicit grace + the Standard rule stays byte-identical to before.
    const lateGrace = ra.lateGrace ?? rule?.lateGracePeriodMinutes ?? grace;
    // Early grace only OVERRIDES the midpoint heuristic when explicitly set (>0); the Standard/converted rule
    // carries early grace 0 (= "unset"), so it keeps the legacy midpoint — no silent half-day reclassification.
    const earlyGrace = ra.earlyLeaveGrace ?? (rule && rule.earlyGracePeriodMinutes > 0 ? rule.earlyGracePeriodMinutes : null);
    return {
      dayType: isHoliday ? 'holiday' : 'workday',
      lateAfter: addGrace(ra.start, lateGrace),
      halfDayBefore:
        earlyGrace != null
          ? subGrace(ra.end, earlyGrace)
          : fmtTime((toMinutes(ra.start) + Math.floor(shiftSpan(ra.start, ra.end, ra.crosses!) / 2)) % MINS_PER_DAY),
      scheduledMinutes: sched,
      breakMinutes: ra.brk!,
      normalMinutesOverride: ra.override ?? null,
      otRule: ra.otRule ?? null,
      rule,
      crossesMidnight: ra.crosses!,
      source: 'roster-shift',
    };
  }
  // A rostered REST day: the calendar-holiday class still wins (premium 3× beats rest-day 2×) — unchanged
  // ordering from before the default-shift step below.
  if (ra?.isRestDay) {
    if (isHoliday) return policyBranch('holiday');
    return { ...policyBranch('rest_day'), source: 'roster-rest' };
  }

  // ec4cbf63 — NO roster row: the employee's DEFAULT shift (profile assignment) resolves next, BEFORE the
  // flat company policy. Its weekly_pattern decides working vs rest day (a shift with no pattern has no
  // working days — deliberate: pattern-less shifts predate Phase 2 and cannot drive scheduling). The shift
  // is honoured even if archived AFTER assignment, exactly like a dated roster row pointing at an archived
  // shift; only NEW assignments of archived shifts are blocked (core/roster.ts assignDefaultShift).
  const [ds] = await tx
    .select({
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      override: shift.normalMinutesOverride,
      pattern: shift.weeklyPattern,
      lateGrace: shift.lateGraceMinutes,
      earlyLeaveGrace: shift.earlyLeaveGraceMinutes,
      otRule: shift.otRule,
      ruleId: shift.ruleId,
    })
    .from(employment)
    .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (ds) {
    if (ds.pattern?.includes(isoWeekday(date))) {
      // Working day of the default shift — mirror the roster-shift branch byte-for-byte, incl. the
      // holiday day-type overlay (the default shift's hours still define the schedule on a holiday), the
      // R17 per-shift grace override, and the 88e94371 rule grace fallback.
      const sched = netScheduledMinutes(ds.start, ds.end, ds.crosses, ds.brk);
      const rule = await ruleFor(ds.ruleId);
      const lateGrace = ds.lateGrace ?? rule?.lateGracePeriodMinutes ?? grace;
      const earlyGrace = ds.earlyLeaveGrace ?? (rule && rule.earlyGracePeriodMinutes > 0 ? rule.earlyGracePeriodMinutes : null);
      return {
        dayType: isHoliday ? 'holiday' : 'workday',
        lateAfter: addGrace(ds.start, lateGrace),
        halfDayBefore:
          earlyGrace != null
            ? subGrace(ds.end, earlyGrace)
            : fmtTime((toMinutes(ds.start) + Math.floor(shiftSpan(ds.start, ds.end, ds.crosses) / 2)) % MINS_PER_DAY),
        scheduledMinutes: sched,
        breakMinutes: ds.brk,
        normalMinutesOverride: ds.override ?? null,
        otRule: ds.otRule ?? null,
        rule,
        crossesMidnight: ds.crosses,
        source: 'default-shift',
      };
    }
    // The default shift's own rest day wins over the flat company working-days list (matching how a
    // rostered rest day wins) — but a calendar holiday still classifies at the holiday premium.
    if (isHoliday) return policyBranch('holiday');
    return { ...policyBranch('rest_day'), source: 'default-shift-rest' };
  }

  if (isHoliday) return policyBranch('holiday');
  // No roster for this employee+date ⇒ company policy (working-days → workday/rest_day). A Half-day marker
  // (D2) counts as a WORKING day here — only leave.ts's deduction math distinguishes Full vs Half.
  return policyBranch(
    unionWorkingDays(pol.workingDays, pol.halfWorkingDays).includes(isoWeekday(date)) ? 'workday' : 'rest_day',
  );
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
  // R7 Multi-Shift Phase 1 — the ONE deliberate OT-derivation change: when the rostered shift carries a
  // manual normal-hours override, workday OT is measured against IT (the override is the shift's normal
  // working minutes everywhere, not a display figure). Null ⇒ span − break, byte-identical to before.
  let otMinutes =
    s.dayType === 'workday'
      ? Math.max(0, workedMinutes - (s.normalMinutesOverride ?? s.scheduledMinutes))
      : workedMinutes;
  // R17 3e8350db — per-shift "OT Rules" shape WORKDAY OT accrual only (rest/holiday premium is statutory and
  // untouched): eligible=false zeroes workday OT; a minimum block drops OT below the threshold to zero; a
  // daily cap clamps it. Null rule ⇒ byte-identical to before.
  if (s.dayType === 'workday' && s.otRule) {
    if (!s.otRule.eligible) {
      otMinutes = 0;
    } else {
      if (s.otRule.minMinutes != null && otMinutes < s.otRule.minMinutes) otMinutes = 0;
      if (s.otRule.dailyCapMinutes != null) otMinutes = Math.min(otMinutes, s.otRule.dailyCapMinutes);
    }
  }
  // 88e94371 — apply the resolved rule's Overtime table: round the workday OT minutes to the matching band's
  // Round-To value and fold in pre-shift ("early") OT when the rule opts in. The engine does not yet attribute
  // pre-shift punch minutes as a separate figure, so earlyOtMinutes is 0 here (documented GAP); a rule with no
  // OT rows / rounding leaves otMinutes unchanged (byte-identical). Statutory 1.5×/2×/3× multipliers stay the
  // pay-side compliance cap and are untouched. Only workday OT is shaped (rest/holiday premium is statutory).
  if (s.dayType === 'workday' && otMinutes != null && s.rule) {
    otMinutes = applyOtRuleRows(otMinutes, 0, s.rule);
  }
  return { status, workedMinutes, otMinutes };
}

// ─────────────────── 2.1.3 Hourly · shift-bounded payable hours ───────────────────
//
// payableHoursForCycle — the ONE genuinely-new behaviour for the Hourly payroll policy. Given an employment and
// a date window, return the payable HOURS (decimal) for that window, with one switch:
//
//   • onlyPullHoursWithinShiftSchedule = false (or omitted) → sum(workedMinutes)/60 over the window. Byte-
//     identical to "all worked hours count" (today's behaviour for a per_hour rule).
//
//   • onlyPullHoursWithinShiftSchedule = true → for each attendance row, clamp that day's worked minutes to the
//     ROSTERED shift's net scheduled minutes (source:'roster-shift'). Concretely the day's payable minutes are
//     min(workedMinutes, scheduledMinutes). Edge semantics, each decided + documented:
//       – Rostered workday/holiday-with-roster (source:'roster-shift'): payable = min(worked, scheduled). This
//         means OVERTIME (worked − scheduled) is NEVER paid when ON — that IS the meaning of "only pay hours
//         within the assigned shift". OT is a premium concern owned by the OT path, not this clamp.
//       – Rest day with a rostered shift is impossible (the shift-xor-rest DB invariant); a rostered REST day
//         (source:'roster-rest') has scheduledMinutes via the policy branch but is NOT an assigned shift → 0
//         payable when ON.
//       – No roster row but a DEFAULT shift (employment.default_shift_id, ec4cbf63) whose weekly_pattern
//         includes the day: the default shift IS the assigned shift → payable = min(worked, its net scheduled
//         minutes) — mirroring scheduleFor's roster → default-shift → policy order so batch and single-day
//         resolution can't diverge. A pattern REST day of the default shift is not an assigned shift → 0.
//       – No roster row and no default shift (source:'policy', the company-default working-day schedule) is
//         NOT an assigned shift → 0 payable when ON: a day the employee was not assigned onto any shift
//         contributes nothing under the toggle.
//       – Cross-midnight shift (e.g. 22:00→06:00): scheduleFor/scheduledMinutes are cross-midnight aware; the
//         worked minutes already live on the shift's start-date attendance row (the punch importer keys a night
//         shift to its start date). We clamp per attendance-date row against THAT date's resolved schedule —
//         the simplest consistent rule — so a cross-midnight shift's scheduled span is the clamp ceiling.
//
// Efficiency: ONE grouped attendance query + ONE grouped roster/shift query for the whole window, then clamp in
// memory. We deliberately do NOT call scheduleFor per (employee, date) in a loop (that is an N-query pattern);
// holiday-class is irrelevant to the clamp (a rostered shift on a holiday still bounds payable hours by its
// scheduled span), so we resolve roster→shift directly here, mirroring the single-aggregate pattern elsewhere.
//
// This helper is PURE-READ (no DomainEvent — substrate rule) and is NOT wired into core/payroll.ts live compute:
// feeding shift-bounded hours into the per_hour rate to produce a payslip is the deferred follow-up.
export async function payableHoursForCycle(
  tx: Tx,
  employmentId: string,
  window: { from: string; to: string },
  opts: { onlyPullHoursWithinShiftSchedule: boolean },
): Promise<number> {
  const rows = await tx
    .select({ date: attendance.attendanceDate, workedMinutes: attendance.workedMinutes })
    .from(attendance)
    .where(
      and(
        eq(attendance.employmentId, employmentId),
        gte(attendance.attendanceDate, window.from),
        lte(attendance.attendanceDate, window.to),
      ),
    );

  // Toggle OFF → all worked minutes count (byte-identical to "all worked hours count").
  if (!opts.onlyPullHoursWithinShiftSchedule) {
    const mins = rows.reduce((acc, r) => acc + (r.workedMinutes ?? 0), 0);
    return mins / 60;
  }

  // Toggle ON → clamp each day to its rostered shift's net scheduled minutes. One grouped query for the roster
  // shifts in the window; a day with no rostered shift (or a rest-day roster) has no entry → 0 payable.
  const ras = await tx
    .select({
      shiftDate: rosterAssignment.shiftDate,
      isRestDay: rosterAssignment.isRestDay,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
    })
    .from(rosterAssignment)
    .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
    .where(
      and(
        eq(rosterAssignment.employmentId, employmentId),
        gte(rosterAssignment.shiftDate, window.from),
        lte(rosterAssignment.shiftDate, window.to),
      ),
    );
  // scheduledMinutes-within-shift per date, ONLY for an actual rostered shift (rest-day rosters → none).
  const schedByDate = new Map<string, number>();
  const rosteredDates = new Set<string>(); // ANY roster row (shift or rest) — a roster row always wins
  for (const r of ras) {
    rosteredDates.add(r.shiftDate);
    if (r.isRestDay || !r.start || !r.end) continue; // a rostered rest day is not an assigned shift
    schedByDate.set(r.shiftDate, Math.max(0, shiftSpan(r.start, r.end, r.crosses!) - r.brk!));
  }

  // ec4cbf63 — the employee's DEFAULT shift (profile assignment) IS an assigned shift: on a day with NO
  // roster row whose ISO weekday is in the default shift's weekly_pattern, the clamp ceiling is the default
  // shift's net scheduled minutes — the SAME resolution order scheduleFor applies (roster → default shift →
  // nothing), so batch payable-hours and single-day derivation can't diverge. A rostered rest day still
  // contributes 0 (the roster row wins), and a pattern rest day is not an assigned shift.
  const [ds] = await tx
    .select({
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      pattern: shift.weeklyPattern,
    })
    .from(employment)
    .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  const dsNet = ds ? netScheduledMinutes(ds.start, ds.end, ds.crosses, ds.brk) : null;

  let payableMinutes = 0;
  for (const row of rows) {
    const scheduled =
      schedByDate.get(row.date) ??
      (!rosteredDates.has(row.date) && dsNet != null && ds!.pattern?.includes(isoWeekday(row.date))
        ? dsNet
        : undefined);
    if (scheduled === undefined) continue; // no assigned shift that day → 0 payable when ON
    payableMinutes += Math.min(row.workedMinutes ?? 0, scheduled);
  }
  return payableMinutes / 60;
}

export type GeoInput = { lat: number; lng: number };

async function checkInTx(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput },
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

    // ADR-0070: resolve the geofence outcome BEFORE writing. Throws (rolling back this transaction, no
    // row/event written) when enforced and outside every assigned site — the caller catches it outside
    // this transaction and appends the blocked event separately.
    const geo = await resolveGeofence(tx, {
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.geo?.lat,
      lng: p.geo?.lng,
      punch: 'in',
    });

    const [row] = await tx
      .insert(attendance)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        checkInAt: p.time,
        status,
        dayType,
        checkInLat: geo.lat,
        checkInLng: geo.lng,
        checkInClockingLocationId: geo.enforced ? geo.clockingLocationId : null,
        checkInDistanceM: geo.enforced ? geo.distanceM : null,
        checkInGeofenceStatus: geo.enforced ? 'pass' : 'not_enforced',
        checkInRadiusM: geo.enforced ? geo.radiusM : null,
        checkInMethod: 'web',
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

/** Check in. `geo` is optional — omitted/undefined when the browser gave no coordinates (allowed only
 *  while geofencing is OFF for this employment; see resolveGeofence). Catches OutsideGeofenceError
 *  OUTSIDE the write transaction and appends the blocked event in its own transaction before rethrowing
 *  (ADR-0070 §3 — the only way a blocked ATTEMPT can be durably recorded once its write rolled back). */
export async function checkIn(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput },
) {
  try {
    return await checkInTx(ctx, p);
  } catch (e) {
    if (e instanceof OutsideGeofenceError) {
      await appendGeofenceBlockedEvent(ctx, e);
    }
    throw e;
  }
}

async function checkOutTx(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput },
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

    // ADR-0070: resolve the geofence outcome for the CHECK-OUT punch — independent of the check-in punch's
    // status/radius (a mid-day toggle or radius change is representable; each punch freezes its own).
    const geo = await resolveGeofence(tx, {
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.geo?.lat,
      lng: p.geo?.lng,
      punch: 'out',
    });

    await tx
      .update(attendance)
      .set({
        checkOutAt: p.time,
        status,
        dayType,
        workedMinutes,
        otMinutes,
        checkOutLat: geo.lat,
        checkOutLng: geo.lng,
        checkOutClockingLocationId: geo.enforced ? geo.clockingLocationId : null,
        checkOutDistanceM: geo.enforced ? geo.distanceM : null,
        checkOutGeofenceStatus: geo.enforced ? 'pass' : 'not_enforced',
        checkOutRadiusM: geo.enforced ? geo.radiusM : null,
        checkOutMethod: 'web',
      })
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

/** Check out. Same optional-geo / blocked-event contract as checkIn (ADR-0070 §3). */
export async function checkOut(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput },
) {
  try {
    return await checkOutTx(ctx, p);
  } catch (e) {
    if (e instanceof OutsideGeofenceError) {
      await appendGeofenceBlockedEvent(ctx, e);
    }
    throw e;
  }
}

export type DayContext = 'on_leave' | 'holiday' | 'rest_day' | null;

/**
 * Every active employee with their attendance row for `date` (null = no row), plus the
 * context that explains a missing row: approved leave > public holiday > rest day.
 *
 * `opts.departmentId` (Attendance>Records Daily tab, 314ea061) narrows to a single department via the
 * employee's CURRENT assignment (validTo/supersededAt null) — the same current-assignment join the People
 * directory uses. Absent = every department (today's behaviour, unchanged).
 */
export function attendanceForDate(
  ctx: SessionContext,
  date: string,
  companyIds?: string[],
  opts?: { departmentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Current assignment (≤1 per employment) — only needed to filter by department; a leftJoin keeps every
    // employee visible when no department filter is applied.
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        companyId: employment.companyId,
        attendanceId: attendance.id,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
        // ADR-0070: per-punch Clocking Location & Geofencing capture for the day table's Location column.
        checkInLat: attendance.checkInLat,
        checkInLng: attendance.checkInLng,
        checkInLocationName: dayCheckInSite.name,
        checkInDistanceM: attendance.checkInDistanceM,
        checkInGeofenceStatus: attendance.checkInGeofenceStatus,
        checkOutLat: attendance.checkOutLat,
        checkOutLng: attendance.checkOutLng,
        checkOutLocationName: dayCheckOutSite.name,
        checkOutDistanceM: attendance.checkOutDistanceM,
        checkOutGeofenceStatus: attendance.checkOutGeofenceStatus,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        attendance,
        and(eq(attendance.employmentId, employment.id), eq(attendance.attendanceDate, date)),
      )
      .leftJoin(dayCheckInSite, eq(dayCheckInSite.id, attendance.checkInClockingLocationId))
      .leftJoin(dayCheckOutSite, eq(dayCheckOutSite.id, attendance.checkOutClockingLocationId))
      .leftJoin(assignment, currentAssignment)
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
          opts?.departmentId ? eq(assignment.departmentId, opts.departmentId) : undefined,
        ),
      )
      .orderBy(person.fullName);

    const empIds = rows.map((r) => r.employmentId);
    const [approvedDates, policies] = await Promise.all([
      // ADR-0068 §4A: read EFFECTIVELY-approved dates (per-date decisions respected). Only full_day leave
      // suppresses the day's attendance signal — a half-day / hourly leave still expects attendance for the
      // worked portion — and approvedLeaveDates already filters full_day. A per-date request's interior
      // REJECTED date is NOT in the set, so it is no longer counted as on-leave (the central fix).
      approvedLeaveDates(tx, empIds, date, date),
      tx
        .select({
          companyId: attendancePolicy.companyId,
          workingDays: attendancePolicy.workingDays,
          halfWorkingDays: attendancePolicy.halfWorkingDays,
        })
        .from(attendancePolicy),
    ]);
    const leaveSet = new Set<string>();
    for (const [emp, dates] of approvedDates) if (dates.has(date)) leaveSet.add(emp);
    // D2: a Half-day marker still counts as a working day for attendance — union with halfWorkingDays.
    const daysByCompany = new Map(
      policies.map((p) => [p.companyId, unionWorkingDays(p.workingDays, p.halfWorkingDays)]),
    );
    const dow = isoWeekday(date);

    // ADR-0055: resolve each absent employee's holiday calendar through the unified resolver (business-group
    // → state → national), the SAME calendar leave + checkIn use — so a group/state holiday explains a
    // missing row exactly as it freezes the day-type. Only no-row employees need this context; one resolver
    // call each, sequential because every call shares the one transaction connection.
    const holidayEmp = new Set<string>();
    for (const r of rows) {
      if (r.attendanceId) continue;
      const hs = await holidayDatesFor(tx, { employmentId: r.employmentId, startDate: date, endDate: date });
      if (hs.has(date)) holidayEmp.add(r.employmentId);
    }

    return rows.map(({ companyId, ...r }) => {
      let context: DayContext = null;
      if (!r.attendanceId) {
        if (leaveSet.has(r.employmentId)) context = 'on_leave';
        else if (holidayEmp.has(r.employmentId)) context = 'holiday';
        else if (!(daysByCompany.get(companyId) ?? DEFAULTS.workingDays).includes(dow))
          context = 'rest_day';
      }
      return { ...r, context };
    });
  });
}

export type AttendanceRangeRow = {
  date: string;
  attendanceId: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: string | null;
  dayType: DayType | null;
  workedMinutes: number | null;
  otMinutes: number | null;
  /** Explains a no-row day, same precedence as attendanceForDate: leave > holiday > rest day. */
  context: DayContext;
};

/**
 * One row per calendar day in [from, to] for a SINGLE employment (Attendance>Records Individual tab,
 * 314ea061). The range analogue of attendanceForDate: an attendance row when present, else the context
 * (approved full-day leave > public holiday > rest day) that explains its absence. Read-only.
 */
export function attendanceForEmploymentRange(
  ctx: SessionContext,
  employmentId: string,
  from: string,
  to: string,
): Promise<AttendanceRangeRow[]> {
  return withTenant(ctx, async (tx) => {
    if (from > to) return [];
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    if (!emp) return []; // RLS-fenced: not visible to this session, or no such employment.

    const [rows, policyRows, approvedDates, holidays] = await Promise.all([
      tx
        .select({
          date: attendance.attendanceDate,
          attendanceId: attendance.id,
          checkInAt: attendance.checkInAt,
          checkOutAt: attendance.checkOutAt,
          status: attendance.status,
          dayType: attendance.dayType,
          workedMinutes: attendance.workedMinutes,
          otMinutes: attendance.otMinutes,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.employmentId, employmentId),
            gte(attendance.attendanceDate, from),
            lte(attendance.attendanceDate, to),
          ),
        ),
      tx
        .select({
          workingDays: attendancePolicy.workingDays,
          halfWorkingDays: attendancePolicy.halfWorkingDays,
        })
        .from(attendancePolicy)
        .where(eq(attendancePolicy.companyId, emp.companyId))
        .limit(1),
      // Only full_day leave suppresses the attendance signal (approvedLeaveDates already filters full_day).
      approvedLeaveDates(tx, [employmentId], from, to),
      holidayDatesFor(tx, { employmentId, startDate: from, endDate: to }),
    ]);

    const byDate = new Map(rows.map((r) => [r.date, r]));
    const leaveSet = approvedDates.get(employmentId) ?? new Set<string>();
    const workDays = policyRows[0]
      ? unionWorkingDays(policyRows[0].workingDays, policyRows[0].halfWorkingDays)
      : DEFAULTS.workingDays;

    const out: AttendanceRangeRow[] = [];
    let d = from;
    // Guard against a pathological range; a first-of-month → today window is ≤ 31 days.
    for (let i = 0; i < 400 && d <= to; i++) {
      const row = byDate.get(d);
      let context: DayContext = null;
      if (!row) {
        if (leaveSet.has(d)) context = 'on_leave';
        else if (holidays.has(d)) context = 'holiday';
        else if (!workDays.includes(isoWeekday(d))) context = 'rest_day';
      }
      out.push({
        date: d,
        attendanceId: row?.attendanceId ?? null,
        checkInAt: row?.checkInAt ?? null,
        checkOutAt: row?.checkOutAt ?? null,
        status: row?.status ?? null,
        dayType: row?.dayType ?? null,
        workedMinutes: row?.workedMinutes ?? null,
        otMinutes: row?.otMinutes ?? null,
        context,
      });
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
    return out;
  });
}

export type MonthSummaryRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
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
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
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
      // ADR-0068 §4A: EFFECTIVELY-approved dates for the month (per-date decisions respected). Only full_day
      // leave counts as a full leave day in the monthly summary (approvedLeaveDates already filters full_day);
      // a per-date request's interior REJECTED date is excluded, so it is not miscounted as a leave day.
      approvedLeaveDates(tx, empIds, monthStart, monthEnd),
      tx
        .select({
          companyId: attendancePolicy.companyId,
          workingDays: attendancePolicy.workingDays,
          halfWorkingDays: attendancePolicy.halfWorkingDays,
        })
        .from(attendancePolicy),
    ]);

    // D2: a Half-day marker still counts as a working day for absence derivation — union with halfWorkingDays.
    const daysByCompany = new Map(
      policies.map((pp) => [pp.companyId, unionWorkingDays(pp.workingDays, pp.halfWorkingDays)]),
    );
    // ADR-0055: each employee's holiday calendar for the month via the unified resolver (business-group →
    // state → national), the SAME calendar leave + checkIn use. One call per employee (the resolver is
    // single-employment, as leave.ts consumes it); sequential because the calls share one transaction
    // connection. Used only so a holiday is never miscounted as absence — the OT split below reads each
    // row's stored dayType (already frozen by scheduleFor through this same resolver).
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
      // ADR-0068 §4A: the employee's set of effectively-approved leave dates for the month (per-date decisions
      // respected). A date is on-leave iff it is in this set — no per-request span math here anymore.
      const myLeaveDates = approvedDates.get(e.employmentId) ?? new Set<string>();
      const onLeave = (d: string) => myLeaveDates.has(d);
      const workingDays = daysByCompany.get(e.companyId) ?? DEFAULTS.workingDays;
      // ADR-0055: a date is a holiday for this employee iff it is in their resolved calendar (business-group
      // → state → national) — agreeing with the dayType checkIn freezes through the same resolver.
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
        otCapExceeded: totalOt > OT_CAP_MINUTES,
        over45hWeek: [...weekMinutes.values()].some((v) => v > WEEK_LIMIT_MINUTES),
      };
    });
  });
}

// ───────────────────── Corrections (ADR-0011 Phase B) ─────────────────────

export type OtApprovalMethod = 'requested' | 'system_calculated' | 'smaller_of';

/** ADR-0069: resolve the APPROVED overtime minutes from the employee's requested figure, the engine's live
 *  system-calculated figure, and the company's chosen method. Pure — the review UI shows both inputs live and
 *  the decide path stamps the result. `system` is the engine-derived OT for the day (may be null when the day
 *  has no clock-out to derive from, e.g. an OT-only request against an unclosed day) — treated as 0 there so a
 *  `system_calculated`/`smaller_of` policy cannot silently approve a phantom figure. */
export function resolveApprovedOt(
  requested: number,
  system: number | null,
  method: OtApprovalMethod,
): number {
  const sys = system ?? 0;
  switch (method) {
    case 'requested':
      return Math.max(0, Math.trunc(requested));
    case 'system_calculated':
      return Math.max(0, Math.trunc(sys));
    case 'smaller_of':
      return Math.max(0, Math.min(Math.trunc(requested), Math.trunc(sys)));
  }
}

/** The company's OT-approval calculation method for an employee (from attendance_policy; default system_calculated). */
async function otApprovalCalculationFor(tx: Tx, employmentId: string): Promise<OtApprovalMethod> {
  const [row] = await tx
    .select({ m: attendancePolicy.otApprovalCalculation })
    .from(employment)
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return (row?.m ?? 'system_calculated') as OtApprovalMethod;
}

/** Raise a correction request for a day's punches and/or an overtime request (ADR-0069). RLS confines who an
 *  employment is visible to (self / manager / admin), so a peer cannot file for someone else.
 *
 *  ADR-0069: `checkIn` is now OPTIONAL — an "OT only" request supplies just `requestedOtMinutes` (and remarks).
 *  Application-level validation enforces:
 *    • at least one of (checkIn, checkOut, requestedOtMinutes) is present — mirrors the DB check constraint;
 *    • a checkOut cannot be given without a checkIn (a lone checkOut has no anchor to derive against);
 *    • `reason`/remarks is MANDATORY (enforced here, NOT at the DB layer — reason stays nullable to avoid a
 *      breaking retroactive NOT NULL on the live table);
 *    • requestedOtMinutes, when present, is a non-negative integer. */
export async function requestAttendanceCorrection(
  ctx: SessionContext,
  p: {
    employmentId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    requestedOtMinutes?: number | null;
    reason?: string;
  },
) {
  const checkIn = p.checkIn ?? null;
  const checkOut = p.checkOut ?? null;
  const hasOt = p.requestedOtMinutes != null;
  // At least one of clock-in / clock-out / OT (mirrors the DB check constraint, with a friendly message).
  if (!checkIn && !checkOut && !hasOt) {
    throw new Error('Provide at least one of a clock-in time, a clock-out time, or overtime hours.');
  }
  // A clock-out with no clock-in has no anchor to derive against.
  if (checkOut && !checkIn) {
    throw new Error('A clock-out time also needs a clock-in time.');
  }
  if (checkIn && checkOut && toMinutes(checkOut) <= toMinutes(checkIn)) {
    throw new Error('Check-out must be after check-in');
  }
  // Remarks mandatory (application-level per ADR-0069).
  const reason = (p.reason ?? '').trim();
  if (reason.length === 0) {
    throw new Error('A reason is required.');
  }
  let requestedOtMinutes: number | null = null;
  if (hasOt) {
    const ot = Math.trunc(p.requestedOtMinutes!);
    if (!Number.isFinite(ot) || ot < 0) throw new Error('Overtime minutes must be a non-negative whole number.');
    requestedOtMinutes = ot;
  }
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(attendanceCorrection)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        proposedCheckIn: checkIn,
        proposedCheckOut: checkOut,
        requestedOtMinutes,
        reason,
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
        checkIn,
        checkOut,
        requestedOtMinutes,
        reason,
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
      const hasClockCorrection = cor.proposedCheckIn != null;
      const hasOtRequest = cor.requestedOtMinutes != null;

      // ADR-0069: resolve the APPROVED OT once, up front, so the SAME value is written to attendance.otMinutes,
      // stamped on the correction row, and (crucially) read by maybeAutoAccrueOnApprovalTx below. The auto-accrual
      // reads attendance.otMinutes AFTER we write it — so the DECISION (tested & documented in ADR-0069) is: TOIL
      // auto-accrual consumes the POLICY-ADJUSTED approved OT, never the raw engine figure. attendance.otMinutes is
      // the single source of truth for both the payroll prefill AND the TOIL day-credit math — no double-counting.
      let approvedOtMinutes: number | null = null;
      let otApprovalMethod: OtApprovalMethod | null = null;
      let systemOtForComparison: number | null = null;
      if (hasOtRequest) {
        otApprovalMethod = await otApprovalCalculationFor(tx, cor.employmentId);
        // The system-calculated comparison figure: derive live from the punches that WILL be authoritative for the
        // day. For a clock correction that is the proposed punches; for an OT-only request it is the existing
        // approved attendance row's punches (resolved below). Computed live — never stored (ADR-0069).
        if (hasClockCorrection) {
          systemOtForComparison = deriveAttendance(sched, cor.proposedCheckIn!, cor.proposedCheckOut).otMinutes;
        } else {
          const [existing] = await tx
            .select({ checkInAt: attendance.checkInAt, checkOutAt: attendance.checkOutAt })
            .from(attendance)
            .where(
              and(
                eq(attendance.employmentId, cor.employmentId),
                eq(attendance.attendanceDate, cor.attendanceDate),
              ),
            )
            .limit(1);
          systemOtForComparison =
            existing?.checkInAt != null
              ? deriveAttendance(sched, existing.checkInAt, existing.checkOutAt).otMinutes
              : null;
        }
        approvedOtMinutes = resolveApprovedOt(cor.requestedOtMinutes!, systemOtForComparison, otApprovalMethod);
      }

      let amendedId: string;
      let eventPayload: Record<string, unknown>;

      if (hasClockCorrection) {
        const d = deriveAttendance(sched, cor.proposedCheckIn!, cor.proposedCheckOut);
        // When OT was also requested, the approved (policy-adjusted) OT OVERRIDES the derived figure.
        const otMinutes = hasOtRequest ? approvedOtMinutes : d.otMinutes;
        // ADR-0070: a correction always replaces both punches' geo-capture fields with null and leaves
        // method NULL (no 'correction' enum value, per the panel's scope-creep cut) — the disclosed,
        // approval-gated geofence bypass. Cutting this would leave a stale geofence attestation sitting
        // next to punch times the correction actually wrote, which is the missing-edges bug the panel
        // flagged; geofencing itself is NOT re-checked here (a human already approved this correction).
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
            otMinutes,
            remarks: 'Corrected',
            checkInMethod: null,
            checkInLat: null,
            checkInLng: null,
            checkInClockingLocationId: null,
            checkInDistanceM: null,
            checkInGeofenceStatus: null,
            checkInRadiusM: null,
            checkOutMethod: null,
            checkOutLat: null,
            checkOutLng: null,
            checkOutClockingLocationId: null,
            checkOutDistanceM: null,
            checkOutGeofenceStatus: null,
            checkOutRadiusM: null,
          })
          .onConflictDoUpdate({
            target: [attendance.employmentId, attendance.attendanceDate],
            set: {
              checkInAt: cor.proposedCheckIn,
              checkOutAt: cor.proposedCheckOut,
              status: d.status,
              dayType,
              workedMinutes: d.workedMinutes,
              otMinutes,
              remarks: 'Corrected',
              checkInMethod: null,
              checkInLat: null,
              checkInLng: null,
              checkInClockingLocationId: null,
              checkInDistanceM: null,
              checkInGeofenceStatus: null,
              checkInRadiusM: null,
              checkOutMethod: null,
              checkOutLat: null,
              checkOutLng: null,
              checkOutClockingLocationId: null,
              checkOutDistanceM: null,
              checkOutGeofenceStatus: null,
              checkOutRadiusM: null,
            },
          })
          .returning({ id: attendance.id });
        amendedId = amended.id;
        eventPayload = {
          correctionId: cor.id,
          date: cor.attendanceDate,
          checkIn: cor.proposedCheckIn,
          checkOut: cor.proposedCheckOut,
          status: d.status,
          dayType,
          workedMinutes: d.workedMinutes,
          otMinutes,
        };
      } else {
        // OT-only request: there MUST already be an attendance row (you cannot bank OT against a day with no
        // recorded work). We update ONLY that row's otMinutes to the approved figure — punches are left intact
        // (we do NOT null them, unlike a clock correction).
        const [existing] = await tx
          .select({ id: attendance.id })
          .from(attendance)
          .where(
            and(
              eq(attendance.employmentId, cor.employmentId),
              eq(attendance.attendanceDate, cor.attendanceDate),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new Error('No attendance record exists for this date to attach overtime to.');
        }
        await tx
          .update(attendance)
          .set({ otMinutes: approvedOtMinutes })
          .where(eq(attendance.id, existing.id));
        amendedId = existing.id;
        eventPayload = {
          correctionId: cor.id,
          date: cor.attendanceDate,
          dayType,
          otMinutes: approvedOtMinutes,
        };
      }

      // Stamp the OT-approval audit fields onto the correction row (requested + approved + method).
      if (hasOtRequest) {
        await tx
          .update(attendanceCorrection)
          .set({ approvedOtMinutes, otApprovalMethod })
          .where(eq(attendanceCorrection.id, cor.id));
        eventPayload = {
          ...eventPayload,
          requestedOtMinutes: cor.requestedOtMinutes,
          systemCalculatedOtMinutes: systemOtForComparison,
          approvedOtMinutes,
          otApprovalMethod,
        };
      }

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'attendance',
        aggregateId: amendedId,
        eventType: 'attendance.amended',
        actor: actorOf(ctx),
        subjectEmploymentId: cor.employmentId,
        payload: eventPayload,
      });

      // RL Control Engine (0113): auto-create the replacement-leave credit when this is the only reviewed
      // attendance-decision path. The approver above already passed assertCanDecide, so the auto-accrual runs
      // with requireDecideAuth:false (re-checking would hard-throw). It self-gates on dayType ∈ {rest_day,
      // holiday}, otMinutes>0, TOIL_ENABLED, and the company's enabled + autoAccrueOnApproval policy; eligibility
      // refusals are swallowed so auto-accrual NEVER blocks an approval. Skipped silently otherwise. Per ADR-0069
      // it reads the POLICY-ADJUSTED attendance.otMinutes written above (single source of truth).
      await maybeAutoAccrueOnApprovalTx(tx, ctx, {
        employmentId: cor.employmentId,
        workedDate: cor.attendanceDate,
        dayType,
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
        employeeCode: employment.employeeCode,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        approvedOtMinutes: attendanceCorrection.approvedOtMinutes,
        otApprovalMethod: attendanceCorrection.otApprovalMethod,
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
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
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
  // Feedback 31474452: weekdays marked as a Half working day (e.g. Saturday 9am-12pm). Disjoint from
  // workingDays. Always ints 1..7; empty = no half-day schedule (today's behaviour).
  halfWorkingDays: number[];
  // ADR-0069: how an approved overtime request's minutes are resolved (requested | system_calculated | smaller_of).
  otApprovalCalculation: OtApprovalMethod;
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
        halfWorkingDays: attendancePolicy.halfWorkingDays,
        otApprovalCalculation: attendancePolicy.otApprovalCalculation,
      })
      .from(attendancePolicy)
      .where(inArray(attendancePolicy.companyId, companyIds));
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    return companyIds.map((companyId) => {
      const r = byCompany.get(companyId);
      return r
        ? { ...r, otApprovalCalculation: r.otApprovalCalculation as OtApprovalMethod, isDefault: false }
        : {
            companyId,
            workStart: DEFAULTS.workStart,
            workEnd: DEFAULTS.workEnd,
            breakMinutes: DEFAULTS.breakMinutes,
            lateAfter: DEFAULTS.lateAfter,
            halfDayBefore: DEFAULTS.halfDayBefore,
            workingDays: DEFAULTS.workingDays,
            halfWorkingDays: DEFAULTS.halfWorkingDays,
            otApprovalCalculation: 'system_calculated' as OtApprovalMethod,
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
    // Feedback 31474452: weekdays marked Half (disjoint from workingDays). Optional — absent/undefined ⇒ [].
    halfWorkingDays?: number[];
    // ADR-0069: how an approved overtime request's minutes are resolved. Optional — absent ⇒ preserved on an
    // existing row / defaulted to system_calculated on a fresh row.
    otApprovalCalculation?: OtApprovalMethod;
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
  const halfWorkingDays = [...new Set(p.halfWorkingDays ?? [])]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort();
  // Union non-empty guard (0142): a schedule that is ALL half days is valid (Half implies working for
  // attendance — D2) — only a schedule with NO working days at all (Full ∪ Half both empty) is rejected.
  if (workingDays.length === 0 && halfWorkingDays.length === 0) {
    throw new Error('Select at least one working day.');
  }
  const overlap = workingDays.filter((d) => halfWorkingDays.includes(d));
  if (overlap.length > 0) {
    throw new Error('A day cannot be both a Full working day and a Half working day.');
  }
  // ADR-0069: validate the OT-approval calculation option (when provided) against the 3-value enum.
  const OT_METHODS: OtApprovalMethod[] = ['requested', 'system_calculated', 'smaller_of'];
  if (p.otApprovalCalculation != null && !OT_METHODS.includes(p.otApprovalCalculation)) {
    throw new Error('Invalid overtime approval calculation option.');
  }
  const otApprovalCalculation: OtApprovalMethod = p.otApprovalCalculation ?? 'system_calculated';

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
        halfWorkingDays,
        otApprovalCalculation,
      })
      .onConflictDoUpdate({
        target: attendancePolicy.companyId,
        set: { workStart, workEnd, breakMinutes, lateAfter, halfDayBefore, workingDays, halfWorkingDays, otApprovalCalculation },
      })
      .returning({ id: attendancePolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-policy',
      aggregateId: row.id,
      eventType: 'attendance-policy.updated',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        workStart,
        workEnd,
        breakMinutes,
        lateAfter,
        halfDayBefore,
        workingDays,
        halfWorkingDays,
        otApprovalCalculation,
      },
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
        // ADR-0070: geofencing does not apply to terminal punches (physical presence at the device is its
        // own proof — a disclosed bypass). Every punch this import writes/overwrites gets method='import'
        // and its geo-capture columns nulled, so an import can never leave a stale geofence attestation
        // sitting next to punch times it didn't actually validate (both check-in AND check-out columns are
        // nulled on every write here, since this importer always determines both punches for the day).
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
            checkInMethod: 'import',
            checkInLat: null,
            checkInLng: null,
            checkInClockingLocationId: null,
            checkInDistanceM: null,
            checkInGeofenceStatus: null,
            checkInRadiusM: null,
            checkOutMethod: checkOut ? 'import' : null,
            checkOutLat: null,
            checkOutLng: null,
            checkOutClockingLocationId: null,
            checkOutDistanceM: null,
            checkOutGeofenceStatus: null,
            checkOutRadiusM: null,
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
              checkInMethod: 'import',
              checkInLat: null,
              checkInLng: null,
              checkInClockingLocationId: null,
              checkInDistanceM: null,
              checkInGeofenceStatus: null,
              checkInRadiusM: null,
              checkOutMethod: checkOut ? 'import' : null,
              checkOutLat: null,
              checkOutLng: null,
              checkOutClockingLocationId: null,
              checkOutDistanceM: null,
              checkOutGeofenceStatus: null,
              checkOutRadiusM: null,
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
