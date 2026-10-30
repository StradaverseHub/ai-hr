import { withCanonicalAiReadTx } from './ai-read-transaction';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { lockLeaveDependenciesTx, lockLeaveDependencyConfigurationTx } from './leave-dependency-lock';
import {attendancePolicyAttestedRawTrace} from '../lib/attendance-policy-attested-trace';
import {assessGeofence,type GeofenceAssessment} from '../lib/geofence-assessment';
import {attendancePolicyUnclockedWorkDates,validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '../lib/attendance-policy-unclocked-work';
import {perRowAttendanceBreakMinutes} from '../lib/attendance-break-count';
import {attendancePolicyClockPlacement,attendancePolicyWorkPlacement,attendancePolicySchedulePlacement,type PolicyClockPlacement,type PolicyWorkPlacement,type PolicySchedulePlacement} from './attendance-policy-schedule';
import {anchorAttendanceClockMinute as anchorToShift} from './attendance-timeline';
import {isCalendarDate} from '../lib/calendar-date';
import {summarizeOvertimeRecords,type FormulaOvertimeRecord,type OvertimeRecordSummary} from '../lib/overtime-records';
import { exceptionDecisionsTx } from './schedule-group-controls';
import { provenCompanyDatesTx } from './employment-company';
import { fullFlexiIntervals, fullFlexiBreakMinutes, type ClosedClockInterval } from '../lib/full-flexi-time';
import { exceptionRevisionOn } from '../lib/schedule-exception';
import { lockPayrollForOwnAttendanceRemoval } from '../packs/payroll/service';
import { retainedAttendancePolicyPlanCancellationTx,attendancePolicyCompleteApprovedPlanSetTx,attendancePolicyPlanProtectionDatesTx, readOvertimeSettlementForDayTx, retainedAttestedPolicyCancellationTx, lockOvertimeDayForAttendanceWriteTx, attendancePolicyUnclockedWorkComparison, attendancePolicySystemEligibleMinutes, attendancePolicyTraceBinding, lockAttendancePolicyImportTx, attendancePolicyImportRoutesTx, attendancePolicyUncapturedRawDay, attendancePolicyRawInputTx, attendancePolicyRawDay, captureCanonicalOvertimePersonnelContextTx, refreshOvertimePatternDayTx, formulaOvertimeForRowsTx, hasRecordedAttendanceGroupPolicyTx } from '../packs/attendance/service';
import { clockCommandContext } from '../lib/clock-command-context';
import {resolveOwnClockEmployment} from './attendance-clock-subject';
import { removalPreservesSequence } from '../lib/attendance-removal';
/**
 * Attendance — generic, jurisdiction-neutral time engine (ADR-0011).
 *
 * One row per employee per day. Check-in classifies the day (workday / rest day /
 * holiday, frozen on the row); check-out derives worked + overtime minutes from the
 * company work schedule. Absence is implicit (no row) and contextualized at read time
 * (approved leave / holiday / rest day are not "absent"). Each mutation appends a
 * domain event (ADR-0006).
 */
import { applyClockChangesTx, clockFingerprint, punchesForCorrectionTx, validateClockEntries, lockAttendancePayrollTx, markAttendancePayrollTx, ClockDataChangedError, AttendancePayrollClosedError, type ClockChanges } from './attendance-punch-change';
import { rotationLookupTx, rotationScheduleRow } from './attendance-rotation';
import { isDeepStrictEqual } from 'node:util';
import { hasGrantFor, withEffectiveGrants } from '../lib/authz-model';
import { prepareAttendanceWorkflowSnapshotTx, snapshotAttendanceWorkflowTx, assertCanDecideAttendanceApplicationTx, decideAttendanceWorkflowStageTx, attendanceWorkflowsForTx } from './attendance-workflow';
import { attendanceApplicationType, AttendanceWorkflowError } from '../lib/attendance-workflow';
import { plannedOvertimeMinutes } from '../lib/overtime-duration';
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
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
import { assertModuleGate, withAttendanceTenant as withTenant } from './module-gate';
import { actorOf, appendEvent, appendEvents } from '../db/events';
import { createHash, randomUUID } from 'node:crypto';
import { filterDelegationOrgScopeTx, assertAssignedWorkPrincipalTx, isApprovalDecisionRefusal } from './approvals';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import { scopeOf } from '../lib/delegation-scope';
import { enforceDeviceGateTx } from './attendance-device';
import { applyOtRuleRows, resolveRuleTx, type ResolvedAttendanceRule } from './attendance-rule';
// 07ebd04d (r331) — the ONE resolver for "whose working week is this, the group's or the shift's".
// A leaf module with no imports, so the rule service can enforce the write-side half of the same
// rule without a cycle through this file. Re-exported below for every caller that had it from here.
import { weekDayKindFor, weekPatternFor, type WeekDayKind, type WeekPattern } from './week-pattern';
import { isAttendanceTrace, ATTENDANCE_TRACE_VERSION, type AttendanceTraceV1, type TraceOtWindow } from './attendance-trace';
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
  effectiveOvertimeRows,
  overtimeCalculationRows,
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
import { holidayDatesByEmployment, holidayDatesFor, holidayCalendarProvenanceFor } from './holidays';
import type {PolicyCalendarProof} from '../lib/attendance-policy-calendar';
import {attendanceGroupPolicyOnTx,type ResolvedAttendanceGroupPolicy} from './attendance-group-policy';
import {HR_LOCAL_TZ} from '../lib/hr-date';
import {overtimeUuid,overtimeDate} from '../lib/overtime-pattern-schema';
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
  attendancePolicyRequestContract,
  attendanceClockCapture,
  // 2166ef79 My Attendance stage one (migration 0434) — the optional supporting file on a request.
  attendanceCorrectionAttachment,
  domainEvent,
  toilAccrual,
  attendancePolicy,
  attendanceDayAdjustment,
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

import { todayInKualaLumpur } from '../lib/hr-date';

// ADR-0070: two aliases of clocking_location so attendanceForDate can resolve BOTH the check-in and
// check-out matched-site names in one query (mirrors core/read.ts myAttendance).
const dayCheckInSite = alias(clockingLocation, 'day_check_in_site');
const dayCheckOutSite = alias(clockingLocation, 'day_check_out_site');

/** A clocking could not be accepted because of the state the day is in (replay, ordering, or an approved
 *  correction). Lives here, not in attendance-clock.ts, because the shared writers below throw it too;
 *  attendance-clock.ts re-exports both so every existing import keeps the same class identity. */
export class ClockConflictError extends Error {}
export class CorrectedClockConflictError extends ClockConflictError {}

/**
 * r434 — AN APPROVED CORRECTION OWNS THE DAY, FOR EVERY WRITER.
 *
 * Clock corrections now reconcile the effective punch set while retaining superseded raw evidence.
 * An approved correction still owns the day: subsequent employee, manual or imported clockings must
 * not silently replace a human decision. That includes an approved removal of every clocking and
 * aggregate-only legacy corrections. HR can submit a further correction through the same workflow.
 */
export async function assertDayNotOwnedByCorrectionTx(tx: Tx, employmentId: string, date: string): Promise<void> {
  const [day] = await tx
    .select({ id: attendance.id })
    .from(attendance)
    .where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date)))
    .limit(1);
  if (!day) return;
  const [correction] = await tx
    .select({ id: attendanceCorrection.id })
    .from(attendanceCorrection)
    .where(
      and(
        eq(attendanceCorrection.employmentId, employmentId),
        eq(attendanceCorrection.attendanceDate, date),
        eq(attendanceCorrection.status, 'approved'),
        or(isNotNull(attendanceCorrection.proposedCheckIn), isNotNull(attendanceCorrection.clockChanges)),
      ),
    )
    .limit(1);
  if (correction) {
    throw new CorrectedClockConflictError(
      'An approved clock correction owns this day; ask HR to review any further clock changes.',
    );
  }
}

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

/** Same typed result is used by preview and every enforced punch writer. */
export class GeofenceQualityError extends GeolocationRequiredError {
  constructor(public readonly assessment:GeofenceAssessment){super();this.name='GeofenceQualityError';}
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
      accuracyM?: number;
      reason?: 'outside_site'|'no_assigned_site';
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
      assessment:GeofenceAssessment;
    };

/** The ONE owner of "which sites count" for an enforced geofence (r423, see resolveGeofence): assigned to the employment,
 *  not archived, open to `companyId` (the employment's current company). resolveGeofence matches against
 *  exactly these rows; the offline context snapshot signs them. Unordered: callers that compare sort by id.
 *  A null-radius row is returned as stored (it can never match); a caller that cannot represent it filters. */
export function assignedClockingSitesTx(tx: Tx, employmentId: string, companyId: string) {
  return tx
    .select({
      id: clockingLocation.id,
      name: clockingLocation.name,
      lat: clockingLocation.lat,
      lng: clockingLocation.lng,
      radiusM: clockingLocation.radiusM,
    })
    .from(employeeClockingLocation)
    .innerJoin(clockingLocation, eq(clockingLocation.id, employeeClockingLocation.clockingLocationId))
    .where(
      and(
        eq(employeeClockingLocation.employmentId, employmentId),
        isNull(clockingLocation.archivedAt),
        sql`exists (select 1 from clocking_location_company gc
                    where gc.clocking_location_id = ${clockingLocation.id} and gc.company_id = ${companyId})`,
      ),
    );
}

/**
 * Resolve the geofence outcome for one punch. When geofencing is OFF, never queries the assignment
 * join or computes a distance (ADR-0070 §8 — keeps the non-enforced hot path lean); stamps raw
 * coordinates only. When ON: loads the employment's active assigned sites and either returns the passing
 * match or THROWS OutsideGeofenceError (zero sites or outside every radius — fail-closed). Missing
 * coordinates or uncertainty while enforced THROWS GeolocationRequiredError.
 * M03: every spatial comparison below includes reported uncertainty; an optional company cap is an
 * additional restriction, never an enlargement of a site's radius. Provider authenticity is separate.
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
 * distance + reported uncertainty ≤ its effective radius", and the nearest is computed ONLY to populate the refusal payload —
 * "you are 850 m from the nearest approved site" is still the most useful thing to tell somebody who has
 * been refused, even though nearness no longer decides anything.
 *
 * EFFECTIVE RADIUS = the site's own radius_m, and nothing else (r423: the per-employee override that
 * used to replace it, employment.geofence_radius_m, is retired — kept in the table, never read). A site
 * with no radius cannot be matched — there is no distance it can be inside of, and fail-closed is the only
 * safe reading. Every production site has a radius (the admin form requires one).
 *
 * r423 — WHICH SITES COUNT: an assigned site that is ACTIVE and OPEN TO THE EMPLOYMENT'S CURRENT COMPANY
 * (clocking_location_company). A site assigned before a transfer to a company it is not open to, or one
 * since deactivated, is not matched — the employee is refused exactly as if it were not assigned, and the
 * profile shows that row flagged.
 *
 * r423 — WHETHER IT IS ENFORCED: employment.geofencing_enabled, and ONLY that. The `required` flag that the
 * self-service Clock screen used to pass (r378: "clock capture requires an enforced geofence") is gone, so
 * an employee whose switch is OFF clocks without a site and the position is recorded, not compared. A
 * caller that must never compare (a time typed in by HR has no phone position) passes `skip: true`.
 *
 * The MATCH is the closest PASSING site, not merely the first one found — with two gates in range the row
 * should record the one the employee actually stood at.
 */
export async function resolveGeofence(
  tx: Tx,
  p: { employmentId: string; date: string; time: string; lat?: number; lng?: number; accuracy?:number; punch: 'in' | 'out'; skip?: boolean },
): Promise<GeofenceCheck> {
  if (p.skip) return { enforced: false, lat: null, lng: null };
  const [emp] = await tx
    .select({ geofencingEnabled: employment.geofencingEnabled, companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  const enabled = emp?.geofencingEnabled ?? false;

  if (!enabled) {
    return { enforced: false, lat: p.lat ?? null, lng: p.lng ?? null };
  }
  const [policy]=await tx.select({maximum:attendancePolicy.geofenceMaximumAccuracyM}).from(attendancePolicy)
    .where(eq(attendancePolicy.companyId,emp!.companyId)).limit(1);

  const sites = await assignedClockingSitesTx(tx, p.employmentId, emp!.companyId);

  const assessment=assessGeofence(p,sites,policy?.maximum??null,haversineMetres);
  if(assessment.outcome==='location_required'||assessment.outcome==='invalid_location'||assessment.outcome==='poor_accuracy')
    throw new GeofenceQualityError(assessment);
  if (assessment.outcome!=='pass') {
    throw new OutsideGeofenceError({
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.lat!,
      lng: p.lng!,
      nearestLocationId: assessment.siteId,
      distanceM: assessment.distanceM==null?null:Math.round(assessment.distanceM),
      radiusM: assessment.radiusM,
      accuracyM:p.accuracy!,reason:assessment.outcome,
      punch: p.punch,
    });
  }
  return {
    enforced: true,
    lat: p.lat!,
    lng: p.lng!,
    clockingLocationId: assessment.siteId!,
    distanceM: Math.round(assessment.distanceM!),
    radiusM: assessment.radiusM!,
    assessment,
  };
}

/** Append the attendance.geofence.blocked event in its OWN transaction, called AFTER the write
 *  transaction rolled back (ADR-0070 §3 — the fix for the fatal "event never commits" flaw: an event can
 *  never survive inside a transaction that itself rolls back). subjectEmploymentId is always the
 *  server-resolved employment id, never client input (ADR-0015). */
export async function appendGeofenceBlockedEvent(ctx: SessionContext, err: OutsideGeofenceError): Promise<void> {
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

/** Sole owner of the writers' minute-ordering refusals: checkInTx/checkOutTx throw `new Error(message)`, and the
 *  clock planner (core/attendance-clock.ts) evaluates the same predicate before any write, so plan and apply
 *  cannot disagree. Inputs are the day's live (non-voided) punch times and its aggregate check-in; null = in order. */
export function clockPunchOrderRefusal(p: {
  direction: 'in' | 'out'; time: string; preciseOrder?: boolean; crossesMidnight: boolean; durationOnly?: boolean;
  dayExists: boolean; punchTimes: readonly string[]; checkInAt: string | null;
}): string | null {
  if (p.preciseOrder) return null;
  const latest = p.punchTimes.reduce<string | null>((a, b) => (a == null || toMinutes(b) > toMinutes(a) ? b : a), null);
  if (p.direction === 'in') {
    // R45: on a non-cross-midnight day a later clock-in must follow every punch already recorded that day.
    return p.dayExists && !p.crossesMidnight && !p.durationOnly && latest != null && toMinutes(p.time) <= toMinutes(latest)
      ? 'Each clocking must be later than the previous one' : null;
  }
  // Order against the latest punch, or a legacy row's check-in that predates the punch table.
  const anchor = latest ?? p.checkInAt;
  if (!p.crossesMidnight && !p.durationOnly && anchor != null && toMinutes(p.time) <= toMinutes(anchor)) return 'Check-out must be after check-in';
  if (anchor != null && toMinutes(p.time) === toMinutes(anchor)) return 'Check-out must differ from check-in';
  return null;
}

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
// The unchanged placement rule is shared with the OT-window and dated-policy owners.

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
  return perRowAttendanceBreakMinutes(periods,breakMinutes,[{inAbs:w.inAbs,outAbs:w.outAbs}],w.startAbs,cutoffAbs,span);
};

// ADR-0032 Phase C: the schedule the engine derives against for one (employee, date) — resolved from the
// employee's roster when present, else the company policy (today's behaviour, byte-identical).
/** The default-shift schedule owner's full/half threshold and effective clock window. No module/DB dependency. */
export function workingShiftSchedule(input:{start:string|null;end:string|null;crosses:boolean;breakMinutes:number;
 roundingMinutes?:number|null;normalMinutesOverride?:number|null;type?:string|null},kind:'full'|'half'){
 const durationOnly=input.type==='full_flexi'||input.start==null||input.end==null;
 if(durationOnly){
  const required=input.normalMinutesOverride;
  if(required==null||required<=0)throw new Error('Full Flexi requires positive normal working minutes.');
  const normalMinutes=kind==='half'?Math.floor(required/2):required;
  return {scheduledMinutes:normalMinutes,normalMinutes,shiftStart:null,shiftEnd:null,crosses:false,normalMinutesOverride:normalMinutes};
 }
 const full=netScheduledMinutes(input.start!,input.end!,input.crosses,input.breakMinutes,input.roundingMinutes);
 const scheduledMinutes=kind==='half'?Math.floor(full/2):full;
 const shiftEnd=kind==='half'?fmtTime((toMinutes(input.start!)+Math.floor(shiftSpan(input.start!,input.end!,input.crosses)/2))%MINS_PER_DAY):input.end!;
 const crosses=kind==='half'?toMinutes(shiftEnd)<toMinutes(input.start!):input.crosses;
 const normalMinutesOverride=input.normalMinutesOverride==null?null:kind==='half'?Math.floor(input.normalMinutesOverride/2):input.normalMinutesOverride;
 return {scheduledMinutes,normalMinutes:normalMinutesOverride??scheduledMinutes,shiftStart:input.start!,shiftEnd,crosses,normalMinutesOverride};
}

type ResolvedSchedule = {
  /** Display-only identity of the shift selected by this exact date resolver. */
  displayShiftId?: string | null;
  scheduleDayKind?: 'full' | 'half' | 'off' | 'rest';
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
  durationOnly?:boolean;
  fullDayNormalMinutes?:number;
  // R17 3e8350db — the resolved shift's per-shift OT rule (eligibility / minimum block / daily cap). Shapes
  // WORKDAY OT accrual only (deriveAttendance); statutory rest/holiday premium is untouched. Null on the
  // policy branch and whenever the shift carries no rule ⇒ byte-identical legacy OT.
  otRule: ShiftOtRule | null;
  manualOtRows?: import('../lib/attendance-day-adjustment').ManualOtRows;
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

/**
 * r424 (50ed39e1) — an OPTIONAL read cache for scheduleFor, for a caller that resolves thousands of
 * (employee, day) schedules in ONE transaction (a 25,000-line clocking import). Without it scheduleFor
 * re-reads the same policy, rules, holiday calendar, shift arrangements, default shift and OT windows for
 * every day of every employee — about ten queries a day. With it each of those is read once per employee
 * (or once per shift / rule) for the whole transaction, the holiday calendar once per employee over the
 * memo's date range, and the roster from a prefetch. ONLY valid while nothing it caches can change, i.e.
 * inside one transaction that writes none of those tables. Absent (every other caller), scheduleFor is
 * exactly what it was.
 */
export type ScheduleMemo = {
  /** Inclusive range every date asked about lies within; the holiday calendar is read over it once. */
  from: string;
  to: string;
  cache: Map<string, Promise<unknown>>;
  /** Raw Schedule owner read: suppress only holiday overlay to break replacement selection recursion. */
  originalSchedule?:boolean;
  /** When set, the roster row for `${employmentId}|${date}` (absent = no roster row) — see prefetch. */
  roster?: Map<string, RosterRow>;
  adjustments?: Map<string,typeof attendanceDayAdjustment.$inferSelect>;
};
type RosterRow = {
  isRestDay: boolean;
  shiftId: string | null;
  code: string | null;
  name: string | null;
  start: string | null;
  end: string | null;
  brk: number | null;
  crosses: boolean | null;
  override: number | null;
  periods: (typeof shift.$inferSelect)['breakPeriods'] | null;
  lateGrace: number | null;
  earlyLeaveGrace: number | null;
  otRule: (typeof shift.$inferSelect)['otRule'] | null;
  ruleId: string | null;
  rounding: number | null;
  halfDayFirstOut: (typeof shift.$inferSelect)['halfDayFirstOut'] | null;
  cutoffOn: boolean | null;
  cutoffAt: string | null;
  flexOn: boolean | null;
  flexMin: number | null;
  shiftType: (typeof shift.$inferSelect)['type'] | null;
};
const rosterRowCols = {
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
};

/** A memo over [from, to] with the roster for `employmentIds` prefetched in chunks (one query each). */
export async function newScheduleMemo(tx: Tx, p: { employmentIds: string[]; from: string; to: string }): Promise<ScheduleMemo> {
  const roster = new Map<string, RosterRow>();
  for (let i = 0; i < p.employmentIds.length; i += 1000) {
    const rows = await tx
      .select({ employmentId: rosterAssignment.employmentId, shiftDate: rosterAssignment.shiftDate, ...rosterRowCols })
      .from(rosterAssignment)
      .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          inArray(rosterAssignment.employmentId, p.employmentIds.slice(i, i + 1000)),
          gte(rosterAssignment.shiftDate, p.from),
          lte(rosterAssignment.shiftDate, p.to),
        ),
      );
    for (const { employmentId, shiftDate, ...r } of rows) {
      const k = `${employmentId}|${shiftDate}`;
      if (!roster.has(k)) roster.set(k, r);
    }
  }
  const adjustments=new Map<string,typeof attendanceDayAdjustment.$inferSelect>();
  if(p.employmentIds.length)for(const row of await tx.select().from(attendanceDayAdjustment).where(and(
    inArray(attendanceDayAdjustment.employmentId,p.employmentIds),gte(attendanceDayAdjustment.attendanceDate,p.from),lte(attendanceDayAdjustment.attendanceDate,p.to))))
    adjustments.set(`${row.employmentId}|${row.attendanceDate}`,row);
  return { from: p.from, to: p.to, cache: new Map(), roster, adjustments };
}

function memoized<T>(memo: ScheduleMemo | undefined, key: string, f: () => Promise<T>): Promise<T> {
  if (!memo) return f();
  const hit = memo.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  // Promise.resolve, not f() itself: a drizzle query is a lazy THENABLE that runs again on every await, so
  // caching the builder would cache nothing. Resolving it once turns it into a real, settled promise.
  const v = Promise.resolve(f());
  memo.cache.set(key, v);
  return v;
}

/** Resolve the schedule for one employee+date: rostered shift > holiday (calendar) > rostered rest-day >
 *  DEFAULT shift (employment.default_shift_id, ec4cbf63 — its weekly_pattern decides working vs rest) >
 *  company policy. No roster row and no default shift ⇒ the policy branch, which reproduces the
 *  pre-Phase-C engine exactly. `memo` (r424) is an optional read cache; see ScheduleMemo. */
async function scheduleFor(tx: Tx, employmentId: string, date: string, memo?: ScheduleMemo): Promise<ResolvedSchedule> {
  const adjustment=memo?.adjustments ? memo.adjustments.get(`${employmentId}|${date}`)
    : (await tx.select().from(attendanceDayAdjustment).where(and(eq(attendanceDayAdjustment.employmentId,employmentId),eq(attendanceDayAdjustment.attendanceDate,date))).limit(1))[0];
  const base=await scheduleBaseFor(tx,employmentId,date,memo,adjustment?.shiftId??undefined);
  if(!adjustment)return base;
  const kind=adjustment.dayKind;
  return {...base,manualOtRows:adjustment.manualOtRows,...(kind ? {
    dayType:kind==='holiday'?'holiday':kind==='rest_day'?'rest_day':'workday',
    ...(kind==='off_day'||kind==='rest_day'?{scheduledMinutes:0,scheduledStart:null,scheduledEnd:null,
      normalMinutesOverride:kind==='off_day'?0:null,flexiDuration:kind==='off_day',scheduleDayKind:kind==='off_day'?'off' as const:'rest' as const,
      ...(kind==='off_day'?{source:'default-shift-rest' as const}:{})}:{}),
  }: {})};
}

async function scheduleBaseFor(tx: Tx, employmentId: string, date: string, memo?: ScheduleMemo, datedShiftId?:string): Promise<ResolvedSchedule> {
  const pol = await memoized(memo, `pol|${employmentId}`, () => policyFor(tx, employmentId));
  const grace = Math.max(0, toMinutes(pol.lateAfter) - toMinutes(pol.workStart)); // 15m by default
  // ADR-0055: the day-type holiday flag comes from the unified resolver — business-group → state →
  // national, single-winner replacement — the SAME calendar the leave engine resolves (leave.ts
  // resolveHolidaySet), so attendance OT day-type classification can never disagree with leave. A
  // business-group override REPLACES nat+state; no company/state rows ⇒ national-only = today's behaviour.
  const isHoliday = memo?.originalSchedule?false:memo
    ? (
        await memoized(memo, `hol|${employmentId}`, () =>
          holidayDatesFor(tx, { employmentId, startDate: memo.from, endDate: memo.to }),
        )
      ).has(date)
    : (await holidayDatesFor(tx, { employmentId, startDate: date, endDate: date })).has(date);
  // 88e94371 — the Standard ("Lateness, Early Out & Overtime Settings") rule. Used by the policy/rest branches
  // AND as the fallback when a resolved shift carries no explicit rule_id. Null when the tenant has no rule
  // yet ⇒ byte-identical legacy behaviour. 6da67ab7: one Standard per TENANT, not per company — the rule is
  // chosen by the shift, and shifts are tenant-wide, so the employee's company no longer selects it.
  const defaultRule = await memoized(memo, 'rule|default', () => resolveRuleTx(tx, { ruleId: null }));
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
  const [empRow] = await memoized(memo, `emprule|${employmentId}`, () =>
    tx.select({ ruleId: employment.attendanceRuleId }).from(employment).where(eq(employment.id, employmentId)).limit(1),
  );
  const groupRule = empRow?.ruleId
    ? await memoized(memo, `rule|${empRow.ruleId}`, () => resolveRuleTx(tx, { ruleId: empRow.ruleId! }))
    : null;
  /** The rule for a branch with NO shift of its own (company policy, rest day): the group's, else Standard. */
  const baseRule = groupRule ?? defaultRule;
  // The effective late/early grace for a shift branch: an explicit per-shift grace wins (R17, unchanged); else
  // the rule's grace-period section; else the policy-derived grace / midpoint heuristic (null ⇒ legacy).
  const ruleFor = (ruleId: string | null): Promise<ResolvedAttendanceRule | null> =>
    groupRule
      ? Promise.resolve(groupRule)
      : ruleId
        ? memoized(memo, `rule|${ruleId}`, () => resolveRuleTx(tx, { ruleId }))
        : Promise.resolve(defaultRule);
  // cf21e554 — the OT windows of one shift, in grid order, or null when it declares none (which is every
  // shift until someone opens the new tab). Null and [] are deliberately the same thing to the caller: no
  // windows ⇒ workday OT stays "time worked past the shift end", byte-identical.
  const otWindowsFor = async (shiftId: string | null): Promise<ShiftOtWindowSpec[] | null> => {
    if (!shiftId) return null;
    return memoized(memo, `otw|${shiftId}`, () => otWindowsRead(shiftId));
  };
  const otWindowsRead = async (shiftId: string): Promise<ShiftOtWindowSpec[] | null> => {
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
  const prefetched=memo?.roster;
  const [ra] = datedShiftId
    ? await tx.select({...rosterRowCols,isRestDay:sql<boolean>`false`}).from(shift).where(eq(shift.id,datedShiftId)).limit(1)
    : prefetched ? ((r)=>(r?[r]:[]))(prefetched.get(`${employmentId}|${date}`))
    : await tx.select(rosterRowCols).from(rosterAssignment).leftJoin(shift,eq(shift.id,rosterAssignment.shiftId))
      .where(and(eq(rosterAssignment.employmentId,employmentId),eq(rosterAssignment.shiftDate,date))).limit(1);

  const policyBranch = (dayType: DayType): ResolvedSchedule => ({
    dayType,
    lateAfter: pol.lateAfter,
    halfDayBefore: pol.halfDayBefore,
    scheduledMinutes: scheduledMinutes(pol),
    fullDayNormalMinutes:scheduledMinutes(pol),
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
    // A policy half marker classifies the day but retains the legacy full required minutes.
    scheduleDayKind: pol.halfWorkingDays.includes(isoWeekday(date)) ? 'half' : 'full',
  });

  const fullFlexiSchedule=(row:{shiftId:string|null;code:string|null;name:string|null;override:number|null;brk:number|null;periods:BreakPeriod[]|null;cutoffOn:boolean|null;cutoffAt:string|null;flexOn:boolean|null;flexMin:number|null;otRule:ShiftOtRule|null},rule:ResolvedAttendanceRule|null,kind:'full'|'half'|'off'|'rest',source:'roster-shift'|'default-shift'):ResolvedSchedule=>{
   if(row.override==null||row.override<=0)throw new Error('Full Flexi normal working hours are unavailable. Ask HR to correct the shift.');
   const required=kind==='half'?Math.floor(row.override/2):kind==='full'?row.override:0;
   return {dayType:isHoliday?'holiday':isWorkingDayKind(kind)?'workday':'rest_day',lateAfter:pol.lateAfter,halfDayBefore:pol.halfDayBefore,
    scheduledMinutes:required,normalMinutesOverride:required,fullDayNormalMinutes:row.override,breakMinutes:row.brk??0,breakPeriods:row.periods,
    shiftStart:null,shiftEnd:null,scheduledStart:null,scheduledEnd:null,crossesMidnight:false,
    dailyCutoffMinutes:row.cutoffOn&&row.cutoffAt?toMinutes(row.cutoffAt):null,flexibleBreakMinutes:row.flexOn?row.flexMin:null,
    flexiDuration:true,durationOnly:true,otRule:row.otRule,otWindows:null,rule,lateGraceMinutes:0,earlyGraceMinutes:0,
    source:!isWorkingDayKind(kind)?'default-shift-rest':source,scheduleDayKind:kind,displayShiftId:row.shiftId,displayShiftCode:row.code,displayShiftName:row.name};
  };
  if(ra&&!ra.isRestDay&&ra.shiftType==='full_flexi'){
    const rule=await ruleFor(ra.ruleId);const resolved=fullFlexiSchedule(ra,rule,'full','roster-shift');
    resolved.otWindows=await otWindowsFor(ra.shiftId);return resolved;
  }

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
      fullDayNormalMinutes:ra.override??sched,
      breakMinutes: ra.brk!,
      shiftStart: ra.start,
      shiftEnd: ra.end,
      breakPeriods: ra.periods ?? null,
      dailyCutoffMinutes: ra.cutoffOn && ra.cutoffAt ? toMinutes(ra.cutoffAt) : null,
      flexibleBreakMinutes: ra.flexOn && ra.flexMin != null ? ra.flexMin : null,
      normalMinutesOverride: ra.override ?? null,
      flexiDuration: ra.shiftType === 'full_flexi' || ra.shiftType === 'semi_flexi',
      otRule: ra.otRule ?? null,
      otWindows,
      rule,
      scheduledStart: ra.start,
      scheduledEnd: ra.end,
      lateGraceMinutes: lateGrace,
      earlyGraceMinutes: earlyGrace ?? 0,
      crossesMidnight: ra.crosses!,
      source: 'roster-shift',
      scheduleDayKind: 'full',
      displayShiftId: ra.shiftId,
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
  const arrangement = pickArrangementOn(
    await memoized(memo, `arr|${employmentId}`, () => arrangementsForEmploymentTx(tx, employmentId)),
    date,
  );
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
  const [legacyDs] = arrangement
    ? await memoized(memo, `shift|${arrangement.shiftId}`, () =>
        tx.select(defaultShiftCols).from(shift).where(eq(shift.id, arrangement.shiftId)).limit(1),
      )
    : await memoized(memo, `dshift|${employmentId}`, () =>
        tx
          .select(defaultShiftCols)
          .from(employment)
          .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
          .where(eq(employment.id, employmentId))
          .limit(1),
      );
  const rotations = await memoized(memo, 'rotations', () => rotationLookupTx(tx));
  const rotation = rotations(groupRule?.id ?? legacyDs?.ruleId ?? defaultRule?.id, date);
  const ds = rotation ? rotationScheduleRow(rotation, date) : legacyDs;
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
    const kind = rotation?.day.kind ?? shiftDayKindFor(weekPatternFor(rule?.week, ds), date);
    if (ds.shiftType==='full_flexi') {
      const resolved=fullFlexiSchedule(ds,rule,kind,'default-shift');resolved.otWindows=await otWindowsFor(ds.shiftId);return resolved;
    }
    if (isWorkingDayKind(kind) && ds.start && ds.end) {
      // Working day of the default shift — mirror the roster-shift branch byte-for-byte, incl. the
      // holiday day-type overlay (the default shift's hours still define the schedule on a holiday), the
      // R17 per-shift grace override, and the 88e94371 rule grace fallback.
      //
      // A HALF day is an ordinary working day with HALF the normal hours, so overtime starts after half a
      // day. Halving the threshold is the whole of it: the shift's clock times, breaks, grace, rule and OT
      // windows are unchanged, and a Full day halves nothing.
      const {scheduledMinutes:sched,shiftEnd,crosses,normalMinutesOverride:override}=workingShiftSchedule({
        start:ds.start,end:ds.end,crosses:ds.crosses,breakMinutes:ds.brk,
        roundingMinutes:ds.rounding,normalMinutesOverride:ds.override},kind==='half'?'half':'full');
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
          end: shiftEnd!,
          crosses,
          normalMinutes: override ?? sched,
          earlyGrace,
        }),
        scheduledMinutes: sched,
        fullDayNormalMinutes:workingShiftSchedule({start:ds.start,end:ds.end,crosses:ds.crosses,breakMinutes:ds.brk,roundingMinutes:ds.rounding,normalMinutesOverride:ds.override},'full').normalMinutes,
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
        flexiDuration: ds.shiftType === 'semi_flexi',
        otRule: ds.otRule ?? null,
        otWindows,
        rule,
        scheduledStart: ds.start,
        scheduledEnd: shiftEnd,
        lateGraceMinutes: lateGrace,
        earlyGraceMinutes: earlyGrace ?? 0,
        crossesMidnight: crosses,
        source: 'default-shift',
        scheduleDayKind: kind === 'half' ? 'half' : 'full',
        displayShiftId: ds.shiftId,
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
      return { ...policyBranch('workday'), scheduledMinutes: 0, normalMinutesOverride: null, scheduleDayKind: 'off', source: 'default-shift-rest' };
    }
    return { ...policyBranch('rest_day'), scheduleDayKind: 'rest', source: 'default-shift-rest' };
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
  closedIntervals?: readonly ClosedClockInterval[],
): DerivedDay {
  // r274 (439565ff) — A DURATION-BASED FLEXI DAY HAS NO FIXED ARRIVAL PENALTY. `lateAfter` is still resolved (it is
  // shift start + grace, and the column is NOT NULL), but on this type the shift's start is the earliest
  // clocking accepted rather than a time anybody must arrive by, so comparing against it would record a
  // 08:31 arrival as late on a shift whose only requirement is nine hours.
  const exemption=exceptionRevisionOn(s.rule?.exceptions,attendanceDate);
  const exceptionActive=exemption?.enabled===true;
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
  const deductible = deductionsApplyOn(s.rule, attendanceDate) && !exceptionActive;
  // Lateness is a workday concept measured against a schedule; rest-day / holiday work has no start to be
  // late against (the same reason `status` never reads 'late' on those days).
  // NULL on duration-based flexi, not 0: zero minutes late asserts they arrived on time against a start that does
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
    ...(exceptionActive?{exemption:{revisionId:exemption!.id,effectiveFrom:exemption!.effectiveFrom,types:['absent','late','early_out'] as const}}:{}),
    schedule: {
      source: s.source,
      shiftId: s.displayShiftId ?? null,
      dailyCutoffMinutes: s.dailyCutoffMinutes,
      dayType: s.dayType,
      fixedClockApplicable:s.dayType==='workday'&&!s.flexiDuration,
      ...(s.fullDayNormalMinutes==null?{}:{fullDayNormalMinutes:s.fullDayNormalMinutes}),
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
    // Semi Flexi retains its existing explicit/derived half-day cutoff. Full Flexi has no
    // clock anchors; a date corrected to Off also has no half-day attendance requirement.
    (!s.flexiDuration || (!s.durationOnly && s.scheduleDayKind !== 'off')) &&
    status !== 'late' &&
    toMinutes(checkOutAt) < toMinutes(s.halfDayBefore)
  ) {
    status = 'half_day';
  }
  const intervals=s.durationOnly?(closedIntervals??[{inAbs:toMinutes(checkInAt),outAbs:toMinutes(checkInAt)+spanMinutes(checkInAt,checkOutAt)}]):undefined;
  const span = intervals?intervals.reduce((n,p)=>n+p.outAbs-p.inAbs,0):spanMinutes(checkInAt, checkOutAt);
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
  const durationBreak=intervals?fullFlexiBreakMinutes(intervals,s.breakPeriods,s.breakMinutes,s.flexibleBreakMinutes):null;
  const workedMinutes = durationBreak!=null?Math.max(0,span-durationBreak):spannedBreak != null ? Math.max(0, span - spannedBreak) : workedFromSpan(span, s.breakMinutes);
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
  } else if ((w || intervals) && s.otWindows && s.otWindows.length > 0) {
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
    earlyOtMinutes = w?Math.max(0, Math.min(w.outAbs, w.startAbs) - w.inAbs):0;
    const firstInterval=intervals?.[0];
    const fromWindows = otMinutesFromWindows(s.otWindows, w?{inAbs:w.inAbs,outAbs:w.outAbs}:firstInterval!, w?.startAbs??firstInterval!.inAbs,intervals);
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

  const calculatedOtMinutes=otMinutes;
  const effectiveOt=effectiveOvertimeRows(otMinutes,s.dayType,s.rule,s.manualOtRows);
  otMinutes=effectiveOt.total;
  if(Object.keys(s.manualOtRows??{}).length&&otMinutes>workedMinutes)throw new Error('Manual overtime exceeds the recorded working minutes. Review the manual rows before recalculating.');
  const otSplit=effectiveOt.split;

  // ── 7c834696 POINT 3 · finish the trace. Reads the finished figures; writes none of them. ───────────
  const trace = baseTrace();
  trace.schedule.breakSpanned = durationBreak ?? spannedBreak;
  trace.punch = {
    inAbs: inAbsRaw, outAbs: inAbsRaw + span, spanMinutes: span, workedMinutes,
    calculationIntervals: (intervals ?? [{inAbs: w?.inAbs ?? inAbsRaw, outAbs: (w?.inAbs ?? inAbsRaw) + span}]).map(part => ({...part})),
    intervalSource: intervals && closedIntervals ? 'closedPunchPairs' : 'elapsedEnvelope',
  };
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
        ? { applied: calculatedOtMinutes !== otBeforeRounding, beforeMinutes: otBeforeRounding, afterMinutes: calculatedOtMinutes }
        : null,
    minutes: otMinutes,
    split: otSplit,
    calculatedMinutes:calculatedOtMinutes,
    calculatedSplit:effectiveOt.calculatedSplit,
    rows:effectiveOt.rows,
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
      type:shift.type,override:shift.normalMinutesOverride,
      shiftType:shift.type,start: shift.startTime,
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
    if(r.type==='full_flexi'&&!r.isRestDay&&r.override!=null){schedByDate.set(r.shiftDate,r.override);continue;}
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
    type:shift.type,override:shift.normalMinutesOverride,
    shiftType:shift.type,start: shift.startTime,
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
      net:sr.type==='full_flexi'?sr.override??0:netScheduledMinutes(sr.start!,sr.end!,sr.crosses,sr.brk,sr.rounding),
      ...clampWeek(sr.ruleId, sr),
    });
  }
  let cachedClamp: ClampShift | null = null;
  if (cachedRow) {
    cachedClamp = {
      net:cachedRow.type==='full_flexi'?cachedRow.override??0:netScheduledMinutes(cachedRow.start!,cachedRow.end!,cachedRow.crosses,cachedRow.brk,cachedRow.rounding),
      ...clampWeek(cachedRow.ruleId, cachedRow),
    };
  }
  const clampRotations = await rotationLookupTx(tx);
  const clampOn = (d: string): ClampShift | null => {
    const p = pickArrangementOn(periods, d);
    const raw = p ? ladderShifts.find(s => s.id === p.shiftId) : cachedRow;
    const rotation = clampRotations(clampEmp?.ruleId ?? raw?.ruleId, d);
    if (rotation) {
      const row = rotationScheduleRow(rotation, d);
      const sched = workingShiftSchedule({start:row.start,end:row.end,crosses:row.crosses,breakMinutes:row.brk,
        roundingMinutes:row.rounding,normalMinutesOverride:row.override,type:row.shiftType},'full');
      return { ...row, net: sched.normalMinutes };
    }
    return p ? (clampByShiftId.get(p.shiftId) ?? null) : cachedClamp;
  };

  const datedOverrides=await attendanceDateOverridesTx(tx,[employmentId],window.from,window.to);
  let payableMinutes = 0;
  for (const row of rows) {
    const dated=datedOverrides.get(`${employmentId}|${row.date}`);
    if(dated){payableMinutes+=Math.min(row.workedMinutes??0,dated.shiftId?dated.shiftDisplay.scheduledMinutes??0:0);continue;}
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

export type GeoInput = { lat: number; lng: number;accuracy?:number };

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

/** Shared policy projection. Current-schedule classification is used only by canonical schedule/
 * calendar recompute owners; ordinary clock mutations retain the day classification already stored.
 * The helper does not write a raw day or grant approval and never accepts a posted day type. */
async function policyRawDayProjectionTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;
 fallbackIn:string|null;fallbackOut:string|null;classification?:'stored'|'currentSchedule'}){
  const raw=await attendancePolicyRawInputTx(tx,ctx,p);
  if(raw.state==='unavailable')throw Error('Canonical raw Attendance inputs are unavailable.');
  if(raw.state!=='policy')return {state:'legacy' as const};
  const current=await scheduleFor(tx,p.employmentId,p.date);
  const [day]=await tx.select({dayType:attendance.dayType}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
    eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  const sched=p.classification!=='currentSchedule'&&day?.dayType?{...current,dayType:day.dayType}:current;
  const first=raw.clocks?.checkInMillisecond;
  const inLabel=first===undefined||first===null?p.fallbackIn:fmtTime(Math.floor(first/60000)%1440);
  const template=raw.source.state==='known'&&first!==undefined&&first!==null&&inLabel
    ?deriveAttendance({...sched,manualOtRows:{}},inLabel,null,p.date).trace:null;
  const columns=attendancePolicyRawDay(raw,{rule:sched.rule,template,dayType:sched.dayType,
    halfDayBefore:toMinutes(sched.halfDayBefore),fallbackIn:p.fallbackIn,fallbackOut:p.fallbackOut});
  return {state:'policy' as const,schedule:sched,columns};
}

/**
 * R45 92bdf77a — Multiple Clocking. Re-derive the day AGGREGATE row from its child punches after a punch is
 * appended. Stage-1 rule (per the approved plan): official Clock-In = the earliest in-punch, official
 * Clock-Out = the latest out-punch, and the day only "closes" (worked/OT computed) when the in/out punches
 * BALANCE (equal count, ≥1 each). This legacy branch is retained only for uncovered dates and
 * frozen legacy applications. New dated policies use the complete captured-clock projection below.
 * An unbalanced legacy day — a single clocking, or a forgotten clock-out — keeps
 * checkOutAt null, so worked/OT stay null and the read-time 'odd' flag (core/attendance-derive.ts) surfaces
 * it for manager/HR review instead of silently miscounting. Worked/OT themselves come from the SAME
 * deriveAttendance the single-pair path used (first-in → last-out span, minus the shift break) — byte-
 * identical for the overwhelming single-pair case. Deferred (stage 2, documented GAP): per-pair unpaid-break,
 * pre-shift/early-OT attribution, split shifts, cross-midnight multi-punch.
 */
async function recomputeDayFromPunches(
  tx: Tx, ctx: SessionContext,
  p: { employmentId:string; attendanceId: string; attendanceDate: string; sched: ResolvedSchedule; fallbackCheckInAt: string | null },
): Promise<{
  status: 'present' | 'late' | 'half_day';
  workedMinutes: number | null;
  otMinutes: number | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  policyRaw:boolean;
}> {
  const punches = await tx
    .select({ punchAt: attendancePunch.punchAt, direction: attendancePunch.direction })
    .from(attendancePunch)
    .where(and(eq(attendancePunch.attendanceId, p.attendanceId), isNull(attendancePunch.voidedAt)));
  const ins=punches.filter(row=>row.direction==='in').map(row=>row.punchAt).sort();
  const outs=punches.filter(row=>row.direction==='out').map(row=>row.punchAt).sort();
  const projected=await policyRawDayProjectionTx(tx,ctx,{employmentId:p.employmentId,date:p.attendanceDate,
    fallbackIn:ins[0]??p.fallbackCheckInAt,fallbackOut:outs.at(-1)??null});
  if(projected.state==='policy'){
    const set=projected.columns;
    await tx.update(attendance).set(set).where(and(eq(attendance.id,p.attendanceId),eq(attendance.tenantId,ctx.tenantId)));
    return {status:set.status,workedMinutes:set.workedMinutes,otMinutes:set.otMinutes,checkInAt:set.checkInAt,checkOutAt:set.checkOutAt,policyRaw:true};
  }
  const { set, result } = deriveDayFromPunchList(p.sched, p.attendanceDate, punches, p.fallbackCheckInAt);
  if (set) await tx.update(attendance).set(set).where(eq(attendance.id, p.attendanceId));
  return {...result,policyRaw:false};
}

/**
 * The rule recomputeDayFromPunches applies, over punches already in hand — so a caller that holds a whole
 * file's punches (r424's batched import) works each day out with EXACTLY this rule and no second read.
 * `set` is what the day row receives, or null when there is nothing to derive.
 */
function deriveDayFromPunchList(
  sched: ResolvedSchedule,
  attendanceDate: string,
  punches: { punchAt: string; direction: 'in' | 'out' }[],
  fallbackCheckInAt: string | null,
) {
  if(sched.durationOnly){
   const paired=fullFlexiIntervals(punches,fallbackCheckInAt,sched.dailyCutoffMinutes);
   if(!paired.checkInAt)return {set:{checkInAt:null,checkOutAt:null,status:'present' as const,workedMinutes:null,otMinutes:null},result:{checkInAt:null,checkOutAt:null,status:'present' as const,workedMinutes:null,otMinutes:null}};
   const d=deriveAttendance(sched,paired.checkInAt,paired.checkOutAt,attendanceDate,paired.intervals);
   const {status,workedMinutes,otMinutes}=d;
   return {set:{checkInAt:paired.checkInAt,checkOutAt:paired.checkOutAt,status,workedMinutes,otMinutes,...stage1Columns(d)},result:{status,workedMinutes,otMinutes,checkInAt:paired.checkInAt,checkOutAt:paired.checkOutAt}};
  }
  const ins = punches.filter((x) => x.direction === 'in').map((x) => x.punchAt);
  const outs = punches.filter((x) => x.direction === 'out').map((x) => x.punchAt);
  // Preserve the payroll minute owner; seconds only resolve equal-minute clock metadata.
  const compareClock = (a: string, b: string) =>
    toMinutes(a) - toMinutes(b) || Number(a.split(':')[2] ?? 0) - Number(b.split(':')[2] ?? 0);
  const minAt = (xs: string[]) => xs.reduce((a, b) => (compareClock(b, a) < 0 ? b : a));
  const maxAt = (xs: string[]) => xs.reduce((a, b) => (compareClock(b, a) > 0 ? b : a));
  const checkInAt = ins.length ? minAt(ins) : fallbackCheckInAt;
  const balanced = ins.length >= 1 && ins.length === outs.length;
  // r430 — checkOutAt is now computed for STORAGE/VISIBILITY independently of `balanced`: a clock-out with
  // no matching clock-in (or any other unbalanced mix) must still land on the row, never vanish. Only a
  // BALANCED day is handed to deriveAttendance below — an unbalanced one keeps worked/OT null so the
  // read-time 'odd' flag (core/attendance-derive.ts flagOf, hasIn !== hasOut) surfaces it for a manager,
  // the same way a lone clock-in with no clock-out already does today.
  // ...but ONLY where there is no clock-in to anchor the day. A day that HAS a clock-in keeps the pre-r430
  // rule exactly (an unbalanced one — in, out, in — stays OPEN with no stored clock-out, which the R45
  // re-open and the clocking-import odd-count tests pin); only the out-first day needs the new storage.
  const checkOutAt = outs.length && (balanced || !checkInAt) ? maxAt(outs) : null;
  if (!checkInAt && !checkOutAt) {
    // No punches and no fallback anchor at all — the true zero-punch defensive case; nothing to derive.
    return {
      set: null,
      result: { status: 'present' as const, workedMinutes: null, otMinutes: null, checkInAt: null, checkOutAt: null },
    };
  }
  if (!checkInAt) {
    // r430 — an OUT-FIRST day: a clock-out with no clock-in beforehand. The old code returned `set: null`
    // here (checkInAt falsy bailed out entirely), which silently dropped the clock-out from the aggregate
    // even though the punch itself was correctly saved — exactly the incident this round exists to surface.
    // Stored and flagged instead: checkOutAt lands on the row, checkInAt stays null, worked/OT stay null
    // (nothing to compute without an in-punch).
    return {
      set: { checkInAt: null, checkOutAt, status: 'present' as const, workedMinutes: null, otMinutes: null },
      result: { status: 'present' as const, workedMinutes: null, otMinutes: null, checkInAt: null, checkOutAt },
    };
  }
  const d = deriveAttendance(sched, checkInAt, balanced ? checkOutAt : null, attendanceDate);
  const { status, workedMinutes, otMinutes } = d;
  return {
    // 7c834696: worked/OT are written exactly as before; the stage-1 columns are added alongside them.
    // Byte-identical to pre-r430 for every balanced (completed/paired) day: checkOutAt here is the same
    // value the old `balanced && outs.length ? maxAt(outs) : null` produced whenever balanced is true.
    set: { checkInAt, checkOutAt, status, workedMinutes, otMinutes, ...stage1Columns(d) },
    result: { status, workedMinutes, otMinutes, checkInAt: checkInAt as string | null, checkOutAt },
  };
}

/** Attendance can bank TOIL and ensure its replacement catalogue. Own exclusive configuration
 * BEFORE any schedule/credit/legacy Attendance lock; callers must roll back the WHOLE Tx on refusal.
 * This is dependency protection, not authority: original self/admin/device/workflow gates still run. */
export async function lockAttendanceLeaveDependenciesTx(tx: Tx, ctx: SessionContext, employmentIds: readonly string[]) {
  const tenantId = ctx.tenantId, ids = [...new Set(employmentIds)].sort();
  await lockAccessConfigurationTx(tx, tenantId);
  await lockLeaveDependencyConfigurationTx(tx, tenantId);
  if (ids.length) await lockLeaveDependenciesTx(tx, tenantId, ids);
}
function captureAttendanceContext(ctx: SessionContext): SessionContext {
  return {...ctx, roles:ctx.roles?.slice(), grants:ctx.grants?.map(grant=>({...grant}))};
}

export async function checkInTx(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string; deviceGateExempt?: boolean; clockCaptureId?: string; preciseOrder?: boolean; manual?: boolean; method?: 'web' | 'mobile_offline' },
  existingTx?: Tx,
) {
  ctx = captureAttendanceContext(ctx); p = structuredClone(p);
  const perform = async (tx: Tx) => {
    await lockAttendanceLeaveDependenciesTx(tx, ctx, [p.employmentId]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + p.employmentId}, 0))`);
    // Feedback 5249d43f: registered-device gate FIRST — when the company policy requires it, an absent /
    // unknown / revoked token throws the typed DeviceNotRegisteredError before anything is evaluated or
    // written (policy OFF ⇒ no-op). Terminal imports bypass by construction (they never call checkIn).
    // r430 — Web Clocking's own self-capture path is a documented, deliberate exemption from this gate
    // regardless of the policy (ADR-0070 amendment): deviceGateExempt:true skips the call entirely. The
    // any other caller (the administrator's manual checkIn/checkOut, which has no screen since r435) never
    // sets it, so that path stays fully policy-gated.
    if (!p.deviceGateExempt) await enforceDeviceGateTx(tx, { employmentId: p.employmentId, deviceToken: p.deviceToken });
    // r434 — an approved correction owns its day: refuse BEFORE anything is read or written.
    await assertDayNotOwnedByCorrectionTx(tx, p.employmentId, p.date);

    const [existing] = await tx
      .select({ id: attendance.id, dayType: attendance.dayType, checkInAt:attendance.checkInAt })
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);

    const sched0 = await scheduleFor(tx, p.employmentId, p.date);
    // Freeze the day-type stamped at the FIRST check-in (existing row) — same rule check-out applies.
    const sched: ResolvedSchedule = existing?.dayType ? { ...sched0, dayType: existing.dayType } : sched0;
    const dayType = sched.dayType;

    // R45: a SECOND (or later) clock-in of the day is now allowed (multiple clocking). Keep punches monotonic
    // on a non-cross-midnight day: a new clocking must be later than every punch already recorded today.
    // The rule itself is clockPunchOrderRefusal's; the latest punch is read only where it can refuse.
    const [last] = existing && !sched.crossesMidnight && !sched.durationOnly && !p.preciseOrder
      ? await tx
        .select({ punchAt: attendancePunch.punchAt })
        .from(attendancePunch)
        .where(and(eq(attendancePunch.attendanceId, existing.id), isNull(attendancePunch.voidedAt)))
        .orderBy(desc(attendancePunch.punchAt))
        .limit(1)
      : [];
    const inOrder = clockPunchOrderRefusal({ direction: 'in', time: p.time, preciseOrder: p.preciseOrder, crossesMidnight: sched.crossesMidnight,
      durationOnly: sched.durationOnly, dayExists: !!existing, punchTimes: last ? [last.punchAt] : [], checkInAt: existing?.checkInAt ?? null });
    if (inOrder) throw new Error(inOrder);

    // ADR-0070: resolve the geofence outcome BEFORE writing. Throws (rolling back this transaction, no
    // row/event written) when enforced and outside every assigned site — the caller catches it outside
    // this transaction and appends the blocked event separately.
    const geo = await resolveGeofence(tx, {
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.geo?.lat,
      lng: p.geo?.lng,
      accuracy:p.geo?.accuracy,
      punch: 'in',
      // r423 — a time HR typed in has no phone position behind it: never compared with a location.
      skip: p.manual,
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
          checkInMethod: p.method ?? 'web',
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
      method: p.method ?? 'web',
      clockCaptureId: p.clockCaptureId,
      ...punchGeoValues(geo),
    });

    const derived = await recomputeDayFromPunches(tx, ctx, {
      employmentId:p.employmentId,attendanceId,
      attendanceDate: p.date,
      sched,
      fallbackCheckInAt: p.time,
    });
    // Capture after deriving the first actual in, including out-first rows. Repeated in-punches retain
    // the original context; historical imports never borrow today's profile.
    if (!existing||existing.checkInAt==null) await captureCanonicalOvertimePersonnelContextTx(tx, ctx, {employmentId: p.employmentId, date: p.date});
    await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:p.date,reason:'Recorded clock-in'});

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
  };
  return existingTx ? perform(existingTx) : withTenant(ctx, perform);
}

/** Check in. `geo` is optional — omitted/undefined when the browser gave no coordinates (allowed only
 *  while geofencing is OFF for this employment; see resolveGeofence). Catches OutsideGeofenceError
 *  OUTSIDE the write transaction and appends the blocked event in its own transaction before rethrowing
 *  (ADR-0070 §3 — the only way a blocked ATTEMPT can be durably recorded once its write rolled back). */
export async function checkIn(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string; manual?: boolean },
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

export async function checkOutTx(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string; deviceGateExempt?: boolean; clockCaptureId?: string; preciseOrder?: boolean; manual?: boolean; method?: 'web' | 'mobile_offline' },
  existingTx?: Tx,
) {
  ctx = captureAttendanceContext(ctx); p = structuredClone(p);
  const perform = async (tx: Tx) => {
    await lockAttendanceLeaveDependenciesTx(tx, ctx, [p.employmentId]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + p.employmentId}, 0))`);
    // Feedback 5249d43f: same registered-device gate as checkInTx — see the comment there (r430: same
    // deviceGateExempt escape hatch).
    if (!p.deviceGateExempt) await enforceDeviceGateTx(tx, { employmentId: p.employmentId, deviceToken: p.deviceToken });
    // r434 — an approved correction owns its day: refuse BEFORE anything is read or written.
    await assertDayNotOwnedByCorrectionTx(tx, p.employmentId, p.date);

    const [existingRec] = await tx
      .select()
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);

    // Resolve the roster/policy schedule — needed either to freeze the day-type stamped at check-in
    // (tolerating legacy rows) or, for a brand-new out-first row, to stamp it in the first place.
    const sched0 = await scheduleFor(tx, p.employmentId, p.date);

    let rec: typeof attendance.$inferSelect;
    if (existingRec) {
      rec = existingRec;
    } else {
      // r430 — a clock-out with NO prior clock-in is now allowed rather than refused ("No check-in
      // recorded for this day"). Create the day row with no check-in, mirroring checkInTx's own-row
      // creation (above) but with every check-in field left null/placeholder — this IS the "no check-in
      // yet" state, not an inferred one. deriveDayFromPunchList (recomputeDayFromPunches below) is what
      // makes the out-punch VISIBLE on the aggregate once it lands, the same way a forgotten clock-out
      // already surfaces via the 'odd' flag.
      const [row] = await tx
        .insert(attendance)
        .values({
          tenantId: ctx.tenantId,
          employmentId: p.employmentId,
          attendanceDate: p.date,
          checkInAt: null,
          status: 'present',
          dayType: sched0.dayType,
          checkInMethod: null,
        })
        .returning();
      rec = row;
    }

    // On a non-cross-midnight schedule check-out must be after the last punch; a cross-midnight shift
    // may legitimately check out at an earlier time-of-day (next day) — but never at the exact last-punch time.
    const sched: ResolvedSchedule = rec.dayType ? { ...sched0, dayType: rec.dayType } : sched0;

    // R45 Multiple Clocking: a checkout after a completed pair now APPENDS an out-punch (was: throw
    // 'Already checked out'). Order against the latest punch already recorded (or the row's check-in for a
    // legacy row that predates the punch table).
    const existingPunches = await tx
      .select({ punchAt: attendancePunch.punchAt })
      .from(attendancePunch)
      .where(and(eq(attendancePunch.attendanceId, rec.id), isNull(attendancePunch.voidedAt)));
    const outOrder = clockPunchOrderRefusal({ direction: 'out', time: p.time, preciseOrder: p.preciseOrder, crossesMidnight: sched.crossesMidnight,
      durationOnly: sched.durationOnly, dayExists: true, punchTimes: existingPunches.map((punch) => punch.punchAt), checkInAt: rec.checkInAt });
    if (outOrder) throw new Error(outOrder);

    // ADR-0070: resolve the geofence outcome for the CHECK-OUT punch — independent of the check-in punch's
    // status/radius (a mid-day toggle or radius change is representable; each punch freezes its own).
    const geo = await resolveGeofence(tx, {
      employmentId: p.employmentId,
      date: p.date,
      time: p.time,
      lat: p.geo?.lat,
      lng: p.geo?.lng,
      accuracy:p.geo?.accuracy,
      punch: 'out',
      skip: p.manual,
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
      method: p.method ?? 'web',
      clockCaptureId: p.clockCaptureId,
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
        checkOutMethod: p.method ?? 'web',
      })
      .where(eq(attendance.id, rec.id));

    // Workday OT = beyond the scheduled net day; rest-day/holiday work is OT-class in full (EA 1955 pays it
    // at premium rates — classification here, monetization in payroll). Derived from first-in / last-out.
    const derived = await recomputeDayFromPunches(tx, ctx, {
      employmentId:p.employmentId,attendanceId: rec.id,
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
    const plannedOt = derived.policyRaw?null:await applyApprovedOtPlanTx(tx, ctx, {
      employmentId: p.employmentId,
      date: p.date,
      attendanceId: rec.id,
      sched,
      systemOtMinutes: derived.otMinutes,
    });
    const otMinutes = plannedOt ?? derived.otMinutes;
    if (plannedOt == null) await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:p.date,reason:'Recorded clock-out'});
    if(derived.policyRaw&&derived.checkInAt&&derived.checkOutAt){
      const [plan]=await tx.select({createdAt:attendanceCorrection.createdAt}).from(attendanceCorrection)
        .innerJoin(attendancePolicyRequestContract,and(eq(attendancePolicyRequestContract.correctionId,attendanceCorrection.id),
          eq(attendancePolicyRequestContract.tenantId,attendanceCorrection.tenantId)))
        .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.employmentId,p.employmentId),
          eq(attendanceCorrection.attendanceDate,p.date),eq(attendanceCorrection.status,'approved'),isNull(attendanceCorrection.cancelledAt),
          isNotNull(attendancePolicyRequestContract.policyBinding),isNotNull(attendancePolicyRequestContract.plannedWindow),
          isNull(attendancePolicyRequestContract.attestedWork)))
        .orderBy(desc(attendanceCorrection.decidedAt),desc(attendanceCorrection.createdAt),desc(attendanceCorrection.id)).limit(1);
      if(plan)await maybeAutoAccrueOnApprovalTx(tx,ctx,{employmentId:p.employmentId,workedDate:p.date,dayType,
        requestedOn:todayInKualaLumpur(plan.createdAt)});
    }

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
  };
  return existingTx ? perform(existingTx) : withTenant(ctx, perform);
}

/** Check out. Same optional-geo / blocked-event contract as checkIn (ADR-0070 §3). */
export async function checkOut(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string; geo?: GeoInput; deviceToken?: string; manual?: boolean },
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
  exceptionExempt?:boolean;
  exceptionRevisionId?:string|null;
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
type RosterDisplayRow = {shiftType?:string|null;override?:number|null; isRestDay: boolean; code: string | null; start: string | null; end: string | null; brk: number | null; crosses: boolean | null; rounding: number | null };
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
export type WeekLookup = (shiftRuleId: string | null | undefined, sh: WeekPattern, employeeRuleId?: string | null) => WeekPattern;

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
  return (shiftRuleId, sh, employeeRuleId = empGroupRuleId) => {
    const chosen = employeeRuleId ?? shiftRuleId ?? null;
    const week = chosen ? byId.get(chosen) : fallback ? byId.get(fallback.id) : undefined;
    return weekPatternFor(week, sh);
  };
}

type DefaultShiftRow = {
  rotationKind?: 'full' | 'half' | 'off' | 'rest';
  code: string | null;
  start: string | null;
  end: string | null;
  brk: number;
  crosses: boolean;
  pattern: number[] | null;
  // b8aa3466 — the four-way row. Optional so the many places that build a DefaultShiftRow from a narrower
  // select keep compiling; absent behaves as '{}', which is the pre-0429 two-way meaning.
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
  rounding: number | null;
  shiftType?:string|null;
  override?:number|null;
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
  if (roster) return !roster.isRestDay && (roster.shiftType==='full_flexi'||(roster.start&&roster.end)) ? 'roster_shift' : 'roster_rest';
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
  // Explicit rotation opt-in uses its dated membership even before absence deductions are enabled.
  if (!deductAbsence && !def?.rotationKind) return !companyWorkingDay;
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
        scheduledMinutes:roster!.shiftType==='full_flexi'?roster!.override??null:netScheduledMinutes(roster!.start!,roster!.end!,roster!.crosses!,roster!.brk!,roster!.rounding),
        shiftStart: roster!.shiftType==='full_flexi'?null:roster!.start!.slice(0,5),
        shiftEnd: roster!.shiftType==='full_flexi'?null:roster!.end!.slice(0,5),
        isRosterRest: false,
      };
    case 'roster_rest':
      return { ...NO_SHIFT, isRosterRest: true }; // an explicit rostered rest day
    case 'default_shift': {
      // `def` already carries the effective group week. Use the calculation owner's exact half window,
      // so Records cannot display a full shift while the engine and My Roster use half a day.
      const schedule=workingShiftSchedule({start:def!.start,end:def!.end,crosses:def!.crosses,
        breakMinutes:def!.brk,roundingMinutes:def!.rounding,normalMinutesOverride:def!.override,type:def!.shiftType},shiftDayKindFor(def!,date)==='half'?'half':'full');
      return {
        shiftCode: def!.code,
        scheduledMinutes: schedule.scheduledMinutes,
        shiftStart: schedule.shiftStart?.slice(0,5)??null,
        shiftEnd: schedule.shiftEnd?.slice(0,5)??null,
        isRosterRest: false,
      };
    }
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
  return withTenant(ctx, (tx) => attendanceDayRowsTx(tx, ctx, date, companyIds, opts));
}

/**
 * r432 (e721a355) — the Daily Attendance list, paged IN SQL. `attendanceForDate` derives shift, leave and
 * holiday context for every active employee in scope and the page then sliced the result in memory; for a
 * large company that is thousands of derivations to show twenty-five rows. This selects the page's
 * employment ids first (name / employee-code search and the department filter applied in SQL, ordered by
 * employee code), then runs the SAME derivation (`attendanceDayRowsTx`, one body for both callers, so the
 * two can never decide a day differently) for those ids only.
 *
 * `total` counts every employment matching the filters, ignoring the page. `q` is trimmed and capped at
 * `ATTENDANCE_DAILY_Q_MAX`; LIKE wildcards in it are escaped so a typed "%" or "_" matches itself.
 * Fenced exactly as attendanceForDate is: withTenant + the employment/person row-level security.
 */
export const ATTENDANCE_DAILY_Q_MAX = 200;

export function attendanceForDatePage(
  ctx: SessionContext,
  date: string,
  companyIds: string[] | undefined,
  opts: { departmentId?: string; q?: string; limit: number; offset: number },
) {
  return withTenant(ctx, async (tx) => {
    const q = (opts.q ?? '').trim().slice(0, ATTENDANCE_DAILY_Q_MAX);
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const where = and(
      isNull(employment.terminatedOn),
      companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
      opts.departmentId ? eq(assignment.departmentId, opts.departmentId) : undefined,
      q ? sql`(${person.fullName} ilike ${like} or ${employment.employeeCode} ilike ${like})` : undefined,
    );
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    const [counted] = await tx
      .select({ n: sql<number>`count(distinct ${employment.id})::int` })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(where);
    const total = counted?.n ?? 0;
    const idRows = await tx
      .select({ id: employment.id })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(where)
      .groupBy(employment.id, employment.employeeCode, person.fullName)
      .orderBy(sql`${employment.employeeCode} asc nulls last`, asc(person.fullName), asc(employment.id))
      .limit(opts.limit)
      .offset(opts.offset);
    const ids = idRows.map((r) => r.id);
    if (!ids.length) return { rows: [], total };
    const derived = await attendanceDayRowsTx(tx, ctx, date, companyIds, { employmentIds: ids });
    const order = new Map(ids.map((id, i) => [id, i]));
    derived.sort((a, b) => order.get(a.employmentId)! - order.get(b.employmentId)!);
    return { rows: derived, total };
  });
}

/**
 * r432 — the punch trail for a set of attendance days (the Daily list's "several clockings" line), one read
 * for the whole page. Keyed by attendanceId like attendancePunchesForRange; time-of-day order within a day.
 */
export function attendancePunchesForDays(ctx: SessionContext, attendanceIds: string[]) {
  return withTenant(ctx, async (tx) => {
    const byAttendance = new Map<string, { punchAt: string; direction: 'in' | 'out' }[]>();
    if (!attendanceIds.length) return byAttendance;
    const punches = await tx
      .select({ attendanceId: attendancePunch.attendanceId, punchAt: attendancePunch.punchAt, direction: attendancePunch.direction })
      .from(attendancePunch)
      .where(and(inArray(attendancePunch.attendanceId, attendanceIds), isNull(attendancePunch.voidedAt)))
      .orderBy(asc(attendancePunch.attendanceId), asc(attendancePunch.punchAt), asc(attendancePunch.id));
    punches.sort((a, b) => toMinutes(a.punchAt) - toMinutes(b.punchAt));
    for (const pch of punches) {
      const list = byAttendance.get(pch.attendanceId) ?? [];
      list.push({ punchAt: pch.punchAt, direction: pch.direction as 'in' | 'out' });
      byAttendance.set(pch.attendanceId, list);
    }
    return byAttendance;
  });
}

async function attendanceDayRowsTx(
  tx: Tx,
  ctx: SessionContext,
  date: string,
  companyIds?: string[],
  opts?: { departmentId?: string; employmentIds?: string[] },
) {
  {
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
          opts?.employmentIds ? inArray(employment.id, opts.employmentIds.length ? opts.employmentIds : ['']) : undefined,
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
        shiftType:shift.type,override:shift.normalMinutesOverride,start: shift.startTime,
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
      shiftType:shift.type,override:shift.normalMinutesOverride,start: shift.startTime,
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

    const gridRotations = await rotationLookupTx(tx);
    const rawByEmp = new Map(profileShifts.map(s => [s.employmentId, s]));
    for (const eid of empIds) {
      const raw = byShiftId.get(shiftIdForDate.get(eid) ?? '') ?? rawByEmp.get(eid);
      const rotation = gridRotations(groupByEmp.get(eid) ?? raw?.ruleId, date);
      if (rotation) defaultShiftByEmp.set(eid, rotationScheduleRow(rotation, date));
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

    const datedOverrides=await attendanceDateOverridesTx(tx,empIds,date,date);
    const exceptionOn=await exceptionDecisionsTx(tx,empIds,date,date);
    const formulaByDay=await formulaOvertimeForRowsTx(tx,ctx,rows.filter(r=>r.attendanceId).map(r=>({employmentId:r.employmentId,date,calcTrace:r.calcTrace})));
    return rows.map(({ companyId, ...r }) => {
      const isWorkingDay = (daysByCompany.get(companyId) ?? DEFAULTS.workingDays).includes(dow);
      // bbada39c — shift-display subset (code / scheduled minutes / start-end / rostered-rest) for the row.
      const policyScheduled = isWorkingDay ? (policySchedByCompany.get(companyId) ?? scheduledMinutes(DEFAULTS)) : null;
      const roster = rosterByEmp.get(r.employmentId);
      const def = defaultShiftByEmp.get(r.employmentId);
      const dated=datedOverrides.get(`${r.employmentId}|${date}`);
      const shiftDisplay = dated?.shiftDisplay??resolveShiftDisplay(date, roster, def, policyScheduled);
      let context: DayContext = null;
      if (!r.attendanceId) {
        if (leaveSet.has(r.employmentId)) context = 'on_leave';
        else if (dated ? dated.dayKind==='holiday' : holidayEmp.has(r.employmentId)) context = 'holiday';
        // e2632276 — the ROSTER WINS, but only once the deduction is switched on for this employment.
        // Off (every company, day one) this is `!isWorkingDay`, byte-identical to before. On, an employee
        // rostered to rest (or whose default-shift pattern excludes the day) on a company working day
        // reads REST instead of a red "Absent", and a rostered SHIFT on a company non-working day becomes
        // a scheduled day that CAN be absent — matching what payroll will charge for.
        else if (dated ? !dated.working : isScheduledOffDay(date, roster, def, isWorkingDay, deductAbsence.has(r.employmentId)))
          context = 'rest_day';
      }
      return { ...r, formulaOvertime:formulaByDay.get(r.employmentId+'|'+date)??null, ...(exceptionOn(r.employmentId,date).enabled?{exceptionExempt:true,exceptionRevisionId:exceptionOn(r.employmentId,date).revisionId}:{}), ...(dated?{dayType:dated.dayKind==='holiday'?'holiday' as const:dated.dayKind==='rest_day'?'rest_day' as const:'workday' as const}:{}),context, ...shiftDisplay };
    });
  }
}

export type AttendanceRangeRow = {
  formulaOvertime?:FormulaOvertimeRecord|null;
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
  /** Opt-in observation identity, from the exact SQL snapshot that read the displayed punch. */
  punchReview?: {fingerprint:string;reviewed:boolean}|null;
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
export async function attendanceForEmploymentRange(
  ctx: SessionContext, employmentId: string, from: string, to: string,
): Promise<AttendanceRangeRow[]> {
  return (await attendanceForEmploymentsRange(ctx, [employmentId], from, to)).get(employmentId) ?? [];
}

/** Canonical Records projection for a team: input reads are bounded by source groups, not cells. */
export function attendanceForEmploymentsRange(
  ctx: SessionContext, employmentIds: string[], from: string, to: string,
  opts: {includePunchReviews?:boolean} = {},
): Promise<Map<string, AttendanceRangeRow[]>> {
  return withTenant(ctx, async (tx) => {
    const result = new Map<string, AttendanceRangeRow[]>();
    if (from > to || employmentIds.length === 0) return result;
    const employees = await tx.select({id:employment.id, companyId:employment.companyId,
      employeeCode:employment.employeeCode,name:person.fullName,defShiftId:employment.defaultShiftId,
      ruleId:employment.attendanceRuleId}).from(employment)
      .innerJoin(person,eq(person.id,employment.personId)).where(inArray(employment.id,[...new Set(employmentIds)]));
    if (employees.length === 0) return result;
    const ids=employees.map(e=>e.id),companyIds=[...new Set(employees.map(e=>e.companyId))];
    const [rows,policies,approvedDates,holidaySets,rosters,arrangements,deducted] = await Promise.all([
      tx.select({employmentId:attendance.employmentId,date:attendance.attendanceDate,attendanceId:attendance.id,
        checkInAt:attendance.checkInAt,checkOutAt:attendance.checkOutAt,status:attendance.status,dayType:attendance.dayType,
        workedMinutes:attendance.workedMinutes,otMinutes:attendance.otMinutes,lateMinutes:attendance.lateMinutes,
        earlyOutMinutes:attendance.earlyOutMinutes,underMinutes:attendance.underMinutes,
        lateDeductMinutes:attendance.lateDeductMinutes,earlyOutDeductMinutes:attendance.earlyOutDeductMinutes,
        otFlatMinutes:attendance.otFlatMinutes,ot00Minutes:attendance.ot00Minutes,ot10Minutes:attendance.ot10Minutes,
        ot15Minutes:attendance.ot15Minutes,ot20Minutes:attendance.ot20Minutes,ot30Minutes:attendance.ot30Minutes,
        calcTrace:attendance.calcTrace,
        ...(opts.includePunchReviews ? {
          punchReviewFingerprint:sql<string>`app.attendance_attention_fingerprint(${attendance})`,
          // A PgColumn interpolation in a single-table SELECT is unqualified by Drizzle.
          // Inside EXISTS that would bind review.id; keep the outer attendance identifier explicit.
          punchReviewed:sql<boolean>`EXISTS(SELECT 1 FROM attendance_attention_review r WHERE r.attendance_id=${sql.identifier('attendance')}.${sql.identifier('id')}
            AND r.reviewer_user_id=app.current_user_id() AND r.fingerprint=app.attendance_attention_fingerprint(${attendance}))`,
        } : {}),
      }).from(attendance).where(and(inArray(attendance.employmentId,ids),
          gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to))),
      tx.select({companyId:attendancePolicy.companyId,workingDays:attendancePolicy.workingDays,
        halfWorkingDays:attendancePolicy.halfWorkingDays,workStart:attendancePolicy.workStart,
        workEnd:attendancePolicy.workEnd,breakMinutes:attendancePolicy.breakMinutes})
        .from(attendancePolicy).where(inArray(attendancePolicy.companyId,companyIds)),
      approvedLeaveDates(tx,ids,from,to),
      holidayDatesByEmployment(tx,{employmentIds:ids,startDate:from,endDate:to}),
      tx.select({employmentId:rosterAssignment.employmentId,shiftDate:rosterAssignment.shiftDate,
        isRestDay:rosterAssignment.isRestDay,code:shift.code,shiftType:shift.type,override:shift.normalMinutesOverride,start:shift.startTime,end:shift.endTime,
        brk:shift.breakMinutes,crosses:shift.crossesMidnight,rounding:shift.normalHoursRoundingMinutes})
        .from(rosterAssignment).leftJoin(shift,eq(shift.id,rosterAssignment.shiftId))
        .where(and(inArray(rosterAssignment.employmentId,ids),gte(rosterAssignment.shiftDate,from),lte(rosterAssignment.shiftDate,to))),
      liveArrangementsTx(tx,ids),deductAbsentDaysByEmployment(tx,ids),
    ]);
    const shiftIds=[...new Set(employees.flatMap(e=>{
      const periods=arrangements.get(e.id)??[];
      return periods.length ? periods.map(p=>p.shiftId) : e.defShiftId ? [e.defShiftId] : [];
    }))];
    const rangeShifts=shiftIds.length ? await tx.select({id:shift.id,code:shift.code,shiftType:shift.type,override:shift.normalMinutesOverride,start:shift.startTime,
      end:shift.endTime,brk:shift.breakMinutes,crosses:shift.crossesMidnight,pattern:shift.weeklyPattern,
      halfPattern:shift.halfPattern,offPattern:shift.offPattern,ruleId:shift.ruleId,rounding:shift.normalHoursRoundingMinutes})
      .from(shift).where(inArray(shift.id,shiftIds)) : [];
    const rangeWeek=await weekLookupTx(tx,null,[...rangeShifts.map(r=>r.ruleId),...employees.map(e=>e.ruleId)]);
    const rangeRotations = await rotationLookupTx(tx);
    const datedOverrides=await attendanceDateOverridesTx(tx,ids,from,to);
    const exceptionOn=await exceptionDecisionsTx(tx,ids,from,to);
    const formulaByDay=await formulaOvertimeForRowsTx(tx,ctx,rows);
    const rowsByEmployment=new Map<string,typeof rows>();
    const rosterByEmployment=new Map<string,typeof rosters>();
    for(const row of rows){const list=rowsByEmployment.get(row.employmentId)??[];list.push(row);rowsByEmployment.set(row.employmentId,list);}
    for(const row of rosters){const list=rosterByEmployment.get(row.employmentId)??[];list.push(row);rosterByEmployment.set(row.employmentId,list);}
    for(const emp of employees){
      const employmentId=emp.id;
      const byDate=new Map((rowsByEmployment.get(emp.id)??[]).map(r=>[r.date,r]));
      const policy=policies.find(p=>p.companyId===emp.companyId);
      const leaveSet=approvedDates.get(emp.id)??new Set<string>();
      const holidays=holidaySets.get(emp.id)??new Set<string>();
      const workDays=policy ? unionWorkingDays(policy.workingDays,policy.halfWorkingDays) : DEFAULTS.workingDays;
      const policyScheduledMin=policy ? scheduledMinutes({...DEFAULTS,workStart:policy.workStart,
        workEnd:policy.workEnd,breakMinutes:policy.breakMinutes}) : scheduledMinutes(DEFAULTS);
      const rosterByDate=new Map<string,RosterDisplayRow>((rosterByEmployment.get(emp.id)??[]).map(r=>[r.shiftDate,r]));
      const periods=arrangements.get(emp.id)??[];
      const shiftById=new Map<string,DefaultShiftRow>(rangeShifts.map(sr=>[sr.id,{...sr,...rangeWeek(sr.ruleId,sr,emp.ruleId)}]));
      const cachedDefShift=periods.length===0&&emp.defShiftId ? shiftById.get(emp.defShiftId) : undefined;
      const defShiftOn=(d:string):DefaultShiftRow|undefined=>{
        const p=pickArrangementOn(periods,d);
        const raw=rangeShifts.find(s=>s.id===(p?.shiftId??emp.defShiftId));
        const rotation=rangeRotations(emp.ruleId??raw?.ruleId,d);
        return rotation ? rotationScheduleRow(rotation,d) : p ? shiftById.get(p.shiftId) : cachedDefShift;
      };
      const deductAbsence=deducted.has(employmentId);
    const out: AttendanceRangeRow[] = [];
    let d = from;
    // Guard against a pathological range; a first-of-month → today window is ≤ 31 days. The literal moved
    // to the exported ATTENDANCE_RANGE_MAX_DAYS above so a caller can bound its own range against the same
    // number instead of discovering the cliff as a short array (67268d83).
    for (let i = 0; i < ATTENDANCE_RANGE_MAX_DAYS && d <= to; i++) {
      const row = byDate.get(d);
      const dated=datedOverrides.get(`${employmentId}|${d}`);
      const isWorkingDay = workDays.includes(isoWeekday(d));
      let context: DayContext = null;
      if (!row) {
        if (leaveSet.has(d)) context = 'on_leave';
        else if (dated ? dated.dayKind==='holiday' : holidays.has(d)) context = 'holiday';
        // e2632276 — the ROSTER WINS once the deduction is on (same gate as attendanceForDate above; see
        // isScheduledOffDay). Off ⇒ `!isWorkingDay`, byte-identical to before.
        else if (dated ? !dated.working : isScheduledOffDay(d, rosterByDate.get(d), defShiftOn(d), isWorkingDay, deductAbsence))
          context = 'rest_day';
      }
      // bbada39c — per-date shift display (code / scheduled minutes / start-end / rostered-rest).
      const shiftDisplay = dated?.shiftDisplay??resolveShiftDisplay(d, rosterByDate.get(d), defShiftOn(d), isWorkingDay ? policyScheduledMin : null);
      if(opts.includePunchReviews&&row&&(typeof row.punchReviewFingerprint!=='string'||typeof row.punchReviewed!=='boolean'))
        throw new Error('Attendance punch review snapshot unavailable');
      out.push({
        ...(opts.includePunchReviews ? {punchReview:row ? {fingerprint:row.punchReviewFingerprint!,reviewed:row.punchReviewed!}:null} : {}),
        date: d,
        ...(exceptionOn(employmentId,d).enabled?{exceptionExempt:true,exceptionRevisionId:exceptionOn(employmentId,d).revisionId}:{}),
        attendanceId: row?.attendanceId ?? null,
        checkInAt: row?.checkInAt ?? null,
        checkOutAt: row?.checkOutAt ?? null,
        status: row?.status ?? null,
        dayType: dated ? dated.dayKind==='holiday'?'holiday':dated.dayKind==='rest_day'?'rest_day':'workday' : row?.dayType ?? null,
        workedMinutes: row?.workedMinutes ?? null,
        otMinutes: row?.otMinutes ?? null,
        formulaOvertime:formulaByDay.get(employmentId+'|'+d)??null,
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
      result.set(emp.id,out);
    }
    return result;
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
  /** r423 — the self-service clock capture behind this punch, or null (manual / import / legacy). */
  clockCaptureId: string | null;
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
        clockCaptureId: attendancePunch.clockCaptureId,
      })
      .from(attendancePunch)
      .leftJoin(clockingLocation, eq(clockingLocation.id, attendancePunch.clockingLocationId))
      .where(
        and(
          eq(attendancePunch.employmentId, employmentId),
          isNull(attendancePunch.voidedAt),
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
  overtimeSummary:OvertimeRecordSummary;
  overtimeCapState:'exceeded'|'within'|'unknown';
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
  p: { month: string; companyIds?: string[]; today?: string; measurement?:'raw' },
  existingTx?: Tx,
): Promise<MonthSummaryRow[]> {
  return withCanonicalAiReadTx(ctx, existingTx, 'attendance', withTenant, async (tx) => {
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
        calcTrace:attendance.calcTrace,
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
        until: today,measurement:p.measurement,
      })),
      ...(await absenceBreakdownByEmployment(tx, monthStart, monthEnd, scheduledIds, {
        rules: 'scheduled',
        until: today,measurement:p.measurement,
      })),
    ]);
    const formulaByDay=p.measurement==='raw'?new Map<string,FormulaOvertimeRecord|null>():await formulaOvertimeForRowsTx(tx,ctx,rows);
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
      // The numeric legacy fields remain the raw measurement consumed by existing allowance owners.
      // Records display uses this explicit selected-stage projection, with unknown days preserved.
      const selectedRows=myRows.map(row=>({...row,formulaOvertime:formulaByDay.get(row.employmentId+'|'+row.date)??null}));
      const overtimeSummary=summarizeOvertimeRecords(selectedRows);
      const overtimeCapState=overtimeSummary.complete?(BigInt(overtimeSummary.knownMinutes.numerator)>BigInt(OT_CAP_MINUTES)*BigInt(overtimeSummary.knownMinutes.denominator)?'exceeded' as const:'within' as const):'unknown' as const;
      return {
        employmentId: e.employmentId,
        overtimeSummary,overtimeCapState,
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
async function otApprovalCalculationFor(tx: Tx, employmentId: string, correctionId?: string): Promise<OtApprovalMethod> {
  // Newly submitted requests retain the company method observed by the submission owner.
  // This does not establish a group-policy binding, worked interval or payment authority.
  if (correctionId) {
    const [contract] = await tx.select().from(attendancePolicyRequestContract)
      .where(and(eq(attendancePolicyRequestContract.correctionId, correctionId),
        eq(attendancePolicyRequestContract.employmentId, employmentId))).limit(1);
    if (contract?.kind === 'epoch') {
      const method = contract.manualApprovalMethod;
      if (!method || !['requested', 'system_calculated', 'smaller_of', 'greater_of'].includes(method))
        throw new Error('The submitted overtime calculation method is unavailable.');
      return method;
    }
  }

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

export type AttendanceCorrectionRequestInput={
    clockChanges?: ClockChanges;
    employmentId: string;
    date: string;
    checkIn?: string | null;
    checkOut?: string | null;
    requestedOtMinutes?: number | null;
    /** HR records actual completed work separately from a clock correction or approved plan. */
    unclockedWork?:Pick<AttendancePolicyUnclockedWork,'completeWorkedDay'|'intervals'|'requestedIntervals'>;
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
  };
/** Canonical human-input validation shared by ordinary submission and supplied-Tx preparation. */
function normalizeAttendanceCorrectionRequest(input:AttendanceCorrectionRequestInput){
 const p=structuredClone(input);
  if (p.clockChanges && (p.clockChanges.version !== 1 || !/^[0-9a-f]{64}$/.test(p.clockChanges.baseline))) throw new Error('Invalid clock-data correction.');
  const clockChanges = p.clockChanges ? { version: 1 as const, baseline: p.clockChanges.baseline, entries: validateClockEntries(p.clockChanges.entries) } : null;
  if (clockChanges && (p.checkIn || p.checkOut || p.requestedOtMinutes != null)) throw new Error('Save clock data separately from overtime requests.');
  const checkIn = p.checkIn ?? null;
  const checkOut = p.checkOut ?? null;
  const hasOt = p.requestedOtMinutes != null;
  if ((clockChanges || checkIn || checkOut) && p.date > todayInKualaLumpur()) {
    throw new AttendanceCorrectionFutureDateError();
  }
  // At least one of clock-in / clock-out / OT (mirrors the DB check constraint, with a friendly message).
  if (!clockChanges && !checkIn && !checkOut && !hasOt) {
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
  if (clockChanges && reason.length > 500) throw new Error('The clock-data correction reason must be at most 500 characters.');
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
  if (plannedStartTime && plannedEndTime && plannedOvertimeMinutes(plannedStartTime, plannedEndTime) == null) {
    throw new Error('Enter different valid start and end times.');
  }
  const unclockedWork=p.unclockedWork?validateAttendancePolicyUnclockedWork({version:1,completeWorkedDay:p.unclockedWork.completeWorkedDay,sourceDate:p.date,reason,
    intervals:p.unclockedWork.intervals,...(p.unclockedWork.requestedIntervals!==undefined?{requestedIntervals:p.unclockedWork.requestedIntervals}:{})},Date.now(),requestedOtMinutes??undefined):undefined;
  if(unclockedWork&&(clockChanges||checkIn||checkOut||plannedStartTime||plannedEndTime||!requestedOtMinutes
    ||p.date>todayInKualaLumpur()))throw Error('Unclocked overtime needs a completed worked day and a separate overtime-only request.');
  const otReasonCategory = p.otReasonCategory ?? null;
  // 2166ef79 — the remark is OPTIONAL and stays optional in stage one: the reporter's "Require Remark"
  // switch belongs to the Attendance Request Settings screen, which is deliberately stage two. An empty
  // string stores as NULL rather than as a blank note nobody wrote.
  const remark = (p.remark ?? '').trim() || null;
  if (p.requestKind && ((p.requestKind === 'self_overtime') !== (!clockChanges && !checkIn && !checkOut && hasOt))) throw new Error('The application type does not match the requested clock or overtime changes.');
  const requestKind = p.requestKind ?? (attendanceApplicationType({ proposedCheckIn: checkIn, proposedCheckOut: checkOut, clockChanges, requestedOtMinutes }) === 'self_overtime' ? 'self_overtime' : 'other');

 return {p,hasOt,clockChanges,checkIn,checkOut,requestedOtMinutes,reason,plannedStartTime,plannedEndTime,otReasonCategory,remark,requestKind,unclockedWork};
}
/** Full canonical preflight with no correction/workflow/event INSERT. Infrastructure policy-epoch
 * initialization remains the existing canonical barrier, not a request or an approval effect. */
export async function prepareAttendanceCorrectionRequestTx(tx:Tx,ctx:SessionContext,input:AttendanceCorrectionRequestInput){
 ctx=captureAttendanceContext(ctx);assertModuleGate(ctx,'attendance');
 const {p,hasOt,clockChanges,checkIn,checkOut,requestedOtMinutes,reason,plannedStartTime,plannedEndTime,otReasonCategory,remark,requestKind,unclockedWork}=normalizeAttendanceCorrectionRequest(input);
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [subject]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1);if(!subject)throw Error('Attendance subject is unavailable.');
 p.employmentId=subject.id; // Canonical UUID spelling owns every shared source/credit lock key.
 await lockLeaveDependenciesTx(tx,ctx.tenantId,[p.employmentId]);
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
 // Normal OT may consult the policy to position an additional approved plan before the legacy
 // insertion owner. Own its existing epoch before that first lookup; unclocked work already takes
 // its actual protected day locks then this epoch in the canonical branch below.
 if(requestedOtMinutes!==null&&!unclockedWork)await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:p.employmentId,date:p.date}]);

    if(unclockedWork){
      const [subject]=await tx.select({admin:sql<boolean>`app.can_admin_employment(${employment.id})`,
        own:sql<boolean>`app.is_self_person(${employment.personId})`}).from(employment)
        .where(eq(employment.id,p.employmentId)).limit(1);
      if(!subject?.admin||subject.own)throw Error('Another authorised HR administrator must attest this employee’s unclocked work.');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
      const protectedDates=attendancePolicyUnclockedWorkDates(unclockedWork);
      for(const date of protectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:p.employmentId,date});
      await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:p.employmentId,date:p.date}]);
      await lockAttendancePayrollTx(tx,p.employmentId,protectedDates);
      const punches=await punchesForCorrectionTx(tx,p.employmentId,p.date);
      if(punches.some(row=>!row.voidedAt))throw Error('Retain existing clock evidence and use the clock-correction workflow for this day.');
    }
    if (clockChanges) {
      const [subject] = await tx.select({ allowed: sql<boolean>`app.can_admin_employment(${employment.id})` })
        .from(employment).where(eq(employment.id, p.employmentId)).limit(1);
      if (!subject?.allowed) throw new Error('Only an authorised administrator may edit clock data.');
      const rows = await punchesForCorrectionTx(tx,p.employmentId,p.date);
      if (clockChanges.baseline !== clockFingerprint(rows)) throw new ClockDataChangedError();
      const active = rows.filter(row => !row.voidedAt);
      if (clockChanges.entries.length === active.length && clockChanges.entries.every(e => active.some(row => row.id === e.id && row.punchAt === e.punchAt && row.direction === e.direction))) throw new Error('Change at least one clocking before saving.');
      for (const e of clockChanges.entries) if (e.id && !rows.some(row=>row.id===e.id)) throw new Error('Clocking does not belong to this attendance day.');
      await lockAttendancePayrollTx(tx,p.employmentId,p.date);
    }
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
        let additionalPositionedPlan=false;
        if(!clockChanges&&!checkIn&&!checkOut&&!unclockedWork&&plannedStartTime&&plannedEndTime
          &&plannedOvertimeMinutes(plannedStartTime,plannedEndTime)===requestedOtMinutes){
          // Serialize the same employee/source/configuration owners before re-reading
          // every retained plan. The pending-request unique fence still arbitrates inserts.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
          const initial=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:p.employmentId,date:p.date});
          const from=Number(plannedStartTime.slice(0,2))*60+Number(plannedStartTime.slice(3,5));
          const protectedDates=await attendancePolicyPlanProtectionDatesTx(tx,ctx,p,initial,{from,to:from+requestedOtMinutes!});
          for(const date of protectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:p.employmentId,date});
          await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:p.employmentId,date:p.date}]);
          const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:p.employmentId,date:p.date});
          additionalPositionedPlan=await attendancePolicyCompleteApprovedPlanSetTx(tx,ctx,p,context);
          if(additionalPositionedPlan)await lockAttendancePayrollTx(tx,p.employmentId,protectedDates);
        }
        if(!additionalPositionedPlan)throw new OvertimePlanAlreadyApprovedError(p.date);
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
 const pending=await tx.select({id:attendanceCorrection.id}).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId,p.employmentId),eq(attendanceCorrection.attendanceDate,p.date),eq(attendanceCorrection.status,'pending'))).limit(1);if(pending.length)throw new AttendanceCorrectionPendingError();
 const data={employmentId:p.employmentId,date:p.date,clockChanges,checkIn,checkOut,requestedOtMinutes,reason,plannedStartTime,plannedEndTime,otReasonCategory,remark,requestKind,unclockedWork};
 const source=await prepareAttendanceCorrectionInsertSourceTx(tx,ctx,data);
 const workflow=await prepareAttendanceWorkflowSnapshotTx(tx,ctx,p.employmentId,attendanceApplicationType({requestKind,proposedCheckIn:checkIn,proposedCheckOut:checkOut,clockChanges,requestedOtMinutes}));
 return {data,source,workflow,asOf:todayInKualaLumpur()};
}
export function attendanceCorrectionPreparedDigest(ctx:SessionContext,prepared:Awaited<ReturnType<typeof prepareAttendanceCorrectionRequestTx>>){return createHash('sha256').update(JSON.stringify({version:1,tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,prepared})).digest('hex');}
/** Reviewed digest is refusal-only, never a source of policy, clocks, routing, actor or approval. */
export async function requestAttendanceCorrectionTx(tx:Tx,ctx:SessionContext,input:AttendanceCorrectionRequestInput,reviewed?:{expectedDigest:string}){
 const current=captureAttendanceContext(ctx),captured=structuredClone(input),expected=reviewed?.expectedDigest,prepared=await prepareAttendanceCorrectionRequestTx(tx,current,captured);
 if(reviewed&&(typeof expected!=='string'||attendanceCorrectionPreparedDigest(current,prepared)!==expected))throw Error('Attendance source changed; review it again.');
 return insertAttendanceCorrectionRequestTx(tx,current,prepared.data,{returnEventId:true});
}
function attendanceCorrectionSubmissionFailure(error:unknown):never{
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
}
/** `existingTx` — the caller's transaction, so another owner can file and decide in one atomic unit (the offline
 *  claim resolution in packs/attendance/mobile-offline-claim-review.ts; the mobile command receipt). Omitted: its
 *  own transaction, as before. Both paths run the same preparation, locks and insert (requestAttendanceCorrectionTx). */
export async function requestAttendanceCorrection(ctx:SessionContext,p:AttendanceCorrectionRequestInput,existingTx?:Tx){
 const current=captureAttendanceContext(ctx),captured=structuredClone(p);normalizeAttendanceCorrectionRequest(captured);
 const run=async(tx:Tx)=>{const result=await requestAttendanceCorrectionTx(tx,current,captured);return {correctionId:result.correctionId};};
 return (existingTx?run(existingTx):withTenant(current,run)).catch(attendanceCorrectionSubmissionFailure);
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
      .limit(1).for('update');
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

/** Supporting file for the download route. RLS admits existing employment visibility or a live
 *  exact v2/v3 request assignment; the latter never grants file writes or general Personnel visibility. */
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

/** Decision/cancellation writers use subject -> correction -> workflow/payroll -> audit order. Discovering
 * the subject does not lock the request: clock-out/import can hold the subject lock while landing OT
 * on this same correction. Re-read after waiting, so status/authority checks never use the first image. */
async function lockAttendanceApplicationTx(tx: Tx, ctx: SessionContext, correctionId: string) {
  await lockAttendanceLeaveDependenciesTx(tx, ctx, []);
  const [visible] = await tx.select({ employmentId: attendanceCorrection.employmentId })
    .from(attendanceCorrection).where(eq(attendanceCorrection.id, correctionId)).limit(1);
  if (!visible) return undefined;
  await lockLeaveDependenciesTx(tx, ctx.tenantId, [visible.employmentId]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + visible.employmentId}, 0))`);
  const [locked] = await tx.select().from(attendanceCorrection)
    .where(and(eq(attendanceCorrection.id, correctionId), eq(attendanceCorrection.employmentId, visible.employmentId)))
    .limit(1).for('update');
  return locked;
}

/** NULL appliedAt predates deferred OT and cannot prove that an old approval never reached attendance.
 * Only the immutable deferred approval event, with no subsequent effect evidence, permits no-op withdrawal. */
async function provenUnlandedDeferredOtTx(tx: Tx, cor: typeof attendanceCorrection.$inferSelect) {
  if (cor.status !== 'approved' || cor.appliedAt || cor.requestedOtMinutes == null
    || cor.proposedCheckIn || cor.proposedCheckOut || cor.clockChanges) return false;
  const [approval] = await tx.select({ payload: domainEvent.payload }).from(domainEvent)
    .where(and(eq(domainEvent.tenantId, cor.tenantId), eq(domainEvent.aggregateId, cor.id),
      eq(domainEvent.eventType, 'attendance-correction.approved')))
    .orderBy(desc(domainEvent.occurredAt), desc(domainEvent.id)).limit(1);
  if ((approval?.payload as { deferred?: unknown } | undefined)?.deferred !== true) return false;
  const [effect] = await tx.select({ id: domainEvent.id }).from(domainEvent)
    .where(and(eq(domainEvent.tenantId, cor.tenantId), or(
      and(eq(domainEvent.aggregateId, cor.id), eq(domainEvent.eventType, 'attendance-correction.effect.recorded')),
      and(eq(domainEvent.eventType, 'attendance.amended'), sql`${domainEvent.payload}->>'correctionId'=${cor.id}`,
        sql`${domainEvent.payload}->>'otPlanApplied'='true'`)))).limit(1);
  return !effect;
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
export class MissingAttendanceRejectReasonError extends Error {
  constructor() { super('A rejection explanation of 1–1000 characters is required.'); }
}

export async function decideAttendanceCorrection(
  ctx: SessionContext,
  p: { correctionId: string; decision: 'approved' | 'rejected'; rejectReason?: string; remarks?: string; expectedStageIndex?: number; expectedParticipantSlot?: string; deciderEmploymentId?: string; today?: string },
  existingTx?: Tx,
) {
  p = structuredClone(p); ctx = captureAttendanceContext(ctx);
  ctx = {...ctx, roles:ctx.roles ?? (ctx.grants ?? []).map(grant=>grant.role)};
  const decide=async (tx:Tx) => {
    const original = await lockAttendanceApplicationTx(tx, ctx, p.correctionId);
    const cor=original?.adminAmendment?{...original,proposedCheckIn:original.adminAmendment.checkIn,proposedCheckOut:original.adminAmendment.checkOut}:original;
    if (!cor) throw new Error('correction request not found (or not visible)');
    if (cor.status !== 'pending') throw new Error(`correction request is already ${cor.status}`);

    await assertCanDecideAttendanceApplicationTx(tx, ctx, cor.id, cor.employmentId);
    if (!['approved', 'rejected'].includes(p.decision)) throw new Error('Invalid attendance decision');
    const rejectReason = p.decision === 'rejected' ? (p.rejectReason ?? '').trim() : null;
    if (p.decision === 'rejected' && (!rejectReason || rejectReason.length > 1000)) throw new MissingAttendanceRejectReasonError();
    if (p.remarks && p.remarks.trim().length > 1000) throw new Error('Approval remarks must be at most 1000 characters.');
    // Identity is resolved from the authenticated actor, never from a caller-supplied employment id.
    const [actualDecider] = ctx.personId ? await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, ctx.personId)).orderBy(asc(employment.id)).limit(1) : [];
    let actualDeciderEmploymentId:string|null = actualDecider?.id ?? null;
    const workflowStage = await decideAttendanceWorkflowStageTx(tx, ctx, { correctionId: cor.id, employmentId: cor.employmentId, decision: p.decision, remarks: p.decision === 'rejected' ? rejectReason ?? undefined : p.remarks, expectedStageIndex: p.expectedStageIndex, expectedParticipantSlot: p.expectedParticipantSlot });
    if (workflowStage.actualDeciderEmploymentId !== undefined) actualDeciderEmploymentId = workflowStage.actualDeciderEmploymentId;
    if (!workflowStage.final) return { status: 'pending' as const, deferred: false };


    // 1e9145d4 — true when this approval was HELD ON THE PLAN rather than written to an attendance day.
    // Surfaced in the decision event's payload and in the return value, so a caller (and an auditor) can
    // tell "approved and counted" from "approved, waiting for the day".
    let deferredApproval = false;
    let policyRawDecision = false;
    let finalizedV2 = false;
    let approvedCredit: {dayType: DayType; requestedOn: string} | null = null;

    // V2 keeps the real actor and installs only a same-transaction request/date capability.
    // Legacy delegated effects retain their existing fixed identity seam. No caller callback executes.
    let restoreEffectHint: string | undefined;
    if (workflowStage.versionedFinalEffect) {
      const [before] = await tx.execute(sql`select coalesce(current_setting('app.attendance_workflow_effect',true),'') as hint`) as unknown as { hint: string }[];
      restoreEffectHint = before.hint;
      await tx.execute(sql`SAVEPOINT attendance_workflow_v2_effect`);
    }
    let restoreIdentity: { userId: string; roles: string; grants: string } | undefined;
    let delegatedIdentity: {user_id:string;roles:string;grants:unknown} | undefined;
    if (workflowStage.delegatedFinalStageIndex != null) {
      const identities = await tx.execute(sql`select * from app.attendance_workflow_effect_identity(${cor.id}::uuid,${workflowStage.delegatedFinalStageIndex})`) as unknown as {user_id:string;roles:string;grants:unknown}[];
      delegatedIdentity = identities[0];
      if (!delegatedIdentity) throw new Error('The assigned manager no longer has a live login and attendance authority for this request. Ask an authorised HR administrator to complete this stage on their behalf.');
      const settings = await tx.execute(sql`select current_setting('app.user_id',true) as "userId",current_setting('app.roles',true) as roles,current_setting('app.grants',true) as grants`) as unknown as {userId:string;roles:string;grants:string}[];
      restoreIdentity = settings[0];
      await tx.execute(sql`SAVEPOINT attendance_workflow_effect`);
    }
    try {
      if (workflowStage.versionedFinalEffect) {
        await tx.execute(sql`select app.attendance_workflow_begin_effect(${cor.id}::uuid)`);
        const [readable] = await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, cor.employmentId)).limit(1);
        if (!readable) throw new Error('The frozen approver no longer has calculation access to this employee. Ask a scoped HR administrator to complete or reassign the pending level.');
      }
      if (delegatedIdentity) {
        await tx.execute(sql`select set_config('app.user_id',${delegatedIdentity.user_id},true),set_config('app.roles',${delegatedIdentity.roles},true),set_config('app.grants',${JSON.stringify(delegatedIdentity.grants)},true)`);
      }
      if (restoreIdentity) {
        const [operationalSubject] = await tx.select({id:employment.id}).from(employment).where(eq(employment.id,cor.employmentId)).limit(1);
        if (!operationalSubject) throw new Error('The assigned manager no longer has attendance calculation access to this employee. Ask an authorised HR administrator to complete the stage.');
      }
    if (p.decision === 'approved') {
      const sched = await scheduleFor(tx, cor.employmentId, cor.attendanceDate);
      const dayType = sched.dayType;
      const hasClockCorrection = cor.proposedCheckIn != null || cor.clockChanges != null;
      const hasOtRequest = cor.requestedOtMinutes != null;
      if(hasOtRequest&&Object.keys(sched.manualOtRows??{}).length)throw new Error('Return this day’s manual overtime rows to Auto before deciding an aggregate overtime request.');
      // 1e9145d4 — THE DEFERRED CASE, and the whole point of the item. An OT-only plan for a day that has
      // not happened yet cannot be measured against anything and must not create an attendance row (see the
      // section header above for why a placeholder row would corrupt the month summary and the payroll
      // prefill). The discriminator is the DATE, not "is there an attendance row": a past-dated OT request
      // with no attendance row keeps throwing exactly as it does today, because that is a genuine mistake
      // (overtime claimed for a day with no recorded work) and holding that line is the regression contract.
      const deferred = !hasClockCorrection && hasOtRequest && cor.attendanceDate > (p.today ?? todayInKualaLumpur());

      let unclockedSystemMinutes:number|undefined;
      let unclockedContext:AttendancePolicyExecutionContext|undefined;
      let unclockedProtectedDates:string[]|undefined;
      if(cor.originalClockSnapshot?.unclockedWork){
        if(deferred||hasClockCorrection||cor.adminAmendment||!workflowStage.versionedFinalEffect)
          throw Error('Unclocked actual work requires its submitted versioned final workflow.');
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+cor.employmentId},0))`);
        unclockedProtectedDates=attendancePolicyUnclockedWorkDates(cor.originalClockSnapshot.unclockedWork);
        for(const date of unclockedProtectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date});
        await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:cor.employmentId,date:cor.attendanceDate}]);
        const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
        const [submission]=await tx.select().from(attendancePolicyRequestContract).where(and(
          eq(attendancePolicyRequestContract.correctionId,cor.id),eq(attendancePolicyRequestContract.tenantId,ctx.tenantId))).limit(1);
        const binding=attendancePolicyTraceBinding(context);
        if(!binding||!submission?.attestedWork||!isDeepStrictEqual(submission.policyBinding,binding)
          ||!isDeepStrictEqual(submission.attestedWork.work,cor.originalClockSnapshot.unclockedWork))
          throw Error('The submitted unclocked-work policy or actual intervals changed. Withdraw and resubmit.');
        const comparison=attendancePolicyUnclockedWorkComparison(context,cor.originalClockSnapshot.unclockedWork);
        const eligible=comparison.state==='known'?attendancePolicySystemEligibleMinutes(context,comparison.work):null;
        if(eligible?.state!=='known')throw Error('The attested work cannot be positioned under the current dated Schedule Group policy.');
        if((await punchesForCorrectionTx(tx,cor.employmentId,cor.attendanceDate)).some(row=>!row.voidedAt))
          throw Error('Clock evidence was added after this unclocked-work submission. Withdraw and use the clock workflow.');
        unclockedSystemMinutes=eligible.minutes;unclockedContext=context;
      }
      let plannedProtectedDates:string[]|undefined;
      if(!deferred&&hasOtRequest&&cor.plannedStartTime!==null&&cor.plannedEndTime!==null){
        const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
        if(context.state==='policy'&&context.selected.activation.epoch>0&&context.selected.policy.overtime.enabled&&context.selected.policy.overtime.approval==='auto'
          &&context.selected.policy.overtime.autoMethod!=='actual'){
          plannedProtectedDates=await attendancePolicyPlanProtectionDatesTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate},context);
          // Complete date/source union precedes the checked configuration barrier and batches.
          for(const date of plannedProtectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date});
          await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:cor.employmentId,date:cor.attendanceDate}]);
        }
      }
      const payrollBatches = deferred ? null : await lockAttendancePayrollTx(tx, cor.employmentId, unclockedProtectedDates??plannedProtectedDates??cor.attendanceDate);
      const [lockedDay] = deferred ? [] : await tx.select({id:attendance.id}).from(attendance).where(and(eq(attendance.employmentId,cor.employmentId),eq(attendance.attendanceDate,cor.attendanceDate))).limit(1).for('update');
      // ADR-0069: resolve the APPROVED OT once, up front, so the SAME value is written to attendance.otMinutes,
      // stamped on the correction row, and (crucially) read by maybeAutoAccrueOnApprovalTx below. The auto-accrual
      // reads attendance.otMinutes AFTER we write it — so the DECISION (tested & documented in ADR-0069) is: TOIL
      // auto-accrual consumes the POLICY-ADJUSTED approved OT, never the raw engine figure. attendance.otMinutes is
      // the single source of truth for both the payroll prefill AND the TOIL day-credit math — no double-counting.
      let approvedOtMinutes: number | null = null;
      let otApprovalMethod: OtApprovalMethod | null = null;
      let systemOtForComparison: number | null = null;
      if (hasOtRequest) {
        otApprovalMethod = await otApprovalCalculationFor(tx, cor.employmentId, cor.id);
        // The system-calculated comparison figure: derive live from the punches that WILL be authoritative for the
        // day. For a clock correction that is the proposed punches; for an OT-only request it is the existing
        // approved attendance row's punches (resolved below). Computed live — never stored (ADR-0069).
        if(unclockedSystemMinutes!==undefined){
          systemOtForComparison=unclockedSystemMinutes;
        } else if (deferred) {
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
          if(existing?.checkInAt!=null){
            const raw=await attendancePolicyRawInputTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
            if(raw.state==='unavailable')throw Error('Canonical overtime comparison inputs are unavailable.');
            if(raw.state==='policy'){
              const comparison=attendancePolicySystemEligibleMinutes(raw.context,raw.work);
              if(comparison.state!=='known'&&otApprovalMethod!=='requested')
                throw Error('Captured overtime eligibility is unavailable for this decision.');
              // Requested-only approval retains an unknown comparison as unknown; it is not a
              // fabricated zero or positioned/payment authority. Other methods require the count.
              systemOtForComparison=comparison.state==='known'?comparison.minutes:null;
            }else systemOtForComparison=deriveAttendance(sched,existing.checkInAt,existing.checkOutAt,cor.attendanceDate).otMinutes;
          }else systemOtForComparison=null;
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
      const beforePunches = deferred ? [] : (await punchesForCorrectionTx(tx,cor.employmentId,cor.attendanceDate)).filter(row => !row.voidedAt).map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction}));

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
      } else if(unclockedSystemMinutes!==undefined){
        // The actual-work testimony has a separate immutable scoped final effect. Its
        // scalar decision never lands in raw Attendance or manufactures a captured trace.
        // SQL still requires the owner-issued attested effect before status can finalize.
        const [existingAnchor]=await tx.select().from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
          eq(attendance.employmentId,cor.employmentId),eq(attendance.attendanceDate,cor.attendanceDate))).limit(1);
        if(existingAnchor&&[existingAnchor.checkInAt,existingAnchor.checkOutAt,existingAnchor.workedMinutes,
          existingAnchor.otMinutes,existingAnchor.otFlatMinutes,existingAnchor.ot00Minutes,existingAnchor.ot10Minutes,
          existingAnchor.ot15Minutes,existingAnchor.ot20Minutes,existingAnchor.ot30Minutes,existingAnchor.lateMinutes,
          existingAnchor.earlyOutMinutes,existingAnchor.underMinutes,existingAnchor.lateDeductMinutes,existingAnchor.earlyOutDeductMinutes,attendancePolicyAttestedRawTrace(existingAnchor.calcTrace)].some(value=>value!==null))
          throw Error('Retain the existing Attendance evidence and correct it through its own workflow before attesting this day.');
        if(existingAnchor)await tx.update(attendance).set({attestedWorkCorrectionId:cor.id,attestedWorkContext:JSON.parse(JSON.stringify(unclockedContext)),dayType,status:'present',calcTrace:null})
          .where(eq(attendance.id,existingAnchor.id));
        else await tx.insert(attendance).values({tenantId:ctx.tenantId,employmentId:cor.employmentId,attendanceDate:cor.attendanceDate,
          attestedWorkCorrectionId:cor.id,attestedWorkContext:JSON.parse(JSON.stringify(unclockedContext)),dayType,status:'present'});
        policyRawDecision=true;
        eventPayload={correctionId:cor.id,date:cor.attendanceDate,dayType,otMinutes:null,
          attestedActualWorkDecisionOnly:true};
      } else if (cor.clockChanges) {
        const [day] = lockedDay ? [lockedDay] : await tx.insert(attendance).values({tenantId:ctx.tenantId,employmentId:cor.employmentId,attendanceDate:cor.attendanceDate,dayType,status:'present'}).returning({id:attendance.id});
        amendedId = day.id;
        await applyClockChangesTx(tx,ctx,{attendanceId:day.id,employmentId:cor.employmentId,date:cor.attendanceDate,reason:cor.reason ?? '',correctionId:cor.id,changes:cor.clockChanges});
        const d = await recomputeDayFromPunches(tx,ctx,{employmentId:cor.employmentId,attendanceId:day.id,attendanceDate:cor.attendanceDate,sched,fallbackCheckInAt:null});
        // Removing every clocking must clear the former paid figures, not retain a stale aggregate.
        if (!d.checkInAt) await tx.update(attendance).set({checkInAt:null,checkOutAt:d.checkOutAt,status:d.checkOutAt ? 'present' : 'absent',workedMinutes:null,otMinutes:null,lateMinutes:null,earlyOutMinutes:null,underMinutes:null,lateDeductMinutes:null,earlyOutDeductMinutes:null,calcTrace:null,...otSplitColumns(null)}).where(eq(attendance.id,day.id));
        await tx.update(attendance).set({dayType,remarks:'Corrected',checkInMethod:null,checkOutMethod:null,checkInLat:null,checkInLng:null,checkInClockingLocationId:null,checkInDistanceM:null,checkInGeofenceStatus:null,checkInRadiusM:null,checkOutLat:null,checkOutLng:null,checkOutClockingLocationId:null,checkOutDistanceM:null,checkOutGeofenceStatus:null,checkOutRadiusM:null}).where(eq(attendance.id,day.id));
        if (!d.policyRaw && d.checkInAt && d.checkOutAt) await applyApprovedOtPlanTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate,attendanceId:day.id,sched,systemOtMinutes:d.otMinutes});
        eventPayload = {correctionId:cor.id,date:cor.attendanceDate,dayType,clockDataChanged:true};
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
          ...otSplitColumns(otMinutes == null ? null : hasOtRequest ? splitOtMinutes(otMinutes, dayType, sched.rule) : d.otSplit),
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
        // Legacy pair corrections now reconcile the effective punches too. Original evidence is retained.
        const originals = await punchesForCorrectionTx(tx,cor.employmentId,cor.attendanceDate);
        await applyClockChangesTx(tx,ctx,{attendanceId:amended.id,employmentId:cor.employmentId,date:cor.attendanceDate,reason:cor.reason ?? 'Attendance correction',correctionId:cor.id,changes:{version:1,baseline:clockFingerprint(originals),entries:[{punchAt:cor.proposedCheckIn!,direction:'in'},...(cor.proposedCheckOut ? [{punchAt:cor.proposedCheckOut,direction:'out' as const}] : [])]}});
        // 1e9145d4 — an approved clock correction RE-DERIVES the day from the proposed punches, which would
        // quietly wipe the hours of an OT plan that had already landed on it. Re-assert them (and, if the
        // correction is what finally gives the day its punches, LAND a plan that was waiting for exactly
        // that). Skipped when this correction carries its own OT figure: the human who approved it decided
        // the day's overtime a moment ago and that decision wins.
        // Reconcile a proposed-pair correction through the same policy raw owner AFTER its
        // effective punch rows exist and BEFORE the final effect/audit snapshot is captured.
        // Manually entered labels do not acquire capture provenance merely because HR approved them.
        const raw=await attendancePolicyRawInputTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
        if(raw.state==='unavailable')throw Error('Canonical corrected Attendance inputs are unavailable.');
        const policyDerived=raw.state==='policy'?await recomputeDayFromPunches(tx,ctx,{employmentId:cor.employmentId,
          attendanceId:amended.id,attendanceDate:cor.attendanceDate,sched,fallbackCheckInAt:cor.proposedCheckIn}):null;
        if(policyDerived)otMinutes=policyDerived.otMinutes;
        if (!hasOtRequest&&!policyDerived) {
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
          status: policyDerived?.status??d.status,
          dayType,
          workedMinutes: policyDerived?policyDerived.workedMinutes:d.workedMinutes,
          otMinutes,
        };
      } else {
        // OT-only request: there MUST already be an attendance row (you cannot bank OT against a day with no
        // recorded work). Frozen legacy days retain scalar landing. A bound policy day replays
        // captured raw inputs and retains the approved scalar only on its decision, not on raw work.
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
        const raw=await attendancePolicyRawInputTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
        if(raw.state==='unavailable')throw Error('Canonical overtime decision inputs are unavailable.');
        if(raw.state==='policy'){
          if(!workflowStage.versionedFinalEffect)throw Error('A dated policy overtime decision requires its frozen versioned workflow.');
          const [submission]=await tx.select().from(attendancePolicyRequestContract)
            .where(and(eq(attendancePolicyRequestContract.correctionId,cor.id),eq(attendancePolicyRequestContract.tenantId,ctx.tenantId))).limit(1);
          const binding=attendancePolicyTraceBinding(raw.context);
          if(!binding||!submission?.policyBinding||!isDeepStrictEqual(submission.policyBinding,binding))
            throw Error('The submitted Attendance policy changed. Withdraw and resubmit the request.');
          const derived=await recomputeDayFromPunches(tx,ctx,{employmentId:cor.employmentId,attendanceId:existing.id,
            attendanceDate:cor.attendanceDate,sched,fallbackCheckInAt:null});
          if(!derived.policyRaw||derived.workedMinutes===null||derived.checkOutAt===null)
            throw Error('A captured complete Attendance day is required for this policy decision.');
          policyRawDecision=true;
        }else{
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
        }
        amendedId = existing.id;
        eventPayload = {
          correctionId: cor.id,
          date: cor.attendanceDate,
          dayType,
          otMinutes: policyRawDecision?null:approvedOtMinutes,
          ...(policyRawDecision?{policyRawOnly:true}:{}),
        };
      }

      if (amendedId && payrollBatches) await markAttendancePayrollTx(tx,ctx,payrollBatches,cor.employmentId);
      if(policyRawDecision&&hasOtRequest&&cor.plannedStartTime!==null&&cor.plannedEndTime!==null){
        const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
        if(context.state!=='policy')throw Error('The current policy plan context is unavailable.');
        const overtime=context.selected.policy.overtime;
        if(overtime.approval==='auto'&&overtime.autoMethod!=='actual'){
          const [submission]=await tx.select().from(attendancePolicyRequestContract).where(and(
            eq(attendancePolicyRequestContract.tenantId,ctx.tenantId),eq(attendancePolicyRequestContract.correctionId,cor.id))).limit(1);
          const minutes=plannedOvertimeMinutes(cor.plannedStartTime.slice(0,5),cor.plannedEndTime.slice(0,5));
          const from=Number(cor.plannedStartTime.slice(0,2))*60+Number(cor.plannedStartTime.slice(3,5));
          const plan=minutes===null?null:{version:1,basis:'startDateEarlierEndNextDay',sourceDate:cor.attendanceDate,
            startLabel:cor.plannedStartTime,endLabel:cor.plannedEndTime,from,to:from+minutes,requestedMinutes:minutes};
          if(!plan||minutes!==cor.requestedOtMinutes||!submission?.plannedWindow
            ||!isDeepStrictEqual(submission.plannedWindow,plan)
            ||!isDeepStrictEqual(submission.policyBinding,attendancePolicyTraceBinding(context)))
            throw Error('The complete submitted policy plan changed. Withdraw and resubmit.');
          // Auto planned methods approve the exact submitted positions. The legacy company
          // scalar comparison cannot replace a 90-minute plan with 120 actual minutes.
          // Final duration still applies the same plan/intersection, limits and rounding owners.
          approvedOtMinutes=minutes;
          eventPayload={...eventPayload,policyPlanDecisionOnly:true};
        }
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
            // A raw policy decision has not placed approved hours on this scalar day.
            // Retain its decision/receipt, but leave legacy landing and credit stamps unset.
            ...(deferred||policyRawDecision ? {} : { appliedAt: sql`now()` }),
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
        const afterPunchFingerprint = clockFingerprint(await punchesForCorrectionTx(tx,cor.employmentId,cor.attendanceDate));
        await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-correction',aggregateId:cor.id,eventType:'attendance-correction.effect.recorded',actor:actorOf(ctx),subjectEmploymentId:cor.employmentId,payload:{attendanceId:amendedId,date:cor.attendanceDate,before:beforeFigures,after:afterFigures,beforePunches,afterPunchFingerprint,clockChanged:hasClockCorrection}});
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

      // Deferred plans bank only when actual work lands. Immediate decisions bank after their
      // approved status is written, so the canonical formula reader sees this exact approval.
      if (!deferred) approvedCredit = {dayType, requestedOn: todayInKualaLumpur(cor.createdAt)};
      // Policy raw columns stay unknown. Auto-accrual below reads the newly finalized
      // independent duration and existing TOIL policy, after the canonical refresh.
      deferredApproval = deferred;
    }
    // Keep v2's writing savepoint active until SQL verifies the actual target-day result.
    // Event markers are audit data and supply no authority to finalize an application.
    if (workflowStage.versionedFinalEffect || approvedCredit) {
      if (workflowStage.finalApprovalEvent) await appendEvent(tx, workflowStage.finalApprovalEvent);
      await tx.update(attendanceCorrection).set({ status: p.decision, rejectReason, decidedByEmploymentId: actualDeciderEmploymentId, decidedAt: sql`now()` }).where(eq(attendanceCorrection.id, cor.id));
      finalizedV2 = true;
    }
    if (approvedCredit||policyRawDecision) {
      await refreshOvertimePatternDayTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate,reason:'Approved attendance decision'});
      if(approvedCredit)await maybeAutoAccrueOnApprovalTx(tx,ctx,{employmentId:cor.employmentId,workedDate:cor.attendanceDate,...approvedCredit});
    }

    } catch (effectError) {
      // A SQL error aborts the subtransaction. Restore its savepoint before resetting identity.
      if (restoreIdentity) await tx.execute(sql`ROLLBACK TO SAVEPOINT attendance_workflow_effect`);
      if (restoreEffectHint != null) await tx.execute(sql`ROLLBACK TO SAVEPOINT attendance_workflow_v2_effect`);
      throw effectError;
    } finally {
      if (restoreIdentity) await tx.execute(sql`select set_config('app.user_id',${restoreIdentity.userId},true),set_config('app.roles',${restoreIdentity.roles},true),set_config('app.grants',${restoreIdentity.grants},true)`);
      if (restoreIdentity) await tx.execute(sql`RELEASE SAVEPOINT attendance_workflow_effect`);
      if (restoreEffectHint != null) {
        await tx.execute(sql`select set_config('app.attendance_workflow_effect',${restoreEffectHint},true)`);
        await tx.execute(sql`RELEASE SAVEPOINT attendance_workflow_v2_effect`);
      }
    }

    if (restoreIdentity) {
      const [restored] = await tx.execute(sql`select current_setting('app.user_id',true) as "userId",current_setting('app.roles',true) as roles,current_setting('app.grants',true) as grants`) as unknown as {userId:string;roles:string;grants:string}[];
      if (!isDeepStrictEqual(restored,restoreIdentity)) throw new Error('Delegated attendance authority was not restored. The decision was rolled back.');
    }

    if (restoreEffectHint != null) {
      const [restored] = await tx.execute(sql`select coalesce(current_setting('app.attendance_workflow_effect',true),'') as hint`) as unknown as { hint: string }[];
      if (restored.hint !== restoreEffectHint) throw new Error('Attendance request authority was not restored. The decision was rolled back.');
    }

    // Final approval emits its stage audit only after the effect, payroll/recalc work and delegated
    // identity restoration. The original actor and database decidedAt were frozen with the decision.
    if (workflowStage.finalApprovalEvent && !finalizedV2) await appendEvent(tx, workflowStage.finalApprovalEvent);

    if (!finalizedV2) await tx
      .update(attendanceCorrection)
      .set({
        status: p.decision,
        rejectReason,
        decidedByEmploymentId: actualDeciderEmploymentId,
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
        rejectReason,
        deciderEmploymentId: actualDeciderEmploymentId,
        actualUserId: actorOf(ctx).id,
        actualPersonId: ctx.personId ?? null,
        ...(restoreIdentity ? { effectAuthorityRestored: true } : {}),
        remarks: p.remarks?.trim() || null,
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
  };
  return existingTx?decide(existingTx):withTenant(ctx,decide);
}

/** Correction inbox — RLS trims to what the viewer may see (admin all in scope, manager
 *  their reports, employee their own). Recent first. */
export function listAttendanceCorrections(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected';requestId?:string } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceCorrection.id,
        requestKind: attendanceCorrection.requestKind,
        employmentId: attendanceCorrection.employmentId,
        personId: sql<string>`subject.person_id`,
        employee: sql<string>`subject.employee`,
        employeeCode: sql<string | null>`subject.employee_code`,
        attendanceDate: attendanceCorrection.attendanceDate,
        adminAmendment: attendanceCorrection.adminAmendment,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        plannedStartTime: attendanceCorrection.plannedStartTime,
        plannedEndTime: attendanceCorrection.plannedEndTime,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        approvedOtMinutes: attendanceCorrection.approvedOtMinutes,
        otApprovalMethod: attendanceCorrection.otApprovalMethod,
        // The file stays behind the same RLS boundary; this list reads presence, never bytes.
        hasAttachment: sql<boolean>`exists (select 1 from ${attendanceCorrectionAttachment} where ${attendanceCorrectionAttachment.attendanceCorrectionId} = ${attendanceCorrection.id})`,
        reason: attendanceCorrection.reason,
        rejectReason: attendanceCorrection.rejectReason,
        originalClockSnapshot: attendanceCorrection.originalClockSnapshot,
        clockChanges: attendanceCorrection.clockChanges,
        status: attendanceCorrection.status,
        createdAt: attendanceCorrection.createdAt,
        // A request's frozen method is independent of today's company configuration.
        // Request visibility alone never grants the raw subject/day comparison.
        systemOtMinutes: attendance.otMinutes,
        otApprovalCalculation: sql<OtApprovalMethod | null>`case when ${attendancePolicyRequestContract.kind}='epoch'
          then ${attendancePolicyRequestContract.manualApprovalMethod} else ${attendancePolicy.otApprovalCalculation}::text end`,
        submittedPolicyBound: sql<boolean>`${attendancePolicyRequestContract.policyBinding} is not null`,
        canReadRawComparison: sql<boolean>`${attendance.id} is not null and app.can_see_employment(${attendanceCorrection.employmentId})`,
      })
      .from(attendanceCorrection)
      .innerJoin(sql`LATERAL app.attendance_application_subject(${attendanceCorrection.id}) AS subject`, sql`true`)
      .leftJoin(
        attendance,
        and(
          eq(attendance.employmentId, attendanceCorrection.employmentId),
          eq(attendance.attendanceDate, attendanceCorrection.attendanceDate),
        ),
      )
      .leftJoin(attendancePolicyRequestContract, and(
        eq(attendancePolicyRequestContract.correctionId, attendanceCorrection.id),
        eq(attendancePolicyRequestContract.tenantId, attendanceCorrection.tenantId)))
      .leftJoin(attendancePolicy, sql`${attendancePolicy.companyId}=subject.company_id`)
      .where(
        and(
          opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
          opts.requestId?eq(attendanceCorrection.id,opts.requestId):undefined,
          opts.companyIds && opts.companyIds.length
            ? sql`(subject.company_id IN (${sql.join(opts.companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) OR app.attendance_workflow_v3_decision_slot(${attendanceCorrection.id}) IS NOT NULL)`
            : undefined,
        ),
      )
      .orderBy(desc(attendanceCorrection.createdAt),desc(attendanceCorrection.id))
      .limit(100);
    // R51 (baf56348): trim delegation-routed rows whose subject is outside the delegation's org coverage
    // from the approver-facing list (a no-op for rows the caller sees in their own right).
    const genericVisible = await filterDelegationOrgScopeTx(tx, ctx, rows, (r) => r.employmentId);
    // Frozen v2 routing grants request visibility only; it does not add Personnel scope.
    const v2Visible = rows.length ? await tx.execute(sql`select c.id,app.attendance_workflow_v2_decide(c.id) as "canDecide" from public.attendance_correction c where c.id in (${sql.join(rows.map(r => sql`${r.id}::uuid`), sql`,`)}) and app.attendance_workflow_v2_read(c.id)`) as unknown as { id: string; canDecide: boolean }[] : [];
    const v3Visible = rows.length ? await tx.execute(sql`select c.id,(app.attendance_workflow_v3_decision_slot(c.id) is not null) as "canDecide" from public.attendance_correction c where c.id in (${sql.join(rows.map(r => sql`${r.id}::uuid`), sql`,`)}) and app.attendance_workflow_v3_read(c.id)`) as unknown as { id: string; canDecide: boolean }[] : [];
    const visibleIds = new Set([...genericVisible, ...v2Visible, ...v3Visible].map(r => r.id));
    const visible = rows.filter(r => visibleIds.has(r.id));
    const workflows = await attendanceWorkflowsForTx(tx, visible.map(r => r.id));
    const comparisons = new Map<string, Promise<number | null>>();
    const comparisonFor = (r: typeof visible[number]) => {
      const hasProposedClocks = r.proposedCheckIn != null || r.proposedCheckOut != null;
      const key = `${r.employmentId}:${r.attendanceDate}:${hasProposedClocks}`;
      let pending = comparisons.get(key);
      if (!pending) {
        pending = (async () => {
          const raw = await attendancePolicyRawInputTx(tx, ctx, { employmentId: r.employmentId, date: r.attendanceDate });
          if (raw.state === 'unavailable') return null;
          if (raw.state !== 'policy') return r.systemOtMinutes;
          if (hasProposedClocks) return null;
          const comparison = attendancePolicySystemEligibleMinutes(raw.context, raw.work);
          return comparison.state === 'known' ? comparison.minutes : null;
        })();
        comparisons.set(key, pending);
      }
      return pending;
    };
    for (const row of visible) {
      if (row.requestedOtMinutes == null || row.status !== 'pending') continue;
      if (!row.canReadRawComparison) { row.systemOtMinutes = null; continue; }
      // Proposed labels are not captured instants. A policy correction preview cannot
      // claim the current captured day's count as the result of those proposed changes.
      if (row.submittedPolicyBound && (row.proposedCheckIn != null || row.proposedCheckOut != null)) {
        row.systemOtMinutes = null; continue;
      }
      row.systemOtMinutes = await comparisonFor(row);
    }
    return visible.map(r => ({ ...r, workflow: workflows.get(r.id) ?? null, canDecide: (workflows.get(r.id)?.routingVersion === 3 || workflows.get(r.id)?.routingVersion === 4) ? v3Visible.find(a => a.id === r.id)?.canDecide === true : workflows.get(r.id)?.routingVersion === 2 ? v2Visible.find(a => a.id === r.id)?.canDecide === true : true }));
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
  /** Saved current-level names; null/absent identifies a legacy reporting-line request. */
  assignedApproverNames?: string[] | null;
  attendanceDate: string;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  requestedOtMinutes: number | null;
  approvedOtMinutes: number | null;
  otReasonCategory: OtReasonCategory | null;
  rejectReason?: string | null;
  originalClockSnapshot?: typeof attendanceCorrection.$inferSelect.originalClockSnapshot;
  clockChanges?: ClockChanges | null;
  reason: string | null;
  /** Employee's optional note, separate from the approver's stored rejectReason. */
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
function workedDayKindForSchedule(s:ResolvedSchedule):WorkedDayKind {
  if (s.dayType === 'holiday') return 'holiday';
  if (s.dayType === 'rest_day') return 'rest_day';
  if (s.source === 'default-shift-rest') return 'off_day';
  return 'workday';
}
export async function workedDayKindForTx(tx: Tx, employmentId: string, date: string): Promise<WorkedDayKind> {
  return workedDayKindForSchedule(await scheduleFor(tx, employmentId, date));
}

/** Bounded calendar evidence for one policy timeline. Uses the final Schedule owner, including day
 * adjustments and the effective holiday overlay. The replacement allocator's raw schedule seam
 * intentionally suppresses holidays and must never answer this question. No work is approved here. */
export async function attendancePolicyCalendarTx(tx:Tx,p:{employmentId:string;dates:readonly string[]}):Promise<PolicyCalendarProof[]> {
  overtimeUuid(p.employmentId,'employmentId');
  if(p.dates.length>3||new Set(p.dates).size!==p.dates.length)throw Error('Choose at most three distinct policy calendar dates.');
  for(const date of p.dates)overtimeDate(date,'calendar.date');
  const dates=[...p.dates].sort();if(!dates.length)return [];
  const from=dates[0],to=dates[dates.length-1];
  if(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>2*86400000)throw Error('Policy calendar dates must belong to one three-day timeline.');
  const [employee]=await tx.select({companyId:employment.companyId}).from(employment).where(eq(employment.id,p.employmentId)).limit(1);
  const companies=await provenCompanyDatesTx(tx,dates.map(date=>({employmentId:p.employmentId,date})));
  if(!employee)return dates.map(date=>({date,state:'unknown',reason:'calendarUnavailable'}));
  const memo=await newScheduleMemo(tx,{employmentIds:[p.employmentId],from,to});
  const provenance=await holidayCalendarProvenanceFor(tx,{employmentId:p.employmentId,startDate:from,endDate:to});
  const out:PolicyCalendarProof[]=[];
  for(const date of dates){
    const company=companies.get(`${p.employmentId}|${date}`);
    if(!company?.companyId||company.reason){out.push({date,state:'unknown',reason:'calendarUnavailable'});continue;}
    const schedule=await scheduleFor(tx,p.employmentId,date,memo);
    // Today's company policy cannot prove the outgoing employer's historical weekdays.
    if(schedule.source==='policy'&&company.companyId!==employee.companyId){out.push({date,state:'unknown',reason:'calendarUnavailable'});continue;}
    const adjustment=memo.adjustments?.get(`${p.employmentId}|${date}`);
    const references=[`employment:${p.employmentId}`,`company:${company.companyId}`,`schedule:${date}:${schedule.source}`,
      ...(schedule.displayShiftId?[`shift:${schedule.displayShiftId}`]:[]),...(schedule.rule?[`attendance-rule:${schedule.rule.id}`]:[]),
      ...(adjustment?[`attendance-day-adjustment:${adjustment.id}:${adjustment.version}`]:[])];
    const kind=workedDayKindForSchedule(schedule);
    if(kind!=='holiday'){
      // Reuse this same memoized dated schedule. Retain ordinary-day qualification
      // separately from calendar class and payable quantity, without another schedule query.
      const boundary=kind==='workday'?attendancePolicyClockPlacement({start:schedule.scheduledStart,end:schedule.scheduledEnd,
       crossesMidnight:schedule.crossesMidnight,durationOnly:schedule.durationOnly===true,flexiDuration:schedule.flexiDuration,
       dayType:schedule.dayType,includeGraceInLateness:false,includeGraceInEarlyOut:false}):undefined;
      const toilQualification:Extract<PolicyCalendarProof,{state:'known'}>['toilQualification']=kind!=='workday'?undefined
       :boundary?.state==='known'&&schedule.rule?{state:'known',basis:'datedScheduleOnly',shiftId:schedule.displayShiftId??null,
        ruleId:schedule.rule.id,scheduled:{...boundary.scheduled}}:{state:'unavailable',basis:'datedScheduleOnly',reason:'noFixedShift'};
      out.push({date,state:'known',companyId:company.companyId,dayClass:kind==='rest_day'?'rest':kind==='off_day'?'off':'normal',moneyDay:kind==='rest_day'?'rest_day':'workday',references,
       ...(toilQualification?{toilQualification}:{})});continue;
    }
    const originals=provenance.originals.filter(row=>row.date===date&&row.companyId===company.companyId);
    const replacements=provenance.replacements.filter(row=>row.replacementDate===date&&row.companyId===company.companyId);
    // Generic manual holiday labels and collisions cannot invent which differentiated formula owns it.
    if((originals.length===0)===(replacements.length===0)){
      out.push({date,state:'unknown',reason:'holidayDesignationUnavailable'});continue;
    }
    out.push({date,state:'known',companyId:company.companyId,dayClass:originals.length?'publicHoliday':'replacementHoliday',moneyDay:'holiday',
      references:[...references,...originals.map(row=>`holiday:${row.id}`),...replacements.map(row=>`replacement-holiday:${row.id}`)]});
  }
  return out;
}

export type AttendancePolicyExecutionContext=
  |{state:'legacy';reason:'noDatedPolicy'}
  |{state:'unavailable';reason:'subjectUnavailable'|'companyUnavailable'|'principalUnavailable'|'scheduleUnavailable'}
  |{state:'policy';employmentId:string;date:string;companyId:string;timeZone:typeof HR_LOCAL_TZ;
    selected:ResolvedAttendanceGroupPolicy;
    resolvedClock:ResolvedAttendanceGroupPolicy['policy']['clock'];
    schedule:{source:ResolvedSchedule['source'];shiftId:string|null;ruleId:string;start:string|null;end:string|null;
      crossesMidnight:boolean;dailyCutoffMinutes:number|null;durationOnly:boolean;flexiDuration:boolean;
      normalMinutes:number;breakMinutes:number;breakPeriods:BreakPeriod[]|null;flexibleBreakMinutes:number|null};
    calendar:PolicyCalendarProof[];clockPlacement?:PolicyClockPlacement;workPlacement?:PolicyWorkPlacement;placement:PolicySchedulePlacement};

/** Selection seam for the canonical calculation writer. No form-supplied company/group/policy ID.
 * This is live input, not final-effect authority or an immutable receipt: the writer must freeze its
 * selected revision and complete facts before financial consumers can use the resulting calculation. */
export async function attendancePolicyExecutionContextTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;classification?:'stored'|'currentSchedule'}):Promise<AttendancePolicyExecutionContext>{
  overtimeUuid(p.employmentId,'employmentId');overtimeDate(p.date,'attendanceDate');
  const [principal]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
  if(!principal?.allowed)return {state:'unavailable',reason:'principalUnavailable'};
  const [subject]=await tx.select({id:employment.id,companyId:employment.companyId}).from(employment)
    .where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1);
  if(!subject)return {state:'unavailable',reason:'subjectUnavailable'};
  const company=(await provenCompanyDatesTx(tx,[p])).get(`${p.employmentId}|${p.date}`);
  if(!company?.companyId||company.reason)return {state:'unavailable',reason:'companyUnavailable'};
  const liveSchedule=await scheduleFor(tx,p.employmentId,p.date);
  const [rawDay]=await tx.select({dayType:attendance.dayType,trace:attendance.calcTrace}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),
    eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  const schedule=p.classification!=='currentSchedule'&&rawDay?.dayType?{...liveSchedule,dayType:rawDay.dayType}:liveSchedule;
  if(schedule.source==='policy'&&company.companyId!==subject.companyId){
    // A destination employer's schedule cannot resolve the old employer's policy.
    // Only a recorded, valid original schedule can establish legacy absence here;
    // missing history or an applicable original policy keeps the explicit refusal.
    const recorded=isAttendanceTrace(rawDay?.trace)?rawDay.trace:null;
    if(recorded){
      const originalRule=recorded.schedule.ruleId;
      if(originalRule===null){
        const [current]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
        return current?.allowed?{state:'legacy',reason:'noDatedPolicy'}:{state:'unavailable',reason:'principalUnavailable'};
      }
      if(typeof originalRule==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(originalRule)){
        const original=await attendanceGroupPolicyOnTx(tx,ctx,{companyId:company.companyId,ruleId:originalRule,date:p.date});
        const [current]=await tx.execute(sql`select app.attendance_policy_principal_current() as allowed`) as unknown as {allowed:boolean}[];
        if(!current?.allowed)return {state:'unavailable',reason:'principalUnavailable'};
        if(!original)return {state:'legacy',reason:'noDatedPolicy'};
      }
    }
    return {state:'unavailable',reason:'scheduleUnavailable'};
  }
  if(!schedule.rule)return {state:'legacy',reason:'noDatedPolicy'};
  const selected=await attendanceGroupPolicyOnTx(tx,ctx,{companyId:company.companyId,ruleId:schedule.rule.id,date:p.date});
  if(!selected)return {state:'legacy',reason:'noDatedPolicy'};
  // An explicit shift grace remains authoritative. An absent override takes the new group value;
  // fixed-clock penalties still do not apply to duration/flexi schedules under their existing owner.
  const [overrides]=schedule.displayShiftId?await tx.select({late:shift.lateGraceMinutes,early:shift.earlyLeaveGraceMinutes})
    .from(shift).where(eq(shift.id,schedule.displayShiftId)).limit(1):[];
  const fixed=schedule.dayType==='workday'&&!schedule.flexiDuration&&!schedule.durationOnly;
  const resolvedClock={...selected.policy.clock,
    lateGraceMinutes:fixed?overrides?.late??selected.policy.clock.lateGraceMinutes:0,
    earlyGraceMinutes:fixed?overrides?.early??selected.policy.clock.earlyGraceMinutes:0};
  const dates=selected.policy.overtime.splitAtMidnight?[p.date,addDays(p.date,1),addDays(p.date,2)]:[p.date];
  const calendar=await attendancePolicyCalendarTx(tx,{employmentId:p.employmentId,dates});
  return {state:'policy',employmentId:p.employmentId,date:p.date,companyId:company.companyId,timeZone:HR_LOCAL_TZ,selected,resolvedClock,
    schedule:{source:schedule.source,shiftId:schedule.displayShiftId??null,ruleId:schedule.rule.id,start:schedule.scheduledStart,end:schedule.scheduledEnd,
      crossesMidnight:schedule.crossesMidnight,dailyCutoffMinutes:schedule.dailyCutoffMinutes,durationOnly:schedule.durationOnly===true,flexiDuration:schedule.flexiDuration,
      normalMinutes:schedule.normalMinutesOverride??schedule.scheduledMinutes,breakMinutes:schedule.breakMinutes,
      breakPeriods:schedule.breakPeriods?.map(row=>({...row}))??null,flexibleBreakMinutes:schedule.flexibleBreakMinutes},calendar,
    clockPlacement:attendancePolicyClockPlacement({start:schedule.scheduledStart,end:schedule.scheduledEnd,crossesMidnight:schedule.crossesMidnight,
      durationOnly:schedule.durationOnly===true,flexiDuration:schedule.flexiDuration,dayType:schedule.dayType,
      includeGraceInLateness:schedule.rule?.includeGraceInLateness??false,includeGraceInEarlyOut:schedule.rule?.includeGraceInEarlyOut??false}),
    workPlacement:attendancePolicyWorkPlacement({start:schedule.scheduledStart,end:schedule.scheduledEnd,crossesMidnight:schedule.crossesMidnight,
      dailyCutoffMinutes:schedule.dailyCutoffMinutes,durationOnly:schedule.durationOnly===true,flexiDuration:schedule.flexiDuration,dayType:schedule.dayType,
      breakMinutes:schedule.breakMinutes,breakPeriods:schedule.breakPeriods,flexibleBreakMinutes:schedule.flexibleBreakMinutes,otWindows:schedule.otWindows,
      includeGraceInLateness:schedule.rule?.includeGraceInLateness??false,includeGraceInEarlyOut:schedule.rule?.includeGraceInEarlyOut??false}),
    placement:attendancePolicySchedulePlacement({start:schedule.scheduledStart,end:schedule.scheduledEnd,crossesMidnight:schedule.crossesMidnight,
      dailyCutoffMinutes:schedule.dailyCutoffMinutes,durationOnly:schedule.durationOnly===true,flexiDuration:schedule.flexiDuration,dayType:schedule.dayType,
      breakMinutes:schedule.breakMinutes,breakPeriods:schedule.breakPeriods,flexibleBreakMinutes:schedule.flexibleBreakMinutes,otWindows:schedule.otWindows,
      includeGraceInLateness:schedule.rule?.includeGraceInLateness??false,includeGraceInEarlyOut:schedule.rule?.includeGraceInEarlyOut??false},selected.policy)};
}

/** Canonical date facts for attendance allowance previews. No measurement is recomputed here.
 * Company-policy halfWorkingDays classify as half, while the policy branch retains
 * its existing full scheduled-minute threshold. This seam never invents a duration. */
export async function allowanceScheduleFactsTx(tx: Tx, employmentId: string, date: string, memo?: ScheduleMemo,options?:{includeApplicability:boolean}): Promise<{
  fixedClockApplicable?:boolean;shiftId: string | null; kind: 'full' | 'half' | 'off' | 'rest' | 'holiday'; scheduledMinutes: number;
}> {
  const resolved = await scheduleFor(tx, employmentId, date, memo);
  const kind = resolved.dayType === 'holiday' ? 'holiday'
    : resolved.dayType === 'rest_day' ? 'rest'
    : resolved.scheduleDayKind ?? (resolved.source === 'default-shift-rest' ? 'off' : 'full');
  return { shiftId: resolved.displayShiftId ?? null, kind,...(options?.includeApplicability?{fixedClockApplicable:!resolved.flexiDuration&&resolved.dayType==='workday'}:{}),
    scheduledMinutes: kind === 'off' || kind === 'rest' ? 0 : resolved.normalMinutesOverride ?? resolved.scheduledMinutes };
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
          shiftType:shift.type,override:shift.normalMinutesOverride,start: shift.startTime,
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
      shiftType:shift.type,override:shift.normalMinutesOverride,start: shift.startTime,
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
    const monthRotations = await rotationLookupTx(tx);
    const defaultOn = (d: string): MonthShift | undefined => {
      const p = pickArrangementOn(periods, d);
      const raw = p ? periodShifts.find(s => s.id === p.shiftId) : cachedRow;
      const rotation = monthRotations(empRow[0].ruleId ?? raw?.ruleId,d);
      return rotation ? rotationScheduleRow(rotation,d) : p ? shiftById.get(p.shiftId) : cachedDefault;
    };

    const hhmm = (t: string | null | undefined): string | null => (t == null ? null : t.slice(0, 5));
    /** The FIRST break window of a shift, which is what the day card shows. A shift may declare several;
     *  naming one and calling it "your break" would be false, so more than one falls back to the scalar. */
    const firstBreak = (ps: BreakPeriod[] | null | undefined): { start: string | null; end: string | null } =>
      ps && ps.length === 1 && ps[0]?.start && ps[0]?.end ? { start: hhmm(ps[0].start), end: hhmm(ps[0].end) } : { start: null, end: null };

    const datedOverrides=await attendanceDateOverridesTx(tx,[employmentId],from,to);
    const out: OtPlanCalendarDay[] = [];
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const dated=datedOverrides.get(`${employmentId}|${d}`);
      if(dated){out.push({date:d,kind:dated.dayKind,...dated.calendar});continue;}
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
        const end=workingShiftSchedule({start:def!.start,end:def!.end,crosses:def!.crosses,
          breakMinutes:def!.brk??0,roundingMinutes:def!.rounding},kindOfDay==='half'?'half':'full').shiftEnd;
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

/** Selected stored duration plus each approved/unlanded plan once. Old numeric API remains raw compatibility. */
export function otMonthToDateDuration(ctx:SessionContext,employmentId:string,date:string):Promise<{recorded:OvertimeRecordSummary;plannedMinutes:number;total:OvertimeRecordSummary;capMinutes:number}>{
 if(!isCalendarDate(date))throw new Error('Invalid attendance date');
 const monthStart=date.slice(0,7)+'-01',end=new Date(date+'T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1,0);const monthEnd=end.toISOString().slice(0,10);
 return withTenant(ctx,async tx=>{const rows=await tx.select({employmentId:attendance.employmentId,date:attendance.attendanceDate,otMinutes:attendance.otMinutes,calcTrace:attendance.calcTrace}).from(attendance).where(and(eq(attendance.employmentId,employmentId),gte(attendance.attendanceDate,monthStart),lte(attendance.attendanceDate,monthEnd)));const formulas=await formulaOvertimeForRowsTx(tx,ctx,rows),selected=rows.map(row=>({...row,formulaOvertime:formulas.get(row.employmentId+'|'+row.date)??null}));
  const plans=await tx.select({id:attendanceCorrection.id,minutes:attendanceCorrection.requestedOtMinutes}).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId,employmentId),gte(attendanceCorrection.attendanceDate,monthStart),lte(attendanceCorrection.attendanceDate,monthEnd),eq(attendanceCorrection.status,'approved'),isNull(attendanceCorrection.appliedAt),isNull(attendanceCorrection.proposedCheckIn),sql`${attendanceCorrection.requestedOtMinutes} is not null`));
  const planRows=[...new Map(plans.map(plan=>[plan.id,plan])).values()].map(plan=>({otMinutes:plan.minutes,formulaOvertime:null}));return {recorded:summarizeOvertimeRecords(selected),plannedMinutes:planRows.reduce((sum,row)=>sum+(row.otMinutes??0),0),total:summarizeOvertimeRecords([...selected,...planRows]),capMinutes:OT_CAP_MINUTES};
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
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        plannedStartTime: attendanceCorrection.plannedStartTime,
        plannedEndTime: attendanceCorrection.plannedEndTime,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        approvedOtMinutes: attendanceCorrection.approvedOtMinutes,
        otReasonCategory: attendanceCorrection.otReasonCategory,
        reason: attendanceCorrection.reason,
        rejectReason: attendanceCorrection.rejectReason,
        originalClockSnapshot: attendanceCorrection.originalClockSnapshot,
        clockChanges: attendanceCorrection.clockChanges,
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
      .offset(offset);
    const workflows = await attendanceWorkflowsForTx(tx, rows.map(row => row.id));
    return rows.map(row => {
      const workflow = workflows.get(row.id);
      return {...row, assignedApproverNames: workflow
        ? (workflow.effectiveStages[workflow.currentStage]?.approvers.map(actor => actor.name) ?? [])
        : null};
    });
  });
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
    const effective=effectiveOvertimeRows(otMinutes,p.sched.dayType,p.sched.rule,p.sched.manualOtRows);
    const [stored]=await tx.select({trace:attendance.calcTrace,worked:attendance.workedMinutes}).from(attendance).where(eq(attendance.id,p.attendanceId)).limit(1);
    if(Object.keys(p.sched.manualOtRows??{}).length&&effective.total>(stored?.worked??0))throw new Error('Manual overtime exceeds the recorded working minutes. Review the manual rows before recalculating.');
    const trace=stored?.trace;
    if(trace?.overtime){
      const calculated=trace.overtime.rows??overtimeCalculationRows(trace.overtime.calculatedMinutes??trace.overtime.minutes,p.sched.dayType,p.sched.rule);
      trace.overtime={...trace.overtime,approvedMinutes:otMinutes,minutes:effective.total,split:effective.split,
        rows:effective.rows.map(row=>({...row,calculatedMinutes:calculated.find(r=>r.key===row.key)?.calculatedMinutes??0}))};
    }
    await tx.update(attendance).set({otMinutes:effective.total,...otSplitColumns(effective.split),...(trace?{calcTrace:trace}:{})}).where(eq(attendance.id,p.attendanceId));
    return effective.total;
  };

  // ── 2 · RE-ASSERTION ────────────────────────────────────────────────────────────────────────────────
  if (plan.appliedAt != null) {
    if (plan.approvedOtMinutes == null) return null;
    const minutes=await writeOt(plan.approvedOtMinutes);
    // Reasserting a scalar legacy approval is not positional policy approval. This branch otherwise
    // skips the normal refresh in both clock-out and import; retain raw clocks but fence final effects.
    if(await hasRecordedAttendanceGroupPolicyTx(tx,ctx,{employmentId:p.employmentId,date:p.date}))
      await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:p.date,reason:'Reasserted overtime plan under dated policy'});
    return minutes;
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
    .where(and(eq(attendanceCorrection.id, plan.id), eq(attendanceCorrection.status, 'approved'), isNull(attendanceCorrection.appliedAt)))
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
  const effectiveOtMinutes=await writeOt(otMinutes);
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
  await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:p.date,reason:'Approved overtime plan landed'});
  await maybeAutoAccrueOnApprovalTx(tx, ctx, {
    employmentId: p.employmentId,
    workedDate: p.date,
    dayType: p.sched.dayType,
    // The same UTC-from-an-instant defect as the correction path above, and fixed with it: a plan filed
    // before 08:00 MYT stamped its credit's Request Date a day early.
    requestedOn: todayInKualaLumpur(plan.createdAt),
  });

  return effectiveOtMinutes;
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
  p = structuredClone(p); ctx = captureAttendanceContext(ctx);
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const plan = await lockAttendanceApplicationTx(tx, ctx, p.correctionId);
    if (!plan) throw new OvertimePlanWithdrawNotAllowedError('overtime plan not found (or not visible)');
    if (plan.clockChanges) throw new OvertimePlanWithdrawNotAllowedError('A clock correction cannot be withdrawn as an overtime plan.');

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
      if (!await provenUnlandedDeferredOtTx(tx, plan)) {
        throw new OvertimePlanWithdrawNotAllowedError(
          'This historical approval has no proof that its hours are uncounted. Submit an attendance correction instead.',
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
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: actorOf(ctx).id ?? 'system', cancellationKind: 'withdrawn' })
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
  rejectReason?: string | null;
  originalClockSnapshot?: typeof attendanceCorrection.$inferSelect.originalClockSnapshot;
  clockChanges?: ClockChanges | null;
  reason: string | null;
  remark: string | null;
  requestKind: AttendanceRequestKind | null;
  status: string;
  appliedAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  /** True when a supporting file was attached (the file itself streams from its own route). */
  hasAttachment: boolean;
  workflow?: Awaited<ReturnType<typeof import('./attendance-workflow').attendanceWorkflowForTx>>;
  cancellationKind?: 'cancelled' | 'withdrawn' | null;
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
  // D13 (mobile M12): the read moved into `ownAttendanceRequestRowsTx` below so the keyset page reads the SAME
  // rows in the SAME order; this caller asks for neither the keyset nor the cursor text and gets what it always got.
  return withTenant(ctx, async (tx) => (await ownAttendanceRequestRowsTx(tx, employmentId, opts)).map(({ cursorAt: _cursorAt, ...row }) => row));
}

/**
 * D13 (mobile M12) keyset position in `myAttendanceCorrections`' one order (attendance date desc, created desc, id
 * desc): the row's attendance date, its exact `created_at` as UTC text with microseconds (`cursorAt`), and its id.
 */
export type MyAttendanceRequestCursor = { date: string; at: string; id: string };

/**
 * D13 (mobile M12) — the same own-request read as `myAttendanceCorrections`, one page at a time: strictly past
 * `before` in the same order, optionally narrowed to `ids` (one request's detail re-read under the caller's own
 * session), each row carrying its exact `cursorAt`. RLS still scopes the rows and `employmentId` still narrows them.
 * No web caller passes either option.
 */
export function myAttendanceCorrectionsPage(
  ctx: SessionContext,
  employmentId: string,
  opts: { limit: number; date?: string; status?: 'pending' | 'approved' | 'rejected' | 'cancelled'; before?: MyAttendanceRequestCursor | null; ids?: readonly string[] },
): Promise<(MyAttendanceRequestRow & { cursorAt: string })[]> {
  return withTenant(ctx, (tx) => ownAttendanceRequestRowsTx(tx, employmentId, opts));
}

/**
 * D13 (mobile M12) — how many of ONE employment's requests the caller can see, per stored status (the four the
 * history's chips filter by). The same RLS scope and employment narrowing as `myAttendanceCorrections`.
 */
export function myAttendanceCorrectionCounts(
  ctx: SessionContext,
  employmentId: string,
): Promise<Record<'pending' | 'approved' | 'rejected' | 'cancelled', number>> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: attendanceCorrection.status, n: sql<number>`count(*)::int` })
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.employmentId, employmentId))
      .groupBy(attendanceCorrection.status);
    const out = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = Number(r.n);
    return out;
  });
}

async function ownAttendanceRequestRowsTx(
  tx: Tx,
  employmentId: string,
  opts: { limit?: number; date?: string; status?: 'pending' | 'approved' | 'rejected' | 'cancelled'; before?: MyAttendanceRequestCursor | null; ids?: readonly string[] },
): Promise<(MyAttendanceRequestRow & { cursorAt: string })[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), MY_ATTENDANCE_REQUEST_ROW_CEILING + 1);
  if (opts.ids && opts.ids.length === 0) return [];
  {
    const rows = await tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        adminAmendment: attendanceCorrection.adminAmendment,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
        plannedStartTime: attendanceCorrection.plannedStartTime,
        plannedEndTime: attendanceCorrection.plannedEndTime,
        otReasonCategory: attendanceCorrection.otReasonCategory,
        reason: attendanceCorrection.reason,
        rejectReason: attendanceCorrection.rejectReason,
        originalClockSnapshot: attendanceCorrection.originalClockSnapshot,
        clockChanges: attendanceCorrection.clockChanges,
        remark: attendanceCorrection.remark,
        requestKind: attendanceCorrection.requestKind,
        cancellationKind: attendanceCorrection.cancellationKind,
        status: attendanceCorrection.status,
        appliedAt: attendanceCorrection.appliedAt,
        decidedAt: attendanceCorrection.decidedAt,
        createdAt: attendanceCorrection.createdAt,
        cursorAt: sql<string>`to_char(${attendanceCorrection.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(attendanceCorrection)
      .where(and(
        eq(attendanceCorrection.employmentId, employmentId),
        opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
        opts.date ? eq(attendanceCorrection.attendanceDate, opts.date) : undefined,
        opts.ids ? inArray(attendanceCorrection.id, [...opts.ids]) : undefined,
        // Strictly after the cursor in the one order below (every key descending).
        opts.before ? sql`(${attendanceCorrection.attendanceDate}, ${attendanceCorrection.createdAt}, ${attendanceCorrection.id}) < (${opts.before.date}::date, ${opts.before.at}::timestamptz, ${opts.before.id}::uuid)` : undefined,
      ))
      // Newest first BY THE ATTENDANCE DATE, then by when it was filed — the same ordering the Plan OT
      // list uses, so two lists on one screen are not sorted two different ways.
      .orderBy(desc(attendanceCorrection.attendanceDate), desc(attendanceCorrection.createdAt), desc(attendanceCorrection.id))
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
    const workflows = await attendanceWorkflowsForTx(tx, rows.map(r => r.id));
    return rows.map((r) => ({ ...r, hasAttachment: withFiles.has(r.id), workflow: workflows.get(r.id) ?? null }));
  }
}

export class AttendanceWithdrawRefusedError extends Error {
  /** D13 (mobile M12): cancelOwnAttendanceCorrection's two state refusals, typed so a caller can tell them apart. Same sentences as before. */
  constructor(readonly refusal: 'overtime' | 'not_pending', message: string) { super(message); this.name = 'AttendanceWithdrawRefusedError'; }
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
  /** D13 (mobile M12): the caller's transaction (the mobile command receipt's). Omitted: its own, as before. */
  existingTx?: Tx,
): Promise<{ status: 'cancelled' }> {
  p = structuredClone(p); ctx = captureAttendanceContext(ctx);
  const run = async (tx: Tx) => {
    const req = await lockAttendanceApplicationTx(tx, ctx, p.correctionId);
    if (!req) throw new Error('attendance request not found (or not visible)');
    await assertOwnCorrectionTx(tx, ctx, req.employmentId);
    if (attendanceApplicationType(req) === 'self_overtime') {
      throw new AttendanceWithdrawRefusedError('overtime', 'This is an overtime plan — withdraw it from the Self Overtime list.');
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
      throw new AttendanceWithdrawRefusedError('not_pending', 'This request is no longer waiting for a decision, so it can no longer be withdrawn.');
    }
    await tx
      .update(attendanceCorrection)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: actorOf(ctx).id ?? 'system', cancellationKind: 'withdrawn' })
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
  };
  return existingTx ? run(existingTx) : withTenant(ctx, run);
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
  geofenceMaximumAccuracyM:number|null;
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
        geofenceMaximumAccuracyM:attendancePolicy.geofenceMaximumAccuracyM,
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
            geofenceMaximumAccuracyM:null,
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
    // Undefined preserves an existing cap; null explicitly removes the additional company cap.
    geofenceMaximumAccuracyM?:number|null;
  },
) {
  p=structuredClone(p);ctx=captureAttendanceContext(ctx);
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
  const geofenceMaximumAccuracyM=p.geofenceMaximumAccuracyM;
  if(geofenceMaximumAccuracyM!=null&&(!Number.isInteger(geofenceMaximumAccuracyM)||geofenceMaximumAccuracyM<=0||geofenceMaximumAccuracyM>2147483647))
    throw new Error('Maximum location uncertainty must be a positive whole number of metres.');

  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
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
        geofenceMaximumAccuracyM,
      })
      .onConflictDoUpdate({
        target: attendancePolicy.companyId,
        set: { workStart, workEnd, breakMinutes, lateAfter, halfDayBefore, workingDays, halfWorkingDays, otApprovalCalculation, requireRegisteredDevice,geofenceMaximumAccuracyM },
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
        ...(geofenceMaximumAccuracyM!==undefined?{geofenceMaximumAccuracyM}:{}),
      },
    });
    return row;
  });
}

// ─── ADR-0032 C6 · terminal punch import — r424 (50ed39e1): ADDS punches, never writes over a day ─────
//
// THE OLD RULE, AND WHY IT WENT. `importAttendancePunches` reconciled a file into ONE aggregate per
// (employee, business day) — earliest punch in, latest out — and UPSERTED it: it replaced the whole day,
// writing over Clock-screen clockings and over times already corrected through an approved attendance
// request, and it wrote no `attendance_punch` children at all. r424 retired it. A file is now read
// through a File Structure Mapping (lib/clocking-file.ts) by core/attendance-clocking-import.ts, which
// decides line by line what may be added, and each surviving clocking is ADDED to its day as an ordinary
// R45 multi-punch child (method 'import'); the day is then worked out exactly as the Clock screen's
// multiple clockings are — recomputeDayFromPunches, first in / last out, balanced or left open.
//
// What stays here is the part that needs this file's private machinery: which BUSINESS DAY a clocking
// belongs to (the roster window below, unchanged from the old importer) and the per-day write.
const PUNCH_WINDOW_BUFFER_MIN = 180; // ± window around a rostered shift to still attribute an early/late punch
const dayIndex = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dtMinutes = (date: string, time: string): number => dayIndex(date) * MINS_PER_DAY + toMinutes(time);

/**
 * The business day each clocking belongs to. Roster-aware, exactly as the old importer was: a rostered
 * shift defines a window (shift start..end, +1 day when it crosses midnight, ± PUNCH_WINDOW_BUFFER_MIN)
 * and every clocking inside it belongs to that shift's day — so a 22:00→06:00 night shift's two
 * clockings land on ONE day keyed to the shift's start date. A clocking in no window keeps its own
 * calendar date. Windows are sorted by start so the earlier shift claims a boundary clocking (a night
 * shift's 06:00 clock-out belongs to the night before, not that morning). One roster query for the whole
 * file, never one per line. Returns one day per input, in input order.
 */
export async function assignPunchBusinessDays(
  tx: Tx,
  items: { employmentId: string; date: string; time: string }[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const dates = items.map((m) => m.date).sort();
  const from = addDays(dates[0], -1);
  const to = addDays(dates[dates.length - 1], 1);
  const empIds = [...new Set(items.map((m) => m.employmentId))];
  type Win = { day: string; startDt: number; endDt: number };
  const windowsByEmp = new Map<string, Win[]>();
  // Chunked: a 25,000-line file can name a few thousand employments, and one IN list that long is a
  // planner and parameter-count risk for no gain.
  for (let i = 0; i < empIds.length; i += 1000) {
    const ras = await tx
      .select({
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        shiftType:shift.type,override:shift.normalMinutesOverride,start: shift.startTime,
        end: shift.endTime,
        crosses: shift.crossesMidnight,
      })
      .from(rosterAssignment)
      .innerJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          inArray(rosterAssignment.employmentId, empIds.slice(i, i + 1000)),
          gte(rosterAssignment.shiftDate, from),
          lte(rosterAssignment.shiftDate, to),
        ),
      );
    for (const r of ras) {
      if(r.shiftType==='full_flexi'){continue;}
      if(!r.start||!r.end)throw new Error('A fixed shift has no clock anchors.');
      const endDay = r.crosses ? addDays(r.shiftDate, 1) : r.shiftDate;
      const arr = windowsByEmp.get(r.employmentId) ?? [];
      arr.push({
        day: r.shiftDate,
        startDt: dtMinutes(r.shiftDate, r.start) - PUNCH_WINDOW_BUFFER_MIN,
        endDt: dtMinutes(endDay, r.end) + PUNCH_WINDOW_BUFFER_MIN,
      });
      windowsByEmp.set(r.employmentId, arr);
    }
  }
  for (const arr of windowsByEmp.values()) arr.sort((a, b) => a.startDt - b.startDt);
  const [hasFlexiCutoff]=await tx.select({id:shift.id}).from(shift).where(and(eq(shift.type,'full_flexi'),eq(shift.dailyCutoffEnabled,true))).limit(1);
  const memo=hasFlexiCutoff?await newScheduleMemo(tx,{employmentIds:empIds,from,to}):undefined;
  const resolved=new Map<string,ResolvedSchedule>();
  const schedule=async(id:string,date:string)=>{const key=`${id}|${date}`;let value=resolved.get(key);if(!value){value=await scheduleFor(tx,id,date,memo);resolved.set(key,value);}return value;};
  const result:string[]=[];
  for(const m of items){
    if(memo){
      const previous=addDays(m.date,-1),prior=await schedule(m.employmentId,previous);
      if(prior.durationOnly&&prior.dailyCutoffMinutes!=null&&toMinutes(m.time)<prior.dailyCutoffMinutes){result.push(previous);continue;}
      const current=await schedule(m.employmentId,m.date);
      if(current.durationOnly){result.push(current.dailyCutoffMinutes!=null&&toMinutes(m.time)<current.dailyCutoffMinutes?previous:m.date);continue;}
    }
    const pDt=dtMinutes(m.date,m.time);
    const win=(windowsByEmp.get(m.employmentId)??[]).find(w=>pDt>=w.startDt&&pDt<=w.endDt);
    result.push(win?win.day:m.date);
  }
  return result;
}

/** Real-time ordering key of a clocking read on calendar `date` at `time` (cross-midnight safe). */
export const punchOrderKey = (date: string, time: string): number => dtMinutes(date, time);

export type ImportedPunchInput = { time: string; direction: 'in' | 'out' };
export type ImportedDayInput = { employmentId: string; day: string; punches: ImportedPunchInput[] };

/**
 * r424 — ADD imported clockings to their (employee, business) days and work each day out again. The caller
 * (core/attendance-clocking-import.ts) has already decided that every punch here may be added: not a
 * duplicate, not on a corrected day, not in a closed pay period, its direction known. This function never
 * removes or rewrites a clocking that is already there.
 *
 *  · No day row yet → one is created, day type from the schedule (as a first clock-in does), remarks
 *    'Imported (terminal)'.
 *  · A day row with NO punch children (written before multi-punch, or by the old importer) → its
 *    check-in and check-out are first synthesised as children with the row's own method and geo, the
 *    same legacy backfill checkOutTx does (both ends here, because this path can add either). Without it
 *    an added clocking would make the day look like a single punch and the old times would be lost.
 *  · The day type stamped on an existing row is KEPT (the clock screen's first-clock-in freeze).
 *  · The day is worked out by recomputeDayFromPunches' own rule (deriveDayFromPunchList) — first in /
 *    last out, closed only when the ins and outs balance — and the aggregate's method / geo columns follow
 *    whichever clocking now supplies each end: an import has no geofence reading, so an end that came from
 *    one carries none (ADR-0070).
 *  · An approved overtime plan lands exactly as at clock-out (applyApprovedOtPlanTx).
 *  · One `attendance.imported` event per day, carrying the run id.
 * No geofence and no registered-device gate: a terminal clocking is not a web clock-in (ADR-0070's
 * disclosed bypass; the device gate is never reached because this is not checkInTx).
 *
 * BATCHED, because a file is 25,000 lines (~12,500 days). Measured on this machine, the one-day-at-a-time
 * version took about eight minutes for that file: ~20 statements a day, ten of them scheduleFor re-reading
 * the same policy, rules and calendar. Here the reads are made once (aggregates, punches, OT plans, the
 * roster through a ScheduleMemo), new rows and punches are inserted in bulk with ids minted up front, an
 * EXISTING day costs one UPDATE, and the events go in bulk. The per-day rule is the same function.
 */
export async function addImportedPunchesBatchTx(
  tx: Tx,
  ctx: SessionContext,
  p: { days: ImportedDayInput[]; runId: string },
): Promise<{ punchIds: string[][] }> {
  ctx = captureAttendanceContext(ctx); p = structuredClone(p);
  const days = p.days.filter((d) => d.punches.length > 0);
  if (days.length === 0) return { punchIds: p.days.map(() => []) };
  await lockAttendanceLeaveDependenciesTx(tx, ctx, days.map(day=>day.employmentId));
  // Acquire the checked shared policy epoch before any memoized schedule or dated selection.
  // The batch barrier proves actual visible subjects, including first imports with no day row yet.
  const policyConfigured=await lockAttendancePolicyImportTx(tx,ctx,days.map(d=>({employmentId:d.employmentId,date:d.day})));
  const empIds = [...new Set(days.map((d) => d.employmentId))];
  const sorted = days.map((d) => d.day).sort();
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const keyOf = (e: string, d: string) => `${e}|${d}`;

  // 1 · What is already there: the day rows, their punches, and which days carry an approved OT decision.
  const rowBy = new Map<string, typeof attendance.$inferSelect>();
  const otKeys = new Set<string>();
  const policyPlanRequestedOn=new Map<string,string>();
  for (const ids of chunk(empIds, 1000)) {
    for (const r of await tx
      .select()
      .from(attendance)
      .where(and(inArray(attendance.employmentId, ids), gte(attendance.attendanceDate, from), lte(attendance.attendanceDate, to)))) {
      rowBy.set(keyOf(r.employmentId, r.attendanceDate), r);
    }
    for (const c of await tx
      .select({ employmentId: attendanceCorrection.employmentId, date: attendanceCorrection.attendanceDate,
        createdAt:attendanceCorrection.createdAt,cancelledAt:attendanceCorrection.cancelledAt,
        binding:attendancePolicyRequestContract.policyBinding,window:attendancePolicyRequestContract.plannedWindow,
        attestedWork:attendancePolicyRequestContract.attestedWork })
      .from(attendanceCorrection)
      .leftJoin(attendancePolicyRequestContract,and(eq(attendancePolicyRequestContract.correctionId,attendanceCorrection.id),
        eq(attendancePolicyRequestContract.tenantId,attendanceCorrection.tenantId)))
      .where(
        and(
          inArray(attendanceCorrection.employmentId, ids),
          gte(attendanceCorrection.attendanceDate, from),
          lte(attendanceCorrection.attendanceDate, to),
          eq(attendanceCorrection.status, 'approved'),
          sql`${attendanceCorrection.requestedOtMinutes} is not null`,
        ),
      ).orderBy(desc(attendanceCorrection.decidedAt),desc(attendanceCorrection.createdAt),desc(attendanceCorrection.id))) {
      otKeys.add(keyOf(c.employmentId, c.date));
      const key=keyOf(c.employmentId,c.date);
      if(c.cancelledAt===null&&c.binding&&c.window&&!c.attestedWork&&!policyPlanRequestedOn.has(key))
        policyPlanRequestedOn.set(key,todayInKualaLumpur(c.createdAt));
    }
  }
  type Kid = { punchAt: string; direction: 'in' | 'out'; method: 'web' | 'import' | 'admin' | 'mobile_offline' };
  const kidsBy = new Map<string, Kid[]>();
  const wanted = days.map((d) => rowBy.get(keyOf(d.employmentId, d.day))?.id).filter((x): x is string => !!x);
  for (const ids of chunk(wanted, 1000)) {
    for (const k of await tx
      .select({ attendanceId: attendancePunch.attendanceId, punchAt: attendancePunch.punchAt, direction: attendancePunch.direction, method: attendancePunch.method })
      .from(attendancePunch)
      .where(and(inArray(attendancePunch.attendanceId, ids), isNull(attendancePunch.voidedAt)))) {
      const arr = kidsBy.get(k.attendanceId) ?? [];
      arr.push(k);
      kidsBy.set(k.attendanceId, arr);
    }
  }
  const memo = await newScheduleMemo(tx, { employmentIds: empIds, from: addDays(from, -7), to: addDays(to, 7) });

  const schedules=new Map<string,ResolvedSchedule>();
  for(const d of days){
    const current=await scheduleFor(tx,d.employmentId,d.day,memo),existing=rowBy.get(keyOf(d.employmentId,d.day));
    schedules.set(keyOf(d.employmentId,d.day),existing?.dayType?{...current,dayType:existing.dayType}:current);
  }
  const policyRoutes=policyConfigured?await attendancePolicyImportRoutesTx(tx,ctx,days.map(d=>{
    const sched=schedules.get(keyOf(d.employmentId,d.day))!;
    return {employmentId:d.employmentId,date:d.day,ruleId:sched.rule?.id??null,scheduleSource:sched.source};
  })):null;
  if(policyRoutes&&days.some(d=>!policyRoutes.has(keyOf(d.employmentId,d.day))||policyRoutes.get(keyOf(d.employmentId,d.day))==='unavailable'))
    throw Error('Canonical import policy inputs are unavailable.');

  // 2 · Work every day out in memory.
  const newRows: (typeof attendance.$inferInsert)[] = [];
  const punchRows: (typeof attendancePunch.$inferInsert)[] = [];
  const updates: { id: string; set: Partial<typeof attendance.$inferInsert> }[] = [];
  const otDays: { employmentId: string; day: string; attendanceId: string; sched: ResolvedSchedule; systemOt: number | null }[] = [];
  const results = new Map<ImportedDayInput, { attendanceId: string; punchIds: string[]; checkInAt: string | null; checkOutAt: string | null }>();
  for (const d of days) {
    const existing = rowBy.get(keyOf(d.employmentId, d.day));
    const sched=schedules.get(keyOf(d.employmentId,d.day))!;
    const policyRaw=policyRoutes?.get(keyOf(d.employmentId,d.day))==='policy';
    const attendanceId = existing?.id ?? randomUUID();
    const base = { tenantId: ctx.tenantId, attendanceId, employmentId: d.employmentId, attendanceDate: d.day };
    const all: Kid[] = [...(existing ? (kidsBy.get(existing.id) ?? []) : [])];
    if (existing && all.length === 0) {
      if (existing.checkInAt) {
        const method = existing.checkInMethod ?? ('web' as const);
        punchRows.push({
          ...base,
          id: randomUUID(),
          punchAt: existing.checkInAt,
          direction: 'in',
          method,
          lat: existing.checkInLat,
          lng: existing.checkInLng,
          clockingLocationId: existing.checkInClockingLocationId,
          distanceM: existing.checkInDistanceM,
          geofenceStatus: existing.checkInGeofenceStatus,
          radiusM: existing.checkInRadiusM,
        });
        all.push({ punchAt: existing.checkInAt, direction: 'in', method });
      }
      if (existing.checkOutAt) {
        const method = existing.checkOutMethod ?? existing.checkInMethod ?? ('web' as const);
        punchRows.push({
          ...base,
          id: randomUUID(),
          punchAt: existing.checkOutAt,
          direction: 'out',
          method,
          lat: existing.checkOutLat,
          lng: existing.checkOutLng,
          clockingLocationId: existing.checkOutClockingLocationId,
          distanceM: existing.checkOutDistanceM,
          geofenceStatus: existing.checkOutGeofenceStatus,
          radiusM: existing.checkOutRadiusM,
        });
        all.push({ punchAt: existing.checkOutAt, direction: 'out', method });
      }
    }
    const punchIds: string[] = [];
    for (const x of d.punches) {
      const id = randomUUID();
      punchIds.push(id);
      punchRows.push({ ...base, id, punchAt: x.time, direction: x.direction, method: 'import' });
      all.push({ punchAt: x.time, direction: x.direction, method: 'import' });
    }
    const legacy=deriveDayFromPunchList(sched,d.day,all,existing?.checkInAt??d.punches[0].time);
    // Every imported child has no capture receipt. Retain actual labels, including an unmatched
    // Out, but do not reuse the legacy envelope's numeric work, deductions, OT or trace.
    const raw=policyRaw?attendancePolicyUncapturedRawDay({fallbackIn:all.filter(k=>k.direction==='in').map(k=>k.punchAt).sort()[0]??null,
      fallbackOut:all.filter(k=>k.direction==='out').map(k=>k.punchAt).sort().at(-1)??null}):null;
    const set=raw??legacy.set;
    const result=raw?{status:raw.status,workedMinutes:raw.workedMinutes,otMinutes:raw.otMinutes,checkInAt:raw.checkInAt,checkOutAt:raw.checkOutAt}:legacy.result;
    // The aggregate's method / geo columns describe the clocking that supplies each end NOW. When an
    // imported clocking has become the day's first in or last out, that end carries no geofence reading.
    const endFrom = (dir: 'in' | 'out', at: string | null) => (at == null ? [] : all.filter((k) => k.direction === dir && k.punchAt === at));
    const inSrc = endFrom('in', result.checkInAt);
    const outSrc = endFrom('out', result.checkOutAt);
    const ends: Partial<typeof attendance.$inferInsert> = {};
    if (existing && inSrc.length > 0 && inSrc.every((k) => k.method === 'import') && existing.checkInMethod !== 'import') {
      Object.assign(ends, {
        checkInMethod: 'import' as const,
        checkInLat: null,
        checkInLng: null,
        checkInClockingLocationId: null,
        checkInDistanceM: null,
        checkInGeofenceStatus: null,
        checkInRadiusM: null,
      });
    }
    if (outSrc.length > 0 && outSrc.every((k) => k.method === 'import') && (existing?.checkOutMethod ?? null) !== 'import') {
      Object.assign(ends, {
        checkOutMethod: 'import' as const,
        checkOutLat: null,
        checkOutLng: null,
        checkOutClockingLocationId: null,
        checkOutDistanceM: null,
        checkOutGeofenceStatus: null,
        checkOutRadiusM: null,
      });
    }
    if (!existing) {
      // r430 — status/checkInAt are no longer hardcoded here: `set` is PROVABLY non-null for this caller
      // (fallbackCheckInAt is always `existing?.checkInAt ?? d.punches[0].time`, a real string, since an
      // imported day always has at least one punch by construction), so deriveDayFromPunchList's own
      // status/checkInAt always win via the spread below — the two hardcoded values TS now correctly
      // flags as dead (TS2783) were always silently overwritten, never actually read.
      newRows.push({
        id: attendanceId,
        tenantId: ctx.tenantId,
        employmentId: d.employmentId,
        attendanceDate: d.day,
        dayType: sched.dayType,
        remarks: 'Imported (terminal)',
        checkInMethod: 'import',
        ...(set ?? {}),
        ...ends,
      });
    } else if (set || Object.keys(ends).length) {
      updates.push({ id: attendanceId, set: { ...(set ?? {}), ...ends } });
    }
    if (!policyRaw&&otKeys.has(keyOf(d.employmentId, d.day))) {
      otDays.push({ employmentId: d.employmentId, day: d.day, attendanceId, sched, systemOt: result.otMinutes });
    }
    results.set(d, { attendanceId, punchIds, checkInAt: result.checkInAt, checkOutAt: result.checkOutAt });
  }

  // 3 · Write: day rows first (the punches reference them), then punches, then the existing days' figures.
  for (const part of chunk(newRows, 500)) await tx.insert(attendance).values(part);
  for (const part of chunk(punchRows, 1000)) await tx.insert(attendancePunch).values(part);
  for (const u of updates) await tx.update(attendance).set(u.set).where(eq(attendance.id, u.id));

  // 4 · 1e9145d4 — an imported day is a worked day, so an overtime plan approved ahead of it lands here on
  // the same terms as a clock-out (and is re-asserted, not re-landed, when it already has). Only on commit:
  // a preview never reaches this function. Only the days that carry an approved OT decision are asked.
  const plannedBy = new Map<string, number>();
  for (const o of otDays) {
    const planned = await applyApprovedOtPlanTx(tx, ctx, {
      employmentId: o.employmentId,
      date: o.day,
      attendanceId: o.attendanceId,
      sched: o.sched,
      systemOtMinutes: o.systemOt,
    });
    if (planned != null) plannedBy.set(keyOf(o.employmentId, o.day), planned);
  }

  for (const d of days) if (!plannedBy.has(keyOf(d.employmentId,d.day))) await refreshOvertimePatternDayTx(tx,ctx,{employmentId:d.employmentId,date:d.day,reason:'Imported clocking day'});
  // Work arrival, not public recalculation, triggers the existing opted-in credit owner.
  // Batched plan metadata supplies only Request Date; the owner replays the complete
  // current approved union, independent duration and original physical source again.
  for(const d of days){
    const key=keyOf(d.employmentId,d.day),requestedOn=policyPlanRequestedOn.get(key),result=results.get(d)!;
    if(policyRoutes?.get(key)==='policy'&&requestedOn&&result.checkInAt&&result.checkOutAt)
      await maybeAutoAccrueOnApprovalTx(tx,ctx,{employmentId:d.employmentId,workedDate:d.day,
        dayType:schedules.get(key)!.dayType,requestedOn});
  }

  // 5 · One `attendance.imported` event per day.
  const events = days.map((d) => {
    const r = results.get(d)!;
    const planned = plannedBy.get(keyOf(d.employmentId, d.day));
    return {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: r.attendanceId,
      eventType: 'attendance.imported',
      actor: actorOf(ctx),
      subjectEmploymentId: d.employmentId,
      payload: {
        date: d.day,
        checkIn: r.checkInAt,
        checkOut: r.checkOutAt,
        source: 'terminal',
        runId: p.runId,
        punchCount: d.punches.length,
        ...(planned != null ? { otMinutes: planned, otPlanApplied: true } : {}),
      },
    };
  });
  for (const part of chunk(events, 500)) await appendEvents(tx, part);
  return { punchIds: p.days.map((d) => results.get(d)?.punchIds ?? []) };
}

// ─────────────── 1c1b321a · Recompute Attendance — the range writer's per-day derivation ───────────────
//
// THE SECOND RE-DERIVE PATH. A day's figures are decided once, at check-out, and then kept. One path
// already re-decides them wholesale against a FRESH schedule and writes the result: approving a clock-time
// correction (decideAttendanceCorrection — resolves a fresh sched and writes sched.dayType). Recompute
// follows it rather than inventing another behaviour: same scheduleFor, same deriveAttendance, same
// stage1Columns, same "day type is re-decided from the calendar and the roster".
//
// ⚠️ r424 (50ed39e1) — THIS USED TO SAY "THE THIRD", counting re-uploading a clocking file
// (importAttendancePunches) as the second wholesale re-derive. That importer is retired: an import now
// ADDS clockings to a day (addImportedPunchesBatchTx) and works it out the Clock-screen way — through
// recomputeDayFromPunches' rule, keeping the day type stamped on the row — so it is no longer a path of this kind.
//
// The first-clock-in DAY-TYPE FREEZE lives on checkInTx/checkOutTx (and, since r424, on the import's
// addImportedPunchesBatchTx) and is deliberately not honoured here, exactly as it is not honoured by the
// correction path above.
//
// Recompute returns CALCULATED figures only, never check_in_at / check_out_at. Fixed and Semi-Flexi use
// the stored clock envelope as before. Full Flexi reads active clock evidence through the same closed-pair
// owner as clock corrections; the envelope alone would turn an unpaid gap into worked/overtime minutes.
// A legacy day without raw punch evidence retains its established stored-clock fallback.
//
// Owned by feedback item 1c1b321a. core/attendance-recompute.ts is its only caller.

/**
 * Re-derive ONE stored day against the schedule that applies to it TODAY, and hand back both the figures
 * and the exact column bag to write. Writes nothing itself.
 *
 * For legacy days/applications, `approvedOtMinutes` is the ADR-0069 guard: that approved
 * number is kept and only its per-rate split is recut (exactly as decideAttendanceCorrection does), so a
 * recompute can refresh the measured figures beside it without overwriting the approved legacy total.
 * New policy days use the shared captured-source projection; a scalar approval cannot supply their
 * unfinished positioned receipt or financial result.
 *
 * Idempotent by construction: the result is a pure function of (stored clock evidence, current schedule,
 * date), so running it twice over the same range produces the same bag the second time.
 */
export async function recomputeDayFigures(
  tx: Tx, ctx:SessionContext,
  p: {
    employmentId: string;
    date: string;
    checkInAt: string;
    checkOutAt: string | null;
    approvedOtMinutes?: number | null;
  },
) {
  // Projection only: actual write roots own the complete interval BEFORE their earlier reads,
  // Payroll/credit/day locks and writes. Do not introduce a late leaf lock or affect dry-run scopes.
  p={...p};ctx=captureAttendanceContext(ctx);
  const projected=await policyRawDayProjectionTx(tx,ctx,{employmentId:p.employmentId,date:p.date,
    fallbackIn:p.checkInAt,fallbackOut:p.checkOutAt,classification:'currentSchedule'});
  if(projected.state==='policy'){
    // Clock labels are outside the range-recompute contract. A scalar historical OT approval cannot
    // replace this policy owner's future positioned receipt and independent financial replay.
    const {checkInAt,checkOutAt,...columns}=projected.columns;
    return {dayType:projected.schedule.dayType,source:projected.schedule.source,
      shiftCode:projected.schedule.displayShiftCode??null,otPreserved:false,
      columns:{...columns,dayType:projected.schedule.dayType}};
  }
  const sched = await scheduleFor(tx, p.employmentId, p.date);
  const d = await deriveStoredAttendanceTx(tx, sched, p);
  const keepOt = p.approvedOtMinutes != null;
  const approvedRows=keepOt?effectiveOvertimeRows(p.approvedOtMinutes!,sched.dayType,sched.rule,sched.manualOtRows):null;
  const otMinutes=approvedRows?.total??d.otMinutes;
  if(approvedRows&&d.trace.overtime){
    d.trace.overtime.approvedMinutes=p.approvedOtMinutes!;
    d.trace.overtime.minutes=approvedRows.total;d.trace.overtime.split=approvedRows.split;
    d.trace.overtime.rows=approvedRows.rows.map(row=>({...row,calculatedMinutes:d.trace.overtime!.rows?.find(r=>r.key===row.key)?.calculatedMinutes??0}));
  }
  const stage1=approvedRows?{...stage1Columns(d),...otSplitColumns(approvedRows.split)}:stage1Columns(d);
  return {
    dayType: sched.dayType,
    source: sched.source,
    shiftCode: sched.displayShiftCode ?? null,
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

/** Reuse Full Flexi's closed-pair owner for reads/recalculation; other shift types keep their envelope. */
async function deriveStoredAttendanceTx(tx:Tx,schedule:ResolvedSchedule,p:{employmentId:string;date:string;checkInAt:string;checkOutAt:string|null}){
  if(schedule.durationOnly){
    const punches=(await punchesForCorrectionTx(tx,p.employmentId,p.date)).filter(punch=>!punch.voidedAt);
    if(punches.length){
      const paired=fullFlexiIntervals(punches,p.checkInAt,schedule.dailyCutoffMinutes);
      // Malformed/open raw evidence must not regain a complete day through the stored envelope.
      return deriveAttendance(schedule,paired.checkInAt??p.checkInAt,paired.checkOutAt,p.date,paired.intervals);
    }
  }
  return deriveAttendance(schedule,p.checkInAt,p.checkOutAt,p.date);
}

/** Presentation/command anchoring only; calculation remains in the existing writer. */
export async function clockScheduleForTx(tx: Tx, employmentId: string, date: string) {
  const schedule = await scheduleFor(tx, employmentId, date);
  return { crossesMidnight: schedule.crossesMidnight, durationOnly: schedule.durationOnly === true, start: schedule.shiftStart, end: schedule.shiftEnd, code: schedule.displayShiftCode ?? null };
}


/** Administrative cancellation/withdrawal. Historical decisions remain immutable. Approved results may
 * be reversed only if the recorded effect still owns the day and no dependent leave credit exists. */
export async function cancelAttendanceApplication(ctx: SessionContext, p: {
    correctionId: string;
    kind: 'cancelled' | 'withdrawn';
    reason: string;
}) {
  p = structuredClone(p); ctx = captureAttendanceContext(ctx);
    if (!['cancelled', 'withdrawn'].includes(p.kind) || !p.reason?.trim() || p.reason.trim().length > 1000)
        throw new Error('A cancellation reason of 1–1000 characters is required.');
    return withTenant(ctx, async (tx) => {
        const cor = await lockAttendanceApplicationTx(tx, ctx, p.correctionId);
        if (!cor)
            throw new Error('Attendance application not found or not visible.');
        const [subject] = await tx.select({ personId: employment.personId, allowed: sql<boolean> `app.can_admin_employment(${employment.id})` }).from(employment).where(eq(employment.id, cor.employmentId)).limit(1);
        if (!subject?.allowed || (!hasGrantFor(withEffectiveGrants(ctx), 'hr_admin') && !hasGrantFor(withEffectiveGrants(ctx), 'super_admin')))
            throw new Error('Only an authorised HR administrator may cancel attendance applications.');
        if (ctx.personId && ctx.personId === subject.personId)
            throw new Error('You cannot administratively cancel your own attendance application.');
        if (cor.status !== 'pending' && cor.status !== 'approved')
            throw new Error('Only pending or approved applications can be cancelled or withdrawn.');
        let reversed = false;
        let attestedCancellation=false;
        let plannedCancellation=false;
        if(cor.status==='approved'&&!cor.originalClockSnapshot?.unclockedWork&&!cor.proposedCheckIn&&!cor.proposedCheckOut
          &&!cor.clockChanges&&cor.plannedStartTime!==null&&cor.plannedEndTime!==null&&cor.requestedOtMinutes!==null){
            // The application lock already holds the employee advisory. A positioned
            // plan withdrawal removes quantity, never restores or edits clock figures.
            await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date:cor.attendanceDate});
            const retained=await retainedAttendancePolicyPlanCancellationTx(tx,ctx,{correctionId:cor.id,employmentId:cor.employmentId,date:cor.attendanceDate});
            if(retained){
                for(const date of retained.protectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date});
                await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:cor.employmentId,date:cor.attendanceDate}]);
                const reserved=await readOvertimeSettlementForDayTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
                if(reserved?.settlement)throw Error('Release the existing Payroll contribution or reverse its Leave Credit before withdrawing this approved plan.');
                const batches=await lockAttendancePayrollTx(tx,cor.employmentId,retained.protectedDates);
                const [credit]=await tx.select({id:toilAccrual.id}).from(toilAccrual).where(and(eq(toilAccrual.employmentId,cor.employmentId),
                    eq(toilAccrual.workedDate,cor.attendanceDate),sql`${toilAccrual.status}<>'reversed'`)).limit(1);
                if(credit)throw Error('Review and reverse the dependent Leave Credit before cancelling this application.');
                await markAttendancePayrollTx(tx,ctx,batches,cor.employmentId);
                plannedCancellation=true;
            }
        }
        if(cor.status==='approved'&&cor.originalClockSnapshot?.unclockedWork){
            // Employee advisory is already held by lockAttendanceApplicationTx. Preserve
            // source/configuration/batch ordering and the original immutable HR evidence.
            await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date:cor.attendanceDate});
            const retained=await retainedAttestedPolicyCancellationTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
            if(!retained||retained.correctionId!==cor.id)throw Error('The original unclocked-work approval no longer owns this day. Review its later changes first.');
            // Lock the complete physical statement before configuration and then ask the
            // same Payroll protection owner once for every covered date, including later months.
            for(const date of retained.protectedDates)await lockOvertimeDayForAttendanceWriteTx(tx,{employmentId:cor.employmentId,date});
            await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:cor.employmentId,date:cor.attendanceDate}]);
            const reserved=await readOvertimeSettlementForDayTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate});
            if(reserved?.settlement)throw Error('Release the existing Payroll contribution or reverse its Leave Credit before cancelling this unclocked-work approval.');
            const batches=await lockAttendancePayrollTx(tx,cor.employmentId,retained.protectedDates);
            const credits=await tx.select({id:toilAccrual.id}).from(toilAccrual).where(and(eq(toilAccrual.employmentId,cor.employmentId),
                eq(toilAccrual.workedDate,cor.attendanceDate),sql`${toilAccrual.status}<>'reversed'`)).limit(1);
            if(credits.length)throw Error('Review and reverse the dependent Leave Credit before cancelling this application.');
            await tx.update(attendance).set({attestedWorkCorrectionId:null,attestedWorkContext:null})
                .where(and(eq(attendance.id,retained.attendanceId),eq(attendance.tenantId,ctx.tenantId),eq(attendance.attestedWorkCorrectionId,cor.id)));
            await markAttendancePayrollTx(tx,ctx,batches,cor.employmentId);
            attestedCancellation=true;
        }else if (!plannedCancellation && cor.status === 'approved' && !await provenUnlandedDeferredOtTx(tx, cor)) {
            const batches = await lockAttendancePayrollTx(tx, cor.employmentId, cor.attendanceDate);
            const later = await tx.select({ id: attendanceCorrection.id }).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId, cor.employmentId), eq(attendanceCorrection.attendanceDate, cor.attendanceDate), eq(attendanceCorrection.status, 'approved'), sql `${attendanceCorrection.id}<>${cor.id}`, cor.decidedAt ? gt(attendanceCorrection.decidedAt, cor.decidedAt) : sql`false`)).limit(1);
            if (later.length)
                throw new Error('A later approval affects this day. Use a new correction so its decisions are preserved.');
            const credits = await tx.select({ id: toilAccrual.id }).from(toilAccrual).where(and(eq(toilAccrual.employmentId, cor.employmentId), eq(toilAccrual.workedDate, cor.attendanceDate), sql `${toilAccrual.status}<>'reversed'`)).limit(1);
            if (credits.length)
                throw new Error('This day has a dependent Leave Credit. Review and reverse that credit through Leave Credits before cancelling this application.');
            const [day] = await tx.select({ id: attendance.id }).from(attendance).where(and(eq(attendance.employmentId, cor.employmentId), eq(attendance.attendanceDate, cor.attendanceDate))).limit(1).for('update');
            const [effect] = await tx.select({ payload: domainEvent.payload }).from(domainEvent).where(and(eq(domainEvent.aggregateId, cor.id), eq(domainEvent.eventType, 'attendance-correction.effect.recorded'))).orderBy(desc(domainEvent.occurredAt), desc(domainEvent.id)).limit(1);
            type Figures = NonNullable<Awaited<ReturnType<typeof attendanceFiguresByIdTx>>>;
            let data = effect?.payload as {
                attendanceId: string;
                before: Figures | null;
                after: Figures;
                beforePunches: {
                    id: string;
                    punchAt: string;
                    direction: 'in' | 'out';
                }[];
                afterPunchFingerprint: string;
                clockChanged: boolean;
            } | undefined;
            // A deferred overtime plan records its effect when it lands, in attendance.amended. It changes only OT.
            if (!data && !cor.proposedCheckIn && !cor.clockChanges) {
                const [landing] = await tx.select({ payload: domainEvent.payload, attendanceId: domainEvent.aggregateId }).from(domainEvent).where(and(eq(domainEvent.eventType, 'attendance.amended'), sql `${domainEvent.payload}->>'correctionId'=${cor.id}`, sql `${domainEvent.payload}->>'otPlanApplied'='true'`)).orderBy(desc(domainEvent.occurredAt), desc(domainEvent.id)).limit(1);
                if (landing) {
                    const v = landing.payload as {
                        before: Figures;
                        after: Figures;
                    };
                    data = { attendanceId: landing.attendanceId, before: v.before, after: v.after, beforePunches: [], afterPunchFingerprint: '', clockChanged: false };
                }
            }
            if (!day || !data || day.id !== data.attendanceId)
                throw new Error('This historical application has no reversible effect record. Submit a new attendance correction.');
            const current = await attendanceFiguresByIdTx(tx, day.id);
            if (!isDeepStrictEqual(current, data.after))
                throw new Error('Attendance has changed since this approval. Submit a new correction instead of reversing later changes.');
            const raw = await punchesForCorrectionTx(tx, cor.employmentId, cor.attendanceDate);
            if (data.clockChanged && clockFingerprint(raw) !== data.afterPunchFingerprint)
                throw new Error('Clock data has changed since this approval. Submit a new correction instead.');
            if (data.clockChanged)
                await applyClockChangesTx(tx, ctx, { attendanceId: day.id, employmentId: cor.employmentId, date: cor.attendanceDate, reason: p.reason.trim(), correctionId: cor.id, changes: { version: 1, baseline: clockFingerprint(raw), entries: data.beforePunches } });
            // The projection is serialized as unknown-valued audit data, but these immutable internal
            // receipts contain exactly this schema projection. Keep the write's type equally narrow.
            const restored = (data.before ?? Object.fromEntries(Object.keys(AMENDED_FIGURE_COLUMNS).map(k => [k, k === 'status' ? 'absent' : k === 'dayType' ? data!.after.dayType : null]))) as Pick<typeof attendance.$inferSelect, keyof typeof AMENDED_FIGURE_COLUMNS>;
            await tx.update(attendance).set(restored).where(eq(attendance.id, day.id));
            await markAttendancePayrollTx(tx, ctx, batches, cor.employmentId);
            await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance', aggregateId: day.id, eventType: 'attendance.application.reversed', actor: actorOf(ctx), subjectEmploymentId: cor.employmentId, payload: { correctionId: cor.id, reason: p.reason.trim(), before: current, after: await attendanceFiguresByIdTx(tx, day.id) } });
            reversed = true;
        }
        await tx.update(attendanceCorrection).set({ status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: actorOf(ctx).id ?? 'system', cancellationKind: p.kind, cancellationReason: p.reason.trim() }).where(eq(attendanceCorrection.id, cor.id));
        // The existing calculation owner refuses active cash/TOIL claims atomically. A
        // cancellation cannot release money or credit, or keep a ready duration on a cancelled source.
        if(attestedCancellation||plannedCancellation)await refreshOvertimePatternDayTx(tx,ctx,{employmentId:cor.employmentId,date:cor.attendanceDate,
            reason:attestedCancellation?'Cancelled unclocked-work approval':'Withdrawn approved-plan quantity'});
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: cor.id, eventType: 'attendance-correction.cancelled', actor: actorOf(ctx), subjectEmploymentId: cor.employmentId, payload: { previousStatus: cor.status, resultingStatus: 'cancelled', cancellationKind: p.kind, reason: p.reason.trim(), reversed, ...(attestedCancellation?{attestedApprovalWithdrawn:true}:{}), ...(plannedCancellation?{approvedPlanWithdrawn:true}:{}), date: cor.attendanceDate, actualPersonId: ctx.personId ?? null } });
        return { status: 'cancelled' as const, reversed };
    });
}


export async function attendanceDayCalculationTx(tx:Tx,ctx:SessionContext,employmentId:string,date:string) {
  let schedule=await scheduleFor(tx,employmentId,date);
  const [day]=await tx.select().from(attendance).where(and(eq(attendance.employmentId,employmentId),eq(attendance.attendanceDate,date))).limit(1);
  const [approved]=await tx.select({minutes:attendanceCorrection.approvedOtMinutes}).from(attendanceCorrection)
    .where(and(eq(attendanceCorrection.employmentId,employmentId),eq(attendanceCorrection.attendanceDate,date),eq(attendanceCorrection.status,'approved'),isNotNull(attendanceCorrection.approvedOtMinutes)))
    .orderBy(desc(attendanceCorrection.decidedAt),desc(attendanceCorrection.id)).limit(1);
  const projected=day?.checkInAt?await policyRawDayProjectionTx(tx,ctx,{employmentId,date,
    fallbackIn:day.checkInAt,fallbackOut:day.checkOutAt,classification:'currentSchedule'}):null;
  if(projected?.state==='policy')schedule=projected.schedule;
  const policyRaw=projected?.state==='policy';
  const automatic=projected?.state==='policy'?{...projected.columns,trace:projected.columns.calcTrace,otSplit:null}:
    day?.checkInAt?await deriveStoredAttendanceTx(tx,{...schedule,manualOtRows:{}},{employmentId,date,checkInAt:day.checkInAt,checkOutAt:day.checkOutAt}):null;
  const automaticMinutes=automatic?.otMinutes??0;
  const approvedOtMinutes=policyRaw?null:approved?.minutes??null;
  return {day:day??null,approvedOtMinutes,automatic,policyRaw,
    rows:policyRaw?[]:overtimeCalculationRows(automaticMinutes,schedule.dayType,schedule.rule),
    effectiveBaseRows:policyRaw?[]:overtimeCalculationRows(approvedOtMinutes??automaticMinutes,schedule.dayType,schedule.rule),
    schedule:{shiftId:schedule.displayShiftId??null,shiftCode:schedule.displayShiftCode??null,
      dayKind:schedule.dayType==='holiday'?'holiday' as const:schedule.dayType==='rest_day'?'rest_day' as const:schedule.scheduleDayKind==='off'?'off_day' as const:'workday' as const,
      scheduledMinutes:schedule.scheduledMinutes,shiftStart:schedule.shiftStart,shiftEnd:schedule.shiftEnd,source:schedule.source},
  };
}

/** Only dates with explicit corrections need the canonical per-date resolver beside the batched ladder. */
export async function attendanceDateOverridesTx(tx:Tx,employmentIds:string[],from:string,to:string) {
  const result=new Map<string,{dayKind:WorkedDayKind;working:boolean;shiftDisplay:ShiftDisplay;shiftId:string|null;calendar:Omit<OtPlanCalendarDay,'date'|'kind'>}>();
  if(!employmentIds.length)return result;
  const rows=await tx.select().from(attendanceDayAdjustment).where(and(inArray(attendanceDayAdjustment.employmentId,employmentIds),gte(attendanceDayAdjustment.attendanceDate,from),lte(attendanceDayAdjustment.attendanceDate,to)));
  if(!rows.length)return result;
  const memo=await newScheduleMemo(tx,{employmentIds:[...new Set(rows.map(r=>r.employmentId))],from,to});
  for(const row of rows){
    if(!row.shiftId&&!row.dayKind)continue;
    const schedule=await scheduleFor(tx,row.employmentId,row.attendanceDate,memo);
    const dayKind:WorkedDayKind=schedule.dayType==='holiday'?'holiday':schedule.dayType==='rest_day'?'rest_day':schedule.scheduleDayKind==='off'?'off_day':'workday';
    result.set(`${row.employmentId}|${row.attendanceDate}`,{dayKind,working:dayKind==='workday',shiftId:schedule.displayShiftId??null,
      shiftDisplay:{shiftCode:schedule.displayShiftCode??null,scheduledMinutes:dayKind==='rest_day'||dayKind==='off_day'?null:schedule.scheduledMinutes,
        shiftStart:dayKind==='rest_day'||dayKind==='off_day'?null:schedule.shiftStart?.slice(0,5)??null,
        shiftEnd:dayKind==='rest_day'||dayKind==='off_day'?null:schedule.shiftEnd?.slice(0,5)??null,isRosterRest:dayKind==='rest_day'},calendar:{source:schedule.source,shiftCode:schedule.displayShiftCode??null,
        shiftName:schedule.displayShiftName??null,scheduleStart:dayKind==='off_day'||dayKind==='rest_day'?null:schedule.shiftStart?.slice(0,5)??null,
        scheduleEnd:dayKind==='off_day'||dayKind==='rest_day'?null:schedule.shiftEnd?.slice(0,5)??null,
        breakStart:schedule.breakPeriods?.length===1?schedule.breakPeriods[0].start.slice(0,5):null,
        breakEnd:schedule.breakPeriods?.length===1?schedule.breakPeriods[0].end.slice(0,5):null,breakMinutes:schedule.breakMinutes}});
  }
  return result;
}

/** Shared submission owner: employee removal constructs a narrow proposal before entering here. */
type AttendanceCorrectionInsertInput={
  id?:string;removalPunchId?:string;employmentId:string;date:string;clockChanges:ClockChanges|null;
  checkIn:string|null;checkOut:string|null;requestedOtMinutes:number|null;reason:string;
  plannedStartTime:string|null;plannedEndTime:string|null;otReasonCategory:OtReasonCategory|null;
  remark:string|null;requestKind:AttendanceRequestKind;unclockedWork?:AttendancePolicyUnclockedWork;
};
async function prepareAttendanceCorrectionInsertSourceTx(tx:Tx,ctx:SessionContext,p:AttendanceCorrectionInsertInput){
  const {clockChanges,checkIn,checkOut,requestedOtMinutes}=p;
  // Freeze the server resolver's selected identity, never a form-supplied rule/revision. Use the
  // existing configuration barrier BEFORE selection and the DB submission owner records/checks
  // the immutable revision under the same transaction. This binding proves neither work nor pay.
  let executionPolicy:ReturnType<typeof attendancePolicyTraceBinding>=null;
  if(requestedOtMinutes!==null){
    await lockAttendancePolicyImportTx(tx,ctx,[{employmentId:p.employmentId,date:p.date}]);
    const context=await attendancePolicyExecutionContextTx(tx,ctx,{employmentId:p.employmentId,date:p.date});
    if(context.state==='unavailable')throw Error('The submitted Attendance policy is unavailable.');
    if(p.unclockedWork&&(context.state!=='policy'||!context.selected.policy.overtime.enabled
      ||!context.selected.policy.overtime.allowBackdatedWithoutClock||context.selected.activation.epoch<1))
      throw Error('The dated Schedule Group policy does not permit unclocked overtime.');
    if(context.state==='policy'){
      executionPolicy=attendancePolicyTraceBinding(context);
      if(!executionPolicy)throw Error('The submitted Attendance policy identity is unavailable.');
    }
  }

    const [original] = clockChanges || checkIn || checkOut ? await tx.select({
      id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt, version:sql<string>`${attendance}.xmin::text`,
    }).from(attendance).where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date))).limit(1) : [];
 return {executionPolicy,original:original??null};
}
async function insertAttendanceCorrectionRequestTx(tx:Tx,ctx:SessionContext,p:AttendanceCorrectionInsertInput,options:{returnEventId:true}):Promise<{correctionId:string;eventId:string}>;
async function insertAttendanceCorrectionRequestTx(tx:Tx,ctx:SessionContext,p:AttendanceCorrectionInsertInput):Promise<{correctionId:string}>;
async function insertAttendanceCorrectionRequestTx(tx:Tx,ctx:SessionContext,p:AttendanceCorrectionInsertInput,options?:{returnEventId:true}){
 const {clockChanges,checkIn,checkOut,requestedOtMinutes,reason,plannedStartTime,plannedEndTime,otReasonCategory,remark,requestKind}=p;
 const {executionPolicy,original}=await prepareAttendanceCorrectionInsertSourceTx(tx,ctx,p);
    const originalClockSnapshot = clockChanges || checkIn || checkOut || executionPolicy ? {
      version: 1 as const, attendanceId: original?.id ?? null,
      originalCheckIn: original?.checkIn ?? null, originalCheckOut: original?.checkOut ?? null,
      capturedAt: new Date().toISOString(),
      ...(executionPolicy?{executionPolicy}:{}),
      ...(p.unclockedWork?{unclockedWork:structuredClone(p.unclockedWork)}:{}),
    } : null;
    const [row] = await tx
      .insert(attendanceCorrection)
      .values({
        ...(p.id?{id:p.id}:{}),
        removalPunchId:p.removalPunchId??null,
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
        originalClockSnapshot,
        clockChanges,
      })
      .returning({ id: attendanceCorrection.id });
    await snapshotAttendanceWorkflowTx(tx, ctx, row.id, p.employmentId, attendanceApplicationType({ requestKind, proposedCheckIn: checkIn, proposedCheckOut: checkOut, clockChanges, requestedOtMinutes }));
    const eventId=await appendEvent(tx, {
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
        originalClockSnapshot,
        clockChanges,
      },
    },{returnId:!!options?.returnEventId});
    if(options?.returnEventId){if(!eventId)throw Error('Attendance event reference unavailable.');return {correctionId:row.id,eventId};}
    return { correctionId: row.id };
}

/** Own web punch only. A selector must resolve to an own active employment; the caller cannot supply
 * a trusted subject, attendance day or replacement clock set. */
export async function requestOwnClockRemoval(ctx:SessionContext,p:{punchId:string;requestId:string;baseline:string;reason:string;clockContext:string;employmentId?:string}){
  const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const reason=typeof p.reason==='string'?p.reason.trim():'';
  if(!uuid.test(p.punchId)||!uuid.test(p.requestId)||!reason||reason.length>500||!/^[0-9a-f]{64}$/.test(p.baseline))throw new Error('Choose a clocking and enter a removal remark of at most 500 characters.');
  const me=await resolveOwnClockEmployment(ctx,p.employmentId);if(!me)throw new Error('No active employee profile.');
  if(p.clockContext!==clockCommandContext(ctx.tenantId,ctx.userId,me.employmentId))throw new Error('Your employee account changed. Reopen Web Clocking.');
  return withTenant(ctx,async tx=>{
    // Same fence as captureEmployeeClock, including a day that has never had a correction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+me.employmentId},0))`);
    const [previous]=await tx.select().from(attendanceCorrection).where(eq(attendanceCorrection.id,p.requestId)).limit(1);
    if(previous){if(previous.employmentId!==me.employmentId||previous.removalPunchId!==p.punchId||previous.reason!==reason||previous.clockChanges?.baseline!==p.baseline)throw new Error('This removal identity is already in use.');return {correctionId:previous.id};}
    const [target]=await tx.select({punch:attendancePunch,capture:attendanceClockCapture.id,deviceId:attendanceClockCapture.deviceId}).from(attendancePunch).innerJoin(attendanceClockCapture,eq(attendanceClockCapture.id,attendancePunch.clockCaptureId)).where(and(eq(attendancePunch.id,p.punchId),eq(attendancePunch.employmentId,me.employmentId),eq(attendanceClockCapture.employmentId,me.employmentId))).limit(1);
    // Owner decision 2026-10-28: an accepted offline punch is not the employee's to remove; HR corrects it.
    if(!target||target.deviceId||target.punch.method==='mobile_offline'||target.punch.voidedAt)throw new Error('This active Web Clocking record is not available for removal.');
    const date=target.punch.attendanceDate;
    if(date>todayInKualaLumpur())throw new AttendanceCorrectionFutureDateError();
    // Payroll precedes attendance row locks, matching the final correction effect.
    const payroll=await lockPayrollForOwnAttendanceRemoval(tx,me.employmentId,date);
    if(payroll.some(batch=>batch.status==='closed'))throw new AttendancePayrollClosedError();
    await tx.select({id:attendance.id}).from(attendance).where(eq(attendance.id,target.punch.attendanceId)).for('update');
    await assertDayNotOwnedByCorrectionTx(tx,me.employmentId,date);
    const [pending]=await tx.select({id:attendanceCorrection.id}).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId,me.employmentId),eq(attendanceCorrection.attendanceDate,date),eq(attendanceCorrection.status,'pending'))).limit(1);
    if(pending)throw new AttendanceCorrectionPendingError();
    const rows=await punchesForCorrectionTx(tx,me.employmentId,date);
    if(clockFingerprint(rows)!==p.baseline)throw new ClockDataChangedError();
    const active=rows.filter(row=>!row.voidedAt),schedule=await clockScheduleForTx(tx,me.employmentId,date);
    const position=(time:string)=>{const m=toMinutes(time);return schedule.crossesMidnight&&schedule.start&&m<toMinutes(schedule.start)?m+1440:m;};
    const ordered=[...active].sort((a,b)=>position(a.punchAt)-position(b.punchAt)||a.createdAt.getTime()-b.createdAt.getTime()||a.id.localeCompare(b.id));
    if(!removalPreservesSequence(ordered,p.punchId))throw new Error('Removing this clocking would leave another clocking without its matching entry. Ask HR for a coordinated correction.');
    const clockChanges={version:1 as const,baseline:p.baseline,entries:active.filter(row=>row.id!==p.punchId).map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction}))};
    return insertAttendanceCorrectionRequestTx(tx,ctx,{id:p.requestId,removalPunchId:p.punchId,employmentId:me.employmentId,date,clockChanges,checkIn:null,checkOut:null,requestedOtMinutes:null,reason,plannedStartTime:null,plannedEndTime:null,otReasonCategory:null,remark:null,requestKind:'other'});
  });
}

/** Same dated Schedule owner without any original/replacement holiday overlay. The replacement-only
 * seam reports historical policy fallback as Unknown when the dated entity differs from today's company;
 * it never borrows the new employer's weekdays or changes ordinary Attendance resolution. */
export async function rawScheduleDayFactsTx(tx:Tx,employmentId:string,from:string,to:string){
 const memo=await newScheduleMemo(tx,{employmentIds:[employmentId],from,to});memo.originalSchedule=true;
 const dates:string[]=[];for(let date=from;date<=to;date=addDays(date,1))dates.push(date);
 const [employee]=await tx.select({companyId:employment.companyId}).from(employment).where(eq(employment.id,employmentId)).limit(1);
 const companies=await provenCompanyDatesTx(tx,dates.map(date=>({employmentId,date})));
 const out=new Map<string,{kind:'full'|'half'|'off'|'rest'|'unknown';reason:'historical_schedule_policy_unknown'|null}>();
 for(const date of dates){
  const schedule=await scheduleFor(tx,employmentId,date,memo),company=companies.get(`${employmentId}|${date}`);
  const missingPolicy=schedule.source==='policy'&&company?.companyId&&company.companyId!==employee?.companyId;
  // Off days use the workday money rules in Attendance, but remain ineligible replacement dates.
  const kind=missingPolicy?'unknown':schedule.dayType==='rest_day'?(schedule.scheduleDayKind==='off'?'off':'rest'):schedule.dayType==='workday'?(schedule.scheduleDayKind==='off'?'off':schedule.scheduleDayKind==='half'?'half':'full'):'unknown';
  out.set(date,{kind,reason:missingPolicy?'historical_schedule_policy_unknown':null});
 }
 return out;
}
export async function rawScheduleDaysTx(tx:Tx,employmentId:string,from:string,to:string){
 return new Map([...(await rawScheduleDayFactsTx(tx,employmentId,from,to))].map(([date,fact])=>[date,fact.kind]));
}


export function pendingAttendanceTaskMetadata(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
  return withTenant(ctx,async tx=>{
    await assertAssignedWorkPrincipalTx(tx,ctx);
    const rows=await tx.select({id:attendanceCorrection.id,employmentId:attendanceCorrection.employmentId,
      personId:sql<string>`subject.person_id`,employee:sql<string|null>`subject.employee`,createdAt:attendanceCorrection.createdAt})
      .from(attendanceCorrection)
      .innerJoin(sql`LATERAL app.attendance_application_subject(${attendanceCorrection.id}) AS subject`,sql`true`)
      .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.status,'pending'),
        sql`NOT app.is_self_person(subject.person_id)`,companyIds===undefined?undefined:companyIds.length===0?sql`false`:
          sql`(subject.company_id IN (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) OR app.attendance_workflow_v3_decision_slot(${attendanceCorrection.id}) IS NOT NULL)`))
      .orderBy(desc(attendanceCorrection.createdAt),attendanceCorrection.id);
    const result:AssignedApprovalMetadata[]=[];
    for(const row of rows){
      try{await assertCanDecideAttendanceApplicationTx(tx,ctx,row.id,row.employmentId);result.push(row);}
      catch(error){
        if(error instanceof AttendanceWorkflowError&&error.code==='notApprover')continue;
        if(isApprovalDecisionRefusal(error,'attendance application'))continue;
        throw error;
      }
    }
    return result;
  });
}

/** Native monthly measurement, reduced to local distinct-person membership. No raw measurement override. */
export async function attendanceAnalysisSourceTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],month:string){
 if(!companyIds.length)throw Error('Attendance analysis requires a company scope.');
 const summary=await attendanceMonthSummary(ctx,{month,companyIds:[...companyIds]},tx);
 const ids=summary.map(row=>row.employmentId);
 const people=ids.length?await tx.select({id:employment.id,personId:employment.personId}).from(employment)
  .where(and(inArray(employment.id,ids),inArray(employment.companyId,[...companyIds]))):[];
 const byId=new Map(people.map(row=>[row.id,row.personId]));
 return {selection:month,rows:summary.map(row=>{const personId=byId.get(row.employmentId);if(!personId)throw Error('Incomplete attendance population.');
  return {personId,conditions:{lateness_prevalence:row.late>0,absence_prevalence:row.absent>0}};})};
}
