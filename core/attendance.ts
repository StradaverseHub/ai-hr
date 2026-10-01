/**
 * Attendance — generic, jurisdiction-neutral time engine (ADR-0011).
 *
 * One row per employee per day. Check-in classifies the day (workday / rest day /
 * holiday, frozen on the row); check-out derives worked + overtime minutes from the
 * company work schedule. Absence is implicit (no row) and contextualized at read time
 * (approved leave / holiday / rest day are not "absent"). Each mutation appends a
 * domain event (ADR-0006).
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
// f618065d (r362) — the "All" ceiling the shared pager already assumes. Self Overtime is a server-paged
// list now, so its read and lib/pagination must agree about how many rows "All" can be: a read that
// stopped at 200 under a pager whose PageState says a 250-row list is complete is a silent partial list.
// core/read.ts takes the same import for the same reason.
import { ALL_ROW_CEILING } from '../lib/pagination';
import { type SessionContext, type Tx } from '../db/client';
// ADR-0077 D3 SERVICE GATE (r292). `withTenant` here is `withAttendanceTenant` — every exported entry
// point refuses a tenant without the Attendance module. The pure day-math helpers this file exports to
// the kernel (`isoWeekday`, `shiftSpan`, `netScheduledMinutes`, `shiftDayKindFor`, `isWorkingDayKind` —
// read by core/leave.ts, core/roster.ts and core/absence-days.ts) open no transaction and stay ungated,
// which is what keeps Leave and the roster working for a tenant without Attendance. See
// core/module-gate.ts.
import { withAttendanceTenant as withTenant } from './module-gate';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide, filterDelegationOrgScopeTx } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { enforceDeviceGateTx } from './attendance-device';
import { applyOtRuleRows, resolveRuleTx, type ResolvedAttendanceRule } from './attendance-rule';
// 07ebd04d (r331) — the ONE resolver for "whose working week is this, the group's or the shift's".
// A leaf module with no imports, so the rule service can enforce the write-side half of the same
// rule without a cycle through this file. Re-exported below for every caller that had it from here.
import { weekDayKindFor, weekPatternFor, type WeekDayKind, type WeekPattern } from './week-pattern';
import { ATTENDANCE_TRACE_VERSION, type AttendanceTraceV1, type TraceOtWindow } from './attendance-trace';
// 7c834696 stage 1 — the pure per-day arithmetic lives in its own module so the release gate ("no bands,
// deductions off ⇒ every figure byte-identical") can be asserted on the functions directly, without
// fixtures. The two measurement helpers are aliased because `earlyOutMinutes` is also a local variable name
// in deriveAttendance and the OT-side `earlyOtMinutes` (pre-shift overtime) is a different thing entirely.
import {
  deductionMinutes,
  deductionsApplyOn,
  earlyOutMinutes as earlyOutOf,
  latenessMinutes as latenessOf,
  splitOtMinutes,
  type OtSplit,
} from './attendance-calc';
// e2632276 — absence days are counted in ONE place now (see core/absence-days.ts), because the same count
// is what payroll deducts. attendanceMonthSummary reads it rather than restating the rule — but under the
// LEGACY rules (byte-identical to what this file used to compute inline) for every employment whose
// payroll policy has not switched `leave.deductAbsentDays` on. See the note above the call site.
import {
  absenceBreakdownByEmployment,
  deductAbsentDaysByEmployment,
  type AbsenceBreakdown,
} from './absence-days';
import { holidayDatesByEmployment, holidayDatesFor } from './holidays';
import { approvedLeaveDates } from './leave';
// cf21e554 stage 2 — the shift's own clock-time overtime windows. Pure, DB-free arithmetic in its own
// module (see its header): this file reads the rows and hands them over, it does not restate the rule.
import { otMinutesFromWindows, type ShiftOtWindowSpec } from './shift-ot-window';
// 18504ca6 — the dated shift-arrangement ladder. A deliberate LEAF module (no core/ imports of its own), so
// this import cannot close a cycle with core/roster.ts. Every "which shift" answer in this file goes through
// it: pickArrangementOn resolves the period in force on a DATE, and `undefined` means the employment has no
// ladder row at all, which is the signal to fall back to employment.default_shift_id exactly as before.
import {
  arrangementsForEmploymentTx,
  liveArrangementsTx,
  pickArrangementOn,
} from './shift-arrangement-resolve';
import { extendedMinutesAfterShiftEnd, maybeAutoAccrueOnApprovalTx } from './toil';
// r336 cbfa8b0b — the ONE double-claim predicate, shared with core/replacement-request.ts. See that file's
// header for why a second copy of the rule here would have been the defect rather than the fix.
import { assertNoCreditClaimForDatesTx } from './credit-ot-overlap';
import {
  assignment,
  attendance,
  attendanceCorrection,
  // 2166ef79 My Attendance stage one (migration 0434) — the optional supporting file on a request.
  attendanceCorrectionAttachment,
  attendancePolicy,
  // 07ebd04d (migration 0483) — the Schedule Group carries the WORKING WEEK; see weekLookupTx below.
  attendanceRule,
  attendancePunch,
  clockingLocation,
  employeeClockingLocation,
  employeeStatutoryMy,
  employment,
  leaveRequest,
  person,
  rosterAssignment,
  shift,
  shiftOtWindow,
  type BreakPeriod,
  // 1e9145d4 Plan OT — the five reason categories the Apply OT Plan form offers, declared beside the column
  // they constrain (text + DB CHECK, not a pgEnum — see the note there).
  type OtReasonCategory,
  // 2166ef79 — which of My Attendance's four sections a request was filed from (same text + CHECK shape).
  type AttendanceRequestKind,
  type ShiftOtRule,
} from '../db/schema';
import { parseAttendanceCsv } from '../lib/attendance-csv';

import { todayInKualaLumpur } from '../lib/hr-date';

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
      /**
       * The allowed distance the NEAREST site was judged against — the number the refusal message quotes
       * beside the measured distance. 1fff489c widened this from `number` to `number | null` for exactly
       * one case: zero assigned sites, where there is no nearest site and therefore no radius to name. It
       * travels with distanceM: both are null together, and the message only quotes either when they are
       * not (app/attendance/clock/actions.ts localizeClockError).
       */
      radiusM: number | null;
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
 * coordinates only. When ON: loads the employment's active assigned sites and either returns the passing
 * match or THROWS OutsideGeofenceError (zero sites or outside every radius — fail-closed). Missing
 * coordinates while enforced THROWS GeolocationRequiredError before any query.
 *
 * ── 1fff489c: PER-SITE RADII. THIS IS A BEHAVIOUR CHANGE, NOT A COLUMN MOVE. ──────────────────────────
 *
 * This function used to pick the NEAREST site and compare it against the ONE radius stored on the
 * employment. With a radius on each site that is wrong, because the nearest site is no longer necessarily
 * the deciding one:
 *
 *     site A — 300 m away, radius 100 m  → fails
 *     site B — 400 m away, radius 500 m  → PASSES
 *
 * The old logic would have picked A (nearest), compared 300 m against the employee radius, and refused a
 * punch that site B plainly authorises. The rule is therefore now "pass if ANY assigned active site has
 * distance ≤ its effective radius", and the nearest is computed ONLY to populate the refusal payload —
 * "you are 850 m from the nearest approved site" is still the most useful thing to tell somebody who has
 * been refused, even though nearness no longer decides anything.
 *
 * EFFECTIVE RADIUS = employment.geofence_radius_m when set (an optional per-EMPLOYEE override that
 * replaces every site's own figure for this person), otherwise the site's own radius_m. A site with
 * NEITHER cannot be matched — it has no allowed distance, so there is no distance it can be inside of, and
 * fail-closed is the only safe reading. Every production site has a radius (the admin form requires one);
 * this only bites a row written before migration 0419, of which there are none.
 *
 * The MATCH is the closest PASSING site, not merely the first one found — with two gates in range the row
 * should record the one the employee actually stood at.
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
  // The per-employee OVERRIDE. Null is now valid and normal (migration 0419 dropped the CHECK that used to
  // force a value here) and means "each site uses its own radius".
  const overrideRadiusM = emp?.geofenceRadiusM ?? null;

  const sites = await tx
    .select({
      id: clockingLocation.id,
      lat: clockingLocation.lat,
      lng: clockingLocation.lng,
      radiusM: clockingLocation.radiusM,
    })
    .from(employeeClockingLocation)
    .innerJoin(clockingLocation, eq(clockingLocation.id, employeeClockingLocation.clockingLocationId))
    .where(and(eq(employeeClockingLocation.employmentId, p.employmentId), isNull(clockingLocation.archivedAt)));

  /** The nearest site of ALL of them — for the refusal payload only. */
  let nearest: { id: string; distanceM: number; radiusM: number | null } | null = null;
  /** The nearest site that actually PASSES its own effective radius — the decision. */
  let match: { id: string; distanceM: number; radiusM: number } | null = null;

  for (const s of sites) {
    const distanceM = haversineMetres(p.lat, p.lng, s.lat, s.lng);
    const effectiveRadiusM = overrideRadiusM ?? s.radiusM;
    if (!nearest || distanceM < nearest.distanceM) {
      nearest = { id: s.id, distanceM, radiusM: effectiveRadiusM };
    }
    if (effectiveRadiusM == null || distanceM > effectiveRadiusM) continue;
    if (!match || distanceM < match.distanceM) {
      match = { id: s.id, distanceM, radiusM: effectiveRadiusM };
    }
  }

  if (!match) {
    throw new OutsideGeofenceError({
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.lat,
      lng: p.lng,
      nearestLocationId: nearest?.id ?? null,
      distanceM: nearest ? Math.round(nearest.distanceM) : null,
      radiusM: nearest?.radiusM ?? null,
      punch: p.punch,
    });
  }
  return {
    enforced: true,
    lat: p.lat,
    lng: p.lng,
    clockingLocationId: match.id,
    distanceM: Math.round(match.distanceM),
    radiusM: match.radiusM,
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
 * DEFAULTS where none exists yet. This is the schedule for a day with NO shift — a shift cannot supply hours
 * for a day it was never assigned to — which is why 6da67ab7 left it company-scoped while moving the
 * CALCULATION rules tenant-wide. Holiday resolution no longer lives here — it is delegated to the unified
 * resolver `holidayDatesFor` (ADR-0055), so attendance classifies the same calendar leave does and the
 * country/state inputs that used to be carried on the Policy are gone.
 */
async function policyFor(tx: Tx, employmentId: string): Promise<Policy> {
  const [row] = await tx
    .select({
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

/**
 * Net scheduled minutes of a shift: span − break, then the shift's own Normal-Hours Rounding.
 * The SHARED auto normal-hours figure (R7 Phase 1) — the shift form's auto readout and the engine's
 * scheduledMinutes are this one expression, never persisted.
 *
 * cf21e554 stage 1 — `roundingMinutes` is the reference General tab's "Normal Hours Rounding" box
 * (shift.normal_hours_rounding_minutes). It rounds the net figure DOWN to a multiple of itself:
 *   • DOWN, not nearest: this figure is a SCHEDULE, and the honest reading of "round my normal hours to the
 *     quarter hour" on a 7h50m shift is 7h45m of normal time, not 8h the employee was never scheduled for.
 *     (7c834696 rev 3: the OT band rounding in core/attendance-rule.ts now rounds DOWN too, for the parallel
 *     reason — nearest could return more overtime than the employee was at work for, and did, on two real
 *     days. The two roundings are now the same direction and stay separate settings.)
 *   • The parameter is OPTIONAL and null/0/absent is a strict no-op, so every one of the caller sites that
 *     does not pass it — and every shift whose column is NULL, which is all 11 rows on production — returns
 *     byte-identically to before.
 */
export const netScheduledMinutes = (
  start: string,
  end: string,
  crosses: boolean,
  breakMinutes: number,
  roundingMinutes?: number | null,
): number => {
  const net = Math.max(0, shiftSpan(start, end, crosses) - breakMinutes);
  const unit = Math.trunc(roundingMinutes ?? 0);
  if (!Number.isFinite(unit) || unit <= 0) return net;
  return Math.floor(net / unit) * unit;
};

// b7b886e2 — the punch placed on the SHIFT's own timeline, in minutes from midnight of the attendance date,
// so a cross-midnight shift's end (and its after-midnight breaks) sit past 1440 and can be compared with
// plain arithmetic. This is what lets the engine ask WHERE a minute fell — before the shift, inside it, or
// past its end — instead of only how many minutes there were in total.
type PunchWindow = { inAbs: number; outAbs: number; startAbs: number; endAbs: number };

/** Place a time-of-day on the shift's timeline. A punch more than 12h BEFORE the shift start belongs to the
 *  next calendar day: on a 22:00→06:00 shift a 00:30 arrival is 2.5h LATE, not 21.5h early. Anything inside
 *  12h is read as an early arrival, which keeps a 21:30 punch on that same shift a 30-minute early start.
 *
 *  b8aa3466 — THE DAILY CUT-OFF replaces that 12-hour guess when the shift sets one. The 12h rule is a
 *  boundary nobody can see or change; a cut-off makes it the operator's own clock time. With a cut-off of
 *  02:00, a punch before 02:00 belongs to the shift-day that opened on the previous calendar day and a punch
 *  after it belongs to the new one — which is what "any clocking after this time counts towards the next
 *  day" means on the form.
 *
 *  `cutoffAbs` NULL (every shift today, and every shift that leaves the box off) ⇒ the original expression,
 *  byte for byte. */
const anchorToShift = (minutes: number, shiftStartAbs: number, cutoffAbs?: number | null): number => {
  if (cutoffAbs != null) return minutes < cutoffAbs ? minutes + MINS_PER_DAY : minutes;
  return minutes < shiftStartAbs - MINS_PER_DAY / 2 ? minutes + MINS_PER_DAY : minutes;
};

/** b8aa3466 — the four-way weekly row, resolved for one ISO weekday.
 *
 *  Full = in weekly_pattern · Half = in half_pattern · Off = in off_pattern · Rest = in none of them.
 *
 *  Rest stays the COMPLEMENT, which is what "not ticked" has always meant, so a shift written before
 *  migration 0429 — and any caller that passes only `pattern` — resolves exactly as it does today. The
 *  three arrays are pairwise disjoint (validated in core/roster.ts AND by the 0429 CHECK), so the order of
 *  these tests cannot change an answer. */
export type ShiftDayKind = WeekDayKind;
/** aec53564 (r331) — the four tests moved into core/week-pattern.ts `weekDayKindFor` and this is now the
 *  date→weekday step in front of them. `isoWeekday` is the only reason this function stays in this file
 *  (the pack drift ratchets quote it by name as living here); the pattern lookup itself never needed a
 *  date, and the Shift form's day row — a client island, which cannot import this module at all — needs
 *  it without one. Two copies of a four-way lookup is how the Full∪Half set union came to be written
 *  twice before 07ebd04d removed both. */
export const shiftDayKindFor = (
  sh: { pattern: number[] | null; halfPattern?: number[] | null; offPattern?: number[] | null },
  date: string,
): ShiftDayKind => weekDayKindFor(sh, isoWeekday(date));
/** Half and Full are both WORKING days; Rest and Off are not. */
export const isWorkingDayKind = (k: ShiftDayKind): boolean => k === 'full' || k === 'half';

/** 07ebd04d (r331) — `WeekPattern`, `weekPatternWorkingDayCount` and `weekPatternFor` now live in the
 *  leaf module core/week-pattern.ts and are RE-EXPORTED here unchanged, so every existing importer
 *  (core/roster.ts, core/shift-arrangement.ts through the pack facade, the tests, the split report)
 *  keeps the same specifier. They moved because core/attendance-rule.ts — the service that creates a
 *  Schedule Group — must now enforce the write-side half of the same rule, and this file already
 *  imports that one. See core/week-pattern.ts for the reasoning that used to sit here. */
export { weekPatternFor, weekPatternWorkingDayCount, type WeekPattern } from './week-pattern';

/** Minutes of the punch that fell inside the shift's declared UNPAID break WINDOWS. Null when the shift
 *  carries no windows — a break scalar alone gives nothing to test the clocking against, so those shifts
 *  keep workedFromSpan's 6h cliff (byte-identical). Capped at the canonical breakMinutes so a drifted row
 *  (Σ windows ≠ break_minutes — see core/shift-break-display.ts) can never deduct more than the figure the
 *  rest of the system reports as the shift's break.
 *
 *  cf21e554 — the filter and the cap MUST range over the same set. `breakMinutes` is Σ of the UNPAID
 *  windows (core/roster.ts normalizeShiftInput), so summing the overlap across ALL windows counted a PAID
 *  window's overlap as unpaid deduction, up to the unpaid total. Reproduced: 09:00–18:00 with a paid
 *  10:30–10:45 tea break and an unpaid 13:00–14:00 lunch ⇒ break_minutes 60; a 09:00→12:00 clocking spans
 *  only the PAID window, and min(15, 60) took 15 minutes off a day that owed nothing. The full-day case
 *  hid it because the cap happened to equal the unpaid total. */
const spannedBreakMinutes = (
  periods: BreakPeriod[] | null,
  breakMinutes: number,
  w: PunchWindow,
  cutoffAbs?: number | null,
): number | null => {
  if (!periods || periods.length === 0) return null;
  const overlap = periods
    .filter((bp) => bp.paid !== true)
    .reduce((acc, bp) => {
      // b8aa3466 — the SAME placement rule the punch used. If the punch and the break windows were anchored
      // by different rules they would sit on different timelines and the overlap arithmetic below would be
      // comparing minutes that never met.
      const bs = anchorToShift(toMinutes(bp.start), w.startAbs, cutoffAbs);
      const be = anchorToShift(toMinutes(bp.end), w.startAbs, cutoffAbs);
      return acc + Math.max(0, Math.min(w.outAbs, be) - Math.max(w.inAbs, bs));
    }, 0);
  return Math.min(overlap, breakMinutes);
};

/** r277 (439565ff) — THE PER-ROW FLEXIBLE ALLOWANCE: what comes off a day when the shift's break rows
 *  carry their OWN allowances instead of one number for the whole shift ("a sixty-minute lunch and a
 *  fifteen-minute tea break can finally have different allowances").
 *
 *  NULL unless at least one UNPAID window is `flexible` AND carries a `flexibleMinutes`. That null is the
 *  whole safety property: a shift with no per-row figure never reaches this branch, so the shift-level
 *  allowance, the spanned-window deduction and workedFromSpan's 6-hour cliff keep their exact order and
 *  their exact answers — which is every shift that exists today, MB28 included.
 *
 *  When it DOES apply, the shift's deduction is read row by row, because that is the only reading under
 *  which two rows can mean two different things:
 *    • a FLEXIBLE row with an allowance contributes its allowance, whether or not the clocking covered the
 *      window — an allowance is a permission to be away for N minutes, not a window to be tested against.
 *      This is the same meaning the shift-level allowance already has, applied one row down.
 *    • every OTHER unpaid row contributes exactly what it contributes today: the minutes of the clocking
 *      that fell inside its window. `flexibleMinutes` ABSENT MEANS TODAY'S BEHAVIOUR, NEVER ZERO — a row
 *      the operator did not touch must not start deducting nothing because a sibling row was edited.
 *    • a PAID row contributes nothing, as it does today: the employer pays for that time either way.
 *
 *  Capped at the canonical `breakMinutes` for the same reason spannedBreakMinutes is (a drifted row can
 *  never deduct more than the figure the rest of the system reports as this shift's break) and at the
 *  day's own span for the same reason the shift-level allowance is (a short day cannot go negative).
 *  core/roster.ts writes break_minutes as Σ of exactly these per-row contributions for a full day, so the
 *  cap is a no-op on a correctly-saved shift and scheduled hours agree with what comes off. */
const perRowBreakMinutes = (
  periods: BreakPeriod[] | null,
  breakMinutes: number,
  w: PunchWindow,
  cutoffAbs: number | null | undefined,
  span: number,
): number | null => {
  if (!periods || periods.length === 0) return null;
  const unpaid = periods.filter((bp) => bp.paid !== true);
  if (!unpaid.some((bp) => bp.flexible === true && bp.flexibleMinutes != null)) return null;
  const total = unpaid.reduce((acc, bp) => {
    if (bp.flexible === true && bp.flexibleMinutes != null) return acc + Math.max(0, Math.trunc(bp.flexibleMinutes));
    // The SAME placement rule the punch used (b8aa3466), for the same reason as in spannedBreakMinutes.
    const bs = anchorToShift(toMinutes(bp.start), w.startAbs, cutoffAbs);
    const be = anchorToShift(toMinutes(bp.end), w.startAbs, cutoffAbs);
    return acc + Math.max(0, Math.min(w.outAbs, be) - Math.max(w.inAbs, bs));
  }, 0);
  return Math.min(total, breakMinutes, span);
};

// ADR-0032 Phase C: the schedule the engine derives against for one (employee, date) — resolved from the
// employee's roster when present, else the company policy (today's behaviour, byte-identical).
type ResolvedSchedule = {
  /** Display-only identity of the shift selected by this exact date resolver. */
  displayShiftCode?: string | null;
  displayShiftName?: string | null;
  dayType: DayType;
  lateAfter: string; // time-of-day after which check-in is "late" (shift start + policy grace, or policy)
  halfDayBefore: string; // checkout before this on a workday ⇒ half-day (policy / shift midpoint)
  scheduledMinutes: number; // net scheduled work minutes (workday OT = worked − this, unless overridden)
  breakMinutes: number;
  // b7b886e2 — the resolved SHIFT's own time-in / time-out and break windows. Set only on the shift
  // branches; NULL on the company-policy branch, which has no assigned shift and therefore keeps the legacy
  // duration-based OT + 6h-cliff break exactly as before. When present, deriveAttendance measures workday OT
  // against shiftEnd and deducts only the break minutes the clocking actually spanned.
  shiftStart: string | null;
  shiftEnd: string | null;
  breakPeriods: BreakPeriod[] | null;
  // b8aa3466 — the resolved shift's DAILY CUT-OFF as minutes from midnight, or NULL when the shift leaves
  // it off (every shift today). NULL ⇒ anchorToShift keeps its hard-coded 12-hour rule byte-identically.
  dailyCutoffMinutes: number | null;
  // 6340aecb — the resolved shift's FLEXIBLE BREAK allowance in minutes, or NULL when the shift leaves the
  // switch off (every shift stored before migration 0457) and on the company-policy branch, which has no
  // shift to carry one. NULL ⇒ the break deduction below is byte-identical to today.
  flexibleBreakMinutes: number | null;
  // R7 Multi-Shift Phase 1: the shift's manual normal-hours override. When set it is the shift's normal
  // working minutes — the workday OT threshold in deriveAttendance — instead of scheduledMinutes. Only a
  // rostered shift can carry one; the policy branch is always null (byte-identical legacy behaviour).
  normalMinutesOverride: number | null;
  /**
   * r274 (439565ff) — FULL FLEXI: the day is judged on HOURS WORKED, not on the clock.
   *
   * TRUE only where the resolved shift's type is `full_flexi`. It suppresses every fixed-clock judgement
   * — lateness, early-out and the half-day cut-off's grace fallback — because a shift with no required
   * start has no time to be late for. It does NOT change how minutes are counted: the duration OT basis
   * it forces is the same one `normal_minutes_override` already selects and Semi Flexi already runs on.
   *
   * `shiftStart` / `shiftEnd` stay populated and stay meaningful: on this type they are the earliest and
   * latest clocking accepted, and thirteen readers depend on them existing (payableHoursForCycle clamps
   * payable hours to them, absence-days treats a row with neither as unscheduled, the OT window grid
   * anchors to the start, and the roster and clock screens print them).
   *
   * FALSE on the company-policy branch, which has no shift at all.
   */
  flexiDuration: boolean;
  // R17 3e8350db — the resolved shift's per-shift OT rule (eligibility / minimum block / daily cap). Shapes
  // WORKDAY OT accrual only (deriveAttendance); statutory rest/holiday premium is untouched. Null on the
  // policy branch and whenever the shift carries no rule ⇒ byte-identical legacy OT.
  otRule: ShiftOtRule | null;
  // cf21e554 stage 2 — the resolved shift's own Overtime Schedule (shift_ot_window), in grid order. NULL on
  // the policy branch and on any shift with no windows ⇒ workday OT keeps being "time past the shift end",
  // byte-identical. When present these windows decide WHICH minutes count; rounding and pay stay with the
  // attendance rule and the statutory cap.
  otWindows: ShiftOtWindowSpec[] | null;
  // 88e94371 — the resolved attendance rule ("Lateness, Early Out & Overtime Settings"): the shift's rule_id
  // when set, else the tenant's Standard rule (6da67ab7 — the library is no longer company-scoped), else null
  // (⇒ legacy behaviour). Its OT rows drive OT-minute rounding + early-OT inclusion in deriveAttendance; its
  // grace periods feed the late/early thresholds below (as a fallback UNDER any explicit per-shift grace, so
  // existing shifts stay identical).
  rule: ResolvedAttendanceRule | null;
  // 7c834696 stage 1 — the schedule's OWN start/end and the EFFECTIVE grace minutes, resolved on EVERY
  // branch including the company-policy one (which has no shift but does have work_start / work_end).
  // Lateness and early-out are measured against these, so an employee on the policy branch and an employee
  // on a shift are measured the same way instead of one of them silently getting no figure at all.
  // `lateAfter` above stays the STATUS threshold and is unchanged; these are the MEASUREMENT inputs.
  scheduledStart: string | null;
  scheduledEnd: string | null;
  lateGraceMinutes: number;
  earlyGraceMinutes: number;
  crossesMidnight: boolean;
  // ec4cbf63: 'default-shift' / 'default-shift-rest' = resolved from employment.default_shift_id (no roster
  // row for the date). Diagnostic only — nothing downstream branches on source for pay except the hourly
  // clamp (payableHoursForCycle), which resolves roster/default-shift itself.
  source: 'policy' | 'roster-shift' | 'roster-rest' | 'default-shift' | 'default-shift-rest';
};

/**
 * b8aa3466 item 8 — THE HALF-DAY CUT-OFF, as one resolver both shift branches call, so they cannot drift.
 *
 * Normal (and every legacy shift): unchanged, in this exact precedence — the shift's own
 * half_day_first_out, else the early-out grace subtracted from the shift end, else the shift midpoint.
 * Nothing already saved moves.
 *
 * Semi Flexi with no explicit value: DERIVED as half the shift's required normal minutes of WORK, breaks
 * not counted, measured from the earliest time in — which is what the form shows the operator and what the
 * plan promises. It is converted to a CLOCK TIME here so deriveAttendance keeps comparing times; adding a
 * duration branch to that comparison is exactly the change this deliberately avoids.
 */
function halfDayCutoff(p: {
  type: string | null;
  explicit: string | null;
  start: string;
  end: string;
  crosses: boolean;
  normalMinutes: number;
  earlyGrace: number | null;
}): string {
  if (p.explicit != null) return p.explicit;
  // r274 (439565ff) — full flexi joins semi flexi here. Both are judged on required hours, so half a day
  // is half those hours from whenever they started, never a wall-clock time.
  if ((p.type === 'semi_flexi' || p.type === 'full_flexi') && p.normalMinutes > 0) {
    return fmtTime((toMinutes(p.start) + Math.floor(p.normalMinutes / 2)) % MINS_PER_DAY);
  }
  if (p.earlyGrace != null) return subGrace(p.end, p.earlyGrace);
  return fmtTime((toMinutes(p.start) + Math.floor(shiftSpan(p.start, p.end, p.crosses) / 2)) % MINS_PER_DAY);
}

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
  // 88e94371 — the Standard ("Lateness, Early Out & Overtime Settings") rule. Used by the policy/rest branches
  // AND as the fallback when a resolved shift carries no explicit rule_id. Null when the tenant has no rule
  // yet ⇒ byte-identical legacy behaviour. 6da67ab7: one Standard per TENANT, not per company — the rule is
  // chosen by the shift, and shifts are tenant-wide, so the employee's company no longer selects it.
  const defaultRule = await resolveRuleTx(tx, { ruleId: null });
  /**
   * 870b79e2 (r277, migration 0464) — THE EMPLOYEE'S SCHEDULE GROUP, and the ONE line of this item that
   * touches the engine.
   *
   * `employment.attendance_rule_id` is the reporter's Employee → Group → Shift chain: a person can now
   * belong to a named attendance_rule directly, instead of only inheriting whichever rule their shift
   * happens to point at. Resolution is ADDITIVE and in this order:
   *
   *     employment.attendance_rule_id  →  shift.rule_id  →  the tenant's is_default ("Standard") rule
   *
   * WHY THE GROUP OUTRANKS THE SHIFT. The group is a statement about the PERSON ("this employee is judged
   * by these lateness and overtime rules"), the shift's rule_id is a default attached to a template many
   * people share. When an administrator has said both, the one they said about the individual is the one
   * they meant. It is also what makes the allowed-shift refusal coherent: every shift the group permits
   * carries that same rule_id anyway (core/roster.ts assertShiftAllowedForEmployment), so on any assignment
   * the system accepts, the two agree and the precedence is invisible.
   *
   * ⚠️ BYTE-IDENTICAL ON RELEASE DAY, AND THAT IS TESTED, NOT ASSERTED. The column ships NULL on every
   * employment with no backfill and no default, so `groupRule` is null for everybody and both expressions
   * below collapse to exactly what they evaluated to before this round.
   * test/attendance-rule-group-resolution.test.ts resolves rules for seeded employments across all three
   * branches (roster shift / default shift / company policy) and asserts no change.
   *
   * A null resolve is a SAFE fallback, never an error: the FK is ON DELETE SET NULL so a dangling id is
   * unrepresentable, and if RLS or a missing row ever made the rule unreadable, `resolveRuleTx` returns
   * null and the employee falls through to the pre-existing chain rather than losing their rules.
   */
  const [empRow] = await tx
    .select({ ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  const groupRule = empRow?.ruleId ? await resolveRuleTx(tx, { ruleId: empRow.ruleId }) : null;
  /** The rule for a branch with NO shift of its own (company policy, rest day): the group's, else Standard. */
  const baseRule = groupRule ?? defaultRule;
  // The effective late/early grace for a shift branch: an explicit per-shift grace wins (R17, unchanged); else
  // the rule's grace-period section; else the policy-derived grace / midpoint heuristic (null ⇒ legacy).
  const ruleFor = (ruleId: string | null): Promise<ResolvedAttendanceRule | null> =>
    groupRule ? Promise.resolve(groupRule) : ruleId ? resolveRuleTx(tx, { ruleId }) : Promise.resolve(defaultRule);
  // cf21e554 — the OT windows of one shift, in grid order, or null when it declares none (which is every
  // shift until someone opens the new tab). Null and [] are deliberately the same thing to the caller: no
  // windows ⇒ workday OT stays "time worked past the shift end", byte-identical.
  const otWindowsFor = async (shiftId: string | null): Promise<ShiftOtWindowSpec[] | null> => {
    if (!shiftId) return null;
    const rows = await tx
      .select({
        label: shiftOtWindow.label,
        startTime: shiftOtWindow.startTime,
        endTime: shiftOtWindow.endTime,
        endNextDay: shiftOtWindow.endNextDay,
        minMinutes: shiftOtWindow.minMinutes,
        maxMinutes: shiftOtWindow.maxMinutes,
        adjustAfterMinutes: shiftOtWindow.adjustAfterMinutes,
        adjustDeltaMinutes: shiftOtWindow.adjustDeltaMinutes,
      })
      .from(shiftOtWindow)
      .where(eq(shiftOtWindow.shiftId, shiftId))
      .orderBy(shiftOtWindow.sortOrder);
    return rows.length > 0 ? rows : null;
  };
  const [ra] = await tx
    .select({
      isRestDay: rosterAssignment.isRestDay,
      shiftId: shift.id,
      code: shift.code,
      name: shift.name,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      override: shift.normalMinutesOverride,
      periods: shift.breakPeriods,
      lateGrace: shift.lateGraceMinutes,
      earlyLeaveGrace: shift.earlyLeaveGraceMinutes,
      otRule: shift.otRule,
      ruleId: shift.ruleId,
      // cf21e554 stage 1 — the two General boxes that MOVE a figure (see db/schema.ts).
      rounding: shift.normalHoursRoundingMinutes,
      halfDayFirstOut: shift.halfDayFirstOut,
      // b8aa3466 — the daily cut-off (migration 0429).
      cutoffOn: shift.dailyCutoffEnabled,
      cutoffAt: shift.dailyCutoffTime,
      // 6340aecb — the flexible break (migration 0457).
      flexOn: shift.flexibleBreakEnabled,
      flexMin: shift.flexibleBreakMinutes,
      shiftType: shift.type,
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
    shiftStart: null,
    shiftEnd: null,
    breakPeriods: null,
    // The company-policy branch has no shift, so there is no cut-off to carry either: anchorToShift keeps
    // its 12-hour rule, exactly as it does today.
    dailyCutoffMinutes: null,
    // …and no shift means no flexible break either: the policy branch keeps the 6h-cliff deduction.
    flexibleBreakMinutes: null,
    normalMinutesOverride: null,
    // No shift on this branch, so nothing can be full flexi.
    flexiDuration: false,
    otRule: null,
    // The company-policy branch has no shift, so there is nothing to carry OT windows.
    otWindows: null,
    // 870b79e2 — the group's rule when the employee has one, else Standard. `baseRule` IS `defaultRule`
    // for every employment that has not been put in a group, which is all of them at release.
    rule: baseRule,
    // The policy branch's schedule IS work_start → work_end, and its late grace is the policy's own
    // (late_after − work_start) — the same figure `lateAfter` above is built from, so the measurement and
    // the status threshold cannot drift apart. No explicit early-out grace exists at policy level, so the
    // rule's supplies it (0 when there is no rule ⇒ early-out measured from the exact work end).
    scheduledStart: pol.workStart,
    scheduledEnd: pol.workEnd,
    lateGraceMinutes: grace,
    earlyGraceMinutes: baseRule?.earlyGracePeriodMinutes ?? 0,
    crossesMidnight: false,
    source: 'policy',
  });

  // A rostered shift defines the schedule even on a calendar holiday or weekend; the day TYPE still comes
  // from the calendar (holiday) so OT is classified at the right premium.
  if (ra && !ra.isRestDay && ra.start && ra.end) {
    const sched = netScheduledMinutes(ra.start, ra.end, ra.crosses!, ra.brk!, ra.rounding);
    const rule = await ruleFor(ra.ruleId);
    const otWindows = await otWindowsFor(ra.shiftId);
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
      // cf21e554 stage 1 — the shift's OWN half-day clock-out wins when it is set. It is the per-shift
      // replacement for attendance_policy.half_day_before, which is one value for the whole company; a
      // shift that leaves it blank keeps exactly the threshold it has today (grace-derived, else the shift
      // midpoint), so nothing already saved moves.
      halfDayBefore: halfDayCutoff({
        type: ra.shiftType,
        explicit: ra.halfDayFirstOut,
        start: ra.start,
        end: ra.end,
        crosses: ra.crosses!,
        normalMinutes: ra.override ?? sched,
        earlyGrace,
      }),
      scheduledMinutes: sched,
      breakMinutes: ra.brk!,
      shiftStart: ra.start,
      shiftEnd: ra.end,
      breakPeriods: ra.periods ?? null,
      dailyCutoffMinutes: ra.cutoffOn && ra.cutoffAt ? toMinutes(ra.cutoffAt) : null,
      flexibleBreakMinutes: ra.flexOn && ra.flexMin != null ? ra.flexMin : null,
      normalMinutesOverride: ra.override ?? null,
      flexiDuration: ra.shiftType === 'full_flexi',
      otRule: ra.otRule ?? null,
      otWindows,
      rule,
      scheduledStart: ra.start,
      scheduledEnd: ra.end,
      lateGraceMinutes: lateGrace,
      earlyGraceMinutes: earlyGrace ?? 0,
      crossesMidnight: ra.crosses!,
      source: 'roster-shift',
      displayShiftCode: ra.code,
      displayShiftName: ra.name,
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
  //
  // 18504ca6 — AND IT IS NOW ANSWERED BY DATE. "The employee's default shift" used to mean
  // employment.default_shift_id, one value with no date, so moving someone onto a new shift silently
  // re-measured every day that was ever re-derived — a correction, a re-import — against the shift they are
  // on TODAY. It now means the dated arrangement in force on `date` (employment_shift_arrangement, migration
  // 0421). A roster row still wins, exactly as before: this branch is only reached when there is none.
  // No ladder row at all ⇒ the employment.default_shift_id join below, byte-identical to before.
  const arrangement = pickArrangementOn(await arrangementsForEmploymentTx(tx, employmentId), date);
  const defaultShiftCols = {
    shiftId: shift.id,
    code: shift.code,
    name: shift.name,
    start: shift.startTime,
    end: shift.endTime,
    brk: shift.breakMinutes,
    crosses: shift.crossesMidnight,
    override: shift.normalMinutesOverride,
    periods: shift.breakPeriods,
    pattern: shift.weeklyPattern,
    lateGrace: shift.lateGraceMinutes,
    earlyLeaveGrace: shift.earlyLeaveGraceMinutes,
    otRule: shift.otRule,
    ruleId: shift.ruleId,
    rounding: shift.normalHoursRoundingMinutes,
    halfDayFirstOut: shift.halfDayFirstOut,
    // b8aa3466 — the four-way weekly row and the daily cut-off (migration 0429).
    halfPattern: shift.halfPattern,
    offPattern: shift.offPattern,
    cutoffOn: shift.dailyCutoffEnabled,
    cutoffAt: shift.dailyCutoffTime,
    // 6340aecb — the flexible break (migration 0457).
    flexOn: shift.flexibleBreakEnabled,
    flexMin: shift.flexibleBreakMinutes,
    shiftType: shift.type,
  };
  const [ds] = arrangement
    ? await tx.select(defaultShiftCols).from(shift).where(eq(shift.id, arrangement.shiftId)).limit(1)
    : await tx
        .select(defaultShiftCols)
        .from(employment)
        .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
        .where(eq(employment.id, employmentId))
        .limit(1);
  if (ds) {
    // 07ebd04d (r331, migration 0483) — THE WORKING WEEK IS THE SCHEDULE GROUP'S WHEN IT HAS ONE.
    //
    // The rule is resolved BEFORE the day-kind test now, because the group carries `weekly_pattern` /
    // `half_pattern` / `off_pattern` of its own since 0483 and it is the group — not the shift template
    // several people share — that states which days are worked. `ruleFor` is the SAME single-valued
    // chain the rest of this branch already used (the employee's group → the shift's group → the tenant
    // Standard rule), so there is no second notion of "this person's group" anywhere.
    //
    // ⚠️ BYTE-IDENTICAL THE DAY 0483 SHIPS, by construction: each group is created carrying exactly the
    // week its own shifts already have, and a group with no working day never wins (core/week-pattern.ts
    // weekPatternFor). The tenant's Standard rule keeps NULL patterns on purpose, so every shift that
    // resolves it — every shift with no rule_id — still reads its own week, unchanged.
    const rule = await ruleFor(ds.ruleId);
    // b8aa3466 — FOUR-WAY. Full and Half are both WORKING days of the default shift; Rest and Off are not.
    // A shift written before migration 0429 has empty half/off arrays, so this resolves Full-where-ticked
    // and Rest-otherwise — byte-identically to the two-way test it replaces.
    const kind = shiftDayKindFor(weekPatternFor(rule?.week, ds), date);
    if (isWorkingDayKind(kind)) {
      // Working day of the default shift — mirror the roster-shift branch byte-for-byte, incl. the
      // holiday day-type overlay (the default shift's hours still define the schedule on a holiday), the
      // R17 per-shift grace override, and the 88e94371 rule grace fallback.
      //
      // A HALF day is an ordinary working day with HALF the normal hours, so overtime starts after half a
      // day. Halving the threshold is the whole of it: the shift's clock times, breaks, grace, rule and OT
      // windows are unchanged, and a Full day halves nothing.
      const full = netScheduledMinutes(ds.start, ds.end, ds.crosses, ds.brk, ds.rounding);
      const sched = kind === 'half' ? Math.floor(full / 2) : full;
      // A HALF day ENDS halfway through the shift's clock span, and that end is what makes "overtime starts
      // after half a day" TRUE. Halving `sched` alone would not: on a resolved shift the engine measures
      // workday overtime as the minutes worked past the shift's TIME-OUT (the `window` branch in
      // deriveAttendance), not as the amount by which the day's total overshot its scheduled duration. So
      // the effective time-out has to halve with the hours, or a half day would accrue nothing until the
      // FULL day's end and the dropdown would be a label with no behaviour behind it.
      //
      // Half the clock span, half the net hours — one rule, stated once. A Full day halves nothing and is
      // byte-identical.
      const shiftEnd =
        kind === 'half' ? fmtTime((toMinutes(ds.start) + Math.floor(shiftSpan(ds.start, ds.end, ds.crosses) / 2)) % MINS_PER_DAY) : ds.end;
      // Halving the span can only bring the end back inside the same day, so a half day never crosses midnight.
      const crosses = kind === 'half' ? false : ds.crosses;
      // The manual normal-hours figure is halved with it — otherwise a Semi-Flexi shift's required 8h would
      // still be the threshold on a half day, and the half day would pay no overtime until hour 8.
      const override = ds.override == null ? null : kind === 'half' ? Math.floor(ds.override / 2) : ds.override;
      const otWindows = await otWindowsFor(ds.shiftId);
      const lateGrace = ds.lateGrace ?? rule?.lateGracePeriodMinutes ?? grace;
      const earlyGrace = ds.earlyLeaveGrace ?? (rule && rule.earlyGracePeriodMinutes > 0 ? rule.earlyGracePeriodMinutes : null);
      return {
        dayType: isHoliday ? 'holiday' : 'workday',
        lateAfter: addGrace(ds.start, lateGrace),
        // cf21e554 — same per-shift half-day override as the roster branch above; the two branches mirror
        // each other byte-for-byte on purpose.
        halfDayBefore: halfDayCutoff({
          type: ds.shiftType,
          explicit: ds.halfDayFirstOut,
          start: ds.start,
          end: shiftEnd,
          crosses,
          normalMinutes: override ?? sched,
          earlyGrace,
        }),
        scheduledMinutes: sched,
        breakMinutes: ds.brk,
        shiftStart: ds.start,
        shiftEnd,
        breakPeriods: ds.periods ?? null,
        dailyCutoffMinutes: ds.cutoffOn && ds.cutoffAt ? toMinutes(ds.cutoffAt) : null,
        // 6340aecb — the allowance is NOT halved on a Half day, and deliberately: it is a break the employee
        // takes, not a portion of the day's hours. `sched` above already halves the NET figure, and halving
        // the break too would deduct it twice over.
        flexibleBreakMinutes: ds.flexOn && ds.flexMin != null ? ds.flexMin : null,
        normalMinutesOverride: override,
        flexiDuration: ds.shiftType === 'full_flexi',
        otRule: ds.otRule ?? null,
        otWindows,
        rule,
        scheduledStart: ds.start,
        scheduledEnd: shiftEnd,
        lateGraceMinutes: lateGrace,
        earlyGraceMinutes: earlyGrace ?? 0,
        crossesMidnight: crosses,
        source: 'default-shift',
        displayShiftCode: ds.code,
        displayShiftName: ds.name,
      };
    }
    // The default shift's own rest day wins over the flat company working-days list (matching how a
    // rostered rest day wins) — but a calendar holiday still classifies at the holiday premium.
    if (isHoliday) return policyBranch('holiday');

    // b8aa3466 — an OFF DAY is not the statutory rest day, and it must not be paid like one. EA s.60A(3)(a)
    // says work on a non-rest, non-holiday day off is ordinary OVERTIME at 1.5x the hourly rate; s.60(3)
    // rest-day pay (half/full day ORP plus 2x on the excess) is a different and much larger number.
    //
    // The cheapest correct way to say "every minute is workday overtime" is a WORKDAY with a normal day of
    // ZERO minutes: deriveAttendance's threshold is `normalMinutesOverride ?? scheduledMinutes`, so worked
    // minus zero is the whole clocking, classified 'workday', which localization/my/payroll.ts already
    // monetises at exactly 1.5x hourly. Both parts are load-bearing — leaving the override in place would
    // put the shift's normal hours back as the threshold and pay nothing until hour 8.
    //
    // Deliberately NOT a fourth DayType. 'off_day' would mean widening the shared attendance_day_type
    // Postgres enum (also used by plan_ot), PlanOtDayType, TraceDayType, OtDay and the payroll OT policy
    // allowlist — a second money-bearing change across core/payroll.ts and localization/, for a value the
    // statute already pays on the leg that exists. The day is REPORTED as a workday; it is PAID correctly.
    if (kind === 'off') {
      return { ...policyBranch('workday'), scheduledMinutes: 0, normalMinutesOverride: null, source: 'default-shift-rest' };
    }
    return { ...policyBranch('rest_day'), source: 'default-shift-rest' };
  }

  if (isHoliday) return policyBranch('holiday');
  // No roster for this employee+date ⇒ company policy (working-days → workday/rest_day). A Half-day marker
  // (D2) counts as a WORKING day here — only leave.ts's deduction math distinguishes Full vs Half.
  return policyBranch(
    unionWorkingDays(pol.workingDays, pol.halfWorkingDays).includes(isoWeekday(date)) ? 'workday' : 'rest_day',
  );
}

/**
 * What one derived day looks like. `status` / `workedMinutes` / `otMinutes` are unchanged from before
 * 7c834696; everything after them is new and ADDITIVE — no existing figure is computed differently.
 * `otMinutes` remains the canonical overtime total and `otSplit` always sums back to it exactly.
 */
type DerivedDay = {
  status: 'present' | 'late' | 'half_day';
  workedMinutes: number | null;
  otMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  underMinutes: number | null;
  lateDeductMinutes: number | null;
  earlyOutDeductMinutes: number | null;
  otSplit: OtSplit | null;
  /** 7c834696 POINT 3 — the working behind the figures above, for the Records hover. ADDITIVE: it is
   *  built from values already computed here and changes none of them. See core/attendance-trace.ts for
   *  why it is stored rather than recomputed at read time. */
  trace: AttendanceTraceV1;
};

/** Derive status + worked/OT minutes against a resolved schedule — the shared rule that check-in/out apply
 *  incrementally and a correction applies in one shot. Cross-midnight aware via spanMinutes().
 *
 *  7c834696 stage 1 also derives the lateness / early-out / short-hours figures and the per-rate overtime
 *  split. `attendanceDate` is required for exactly one reason: it is the date a deduction is gated against
 *  (a rule's deductions only exist forward of its effective-from), and passing it makes that impossible to
 *  forget at a call site. */
function deriveAttendance(
  s: ResolvedSchedule,
  checkInAt: string,
  checkOutAt: string | null,
  attendanceDate: string,
): DerivedDay {
  // r274 (439565ff) — A FULL FLEXI DAY HAS NO TIME TO BE LATE FOR. `lateAfter` is still resolved (it is
  // shift start + grace, and the column is NOT NULL), but on this type the shift's start is the earliest
  // clocking accepted rather than a time anybody must arrive by, so comparing against it would record a
  // 08:31 arrival as late on a shift whose only requirement is nine hours.
  let status: 'present' | 'late' | 'half_day' =
    s.dayType === 'workday' && !s.flexiDuration && toMinutes(checkInAt) > toMinutes(s.lateAfter)
      ? 'late'
      : 'present';

  // 7c834696 — the schedule's own timeline, resolved on every branch. anchorToShift is the SAME placement
  // rule the OT window uses, so a 00:30 arrival on a 22:00 shift reads as 2.5h late rather than 21.5h early.
  const schedStartAbs = s.scheduledStart != null ? toMinutes(s.scheduledStart) : null;
  const inAbsSched = schedStartAbs != null ? anchorToShift(toMinutes(checkInAt), schedStartAbs, s.dailyCutoffMinutes) : null;
  // The gate on the only downward-capable figures in this change. FALSE for every rule at release, and
  // FALSE for any date before the rule's switch-on date, forever.
  const deductible = deductionsApplyOn(s.rule, attendanceDate);
  // Lateness is a workday concept measured against a schedule; rest-day / holiday work has no start to be
  // late against (the same reason `status` never reads 'late' on those days).
  // NULL on full flexi, not 0: zero minutes late asserts they arrived on time against a start that does
  // not exist, and `late_deduct_minutes` reads this figure.
  const lateMinutes: number | null =
    s.dayType === 'workday' && !s.flexiDuration && schedStartAbs != null && inAbsSched != null
      ? latenessOf({
          checkInAbs: inAbsSched,
          startAbs: schedStartAbs,
          graceMinutes: s.lateGraceMinutes,
          includeGrace: s.rule?.includeGraceInLateness ?? false,
        })
      : null;
  const lateDeduct: number | null =
    lateMinutes == null
      ? null
      : deductible
        ? deductionMinutes(lateMinutes, s.rule!.lateAfterMinutes, s.rule!.lateDeductMinutes)
        : 0;

  // ── 7c834696 POINT 3 · the trace. Built from the values ALREADY computed above; it reads them and
  // writes nothing back, so no figure this function returns can depend on it. ────────────────────────
  const inAbsRaw = toMinutes(checkInAt);
  const traceLateness: AttendanceTraceV1['lateness'] =
    lateMinutes == null || schedStartAbs == null || inAbsSched == null
      ? null
      : {
          startAbs: schedStartAbs,
          graceMinutes: Math.max(0, s.lateGraceMinutes),
          thresholdAbs: schedStartAbs + Math.max(0, s.lateGraceMinutes),
          checkInAbs: inAbsSched,
          includeGrace: s.rule?.includeGraceInLateness ?? false,
          minutes: lateMinutes,
        };
  // `applies` distinguishes "your rule does not deduct" from "it does, and this day earned nothing" —
  // every rule ships with deductions OFF, so without this the panel would answer the wrong question.
  const traceLateDeduction: AttendanceTraceV1['latenessDeduction'] =
    lateDeduct == null
      ? null
      : {
          applies: deductible,
          everyMinutes: deductible ? s.rule!.lateAfterMinutes : null,
          deductPerBlock: deductible ? s.rule!.lateDeductMinutes : null,
          blocks: deductible && s.rule!.lateAfterMinutes > 0 ? Math.floor((lateMinutes ?? 0) / s.rule!.lateAfterMinutes) : 0,
          minutes: lateDeduct,
        };
  const baseTrace = (): AttendanceTraceV1 => ({
    v: ATTENDANCE_TRACE_VERSION,
    schedule: {
      source: s.source,
      dayType: s.dayType,
      startAbs: schedStartAbs,
      endAbs: s.scheduledEnd != null ? toMinutes(s.scheduledEnd) + (s.crossesMidnight ? MINS_PER_DAY : 0) : null,
      scheduledMinutes: s.scheduledMinutes,
      normalMinutesOverride: s.normalMinutesOverride,
      crossesMidnight: s.crossesMidnight,
      breakMinutes: s.breakMinutes,
      breakSpanned: null,
      ruleId: s.rule?.id ?? null,
    },
    punch: { inAbs: inAbsRaw, outAbs: null, spanMinutes: null, workedMinutes: null },
    lateness: traceLateness,
    latenessDeduction: traceLateDeduction,
    earlyOut: null,
    earlyOutDeduction: null,
    overtime: null,
  });

  if (!checkOutAt) {
    // An open day: worked/OT have always been null here and stay null, and so does everything that needs a
    // clock-out. Lateness is already knowable, and the read layer already shows a 'late' status at this point.
    return {
      status,
      workedMinutes: null,
      otMinutes: null,
      lateMinutes,
      earlyOutMinutes: null,
      underMinutes: null,
      lateDeductMinutes: lateDeduct,
      earlyOutDeductMinutes: null,
      otSplit: null,
      // An open day gets a trace too — the lateness half is already knowable and is exactly what HR asks
      // about mid-morning. The overtime half stays null rather than reading as a confident zero.
      trace: baseTrace(),
    };
  }
  // Half-day is a day-shift concept; skip it for cross-midnight shifts (checkout time-of-day is next-day).
  if (
    s.dayType === 'workday' &&
    !s.crossesMidnight &&
    status !== 'late' &&
    toMinutes(checkOutAt) < toMinutes(s.halfDayBefore)
  ) {
    status = 'half_day';
  }
  const span = spanMinutes(checkInAt, checkOutAt);
  // b7b886e2 — with a resolved SHIFT we know where each minute fell, not just how many there were.
  const w: PunchWindow | null =
    s.shiftStart && s.shiftEnd
      ? (() => {
          const startAbs = toMinutes(s.shiftStart);
          const inAbs = anchorToShift(toMinutes(checkInAt), startAbs, s.dailyCutoffMinutes);
          // The punch LENGTH stays spanMinutes (the established, tested contract); only its placement is new.
          return {
            inAbs,
            outAbs: inAbs + span,
            startAbs,
            endAbs: s.crossesMidnight ? toMinutes(s.shiftEnd) + MINS_PER_DAY : toMinutes(s.shiftEnd),
          };
        })()
      : null;
  // 6340aecb — A FLEXIBLE BREAK IS AN ALLOWANCE, NOT A WINDOW. The employee may take up to N minutes
  // whenever they like, so there is nothing for the engine to test the clocking against: N comes off,
  // clamped to the day's own span so a short day can never go negative. It therefore REPLACES both of the
  // rules below — the window-overlap deduction (there is no window to require) and workedFromSpan's 6h
  // cliff (an allowance the operator has stated is not conditional on the length of the day).
  //
  // NULL on every shift that leaves the switch off, on every shift stored before migration 0457, and on
  // the company-policy branch — for all of which the two lines below are exactly what they were.
  const flexibleBreak = s.flexibleBreakMinutes != null ? Math.min(s.flexibleBreakMinutes, span) : null;
  // b7b886e2 — the break comes out only when the clocking actually SPANNED a declared break window, as the
  // reporter specified. Without windows there is nothing to test against, so the legacy 6h cliff stands.
  // r277 — the PER-ROW allowance sits between the two, and only ever fires for a shift whose break rows
  // carry their own figures. It is second, not first: a shift that still uses the shift-level switch has
  // one allowance for the whole shift and that answer must not change (core/roster.ts refuses to store
  // both at once, so in practice they can never both be present — the order here says which would win if
  // a row were ever written past the service). NULL ⇒ the line below is the line that has always run.
  const perRowBreak = w ? perRowBreakMinutes(s.breakPeriods, s.breakMinutes, w, s.dailyCutoffMinutes, span) : null;
  const spannedBreak =
    flexibleBreak ?? perRowBreak ?? (w ? spannedBreakMinutes(s.breakPeriods, s.breakMinutes, w, s.dailyCutoffMinutes) : null);
  const workedMinutes = spannedBreak != null ? Math.max(0, span - spannedBreak) : workedFromSpan(span, s.breakMinutes);
  // b7b886e2 — workday OT is the time worked BEYOND the shift's time-out, not the amount by which the day's
  // TOTAL overshot the scheduled duration. The old duration comparison ignored where the minutes fell, so a
  // late arrival who stayed an hour past the shift end accrued nothing, while an early arrival who left dead
  // on time accrued an hour of overtime pay they never worked late. max(inAbs, endAbs) keeps a punch that
  // began after the shift ended from claiming minutes before it clocked in.
  //
  // R7 Multi-Shift Phase 1 is preserved: a manual normal-hours override is an explicit operator statement
  // that normal hours are N minutes regardless of the clock, so it keeps the duration comparison.
  let earlyOtMinutes = 0;
  let otMinutes: number;
  // 7c834696 point 3 — which arithmetic ran. Captured here rather than re-derived by the panel, because
  // the branches are indistinguishable from the stored figures alone.
  let otBasis: 'window' | 'duration' | 'nonWorkday' | 'shiftWindows';
  // cf21e554 stage 2 — per-window detail for the trace (null unless the shiftWindows branch ran).
  let otWindowRows: TraceOtWindow[] | null = null;
  if (s.dayType !== 'workday') {
    otMinutes = workedMinutes;
    otBasis = 'nonWorkday';
  } else if (w && s.otWindows && s.otWindows.length > 0) {
    // cf21e554 stage 2 — the shift declares its overtime BY CLOCK TIME ("05:00–08:00", "17:00–23:59"), so
    // those windows decide which minutes count and the duration/past-the-end comparisons below do not run.
    //
    // WHY THIS OUTRANKS normalMinutesOverride. A manual normal-hours figure is a statement that normal
    // hours are N minutes "regardless of the clock"; an OT schedule is a statement about the clock itself,
    // and it is both newer and more specific. A shift carrying both would otherwise have its whole new tab
    // silently ignored. The override still owns SHORT HOURS (`under`, below) and the half-day/normal-hours
    // readout, which is where "normal hours are N" actually means something.
    //
    // Pre-shift minutes are NOT folded in on this branch: a before-shift window (the reporter's 05:00–08:00)
    // already counts them, and adding them again through the rule's applyToEarlyOt would pay them twice.
    earlyOtMinutes = Math.max(0, Math.min(w.outAbs, w.startAbs) - w.inAbs);
    const fromWindows = otMinutesFromWindows(s.otWindows, { inAbs: w.inAbs, outAbs: w.outAbs }, w.startAbs);
    otMinutes = fromWindows.total;
    otWindowRows = fromWindows.rows;
    otBasis = 'shiftWindows';
  } else if (w && s.normalMinutesOverride == null && !s.flexiDuration) {
    // r274 — the window basis measures overtime as time past the shift END. A full flexi shift has no end
    // to be past, so it never takes this branch. In practice its override is required, which would route
    // it to `duration` anyway; the flag is checked here too so the basis cannot silently change if a shift
    // is ever saved without one.
    otMinutes = Math.max(0, w.outAbs - Math.max(w.inAbs, w.endAbs));
    earlyOtMinutes = Math.max(0, Math.min(w.outAbs, w.startAbs) - w.inAbs);
    otBasis = 'window';
  } else {
    otMinutes = Math.max(0, workedMinutes - (s.normalMinutesOverride ?? s.scheduledMinutes));
    otBasis = 'duration';
  }
  const otRawMinutes = otMinutes;
  // 88e94371's documented GAP — "the engine does not yet attribute pre-shift punch minutes" — is what the
  // window above now supplies. The rule's opt-in folds them in HERE, before the per-shift OT shape below, so
  // an ineligible or capped shift can never let early minutes leak past its own limits. The shiftWindows
  // branch is excluded because its own before-shift window has already counted them (see above).
  const earlyOtFolded = s.dayType === 'workday' && otBasis !== 'shiftWindows' && (s.rule?.applyToEarlyOt ?? false);
  if (earlyOtFolded) otMinutes += earlyOtMinutes;
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
  const otAfterShiftRule = otMinutes;
  // 88e94371 — apply the resolved rule's Overtime table: round the workday OT minutes to the matching band's
  // Round-To value. Early OT was already folded in above (b7b886e2), so 0 is passed here deliberately — the
  // fold has to happen before the per-shift cap, and this call is only the rounding step. A rule with no OT
  // rows / rounding leaves otMinutes unchanged (byte-identical). Statutory 1.5×/2×/3× multipliers stay the
  // pay-side compliance cap and are untouched. Only workday OT is shaped (rest/holiday premium is statutory).
  const otBeforeRounding = otMinutes;
  if (s.dayType === 'workday' && otMinutes != null && s.rule) {
    otMinutes = applyOtRuleRows(otMinutes, 0, s.rule);
  }

  // ── 7c834696 stage 1 · the figures that had nowhere to live before ──────────────────────────────────
  // Everything below is derived FROM the values above and changes none of them. `otMinutes` is final at
  // this point and stays the canonical total; the split only says how it is distributed.
  const schedEndAbs =
    s.scheduledEnd != null
      ? s.crossesMidnight
        ? toMinutes(s.scheduledEnd) + MINS_PER_DAY
        : toMinutes(s.scheduledEnd)
      : null;
  const outAbsSched = inAbsSched != null ? inAbsSched + span : null;
  let earlyOut: number | null = null;
  let under: number | null = null;
  if (s.dayType === 'workday') {
    // r274 — and no time to leave early from. `under` below still measures short hours, because on a full
    // flexi day that is the ONLY thing that can be short: the required minutes were not worked.
    if (!s.flexiDuration && schedEndAbs != null && outAbsSched != null) {
      earlyOut = earlyOutOf({
        checkOutAbs: outAbsSched,
        endAbs: schedEndAbs,
        graceMinutes: s.earlyGraceMinutes,
        includeGrace: s.rule?.includeGraceInEarlyOut ?? false,
      });
    }
    // Short hours measured against the SAME normal-minutes figure the OT threshold uses (a manual
    // override wins over the shift's span, exactly as it does for overtime) — so a day cannot be both
    // short of its normal hours and over them.
    under = Math.max(0, (s.normalMinutesOverride ?? s.scheduledMinutes) - workedMinutes);
  }
  const earlyOutDeduct: number | null =
    earlyOut == null
      ? null
      : deductible
        ? deductionMinutes(earlyOut, s.rule!.earlyAfterMinutes, s.rule!.earlyDeductMinutes)
        : 0;

  const otSplit = splitOtMinutes(otMinutes, s.dayType, s.rule);

  // ── 7c834696 POINT 3 · finish the trace. Reads the finished figures; writes none of them. ───────────
  const trace = baseTrace();
  trace.schedule.breakSpanned = spannedBreak;
  trace.punch = { inAbs: inAbsRaw, outAbs: inAbsRaw + span, spanMinutes: span, workedMinutes };
  trace.earlyOut =
    earlyOut == null || schedEndAbs == null || outAbsSched == null
      ? null
      : {
          endAbs: schedEndAbs,
          graceMinutes: Math.max(0, s.earlyGraceMinutes),
          thresholdAbs: schedEndAbs - Math.max(0, s.earlyGraceMinutes),
          checkOutAbs: outAbsSched,
          includeGrace: s.rule?.includeGraceInEarlyOut ?? false,
          minutes: earlyOut,
        };
  trace.earlyOutDeduction =
    earlyOutDeduct == null
      ? null
      : {
          applies: deductible,
          everyMinutes: deductible ? s.rule!.earlyAfterMinutes : null,
          deductPerBlock: deductible ? s.rule!.earlyDeductMinutes : null,
          blocks: deductible && s.rule!.earlyAfterMinutes > 0 ? Math.floor(earlyOut! / s.rule!.earlyAfterMinutes) : 0,
          minutes: earlyOutDeduct,
        };
  trace.overtime = {
    basis: otBasis,
    // 'nonWorkday' has no normal hours to measure against — null rather than 0, which would read as
    // "your normal day is zero minutes" on the panel.
    normalMinutes: otBasis === 'nonWorkday' ? null : (s.normalMinutesOverride ?? s.scheduledMinutes),
    normalIsOverride: otBasis !== 'nonWorkday' && s.normalMinutesOverride != null,
    rawMinutes: otRawMinutes,
    earlyMinutes: earlyOtMinutes,
    earlyIncluded: earlyOtFolded,
    // cf21e554 stage 2 — what each declared OT window contributed. Null on every other branch, which is
    // every shift that has not opened the new tab.
    shiftOtWindows: otWindowRows,
    shiftRule:
      s.dayType === 'workday' && s.otRule
        ? {
            eligible: s.otRule.eligible,
            // `?? null` is load-bearing, not defensive tidying: ShiftOtRule carries these as
            // `number | undefined`, and JSON.stringify DROPS an undefined value entirely — the key would
            // vanish from the stored jsonb and the panel could not tell "no cap configured" from "a trace
            // written before caps existed". null survives the round trip and keeps the shape stable.
            minMinutes: s.otRule.minMinutes ?? null,
            dailyCapMinutes: s.otRule.dailyCapMinutes ?? null,
            minutesAfter: otAfterShiftRule,
          }
        : null,
    // `applied` is whether rounding MOVED the figure, not whether a rule existed: a rule with no
    // rounding configured is byte-identical to no rule, and the panel should not claim a step ran.
    rounding:
      s.dayType === 'workday' && s.rule
        ? { applied: otMinutes !== otBeforeRounding, beforeMinutes: otBeforeRounding, afterMinutes: otMinutes }
        : null,
    minutes: otMinutes,
    split: otSplit,
  };

  return {
    status,
    workedMinutes,
    otMinutes,
    lateMinutes,
    earlyOutMinutes: earlyOut,
    underMinutes: under,
    lateDeductMinutes: lateDeduct,
    earlyOutDeductMinutes: earlyOutDeduct,
    otSplit,
    trace,
  };
}

/** The six per-rate columns as a DB value object. Null split ⇒ all six stay NULL ("no engine computed
 *  this"), which is a different statement from six zeros and is what the read layer renders as "—". */
const otSplitColumns = (split: OtSplit | null) => ({
  otFlatMinutes: split?.flat ?? null,
  ot00Minutes: split?.ot00 ?? null,
  ot10Minutes: split?.ot10 ?? null,
  ot15Minutes: split?.ot15 ?? null,
  ot20Minutes: split?.ot20 ?? null,
  ot30Minutes: split?.ot30 ?? null,
});

/** Every stage-1 figure of a derived day, as the columns migration 0394 added. One helper so the four
 *  write paths (check-in, check-out, correction approval, punch import) cannot drift apart. */
const stage1Columns = (d: DerivedDay) => ({
  // 7c834696 point 3 — the working, written by the SAME helper as the figures it explains. Putting it
  // anywhere else would let one of the four write paths persist a figure with no trace beside it.
  calcTrace: d.trace,
  lateMinutes: d.lateMinutes,
  earlyOutMinutes: d.earlyOutMinutes,
  underMinutes: d.underMinutes,
  lateDeductMinutes: d.lateDeductMinutes,
  earlyOutDeductMinutes: d.earlyOutDeductMinutes,
  ...otSplitColumns(d.otSplit),
});

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
      rounding: shift.normalHoursRoundingMinutes,
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
    // cf21e554 — was an inlined copy of netScheduledMinutes; now the shared helper, so the shift's
    // Normal-Hours Rounding reaches the hourly clamp's ceiling too. A clamp measured against an unrounded
    // figure while the engine measures the day against a rounded one is a divergence nobody would see
    // until a payslip. Identical output for every shift whose rounding column is NULL.
    schedByDate.set(r.shiftDate, netScheduledMinutes(r.start, r.end, r.crosses!, r.brk!, r.rounding));
  }

  // ec4cbf63 — the employee's DEFAULT shift (profile assignment) IS an assigned shift: on a day with NO
  // roster row whose ISO weekday is in the default shift's weekly_pattern, the clamp ceiling is the default
  // shift's net scheduled minutes — the SAME resolution order scheduleFor applies (roster → default shift →
  // nothing), so batch payable-hours and single-day derivation can't diverge. A rostered rest day still
  // contributes 0 (the roster row wins), and a pattern rest day is not an assigned shift.
  //
  // 18504ca6 — and PER DATE, for the same reason scheduleFor is: a cycle that spans a shift change must clamp
  // each day against the shift that was in force on THAT day, not the one in force when the payroll ran.
  // Still batched: one ladder query, one query for the shifts it names.
  const periods = await arrangementsForEmploymentTx(tx, employmentId);
  const defShiftCols = {
    id: shift.id,
    start: shift.startTime,
    end: shift.endTime,
    brk: shift.breakMinutes,
    crosses: shift.crossesMidnight,
    pattern: shift.weeklyPattern,
    // b8aa3466 — the clamp must read the SAME four-way row scheduleFor does, or the payable-hours ceiling
    // and the day's own scheduled minutes diverge on a Half day and nobody sees it until a payslip.
    halfPattern: shift.halfPattern,
    offPattern: shift.offPattern,
    // 07ebd04d — the shift's Schedule Group, so the clamp can resolve the SAME working week scheduleFor
    // does now that the group carries one (migration 0483). Reading the shift's own week while the engine
    // reads the group's is the identical divergence the b8aa3466 note above was written about.
    ruleId: shift.ruleId,
    rounding: shift.normalHoursRoundingMinutes,
  };
  type ClampShift = { net: number; pattern: number[] | null; halfPattern?: number[] | null; offPattern?: number[] | null };
  const clampByShiftId = new Map<string, ClampShift>();
  const ladderShiftIds = [...new Set(periods.map((p) => p.shiftId))];
  const ladderShifts =
    ladderShiftIds.length > 0 ? await tx.select(defShiftCols).from(shift).where(inArray(shift.id, ladderShiftIds)) : [];
  // No ladder row for this employment ⇒ the cache, exactly as before this item.
  const [cachedRow] =
    periods.length === 0
      ? await tx
          .select(defShiftCols)
          .from(employment)
          .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
          .where(eq(employment.id, employmentId))
          .limit(1)
      : [];
  const [clampEmp] = await tx
    .select({ ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  const clampWeek = await weekLookupTx(tx, clampEmp?.ruleId, [...ladderShifts, ...(cachedRow ? [cachedRow] : [])].map((r) => r.ruleId));
  for (const sr of ladderShifts) {
    clampByShiftId.set(sr.id, {
      net: netScheduledMinutes(sr.start, sr.end, sr.crosses, sr.brk, sr.rounding),
      ...clampWeek(sr.ruleId, sr),
    });
  }
  let cachedClamp: ClampShift | null = null;
  if (cachedRow) {
    cachedClamp = {
      net: netScheduledMinutes(cachedRow.start, cachedRow.end, cachedRow.crosses, cachedRow.brk, cachedRow.rounding),
      ...clampWeek(cachedRow.ruleId, cachedRow),
    };
  }
  const clampOn = (d: string): ClampShift | null => {
    const p = pickArrangementOn(periods, d);
    return p ? (clampByShiftId.get(p.shiftId) ?? null) : cachedClamp;
  };

  let payableMinutes = 0;
  for (const row of rows) {
    const ds = clampOn(row.date);
    // b8aa3466 — Full clamps at the shift's net minutes, HALF at half of them, and Rest/Off contribute
    // nothing (they are not an assigned shift), exactly as a pattern rest day does today.
    const dsKind = ds == null ? null : shiftDayKindFor(ds, row.date);
    const scheduled =
      schedByDate.get(row.date) ??
      (!rosteredDates.has(row.date) && ds != null && dsKind != null && isWorkingDayKind(dsKind)
        ? dsKind === 'half'
          ? Math.floor(ds.net / 2)
          : ds.net
        : undefined);
    if (scheduled === undefined) continue; // no assigned shift that day → 0 payable when ON
    payableMinutes += Math.min(row.workedMinutes ?? 0, scheduled);
  }
  return payableMinutes / 60;
}

export type GeoInput = { lat: number; lng: number };

/** Map a resolved geofence outcome onto the attendance_punch geo columns (per-punch capture, ADR-0070 parity). */
function punchGeoValues(geo: GeofenceCheck) {
  return {
    lat: geo.lat,
    lng: geo.lng,
    clockingLocationId: geo.enforced ? geo.clockingLocationId : null,
    distanceM: geo.enforced ? geo.distanceM : null,
    geofenceStatus: (geo.enforced ? 'pass' : 'not_enforced') as 'pass' | 'not_enforced',
    radiusM: geo.enforced ? geo.radiusM : null,
  };
}

/**
 * R45 92bdf77a — Multiple Clocking. Re-derive the day AGGREGATE row from its child punches after a punch is
 * appended. Stage-1 rule (per the approved plan): official Clock-In = the earliest in-punch, official
 * Clock-Out = the latest out-punch, and the day only "closes" (worked/OT computed) when the in/out punches
 * BALANCE (equal count, ≥1 each). An unbalanced day — a single clocking, or a forgotten clock-out — keeps
 * checkOutAt null, so worked/OT stay null and the read-time 'odd' flag (core/attendance-derive.ts) surfaces
 * it for manager/HR review instead of silently miscounting. Worked/OT themselves come from the SAME
 * deriveAttendance the single-pair path used (first-in → last-out span, minus the shift break) — byte-
 * identical for the overwhelming single-pair case. Deferred (stage 2, documented GAP): per-pair unpaid-break,
 * pre-shift/early-OT attribution, split shifts, cross-midnight multi-punch.
 */
async function recomputeDayFromPunches(
  tx: Tx,
  p: { attendanceId: string; attendanceDate: string; sched: ResolvedSchedule; fallbackCheckInAt: string | null },
): Promise<{
  status: 'present' | 'late' | 'half_day';
  workedMinutes: number | null;
  otMinutes: number | null;
  checkInAt: string | null;
  checkOutAt: string | null;
}> {
  const punches = await tx
    .select({ punchAt: attendancePunch.punchAt, direction: attendancePunch.direction })
    .from(attendancePunch)
    .where(eq(attendancePunch.attendanceId, p.attendanceId));
  const ins = punches.filter((x) => x.direction === 'in').map((x) => x.punchAt);
  const outs = punches.filter((x) => x.direction === 'out').map((x) => x.punchAt);
  const minAt = (xs: string[]) => xs.reduce((a, b) => (toMinutes(b) < toMinutes(a) ? b : a));
  const maxAt = (xs: string[]) => xs.reduce((a, b) => (toMinutes(b) > toMinutes(a) ? b : a));
  const checkInAt = ins.length ? minAt(ins) : p.fallbackCheckInAt;
  const balanced = ins.length >= 1 && ins.length === outs.length;
  const checkOutAt = balanced && outs.length ? maxAt(outs) : null;
  if (!checkInAt) {
    // No punches and no fallback anchor — nothing to derive (defensive; a check-in always seeds one).
    return { status: 'present', workedMinutes: null, otMinutes: null, checkInAt: null, checkOutAt: null };
  }
  const d = deriveAttendance(p.sched, checkInAt, checkOutAt, p.attendanceDate);
  const { status, workedMinutes, otMinutes } = d;
  await tx
    .update(attendance)
    // 7c834696: worked/OT are written exactly as before; the stage-1 columns are added alongside them.
    .set({ checkInAt, checkOutAt, status, workedMinutes, otMinutes, ...stage1Columns(d) })
    .where(eq(attendance.id, p.attendanceId));
  return { status, workedMinutes, otMinutes, checkInAt, checkOutAt };
}

async function checkInTx(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Feedback 5249d43f: registered-device gate FIRST — when the company policy requires it, an absent /
    // unknown / revoked token throws the typed DeviceNotRegisteredError before anything is evaluated or
    // written (policy OFF ⇒ no-op). Terminal imports bypass by construction (they never call checkIn).
    await enforceDeviceGateTx(tx, { employmentId: p.employmentId, deviceToken: p.deviceToken });

    const [existing] = await tx
      .select({ id: attendance.id, dayType: attendance.dayType })
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);

    const sched0 = await scheduleFor(tx, p.employmentId, p.date);
    // Freeze the day-type stamped at the FIRST check-in (existing row) — same rule check-out applies.
    const sched: ResolvedSchedule = existing?.dayType ? { ...sched0, dayType: existing.dayType } : sched0;
    const dayType = sched.dayType;

    // R45: a SECOND (or later) clock-in of the day is now allowed (multiple clocking). Keep punches monotonic
    // on a non-cross-midnight day: a new clocking must be later than every punch already recorded today.
    if (existing && !sched.crossesMidnight) {
      const [last] = await tx
        .select({ punchAt: attendancePunch.punchAt })
        .from(attendancePunch)
        .where(eq(attendancePunch.attendanceId, existing.id))
        .orderBy(desc(attendancePunch.punchAt))
        .limit(1);
      if (last && toMinutes(p.time) <= toMinutes(last.punchAt)) {
        throw new Error('Each clocking must be later than the previous one');
      }
    }

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

    let attendanceId: string;
    if (!existing) {
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
          // The aggregate's check-in geo reflects the FIRST clock-in punch (each punch also keeps its own).
          checkInLat: geo.lat,
          checkInLng: geo.lng,
          checkInClockingLocationId: geo.enforced ? geo.clockingLocationId : null,
          checkInDistanceM: geo.enforced ? geo.distanceM : null,
          checkInGeofenceStatus: geo.enforced ? 'pass' : 'not_enforced',
          checkInRadiusM: geo.enforced ? geo.radiusM : null,
          checkInMethod: 'web',
        })
        .returning({ id: attendance.id });
      attendanceId = row.id;
    } else {
      attendanceId = existing.id;
    }

    await tx.insert(attendancePunch).values({
      tenantId: ctx.tenantId,
      attendanceId,
      employmentId: p.employmentId,
      attendanceDate: p.date,
      punchAt: p.time,
      direction: 'in',
      method: 'web',
      ...punchGeoValues(geo),
    });

    const derived = await recomputeDayFromPunches(tx, {
      attendanceId,
      attendanceDate: p.date,
      sched,
      fallbackCheckInAt: p.time,
    });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: attendanceId,
      eventType: 'attendance.checked-in',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // Substrate: the per-punch insert is high-volume; its audit rolls up into this day-level event
      // (CLAUDE.md documented skip for per-item writes with their own trail). punchAt is on the payload.
      payload: { employmentId: p.employmentId, date: p.date, time: p.time, status: derived.status, dayType, punch: 'in' },
    });
    return { attendanceId, status: derived.status, dayType };
  });
}

/** Check in. `geo` is optional — omitted/undefined when the browser gave no coordinates (allowed only
 *  while geofencing is OFF for this employment; see resolveGeofence). Catches OutsideGeofenceError
 *  OUTSIDE the write transaction and appends the blocked event in its own transaction before rethrowing
 *  (ADR-0070 §3 — the only way a blocked ATTEMPT can be durably recorded once its write rolled back). */
export async function checkIn(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string },
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
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Feedback 5249d43f: same registered-device gate as checkInTx — see the comment there.
    await enforceDeviceGateTx(tx, { employmentId: p.employmentId, deviceToken: p.deviceToken });

    const [rec] = await tx
      .select()
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);
    if (!rec) throw new Error('No check-in recorded for this day');

    // Resolve the roster/policy schedule, then freeze the day-type stamped at check-in (tolerating legacy
    // rows). On a non-cross-midnight schedule check-out must be after the last punch; a cross-midnight shift
    // may legitimately check out at an earlier time-of-day (next day) — but never at the exact last-punch time.
    const sched0 = await scheduleFor(tx, p.employmentId, p.date);
    const sched: ResolvedSchedule = rec.dayType ? { ...sched0, dayType: rec.dayType } : sched0;

    // R45 Multiple Clocking: a checkout after a completed pair now APPENDS an out-punch (was: throw
    // 'Already checked out'). Order against the latest punch already recorded (or the row's check-in for a
    // legacy row that predates the punch table).
    const existingPunches = await tx
      .select({ punchAt: attendancePunch.punchAt })
      .from(attendancePunch)
      .where(eq(attendancePunch.attendanceId, rec.id));
    const anchor = existingPunches.length
      ? existingPunches.reduce((a, b) => (toMinutes(b.punchAt) > toMinutes(a.punchAt) ? b : a)).punchAt
      : rec.checkInAt;
    if (!sched.crossesMidnight && anchor != null && toMinutes(p.time) <= toMinutes(anchor)) {
      throw new Error('Check-out must be after check-in');
    }
    if (anchor != null && toMinutes(p.time) === toMinutes(anchor)) {
      throw new Error('Check-out must differ from check-in');
    }

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

    // Legacy backfill: an attendance row created before multi-punch (biometric import, seed) carries a
    // check_in_at but NO 'in' punch child. Synthesise one from the row so first-in/last-out summation is
    // correct — otherwise the day would look like a single out-punch. One-time, idempotent (only when empty).
    if (existingPunches.length === 0 && rec.checkInAt) {
      await tx.insert(attendancePunch).values({
        tenantId: ctx.tenantId,
        attendanceId: rec.id,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        punchAt: rec.checkInAt,
        direction: 'in',
        method: rec.checkInMethod ?? 'web',
        lat: rec.checkInLat,
        lng: rec.checkInLng,
        clockingLocationId: rec.checkInClockingLocationId,
        distanceM: rec.checkInDistanceM,
        geofenceStatus: rec.checkInGeofenceStatus,
        radiusM: rec.checkInRadiusM,
      });
    }

    await tx.insert(attendancePunch).values({
      tenantId: ctx.tenantId,
      attendanceId: rec.id,
      employmentId: p.employmentId,
      attendanceDate: p.date,
      punchAt: p.time,
      direction: 'out',
      method: 'web',
      ...punchGeoValues(geo),
    });

    // The aggregate's check-out geo reflects the LATEST out-punch (first-in / last-out parity).
    await tx
      .update(attendance)
      .set({
        checkOutLat: geo.lat,
        checkOutLng: geo.lng,
        checkOutClockingLocationId: geo.enforced ? geo.clockingLocationId : null,
        checkOutDistanceM: geo.enforced ? geo.distanceM : null,
        checkOutGeofenceStatus: geo.enforced ? 'pass' : 'not_enforced',
        checkOutRadiusM: geo.enforced ? geo.radiusM : null,
        checkOutMethod: 'web',
      })
      .where(eq(attendance.id, rec.id));

    // Workday OT = beyond the scheduled net day; rest-day/holiday work is OT-class in full (EA 1955 pays it
    // at premium rates — classification here, monetization in payroll). Derived from first-in / last-out.
    const derived = await recomputeDayFromPunches(tx, {
      attendanceId: rec.id,
      attendanceDate: p.date,
      sched,
      fallbackCheckInAt: rec.checkInAt,
    });
    const dayType = sched.dayType;

    // 1e9145d4 — THE DAY HAS NOW MATERIALISED, so an overtime plan approved ahead of it lands here: the
    // agreed figure is resolved against `derived.otMinutes` (what was really clocked) through the company's
    // own ot_approval_calculation, and the replacement-leave credit the deferred approval could not mint is
    // minted. On a SECOND clock-out of the day this instead re-asserts the figure that already landed —
    // recomputeDayFromPunches above has just overwritten ot_minutes from the punches, which would otherwise
    // quietly erase what a human approved. Returns null (and changes nothing) when there is no plan, which
    // is every ordinary day.
    const plannedOt = await applyApprovedOtPlanTx(tx, ctx, {
      employmentId: p.employmentId,
      date: p.date,
      attendanceId: rec.id,
      sched,
      systemOtMinutes: derived.otMinutes,
    });
    const otMinutes = plannedOt ?? derived.otMinutes;

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
        status: derived.status,
        dayType,
        // The figure standing on the row AFTER any approved OT plan landed — not the raw derived one, which
        // would make the event disagree with the record it describes.
        otMinutes,
        punch: 'out',
      },
    });
    return { status: derived.status, dayType, workedMinutes: derived.workedMinutes, otMinutes };
  });
}

/** Check out. Same optional-geo / blocked-event contract as checkIn (ADR-0070 §3). */
export async function checkOut(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string },
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

// ─── Attendance Records Table Enhancement (feedback bbada39c) — shift-display resolution ──────────────
//
// The Records tables need, per row, the assigned Shift CODE, the scheduled minutes and the shift start/end
// — none of which is stored on the attendance row. scheduleFor() resolves all of this but DISCARDS the
// shift identity and is per-(employee,date) (an N+1 in the daily loader). So we resolve the DISPLAY subset
// with the SAME precedence (rostered shift > rostered rest > default shift working-day > default-shift rest
// > company policy), fed from BATCHED queries (one roster query, one default-shift query for the whole
// page) — read-only, no behaviour change to pay derivation.

/** The per-row shift-display fields surfaced by both Records loaders (all derived, none stored). */
export type ShiftDisplay = {
  /** Assigned Shift Code for the date (fixed default shift or rostered shift); null on a policy/rest day. */
  shiftCode: string | null;
  /** Net scheduled work minutes for the resolved shift/policy working day; null on a no-work (rest/off) day. */
  scheduledMinutes: number | null;
  /** Shift start / end as HH:MM; null when no shift resolves (policy / rest day). */
  shiftStart: string | null;
  shiftEnd: string | null;
  /** True when the day is an EXPLICIT rostered rest day (→ Status "Rest" vs the "OFF" policy non-working day). */
  isRosterRest: boolean;
};

const NO_SHIFT: ShiftDisplay = { shiftCode: null, scheduledMinutes: null, shiftStart: null, shiftEnd: null, isRosterRest: false };

// cf21e554 — `rounding` (shift.normal_hours_rounding_minutes) is carried here for the reason this
// module's own comment gives two lines below: the table must not disagree with the engine. Without it a
// shift that rounds its normal hours would render 7h 50m in the Scheduled column while scheduleFor
// measured the day against 7h 45m. Null on every legacy row ⇒ byte-identical.
type RosterDisplayRow = { isRestDay: boolean; code: string | null; start: string | null; end: string | null; brk: number | null; crosses: boolean | null; rounding: number | null };
/**
 * 07ebd04d (r331, migration 0483) — THE BATCHED "WHOSE WORKING WEEK IS THIS" LOOKUP.
 *
 * `scheduleFor` resolves one employee on one date and already has the rule in hand. The surfaces below
 * resolve a whole cycle or a whole grid, and each of them builds its own narrow shift row; none of them
 * may afford a rule query per date. This is that query, once: every rule week that could possibly answer
 * for the shifts in play, plus the tenant's is_default rule (which is what a shift with no `rule_id`
 * resolves — see core/attendance-rule.ts resolveRuleTx).
 *
 * THE CHAIN IS THE SAME ONE `scheduleFor`'s `ruleFor` USES and is not restated anywhere else:
 *     employment.attendance_rule_id  →  shift.rule_id  →  the tenant's is_default rule
 * The rule is chosen first, and THAT rule's week is then offered to `weekPatternFor`, which hands back
 * the shift's own week whenever the chosen rule declares no working day. Every rule written before 0483
 * declares none, and migration 0483 deliberately leaves the is_default rule that way forever, so this is
 * byte-identical for every shift that has not been put into a pattern-carrying group.
 */
export type WeekLookup = (shiftRuleId: string | null | undefined, sh: WeekPattern) => WeekPattern;

export async function weekLookupTx(
  tx: Tx,
  empGroupRuleId: string | null | undefined,
  shiftRuleIds: readonly (string | null | undefined)[],
): Promise<WeekLookup> {
  const ids = [...new Set([empGroupRuleId, ...shiftRuleIds].filter((v): v is string => !!v))];
  const rows = await tx
    .select({
      id: attendanceRule.id,
      isDefault: attendanceRule.isDefault,
      pattern: attendanceRule.weeklyPattern,
      halfPattern: attendanceRule.halfPattern,
      offPattern: attendanceRule.offPattern,
    })
    .from(attendanceRule)
    .where(ids.length ? or(inArray(attendanceRule.id, ids), eq(attendanceRule.isDefault, true)) : eq(attendanceRule.isDefault, true));
  const byId = new Map(rows.map((r) => [r.id, { pattern: r.pattern, halfPattern: r.halfPattern, offPattern: r.offPattern }]));
  const fallback = rows.find((r) => r.isDefault);
  return (shiftRuleId, sh) => {
    const chosen = empGroupRuleId ?? shiftRuleId ?? null;
    const week = chosen ? byId.get(chosen) : fallback ? byId.get(fallback.id) : undefined;
    return weekPatternFor(week, sh);
  };
}

type DefaultShiftRow = {
  code: string | null;
  start: string;
  end: string;
  brk: number;
  crosses: boolean;
  pattern: number[] | null;
  // b8aa3466 — the four-way row. Optional so the many places that build a DefaultShiftRow from a narrower
  // select keep compiling; absent behaves as '{}', which is the pre-0429 two-way meaning.
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
  rounding: number | null;
};

/**
 * e2632276 — THE ONE SCHEDULING LADDER the Records surfaces read, stated once. It mirrors scheduleFor()'s
 * precedence exactly (rostered shift → rostered rest → default shift's weekly pattern → default-shift rest
 * → company policy) and is consumed by BOTH `resolveShiftDisplay` (what the row shows) and
 * `isScheduledOffDay` (whether a missing row is explained by a rest day or is a real absence). Those two
 * questions used to be answered from different inputs — the display honoured the roster while the context
 * looked only at the company weekday list — which is why an employee ROSTERED TO REST on a company working
 * day was shown in red as Absent. Under the absence deduction that discrepancy would have cost them a
 * day's pay, so the ladder now has exactly one statement of itself.
 *
 * A roster row that is not a rest day but resolves no shift times is NOT a scheduled shift: scheduleFor
 * requires start AND end before it treats the row as work, and falls through to its rostered-rest branch.
 */
type ScheduleClass = 'roster_shift' | 'roster_rest' | 'default_shift' | 'default_rest' | 'policy_work' | 'policy_rest';

function classifyScheduleDay(
  date: string,
  roster: RosterDisplayRow | undefined,
  def: DefaultShiftRow | undefined,
  companyWorkingDay: boolean,
): ScheduleClass {
  if (roster) return !roster.isRestDay && roster.start && roster.end ? 'roster_shift' : 'roster_rest';
  // b8aa3466 — Full and Half are both scheduled work; Rest and Off are not. An Off day is still a
  // "no work scheduled" day for the DISPLAY ladder — the difference between Rest and Off is what working
  // it PAYS, not whether it was scheduled — so a missing row on either is explained, not an absence.
  if (def) return isWorkingDayKind(shiftDayKindFor(def, date)) ? 'default_shift' : 'default_rest';
  return companyWorkingDay ? 'policy_work' : 'policy_rest';
}

/**
 * e2632276 — true when this employee has NO work on this date, i.e. a missing attendance row is explained
 * by a rest day rather than being a real absence. The Records loaders use it to set `context='rest_day'`
 * instead of letting `statusOf` print a red "Absent".
 *
 * `deductAbsence` IS THE SAFETY GATE, and it is why this function takes a boolean rather than simply
 * reading the ladder. With it FALSE — which is every employment on every one of the nine companies until
 * somebody ticks "Deduct absence days" on a payroll policy — the answer is `!companyWorkingDay`, exactly
 * what this file computed before e2632276: the roster is ignored, and an employee rostered to rest on a
 * company working day still renders the wrong red "Absent". That is a real bug and it is deliberately
 * left alone, because the same rule feeds `attendanceMonthSummary`, whose `absent` / `present` /
 * `leaveDays` figures `evaluateMonthly` (core/attendance-allowance.ts) turns into a real payment. Fixing
 * it un-gated would start and stop attendance allowances on day one, for everybody, which is precisely
 * what the approved plan promised would not happen ("all 9 of your companies keep behaving exactly as
 * they do now until you turn it on").
 *
 * With it TRUE the full ladder applies — rostered shift → rostered rest → default-shift weekly pattern →
 * company policy — so the screen, the month roll-up and the payroll deduction all read the same schedule
 * and a rostered rest day can never cost anybody a day's pay.
 */
function isScheduledOffDay(
  date: string,
  roster: RosterDisplayRow | undefined,
  def: DefaultShiftRow | undefined,
  companyWorkingDay: boolean,
  deductAbsence: boolean,
): boolean {
  if (!deductAbsence) return !companyWorkingDay;
  const c = classifyScheduleDay(date, roster, def, companyWorkingDay);
  return c === 'roster_rest' || c === 'default_rest' || c === 'policy_rest';
}

/**
 * Resolve the shift-DISPLAY subset for one (employee, date) from already-batched inputs, mirroring
 * scheduleFor()'s precedence exactly so the table can't disagree with the engine:
 *   rostered shift → rostered rest → default shift (pattern working day) → default-shift rest → policy.
 * `policyScheduled` is the company policy's net scheduled minutes when the date is a policy WORKING day,
 * else null (the caller decides working-vs-rest from the same workDays list the context uses).
 */
function resolveShiftDisplay(
  date: string,
  roster: RosterDisplayRow | undefined,
  def: DefaultShiftRow | undefined,
  policyScheduled: number | null,
): ShiftDisplay {
  switch (classifyScheduleDay(date, roster, def, policyScheduled !== null)) {
    case 'roster_shift':
      return {
        shiftCode: roster!.code,
        scheduledMinutes: netScheduledMinutes(roster!.start!, roster!.end!, roster!.crosses!, roster!.brk!, roster!.rounding),
        shiftStart: roster!.start!.slice(0, 5),
        shiftEnd: roster!.end!.slice(0, 5),
        isRosterRest: false,
      };
    case 'roster_rest':
      return { ...NO_SHIFT, isRosterRest: true }; // an explicit rostered rest day
    case 'default_shift':
      return {
        shiftCode: def!.code,
        scheduledMinutes: netScheduledMinutes(def!.start, def!.end, def!.crosses, def!.brk, def!.rounding),
        shiftStart: def!.start.slice(0, 5),
        shiftEnd: def!.end.slice(0, 5),
        isRosterRest: false,
      };
    case 'default_rest':
      return NO_SHIFT; // default shift's own rest day (pattern excludes) → OFF, not an explicit rostered rest
    default:
      // Company-policy branch: a working day carries the policy schedule; a non-working day is OFF (no shift).
      return { ...NO_SHIFT, scheduledMinutes: policyScheduled };
  }
}

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
        // 7c834696 stage 1 — the stored per-day figures. NULL on every row that predates the engine that
        // computes them; the read-time derivations treat NULL as "fall back to the old routing".
        lateMinutes: attendance.lateMinutes,
        earlyOutMinutes: attendance.earlyOutMinutes,
        underMinutes: attendance.underMinutes,
        lateDeductMinutes: attendance.lateDeductMinutes,
        earlyOutDeductMinutes: attendance.earlyOutDeductMinutes,
        otFlatMinutes: attendance.otFlatMinutes,
        ot00Minutes: attendance.ot00Minutes,
        ot10Minutes: attendance.ot10Minutes,
        ot15Minutes: attendance.ot15Minutes,
        ot20Minutes: attendance.ot20Minutes,
        ot30Minutes: attendance.ot30Minutes,
        // 7c834696 point 3 — the WORKING behind the figures above, so the Records hover can show how each
        // one was arrived at. NULL on every row written before migration 0411 and on any row nothing has
        // re-derived since; core/attendance-explain.ts turns that into "no working was recorded", which is
        // the honest answer. It is never reconstructed at read time (see core/attendance-trace.ts).
        calcTrace: attendance.calcTrace,
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
          // bbada39c — policy net scheduled minutes for the "Shift Hours" column on a policy (no-shift) day.
          workStart: attendancePolicy.workStart,
          workEnd: attendancePolicy.workEnd,
          breakMinutes: attendancePolicy.breakMinutes,
        })
        .from(attendancePolicy),
    ]);
    const leaveSet = new Set<string>();
    for (const [emp, dates] of approvedDates) if (dates.has(date)) leaveSet.add(emp);
    // D2: a Half-day marker still counts as a working day for attendance — union with halfWorkingDays.
    const daysByCompany = new Map(
      policies.map((p) => [p.companyId, unionWorkingDays(p.workingDays, p.halfWorkingDays)]),
    );
    // bbada39c — company → policy net scheduled minutes (span − break), used only when no shift resolves.
    const policySchedByCompany = new Map(
      policies.map((p) => [p.companyId, scheduledMinutes({ ...DEFAULTS, workStart: p.workStart, workEnd: p.workEnd, breakMinutes: p.breakMinutes })]),
    );
    const dow = isoWeekday(date);

    // bbada39c — BATCHED shift-display resolution (avoid an N+1): one roster query + one default-shift query
    // for the whole page, then resolveShiftDisplay() applies scheduleFor's precedence per row.
    const rosterByEmp = new Map<string, RosterDisplayRow>();
    for (const rr of await tx
      .select({
        employmentId: rosterAssignment.employmentId,
        isRestDay: rosterAssignment.isRestDay,
        code: shift.code,
        start: shift.startTime,
        end: shift.endTime,
        brk: shift.breakMinutes,
        crosses: shift.crossesMidnight,
        rounding: shift.normalHoursRoundingMinutes,
      })
      .from(rosterAssignment)
      .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(and(inArray(rosterAssignment.employmentId, empIds.length ? empIds : ['']), eq(rosterAssignment.shiftDate, date)))) {
      rosterByEmp.set(rr.employmentId, rr);
    }
    // 18504ca6 — THE RETROACTIVE RELABEL THIS CLOSES. This map used to be a plain join on
    // employment.default_shift_id with NO date predicate, so the moment someone was moved onto a new shift
    // every PAST day in this table started showing the new shift code beside figures that were never measured
    // against it. The arrangement in force on `date` answers it now; two batched queries (the ladder, then the
    // shifts it names) keep the loader's batching promise. An employment with no ladder row falls through to
    // the same cache join as before.
    const arrangementsByEmp = await liveArrangementsTx(tx, empIds);
    const shiftIdForDate = new Map<string, string>();
    for (const [eid, periods] of arrangementsByEmp) {
      const p = pickArrangementOn(periods, date);
      if (p) shiftIdForDate.set(eid, p.shiftId);
    }
    // 07ebd04d — the GRID's working week, resolved exactly as scheduleFor resolves one day's: the
    // employee's Schedule Group, else the shift's, else the tenant default (migration 0483). Two extra
    // set-based reads for the whole grid — the group of every listed employment, and the week of every
    // rule those shifts name — never one per row. `weekPatternFor` hands back the shift's own week for
    // every group that declares none, which is every group written before 0483.
    const groupByEmp = new Map<string, string | null>();
    if (empIds.length) {
      for (const g of await tx
        .select({ id: employment.id, ruleId: employment.attendanceRuleId })
        .from(employment)
        .where(inArray(employment.id, empIds))) {
        groupByEmp.set(g.id, g.ruleId);
      }
    }
    const defaultShiftByEmp = new Map<string, DefaultShiftRow>();
    const gridShiftCols = {
      id: shift.id,
      code: shift.code,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      pattern: shift.weeklyPattern,
      halfPattern: shift.halfPattern,
      offPattern: shift.offPattern,
      ruleId: shift.ruleId,
      rounding: shift.normalHoursRoundingMinutes,
    };
    const datedShiftIds = [...new Set(shiftIdForDate.values())];
    const datedShifts = datedShiftIds.length
      ? await tx.select(gridShiftCols).from(shift).where(inArray(shift.id, datedShiftIds))
      : [];
    const profileShifts = await tx
      .select({ ...gridShiftCols, employmentId: employment.id })
      .from(employment)
      .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
      .where(inArray(employment.id, empIds.length ? empIds : ['']));
    // ONE rule read for the whole grid. The lookup is per employment (the group is the employee's), so it
    // is built with a null employment group and the employee's own group is applied at the call site.
    const gridWeek = await weekLookupTx(tx, null, [
      ...[...datedShifts, ...profileShifts].map((r) => r.ruleId),
      ...groupByEmp.values(),
    ]);
    const weekFor = (eid: string, row: { ruleId: string | null; pattern: number[] | null; halfPattern: number[]; offPattern: number[] }) =>
      gridWeek(groupByEmp.get(eid) ?? row.ruleId, row);
    const byShiftId = new Map(datedShifts.map((sr) => [sr.id, sr]));
    for (const [eid, sid] of shiftIdForDate) {
      const row = byShiftId.get(sid);
      if (row) defaultShiftByEmp.set(eid, { ...row, ...weekFor(eid, row) });
    }
    for (const dr of profileShifts) {
      if (!defaultShiftByEmp.has(dr.employmentId)) defaultShiftByEmp.set(dr.employmentId, { ...dr, ...weekFor(dr.employmentId, dr) });
    }

    // ADR-0055: resolve each absent employee's holiday calendar through the unified resolver (business-group
    // → state → national), the SAME calendar leave + checkIn use — so a group/state holiday explains a
    // missing row exactly as it freezes the day-type. Only no-row employees need this context.
    // r298 (b6a995c1): this used to be one resolver call per no-row employee, awaited in turn — 1,000 of
    // them before anyone clocks in. holidayDatesByEmployment answers them all at once: the same
    // `holidayDatesFor`, called once per distinct set of the inputs that decide a calendar (company, work
    // state, holiday group, open-assignment location), with an entry for every id asked.
    const holidaysByEmp = await holidayDatesByEmployment(tx, {
      employmentIds: rows.filter((r) => !r.attendanceId).map((r) => r.employmentId),
      startDate: date,
      endDate: date,
    });
    const holidayEmp = new Set<string>();
    for (const r of rows) {
      if (r.attendanceId) continue;
      const hs = holidaysByEmp.get(r.employmentId);
      if (hs && hs.has(date)) holidayEmp.add(r.employmentId);
    }

    // e2632276 — the absence GATE, per employment (it lives on the assigned PAYROLL POLICY, so two
    // employees of one company can differ). Empty for every company until somebody ticks the box, and an
    // empty set makes `isScheduledOffDay` fall back to `!isWorkingDay` — the exact expression this loader
    // used before this item. Batched: three set-based queries for the whole grid, never one per row.
    const deductAbsence = await deductAbsentDaysByEmployment(
      tx,
      rows.filter((r) => !r.attendanceId).map((r) => r.employmentId),
    );

    return rows.map(({ companyId, ...r }) => {
      const isWorkingDay = (daysByCompany.get(companyId) ?? DEFAULTS.workingDays).includes(dow);
      // bbada39c — shift-display subset (code / scheduled minutes / start-end / rostered-rest) for the row.
      const policyScheduled = isWorkingDay ? (policySchedByCompany.get(companyId) ?? scheduledMinutes(DEFAULTS)) : null;
      const roster = rosterByEmp.get(r.employmentId);
      const def = defaultShiftByEmp.get(r.employmentId);
      const shiftDisplay = resolveShiftDisplay(date, roster, def, policyScheduled);
      let context: DayContext = null;
      if (!r.attendanceId) {
        if (leaveSet.has(r.employmentId)) context = 'on_leave';
        else if (holidayEmp.has(r.employmentId)) context = 'holiday';
        // e2632276 — the ROSTER WINS, but only once the deduction is switched on for this employment.
        // Off (every company, day one) this is `!isWorkingDay`, byte-identical to before. On, an employee
        // rostered to rest (or whose default-shift pattern excludes the day) on a company working day
        // reads REST instead of a red "Absent", and a rostered SHIFT on a company non-working day becomes
        // a scheduled day that CAN be absent — matching what payroll will charge for.
        else if (isScheduledOffDay(date, roster, def, isWorkingDay, deductAbsence.has(r.employmentId)))
          context = 'rest_day';
      }
      return { ...r, context, ...shiftDisplay };
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
  // 7c834696 stage 1 — the stored per-day figures (see core/attendance-derive.ts AttendanceDeriveRow for
  // how the read layer treats a NULL: fall back to the pre-7c834696 routing, never to a confident zero).
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  underMinutes: number | null;
  lateDeductMinutes: number | null;
  earlyOutDeductMinutes: number | null;
  otFlatMinutes: number | null;
  ot00Minutes: number | null;
  ot10Minutes: number | null;
  ot15Minutes: number | null;
  ot20Minutes: number | null;
  ot30Minutes: number | null;
  /** 7c834696 point 3 — the stored working behind the figures above. Typed `unknown` on purpose: the only
   *  legitimate consumer is core/attendance-explain.ts, whose whole contract is that it validates the
   *  version itself and reports `unavailable` on anything it does not recognise. Typing it as the current
   *  trace shape would invite a caller to read `.overtime.minutes` off a row written by an older build. */
  calcTrace: unknown;
  /** Explains a no-row day, same precedence as attendanceForDate: leave > holiday > rest day. */
  context: DayContext;
  // bbada39c — the individual row now carries the employee identity (the page used to read it from the
  // dropdown) plus the shift-display subset, so the Records table can render code / shift / hours per day.
  employeeCode: string | null;
  name: string;
} & ShiftDisplay;

/**
 * THE HARD CEILING ON attendanceForEmploymentRange's DAY LOOP — now a named export, and that is the whole
 * point of it (67268d83, r367).
 *
 * The number was already here as a bare `400` inside the loop below, with a comment saying a
 * first-of-month → today window is at most 31 days. That reasoning held while every caller chose the range
 * itself: `/attendance/individual` defaults to month-to-date and only an administrator can widen it.
 * 67268d83 puts a From / To pair in an EMPLOYEE's hands on /attendance/my-records, so a range longer than
 * this ceiling became reachable by anybody — and the loop's behaviour past it is to stop, silently, with a
 * short array that looks exactly like "you have no attendance after that date".
 *
 * THE LOOP IS NOT CHANGED. Removing the cap would trade a silent truncation for an unbounded read, which
 * is worse; raising it would move the cliff without removing it. What was wrong is that no caller could
 * SEE the cliff, so the fix is to publish it: a caller that lets a human pick the range bounds the range
 * against THIS constant and refuses politely, rather than issuing a read it knows will be cut short.
 * app/attendance/my-records/range.ts does exactly that, and test/attendance-overview-round1.test.ts pins
 * the two halves together — that the loop really does truncate at this number, and that the screen refuses
 * before it can.
 */
export const ATTENDANCE_RANGE_MAX_DAYS = 400;

/**
 * One row per calendar day in [from, to] for a SINGLE employment (Attendance>Records Individual tab,
 * 314ea061). The range analogue of attendanceForDate: an attendance row when present, else the context
 * (approved full-day leave > public holiday > rest day) that explains its absence. Read-only.
 *
 * ⚠️ TRUNCATES at ATTENDANCE_RANGE_MAX_DAYS calendar days and says nothing about it. A caller whose range
 * comes from a human must bound it against that constant first (see its comment).
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
      .select({
        companyId: employment.companyId,
        // bbada39c — surface the identity onto every row (the page previously sourced it from the dropdown).
        employeeCode: employment.employeeCode,
        name: person.fullName,
        // The employee's fixed DEFAULT shift, resolved once for the whole range.
        defShiftId: employment.defaultShiftId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
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
          // 7c834696 stage 1 — the stored per-day figures. NULL on every row that predates the engine that
          // computes them; the read-time derivations treat NULL as "fall back to the old routing".
          lateMinutes: attendance.lateMinutes,
          earlyOutMinutes: attendance.earlyOutMinutes,
          underMinutes: attendance.underMinutes,
          lateDeductMinutes: attendance.lateDeductMinutes,
          earlyOutDeductMinutes: attendance.earlyOutDeductMinutes,
          otFlatMinutes: attendance.otFlatMinutes,
          ot00Minutes: attendance.ot00Minutes,
          ot10Minutes: attendance.ot10Minutes,
          ot15Minutes: attendance.ot15Minutes,
          ot20Minutes: attendance.ot20Minutes,
          ot30Minutes: attendance.ot30Minutes,
          // 7c834696 point 3 — the working behind the figures above (see attendanceForDate for the why).
          calcTrace: attendance.calcTrace,
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
          workStart: attendancePolicy.workStart,
          workEnd: attendancePolicy.workEnd,
          breakMinutes: attendancePolicy.breakMinutes,
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
    // bbada39c — policy net scheduled minutes for the "Shift Hours" column on a policy (no-shift) working day.
    const policyScheduledMin = policyRows[0]
      ? scheduledMinutes({ ...DEFAULTS, workStart: policyRows[0].workStart, workEnd: policyRows[0].workEnd, breakMinutes: policyRows[0].breakMinutes })
      : scheduledMinutes(DEFAULTS);

    // bbada39c — BATCHED shift-display inputs for the range: all roster rows in [from,to] joined to their
    // shift, plus the one fixed default shift, resolved per date by resolveShiftDisplay (scheduleFor order).
    const rosterByDate = new Map<string, RosterDisplayRow>();
    for (const rr of await tx
      .select({
        shiftDate: rosterAssignment.shiftDate,
        isRestDay: rosterAssignment.isRestDay,
        code: shift.code,
        start: shift.startTime,
        end: shift.endTime,
        brk: shift.breakMinutes,
        crosses: shift.crossesMidnight,
        rounding: shift.normalHoursRoundingMinutes,
      })
      .from(rosterAssignment)
      .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(and(eq(rosterAssignment.employmentId, employmentId), gte(rosterAssignment.shiftDate, from), lte(rosterAssignment.shiftDate, to)))) {
      rosterByDate.set(rr.shiftDate, rr);
    }
    // 18504ca6 — the default shift is resolved PER DATE across the range, not once for the whole of it. The
    // Individual Records table is the screen the reporter would look at to answer "which shift was I on on
    // the 13th"; before this it answered with the shift the employee is on today for every row. Two batched
    // queries (the ladder, then the shifts it names) — the header's batching promise is unchanged. An
    // employment with no ladder row keeps the single cache lookup this replaced.
    const rangeShiftCols = {
      id: shift.id,
      code: shift.code,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      crosses: shift.crossesMidnight,
      pattern: shift.weeklyPattern,
      halfPattern: shift.halfPattern,
      offPattern: shift.offPattern,
      // 07ebd04d — the shift's Schedule Group, so this table's "was the employee scheduled that day"
      // reads the SAME working week scheduleFor does (migration 0483). Without it, a group whose week
      // differs from its shifts' would show Absent in red on a day the engine treated as a rest day.
      ruleId: shift.ruleId,
      rounding: shift.normalHoursRoundingMinutes,
    };
    const periods = await arrangementsForEmploymentTx(tx, employmentId);
    const periodShiftIds = [...new Set(periods.map((p) => p.shiftId))];
    const rangeShifts =
      periodShiftIds.length > 0 ? await tx.select(rangeShiftCols).from(shift).where(inArray(shift.id, periodShiftIds)) : [];
    const [cachedRangeRow] =
      periods.length === 0 && emp.defShiftId
        ? await tx.select(rangeShiftCols).from(shift).where(eq(shift.id, emp.defShiftId)).limit(1)
        : [];
    const [rangeEmpGroup] = await tx
      .select({ ruleId: employment.attendanceRuleId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    const rangeWeek = await weekLookupTx(
      tx,
      rangeEmpGroup?.ruleId,
      [...rangeShifts, ...(cachedRangeRow ? [cachedRangeRow] : [])].map((r) => r.ruleId),
    );
    const shiftById = new Map<string, DefaultShiftRow>();
    for (const sr of rangeShifts) shiftById.set(sr.id, { ...sr, ...rangeWeek(sr.ruleId, sr) });
    const cachedDefShift: DefaultShiftRow | undefined = cachedRangeRow
      ? { ...cachedRangeRow, ...rangeWeek(cachedRangeRow.ruleId, cachedRangeRow) }
      : undefined;
    const defShiftOn = (d: string): DefaultShiftRow | undefined => {
      const p = pickArrangementOn(periods, d);
      return p ? shiftById.get(p.shiftId) : cachedDefShift;
    };

    // e2632276 — the absence GATE for this one employment (see isScheduledOffDay). False until the
    // employment's assigned payroll policy sets `leave.deductAbsentDays`, and false ⇒ the rest-day test
    // below is `!isWorkingDay`, exactly as it was before this item.
    const deductAbsence = (await deductAbsentDaysByEmployment(tx, [employmentId])).has(employmentId);

    const out: AttendanceRangeRow[] = [];
    let d = from;
    // Guard against a pathological range; a first-of-month → today window is ≤ 31 days. The literal moved
    // to the exported ATTENDANCE_RANGE_MAX_DAYS above so a caller can bound its own range against the same
    // number instead of discovering the cliff as a short array (67268d83).
    for (let i = 0; i < ATTENDANCE_RANGE_MAX_DAYS && d <= to; i++) {
      const row = byDate.get(d);
      const isWorkingDay = workDays.includes(isoWeekday(d));
      let context: DayContext = null;
      if (!row) {
        if (leaveSet.has(d)) context = 'on_leave';
        else if (holidays.has(d)) context = 'holiday';
        // e2632276 — the ROSTER WINS once the deduction is on (same gate as attendanceForDate above; see
        // isScheduledOffDay). Off ⇒ `!isWorkingDay`, byte-identical to before.
        else if (isScheduledOffDay(d, rosterByDate.get(d), defShiftOn(d), isWorkingDay, deductAbsence))
          context = 'rest_day';
      }
      // bbada39c — per-date shift display (code / scheduled minutes / start-end / rostered-rest).
      const shiftDisplay = resolveShiftDisplay(d, rosterByDate.get(d), defShiftOn(d), isWorkingDay ? policyScheduledMin : null);
      out.push({
        date: d,
        attendanceId: row?.attendanceId ?? null,
        checkInAt: row?.checkInAt ?? null,
        checkOutAt: row?.checkOutAt ?? null,
        status: row?.status ?? null,
        dayType: row?.dayType ?? null,
        workedMinutes: row?.workedMinutes ?? null,
        otMinutes: row?.otMinutes ?? null,
        lateMinutes: row?.lateMinutes ?? null,
        earlyOutMinutes: row?.earlyOutMinutes ?? null,
        underMinutes: row?.underMinutes ?? null,
        lateDeductMinutes: row?.lateDeductMinutes ?? null,
        earlyOutDeductMinutes: row?.earlyOutDeductMinutes ?? null,
        otFlatMinutes: row?.otFlatMinutes ?? null,
        ot00Minutes: row?.ot00Minutes ?? null,
        ot10Minutes: row?.ot10Minutes ?? null,
        ot15Minutes: row?.ot15Minutes ?? null,
        ot20Minutes: row?.ot20Minutes ?? null,
        ot30Minutes: row?.ot30Minutes ?? null,
        calcTrace: row?.calcTrace ?? null,
        context,
        employeeCode: emp.employeeCode,
        name: emp.name,
        ...shiftDisplay,
      });
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
    return out;
  });
}

/** R45 92bdf77a — one punch (a single clock-in or clock-out) of a multi-clocking day. Feedback af552c5d
 *  (Clock In/Out redesign) added the punch's captured coordinates + the MATCHED clocking-location name
 *  (from the geofence resolution frozen on the punch row) so the clock screen can show where the punch
 *  was verified — all nullable: a punch written while geofencing was off carries no match. */
export type AttendancePunchRow = {
  attendanceId: string;
  punchAt: string;
  direction: 'in' | 'out';
  lat: number | null;
  lng: number | null;
  locationName: string | null;
};

/**
 * R45 92bdf77a — every punch for a SINGLE employment across [from, to], grouped by their day's attendanceId,
 * ordered by time. The Individual Attendance detail lists the full punch trail (labelled first / in-between /
 * last) while the hours/OT summary uses first-in / last-out only. Read-only: no DomainEvent (substrate skip).
 */
export function attendancePunchesForRange(
  ctx: SessionContext,
  employmentId: string,
  from: string,
  to: string,
): Promise<Map<string, AttendancePunchRow[]>> {
  return withTenant(ctx, async (tx) => {
    const byAttendance = new Map<string, AttendancePunchRow[]>();
    if (from > to) return byAttendance;
    const punches = await tx
      .select({
        attendanceId: attendancePunch.attendanceId,
        punchAt: attendancePunch.punchAt,
        direction: attendancePunch.direction,
        // af552c5d — per-punch capture + matched-site name for the clock screen's location display.
        lat: attendancePunch.lat,
        lng: attendancePunch.lng,
        locationName: clockingLocation.name,
      })
      .from(attendancePunch)
      .leftJoin(clockingLocation, eq(clockingLocation.id, attendancePunch.clockingLocationId))
      .where(
        and(
          eq(attendancePunch.employmentId, employmentId),
          gte(attendancePunch.attendanceDate, from),
          lte(attendancePunch.attendanceDate, to),
        ),
      );
    // Time-of-day order (first → last), the same order the summary uses for first-in / last-out.
    punches.sort((a, b) => toMinutes(a.punchAt) - toMinutes(b.punchAt));
    for (const pch of punches) {
      const list = byAttendance.get(pch.attendanceId) ?? [];
      list.push(pch);
      byAttendance.set(pch.attendanceId, list);
    }
    return byAttendance;
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

// 1e9145d4 — EXPORTED (was module-private). The Apply OT Plan form warns, before you submit, when a plan
// would take you past the statutory monthly ceiling, and it must warn against the SAME number the month
// summary flags on. One constant, two readers; nothing about the value or its use here changed.
export const OT_CAP_MINUTES = 104 * 60;
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
    const today = p.today ?? todayInKualaLumpur(); // absence only up to today (clamped in absence-days.ts)

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

    const rows = await tx
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
      );
    // e2632276 — the absence / leave-day counts are no longer derived here. They come from
    // core/absence-days.ts, the SAME helper the payroll deduction reads, so the number the month roll-up
    // prints and the number an employee is charged for can never drift apart.
    //
    // BUT THIS ROLL-UP IS MONEY, AND IT IS NOT THE DEDUCTION'S MONEY. `evaluateAllowancesForPeriod` →
    // `evaluateMonthly` (core/attendance-allowance.ts) gates a policy's `amount` on `present`, `absent`,
    // `late` and `leaveDays` straight off these rows. Every correction the `scheduled` rules make is
    // therefore a live change to who is paid an attendance allowance — landing on all nine companies the
    // day it deploys, with nobody having asked for it. The approved plan promises the opposite ("all 9 of
    // your companies keep behaving exactly as they do now until you turn it on"), so the corrections ride
    // behind the same switch the deduction does, resolved PER EMPLOYMENT off its assigned payroll policy:
    //
    //   OFF (every employment, day one) → `legacy`, a transcription of the loop that used to live right
    //       here. Company weekday pattern only; any attendance row means the day is spoken for; a
    //       partial-day leave date with no clock-in is an absence. Pinned byte-for-byte against a copy of
    //       main's algorithm over identical fixtures in test/absence-deduction.test.ts.
    //   ON  → `scheduled`, which differs in exactly four ways, all of them corrections:
    //       (a) an attendance row explicitly marked `status='absent'` is counted as ABSENT (legacy skipped
    //           every recorded date, and the tally below filed such a row under `present` — while the
    //           daily and individual screens have always shown it in red);
    //       (b) the ROSTER wins over the company weekday pattern, so a rostered rest day — or a
    //           default-shift pattern rest day — on a company working day is no longer an absence;
    //       (c) …and symmetrically a rostered SHIFT on a company non-working day now IS a scheduled day
    //           that can be absent;
    //       (d) an approved HALF-DAY or HOURLY leave date is no longer counted as a whole absent day.
    //
    // Two calls, not one, because the rule set is per employment. Each returns immediately on an empty id
    // list, so with the switch off nowhere — the shipped state — this is exactly one call, doing exactly
    // what the inline loop did.
    const deductAbsence = await deductAbsentDaysByEmployment(tx, empIds);
    const scheduledIds = empIds.filter((id) => deductAbsence.has(id));
    const legacyIds = empIds.filter((id) => !deductAbsence.has(id));
    const absence = new Map<string, AbsenceBreakdown>([
      ...(await absenceBreakdownByEmployment(tx, monthStart, monthEnd, legacyIds, {
        rules: 'legacy',
        until: today,
      })),
      ...(await absenceBreakdownByEmployment(tx, monthStart, monthEnd, scheduledIds, {
        rules: 'scheduled',
        until: today,
      })),
    ]);
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
        // e2632276 (a) — an explicit `absent` row is NOT a present day. It used to fall into this `else`
        // and inflate `present` while the same row rendered red as "Absent" on every other screen. Once
        // the switch is on it is counted by the `scheduled` breakdown instead, so nothing is counted
        // twice; with the switch OFF the row stays under `present`, exactly as it does in production —
        // `present` feeds evaluateMonthly's minAttendanceDays, so moving it un-gated would withhold
        // allowances nobody decided to withhold.
        else if (!(r.status === 'absent' && deductAbsence.has(e.employmentId))) present += 1;
        workedMinutes += r.workedMinutes ?? 0;
        const ot = r.otMinutes ?? 0;
        if (r.dayType === 'rest_day') otRestDay += ot;
        else if (r.dayType === 'holiday') otHoliday += ot;
        else otWorkday += ot;
        const wk = mondayOf(r.date);
        weekMinutes.set(wk, (weekMinutes.get(wk) ?? 0) + (r.workedMinutes ?? 0));
      }

      // e2632276 — one definition, shared with payroll (see the note above the call).
      const { absentDays: absent, leaveDays } = absence.get(e.employmentId) ?? { absentDays: 0, leaveDays: 0 };

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

export type OtApprovalMethod = 'requested' | 'system_calculated' | 'smaller_of' | 'greater_of';

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
    // 7c834696 stage 1 — the request has always listed four options; ADR-0069 shipped three. Nothing else
    // about the resolution changes, and the default stays system_calculated.
    case 'greater_of':
      return Math.max(0, Math.max(Math.trunc(requested), Math.trunc(sys)));
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
export class AttendanceCorrectionFutureDateError extends Error {
  constructor() { super('Future dates cannot be corrected.'); }
}
export class AttendanceCorrectionPendingError extends Error {
  constructor() { super('A correction is already pending for this date.'); }
}

export async function requestAttendanceCorrection(
  ctx: SessionContext,
  p: {
    employmentId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    requestedOtMinutes?: number | null;
    reason?: string;
    // 1e9145d4 Plan OT — the planned window and the reason category the Apply OT Plan form collects. All
    // optional: every existing caller (the clock-correction form, the tests, the import paths) omits them
    // and stores NULL, which is byte-identical to before.
    plannedStartTime?: string | null;
    plannedEndTime?: string | null;
    otReasonCategory?: OtReasonCategory | null;
    // 2166ef79 My Attendance stage one — the optional note beside the mandatory reason, and which of the
    // four sections the request was filed from. Both optional at every layer: every existing caller (the
    // OT form, the tests, the import paths) omits them and stores NULL, which is byte-identical to before.
    remark?: string | null;
    requestKind?: AttendanceRequestKind | null;
  },
) {
  const checkIn = p.checkIn ?? null;
  const checkOut = p.checkOut ?? null;
  const hasOt = p.requestedOtMinutes != null;
  if ((checkIn || checkOut) && p.date > todayInKualaLumpur()) {
    throw new AttendanceCorrectionFutureDateError();
  }
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
  // 1e9145d4 — the planned window, when the form supplies one. Validated the same way the punch pair is:
  // an end before or equal to its start is a typo, not a cross-midnight plan (the hours figure the form
  // shows is derived from these two, so an inverted pair would display a negative). Both-or-neither.
  const plannedStartTime = p.plannedStartTime || null;
  const plannedEndTime = p.plannedEndTime || null;
  if ((plannedStartTime == null) !== (plannedEndTime == null)) {
    throw new Error('A planned overtime window needs both a start time and an end time.');
  }
  if (plannedStartTime && plannedEndTime && toMinutes(plannedEndTime) <= toMinutes(plannedStartTime)) {
    throw new Error('The planned end time must be after the planned start time.');
  }
  const otReasonCategory = p.otReasonCategory ?? null;
  // 2166ef79 — the remark is OPTIONAL and stays optional in stage one: the reporter's "Require Remark"
  // switch belongs to the Attendance Request Settings screen, which is deliberately stage two. An empty
  // string stores as NULL rather than as a blank note nobody wrote.
  const remark = (p.remark ?? '').trim() || null;
  const requestKind = p.requestKind ?? null;

  return withTenant(ctx, async (tx) => {
    // 1e9145d4 — ONE APPROVED PLAN PER DATE. attendance_correction_one_pending_uq is partial (WHERE status =
    // 'pending'), so it stops two WAITING requests for a date but NOT a second request once the first is
    // approved. That was harmless while approval could only happen after the day was worked. It is not
    // harmless now: approve plan A, file plan B for the same date, approve B, and there are two approved
    // unapplied rows while "find the approved, not-yet-applied plan" has no defined answer. Refused here at
    // the application layer with a message a human can act on, rather than by a second partial unique index
    // — that index would also have to exclude cancelled AND applied rows, which is more fragile.
    //
    // ec30b2e9 (r364) — AND THE SENTENCE ABOVE WAS ONLY HALF THE RULE. It said the first request stops a
    // second one "once the first is approved"; what it actually built stops one only while the first is
    // approved AND UNAPPLIED. It read as though approved-and-applied were unreachable here. It is the
    // COMMON case: every past-dated approval lands and stamps applied_at at approval time. The second
    // check below closes that, and the rest of the reasoning — application layer, not a second partial
    // index — is unchanged and is why there is still no migration.
    if (hasOt) {
      const live = await liveOtPlanTx(tx, p.employmentId, p.date);
      if (live) {
        // r364 — WAS a raw English `throw new Error(...)` whose message reached the screen verbatim through
        // `?error=`. Same refusal, same wording, now typed so the action can print it in the employee's own
        // language (`me.otPlanApprovedNotCounted`). The sentence is not a guard being loosened: it still
        // names the date and still says to withdraw the first plan.
        throw new OvertimePlanAlreadyApprovedError(p.date);
      }
      // ── ec30b2e9 (r364) · AND THE HOLE THAT LEFT: APPROVED **AND ALREADY COUNTED** ──────────────────
      // The guard above only closes the window in which an approved plan is still waiting for its day. For
      // a date that is today or past — which is every date on which a first plan can already have landed —
      // approval LANDS the hours and stamps `applied_at` in the same transaction, so that window is never
      // open and a second plan was accepted. Approving it then REPLACED ot_minutes outright.
      //
      // ⚠️ `checkIn == null` IS LOAD-BEARING AND MUST NOT BE DROPPED. This block is `hasOt`, and `hasOt` is
      // ALSO true of a CLOCK CORRECTION that carries an OT figure — which is precisely the route the refusal
      // below tells the employee to use. Widening this to every OT-bearing request would refuse the remedy
      // in the same breath as recommending it, and the message would be a lie. An OT-ONLY request (no
      // proposed clock-in) is a PLAN; anything carrying punches is a correction and passes straight through.
      // Pinned by test/plan-ot.test.ts §4, whose (b) case exists for no other purpose.
      //
      // d16237da (r366) — WHAT THE HELPER NOW ANSWERS. `countedOtPlanTx` used to count only a day counted
      // by an earlier PLAN; it now counts a day counted by ANY approved, applied, OT-bearing decision,
      // including the clock correction this refusal recommends. That widening belongs in the helper and
      // NOT here: the gate on this line is the only thing keeping the recommended route open, so the two
      // reads must stay separate. See the helper's own note.
      if (checkIn == null) {
        const counted = await countedOtPlanTx(tx, p.employmentId, p.date);
        if (counted) throw new OvertimeAlreadyCountedError(p.date);
      }
      // ── r336 cbfa8b0b · DIRECTION 2 OF THE DOUBLE-CLAIM CHECK ────────────────────────────────────────
      // The same worked day is cash XOR time in lieu. core/payroll.ts already enforces that once a credit
      // is BANKED (`EXCLUDE_TOIL_BANKED_DAYS`), but between submission and approval both sides were open:
      // an employee could file an overtime claim and a Leave Credit claim for the same date and have
      // whichever approved second quietly win. This refuses the second claim at the door.
      //
      // ONLY ON THE OT BRANCH, and only where `requestedOtMinutes` is present. A plain clock-time
      // correction (a forgotten punch) is not a claim on the day's hours and must stay filable on a date
      // whose credit is pending — refusing it would make a live credit claim un-correctable.
      //
      // THE PREDICATE IS SHARED, NOT MIRRORED. `assertNoCreditClaimForDatesTx` is the same module
      // core/replacement-request.ts asks the opposite question of, so "pending and approved block;
      // rejected and cancelled release" is defined once. See core/credit-ot-overlap.ts.
      if (requestedOtMinutes != null && requestedOtMinutes > 0) {
        await assertNoCreditClaimForDatesTx(tx, p.employmentId, [p.date]);
      }
    }
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
        plannedStartTime,
        plannedEndTime,
        otReasonCategory,
        remark,
        requestKind,
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
        plannedStartTime,
        plannedEndTime,
        otReasonCategory,
        remark,
        requestKind,
      },
    });
    return { correctionId: row.id };
  }).catch((error: unknown) => {
    // Preserve the database's atomic pending-request fence, including simultaneous submissions.
    let cause: unknown = error;
    for (let depth = 0; cause && typeof cause === 'object' && depth < 5; depth++) {
      const dbError = cause as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
      if (dbError.code === '23505' && (dbError.constraint_name ?? dbError.constraint) === 'attendance_correction_one_pending_uq') {
        throw new AttendanceCorrectionPendingError();
      }
      cause = dbError.cause;
    }
    throw error;
  });
}

/**
 * 2166ef79 — attach ONE supporting file to an attendance request. Mirrors addLeaveAttachment (core/leave.ts)
 * and addResignationAttachment: the file is written to a bytea side table, never onto the request row.
 *
 * WHILE PENDING ONLY. A file added to a request somebody has already decided would be evidence the approver
 * never saw, filed under their decision — so it is refused, exactly as leave refuses it.
 *
 * The ceiling and the accepted types are FIXED in stage one (5 MB, images + PDF). Making them configurable
 * is "Require Attachment / attachment rules" on the Attendance Request Settings screen, which is stage two;
 * a fixed, stated limit is honest, a silently-unbounded upload is not.
 */
export const ATTENDANCE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTENDANCE_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export async function addAttendanceCorrectionAttachment(
  ctx: SessionContext,
  p: { correctionId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new Error('That file is empty.');
  if (p.content.byteLength > ATTENDANCE_ATTACHMENT_MAX_BYTES) {
    throw new Error('That file is larger than 5 MB.');
  }
  if (!(ATTENDANCE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(p.mimeType)) {
    throw new Error('That file type is not accepted — attach a photo or a PDF.');
  }
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select({ employmentId: attendanceCorrection.employmentId, status: attendanceCorrection.status })
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!req) throw new Error('attendance request not found (or not visible)');
    if (req.status !== 'pending') throw new Error('A file can only be attached while the request is waiting.');
    const [row] = await tx
      .insert(attendanceCorrectionAttachment)
      .values({
        tenantId: ctx.tenantId,
        attendanceCorrectionId: p.correctionId,
        employmentId: req.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: attendanceCorrectionAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: p.correctionId,
      eventType: 'attendance-correction.document.attached',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** The supporting file on an attendance request, for the download route. RLS-fenced (subject + manager +
 *  admin via can_see_employment), so this needs no gate of its own — the policy IS the gate. */
export function getAttendanceCorrectionAttachment(ctx: SessionContext, correctionId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: attendanceCorrectionAttachment.content,
        fileName: attendanceCorrectionAttachment.fileName,
        mimeType: attendanceCorrectionAttachment.mimeType,
      })
      .from(attendanceCorrectionAttachment)
      .where(eq(attendanceCorrectionAttachment.attendanceCorrectionId, correctionId))
      .orderBy(desc(attendanceCorrectionAttachment.createdAt))
      .limit(1);
    return row ?? null;
  });
}

/**
 * ─── r368 · c8282468 · THE PRE-IMAGE OF A CORRECTED DAY ─────────────────────────────────────────────
 *
 * The caption under the admin correction form promised HR that a correction records "the previous value".
 * It did not. `decideAttendanceCorrection` wrote the day with a blind `insert … onConflictDoUpdate` that
 * never read the existing row, `.returning` took the id only, and the `attendance.amended` payload was
 * after-values only — so the figure a correction replaced was destroyed UNREAD, and nothing anywhere
 * could say afterwards what the day used to hold. No history table, no before column, no spelling of
 * previousValue in the repo. This projection is the read that stops that.
 *
 * WHERE THE PREVIOUS VALUE GOES: a TOP-LEVEL `{ before, after }` pair on the existing `attendance.amended`
 * payload, in the same transaction as the write. NOT a column and NOT a history table — ADR-0069 already
 * declined a stored snapshot column on `attendance_correction` by name (db/schema.ts), so a column would
 * fight an existing decision; an event payload does not. It is also the repo's dominant convention across
 * ~60 `appendEvent` sites, and the closest precedent is one module away: `core/attendance-recompute.ts`
 * puts `{ before, after }` on `attendance.recomputed`. The worked discipline is
 * `localization/my/statutory.ts` — read the pre-image into a named local FIRST, write, then emit named
 * before/after blocks ADDITIVELY, never moving the existing after-only keys.
 *
 * TWO HARD CONSTRAINTS FROM `describePayload` (lib/audit-format.ts), and breaking either loses the render:
 *   · `before` and `after` must sit at the TOP LEVEL. A nested block falls through to the flat-key dump
 *     and renders as one JSON string truncated at 120 characters.
 *   · both sides must carry the SAME KEY SET, because the diff is per key. ONE projection is used for both
 *     sides for exactly this reason: two hand-written shapes drift, and the trail then silently stops
 *     showing a column.
 *
 * `after` IS RE-READ FROM THE ROW, never assembled from the values passed to the write. On the clock
 * branch `applyApprovedOtPlanTx` runs AFTER the upsert and can re-assert `ot_minutes` and its six split
 * columns; an assembled `after` would report a figure that is not on the row.
 *
 * WHAT IT COVERS — every column the correction's upsert writes, and nothing else:
 *   · the clock times, the status and the day type;
 *   · worked and overtime minutes, and the six per-rate OT split columns;
 *   · the stage-1 measured and deducted minutes, and `calcTrace` — the stored WORKING behind them, which
 *     a correction replaces and which cannot be re-derived from the figures beside it;
 *   · `remarks`;
 *   · AND THE 14 GEO/METHOD COLUMNS A CORRECTION NULLS, seven per punch. Nulling them is ADR-0070 and is
 *     deliberate and right — a time typed in by HR has no location behind it — but it DESTROYS a geofence
 *     attestation, and until now it did so silently: db/schema.ts records the deliberate half only. They
 *     are in the before-image so the diff SHOWS the loss; `after` carries the same keys as nulls.
 *
 * NOT `absenceReason`: the upsert does not write it. A before-image wider than the write would assert a
 * change that never happened.
 */
const AMENDED_FIGURE_COLUMNS = {
  checkInAt: attendance.checkInAt,
  checkOutAt: attendance.checkOutAt,
  status: attendance.status,
  dayType: attendance.dayType,
  workedMinutes: attendance.workedMinutes,
  otMinutes: attendance.otMinutes,
  // stage1Columns(), column for column.
  calcTrace: attendance.calcTrace,
  lateMinutes: attendance.lateMinutes,
  earlyOutMinutes: attendance.earlyOutMinutes,
  underMinutes: attendance.underMinutes,
  lateDeductMinutes: attendance.lateDeductMinutes,
  earlyOutDeductMinutes: attendance.earlyOutDeductMinutes,
  // otSplitColumns(), column for column — the OT-only branch writes these six and nothing else.
  otFlatMinutes: attendance.otFlatMinutes,
  ot00Minutes: attendance.ot00Minutes,
  ot10Minutes: attendance.ot10Minutes,
  ot15Minutes: attendance.ot15Minutes,
  ot20Minutes: attendance.ot20Minutes,
  ot30Minutes: attendance.ot30Minutes,
  remarks: attendance.remarks,
  // ADR-0070 geo capture, seven per punch. Destroyed by every clock correction; see the note above.
  checkInMethod: attendance.checkInMethod,
  checkInLat: attendance.checkInLat,
  checkInLng: attendance.checkInLng,
  checkInClockingLocationId: attendance.checkInClockingLocationId,
  checkInDistanceM: attendance.checkInDistanceM,
  checkInGeofenceStatus: attendance.checkInGeofenceStatus,
  checkInRadiusM: attendance.checkInRadiusM,
  checkOutMethod: attendance.checkOutMethod,
  checkOutLat: attendance.checkOutLat,
  checkOutLng: attendance.checkOutLng,
  checkOutClockingLocationId: attendance.checkOutClockingLocationId,
  checkOutDistanceM: attendance.checkOutDistanceM,
  checkOutGeofenceStatus: attendance.checkOutGeofenceStatus,
  checkOutRadiusM: attendance.checkOutRadiusM,
};

/** Every key of the pair, exported so a guard can assert the two sides agree without restating the list. */
export const AMENDED_FIGURE_KEYS = Object.keys(AMENDED_FIGURE_COLUMNS) as readonly string[];

export type AmendedFigures = { [K in keyof typeof AMENDED_FIGURE_COLUMNS]: unknown };

/** The day's figures BY (employment, date) — the pair the correction's upsert targets, and the only handle
 *  available before the row exists. `null` means NO ROW EXISTED, which is not an empty object and not a row
 *  of nulls: "nothing was recorded" and "an explicit zero" are different befores, so `before: null` is the
 *  honest answer and `describePayload` renders each key as "— → value" from it. */
async function attendanceFiguresTx(tx: Tx, employmentId: string, date: string): Promise<AmendedFigures | null> {
  const [row] = await tx
    .select(AMENDED_FIGURE_COLUMNS)
    .from(attendance)
    .where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date)))
    .limit(1);
  return row ?? null;
}

/** The same projection BY ROW ID, for the after-image and for `applyApprovedOtPlanTx` (which is handed the
 *  attendance id). Exact rather than re-resolving (employment, date) after a write. */
async function attendanceFiguresByIdTx(tx: Tx, attendanceId: string): Promise<AmendedFigures | null> {
  const [row] = await tx
    .select(AMENDED_FIGURE_COLUMNS)
    .from(attendance)
    .where(eq(attendance.id, attendanceId))
    .limit(1);
  return row ?? null;
}

/** Decide a correction. Approval upserts the attendance row with the proposed punches,
 *  re-derived through the time engine (so corrected OT flows to payroll). No self-approval.
 *
 *  1e9145d4 — an OT-only request for a FUTURE date is now APPROVABLE. It used to throw ("No attendance
 *  record exists for this date to attach overtime to"), which made the pre-approval the Overtime Request
 *  form has always advertised impossible in practice. Such an approval is DEFERRED: the agreed figure and
 *  the resolution rule are stamped on the plan and attendance is left alone, and the hours land later,
 *  when the day is worked (applyApprovedOtPlanTx). Everything else — every clock correction, and every
 *  OT request dated today or earlier — behaves exactly as it did. `today` is injectable for tests only. */
export async function decideAttendanceCorrection(
  ctx: SessionContext,
  p: { correctionId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string; today?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cor] = await tx
      .select()
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!cor) throw new Error('correction request not found (or not visible)');
    if (cor.status !== 'pending') throw new Error(`correction request is already ${cor.status}`);

    await assertCanDecide(tx, ctx, cor.employmentId, 'attendance correction', scopeOf('attendance.correction'));

    // 1e9145d4 — true when this approval was HELD ON THE PLAN rather than written to an attendance day.
    // Surfaced in the decision event's payload and in the return value, so a caller (and an auditor) can
    // tell "approved and counted" from "approved, waiting for the day".
    let deferredApproval = false;

    if (p.decision === 'approved') {
      const sched = await scheduleFor(tx, cor.employmentId, cor.attendanceDate);
      const dayType = sched.dayType;
      const hasClockCorrection = cor.proposedCheckIn != null;
      const hasOtRequest = cor.requestedOtMinutes != null;
      // 1e9145d4 — THE DEFERRED CASE, and the whole point of the item. An OT-only plan for a day that has
      // not happened yet cannot be measured against anything and must not create an attendance row (see the
      // section header above for why a placeholder row would corrupt the month summary and the payroll
      // prefill). The discriminator is the DATE, not "is there an attendance row": a past-dated OT request
      // with no attendance row keeps throwing exactly as it does today, because that is a genuine mistake
      // (overtime claimed for a day with no recorded work) and holding that line is the regression contract.
      const deferred = !hasClockCorrection && hasOtRequest && cor.attendanceDate > (p.today ?? todayInKualaLumpur());

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
        if (deferred) {
          // Nothing has been clocked, so there is NO comparison figure and resolving one now would be
          // fiction: under `system_calculated` or `smaller_of` a null system figure reads as zero, and the
          // plan would be stamped "approved: 0 hours" the moment the manager clicked approve. What is
          // stamped instead is the figure the approver actually agreed to — the requested one — together
          // with the rule (`otApprovalMethod`) that will resolve it for real against the clocked hours when
          // the day is worked. applyApprovedOtPlanTx overwrites approvedOtMinutes with that final figure.
          systemOtForComparison = null;
          approvedOtMinutes = Math.max(0, Math.trunc(cor.requestedOtMinutes!));
        } else if (hasClockCorrection) {
          systemOtForComparison = deriveAttendance(sched, cor.proposedCheckIn!, cor.proposedCheckOut, cor.attendanceDate).otMinutes;
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
              ? deriveAttendance(sched, existing.checkInAt, existing.checkOutAt, cor.attendanceDate).otMinutes
              : null;
        }
        // The deferred branch above has already set approvedOtMinutes to the agreed (requested) figure and
        // deliberately does NOT resolve — there is nothing to resolve against until the day is worked.
        if (!deferred) {
          approvedOtMinutes = resolveApprovedOt(cor.requestedOtMinutes!, systemOtForComparison, otApprovalMethod);
        }
      }

      // ── r368 c8282468 · THE PRE-IMAGE, READ BEFORE ANYTHING IS WRITTEN ──────────────────────────────
      // ⚠️ THIS READ MUST STAY ABOVE THE BRANCH DISPATCH. Everything below it writes: the clock branch
      // upserts the whole day, the OT-only branch updates ot_minutes and its split. Move this line under
      // either of them and `before` becomes a copy of `after` — green tests, and an audit trail that
      // silently says nothing changed. See AMENDED_FIGURE_COLUMNS above for what it covers and why the
      // geo columns are in it.
      //
      // Skipped for a DEFERRED approval, which writes nothing to attendance and emits no
      // `attendance.amended` at all: its before/after is taken at the moment the plan LANDS, in
      // applyApprovedOtPlanTx, because that is the moment a figure actually moves.
      const beforeFigures = deferred ? null : await attendanceFiguresTx(tx, cor.employmentId, cor.attendanceDate);

      let amendedId: string | null = null;
      let eventPayload: Record<string, unknown>;

      if (deferred) {
        // NOTHING IS WRITTEN TO ATTENDANCE. The decision is recorded on the plan (the stamp below) and the
        // hours are applied when the day materialises. Deliberately no `attendance.amended` event either:
        // no attendance row was amended, and there is no aggregateId to hang one on. The audit for this
        // moment is the `attendance-correction.approved` event at the foot of this function, whose payload
        // carries the deferral facts.
        eventPayload = {
          correctionId: cor.id,
          date: cor.attendanceDate,
          dayType,
          deferredToDate: cor.attendanceDate,
        };
      } else if (hasClockCorrection) {
        const d = deriveAttendance(sched, cor.proposedCheckIn!, cor.proposedCheckOut, cor.attendanceDate);
        // When OT was also requested, the approved (policy-adjusted) OT OVERRIDES the derived figure.
        // `let`, not `const`: 1e9145d4 re-asserts a landed OT plan's hours after the upsert below, and the
        // event payload has to report the figure that actually ended up on the row.
        let otMinutes = hasOtRequest ? approvedOtMinutes : d.otMinutes;
        // 7c834696: when an approved OT figure OVERRIDES the engine's, the per-rate split has to be taken
        // from the figure actually stored, or the buckets would stop summing to ot_minutes on exactly the
        // days a human intervened. The measured lateness/early-out/short-hours come from the corrected
        // punches (d) and are unaffected by the OT override.
        const stage1 = {
          ...stage1Columns(d),
          ...otSplitColumns(otMinutes == null ? null : splitOtMinutes(otMinutes, dayType, sched.rule)),
        };
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
            ...stage1,
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
              ...stage1,
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
        // 1e9145d4 — an approved clock correction RE-DERIVES the day from the proposed punches, which would
        // quietly wipe the hours of an OT plan that had already landed on it. Re-assert them (and, if the
        // correction is what finally gives the day its punches, LAND a plan that was waiting for exactly
        // that). Skipped when this correction carries its own OT figure: the human who approved it decided
        // the day's overtime a moment ago and that decision wins.
        if (!hasOtRequest) {
          const planned = await applyApprovedOtPlanTx(tx, ctx, {
            employmentId: cor.employmentId,
            date: cor.attendanceDate,
            attendanceId: amended.id,
            sched,
            systemOtMinutes: d.otMinutes,
          });
          if (planned != null) otMinutes = planned;
        }
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
          // 1e9145d4: reachable ONLY for a date that is today or in the past — a future-dated plan took the
          // deferred branch above and never gets here. So this still means what it has always meant:
          // overtime is being claimed for a day on which no work was ever recorded.
          throw new Error('No attendance record exists for this date to attach overtime to.');
        }
        await tx
          .update(attendance)
          // 7c834696: the punches are untouched here, so lateness / early-out / short-hours keep whatever
          // the engine already derived. Only the OT total moved, so only its split is rewritten — and it is
          // rewritten from the stored figure, keeping the buckets summing to ot_minutes.
          .set({
            otMinutes: approvedOtMinutes,
            ...otSplitColumns(
              approvedOtMinutes == null ? null : splitOtMinutes(approvedOtMinutes, dayType, sched.rule),
            ),
          })
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
          .set({
            approvedOtMinutes,
            otApprovalMethod,
            // 1e9145d4 — applied_at means ONE thing: "these hours are on the attendance day". The IMMEDIATE
            // path just put them there, so it stamps it too; only a DEFERRED approval leaves it null,
            // because only a deferred approval has not landed.
            //
            // THIS IS NOT COSMETIC. Leave it null on the immediate path and an already-counted approval
            // still matches "approved, unapplied" — so (a) otMonthToDateMinutes would add its minutes to
            // the attendance row's own, double-counting them against the 104-hour ceiling, and (b) the
            // next clock-out of that day would LAND it a second time, re-resolving a figure a human had
            // already agreed and re-running the replacement-leave accrual. Both are silent.
            ...(deferred ? {} : { appliedAt: sql`now()` }),
          })
          .where(eq(attendanceCorrection.id, cor.id));
        eventPayload = {
          ...eventPayload,
          requestedOtMinutes: cor.requestedOtMinutes,
          systemCalculatedOtMinutes: systemOtForComparison,
          approvedOtMinutes,
          otApprovalMethod,
        };
      }

      // 1e9145d4 — only when an attendance row was actually amended. A deferred approval touched none.
      if (amendedId != null) {
        // r368 c8282468 — the AFTER image, re-read from the row rather than assembled from what we passed
        // to the write. `applyApprovedOtPlanTx` above can re-assert ot_minutes and its six split columns
        // after the upsert, so the row is the only thing that knows what the day now says.
        const afterFigures = await attendanceFiguresByIdTx(tx, amendedId);
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'attendance',
          aggregateId: amendedId,
          eventType: 'attendance.amended',
          actor: actorOf(ctx),
          subjectEmploymentId: cor.employmentId,
          // ⚠️ ADDITIVE, AND `before`/`after` ARE TOP-LEVEL. The after-only keys `eventPayload` already
          // carried (correctionId, date, checkIn, checkOut, status, dayType, workedMinutes, otMinutes and
          // the four OT-approval keys) are KEPT AND UNMOVED: a consumer of the event stream reads them,
          // and the same "add beside, never relocate" rule localization/my/statutory.ts states for the EPF
          // election applies here. Nesting the pair would drop describePayload through to the flat dump and
          // render it as JSON truncated at 120 characters.
          payload: { ...eventPayload, before: beforeFigures, after: afterFigures },
        });
      }

      // *** 1e9145d4 — THE SILENT REGRESSION GUARD. READ THIS BEFORE TOUCHING THE CONDITION. ***
      //
      // For a DEFERRED approval the accrual below MUST NOT run here, and it must not simply be dropped
      // either. accrueToilTx reads the attendance row for the day and throws ToilNoOvertimeError when there
      // is none or ot_minutes <= 0 — and that error is SWALLOWED (see the helper) so auto-accrual can never
      // block an approval. Leave the call where it is and pre-approving a rest-day or public-holiday plan
      // would silently stop minting the replacement-leave credit that the very same approval mints today:
      // no error, no log, nothing, until an employee asks where their day went. So for the deferred case
      // the accrual MOVES to applyApprovedOtPlanTx, which runs it after the hours land on a real day — with
      // this correction's own created_at still supplied as `requestedOn`, so the credit's Request Date stays
      // the employee's request date. The immediate path keeps calling it exactly where it always has.
      if (!deferred) {
        // RL Control Engine (0113): auto-create the replacement-leave credit when this is the only reviewed
        // attendance-decision path. The approver above already passed assertCanDecide, so the auto-accrual runs
        // with requireDecideAuth:false (re-checking would hard-throw). It self-gates on dayType ∈ {rest_day,
        // holiday}, otMinutes>0, TOIL_ENABLED, and the company's enabled + autoAccrueOnApproval policy; eligibility
        // refusals are swallowed so auto-accrual NEVER blocks an approval. Skipped silently otherwise. Per ADR-0069
        // it reads the POLICY-ADJUSTED attendance.otMinutes written above (single source of truth).
        //
        // r334 928f0454 — "dayType ∈ {rest_day, holiday}" ABOVE IS NO LONGER THE WHOLE GATE, and the sentence
        // is left standing rather than quietly rewritten because it is still the gate for every company that
        // has not opted in. A company with `toil_policy.extended_hours_enabled` on also admits an ORDINARY
        // WORKING DAY here, where the hours past the scheduled shift end are tiered into a 0.5 / 1.0-day
        // credit; `maybeAutoAccrueOnApprovalTx` reads that flag itself (it had to move its day-type filter
        // BELOW the policy read to do so) and `accrueToilTx` re-checks it. Nothing changes for a company with
        // the switch off, which is every company on release. ⚠️ MONEY: such a credit suppresses that day's
        // overtime pay, so this call now reaches the payslip on a workday too.
        await maybeAutoAccrueOnApprovalTx(tx, ctx, {
          employmentId: cor.employmentId,
          workedDate: cor.attendanceDate,
          dayType,
          // 00307068: THIS correction is the employee's request for the credit, so its own creation date is
          // the credit's Request Date. Passed rather than re-queried inside the accrual because the status
          // flip to 'approved' happens BELOW this call — a lookup would still see 'pending' and could not
          // identify the row it was looking for.
          // ⚠️ THE KUALA LUMPUR DATE, NOT THE UTC ONE (r324). This read `cor.createdAt.toISOString()`,
          // which is a DATE DERIVED FROM AN INSTANT IN UTC — the thing CLAUDE.md §8 forbids, and the
          // exact defect r299 fixed one line away in core/toil.ts for `approvedOn`. For any correction
          // filed between midnight and 08:00 in Malaysia it stamped the credit's Request Date A DAY
          // EARLY, while the EXPIRY on the very same row was resolved in KL — so one accrual carried two
          // dates that disagreed about what day it was. Found by a gate run that happened to start at
          // 01:07 MYT; it passes for sixteen hours out of every twenty-four.
          requestedOn: todayInKualaLumpur(cor.createdAt),
        });
      }
      deferredApproval = deferred;
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
      payload: {
        decision: p.decision,
        deciderEmploymentId: p.deciderEmploymentId ?? null,
        // 1e9145d4 — `overtime` tells a consumer which KIND of request was decided. The notification
        // registry needs it: this one event type covers both an overtime plan and a clock-time correction,
        // and a notice headed "Overtime plan approved" on somebody's forgotten clock-out would be wrong.
        // Nothing else in the payload distinguishes them.
        overtime: cor.requestedOtMinutes != null,
        // The deferral facts. `deferred` says the hours were NOT written to a day; `date` and
        // `approvedOtMinutes` say which day they are waiting for and how many were agreed. This is the only
        // audit record of a deferred approval, because no attendance row was amended.
        ...(deferredApproval
          ? { deferred: true, date: cor.attendanceDate, approvedOtMinutes: cor.requestedOtMinutes }
          : {}),
      },
    });
    return { status: p.decision, deferred: deferredApproval };
  });
}

/** Correction inbox — RLS trims to what the viewer may see (admin all in scope, manager
 *  their reports, employee their own). Recent first. */
export function listAttendanceCorrections(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
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
        // ADR-0069 / R45 3707cba9 — surface the "Actual vs Approved" OT comparison the decide path already
        // computes. systemOtMinutes = the OT the engine derived from the day's real clockings (the row's
        // stored figure); otApprovalCalculation = the company rule that turns it + the request into the
        // approved figure. The approver page previews the resolved figure with resolveApprovedOt().
        systemOtMinutes: attendance.otMinutes,
        otApprovalCalculation: attendancePolicy.otApprovalCalculation,
      })
      .from(attendanceCorrection)
      .innerJoin(employment, eq(employment.id, attendanceCorrection.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        attendance,
        and(
          eq(attendance.employmentId, attendanceCorrection.employmentId),
          eq(attendance.attendanceDate, attendanceCorrection.attendanceDate),
        ),
      )
      .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
      .where(
        and(
          opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(attendanceCorrection.createdAt))
      .limit(100);
    // R51 (baf56348): trim delegation-routed rows whose subject is outside the delegation's org coverage
    // from the approver-facing list (a no-op for rows the caller sees in their own right).
    return filterDelegationOrgScopeTx(tx, ctx, rows, (r) => r.employmentId);
  });
}

// ═══════════════════ 1e9145d4 · Plan OT — overtime agreed BEFORE it is worked ═══════════════════
//
// READ THIS BEFORE CHANGING ANYTHING BELOW. A "plan" is not a new record type: it is the ADR-0069 OT-only
// attendance_correction (no proposed punches, `requested_ot_minutes` set) that has existed since R45. What
// this section adds is the ability to APPROVE ONE BEFORE ITS DATE, which decideAttendanceCorrection has
// always refused ("No attendance record exists for this date to attach overtime to") because there is no
// attendance row for a day nobody has worked.
//
// The fix is to SPLIT APPROVAL FROM APPLICATION:
//   • APPROVAL of a FUTURE-dated OT-only request stamps the agreed figure + the company's resolution method
//     on the correction row and touches nothing else. No placeholder attendance row is created — see the
//     migration 0424 header for why one would corrupt attendanceMonthSummary and the payroll prefill.
//   • APPLICATION happens when the day materialises: every attendance write path that finalises a day
//     (clock-out, terminal import, an approved clock correction) calls applyApprovedOtPlanTx, which resolves
//     the agreed figure against what was ACTUALLY clocked using attendance_policy.ot_approval_calculation —
//     the same rule the immediate path has always used — and writes ot_minutes + the per-rate split.
//   • PAST-DATED approvals keep today's immediate behaviour BYTE-IDENTICAL. That is the regression line.
//
// THE SILENT REGRESSION THIS DESIGN WOULD OTHERWISE CREATE. decideAttendanceCorrection calls
// maybeAutoAccrueOnApprovalTx (the 0113 RL Control Engine) to mint the replacement-leave credit that rest-day
// / public-holiday overtime earns. That helper reads the attendance row and throws ToilNoOvertimeError when
// there is none — and the caller deliberately SWALLOWS that error so auto-accrual never blocks an approval.
// So a naive deferred branch would silently stop creating the credit, with no error anywhere, and nobody
// would notice until an employee asked where their day went. The accrual therefore MOVES to the application
// step for the deferred case (and only for it), carrying the correction's own created_at as `requestedOn`
// so the credit's Request Date stays the employee's request date rather than the clock-out date (00307068).

/** The three day classifications a plan can be filed against. Same vocabulary as attendance.day_type. */
export type PlanOtDayType = 'workday' | 'rest_day' | 'holiday';

/** One row of the Plan OT list. */
export type OvertimePlanRow = {
  id: string;
  attendanceDate: string;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  requestedOtMinutes: number | null;
  approvedOtMinutes: number | null;
  otReasonCategory: OtReasonCategory | null;
  reason: string | null;
  /** f618065d (r362) — the EMPLOYEE's own optional note, written only by requestAttendanceCorrection.
   *  It is NOT an approver's reason: `decideAttendanceCorrection` takes none and writes none. The plan
   *  told the reporter exactly that, and promised this — the note they themselves added — instead. */
  remark: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  appliedAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
};

/**
 * f618065d (r362) — HOW THE SELF OVERTIME LIST IS NARROWED, in one shape used by BOTH reads.
 *
 * The chip counts and the rows they sit above must never disagree, and the only way to guarantee that is
 * for one predicate builder to serve both queries. `status` is deliberately NOT part of this type: the
 * counts read groups BY status and must therefore see every status the other filters allow, while the
 * list read adds the active chip on top. Putting it in here is exactly how a chip would come to say 2
 * over a list of 12.
 */
export type OvertimePlanFilter = {
  /** Inclusive lower bound on the OVERTIME date (not the filing date). */
  from?: string;
  /** Inclusive upper bound on the overtime date. Absent = open ended, which is the screen's default:
   *  overtime is filed BEFORE the day, so a closed window hides the very plan being watched. */
  to?: string;
  /** Case-insensitive substring of the employee's own free-text reason. The reason CATEGORY is a
   *  translated label resolved in the page, not a stored string, so it cannot be matched here. */
  q?: string;
};

/** The columns Self Overtime may be ordered by. `status` is absent on purpose: ordering by the stored
 *  value is alphabetical, which means nothing to a reader, and the chips already do that job. */
export const OVERTIME_PLAN_SORTS = ['date', 'hours', 'submitted'] as const;
export type OvertimePlanSort = (typeof OVERTIME_PLAN_SORTS)[number];

/** One status's share of the filtered set — count, hours asked for, and hours actually granted. */
export type OvertimePlanCountRow = {
  status: OvertimePlanRow['status'];
  count: number;
  requestedMinutes: number;
  approvedMinutes: number;
};

/** What the Apply OT Plan form needs to warn the employee before they submit. */
export type OvertimeCapView = {
  /** OT already RECORDED on attendance rows in the month (the days actually worked). */
  recordedMinutes: number;
  /** OT approved on plans for days NOT YET counted — future days, and days not yet clocked out. */
  plannedMinutes: number;
  /** recorded + planned: what the month already commits to, before the plan being typed. */
  totalMinutes: number;
  /** EA 1955 limitation-of-overtime regs — 104 hours a month. */
  capMinutes: number;
};

/**
 * The day classification for ONE employment on ONE date — rest day, public holiday or an ordinary working
 * day — resolved through the SAME `scheduleFor` the clocking path uses (roster shift > holiday calendar >
 * rostered rest day > default shift > company policy), so the form can never name a different kind of day
 * from the one the engine will freeze onto the attendance row.
 *
 * A THIN WRAPPER, deliberately, rather than exporting `scheduleFor` itself: the resolved schedule carries
 * shift windows, OT rules, grace periods and rate rows that no caller outside this file has any business
 * reading, and widening the private function is how that surface leaks.
 */
export function dayTypeFor(ctx: SessionContext, employmentId: string, date: string): Promise<PlanOtDayType> {
  return withTenant(ctx, async (tx) => (await scheduleFor(tx, employmentId, date)).dayType);
}

/**
 * 3fb1a611 (r299) · WHICH KIND OF DAY WAS THIS, for a Leave Credit — the four answers the reporter uses:
 * an ordinary working day, a rest day, an OFF day, or a public holiday.
 *
 * THE SAME LADDER THE CLOCKING PATH FREEZES ONTO AN ATTENDANCE ROW, not a second one. `scheduleFor` resolves
 * rostered shift → public holiday (holidayDatesFor, the unified calendar) → rostered rest → the default
 * shift's four-way weekly pattern → company working days, which is the precedence `classifyScheduleDay`
 * (the Daily Attendance / Records ladder) states it mirrors. Reading it here means a credit's day kind can
 * never disagree with the day type an attendance row for the same date would carry.
 *
 * THE OFF DAY IS READ FROM THE RESOLVED SOURCE, NOT A FOURTH DayType. b8aa3466 records an off day as a
 * WORKDAY with a zero-minute normal day and `source: 'default-shift-rest'` (the default shift's own rest
 * branch returns 'rest_day'; its off branch returns 'workday'). So on the default-shift branch, a 'workday'
 * that came from the rest branch IS the off day. `attendance_day_type` is not widened and nothing about how
 * that day is PAID changes.
 *
 * `deductAbsence` is NOT consulted, deliberately: that gate exists so the Records screen keeps rendering an
 * unrostered company-working-day absence the old way until payroll opts in. It decides how a MISSING row is
 * labelled, not what kind of day a date is — and this question is the latter.
 */
export type WorkedDayKind = 'workday' | 'rest_day' | 'off_day' | 'holiday';
export async function workedDayKindForTx(tx: Tx, employmentId: string, date: string): Promise<WorkedDayKind> {
  const s = await scheduleFor(tx, employmentId, date);
  if (s.dayType === 'holiday') return 'holiday';
  if (s.dayType === 'rest_day') return 'rest_day';
  if (s.source === 'default-shift-rest') return 'off_day';
  return 'workday';
}

/**
 * ce5ded11 (r362) · THE OT CALENDAR'S MONTH — one batched read, for the calendar-first Apply OT Plan screen.
 *
 * WHAT IT ANSWERS, per date of one month for ONE employment: which kind of day it is (the four
 * `WorkedDayKind` answers), WHICH RUNG of the scheduling ladder answered, the resolved shift's code and
 * name, the schedule's start and end, and the first break window. That is what the day panel prints and
 * what the calendar shades, and none of it is stored — it is all resolved.
 *
 * ⚠️ WHY IT IS NOT 31 × `scheduleFor`. `scheduleFor` is per (employee, date) and makes six or seven round
 * trips of its own (policy, holiday set, rule, employment row, roster join, OT windows, the arrangement
 * ladder). A month of it is ~200 queries to draw one self-service screen. This is the same ladder over
 * BATCHED inputs — one roster query, one holiday set, one arrangement ladder, one shift query, one policy
 * — which is exactly the shape `attendanceForEmploymentRange` already uses for the Records table.
 *
 * ⚠️ AND WHY IT CANNOT DRIFT FROM THE ENGINE. The precedence is NOT restated here: `classifyScheduleDay`
 * (this file, ~line 2100) is the one written statement of "rostered shift → rostered rest → default shift's
 * working week → default-shift rest → company policy", and it is what both `resolveShiftDisplay` and
 * `isScheduledOffDay` already read. This function adds exactly two things on top of it, in the order
 * `scheduleFor` adds them:
 *   · the PUBLIC HOLIDAY overlay — a rostered shift still defines the schedule on a holiday (the day is
 *     classified 'holiday' so the premium is right), and every no-shift rung falls to policyBranch('holiday'),
 *     which is why `source` reads 'policy' on a holiday that lands on a rest or off day. That is not a
 *     rounding of the answer, it is the rung `scheduleFor` actually returns.
 *   · the REST-vs-OFF split on the default-shift branch, which `classifyScheduleDay` folds into one
 *     'default_rest' because the DISPLAY ladder does not care. `workedDayKindForTx` reads it off
 *     `source === 'default-shift-rest'`; the four-way weekly row (`shiftDayKindFor`) is what says which of
 *     the two it is, and an OFF day is only ever the default shift's own `off_pattern`. A ROSTERED day can
 *     never be an off day — `roster_assignment` holds `shift_id` and `is_rest_day` and nothing else
 *     (db/schema.ts) — so the calendar must not draw one there, and this cannot.
 *
 * test/ot-plan-calendar.test.ts pins the agreement DATE BY DATE against `dayTypeFor` over a seeded month,
 * so "the same ladder" is a checked property rather than a comment.
 *
 * `scheduleStart` / `scheduleEnd` are the SCHEDULE's own times, mirroring ResolvedSchedule's
 * `scheduledStart` / `scheduledEnd`: the shift's on a shift rung, the company's standard hours on a policy
 * WORKING day, and NULL wherever no work is scheduled. They are deliberately not the company's hours on a
 * rest or off day — `policyBranch` carries them there for the lateness measurement, and printing them on
 * the screen would tell an employee they are scheduled to work on their day off.
 */
export type OtPlanDaySource = 'roster-shift' | 'roster-rest' | 'default-shift' | 'default-shift-rest' | 'policy';

export type OtPlanCalendarDay = {
  date: string;
  kind: WorkedDayKind;
  source: OtPlanDaySource;
  /** The resolved shift's code and name. NULL on every rung that resolves no shift. */
  shiftCode: string | null;
  shiftName: string | null;
  /** HH:MM. NULL where no work is scheduled (see the header). */
  scheduleStart: string | null;
  scheduleEnd: string | null;
  /** The resolved shift's FIRST break window, HH:MM. NULL when the shift declares no windows. */
  breakStart: string | null;
  breakEnd: string | null;
  /** The shift's (or the policy's) canonical break minutes; NULL where no work is scheduled. */
  breakMinutes: number | null;
};

export function otPlanCalendarMonth(
  ctx: SessionContext,
  employmentId: string,
  month: string,
): Promise<OtPlanCalendarDay[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return Promise.resolve([]);
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return withTenant(ctx, async (tx) => {
    const pol = await policyFor(tx, employmentId);
    const workDays = unionWorkingDays(pol.workingDays, pol.halfWorkingDays);

    const [holidays, rosterRows, empRow, periods] = await Promise.all([
      holidayDatesFor(tx, { employmentId, startDate: from, endDate: to }),
      tx
        .select({
          shiftDate: rosterAssignment.shiftDate,
          isRestDay: rosterAssignment.isRestDay,
          code: shift.code,
          name: shift.name,
          start: shift.startTime,
          end: shift.endTime,
          brk: shift.breakMinutes,
          periods: shift.breakPeriods,
          crosses: shift.crossesMidnight,
          rounding: shift.normalHoursRoundingMinutes,
        })
        .from(rosterAssignment)
        .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
        .where(
          and(
            eq(rosterAssignment.employmentId, employmentId),
            gte(rosterAssignment.shiftDate, from),
            lte(rosterAssignment.shiftDate, to),
          ),
        ),
      tx
        .select({ ruleId: employment.attendanceRuleId, defShiftId: employment.defaultShiftId })
        .from(employment)
        .where(eq(employment.id, employmentId))
        .limit(1),
      arrangementsForEmploymentTx(tx, employmentId),
    ]);
    // RLS-fenced, or no such employment: an empty month is the honest answer, not a fabricated policy week.
    if (!empRow[0]) return [];

    const rosterByDate = new Map(rosterRows.map((r) => [r.shiftDate, r]));

    // 18504ca6 — the default shift is resolved PER DATE off the dated arrangement ladder, exactly as
    // attendanceForEmploymentRange does it: two batched queries (the ladder, then the shifts it names),
    // falling back to employment.default_shift_id only when the employment has no ladder row at all.
    const monthShiftCols = {
      id: shift.id,
      code: shift.code,
      name: shift.name,
      start: shift.startTime,
      end: shift.endTime,
      brk: shift.breakMinutes,
      periods: shift.breakPeriods,
      crosses: shift.crossesMidnight,
      pattern: shift.weeklyPattern,
      halfPattern: shift.halfPattern,
      offPattern: shift.offPattern,
      ruleId: shift.ruleId,
      rounding: shift.normalHoursRoundingMinutes,
    };
    const periodShiftIds = [...new Set(periods.map((p) => p.shiftId))];
    const periodShifts =
      periodShiftIds.length > 0 ? await tx.select(monthShiftCols).from(shift).where(inArray(shift.id, periodShiftIds)) : [];
    const [cachedRow] =
      periods.length === 0 && empRow[0].defShiftId
        ? await tx.select(monthShiftCols).from(shift).where(eq(shift.id, empRow[0].defShiftId)).limit(1)
        : [];
    // 07ebd04d — the SCHEDULE GROUP's working week when the employee (or the shift) is in one, resolved
    // through the same chain scheduleFor's `ruleFor` uses. Without it the calendar would say OFF on a day
    // the engine pays as work.
    const week = await weekLookupTx(
      tx,
      empRow[0].ruleId,
      [...periodShifts, ...(cachedRow ? [cachedRow] : [])].map((r) => r.ruleId),
    );
    type MonthShift = Omit<(typeof periodShifts)[number], 'pattern' | 'halfPattern' | 'offPattern'> & WeekPattern;
    const shiftById = new Map<string, MonthShift>();
    for (const sr of periodShifts) shiftById.set(sr.id, { ...sr, ...week(sr.ruleId, sr) });
    const cachedDefault: MonthShift | undefined = cachedRow ? { ...cachedRow, ...week(cachedRow.ruleId, cachedRow) } : undefined;
    const defaultOn = (d: string): MonthShift | undefined => {
      const p = pickArrangementOn(periods, d);
      return p ? shiftById.get(p.shiftId) : cachedDefault;
    };

    const hhmm = (t: string | null | undefined): string | null => (t == null ? null : t.slice(0, 5));
    /** The FIRST break window of a shift, which is what the day card shows. A shift may declare several;
     *  naming one and calling it "your break" would be false, so more than one falls back to the scalar. */
    const firstBreak = (ps: BreakPeriod[] | null | undefined): { start: string | null; end: string | null } =>
      ps && ps.length === 1 && ps[0]?.start && ps[0]?.end ? { start: hhmm(ps[0].start), end: hhmm(ps[0].end) } : { start: null, end: null };

    const out: OtPlanCalendarDay[] = [];
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const roster = rosterByDate.get(d);
      const def = defaultOn(d);
      const isWorkingDay = workDays.includes(isoWeekday(d));
      const isHoliday = holidays.has(d);
      const cls = classifyScheduleDay(d, roster, def, isWorkingDay);
      const noShift = { shiftCode: null, shiftName: null, scheduleStart: null, scheduleEnd: null, breakStart: null, breakEnd: null, breakMinutes: null };

      if (cls === 'roster_shift') {
        const b = firstBreak(roster!.periods);
        out.push({
          date: d,
          kind: isHoliday ? 'holiday' : 'workday',
          source: 'roster-shift',
          shiftCode: roster!.code ?? null,
          shiftName: roster!.name ?? null,
          scheduleStart: hhmm(roster!.start),
          scheduleEnd: hhmm(roster!.end),
          breakStart: b.start,
          breakEnd: b.end,
          breakMinutes: roster!.brk ?? null,
        });
        continue;
      }
      if (cls === 'roster_rest') {
        // scheduleFor: `if (isHoliday) return policyBranch('holiday')` — the holiday premium beats the
        // rest-day one, and the rung it returns from IS the policy branch.
        out.push({ date: d, kind: isHoliday ? 'holiday' : 'rest_day', source: isHoliday ? 'policy' : 'roster-rest', ...noShift });
        continue;
      }
      if (cls === 'default_shift') {
        const kindOfDay = shiftDayKindFor(def!, d);
        // A HALF day ENDS halfway through the shift's clock span — scheduleFor halves the effective
        // shift end, and that end is what workday overtime is measured past. The screen prefills the
        // overtime start from this figure, so it must be the engine's, not the full shift's.
        const end =
          kindOfDay === 'half'
            ? fmtTime((toMinutes(def!.start) + Math.floor(shiftSpan(def!.start, def!.end, def!.crosses) / 2)) % MINS_PER_DAY)
            : def!.end;
        const b = firstBreak(def!.periods);
        out.push({
          date: d,
          kind: isHoliday ? 'holiday' : 'workday',
          source: 'default-shift',
          shiftCode: def!.code ?? null,
          shiftName: def!.name ?? null,
          scheduleStart: hhmm(def!.start),
          scheduleEnd: hhmm(end),
          breakStart: b.start,
          breakEnd: b.end,
          breakMinutes: def!.brk ?? null,
        });
        continue;
      }
      if (cls === 'default_rest') {
        if (isHoliday) {
          out.push({ date: d, kind: 'holiday', source: 'policy', ...noShift });
          continue;
        }
        // The ONLY place an off day is representable: the default shift's own four-way weekly row.
        out.push({
          date: d,
          kind: shiftDayKindFor(def!, d) === 'off' ? 'off_day' : 'rest_day',
          source: 'default-shift-rest',
          ...noShift,
        });
        continue;
      }
      // The company-policy rung. A working day carries the company's standard hours (which is what
      // scheduleFor's policyBranch schedules); a rest day carries none.
      out.push({
        date: d,
        kind: isHoliday ? 'holiday' : isWorkingDay ? 'workday' : 'rest_day',
        source: 'policy',
        ...noShift,
        ...(!isHoliday && isWorkingDay
          ? { scheduleStart: hhmm(pol.workStart), scheduleEnd: hhmm(pol.workEnd), breakMinutes: pol.breakMinutes }
          : {}),
      });
    }
    return out;
  });
}

/**
 * r336 cbfa8b0b · THE FOUR READ-ONLY FACTS SECTION B OF THE LEAVE CREDIT REQUEST SHOWS FOR ONE DATE.
 *
 * The reporter's Section B row is: date worked, SCHEDULED SHIFT END (read-only), ACTUAL CLOCK-OUT
 * (read-only, from Attendance), the employee's claimed window, and the derived eligible minutes. Three of
 * those four are facts this engine already owns, and this is the one read that hands them over together —
 * one `scheduleFor` and one attendance row rather than three round trips from the leave side.
 *
 * ⚠️ IT MEASURES NOTHING NEW, and that is the whole design. `measuredExtendedMinutes` is r334's
 * `extendedMinutesAfterShiftEnd` over this day's stored `ot_minutes` and `calc_trace` — the figure
 * core/toil.ts's tier ladder already runs on, produced by the same function rather than re-derived from
 * `checkOutAt − shiftEnd` here. Re-deriving it would put a SECOND owner on "how long did this person work
 * past their shift end", and the two would diverge the first time a shift's OT rule, its rounding band or
 * its daily cap moved, while payroll kept paying the first one.
 *
 * ⚠️ r353 cbfa8b0b — THIS PARAGRAPH USED TO END "the clock-out below is shown to the EMPLOYEE so they can
 * see what the system has; it is not what the credit is computed from." The second half was true of r336's
 * arithmetic and is now WRONG IN BOTH DIRECTIONS, so it is corrected rather than left to age: the owner
 * reversed the rule on cbfa8b0b, so the clock-out no longer clips the claim (it never was the basis, and
 * now it does not narrow it either) AND `measuredExtendedMinutes` no longer caps it. What the clock-out is
 * for now is the APPROVER: `assessExtendedClaim` (lib/extended-hours.ts) compares it with the claimed end
 * and both the request table and the approvals queue print an amber warning when the claim runs past it, or
 * when there is no clock-out on record at all. `measuredExtendedMinutes` is still returned as the engine's
 * own measurement and is read by no credit arithmetic since r353 — do not reintroduce it as a ceiling.
 *
 * NULLS ARE HONEST ANSWERS, not failures. `shiftEnd` is NULL on the company-policy branch (no assigned
 * shift, so there is no scheduled end to claim past — ResolvedSchedule documents this). `actualClockOut`
 * is NULL when the day has no attendance row or was never clocked out, and THOSE TWO ARE INDISTINGUISHABLE
 * HERE — `row?.checkOutAt ?? null` collapses them on purpose, which is why the screens say "No record"
 * (there is no clock-out to compare with) rather than claiming there is no attendance row. On an Ordinary
 * Day row a NULL clock-out now reads as that "No record", not as the em dash that means "this cell does not
 * apply to this day type"; the REFUSAL for a day that cannot earn anything comes from the minutes, never
 * from a missing time.
 */
/**
 * ⚠️ r365 cbfa8b0b — TWO REFERENCE-ONLY FIELDS JOINED THIS VIEW, AND NEITHER IS AN INPUT TO ANY FIGURE.
 *
 * The Leave Credit request row moved its attendance figures behind one `View` button, and that panel shows
 * the employee the whole record for the date: the scheduled shift as a WINDOW (not just its end), and the
 * clock-IN beside the clock-out. `shiftStart` and `actualClockIn` exist for that panel and for nothing
 * else — no arithmetic in this repo reads either of them, and `assessExtendedClaim`'s inputs are unchanged
 * (`lib/extended-hours.ts` still takes `shiftEnd` and `actualClockOut`, and the Leave Credit table still
 * passes NULL for both on the three non-working day types, which is the money rule).
 *
 * ⚠️ `s.shiftStart` / `s.shiftEnd`, NEVER `s.scheduledStart` / `s.scheduledEnd`. The two pairs are not
 * synonyms: `scheduledStart`/`scheduledEnd` resolve on EVERY branch including company-policy, while
 * `shiftStart`/`shiftEnd` are NULL on that branch (see ResolvedSchedule above) — and `shiftEnd` is what the
 * credit is actually floored at. Printing the scheduled pair would show the employee one number while the
 * credit used another, which is the class of defect this whole round is about.
 *
 * NO EXTRA QUERY. `checkInAt` is a column on the row already being selected for the clock-out.
 */
export type ExtendedHoursDayView = {
  kind: WorkedDayKind;
  scheduleName: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  attendanceRecordPresent: boolean;
  /** The resolved schedule's shift START (HH:MM:SS), or null on the company-policy branch. Display only. */
  shiftStart: string | null;
  /** The resolved schedule's shift end (HH:MM:SS), or null on the company-policy branch. */
  shiftEnd: string | null;
  /** The attendance row's clock-IN (HH:MM:SS), or null when the day has no row or no clock-in. Display only. */
  actualClockIn: string | null;
  /** The attendance row's clock-out (HH:MM:SS), or null when the day has no row or no clock-out. */
  actualClockOut: string | null;
  /** r334's measured extended figure for the day: `ot_minutes` less any folded pre-shift minutes. */
  measuredExtendedMinutes: number;
};

export async function extendedHoursDayForTx(tx: Tx, employmentId: string, date: string): Promise<ExtendedHoursDayView> {
  const s = await scheduleFor(tx, employmentId, date);
  const kind: WorkedDayKind =
    s.dayType === 'holiday' ? 'holiday' : s.dayType === 'rest_day' ? 'rest_day' : s.source === 'default-shift-rest' ? 'off_day' : 'workday';
  const [row] = await tx
    .select({
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      otMinutes: attendance.otMinutes,
      calcTrace: attendance.calcTrace,
    })
    .from(attendance)
    .where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date)))
    .limit(1);
  const [group] = s.rule ? await tx.select({name:attendanceRule.name}).from(attendanceRule).where(eq(attendanceRule.id,s.rule.id)).limit(1) : [];
  return {
    scheduleName: group?.name ?? null,
    shiftCode: s.displayShiftCode ?? null,
    shiftName: s.displayShiftName ?? null,
    attendanceRecordPresent: row != null,
    kind,
    shiftStart: s.shiftStart ?? null,
    shiftEnd: s.shiftEnd ?? null,
    actualClockIn: row?.checkInAt ?? null,
    actualClockOut: row?.checkOutAt ?? null,
    measuredExtendedMinutes: row ? extendedMinutesAfterShiftEnd({ otMinutes: row.otMinutes, calcTrace: row.calcTrace }) : 0,
  };
}

/**
 * Month-to-date overtime for ONE employment, INCLUDING approved plans that have not landed yet — the figure
 * the cap warning is measured against.
 *
 * WHY NOT attendanceMonthSummary. That takes a month plus optional companyIds and returns a row PER
 * EMPLOYEE, resolving each one's holiday calendar with a query apiece. It is a management report; running it
 * to render one employee's form would be several orders of magnitude too heavy.
 *
 * WHY PLANNED MINUTES COUNT. The point of the warning is to catch the ceiling BEFORE the month is worked. A
 * figure that ignored three approved future plans would tell an employee they had room they had already
 * committed — which is exactly the situation planning ahead is supposed to prevent.
 */
export function otMonthToDateMinutes(
  ctx: SessionContext,
  employmentId: string,
  date: string,
): Promise<OvertimeCapView> {
  const monthStart = `${date.slice(0, 7)}-01`;
  // Last day of the month, by UTC date arithmetic on a known date-only string (the form the codebase keeps
  // in UTC): day 0 of the NEXT month is the last day of this one.
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return withTenant(ctx, async (tx) => {
    const [recorded] = await tx
      .select({ total: sql<string>`coalesce(sum(${attendance.otMinutes}), 0)` })
      .from(attendance)
      .where(
        and(
          eq(attendance.employmentId, employmentId),
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      );
    // Approved, not-yet-landed OT plans in the month. `applied_at IS NULL` is what makes these additive
    // rather than double-counted: once a plan lands, its minutes are ON the attendance row above.
    const [planned] = await tx
      .select({ total: sql<string>`coalesce(sum(${attendanceCorrection.requestedOtMinutes}), 0)` })
      .from(attendanceCorrection)
      .where(
        and(
          eq(attendanceCorrection.employmentId, employmentId),
          gte(attendanceCorrection.attendanceDate, monthStart),
          lte(attendanceCorrection.attendanceDate, monthEnd),
          eq(attendanceCorrection.status, 'approved'),
          isNull(attendanceCorrection.appliedAt),
          isNull(attendanceCorrection.proposedCheckIn),
          sql`${attendanceCorrection.requestedOtMinutes} is not null`,
        ),
      );
    const recordedMinutes = Number(recorded?.total ?? 0);
    const plannedMinutes = Number(planned?.total ?? 0);
    return {
      recordedMinutes,
      plannedMinutes,
      totalMinutes: recordedMinutes + plannedMinutes,
      capMinutes: OT_CAP_MINUTES,
    };
  });
}

/**
 * The employee's OWN overtime plans, newest first, paged — the Plan OT landing list.
 *
 * WHY NOT myAttendanceCorrections. That one is EVERY request of every kind, which is the other list on the
 * same screen (2166ef79 widened it to carry reason, remark, kind and the four statuses for exactly that
 * job). This read is OT-ONLY by construction — it is what the Self Overtime section shows, and it is the
 * only one that answers "has this been counted on the day yet". Merging the two would mean a section
 * called Self Overtime filtering a general list in the page, which is how the five-row mixed list this
 * item replaced came about in the first place.
 *
 * RLS scopes the rows; the employmentId argument narrows to the one employment the caller asked about.
 */
export function myOvertimePlans(
  ctx: SessionContext,
  employmentId: string,
  opts: OvertimePlanFilter & {
    limit?: number;
    offset?: number;
    status?: OvertimePlanRow['status'];
    sort?: OvertimePlanSort;
    dir?: 'asc' | 'desc';
  } = {},
): Promise<OvertimePlanRow[]> {
  // f618065d (r362) — the ceiling is the pager's "All" ceiling, not a private 200. See the import.
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 25)), ALL_ROW_CEILING);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  // ce5ded11 (r362) — an OPTIONAL overtime-date window, for the calendar, which draws one month and must
  // not be told about it by a `limit` that happened to reach far enough back. Absent ⇒ byte-identical to
  // before: no bound is added and the newest `limit` rows across every month come back.
  // f618065d (r362) — and the SAME builder now serves the counts read, so a chip and its rows are
  // narrowed by one expression rather than by two that can drift.
  const window = [
    ...overtimePlanFilters(employmentId, opts),
    opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
  ].filter((c) => c !== undefined);
  // Newest first BY THE OVERTIME DATE, then by when it was filed — the mockup's ordering, and still the
  // default here. Every alternative is a WHITELIST: a raw `?sort=` is a column name arriving from the
  // address bar. The secondary key is always the overtime date, so a page boundary cannot shuffle rows
  // that tie on the primary one (test/plan-ot.test.ts pins the untouched default).
  const dirFn = opts.dir === 'asc' ? asc : desc;
  const orderBy =
    opts.sort === 'hours'
      ? [dirFn(attendanceCorrection.requestedOtMinutes), desc(attendanceCorrection.attendanceDate)]
      : opts.sort === 'submitted'
        ? [dirFn(attendanceCorrection.createdAt), desc(attendanceCorrection.attendanceDate)]
        : [dirFn(attendanceCorrection.attendanceDate), desc(attendanceCorrection.createdAt)];
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        plannedStartTime: attendanceCorrection.plannedStartTime,
        plannedEndTime: attendanceCorrection.plannedEndTime,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        approvedOtMinutes: attendanceCorrection.approvedOtMinutes,
        otReasonCategory: attendanceCorrection.otReasonCategory,
        reason: attendanceCorrection.reason,
        remark: attendanceCorrection.remark,
        status: attendanceCorrection.status,
        appliedAt: attendanceCorrection.appliedAt,
        createdAt: attendanceCorrection.createdAt,
        decidedAt: attendanceCorrection.decidedAt,
      })
      .from(attendanceCorrection)
      .where(and(...window))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
  );
}

/**
 * f618065d (r362) — THE ONE PREDICATE both Self Overtime reads are built from.
 *
 * OT-only by construction: a clock-time correction that happens to carry OT belongs to Attendance
 * Request, and mixing the two is the other half of the complaint this list was split out of.
 */
function overtimePlanFilters(employmentId: string, f: OvertimePlanFilter) {
  return [
    eq(attendanceCorrection.employmentId, employmentId),
    isNull(attendanceCorrection.proposedCheckIn),
    sql`${attendanceCorrection.requestedOtMinutes} is not null`,
    f.from ? gte(attendanceCorrection.attendanceDate, f.from) : undefined,
    f.to ? lte(attendanceCorrection.attendanceDate, f.to) : undefined,
    // `%` and `_` typed into a search box are characters the employee meant literally, not wildcards —
    // and `\` before either of them is how Postgres LIKE is told so.
    f.q && f.q.trim() !== ''
      ? ilike(attendanceCorrection.reason, `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      : undefined,
  ].filter((c) => c !== undefined);
}

/**
 * f618065d (r362) — HOW MANY, AND HOW MANY HOURS, PER STATUS — in ONE round trip.
 *
 * ⚠️ THE COUNTS MUST NOT BE COUNTED OFF THE LIST, and that is the whole reason this exists. The list is
 * paged and capped (`ALL_ROW_CEILING`) and returns no total, so a chip counted over the fetched rows says
 * 25 when the truth is 300 — the exact defect documented at app/feedback/page.tsx, which on production
 * painted "All 517" over a list of 200.
 *
 * Grouped by status and filtered by everything EXCEPT status, so one read answers all five chips, the
 * pager's total and the summary line's hours. Shape lifted from `feedbackStatusCounts` (core/feedback.ts).
 *
 * `requestedMinutes` is a sum over rows the OT-only predicate already guarantees are non-null.
 * `approvedMinutes` is null on every pending, rejected and withdrawn row, so the sum is meaningful only
 * on the approved group — which is the only place the screen prints it.
 *
 * Indexed: `attendance_correction_employment_idx` is (employment_id, attendance_date), which is the
 * equality plus the range this predicate asks for.
 */
export function myOvertimePlanCounts(
  ctx: SessionContext,
  employmentId: string,
  filter: OvertimePlanFilter = {},
): Promise<OvertimePlanCountRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        status: attendanceCorrection.status,
        count: sql<number>`count(*)::int`,
        requestedMinutes: sql<number>`coalesce(sum(${attendanceCorrection.requestedOtMinutes}), 0)::int`,
        approvedMinutes: sql<number>`coalesce(sum(${attendanceCorrection.approvedOtMinutes}), 0)::int`,
      })
      .from(attendanceCorrection)
      .where(and(...overtimePlanFilters(employmentId, filter)))
      .groupBy(attendanceCorrection.status);
    return rows as OvertimePlanCountRow[];
  });
}

/**
 * Day types for a LIST of (employment, date) pairs — what the approvals inbox needs to flag a rest-day or
 * public-holiday overtime plan on the row, so the approver cannot miss it.
 *
 * Keyed `${employmentId}|${date}`. Sequential rather than batched on purpose: scheduleFor is
 * single-employment (roster → holiday calendar → default shift → policy) and the calls share one
 * transaction connection, exactly as attendanceMonthSummary's holiday resolution does. `limit` is a
 * deliberate ceiling — this runs on a page render, and an inbox with hundreds of pending overtime rows
 * should degrade to "no chip on the tail" rather than to a slow page.
 */
export function dayTypesForPairs(
  ctx: SessionContext,
  pairs: { employmentId: string; date: string }[],
  limit = 60,
): Promise<Map<string, PlanOtDayType>> {
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, PlanOtDayType>();
    // De-duplicate first: two plans for one employee-day resolve to the same schedule.
    const seen = new Set<string>();
    const unique: { employmentId: string; date: string }[] = [];
    for (const p of pairs) {
      const k = `${p.employmentId}|${p.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(p);
    }
    for (const p of unique.slice(0, limit)) {
      out.set(`${p.employmentId}|${p.date}`, (await scheduleFor(tx, p.employmentId, p.date)).dayType);
    }
    return out;
  });
}

/** The approved, not-yet-landed OT plan for one (employment, date), if there is one. Tx-level so both the
 *  request guard and the application step ask the same question the same way. */
async function liveOtPlanTx(tx: Tx, employmentId: string, date: string) {
  const [row] = await tx
    .select()
    .from(attendanceCorrection)
    .where(
      and(
        eq(attendanceCorrection.employmentId, employmentId),
        eq(attendanceCorrection.attendanceDate, date),
        eq(attendanceCorrection.status, 'approved'),
        isNull(attendanceCorrection.appliedAt),
        isNull(attendanceCorrection.proposedCheckIn),
        sql`${attendanceCorrection.requestedOtMinutes} is not null`,
      ),
    )
    .orderBy(desc(attendanceCorrection.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * ec30b2e9 (r364), widened by d16237da (r366) · The approved, OT-bearing decision for one
 * (employment, date) whose hours HAVE ALREADY LANDED, if there is one. `liveOtPlanTx` with
 * `applied_at IS NULL` flipped to `IS NOT NULL` — and, since r366, WITHOUT its `proposed_check_in IS NULL`,
 * because the two are no longer asking the same question: `liveOtPlanTx` looks for an unapplied PLAN this
 * request would duplicate, while this one looks for a COUNTED FIGURE, and a figure counts however it got
 * there. The r364 text claiming the two predicates are "deliberately the same predicate otherwise" is
 * quoted and superseded below.
 *
 * WHY IT IS NEEDED AT ALL. `liveOtPlanTx` stops a second plan only while the first is APPROVED AND
 * UNAPPLIED. For a date that is today or past the immediate branch of decideAttendanceCorrection lands the
 * hours and stamps `applied_at` in the same transaction as the approval, so the first plan stops being
 * "live" the instant it is approved and the window `liveOtPlanTx` guards is never open at all. From that
 * moment a second plan was ACCEPTED, and approving it did a bare `update attendance set ot_minutes = …`:
 * REPLACE, not add, with nothing on any screen saying a figure had been displaced.
 *
 * d16237da (r366) · WHAT COUNTS AS "COUNTED" — AND THE SENTENCE THIS REPLACES. This comment used to read
 * "ONLY A PLAN COUNTS HERE (`proposed_check_in IS NULL`), which is the boundary of this item: what is
 * refused is a second PLAN on a counted day." That boundary has MOVED and the `isNull(proposed_check_in)`
 * it described is gone. It left one door open: a day counted by an approved CLOCK CORRECTION — the very
 * route the refusal recommends — was invisible here, so a plain OT-only plan filed afterwards was accepted
 * and approving it replaced the corrected figure. This helper now answers the question its name implies:
 * ANY approved, applied, OT-bearing decision on the date, whichever route filed it.
 *
 * WHAT STILL KEEPS THE CORRECTION ROUTE OPEN IS THE CALLER, NOT THIS QUERY. The two conditions do
 * different jobs and must not be confused:
 *
 *   - the CALL SITE asks "is the INCOMING request a plan?" (`checkIn == null`) — only a plan is refused;
 *   - this HELPER asks "has this day's overtime ALREADY been counted?" — by anything.
 *
 * Drop the caller's gate instead of this condition and the refusal refuses the remedy its own message
 * recommends. Pinned both ways by test/plan-ot.test.ts §4: (b) is the correction route staying open.
 */
async function countedOtPlanTx(tx: Tx, employmentId: string, date: string) {
  const [row] = await tx
    .select()
    .from(attendanceCorrection)
    .where(
      and(
        eq(attendanceCorrection.employmentId, employmentId),
        eq(attendanceCorrection.attendanceDate, date),
        eq(attendanceCorrection.status, 'approved'),
        isNotNull(attendanceCorrection.appliedAt),
        sql`${attendanceCorrection.requestedOtMinutes} is not null`,
      ),
    )
    .orderBy(desc(attendanceCorrection.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * APPLY an approved OT plan to the attendance day that has just been written. Called from every path that
 * finalises a day's figures: clock-out, the terminal punch import, and an approved clock correction.
 *
 * Two jobs, and they are different:
 *
 *  1 · LANDING (applied_at was NULL). Resolve the agreed figure against what was actually clocked, through
 *      the company's own ot_approval_calculation, write ot_minutes + the per-rate split, stamp applied_at
 *      and the final approved figure, append the audit event, and run the replacement-leave accrual that the
 *      deferred approval deliberately did not run. Happens AT MOST ONCE: the applied_at stamp is claimed by
 *      a conditional UPDATE ... WHERE applied_at IS NULL, so two concurrent writers cannot both land it.
 *
 *  2 · RE-ASSERTION (applied_at already set). A day does not stop moving after it lands: a second clock-out
 *      of the day, a re-import, or an approved clock correction all re-derive ot_minutes from the punches
 *      and would otherwise QUIETLY WIPE the figure a human approved. So the already-resolved
 *      approved_ot_minutes is written back. This is NOT a second landing: nothing is re-resolved, no event
 *      is appended and no second replacement-leave credit is minted.
 *
 *      ec30b2e9 (r364) — WHOSE approved_ot_minutes. The LATEST APPROVED OT-BEARING DECISION for the day, by
 *      DECISION TIME, and a clock correction carrying an OT figure IS one. It used to be "the newest OT-only
 *      plan by creation time", which meant a correction that revised a counted day's overtime was reverted
 *      to the plan's figure by the next punch. See the long note at the query.
 *
 * Returns the OT minutes now standing on the day, or null when there was no plan to apply.
 */
async function applyApprovedOtPlanTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    date: string;
    attendanceId: string;
    sched: ResolvedSchedule;
    /** The figure the engine just derived from the day's real punches — the comparison input. */
    systemOtMinutes: number | null;
  },
): Promise<number | null> {
  // ── ec30b2e9 (r364) · WHICH DECISION THIS RE-ASSERTS, AND WHY THE OLD ANSWER WAS WRONG ──────────────
  //
  // THE OLD COMMENT HERE SAID: "The plan for this day, landed or not. Cancelled and rejected rows are
  // excluded; a clock correction that merely carries OT is not a plan (proposed_check_in is set) and is not
  // eligible either." — and the query said the same, filtering `proposed_check_in IS NULL` and ordering by
  // `created_at desc`. That is true of LANDING and FALSE of RE-ASSERTION, and the two share one query.
  //
  // What it cost: an approved CLOCK CORRECTION that revised a counted day's overtime was invisible here, so
  // the next clock-out or terminal re-import re-asserted the OLDER PLAN's figure and the correction's number
  // silently went back. The correction is the route the new request-time refusal points employees at, so
  // that defect is what made the remedy unsafe — it is fixed with it.
  //
  // THE RULE NOW: the decision that stands on a day is the LATEST APPROVED DECISION CARRYING AN OT FIGURE,
  // ordered by DECISION TIME (`decided_at`), and a clock correction is such a decision. `created_at` is the
  // wrong order for this: it says when the employee typed, not when a human agreed, and a correction filed
  // before a plan can be decided after it.
  //
  // LANDING still belongs to a PLAN ONLY — see the guard below the applied_at branch.
  const [plan] = await tx
    .select()
    .from(attendanceCorrection)
    .where(
      and(
        eq(attendanceCorrection.employmentId, p.employmentId),
        eq(attendanceCorrection.attendanceDate, p.date),
        eq(attendanceCorrection.status, 'approved'),
        sql`${attendanceCorrection.requestedOtMinutes} is not null`,
      ),
    )
    // decided_at is non-null on every approved row (decideAttendanceCorrection stamps it in the same
    // statement as the status), and created_at breaks a tie so the order is total rather than arbitrary —
    // "pin invariants, not positions" cuts both ways when a query feeds an assertion.
    .orderBy(desc(attendanceCorrection.decidedAt), desc(attendanceCorrection.createdAt))
    .limit(1);
  if (!plan) return null;

  const writeOt = async (otMinutes: number) => {
    await tx
      .update(attendance)
      .set({
        otMinutes,
        ...otSplitColumns(splitOtMinutes(otMinutes, p.sched.dayType, p.sched.rule)),
      })
      .where(eq(attendance.id, p.attendanceId));
  };

  // ── 2 · RE-ASSERTION ────────────────────────────────────────────────────────────────────────────────
  if (plan.appliedAt != null) {
    if (plan.approvedOtMinutes == null) return null;
    await writeOt(plan.approvedOtMinutes);
    return plan.approvedOtMinutes;
  }

  // ── 1 · LANDING ─────────────────────────────────────────────────────────────────────────────────────
  // ONLY A PLAN CAN LAND. The selection above deliberately no longer filters out clock corrections — that
  // is what fixed re-assertion — so the filter the LANDING branch needs is restated here, where it is the
  // rule rather than an accident of one shared query. Unreachable today by construction (every approved
  // clock correction carrying OT is stamped applied_at in the same transaction as its approval, so it can
  // only arrive at the branch above), and it is here so that stops being a thing a reader has to re-derive.
  if (plan.proposedCheckIn != null) return null;
  // Claim first. The conditional WHERE is the concurrency guard AND the "at most once" guarantee: if
  // another writer got here first, no row comes back and we do nothing at all (their figure stands).
  const claimed = await tx
    .update(attendanceCorrection)
    .set({ appliedAt: sql`now()` })
    .where(and(eq(attendanceCorrection.id, plan.id), isNull(attendanceCorrection.appliedAt)))
    .returning({ id: attendanceCorrection.id });
  if (claimed.length === 0) return null;

  // The rule that was FROZEN onto the plan when the human approved it, not whatever the company happens to
  // be set to today — the approver agreed to a figure under a stated rule, and a policy edit between
  // approval and the worked day must not silently change what they agreed. Falls back to the live setting
  // for a plan approved before this release (which cannot exist yet, but the column is nullable).
  const method: OtApprovalMethod =
    (plan.otApprovalMethod as OtApprovalMethod | null) ?? (await otApprovalCalculationFor(tx, p.employmentId));
  const otMinutes = resolveApprovedOt(plan.requestedOtMinutes!, p.systemOtMinutes, method);
  // ── r368 c8282468 · THE PRE-IMAGE OF A DEFERRED LANDING ─────────────────────────────────────────────
  // THIS IS THE ONLY MOMENT A DEFERRED APPROVAL MOVES A FIGURE. `decideAttendanceCorrection` wrote nothing
  // to attendance when the plan was filed for a future date and emitted no `attendance.amended` at all, so
  // it has no before/after to record; the landing does, and this is it. ⚠️ MUST STAY ABOVE `writeOt` — it
  // is the only write to the attendance row on this path, and reading after it makes `before` a copy of
  // `after`. The `claimed` UPDATE above touches attendance_correction, never attendance.
  const beforeFigures = await attendanceFiguresByIdTx(tx, p.attendanceId);
  await writeOt(otMinutes);
  await tx
    .update(attendanceCorrection)
    .set({ approvedOtMinutes: otMinutes })
    .where(eq(attendanceCorrection.id, plan.id));
  // Re-read rather than assembled, and with the SAME projection as `before`, so the two sides cannot carry
  // different key sets — which is what describePayload's per-key diff needs to render "old → new".
  const afterFigures = await attendanceFiguresByIdTx(tx, p.attendanceId);

  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'attendance',
    aggregateId: p.attendanceId,
    eventType: 'attendance.amended',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      correctionId: plan.id,
      date: p.date,
      dayType: p.sched.dayType,
      otMinutes,
      requestedOtMinutes: plan.requestedOtMinutes,
      systemCalculatedOtMinutes: p.systemOtMinutes,
      approvedOtMinutes: otMinutes,
      otApprovalMethod: method,
      // The distinguishing mark of a deferred landing in the audit trail: this OT was agreed before the day
      // was worked, and this is the moment it was counted.
      otPlanApplied: true,
      // r368 c8282468 — TOP-LEVEL and ADDITIVE, exactly as on the correction path. Every key above is
      // after-only and stays where it is; the pair is added beside them. On this path the figures that move
      // are ot_minutes and the six split columns, so those are the lines the trail renders as old → new —
      // the rest of the projection is carried unchanged on both sides and describePayload drops it.
      before: beforeFigures,
      after: afterFigures,
    },
  });

  // The replacement-leave credit the deferred approval could not mint (there was no day to read). Runs HERE,
  // after ot_minutes and the split are written, so accrueToilTx sees a real row with real overtime on it.
  // `requestedOn` is the PLAN's own creation date (00307068): the credit's Request Date is when the employee
  // asked, never when they happened to clock out. Self-gates on rest_day/holiday + policy; refusals are
  // swallowed inside the helper exactly as they are on the immediate path.
  //
  // r334 928f0454 — and, for a company that has switched extended hours ON, on an ordinary working day too:
  // see the longer note at the immediate call site. The gate is read inside the helper, not restated here.
  await maybeAutoAccrueOnApprovalTx(tx, ctx, {
    employmentId: p.employmentId,
    workedDate: p.date,
    dayType: p.sched.dayType,
    // The same UTC-from-an-instant defect as the correction path above, and fixed with it: a plan filed
    // before 08:00 MYT stamped its credit's Request Date a day early.
    requestedOn: todayInKualaLumpur(plan.createdAt),
  });

  return otMinutes;
}

/**
 * ec30b2e9 (r364) · THE TWO REFUSALS OF A SECOND OVERTIME REQUEST FOR ONE DATE, AND WHY THEY ARE TYPED.
 *
 * They must read DIFFERENTLY, because the way out of each one is different:
 *
 *  · OvertimePlanAlreadyApprovedError — an approved plan is still waiting for the day. Nothing has reached
 *    payroll, so the way out is to WITHDRAW it (cancelPlannedOvertime allows exactly that state).
 *  · OvertimeAlreadyCountedError — the hours are already ON the attendance day and in what payroll reads.
 *    Withdrawal is refused at that point by design, so the way out is an attendance CORRECTION that also
 *    states the day's clock times: the route that records what the figure was and what it became.
 *
 *    ⚠️ r368 c8282468 — THAT SENTENCE WAS NOT TRUE WHEN IT WAS WRITTEN. The correction route recorded what
 *    the figure BECAME and nothing about what it WAS: the upsert never read the row it overwrote and the
 *    `attendance.amended` payload was after-values only. It is true as of this round, because the payload
 *    now carries a top-level `{ before, after }` pair (AMENDED_FIGURE_COLUMNS above). Left standing rather
 *    than reworded, with the correction beside it, so a reader can see which half of it the code earned and
 *    when — and so nobody quietly re-derives the claim from the comment again.
 *
 * TYPED, not raw English `throw`s, because app/me/actions.ts surfaces `Error.message` straight into
 * `?error=` and ErrorBanner prints it verbatim — so a raw throw is English for a Tamil, Thai, Malay,
 * Vietnamese or Chinese employee. Each carries `date` so the action can interpolate it into the
 * localized sentence (`me.otPlanApprovedNotCounted` / `me.otAlreadyCountedForDate`).
 */
export class OvertimePlanAlreadyApprovedError extends Error {
  constructor(readonly date: string) {
    super(`You already have an approved overtime plan for ${date}. Withdraw it first if it is wrong.`);
    this.name = 'OvertimePlanAlreadyApprovedError';
  }
}

export class OvertimeAlreadyCountedError extends Error {
  constructor(readonly date: string) {
    super(
      `Overtime for ${date} has already been approved and counted on that day. A second overtime request cannot replace it — file an attendance request with that day's clock-in and clock-out times instead.`,
    );
    this.name = 'OvertimeAlreadyCountedError';
  }
}

/** Raised when a withdrawal is not allowed — the caller is not the subject, or the plan is in a state that
 *  cannot be taken back. Typed so the action layer can show the message as-is rather than a stack trace. */
export class OvertimePlanWithdrawNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OvertimePlanWithdrawNotAllowedError';
  }
}

/**
 * WITHDRAW an overtime plan — the employee taking back their own request. Today nothing can be taken back
 * at all, pending or approved.
 *
 * WHO: the subject only. Enforced in code, because RLS makes an employee's own rows writable and a manager
 * can see their reports' — neither of which should be able to withdraw on somebody's behalf (a manager who
 * wants a plan gone rejects it, which is a decision and is recorded as one).
 *
 * WHEN: while it is still PENDING, or once APPROVED provided the hours have NOT LANDED (applied_at unset)
 * and the overtime date has not passed. Never once applied — at that point the hours are on the attendance
 * day and in what payroll reads, so removing them is a correction, not a withdrawal, and it needs the
 * approval trail a correction carries.
 */
export async function cancelPlannedOvertime(
  ctx: SessionContext,
  p: { correctionId: string; today?: string },
): Promise<{ status: 'cancelled' }> {
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const [plan] = await tx
      .select()
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!plan) throw new OvertimePlanWithdrawNotAllowedError('overtime plan not found (or not visible)');

    const [subject] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, plan.employmentId))
      .limit(1);
    if (!ctx.personId || subject?.personId !== ctx.personId) {
      throw new OvertimePlanWithdrawNotAllowedError('Only the employee who filed a plan can withdraw it.');
    }

    if (plan.status === 'cancelled') {
      throw new OvertimePlanWithdrawNotAllowedError('This plan has already been withdrawn.');
    }
    if (plan.status === 'rejected') {
      throw new OvertimePlanWithdrawNotAllowedError('This plan was not approved, so there is nothing to withdraw.');
    }
    if (plan.status === 'approved') {
      if (plan.appliedAt != null) {
        throw new OvertimePlanWithdrawNotAllowedError(
          'These hours have already been counted on the attendance day, so they can no longer be withdrawn.',
        );
      }
      if (plan.attendanceDate < today) {
        throw new OvertimePlanWithdrawNotAllowedError(
          'The overtime date has passed, so this plan can no longer be withdrawn.',
        );
      }
    }

    await tx
      .update(attendanceCorrection)
      .set({ status: 'cancelled' })
      .where(eq(attendanceCorrection.id, plan.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: plan.id,
      eventType: 'attendance-correction.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: plan.employmentId,
      payload: {
        date: plan.attendanceDate,
        previousStatus: plan.status,
        requestedOtMinutes: plan.requestedOtMinutes,
      },
    });
    return { status: 'cancelled' as const };
  });
}

/** One row of "My requests" — every request this employee has filed, whatever it was for. */
export type MyAttendanceRequestRow = {
  id: string;
  attendanceDate: string;
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  requestedOtMinutes: number | null;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  otReasonCategory: OtReasonCategory | null;
  reason: string | null;
  remark: string | null;
  requestKind: AttendanceRequestKind | null;
  status: string;
  appliedAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  /** True when a supporting file was attached (the file itself streams from its own route). */
  hasAttachment: boolean;
};

/**
 * 7709ffd1 (r369) — THE ROW CEILING ON `myAttendanceCorrections`, PUBLISHED, on ATTENDANCE_RANGE_MAX_DAYS'
 * reasoning (67268d83, r367).
 *
 * The number was a bare `500` inside the clamp below, and the ONE screen reading this list asked for 200 of
 * it, filtered and paged the result IN MEMORY, and set its pager total to `rows.length`. So an employee with
 * more than 200 requests was shown a total of 200 and told nothing — a short list that looks exactly like a
 * complete one. Adding an export to that screen would have turned it into a FILE that looks complete and is
 * not, which is why this is fixed before the export and not after it.
 *
 * THE CLAMP IS NOT REMOVED. Removing it trades a silent truncation for an unbounded read; raising it moves
 * the cliff without removing it. What was wrong is that no caller could SEE the cliff. So it is published:
 * a caller that will show or serialise the rows bounds itself against THIS constant and refuses politely
 * rather than handing over a short answer. app/attendance/request-status/rows.ts does that, and both the
 * screen and app/attendance/request-status/export/route.ts read it from there.
 *
 * ⚠️ WHY THE CLAMP IS `+ 1` AND THE CEILING IS NOT. A caller cannot tell a complete list of exactly
 * `MY_ATTENDANCE_REQUEST_ROW_CEILING` rows from a truncated one, so it must be able to ask for ONE row past
 * the ceiling — and getting that row back is how it learns there are more than it may show. The ceiling is
 * therefore the most rows anybody may DISPLAY or EXPORT; the clamp is one higher so that limit is knowable
 * rather than guessed. Anything above it is still refused by the clamp.
 */
export const MY_ATTENDANCE_REQUEST_ROW_CEILING = 500;

/**
 * An employee's OWN attendance requests, newest first — the "My requests" list on My Attendance.
 *
 * 2166ef79 WIDENED this read; it did not fork it. It used to return five rows and four columns, which was
 * all the collapsed list on /me needed. The stage-one screen has to show what was asked for, when it was
 * filed, where it stands and whether it can still be taken back, and it has to be filterable by status —
 * so the columns and the ceiling grew here rather than in a second near-identical query beside it. The one
 * previous caller (app/attendance/requests) is the screen doing the asking.
 *
 * NOT merged with myOvertimePlans, deliberately: that one is OT-ONLY by construction (the Self Overtime
 * section is exactly the Plan OT list, moved in whole and still showing planned window, category and
 * whether the hours have landed). This read is the OTHER list on the same screen — every request of every
 * kind. Two lists on one page, each with its own question.
 *
 * RLS scopes the rows; `employmentId` narrows to the one employment the caller asked about.
 */
export function myAttendanceCorrections(
  ctx: SessionContext,
  employmentId: string,
  opts: { limit?: number; date?: string; status?: 'pending' | 'approved' | 'rejected' | 'cancelled' } = {},
): Promise<MyAttendanceRequestRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), MY_ATTENDANCE_REQUEST_ROW_CEILING + 1);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        plannedStartTime: attendanceCorrection.plannedStartTime,
        plannedEndTime: attendanceCorrection.plannedEndTime,
        otReasonCategory: attendanceCorrection.otReasonCategory,
        reason: attendanceCorrection.reason,
        remark: attendanceCorrection.remark,
        requestKind: attendanceCorrection.requestKind,
        status: attendanceCorrection.status,
        appliedAt: attendanceCorrection.appliedAt,
        decidedAt: attendanceCorrection.decidedAt,
        createdAt: attendanceCorrection.createdAt,
      })
      .from(attendanceCorrection)
      .where(and(
        eq(attendanceCorrection.employmentId, employmentId),
        opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
        opts.date ? eq(attendanceCorrection.attendanceDate, opts.date) : undefined,
      ))
      // Newest first BY THE ATTENDANCE DATE, then by when it was filed — the same ordering the Plan OT
      // list uses, so two lists on one screen are not sorted two different ways.
      .orderBy(desc(attendanceCorrection.attendanceDate), desc(attendanceCorrection.createdAt))
      .limit(limit);
    if (rows.length === 0) return [];
    // Which of them carry a file. One extra query for the page rather than one per row; the content
    // itself is never selected here (it streams from the attachment route, on demand).
    const withFiles = new Set(
      (
        await tx
          .select({ id: attendanceCorrectionAttachment.attendanceCorrectionId })
          .from(attendanceCorrectionAttachment)
          .where(
            inArray(
              attendanceCorrectionAttachment.attendanceCorrectionId,
              rows.map((r) => r.id),
            ),
          )
      ).map((r) => r.id),
    );
    return rows.map((r) => ({ ...r, hasAttachment: withFiles.has(r.id) }));
  });
}

/**
 * 2166ef79 — the employee WITHDRAWS their own clock-time attendance request.
 *
 * r363 — THAT FIRST LINE USED TO READ "the employee CANCELS their own clock-time attendance request",
 * and only the VERB moved. The screen calls this act "Withdraw" for a correction as well as for an
 * overtime plan now, because only the subject can ever reach this state (see `assertOwnCorrectionTx`
 * below and `statusLabel` in app/attendance/request-ui.tsx), and the refusal below follows the screen.
 * The NAMES are untouched: the stored status is still `cancelled` and so is this function.
 *
 * WHY THIS IS NOT cancelPlannedOvertime. The subject rule is identical and is shared below, but the STATE
 * rule is genuinely different and must not be blurred into one. An overtime plan may be withdrawn after
 * approval, while the hours have not yet landed on a day — that is the whole point of agreeing overtime in
 * advance. A clock correction may not: approving one WRITES the punches onto the attendance row and
 * re-derives the day, so "withdrawing" it afterwards is a second correction, with the approval trail a
 * correction carries, not a cancellation. Pending only, therefore.
 *
 * An overtime plan handed to this function is refused and pointed at withdraw, rather than silently
 * cancelled under the wrong rule.
 */
export async function cancelOwnAttendanceCorrection(
  ctx: SessionContext,
  p: { correctionId: string },
): Promise<{ status: 'cancelled' }> {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!req) throw new Error('attendance request not found (or not visible)');
    await assertOwnCorrectionTx(tx, ctx, req.employmentId);
    if (req.proposedCheckIn == null && req.requestedOtMinutes != null) {
      throw new Error('This is an overtime plan — withdraw it from the Self Overtime list.');
    }
    if (req.status !== 'pending') {
      // r363 — DO NOT INTERPOLATE `req.status` HERE. It is the stored enum, and 4c8aae68 made
      // `cancelled` read "Withdrawn" everywhere the employee can see it; naming the raw value produced
      // "This request has already been cancelled, so it can no longer be withdrawn." — two words for
      // one state in one sentence, created by the very round that unified them.
      //
      // The alternative was a status-to-word map, which is presentation and does not belong in the
      // kernel. Naming the state is not what the sentence is for: the reader needs to know the request
      // is no longer pending and why that ends it, and "no longer waiting for a decision" is true of
      // approved, rejected and withdrawn alike. So it says that, and names nothing.
      throw new Error('This request is no longer waiting for a decision, so it can no longer be withdrawn.');
    }
    await tx
      .update(attendanceCorrection)
      .set({ status: 'cancelled' })
      .where(eq(attendanceCorrection.id, p.correctionId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: p.correctionId,
      eventType: 'attendance-correction.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { date: req.attendanceDate, previousStatus: req.status, requestKind: req.requestKind },
    });
    return { status: 'cancelled' as const };
  });
}

/** SUBJECT-ONLY. Enforced in code rather than by RLS, because RLS makes an employee's own rows writable AND
 *  a manager's reports' rows visible — and a manager who wants a request gone REJECTS it, which is a
 *  decision and is recorded as one. (cancelPlannedOvertime states the same rule inline because it must
 *  raise the TYPED OvertimePlanWithdrawNotAllowedError its own action layer reports verbatim.) */
async function assertOwnCorrectionTx(tx: Tx, ctx: SessionContext, employmentId: string) {
  const [subject] = await tx
    .select({ personId: employment.personId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!ctx.personId || subject?.personId !== ctx.personId) {
    throw new Error('Only the employee who filed a request can cancel it.');
  }
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
  // Feedback 5249d43f: when TRUE, web clock-in/out requires a registered device (employee_device).
  requireRegisteredDevice: boolean;
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
        requireRegisteredDevice: attendancePolicy.requireRegisteredDevice,
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
            requireRegisteredDevice: false,
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
    // Feedback 5249d43f: require a registered device for web clocking. Optional — absent ⇒ false (the
    // checkbox posts nothing when unchecked; pre-existing callers keep the shipping default OFF).
    requireRegisteredDevice?: boolean;
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
  const OT_METHODS: OtApprovalMethod[] = ['requested', 'system_calculated', 'smaller_of', 'greater_of'];
  if (p.otApprovalCalculation != null && !OT_METHODS.includes(p.otApprovalCalculation)) {
    throw new Error('Invalid overtime approval calculation option.');
  }
  const otApprovalCalculation: OtApprovalMethod = p.otApprovalCalculation ?? 'system_calculated';
  const requireRegisteredDevice = p.requireRegisteredDevice ?? false;

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
        requireRegisteredDevice,
      })
      .onConflictDoUpdate({
        target: attendancePolicy.companyId,
        set: { workStart, workEnd, breakMinutes, lateAfter, halfDayBefore, workingDays, halfWorkingDays, otApprovalCalculation, requireRegisteredDevice },
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
        requireRegisteredDevice,
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
        // 44bc1c33 — the THIRD key, for a terminal whose Card / Clocking ID is not the employee code.
        cardId: employment.cardId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(isNull(employment.terminatedOn));
    const byRef = new Map<string, { id: string; name: string }>();
    // 44bc1c33 — ORDER IS THE PRECEDENCE, and it is deliberate. This is a FLAT map, so the last writer of a
    // key wins. Codes and ICs go in first and CARD IDS LAST, so an exact card match beats a coincidental
    // collision with somebody else's code or IC: the card is the device's own field and the most specific
    // answer to "who is this punch". `assertCardIdFree` (core/attendance-card.ts) refuses such a collision
    // at the point a card is assigned, so this ordering is the second line rather than the first — it
    // matters for cards that predate that guard or arrive by any other route.
    for (const e of emps) {
      if (e.code) byRef.set(e.code.toLowerCase(), { id: e.id, name: e.name });
      if (e.ic) byRef.set(onlyDigits(e.ic), { id: e.id, name: e.name });
    }
    for (const e of emps) {
      if (e.cardId) byRef.set(e.cardId.toLowerCase(), { id: e.id, name: e.name });
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
      const d = deriveAttendance(sched, checkIn, checkOut, g.day);
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
            ...stage1Columns(d),
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
              ...stage1Columns(d),
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
        // 1e9145d4 — an imported day is a day that has been WORKED, so an overtime plan approved ahead of it
        // lands here on exactly the same terms as a clock-out: resolved against `d.otMinutes` (the figure
        // derived from the terminal punches) through the company's ot_approval_calculation, once. On a
        // RE-IMPORT of a day whose plan already landed this re-asserts the approved figure, which the upsert
        // above has just overwritten with the raw derived one. Only reached when !dryRun — a preview must
        // never consume a plan.
        const plannedOt = await applyApprovedOtPlanTx(tx, ctx, {
          employmentId: g.employmentId,
          date: g.day,
          attendanceId: row.id,
          sched,
          systemOtMinutes: d.otMinutes,
        });
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'attendance',
          aggregateId: row.id,
          eventType: 'attendance.imported',
          actor: actorOf(ctx),
          subjectEmploymentId: g.employmentId,
          payload: {
            date: g.day,
            checkIn,
            checkOut,
            source: 'terminal',
            punchCount: g.punches.length,
            ...(plannedOt != null ? { otMinutes: plannedOt, otPlanApplied: true } : {}),
          },
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

// ─────────────── 1c1b321a · Recompute Attendance — the range writer's per-day derivation ───────────────
//
// THE THIRD RE-DERIVE PATH. A day's figures are decided once, at check-out, and then kept. Two paths
// already re-decide them wholesale against a FRESH schedule and write the result: approving a clock-time
// correction (decideAttendanceCorrection — resolves a fresh sched and writes sched.dayType) and
// re-uploading a clocking file (importAttendancePunches — same). Recompute is the third, and it follows
// those two rather than inventing a fourth behaviour: same scheduleFor, same deriveAttendance, same
// stage1Columns, same "day type is re-decided from the calendar and the roster".
//
// The first-clock-in DAY-TYPE FREEZE lives only on checkInTx/checkOutTx and is deliberately not honoured
// here, exactly as it is not honoured by the two paths above.
//
// WHAT THIS FUNCTION DOES NOT DO: it never looks at attendance_punch and it never returns a check_in_at /
// check_out_at. Recompute rewrites CALCULATED figures only — the reporter's hard requirement — so the
// stored clock times are inputs to this function and are never among its outputs. That is also what keeps
// this path clear of recomputeDayFromPunches' first-in/last-out rewrite.
//
// Owned by feedback item 1c1b321a. core/attendance-recompute.ts is its only caller.

/** The shift the recompute measured a day against, for the preview's Shift column. Keyed off the SOURCE
 *  scheduleFor itself reported, so it cannot name a shift the engine did not use: only the two shift
 *  branches have a shift at all, and the rest/policy branches honestly have none. */
async function recomputeShiftCode(
  tx: Tx,
  employmentId: string,
  date: string,
  source: ResolvedSchedule['source'],
): Promise<string | null> {
  if (source === 'roster-shift') {
    const [row] = await tx
      .select({ code: shift.code })
      .from(rosterAssignment)
      .innerJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(and(eq(rosterAssignment.employmentId, employmentId), eq(rosterAssignment.shiftDate, date)))
      .limit(1);
    return row?.code ?? null;
  }
  if (source === 'default-shift') {
    // Same ladder scheduleFor walked one call earlier: the dated arrangement in force on `date`
    // (18504ca6), else employment.default_shift_id.
    const arrangement = pickArrangementOn(await arrangementsForEmploymentTx(tx, employmentId), date);
    const [row] = arrangement
      ? await tx.select({ code: shift.code }).from(shift).where(eq(shift.id, arrangement.shiftId)).limit(1)
      : await tx
          .select({ code: shift.code })
          .from(employment)
          .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
          .where(eq(employment.id, employmentId))
          .limit(1);
    return row?.code ?? null;
  }
  return null;
}

/**
 * Re-derive ONE stored day against the schedule that applies to it TODAY, and hand back both the figures
 * and the exact column bag to write. Writes nothing itself.
 *
 * `approvedOtMinutes` is the ADR-0069 guard: when a human has approved an OT figure for this day, that
 * number is kept and only its per-rate split is recut (exactly as decideAttendanceCorrection does), so a
 * recompute can refresh the measured figures beside it without ever overwriting the approved total.
 *
 * Idempotent by construction: the result is a pure function of (stored punch times, current schedule,
 * date), so running it twice over the same range produces the same bag the second time.
 */
export async function recomputeDayFigures(
  tx: Tx,
  p: {
    employmentId: string;
    date: string;
    checkInAt: string;
    checkOutAt: string | null;
    approvedOtMinutes?: number | null;
  },
) {
  const sched = await scheduleFor(tx, p.employmentId, p.date);
  const d = deriveAttendance(sched, p.checkInAt, p.checkOutAt, p.date);
  const keepOt = p.approvedOtMinutes != null;
  const otMinutes = keepOt ? p.approvedOtMinutes! : d.otMinutes;
  // When the approved figure is kept, the buckets are recut FROM IT so they still sum to ot_minutes —
  // the same reason decideAttendanceCorrection recuts them. The measured lateness / early-out /
  // short-hours are unaffected by the override and come from `d`.
  const stage1 = keepOt
    ? { ...stage1Columns(d), ...otSplitColumns(splitOtMinutes(otMinutes!, sched.dayType, sched.rule)) }
    : stage1Columns(d);
  return {
    dayType: sched.dayType,
    source: sched.source,
    shiftCode: await recomputeShiftCode(tx, p.employmentId, p.date, sched.source),
    otPreserved: keepOt,
    /** Exactly the columns a recompute may write: status, day type, the two totals and every stage-1
     *  figure. `check_in_at` / `check_out_at` are absent by construction — see the header above. */
    columns: {
      status: d.status,
      dayType: sched.dayType,
      workedMinutes: d.workedMinutes,
      otMinutes,
      ...stage1,
    },
  };
}
