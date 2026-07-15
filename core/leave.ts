/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { assertCanDecide } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { isAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
import { resolveApprovalChain } from './leave-approval-policy';
import { consumeReplacementLeaveTx } from './toil';
import {
  holidayDatesFor,
  effectiveHolidayState,
  warnIfHolidaysIncomplete,
  yearsSpanned,
  type HolidayCompletenessWarning,
} from './holidays';
import { isoWeekday } from './attendance';
import { packFor } from '../localization/registry';
import {
  applyMaxBalance,
  bandDaysFor,
  bandFor,
  bandCarryExpiry,
  bandCarryMax,
  bandMaxBalance,
  carryEnabled,
  hasAnyCarryExpiry,
  isValidMonthDay,
  isWellFormedBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  previewEntitlement,
  resolveGradePolicy,
  resolveEffectiveSchemeId,
  schemeBandDays,
  type AccrualConfig,
  type BenefitSchemeRow,
  type CarryExpiry,
  type GradePolicyRow,
  type PreviewResult,
  type ResolvedPolicy,
  type SchemeMatchSubject,
  type ServiceBand,
} from './leave-compute';
// Re-export the pure module's surface so every existing caller/test keeps importing these from '@/core/leave'.
export {
  applyMaxBalance,
  bandDaysFor,
  bandFor,
  bandCarryExpiry,
  bandCarryMax,
  bandMaxBalance,
  carryEnabled,
  hasAnyCarryExpiry,
  isValidMonthDay,
  isWellFormedBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  previewEntitlement,
  resolveGradePolicy,
  resolveEffectiveSchemeId,
  schemeBandDays,
  type AccrualConfig,
  type BenefitSchemeRow,
  type CarryExpiry,
  type GradePolicyRow,
  type PreviewResult,
  type ResolvedPolicy,
  type SchemeMatchSubject,
  type ServiceBand,
};
import {
  assignment,
  attendancePolicy,
  benefitScheme,
  businessUnit,
  company,
  department,
  employment,
  gradeGroupMember,
  jobGrade,
  schemeLeaveEntitlement,
  leaveApprovalStep,
  leaveCancellationRequest,
  leaveEncashmentSnapshot,
  leaveLedger,
  leavePolicy,
  leaveRequest,
  leaveRequestAttachment,
  leaveRequestDate,
  leaveType,
  leaveYearConfig,
  payrollBatch,
  payslip,
  person,
  reportingLine,
  schemeLeaveCombinedLimit,
  schemeLeaveCombinedLimitMember,
} from '../db/schema';

/** ADR-0069: the set of "employmentId|leaveTypeId" keys with an ACTIVE frozen encashment snapshot, for the
 *  year-boundary sweeps (openLeaveYear, accrueEarnedLeave, expireCarriedLeave, grantAdHocLeave) to skip —
 *  the DB trigger would reject the write anyway; skipping here avoids aborting the whole batch on one
 *  frozen employee. Read-only, no events.append (CLAUDE.md skip rule). */
async function frozenSnapshotKeySet(tx: Tx, empIds: string[], typeIds: string[]): Promise<Set<string>> {
  if (empIds.length === 0 || typeIds.length === 0) return new Set();
  const rows = await tx
    .select({ employmentId: leaveEncashmentSnapshot.employmentId, leaveTypeId: leaveEncashmentSnapshot.leaveTypeId })
    .from(leaveEncashmentSnapshot)
    .where(
      and(
        inArray(leaveEncashmentSnapshot.employmentId, empIds),
        inArray(leaveEncashmentSnapshot.leaveTypeId, typeIds),
        eq(leaveEncashmentSnapshot.status, 'frozen'),
      ),
    );
  return new Set(rows.map((r) => `${r.employmentId}|${r.leaveTypeId}`));
}

/** The engine default working-day roster (ISO weekday 1=Mon … 7=Sun) — Mon–Fri. Mirrors core/attendance.ts
 *  DEFAULTS.workingDays so leave classifies rest days the same way attendance does (audit H#3). */
const DEFAULT_WORKING_DAYS_ISO = [1, 2, 3, 4, 5];

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
  }
}

// Configurable Negative Leave Balance Validation (0ef0defd): the SUBMIT/EDIT-time balance guard — thrown by
// requestLeave + editLeaveRequest when the leave type has allow_negative_balance=false and the requested days
// exceed the employee's available balance (ledger sum MINUS other pending requests of the same type). Distinct
// from InsufficientLeaveBalanceError (the pre-existing APPROVAL-time guard) so the two surfaces localize to
// their own messages; this one maps to the reporter's requested wording (leave.errors.insufficientBalance).
export class InsufficientLeaveBalanceOnSubmitError extends Error {
  constructor() {
    super('Insufficient leave balance for this application');
    this.name = 'InsufficientLeaveBalanceOnSubmitError';
  }
}

// Combined Leave Type Limit (R44 4c48fd1f, Stage 2): the requested leave type belongs to a benefit-scheme
// combined-limit pool (e.g. "Compassionate + Marriage + Paternity = 5 days/year") and this application would
// push the employee's per-cycle usage ACROSS ALL pooled types over the shared total. Carries the pool name +
// total for a readable, re-localizable error. Fires for admins too — it's a data cap, like the balance gate.
export class CombinedLeaveLimitExceededError extends Error {
  readonly poolName: string;
  readonly totalLimitDays: number;
  constructor(poolName: string, totalLimitDays: number) {
    super(`Combined leave limit "${poolName}" (${totalLimitDays} days) would be exceeded`);
    this.name = 'CombinedLeaveLimitExceededError';
    this.poolName = poolName;
    this.totalLimitDays = totalLimitDays;
  }
}

// Leave Year Configuration (9aa894a4): a non-HR employee tried to apply for a FUTURE leave year that has not
// yet been opened for applications — either there is no managed leave_year_config row for that year, its
// status is not 'open', or today is before its employeeApplicationStartDate. Carries `year` so the action
// layer can re-localize via getTranslations('leave.errors') before redirecting with ?error=. HR admins
// (isAdmin) bypass this in requestLeave (the override path, stamped for audit), so it only throws for
// ordinary employees. Models InsufficientLeaveBalanceError (a plain typed leave rejection).
export class LeaveYearNotOpenError extends Error {
  readonly year: number;
  constructor(year: number) {
    super(`Leave year ${year} is not yet open for applications.`);
    this.name = 'LeaveYearNotOpenError';
    this.year = year;
  }
}

// ── Partial Leave Approval (0131) ────────────────────────────────────────────────────────────────────
// A manager may approve some dates and reject others within one multi-day request (the request is split at
// submission into per-working-date children sharing a parent_group_id — see the per_date_approval gate in
// requestLeave). Rejecting ANY date requires a reason, so the employee knows WHY that date was declined. This
// applies uniformly to the existing decideLeave path (single-day, half, hourly, and per-date child), so a
// blank reject reason is refused BEFORE any write — nothing is persisted.
export class MissingRejectReasonError extends Error {
  constructor() {
    super('A reason is required to reject a leave request');
    this.name = 'MissingRejectReasonError';
  }
}

// ── Partial Leave Cancellation (ADR-0065) ────────────────────────────────────────────────────────────
// After a leave is approved, the employee can give back a SUBSET of the approved dates. The gates below are
// hard service-layer rejections (typed so the UI can localize and so the affordance can be hidden, not just
// throw). None of these persist anything — they run BEFORE any write.
export class LeaveCancellationNotAllowedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Leave date(s) cannot be cancelled: ${reason}` : 'Leave date(s) cannot be cancelled.');
    this.name = 'LeaveCancellationNotAllowedError';
  }
}
/** A requested cancel date is on/before "today" (tenant working-day frame) — too late to give back. */
export class LeaveCancellationTooLateError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `Leave for ${date} can no longer be cancelled (it has started or passed).` : 'Leave can no longer be cancelled.');
    this.name = 'LeaveCancellationTooLateError';
    this.date = date;
  }
}
/** A requested cancel date is outside the request span, or is not a working day inside it. */
export class LeaveCancellationDateInvalidError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `${date} is not a cancellable working day in this leave.` : 'An invalid cancellation date was supplied.');
    this.name = 'LeaveCancellationDateInvalidError';
    this.date = date;
  }
}
/** A requested cancel date falls in a payroll period whose batch is already closed — the deduction was
 *  already taken and there is no reversal path, so the finalised payslip must not be retroactively altered. */
export class LeaveCancellationPeriodClosedError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `${date} falls in a closed payroll period and can no longer be cancelled.` : 'A cancellation date falls in a closed payroll period.');
    this.name = 'LeaveCancellationPeriodClosedError';
    this.date = date;
  }
}

/** Edit-by-status self-service (item c9a19e34) — an employee tried to EDIT a leave that is not in an
 *  editable state (only a PENDING, plain single-request row is editable) or the new details fail re-validation.
 *  A distinct type from the cancellation errors so the action-layer localizer renders a clear "can't edit"
 *  message (the underlying validation errors — backdating, eligibility, etc. — keep their own typed errors). */
export class LeaveEditNotAllowedError extends Error {
  constructor(reason?: string) {
    super(reason ? `This leave cannot be edited: ${reason}` : 'This leave cannot be edited.');
    this.name = 'LeaveEditNotAllowedError';
  }
}

// ── Emergency-Leave unpaid consent (Phase-B #12, ADR-0061) ─────────────────────────────────────────
// An Emergency-Leave application whose paid balances (Annual, and Sick for illness) fall short would have
// the remainder taken as UNPAID (no-work-no-pay). That conversion is lawful only if the employee elects it,
// so requestEmergencyLeave throws this when the cascade would create an UNPAID child and unpaidConsent was
// not supplied — and persists nothing. The frontend surfaces the computed split + an acknowledgement
// checkbox so the consent is informed.
export class UnpaidConsentRequiredError extends Error {
  /** The unpaid days the employee must consent to (informational; the EL form shows the full split). */
  readonly unpaidDays?: number;
  constructor(unpaidDays?: number) {
    super(
      unpaidDays != null
        ? `This emergency leave would take ${unpaidDays} day(s) as unpaid leave. Your acknowledgement of the unpaid days is required.`
        : 'This emergency leave would take some days as unpaid leave. Your acknowledgement of the unpaid days is required.',
    );
    this.name = 'UnpaidConsentRequiredError';
    this.unpaidDays = unpaidDays;
  }
}

// Reason category for an Emergency-Leave application (Phase-B #12). 'illness' routes the cascade through the
// employee's paid SICK balance first (EA s.60F) before Annual/Unpaid; 'personal'/'other' keep Annual→Unpaid.
export type EmergencyReasonCategory = 'illness' | 'personal' | 'other';
export const EMERGENCY_REASON_CATEGORIES: readonly EmergencyReasonCategory[] = [
  'illness',
  'personal',
  'other',
] as const;
export function isEmergencyReasonCategory(v: unknown): v is EmergencyReasonCategory {
  return typeof v === 'string' && (EMERGENCY_REASON_CATEGORIES as readonly string[]).includes(v);
}

// ── Duration types (ADR-0048) ──────────────────────────────────────────────────────────────────────
// A request can be a full day, a half-day (AM or PM), or a number of hours. The deduction is full=1,
// half=0.5, hourly = round(hours / DEFAULT_STANDARD_HOURS, 2). The denominator "hours in a workday" is a
// company-wide constant (matches core/toil.ts STD_DAY_MINUTES = 480 = 8h), not a per-type column.
export type LeaveDurationType = 'full_day' | 'half_day_am' | 'half_day_pm' | 'hourly';
export const LEAVE_DURATION_TYPES: readonly LeaveDurationType[] = [
  'full_day',
  'half_day_am',
  'half_day_pm',
  'hourly',
] as const;
export const DEFAULT_STANDARD_HOURS = 8;
export function isLeaveDurationType(v: unknown): v is LeaveDurationType {
  return typeof v === 'string' && (LEAVE_DURATION_TYPES as readonly string[]).includes(v);
}

// ── Hourly-leave time window (0129) ────────────────────────────────────────────────────────────────
// For a duration_type='hourly' request the applicant picks a From/To time; the deducted `hours` is derived
// from the elapsed span, not typed by hand. Thrown when the window is malformed (missing, or to <= from).
export class HourlyLeaveTimeRangeError extends Error {
  constructor(message = 'Hourly leave requires a From time and a To time, and To must be after From') {
    super(message);
    this.name = 'HourlyLeaveTimeRangeError';
  }
}

/**
 * Elapsed hours between two HH:MM (or HH:MM:SS) times, rounded to 2 dp. Pure + DB-free + unit-testable.
 *
 * Seconds-format hazard: a Postgres `time` column reads back as 'HH:MM:SS', while an <input type="time">
 * emits 'HH:MM'. Both inputs are normalized to 'HH:MM' first (slice(0, 5)) so a stored '09:00:00' parses
 * identically to a form '09:00'. Throws HourlyLeaveTimeRangeError when either input is empty or the span is
 * <= 0. The window is ELAPSED wall time (09:00–18:00 = 9h including a lunch break), NOT a net-work figure —
 * so callers must NOT cap it at DEFAULT_STANDARD_HOURS (see the hourly branch of requestLeave).
 */
export function hoursBetween(fromTime: string, toTime: string): number {
  const toMinutes = (s: string): number => {
    const hhmm = (s ?? '').slice(0, 5);
    const [h, m] = hhmm.split(':').map((x) => Number(x));
    if (!Number.isFinite(h) || !Number.isFinite(m)) throw new HourlyLeaveTimeRangeError();
    return h * 60 + m;
  };
  if (!fromTime || !toTime) throw new HourlyLeaveTimeRangeError();
  const span = toMinutes(toTime) - toMinutes(fromTime);
  if (span <= 0) throw new HourlyLeaveTimeRangeError();
  return Math.round((span / 60) * 100) / 100;
}

export class LeaveDurationNotAllowedError extends Error {
  constructor() {
    super('This leave type does not allow the selected duration (full day / half day / hourly)');
    this.name = 'LeaveDurationNotAllowedError';
  }
}

// ── Eligibility (ADR-0038 2A-1, #25) ──────────────────────────────────────────────────────────────
// A lawful gate that mirrors what the Act restricts (maternity female-only EA s.37; paternity married-
// male ≥12mo EA s.60FA). It NEVER blocks a statutory entitlement — types with no restriction carry no
// eligibility, so everyone can request them.
// gender / maritalStatus accept EITHER a scalar (legacy rows written before multi-select, #badc5966) OR an
// array (multi-select: qualify if the employee matches ANY selected value). Reads normalize via asList() so
// no backfill/migration is needed — a pre-existing scalar row behaves exactly as before.
export type LeaveEligibility = {
  gender?: string | string[];
  maritalStatus?: string | string[];
  minServiceMonths?: number;
  // Min-service unit (#f88f0a63): the number in minServiceMonths is measured in this unit — 'months' (whole
  // completed months, the legacy behaviour) or 'days' (elapsed whole days). ABSENT ⇒ 'months', so every row
  // written before this field existed keeps its exact old meaning without a migration/backfill. Only carried
  // when a positive minServiceMonths survives cleaning (a lone unit is never stored).
  minServiceUnit?: 'months' | 'days';
  // Probation eligibility (d6bdbd55): whether the type is restricted by the employee's probation status.
  // 'confirmed_only' ⇒ only employees past probation may apply; 'probation_only' ⇒ only employees still on
  // probation may apply; ABSENT/undefined ⇒ no restriction. Stored in leave_type.probation_eligibility (its
  // own column, migration 0225) and merged into this object at the enforcement chokepoints so it rides the
  // same assertEligible / isLeaveEligible gate as the other rules.
  probation?: 'confirmed_only' | 'probation_only';
};

/** The closed set of probation eligibility values (mirrors the DB CHECK on leave_type.probation_eligibility). */
export const PROBATION_ELIGIBILITY_VALUES = ['confirmed_only', 'probation_only'] as const;
export type ProbationEligibility = (typeof PROBATION_ELIGIBILITY_VALUES)[number];

/** Elapsed service in a rule's chosen unit, from an employee's hire date to `asOf`. unit==='days' counts
 *  whole elapsed days (daysBetween); anything else — including an absent unit on a legacy row — counts whole
 *  completed months (monthsBetween). Central so assertEligible + isLeaveEligible resolve service identically. */
function servedFor(unit: LeaveEligibility['minServiceUnit'], hiredOn: string, asOf: string): number {
  return unit === 'days' ? daysBetween(hiredOn, asOf) : monthsBetween(hiredOn, asOf);
}

/** Normalize a scalar-or-array eligibility field to a de-blanked list. null/undefined → []; scalar → [scalar];
 *  array → itself (blanks dropped). Used at every chokepoint so legacy scalar rows and new array rows match
 *  identically without a data migration. */
export function asList(v: string | string[] | null | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

// ── Day Type Inclusion (feedback ef6d7146) ───────────────────────────────────────────────────────
// A per-leave-type vector of five INDEPENDENT booleans deciding whether each day type is COUNTED when
// calculating a leave's duration. It REFINES leave_type.counting: a calendar_days type already counts every
// day (the vector is moot); a working_days type today skips weekends/rest days AND public holidays, and this
// vector lets it selectively RE-INCLUDE specific day types (e.g. "skip weekends but DO count public
// holidays" — impossible before). Persisted as leave_type.day_type_inclusion JSONB.
export type DayTypeInclusion = {
  offDay: boolean;
  restDay: boolean;
  publicHoliday: boolean;
  companyHoliday: boolean;
  shutdownDay: boolean;
};
/** The closed camelCase allow-list of day-type keys (the order the admin UI renders them). */
export const DAY_TYPE_INCLUSION_KEYS = [
  'offDay',
  'restDay',
  'publicHoliday',
  'companyHoliday',
  'shutdownDay',
] as const;

/** Normalize a stored day_type_inclusion JSONB to a strict DayTypeInclusion, or `undefined` when it should
 *  be treated as INERT — i.e. take the byte-identical legacy counting path. `undefined` is returned for:
 *  a null/non-object column (every existing row), AND an all-false vector (which is exactly today's
 *  working_days behaviour, so nothing re-includes). Any non-boolean/absent key coerces to false. This is the
 *  single guard that guarantees old data + all-off config count identically to before the feature. */
export function normalizeDayTypeInclusion(v: unknown): DayTypeInclusion | undefined {
  if (v == null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const r: DayTypeInclusion = {
    offDay: o.offDay === true,
    restDay: o.restDay === true,
    publicHoliday: o.publicHoliday === true,
    companyHoliday: o.companyHoliday === true,
    shutdownDay: o.shutdownDay === true,
  };
  if (!r.offDay && !r.restDay && !r.publicHoliday && !r.companyHoliday && !r.shutdownDay) return undefined;
  return r;
}

export class LeaveIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveIneligibleError';
  }
}

// Leave Type Employee Visibility (feedback 7b11f1c1): thrown by requestLeave when the leave type has
// employee_can_apply === false and the caller is an ordinary employee. This is the SERVER-SIDE authority for
// the "can look but can't apply" switch — defense-in-depth behind the apply-dropdown filter, so the rule
// holds even if the UI is bypassed. HR admins (isAdmin) bypass it via the existing override path (like
// backdating / min-advance), so HR can still book this leave on an employee's behalf. Carries the (localized)
// leave-type name so the action layer can re-localize via getTranslations('leave.errors') before redirecting.
export class LeaveApplyNotAllowedError extends Error {
  readonly typeName?: string;
  constructor(typeName?: string) {
    super(`Employees cannot apply for ${typeName ?? 'this leave type'}. Please contact HR.`);
    this.name = 'LeaveApplyNotAllowedError';
    this.typeName = typeName;
  }
}

// Leave Type Employee Visibility (feedback 7b11f1c1): the closed set of leave-type codes that carry a
// Malaysian statutory entitlement an employee must always be able to exercise — Annual & Sick (EA 1955
// s.60E / s.60F), Hospitalization (s.60F), Maternity (s.37), Paternity (s.60FA). updateLeaveType refuses to
// set employee_can_apply=false on any of these so a well-meant configuration can never deny a lawful
// entitlement. visible_to_employee=false is NOT blocked on these (HR can still grant the leave directly), but
// closing off the ability to APPLY would breach the statutory right.
export const STATUTORY_APPLY_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY'] as const;

// ── Mandatory documents (ADR-0038 2A-2, #25) ─────────────────────────────────────────────────────
// Some leave types need a supporting document (e.g. an MC for sick leave). When leave_type.requires_
// document is set, requestLeave rejects a request that arrives without an attachment.
//
// Supporting-document config: these errors carry STRUCTURED fields (typeName, afterDays, ...) so the
// action layer can re-localize via getTranslations('leave.errors') before redirecting with ?error=.
// The English `message` stays as a fallback for tests/logs.
export class LeaveDocumentRequiredError extends Error {
  /** The (localized) leave-type name and, when the rule is conditioned on duration, the threshold. */
  readonly typeName?: string;
  readonly afterDays?: number;
  constructor(typeName?: string, afterDays?: number) {
    super(
      afterDays != null
        ? `A supporting document is required for ${typeName ?? 'this leave type'} exceeding ${afterDays} days.`
        : `A supporting document is required for ${typeName ?? 'this leave type'} (e.g. a medical certificate).`,
    );
    this.name = 'LeaveDocumentRequiredError';
    this.typeName = typeName;
    this.afterDays = afterDays;
  }
}

// Configurable backdated-leave restriction (0133): a non-HR request whose start date is older than the
// leave type's backdatingLimitDays window. Carries STRUCTURED fields (typeName, limitDays) so the action
// layer can re-localize via getTranslations('leave.errors') before redirecting with ?error=. HR admins
// (isAdmin) bypass this in requestLeave (the override path), so this only throws for ordinary employees.
export class LeaveBackdatingNotAllowedError extends Error {
  readonly typeName?: string;
  readonly limitDays: number;
  // Custom validation messages (custom-messages migration): when the leave type has an admin-authored
  // customMessages.backdatingLimitDays override, it is passed here and used VERBATIM as the Error message
  // instead of the interpolated default. The action-layer localizer (localizeLeaveError) detects a present
  // customMessage and renders it as-is — it does NOT re-localize or interpolate an admin-authored string.
  // Absent ⇒ the built-in localized default is shown (existing behaviour).
  readonly customMessage?: string;
  constructor(limitDays: number, typeName?: string, customMessage?: string) {
    super(customMessage ?? `${typeName ?? 'This leave type'} cannot be backdated more than ${limitDays} day(s).`);
    this.name = 'LeaveBackdatingNotAllowedError';
    this.typeName = typeName;
    this.limitDays = limitDays;
    this.customMessage = customMessage;
  }
}

// Minimum advance-notice rule (0159 / feedback 0b0fb6c3): a non-HR request submitted with less notice than
// the leave type's minAdvanceDays requires ("Annual Leave must be submitted at least 7 days before the leave
// start date"). Carries STRUCTURED fields (typeName, minDays) so the action layer can re-localize via
// getTranslations('leave.errors') before redirecting with ?error=. HR admins (isAdmin) bypass this in
// requestLeave (the override path, stamped for audit), so this only throws for ordinary employees. Mirrors
// LeaveBackdatingNotAllowedError above end-to-end.
export class LeaveAdvanceNoticeRequiredError extends Error {
  readonly typeName?: string;
  readonly minDays: number;
  // Custom validation messages (0147): when the leave type has an admin-authored customMessages.minAdvanceDays
  // override, it is passed here and used VERBATIM as the Error message instead of the interpolated default.
  // The action-layer localizer (localizeLeaveError) detects a present customMessage and renders it as-is —
  // it does NOT re-localize or interpolate an admin-authored string. Absent ⇒ the built-in localized default.
  readonly customMessage?: string;
  constructor(minDays: number, typeName?: string, customMessage?: string) {
    super(
      customMessage ??
        `${typeName ?? 'This leave type'} must be submitted at least ${minDays} day(s) before the leave start date.`,
    );
    this.name = 'LeaveAdvanceNoticeRequiredError';
    this.typeName = typeName;
    this.minDays = minDays;
    this.customMessage = customMessage;
  }
}

// R5 Build #3 (backdating diagnose-first): a request that resolves to zero leave days — the range is empty
// (end before start) or every day in it is a non-working day (weekend/holiday) for a working_days type. This
// fires for admins AND ordinary employees, and is a common outcome of a BACKDATED single-day request that
// happens to land on a weekend/holiday. Previously thrown as a raw English `Error`, so a non-English-locale
// user (or an HR admin filing a backdated leave for someone) saw untranslated technical text via the
// localizeLeaveError fallback. Typed here so the action layer re-localizes it into the viewer's language.
export class LeaveNoDaysInRangeError extends Error {
  constructor() {
    super('No leave days in range (end before start, or all non-working)');
    this.name = 'LeaveNoDaysInRangeError';
  }
}

// Duplicate Leave Application Restriction (feedback d5e51c34): the leave type's duplicate_application_policy
// ('restrict_same' | 'restrict_any') blocked this submission/edit because a pending/approved application
// already overlaps the requested date range. Fires for BOTH ordinary employees and HR admins (double-booking
// is a data-integrity rule, not a permission the admin overrides). Typed so the action layer re-localizes it
// into the viewer's language via localizeLeaveError; the message text matches the reporter's requested copy.
export class DuplicateLeaveApplicationError extends Error {
  constructor() {
    super(
      'A leave application already exists for the selected date. Multiple leave applications on the same date are not allowed.',
    );
    this.name = 'DuplicateLeaveApplicationError';
  }
}

// ADR-0066 festive / one-off grant: invalid input (bad days/date/leave-type) or an authority violation
// (a company-scoped admin attempting a group-wide grant, or a grant for a company they don't administer).
export class AdHocLeaveGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdHocLeaveGrantError';
  }
}

// Supporting-document config: the applicant must supply a remark when the type sets employeeRemarkRequired.
export class LeaveRemarkRequiredError extends Error {
  readonly typeName?: string;
  constructor(typeName?: string) {
    super(`An employee remark is required for ${typeName ?? 'this leave type'}.`);
    this.name = 'LeaveRemarkRequiredError';
    this.typeName = typeName;
  }
}

// Supporting-document config: file type / size validation. Thrown at the /me action boundary BEFORE
// requestLeave commits (so a bad file never leaves an orphan pending request), and again as defence-in-
// depth inside addLeaveAttachment for any other caller.
const DOC_MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
};
export class LeaveDocumentTypeError extends Error {
  readonly allowed: string[];
  constructor(allowed: string[]) {
    const labels = allowed.map((m) => DOC_MIME_LABELS[m] ?? m).join(', ');
    super(`File type not allowed — accepted: ${labels}`);
    this.name = 'LeaveDocumentTypeError';
    this.allowed = allowed;
  }
}
export class LeaveDocumentSizeError extends Error {
  readonly maxMb: number;
  constructor(maxBytes: number) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    super(`File exceeds the ${maxMb} MB limit`);
    this.name = 'LeaveDocumentSizeError';
    this.maxMb = maxMb;
  }
}

/** A type's supporting-document rule, as needed by the pure validator. */
export type LeaveDocumentRule = { allowedMimeTypes?: string[] | null; maxDocBytes?: number | null };

/**
 * Pure file-type / size gate for a leave attachment. Empty/null allowedMimeTypes ⇒ no type restriction
 * (backward-compat). maxDocBytes null ⇒ fall back to the prior 10 MB ceiling. Called at the submission
 * boundary BEFORE the request commits, and inside addLeaveAttachment as defence-in-depth.
 */
export function validateLeaveDocument(
  rule: LeaveDocumentRule,
  file: { mimeType: string; sizeBytes: number },
): void {
  const allowed = rule.allowedMimeTypes ?? [];
  if (allowed.length > 0 && !allowed.includes(file.mimeType)) {
    throw new LeaveDocumentTypeError(allowed);
  }
  const max = rule.maxDocBytes ?? 10 * 1024 * 1024;
  if (file.sizeBytes > max) throw new LeaveDocumentSizeError(max);
}

/** Whole completed months from `start` to `asOf` (both ISO yyyy-mm-dd). */
function monthsBetween(start: string, asOf: string): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = asOf.split('-').map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1; // the day-of-month hasn't come round yet
  return Math.max(0, months);
}

/** Confirmation date an employee's probation status is derived from: finalConfirmationDate (canonical — it
 *  already folds in any probation extension) falling back to confirmationDate, else null. `asOf < date` ⇒ on
 *  probation; `asOf >= date` or a null date ⇒ NOT on probation (a legacy row with no confirmation date is
 *  treated as confirmed rather than blocked from a confirmed_only type). */
type ProbationEmp = { confirmationDate?: string | null; finalConfirmationDate?: string | null };
function onProbationAsOf(emp: ProbationEmp | undefined, asOf: string): boolean {
  const confDate = emp?.finalConfirmationDate ?? emp?.confirmationDate ?? null;
  return confDate != null && asOf < confDate;
}

function assertEligible(
  elig: LeaveEligibility,
  emp:
    | { gender: string | null; marital: string | null; hiredOn: string; confirmationDate?: string | null; finalConfirmationDate?: string | null }
    | undefined,
  asOf: string,
): void {
  // Multi-select (#badc5966): qualify if the employee's attribute matches ANY selected value (OR within a
  // field, AND across fields). An empty list carries no restriction. asList() normalizes legacy scalar rows.
  const genders = asList(elig.gender);
  if (genders.length > 0 && !genders.includes(emp?.gender ?? '')) {
    throw new LeaveIneligibleError(`This leave type is available to ${genders.join(' or ')} employees only.`);
  }
  const maritals = asList(elig.maritalStatus);
  if (maritals.length > 0 && !maritals.includes(emp?.marital ?? '')) {
    throw new LeaveIneligibleError(`This leave type requires marital status “${maritals.join(' or ')}”.`);
  }
  if (elig.minServiceMonths && (!emp || servedFor(elig.minServiceUnit, emp.hiredOn, asOf) < elig.minServiceMonths)) {
    // Unit-aware message (#f88f0a63): 'days' rules read as "N days", months (incl. absent unit) as "N months".
    const unitWord = elig.minServiceUnit === 'days' ? 'days' : 'months';
    throw new LeaveIneligibleError(`This leave type requires at least ${elig.minServiceMonths} ${unitWord} of service.`);
  }
  // Probation gate (d6bdbd55): confirmed_only blocks employees still on probation; probation_only blocks
  // employees who are already confirmed. A null confirmation date ⇒ not-on-probation (see onProbationAsOf).
  if (elig.probation) {
    const onProbation = onProbationAsOf(emp, asOf);
    if (elig.probation === 'confirmed_only' && onProbation) {
      throw new LeaveIneligibleError('This leave type is available to confirmed employees only (after probation).');
    }
    if (elig.probation === 'probation_only' && !onProbation) {
      throw new LeaveIneligibleError('This leave type is available to employees on probation only.');
    }
  }
}

// ── Maternity paid-allowance eligibility (EA s.37, Phase-B #13 / ADR-0062) ────────────────────────────
// The 98-day maternity LEAVE is unconditional (the female-only gate above is the only check on the leave).
// The paid maternity ALLOWANCE is a SEPARATE entitlement that EA-1955 s.37 withholds when EITHER:
//   1. qualifying-service fails — she must have been employed at ANY time in the 4 months immediately before
//      confinement AND for a total of ≥90 days in the 9 months immediately before confinement, OR
//   2. she already has ≥5 surviving children at confinement (the 5th-child proviso).
// When withheld, the leave is still granted but UNPAID (allowance_eligible=false + a reason), which drives
// the existing leave_type.paid=false → unpaidDaysByEmployment payroll path.
export const MATERNITY_LEAVE_CODE = 'MATERNITY';
/** EA s.37: the maximum number of surviving children for which the paid allowance is still payable (the 5th+
 *  child is excluded). */
const MATERNITY_MAX_SURVIVING_CHILDREN = 5;

export type MaternityAllowanceReason = 'qualifying_service' | 'fifth_child';
export type MaternityAllowanceDecision = {
  eligible: boolean;
  reason?: MaternityAllowanceReason;
  /** Whether the s.37 qualifying-service test passed (independent of the 5th-child proviso). */
  qualifyingService: boolean;
};

/** Whole days from `start` (inclusive) to `end` (exclusive), both ISO yyyy-mm-dd. Negative if end < start. */
function daysBetween(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.round((e - s) / 86_400_000);
}

/** "Today" in the tenant's local (Asia/Kuala_Lumpur) calendar as ISO yyyy-mm-dd. Used so the backdating
 *  boundary is not UTC-skewed for a late-night request near MYT midnight (this is a Malaysia product). The
 *  action layer computes this and passes it into requestLeave; core defaults to it when a caller omits it. */
export function todayInKualaLumpur(now: Date = new Date()): string {
  // en-CA yields yyyy-mm-dd; the timeZone shifts the wall-clock date to MYT before formatting.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(now);
}

/** Configurable backdated-leave restriction (0133). True when `startDate` is backdated beyond `limitDays`
 *  from `today` (both ISO yyyy-mm-dd). limitDays null ⇒ never blocked (existing behaviour). limitDays 0 ⇒
 *  any past date is blocked (start must be today or later). daysBetween(start, today) is positive when start
 *  is before today and negative for a future date, so future dates are never blocked. Pure + `today`-
 *  injectable for deterministic tests. */
export function exceedsBackdatingLimit(startDate: string, today: string, limitDays: number | null): boolean {
  if (limitDays == null) return false;
  return daysBetween(startDate, today) > limitDays;
}

/** Minimum advance-notice rule (0159). True when `startDate` arrives with fewer than `minDays` days of
 *  notice from `today` (both ISO yyyy-mm-dd). minDays null ⇒ never blocked (existing behaviour). Exactly
 *  minDays of notice is allowed ("at least N days before"). daysBetween(today, start) is positive for a
 *  future start and NEGATIVE for a backdated one, so a backdated request always lacks notice — consistent
 *  with "must be submitted at least N days before the start date" (the separate backdating gate may fire
 *  first; both are checked before any write). minDays 0 ⇒ only past start dates lack notice (start must be
 *  today or later). Pure + `today`-injectable for deterministic tests, mirroring exceedsBackdatingLimit. */
export function lacksMinAdvanceNotice(startDate: string, today: string, minDays: number | null): boolean {
  if (minDays == null) return false;
  return daysBetween(today, startDate) < minDays;
}

/** The lifecycle status of a managed leave-year record. draft = created but balances not yet posted;
 *  open = openLeaveYear ran (balances live) and applications are permitted (subject to the app-start date);
 *  closed = an informational badge for a bygone year (v1 does not sweep on close). */
export type LeaveYearStatus = 'draft' | 'open' | 'closed';
export const LEAVE_YEAR_STATUSES: readonly LeaveYearStatus[] = ['draft', 'open', 'closed'] as const;
export function isLeaveYearStatus(v: unknown): v is LeaveYearStatus {
  return typeof v === 'string' && (LEAVE_YEAR_STATUSES as readonly string[]).includes(v);
}

/** The minimal leave-year config shape the pure gate reads (subset of LeaveYearConfigRow). */
export type LeaveYearGateConfig = {
  year: number;
  status: string;
  employeeApplicationStartDate: string | null;
};

/**
 * Leave Year Configuration (9aa894a4) — pure "may an employee apply for `targetYear`?" gate. Mirrors
 * lacksMinAdvanceNotice: pure + `today`-injectable for deterministic tests. Returns TRUE only when the
 * managed record for `targetYear` exists, is 'open', and today is on/after its employeeApplicationStartDate.
 * FALSE (not open) when: no config for the year, config for a different year, status ≠ 'open', or today is
 * before the application-start date. A null application-start date on an OPEN year means "no gate date" ⇒
 * open immediately. The caller decides WHICH years to enforce this on — requestLeave only enforces it for a
 * FUTURE leave year, so a null-config current/past year keeps today's exact behaviour (see requestLeave).
 */
export function leaveYearOpenForApplication(
  config: LeaveYearGateConfig | null | undefined,
  targetYear: number,
  today: string,
): boolean {
  if (!config) return false;
  if (config.year !== targetYear) return false;
  if (config.status !== 'open') return false;
  const appStart = config.employeeApplicationStartDate;
  if (appStart && today < appStart) return false;
  return true;
}

/** Subtract whole calendar months from an ISO date, clamping the day to the target month's length. */
function subtractMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 - months, 1));
  const ty = base.getUTCFullYear();
  const tm = base.getUTCMonth(); // 0-based
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, dim);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * EA s.37 maternity paid-ALLOWANCE eligibility. Pure (no DB), unit-testable. Returns the decision the
 * service applies as a per-request OVERRIDE of the maternity leave-type paid default:
 *   - qualifying service met AND survivingChildren < 5 → { eligible: true }
 *   - qualifying service FAILS                          → { eligible: false, reason: 'qualifying_service' }
 *   - qualifying met but survivingChildren ≥ 5          → { eligible: false, reason: 'fifth_child' }
 * Qualifying-service precedence: when BOTH fail, 'qualifying_service' is reported (it is the threshold check).
 * Qualifying service = employed at any time in the 4 months immediately before confinement AND for ≥90 days
 * in the 9 months immediately before confinement (computed from hiredOn vs the confinement date).
 */
export function maternityAllowanceEligibility(
  hiredOn: string,
  confinementDate: string,
  survivingChildren: number,
): MaternityAllowanceDecision {
  // Employed at any time in the 4 months immediately before confinement: the employment [hiredOn, …)
  // overlaps the window [conf−4mo, conf) iff she was hired strictly before confinement (hiredOn ≥ conf would
  // mean she was not yet employed at confinement at all).
  const employedInFourMonthWindow = hiredOn < confinementDate;
  // ≥90 days in the 9 months immediately before confinement: days employed inside [conf−9mo, conf).
  const nineMonthsBefore = subtractMonths(confinementDate, 9);
  const windowStart = hiredOn > nineMonthsBefore ? hiredOn : nineMonthsBefore;
  const daysInNineMonthWindow = Math.max(0, daysBetween(windowStart, confinementDate));
  const qualifyingService = employedInFourMonthWindow && daysInNineMonthWindow >= 90;

  if (!qualifyingService) {
    return { eligible: false, reason: 'qualifying_service', qualifyingService: false };
  }
  if (survivingChildren >= MATERNITY_MAX_SURVIVING_CHILDREN) {
    return { eligible: false, reason: 'fifth_child', qualifyingService: true };
  }
  return { eligible: true, qualifyingService: true };
}

/** Boolean form of the eligibility gate (assertEligible throws; this just answers). Used by reads to
 *  show an employee only the leave types they could actually take (2F-1 / R18). */
export function isLeaveEligible(
  elig: LeaveEligibility | null | undefined,
  emp:
    | { gender: string | null; marital: string | null; hiredOn: string; confirmationDate?: string | null; finalConfirmationDate?: string | null }
    | undefined,
  asOf: string,
): boolean {
  if (!elig) return true;
  const genders = asList(elig.gender);
  if (genders.length > 0 && !genders.includes(emp?.gender ?? '')) return false;
  const maritals = asList(elig.maritalStatus);
  if (maritals.length > 0 && !maritals.includes(emp?.marital ?? '')) return false;
  if (elig.minServiceMonths && (!emp || servedFor(elig.minServiceUnit, emp.hiredOn, asOf) < elig.minServiceMonths))
    return false;
  // Probation gate (d6bdbd55) — mirrors assertEligible so reads hide a type the employee can't take.
  if (elig.probation) {
    const onProbation = onProbationAsOf(emp, asOf);
    if (elig.probation === 'confirmed_only' && onProbation) return false;
    if (elig.probation === 'probation_only' && !onProbation) return false;
  }
  return true;
}

export async function leaveBalance(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
}

// Configurable Negative Leave Balance Validation (0ef0defd): the "available" balance for the SUBMIT/EDIT-time
// guard = leaveBalance (approved ledger only) MINUS the sum of this employee's OTHER PENDING requests of the
// same leave type (days already reserved but not yet approved, so they post no ledger entry). Subtracting the
// pending reservation stops an employee stacking several pending applications that individually pass but
// collectively overshoot. `excludeRequestId` drops the request being edited from its own pending sum (the edit
// path re-checks the NEW days against everything else). Rounded to 2dp to match the rest of the leave math.
export async function availableLeaveBalance(
  tx: Tx,
  employmentId: string,
  leaveTypeId: string,
  excludeRequestId?: string,
): Promise<number> {
  const bal = await leaveBalance(tx, employmentId, leaveTypeId);
  const [row] = await tx
    .select({ pending: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, employmentId),
        eq(leaveRequest.leaveTypeId, leaveTypeId),
        eq(leaveRequest.status, 'pending'),
        ...(excludeRequestId ? [sql`${leaveRequest.id} <> ${excludeRequestId}`] : []),
      ),
    );
  return round2(bal - Number(row?.pending ?? 0));
}

// ── Combined Leave Type Limit enforcement (R44 4c48fd1f, Stage 2) ───────────────────────────────────
/** Resolve ONE employment's effective benefit scheme id (override → auto-match → none), reusing the pure
 *  resolver. Read-only. Returns null when no active scheme matches (⇒ no combined-limit pools apply). */
async function resolveSchemeIdForEmployment(tx: Tx, employmentId: string): Promise<string | null> {
  const [emp] = await tx
    .select({ companyId: employment.companyId, gradeId: employment.gradeId, overrideSchemeId: employment.benefitSchemeId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  const schemes = await tx
    .select({
      id: benefitScheme.id,
      companyId: benefitScheme.companyId,
      employmentType: benefitScheme.employmentType,
      gradeGroupId: benefitScheme.gradeGroupId,
      status: benefitScheme.status,
    })
    .from(benefitScheme);
  if (schemes.length === 0) return null;
  const [assign] = await tx
    .select({ employmentType: assignment.employmentType })
    .from(assignment)
    .where(and(eq(assignment.employmentId, employmentId), isNull(assignment.validTo), isNull(assignment.supersededAt)))
    .limit(1);
  let gradeGroupId: string | null = null;
  if (emp.gradeId) {
    const [gm] = await tx
      .select({ gradeGroupId: gradeGroupMember.gradeGroupId })
      .from(gradeGroupMember)
      .where(eq(gradeGroupMember.gradeId, emp.gradeId))
      .limit(1);
    gradeGroupId = gm?.gradeGroupId ?? null;
  }
  return resolveEffectiveSchemeId(
    schemes.map((s) => ({
      id: s.id,
      companyId: s.companyId,
      employmentType: s.employmentType,
      gradeGroupId: s.gradeGroupId,
      status: s.status,
    })),
    {
      companyId: emp.companyId,
      employmentType: assign?.employmentType ?? null,
      gradeGroupId,
      overrideSchemeId: emp.overrideSchemeId ?? null,
    },
  );
}

/** Combined-limit guard: if the requested leave type belongs to a pool in the employee's effective scheme,
 *  sum the employee's per-cycle usage ACROSS ALL pooled types (pending + approved, minus the request being
 *  re-evaluated) and reject when adding `requestedDays` would breach the pool's shared total. The cycle is
 *  the calendar leave year of `startDate` (mirrors the tenant's calendar-year leave_year_config keying). A
 *  no-op when the employee has no scheme, or the type is in no pool — so tenants without pools are unchanged. */
async function enforceCombinedLeaveLimit(
  tx: Tx,
  p: { employmentId: string; leaveTypeId: string; startDate: string; requestedDays: number; excludeRequestId?: string },
): Promise<void> {
  if (p.requestedDays <= 0) return;
  const schemeId = await resolveSchemeIdForEmployment(tx, p.employmentId);
  if (!schemeId) return;
  // The pool (if any) this leave type belongs to within the effective scheme.
  const [pool] = await tx
    .select({
      id: schemeLeaveCombinedLimit.id,
      name: schemeLeaveCombinedLimit.name,
      totalLimitDays: schemeLeaveCombinedLimit.totalLimitDays,
    })
    .from(schemeLeaveCombinedLimitMember)
    .innerJoin(schemeLeaveCombinedLimit, eq(schemeLeaveCombinedLimit.id, schemeLeaveCombinedLimitMember.combinedLimitId))
    .where(
      and(
        eq(schemeLeaveCombinedLimitMember.benefitSchemeId, schemeId),
        eq(schemeLeaveCombinedLimitMember.leaveTypeId, p.leaveTypeId),
      ),
    )
    .limit(1);
  if (!pool) return;
  const total = Number(pool.totalLimitDays);
  // All member leave types of the pool.
  const members = await tx
    .select({ leaveTypeId: schemeLeaveCombinedLimitMember.leaveTypeId })
    .from(schemeLeaveCombinedLimitMember)
    .where(eq(schemeLeaveCombinedLimitMember.combinedLimitId, pool.id));
  const memberTypeIds = members.map((m) => m.leaveTypeId);
  if (memberTypeIds.length === 0) return;
  // Per-cycle usage across all member types = pending + approved requests whose start falls in the same
  // calendar year, minus the request being re-evaluated (avoids double-counting on the approval path).
  const year = p.startDate.slice(0, 4);
  const windowStart = `${year}-01-01`;
  const windowEnd = `${year}-12-31`;
  const [used] = await tx
    .select({ total: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, p.employmentId),
        inArray(leaveRequest.leaveTypeId, memberTypeIds),
        inArray(leaveRequest.status, ['pending', 'approved']),
        gte(leaveRequest.startDate, windowStart),
        lte(leaveRequest.startDate, windowEnd),
        ...(p.excludeRequestId ? [sql`${leaveRequest.id} <> ${p.excludeRequestId}`] : []),
      ),
    );
  const usedDays = Number(used?.total ?? 0);
  if (round2(usedDays + p.requestedDays) > total) {
    throw new CombinedLeaveLimitExceededError(pool.name, total);
  }
}

// ── Emergency Leave (0106) ─────────────────────────────────────────────────────────────────────────
// EL is an APPLICATION TYPE ONLY (no balance, no ledger). On submission requestLeave decomposes it into
// up to two ordinary child requests over the same dates: an ANNUAL request for the AL-covered portion and
// an UNPAID request for the remainder, linked by a shared parent_group_id. Everything downstream
// (approval chain, balance gate, ledger debit, payroll, history) reuses the existing code paths unchanged.
export const EMERGENCY_LEAVE_CODE = 'EMERGENCY';

/** Round to 2 dp (mirrors the rest of the leave math). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure AL→UPL split resolver. Given the Annual balance and the span counted in Annual's own
 * (working-days) unit, cover as much as the balance allows from Annual and take the remainder as Unpaid.
 *   alCovered   = max(0, min(alBalance, alWorkingDays))
 *   alShortfall = round2(alWorkingDays − alCovered)  (the days that fall to Unpaid)
 * No DB, unit-testable. A negative balance yields alCovered 0 (everything to Unpaid).
 */
export function resolveEmergencyCascade(
  alBalance: number,
  alWorkingDays: number,
): { alCovered: number; alShortfall: number } {
  const alCovered = round2(Math.max(0, Math.min(alBalance, alWorkingDays)));
  const alShortfall = round2(alWorkingDays - alCovered);
  return { alCovered, alShortfall };
}

/**
 * Pure SICK→ANNUAL→UPL cascade for an illness-driven emergency (Phase-B #12, ADR-0061). Cover as much of
 * the working-days span as the paid SICK balance allows FIRST (EA s.60F is paid), then Annual, then the
 * remainder as Unpaid. `sickCovered` + `alCovered` + `alShortfall` always sum to the span (within 2 dp).
 * Negative balances clamp to 0. No DB — unit-testable. When sickBalance ≤ 0 this degrades to exactly the
 * AL→UPL split (sickCovered 0), so the non-illness path can reuse the same shape.
 */
export function resolveEmergencyIllnessCascade(
  sickBalance: number,
  alBalance: number,
  workingDays: number,
): { sickCovered: number; alCovered: number; alShortfall: number } {
  const sickCovered = round2(Math.max(0, Math.min(sickBalance, workingDays)));
  const afterSick = round2(workingDays - sickCovered);
  const alCovered = round2(Math.max(0, Math.min(alBalance, afterSick)));
  const alShortfall = round2(afterSick - alCovered);
  return { sickCovered, alCovered, alShortfall };
}

/** Inclusive whole-day count between two ISO dates (Slice 0 — no public-holiday logic yet). */
function dayCount(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((e - s) / 86_400_000) + 1;
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** True when `date` is a working day (Full OR Half) for the given ISO working-day roster (1=Mon … 7=Sun) and
 *  is not a holiday. Resolves rest days from the SAME source the attendance engine uses (audit H#3), never a
 *  hardcoded Sat/Sun. List/membership semantics only — for the DEDUCTED AMOUNT on a date use dayWeight. */
function isWorkingDay(date: string, workingDaysIso: number[], holidays: Set<string>): boolean {
  return workingDaysIso.includes(isoWeekday(date)) && !holidays.has(date);
}

/** Working days in [start, end]: counts only days on the employee's configured working-day roster (ISO
 *  weekdays, default Mon–Fri, Full ∪ Half) that are not holidays. List/membership semantics — for the
 *  WEIGHTED (fractional half-day) total use workingDaysWeighted. */
function workingDays(start: string, end: string, holidays: Set<string>, workingDaysIso: number[]): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    if (isWorkingDay(d, workingDaysIso, holidays)) n++;
  }
  return n;
}

/** The company's configured working-day roster for an employment (ISO weekday array, 1=Mon … 7=Sun),
 *  resolved from attendance_policy.workingDays — the SAME source core/attendance.ts uses. Falls back to the
 *  Mon–Fri default when no policy row exists, so existing single-company behaviour is unchanged (audit H#3).
 *  Kept as a thin wrapper over resolveSchedule for callers that only need list/membership semantics
 *  (Full ∪ Half, no weighting). */
async function resolveWorkingDaysIso(tx: Tx, employmentId: string): Promise<number[]> {
  const sched = await resolveSchedule(tx, employmentId);
  return [...new Set([...sched.workingDaysIso, ...sched.halfDaysIso])];
}

/** Feedback 31474452 (4a): one query resolving an employment's full schedule — the company's configured
 *  Full working days, Half working days, and the company's half-day-deduction toggle. Falls back to
 *  Mon-Fri / no-half-days / toggle-off so existing single-company behaviour is byte-identical when no policy
 *  row or half-day marker exists (D2/back-compat). */
async function resolveSchedule(
  tx: Tx,
  employmentId: string,
): Promise<{ workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean }> {
  const [row] = await tx
    .select({
      workingDays: attendancePolicy.workingDays,
      halfWorkingDays: attendancePolicy.halfWorkingDays,
      halfCountsFull: company.leaveHalfDayFullDeduction,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    workingDaysIso: row?.workingDays ?? DEFAULT_WORKING_DAYS_ISO,
    halfDaysIso: row?.halfWorkingDays ?? [],
    halfCountsFull: row?.halfCountsFull ?? false,
  };
}

/** Feedback 31474452 (4b): the leave-deduction WEIGHT of a single date — 0 for a holiday or a date on
 *  neither roster (rest day), 1 for a Full working day, and either 1.0 (toggle ON) or 0.5 (toggle OFF, the
 *  default) for a Half working day. No rounding — weights are exactly 0 / 0.5 / 1 so sums stay exact
 *  (rounding is only ever applied on the pre-existing hourly path). */
function dayWeight(
  date: string,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  holidays: Set<string>,
  // Day Type Inclusion (feedback ef6d7146): optional per-leave-type re-inclusion vector. When ABSENT
  // (undefined — every existing type / an all-off config, via normalizeDayTypeInclusion) this takes the
  // byte-identical legacy early-return path below, so nothing about today's counting changes. When present
  // it refines the working_days weighting: a public holiday counts 1 if inclusion.publicHoliday, and a
  // non-roster weekday (rest/off day) counts 1 if inclusion.restDay OR inclusion.offDay.
  inclusion?: DayTypeInclusion,
): number {
  if (inclusion === undefined) {
    // ── Legacy path (unchanged) — the golden-test guarantee. ──
    if (holidays.has(date)) return 0;
    const dowL = isoWeekday(date);
    if (sched.workingDaysIso.includes(dowL)) return 1;
    if (sched.halfDaysIso.includes(dowL)) return sched.halfCountsFull ? 1 : 0.5;
    return 0;
  }
  // ── Inclusion-aware refinement of working_days ──
  const dow = isoWeekday(date);
  if (holidays.has(date)) {
    // Phase A: every holiday is treated as a PUBLIC holiday for inclusion. companyHoliday/shutdownDay are
    // stored-but-inert (the public-vs-company scope split + the shutdown concept are Phase B), so a holiday
    // is re-included iff publicHoliday is on.
    return inclusion.publicHoliday ? 1 : 0;
  }
  if (sched.workingDaysIso.includes(dow)) return 1;
  if (sched.halfDaysIso.includes(dow)) return sched.halfCountsFull ? 1 : 0.5;
  // A non-roster weekday is a rest/off day. Phase A collapses restDay + offDay into this single bucket (the
  // statutory rest-vs-off weekday designation is Phase B), so it re-includes if EITHER toggle is on.
  return inclusion.restDay || inclusion.offDay ? 1 : 0;
}

/** True when `date` carries a non-zero leave DEDUCTION weight for the given schedule/holiday set and optional
 *  inclusion vector — i.e. it is a day this leave type actually deducts. When `inclusion` is undefined this is
 *  BYTE-IDENTICAL to isWorkingDay (a Full day weighs 1, a Half day 0.5 — both > 0 — and a holiday/rest day 0),
 *  so the membership set is unchanged for every existing type. With an inclusion vector it additionally admits
 *  re-included public-holiday / rest-day dates, keeping the cancellable/per-date set in agreement with the
 *  weighted total (workingDaysWeighted) so submission, per-date, preview and cancellation never drift. */
function isDeductibleDay(
  date: string,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  holidays: Set<string>,
  inclusion?: DayTypeInclusion,
): boolean {
  return dayWeight(date, sched, holidays, inclusion) > 0;
}

/** Feedback 31474452 (4c): the WEIGHTED sum of dayWeight over [start, end] — the real deducted-days total for
 *  a working_days-counted span, honouring Half-day markers + the company toggle. Degrades to workingDays()
 *  exactly when there are no half-day markers (empty halfDaysIso ⇒ every date weighs 0 or 1). */
function workingDaysWeighted(
  start: string,
  end: string,
  holidays: Set<string>,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  // Day Type Inclusion (feedback ef6d7146): threaded straight into dayWeight — undefined ⇒ byte-identical.
  inclusion?: DayTypeInclusion,
): number {
  let total = 0;
  for (const d of eachDate(start, end)) total += dayWeight(d, sched, holidays, inclusion);
  return round2(total);
}

/** The set of holiday dates in [start, end] for an employment, resolved business-group → state →
 *  national (ADR-0055; org-based override over ADR-0038 2C). Delegates to the unified resolver so leave
 *  and the Emergency-Leave path count a working-days span the same way attendance will. */
async function resolveHolidaySet(
  tx: Tx,
  employmentId: string,
  start: string,
  end: string,
): Promise<Set<string>> {
  return holidayDatesFor(tx, { employmentId, startDate: start, endDate: end });
}

/**
 * Shared insert+event+approval-step body for a single leave_request. Both the ordinary requestLeave path
 * and the Emergency-Leave children funnel through here so the event/approval-step wiring is never
 * duplicated. The caller has already computed `days` in the type's own counting mode and run every gate.
 */
async function insertLeaveRequest(
  tx: Tx,
  ctx: SessionContext,
  v: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    days: number;
    durationType: LeaveDurationType;
    hours: number | null;
    // Hourly-leave time window (0129): the From/To window for an hourly request (HH:MM). Optional — null for
    // full_day / half_day rows and for the Emergency-Leave children (which are always full-day).
    fromTime?: string | null;
    toTime?: string | null;
    reason: string | null;
    employeeRemark: string | null;
    parentGroupId: string | null;
    mandatoryAfterDays: number | null;
    // Phase-B #12 (ADR-0061): set on the UNPAID child of a consented Emergency-Leave submission only.
    unpaidConsentAt?: Date | null;
    unpaidConsentBy?: string | null;
    // Phase-B #13 (ADR-0062): EA s.37 maternity paid-allowance facts + per-request override. Non-null only
    // for a MATERNITY request; maternityAllowanceEvent carries the decision onto the submitted event.
    survivingChildren?: number | null;
    confinementDate?: string | null;
    allowanceEligible?: boolean | null;
    maternityAllowanceEvent?: Record<string, unknown> | null;
    // Configurable backdated-leave restriction (0133): set only when an HR admin SUCCESSFULLY overrode the
    // limit (the request is backdated beyond the type's window but isAdmin let it through). Stamps the
    // override onto the submitted event payload for the audit trail (CLAUDE.md substrate discipline: an admin
    // bypassing a configured control must be captured). null/absent ⇒ normal in-window request; payload
    // unchanged so existing assertions stay green.
    backdatingAudit?: { daysBackdated: number; backdatingLimitDays: number | null } | null;
    // Minimum advance-notice rule (0159): set only when an HR admin SUCCESSFULLY overrode the rule (the
    // request lacks the type's required notice but isAdmin let it through). Stamps the override onto the
    // submitted event payload for the audit trail (CLAUDE.md substrate discipline: an admin bypassing a
    // configured control must be captured). null/absent ⇒ normal in-notice request; payload unchanged so
    // existing assertions stay green. Mirrors backdatingAudit above.
    minAdvanceAudit?: { daysInAdvance: number; minAdvanceDays: number | null } | null;
    // Leave Year Configuration (9aa894a4): set only when an HR admin SUCCESSFULLY overrode the not-yet-open
    // gate (the request is for a future leave year that is not open, but isAdmin let it through). Stamps the
    // override onto the submitted event payload for the audit trail. null/absent ⇒ normal request; payload
    // unchanged. Mirrors backdatingAudit / minAdvanceAudit above.
    leaveYearAudit?: { targetYear: number } | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(leaveRequest)
    .values({
      tenantId: ctx.tenantId,
      employmentId: v.employmentId,
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      days: v.days.toFixed(2),
      durationType: v.durationType,
      hours: v.hours != null ? v.hours.toFixed(2) : null,
      // Hourly-leave time window (0129): persisted only for hourly rows; null otherwise.
      fromTime: v.fromTime ?? null,
      toTime: v.toTime ?? null,
      status: 'pending',
      reason: v.reason,
      employeeRemark: v.employeeRemark,
      parentGroupId: v.parentGroupId,
      unpaidConsentAt: v.unpaidConsentAt ?? null,
      unpaidConsentBy: v.unpaidConsentBy ?? null,
      survivingChildren: v.survivingChildren ?? null,
      confinementDate: v.confinementDate ?? null,
      allowanceEligible: v.allowanceEligible ?? null,
    })
    .returning({ id: leaveRequest.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: row.id,
    eventType: 'leave-request.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: v.employmentId,
    payload: {
      employmentId: v.employmentId,
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      days: v.days,
      durationType: v.durationType,
      hours: v.hours,
      // Hourly-leave time window (0129): carry the From/To window onto the submitted event for the audit
      // trail / approver view. Present only for hourly rows. The decision (approve/reject) event deliberately
      // does NOT re-stamp the window — it is immutable on the row and queryable, so re-stamping is redundant.
      ...(v.fromTime ? { fromTime: v.fromTime } : {}),
      ...(v.toTime ? { toTime: v.toTime } : {}),
      mandatoryAfterDays: v.mandatoryAfterDays,
      hasRemark: !!v.employeeRemark,
      ...(v.parentGroupId ? { parentGroupId: v.parentGroupId } : {}),
      // Phase-B #13 (ADR-0062): the s.37 paid-allowance decision for the audit trail / approver view.
      ...(v.maternityAllowanceEvent ? { maternityAllowance: v.maternityAllowanceEvent } : {}),
      // Configurable backdated-leave restriction (0133): when an HR admin overrode the type's backdating
      // limit, stamp it so an auditor can see this was a backdated override (vs an in-window request). Only
      // present on the override path — the normal-path payload is byte-identical to before.
      ...(v.backdatingAudit
        ? {
            backdatedOverride: true,
            daysBackdated: v.backdatingAudit.daysBackdated,
            backdatingLimitDays: v.backdatingAudit.backdatingLimitDays,
          }
        : {}),
      // Minimum advance-notice rule (0159): when an HR admin overrode the type's required notice, stamp it so
      // an auditor can see this was a short-notice override (vs an in-notice request). Only present on the
      // override path — the normal-path payload is byte-identical to before. Mirrors backdatedOverride above.
      ...(v.minAdvanceAudit
        ? {
            advanceNoticeOverride: true,
            daysInAdvance: v.minAdvanceAudit.daysInAdvance,
            minAdvanceDays: v.minAdvanceAudit.minAdvanceDays,
          }
        : {}),
      // Leave Year Configuration (9aa894a4): when an HR admin applied for a future leave year that is not yet
      // open, stamp it so an auditor sees this was an override (vs a normal in-window request). Only present
      // on the override path — the normal-path payload is byte-identical to before.
      ...(v.leaveYearAudit
        ? { leaveYearNotOpenOverride: true, targetLeaveYear: v.leaveYearAudit.targetYear }
        : {}),
    },
  });
  // 2B-1/2B-2/ADR-0071: if the company runs a multi-step chain, generate the instance approval steps,
  // resolving the scoped rule matrix against this request's day count (fractional for hourly/partial).
  await generateApprovalSteps(tx, ctx.tenantId, row.id, v.employmentId, v.leaveTypeId, v.days);
  return { id: row.id };
}

/** requestLeave's result. `leaveRequestId` is the created request (the AL child, else the UPL child, for
 *  an EL submission). `parentGroupId` is non-null only for an Emergency-Leave submission; `children` lists
 *  every created request (one for an ordinary request; one or two for EL). */
export type RequestLeaveResult = {
  leaveRequestId: string;
  days: number;
  parentGroupId: string | null;
  children: { id: string; code: string; days: number }[];
  // Phase-B #13 (ADR-0062): set true when a MATERNITY request was submitted WITHOUT the s.37 inputs
  // (surviving-children + confinement date), so the allowance eligibility could not be confirmed. The leave
  // is still granted PAID (the conservative default), but HR is warned the paid-allowance is unconfirmed.
  maternityAllowanceWarning?: boolean;
  // Phase-B #15: NON-BLOCKING holiday-completeness warning(s) — present when the request's (state, year)
  // has fewer than the EA s.60D minimum of 11 gazetted holidays loaded, so the working-day count may be
  // wrong until HR finishes loading the state gazette. The request is still created.
  holidayWarnings?: HolidayCompletenessWarning[];
};

export async function requestLeave(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    hasDocument?: boolean; // 2A-2: asserts a supporting document accompanies this request
    employeeRemark?: string; // doc-config: required when the type sets employeeRemarkRequired
    durationType?: LeaveDurationType; // ADR-0048: defaults to 'full_day'
    hours?: number; // ADR-0048: legacy/importer hourly figure — used only when fromTime/toTime are absent
    // Hourly-leave time window (0129): when durationType==='hourly' these are MANDATORY; `hours` is derived
    // from (toTime - fromTime). The raw `hours` path above is the back-compat fallback for importer/legacy
    // callers that don't supply a window.
    fromTime?: string;
    toTime?: string;
    // Phase-B #12 (ADR-0061) — Emergency-Leave only:
    reasonCategory?: EmergencyReasonCategory; // 'illness' routes through paid SICK first
    unpaidConsent?: boolean; // the employee's acknowledgement of the unpaid days (gates UNPAID children)
    // Phase-B #13 (ADR-0062) — MATERNITY only: the s.37 paid-allowance facts at confinement. When both are
    // supplied the per-request allowance eligibility is computed and OVERRIDES the leave-type paid default
    // (withheld ⇒ leave granted UNPAID). When absent the leave stays paid + a maternityAllowanceWarning fires.
    survivingChildren?: number;
    confinementDate?: string;
    // Configurable backdated-leave restriction (0133): the tenant-local "today" (ISO yyyy-mm-dd) against
    // which the backdating window is judged. The action layer computes it in Asia/Kuala_Lumpur and passes it
    // in; core defaults to todayInKualaLumpur() so importer/legacy callers still work.
    today?: string;
  },
): Promise<RequestLeaveResult> {
  return withTenant(ctx, async (tx) => {
    // Day count depends on the leave type: working-days (excl weekends + holidays) vs calendar.
    const [lt] = await tx
      .select({
        code: leaveType.code,
        name: leaveType.name,
        counting: leaveType.counting,
        eligibility: leaveType.eligibility,
        // Probation eligibility (d6bdbd55): merged into the eligibility object below so the probation gate
        // rides the same assertEligible check as gender/marital/min-service.
        probationEligibility: leaveType.probationEligibility,
        // Day Type Inclusion (feedback ef6d7146): the re-inclusion vector — threaded into the working_days
        // counting below so the deducted `days` honours which day types this type counts.
        dayTypeInclusion: leaveType.dayTypeInclusion,
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        durations: leaveType.durations,
        perDateApproval: leaveType.perDateApproval,
        backdatingLimitDays: leaveType.backdatingLimitDays,
        // Minimum advance-notice rule (0159): required days of notice before the start date.
        minAdvanceDays: leaveType.minAdvanceDays,
        // Custom validation messages (custom-messages migration): the admin-authored override map, keyed by
        // rule config field. Passed through the typed error so the localizer shows it verbatim.
        customMessages: leaveType.customMessages,
        // Leave Type Employee Visibility (7b11f1c1): the can-apply switch. false ⇒ an ordinary employee may
        // not apply for this type (rejected below); NULL ⇒ can apply (today's behaviour). isAdmin bypasses.
        employeeCanApply: leaveType.employeeCanApply,
        // Duplicate Leave Application Restriction (d5e51c34): the same-date double-booking policy, enforced
        // below AFTER the AM/PM slot-clash guard. null ⇒ 'allow' (no extra check).
        duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
        // Configurable Negative Leave Balance Validation (0ef0defd): false ⇒ reject a submit that would take
        // the balance negative (enforced below, after `days` is known); true ⇒ skip the submit-time check.
        allowNegativeBalance: leaveType.allowNegativeBalance,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);

    // Emergency Leave (0106): an application type only — decompose into ANNUAL + UNPAID children over the
    // same dates before the normal single-request path. No EMERGENCY row is ever persisted.
    if (lt?.code === EMERGENCY_LEAVE_CODE) {
      return requestEmergencyLeave(tx, ctx, p);
    }

    // Doc-config: the mandatory-document gate moved BELOW day-counting (it now depends on `days` vs
    // mandatoryAfterDays). The eligibility gate stays here — it does not depend on `days`.

    // Eligibility gate (2A-1, #25) — fail fast before anything is created. Probation (d6bdbd55) is stored in
    // its own column; merge it into the eligibility object so the one gate covers every rule.
    const baseElig = (lt?.eligibility ?? null) as LeaveEligibility | null;
    const probation = (lt?.probationEligibility ?? null) as ProbationEligibility | null;
    const elig: LeaveEligibility | null =
      baseElig || probation ? { ...(baseElig ?? {}), ...(probation ? { probation } : {}) } : null;
    if (elig && (elig.gender || elig.maritalStatus || elig.minServiceMonths || elig.probation)) {
      const [emp] = await tx
        .select({
          gender: person.gender,
          marital: person.maritalStatus,
          hiredOn: employment.hiredOn,
          confirmationDate: employment.confirmationDate,
          finalConfirmationDate: employment.finalConfirmationDate,
        })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
    }

    // Leave Type Employee Visibility (7b11f1c1) — can-apply gate. When HR has set employee_can_apply=false,
    // an ordinary employee may not submit a request for this type ("can look but can't apply"). This is the
    // SERVER-SIDE authority behind the apply-dropdown filter (listEligibleLeaveTypesFor), so the rule holds
    // even if the UI is bypassed. HR admins (isAdmin) bypass it — like backdating / min-advance below — so HR
    // can still book this leave on the employee's behalf. NULL ⇒ can apply (backward compatible). The
    // statutory guard in updateLeaveType prevents this ever being set on a lawful-entitlement code, so this
    // gate can never block a statutory leave. Fails fast before any write, like the eligibility gate above.
    if (!isAdmin(ctx) && lt?.employeeCanApply === false) {
      throw new LeaveApplyNotAllowedError(lt?.name);
    }

    // Configurable backdated-leave restriction (0133). Non-HR users are blocked when the request's start date
    // (the earliest, most-backdated day of the request) is older than the type's window; HR admins (isAdmin)
    // bypass for exceptional cases (the override path). `today` is judged in the tenant's local (MYT) calendar
    // — supplied by the action layer, defaulting to todayInKualaLumpur() — so the boundary is not UTC-skewed.
    // It does not depend on `days`, so it fails fast like the eligibility gate. Emergency Leave already
    // returned above (it is inherently retroactive and the field is hidden for it in the admin UI).
    const today = p.today ?? todayInKualaLumpur();
    const limit = lt?.backdatingLimitDays ?? null;
    const backdatedOverride = isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, limit);
    if (!isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, limit)) {
      // Custom validation messages (custom-messages migration): pass the admin-authored override for THIS
      // rule (keyed by its config field name) through the typed error so the localizer renders it verbatim;
      // absent ⇒ the built-in localized default. A future rule follows the same look-up-then-pass-through
      // pattern (customMessages[ruleKey]) plus a branch in the action-layer localizer.
      throw new LeaveBackdatingNotAllowedError(limit!, lt?.name, lt?.customMessages?.backdatingLimitDays || undefined);
    }

    // Minimum advance-notice rule (0159 / feedback 0b0fb6c3). Non-HR users are blocked when the request's
    // start date arrives with fewer than the type's minAdvanceDays days of notice ("Annual Leave must be
    // submitted at least 7 days before the leave start date"); HR admins (isAdmin) bypass for exceptional
    // cases (the override path, stamped onto the submitted event below). Judged against the same tenant-
    // local (MYT) `today` as the backdating gate and fails fast BEFORE any write. Emergency Leave already
    // returned above — it exists precisely for short-notice absence (the reporter's custom message points
    // employees to it) and the field is hidden for EL in the admin UI.
    const minAdvance = lt?.minAdvanceDays ?? null;
    const advanceOverride = isAdmin(ctx) && lacksMinAdvanceNotice(p.startDate, today, minAdvance);
    if (!isAdmin(ctx) && lacksMinAdvanceNotice(p.startDate, today, minAdvance)) {
      // Custom validation messages (0147): pass the admin-authored override for THIS rule (keyed by its
      // config field name) through the typed error so the localizer renders it verbatim; absent ⇒ the
      // built-in localized default. Same look-up-then-pass-through pattern as the backdating gate above.
      throw new LeaveAdvanceNoticeRequiredError(minAdvance!, lt?.name, lt?.customMessages?.minAdvanceDays || undefined);
    }

    // Leave Year Configuration (9aa894a4). "Employees can only apply leave for a FUTURE leave year after the
    // leave year is opened." Derive the target year from the request's START date. Only a FUTURE year (strictly
    // after today's tenant-local calendar year) is gated — a current/past year keeps today's EXACT behaviour,
    // and with NO managed leave_year_config record the system is unchanged for current/past years. For a
    // future year we look up its managed record and require it to be OPEN and past its employee-application-
    // start date (leaveYearOpenForApplication). HR admins (isAdmin) bypass for exceptional cases (the override
    // path, stamped onto the submitted event below); ordinary employees get a typed LeaveYearNotOpenError
    // BEFORE any write. Emergency Leave already returned above (it exists for urgent, current absence).
    const targetLeaveYear = Number(p.startDate.slice(0, 4));
    const currentLeaveYear = Number(today.slice(0, 4));
    let leaveYearOverride = false;
    if (Number.isInteger(targetLeaveYear) && targetLeaveYear > currentLeaveYear) {
      const [lyCfg] = await tx
        .select({
          year: leaveYearConfig.year,
          status: leaveYearConfig.status,
          employeeApplicationStartDate: leaveYearConfig.employeeApplicationStartDate,
        })
        .from(leaveYearConfig)
        .where(and(eq(leaveYearConfig.tenantId, ctx.tenantId), eq(leaveYearConfig.year, targetLeaveYear)))
        .limit(1);
      const open = leaveYearOpenForApplication(lyCfg ?? null, targetLeaveYear, today);
      leaveYearOverride = isAdmin(ctx) && !open;
      if (!isAdmin(ctx) && !open) throw new LeaveYearNotOpenError(targetLeaveYear);
    }

    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    // Hourly-leave time window (0129): for an hourly request prefer the From/To window — the window is
    // MANDATORY at this service boundary (mirrors LeaveDurationNotAllowedError) and `hours` is derived from
    // it. The raw `p.hours` path remains a back-compat fallback for importer/legacy callers that don't supply
    // a window. fromTime/toTime are persisted (hourly only) so the approver + history can render the window.
    let fromTime: string | null = null;
    let toTime: string | null = null;
    let hours: number | null = null;
    if (durationType === 'hourly') {
      if (p.fromTime || p.toTime) {
        // A window was supplied: both halves are required and hours is derived from the elapsed span.
        hours = hoursBetween(p.fromTime ?? '', p.toTime ?? '');
        fromTime = (p.fromTime ?? '').slice(0, 5);
        toTime = (p.toTime ?? '').slice(0, 5);
      } else if (p.hours != null) {
        // Back-compat: importer/legacy caller passed a raw hours figure with no window.
        hours = p.hours;
      } else {
        // Neither a window nor a raw figure — the mandatory window is missing.
        throw new HourlyLeaveTimeRangeError();
      }
    }

    // ADR-0048: a non-full-day duration must be enabled on the leave type's allow-list, and confined to a
    // single day. (full_day is always allowed and keeps the original range path unchanged.)
    if (durationType !== 'full_day') {
      const allow = (lt?.durations as string[] | null) ?? [];
      if (!allow.includes(durationType)) throw new LeaveDurationNotAllowedError();
      if (p.startDate !== p.endDate) {
        throw new Error('Half-day and hourly leave must be a single day (start and end dates must match)');
      }
    }

    // For working_days types the leave must land on an actual working day — for full_day ranges this is the
    // existing count; for half/hourly it is the panel-fix guard so a half-day on a weekend/holiday is
    // rejected rather than silently deducted at 0.5. Run the holiday query once and reuse it for both.
    // workingDayCount is the LIST count (Full ∪ Half, unweighted) — used only for the "any working day in
    // range?" rejection guard below. workingDayWeight (4b/4c) is the actual DEDUCTED amount, which is what
    // `days` is set from for full_day — it differs from workingDayCount only when a Half marker + the
    // company's leaveHalfDayFullDeduction toggle apply (D2/Feedback 31474452).
    let workingDayCount: number | null = null;
    let workingDayWeight: number | null = null;
    if (lt?.counting === 'working_days') {
      // 2C (ADR-0038) + holiday grouping: holidays apply per the employee's effective set of states —
      // national (state null) ∪ those states, resolved holiday_group → work_state →
      // company.default_work_state → national-only (see resolveHolidaySet).
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, p.employmentId);
      // Day Type Inclusion (feedback ef6d7146): the type's re-inclusion vector (undefined ⇒ inert legacy
      // path). Both the deducted WEIGHT and the "any deductible day in range?" guard honour it so a type
      // configured to count e.g. public holidays deducts them and a half/hourly guard sees them as valid.
      const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
      // workingDayCount is the LIST count of deductible days — byte-identical to workingDays() when incl is
      // undefined (a Full/Half day weighs > 0, a holiday/rest day 0), and additionally counts re-included
      // day types when a vector is set.
      workingDayCount = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl)).length;
      workingDayWeight = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt?.counting === 'working_days' ? workingDayWeight! : dayCount(p.startDate, p.endDate);
    } else {
      // Single day already enforced. Working-day guard: reject a half/hourly request that falls on a
      // weekend/holiday for working_days types (workingDayCount === 0) — same error as an empty range.
      if (lt?.counting === 'working_days' && workingDayCount === 0) {
        throw new LeaveNoDaysInRangeError();
      }
      if (durationType === 'hourly') {
        const h = hours ?? 0;
        // Semantic shift (0129): the old guard capped at DEFAULT_STANDARD_HOURS (8) because the legacy input
        // was a NET-work figure. A From/To window is ELAPSED wall time — 09:00–18:00 is 9 elapsed hours (8
        // work + 1 lunch) and is a legitimate request — so we must NOT cap at 8. Lower bound (> 0) is already
        // enforced by hoursBetween for the window path; keep it for the back-compat raw-hours path too. Sanity
        // cap at 24h: hourly leave is single-day (the startDate === endDate guard above), so a single calendar
        // day cannot exceed 24 elapsed hours.
        if (!(h > 0 && h <= 24)) {
          throw new Error('Hourly leave must be more than 0 and at most 24 hours');
        }
        days = Math.round((h / DEFAULT_STANDARD_HOURS) * 100) / 100;
      } else {
        days = 0.5; // half_day_am / half_day_pm
      }

      // AM/PM same-date conflict (ADR-0048): a non-rejected request already covering this slot blocks a new
      // one. Complementary AM + PM on the same date is allowed; everything else (same slot, a full_day, or
      // an hourly) conflicts. This is the only overlap logic — general range overlap stays out of scope.
      const existing = await tx
        .select({ durationType: leaveRequest.durationType })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, p.employmentId),
            eq(leaveRequest.startDate, p.startDate),
            eq(leaveRequest.endDate, p.endDate),
            inArray(leaveRequest.status, ['pending', 'approved']),
          ),
        );
      for (const e of existing) {
        const conflicts =
          e.durationType === durationType || // same slot (or hourly vs hourly)
          e.durationType === 'full_day' ||
          e.durationType === 'hourly' ||
          durationType === 'hourly';
        if (conflicts) throw new Error('This date already has a conflicting leave request');
      }
    }

    // Duplicate Leave Application Restriction (d5e51c34): AFTER the narrow AM/PM same-slot clash above, apply
    // the leave type's same-DATE double-booking policy. Runs for ALL durations (full-day included), unlike the
    // slot clash which only lives in the non-full-day branch. Extends the comparison from same-slot to same-
    // DATE range overlap: a pending/approved application whose [startDate, endDate] intersects the requested
    // [startDate, endDate]. 'restrict_same' scopes the check to the SAME leave type; 'restrict_any' matches any
    // type. 'allow'/null ⇒ no extra check (today's behaviour). Fires for admins too — double-booking is a data
    // rule, not a permission (unlike backdating/advance-notice, which isAdmin bypasses).
    const dupPolicy = lt?.duplicateApplicationPolicy ?? 'allow';
    if (dupPolicy === 'restrict_same' || dupPolicy === 'restrict_any') {
      const overlap = await tx
        .select({ id: leaveRequest.id })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, p.employmentId),
            inArray(leaveRequest.status, ['pending', 'approved']),
            lte(leaveRequest.startDate, p.endDate),
            gte(leaveRequest.endDate, p.startDate),
            ...(dupPolicy === 'restrict_same' ? [eq(leaveRequest.leaveTypeId, p.leaveTypeId)] : []),
          ),
        )
        .limit(1);
      if (overlap.length > 0) throw new DuplicateLeaveApplicationError();
    }

    if (days <= 0) throw new LeaveNoDaysInRangeError();

    // Configurable Negative Leave Balance Validation (0ef0defd): submit-time balance guard. When the leave type
    // has allow_negative_balance=false (the default), reject an application whose days exceed the employee's
    // AVAILABLE balance — the approved-ledger balance MINUS days already reserved by other pending requests of
    // the same type (availableLeaveBalance). allow_negative_balance=true skips this (employees may go negative;
    // the pre-existing approval-time guard is unaffected). Fires for admins too — this is a data rule about the
    // balance, mirroring the duplicate-application gate above. round2 matches the leave math (leavePreview).
    if (lt?.allowNegativeBalance === false) {
      const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
      if (round2(available - days) < 0) throw new InsufficientLeaveBalanceOnSubmitError();
    }

    // Combined Leave Type Limit (R44 4c48fd1f, Stage 2): reject when this application would push the
    // employee's per-cycle usage across a shared pool (scheme combined-limit) over its total. No-op when the
    // employee has no effective scheme or the type is in no pool, so tenants without pools are unaffected.
    await enforceCombinedLeaveLimit(tx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      requestedDays: days,
    });

    // ADR-0069: a friendly UX pre-check — the DB trigger (guard_frozen_leave_balance) is the real
    // enforcement at approval time, but failing fast here gives the employee a readable error immediately
    // instead of only at approval. Import is deferred (function-scope) to avoid a load-time circular
    // dependency: leave-encashment.ts never imports from leave.ts.
    {
      const { frozenSnapshotFor, LeaveBalanceFrozenError } = await import('./leave-encashment');
      const frozen = await frozenSnapshotFor(tx, p.employmentId, p.leaveTypeId);
      if (frozen) throw new LeaveBalanceFrozenError();
    }

    // Doc-config: now that `days` is known, enforce the conditional document gate. `days` is fractional
    // (half-day / hourly), so use strict `>` against the integer config: mandatoryAfterDays:N means "more
    // than N days" (a 2.0-day request with N=2 needs no doc; 2.5 days does). null/0 ⇒ always require.
    if (lt?.requiresDocument && !p.hasDocument) {
      const after = lt.mandatoryAfterDays;
      if (after == null || after === 0 || days > after) {
        throw new LeaveDocumentRequiredError(lt.name, after ?? undefined);
      }
    }

    // Doc-config: mandatory employee remark.
    const employeeRemark = p.employeeRemark?.trim() || null;
    if (lt?.employeeRemarkRequired && !employeeRemark) {
      throw new LeaveRemarkRequiredError(lt.name);
    }

    // Phase-B #13 (ADR-0062): EA s.37 maternity paid-ALLOWANCE eligibility. The 98-day LEAVE is granted
    // regardless; the paid ALLOWANCE is a separate entitlement. When the s.37 facts (surviving-children +
    // confinement date) are supplied, compute the decision — it OVERRIDES the maternity leave-type paid
    // default: withheld ⇒ allowance_eligible=false ⇒ unpaidDaysByEmployment treats the days as unpaid. When
    // the inputs are absent (legacy/UI-not-updated), default conservatively to PAID (allowance_eligible left
    // NULL) and surface a "paid-allowance unconfirmed" warning so HR can confirm — never silently wrong.
    let maternity: {
      survivingChildren: number | null;
      confinementDate: string | null;
      allowanceEligible: boolean | null;
      event: Record<string, unknown>;
    } | null = null;
    let maternityAllowanceWarning = false;
    if (lt?.code === MATERNITY_LEAVE_CODE) {
      const hasInputs = p.confinementDate != null && p.survivingChildren != null;
      if (hasInputs) {
        const [emp] = await tx
          .select({ hiredOn: employment.hiredOn })
          .from(employment)
          .where(eq(employment.id, p.employmentId))
          .limit(1);
        const decision = maternityAllowanceEligibility(emp!.hiredOn, p.confinementDate!, p.survivingChildren!);
        maternity = {
          survivingChildren: p.survivingChildren!,
          confinementDate: p.confinementDate!,
          allowanceEligible: decision.eligible,
          event: {
            allowanceEligible: decision.eligible,
            reason: decision.reason ?? null,
            qualifyingService: decision.qualifyingService,
            survivingChildren: p.survivingChildren!,
            confinementDate: p.confinementDate!,
            unconfirmed: false,
          },
        };
      } else {
        // Belt-and-braces: inputs unconfirmed → keep the leave paid (allowance_eligible NULL) + warn.
        maternityAllowanceWarning = true;
        maternity = {
          survivingChildren: p.survivingChildren ?? null,
          confinementDate: p.confinementDate ?? null,
          allowanceEligible: null,
          event: {
            allowanceEligible: null,
            reason: null,
            qualifyingService: null,
            survivingChildren: p.survivingChildren ?? null,
            confinementDate: p.confinementDate ?? null,
            unconfirmed: true,
          },
        };
      }
    }

    // Partial Leave Approval — single-request model (ADR-0068, supersedes 0131's child-row split). When the
    // type opts into per-date approval AND the company is single-step, a multi-day FULL-DAY WORKING-DAYS
    // request stays ONE leave_request row and gets one leave_request_date sub-row per working date (below,
    // after the single insert). The approver then decides each date via decideLeaveDate in the request detail
    // view — one inbox row, not one-per-day. The gate (§4C) excludes: calendar-counted types (kept as a whole
    // span), half/hourly (single-day, forced start===end above), REPLACEMENT (TOIL consume-on-approve
    // interaction), and — critically — MULTI-STEP companies (per-date × the manager→HR chain is deferred;
    // such a request falls through to today's whole-request decideLeave chain with NO per-date rows, so
    // deployed multi-step data is never stranded). "route by whether leave_request_date rows exist" is safe
    // precisely because rows are only ever created for single-step companies. EL was already routed above.
    const [coCfg] = await tx
      .select({ multi: company.leaveMultiApproval })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const perDateEligible =
      durationType === 'full_day' &&
      lt?.counting === 'working_days' &&
      !!lt?.perDateApproval &&
      lt?.code !== 'REPLACEMENT' &&
      p.startDate !== p.endDate &&
      coCfg?.multi === false;

    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      days,
      durationType,
      hours,
      fromTime,
      toTime,
      reason: p.reason ?? null,
      employeeRemark,
      parentGroupId: null,
      mandatoryAfterDays: lt?.mandatoryAfterDays ?? null,
      survivingChildren: maternity?.survivingChildren ?? null,
      confinementDate: maternity?.confinementDate ?? null,
      allowanceEligible: maternity?.allowanceEligible ?? null,
      maternityAllowanceEvent: maternity?.event ?? null,
      // Configurable backdated-leave restriction (0133): stamp the override onto the submitted event only when
      // an HR admin actually bypassed the type's limit (computed at the guard above).
      backdatingAudit: backdatedOverride
        ? { daysBackdated: daysBetween(p.startDate, today), backdatingLimitDays: limit }
        : null,
      // Minimum advance-notice rule (0159): stamp the override onto the submitted event only when an HR admin
      // actually bypassed the type's required notice (computed at the guard above).
      minAdvanceAudit: advanceOverride
        ? { daysInAdvance: daysBetween(today, p.startDate), minAdvanceDays: minAdvance }
        : null,
      // Leave Year Configuration (9aa894a4): stamp the override onto the submitted event only when an HR admin
      // actually applied for a not-yet-open future leave year (computed at the gate above).
      leaveYearAudit: leaveYearOverride ? { targetYear: targetLeaveYear } : null,
    });

    // Partial Leave Approval — single-request model (ADR-0068 §4B). When the type is opted-in (§4C gate above)
    // and the span has >1 working date, insert one leave_request_date sub-row per working date (status
    // 'pending') IN THE SAME TRANSACTION as the single request. These are the per-date decision handles the
    // approver flips in the detail view via decideLeaveDate; the span consumers (§4A) read them so only the
    // approved dates count as leave. The submitted event's payload carries perDate so the whole submission is
    // captured on ONE aggregate event. Substrate: the per-date INSERTs are sub-rows of a single aggregate whose
    // lifecycle is captured by the aggregate's submitted (with perDate) + per-date-decided events — no separate
    // event per sub-row insert.
    let perDate: { date: string; days: number }[] = [];
    if (perDateEligible) {
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, p.employmentId);
      // Day Type Inclusion (feedback ef6d7146): the per-date sub-rows must span exactly the DEDUCTIBLE dates
      // (re-included day types included) and carry each date's inclusion-aware weight, so sum(perDate.days)
      // still equals the request's weighted `days` and no re-included day is stranded outside per-date approval.
      const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
      const dates = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl));
      if (dates.length > 1) {
        // Feedback 31474452: each date carries ITS OWN weight (1 for Full, 0.5/1.0 for Half per the company
        // toggle) rather than always-1 "one whole working day by construction" — so sum(perDate.days) equals
        // the request's WEIGHTED total (days, set above from workingDayWeight), not merely its date count.
        perDate = dates.map((d) => ({ date: d, days: dayWeight(d, sched, hols, incl) }));
        await tx.insert(leaveRequestDate).values(
          perDate.map((pd) => ({
            tenantId: ctx.tenantId,
            leaveRequestId: id,
            subjectEmploymentId: p.employmentId,
            leaveDate: pd.date,
            days: pd.days.toFixed(2),
            status: 'pending' as const,
          })),
        );
        // Extend the already-appended submitted event with the per-date breakdown (append a companion command
        // event on the same aggregate so the submitted fact + its date breakdown are both queryable).
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: id,
          eventType: 'leave-request.per-date.initialized',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          payload: { perDate },
        });
      }
    }

    // Phase-B #15 — holiday-completeness guard. A working_days request's day count depends on the gazetted
    // holidays loaded for the employee's (state, year). If fewer than the s.60D minimum of 11 are loaded,
    // warn LOUDLY (domain event + returned warning) but do NOT block — the count may be wrong until HR loads
    // the rest of the state gazette. Only meaningful for working_days types (calendar types ignore holidays).
    const holidayWarnings = lt?.counting === 'working_days'
      ? await warnLeaveHolidayCompleteness(tx, ctx, p.employmentId, p.startDate, p.endDate, id)
      : [];

    return {
      leaveRequestId: id,
      days,
      parentGroupId: null,
      children: [{ id, code: lt?.code ?? '', days }],
      ...(maternityAllowanceWarning ? { maternityAllowanceWarning: true } : {}),
      ...(holidayWarnings.length ? { holidayWarnings } : {}),
    };
  });
}

/** Feedback 31474452 (Step 5): pre-submission preview — "this will deduct X day(s), balance before/after" —
 *  for the day-based durations only (full_day, half_day_am, half_day_pm; hourly keeps its existing
 *  client-side display, see components/leave-duration-fields.tsx hourlyTotal). Read-only: no domain event, no
 *  write. Mirrors (but does not duplicate) requestLeave's day-counting math so the preview and the actual
 *  submission can never drift on the FULL-DAY figure — both read the same resolveSchedule/dayWeight/
 *  workingDaysWeighted helpers. Runs under the caller's own session (RLS on leave_ledger/leave_type already
 *  scopes what is readable) and validates employmentId is real/visible exactly like requestLeave does (a
 *  bogus or out-of-scope id simply yields no leave-type match / RLS-empty balance, never a throw here — the
 *  UI's own employment <select> is the real gate, same trust boundary as requestLeave itself).
 *  Emergency Leave: returns the weighted span total as `days` with `isEmergencySplit: true` — the actual
 *  sick/annual/unpaid split (and the unpaid-consent gate) is only resolved authoritatively at submission. */
export async function previewLeaveDeduction(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    durationType?: LeaveDurationType;
  },
): Promise<{
  days: number;
  balanceAvailable: number;
  balanceAfter: number;
  hasHalfScheduleDate: boolean;
  isEmergencySplit: boolean;
}> {
  return withTenant(ctx, async (tx) => {
    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    const [lt] = await tx
      // Day Type Inclusion (feedback ef6d7146): projected so the preview's day-count matches what submission
      // will deduct (both run through workingDaysWeighted with the same inclusion vector — no preview drift).
      .select({ code: leaveType.code, counting: leaveType.counting, dayTypeInclusion: leaveType.dayTypeInclusion })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    const isEmergencySplit = lt?.code === EMERGENCY_LEAVE_CODE;
    const balanceAvailable = await leaveBalance(tx, p.employmentId, p.leaveTypeId);

    let days = 0;
    let hasHalfScheduleDate = false;
    if (lt?.counting === 'working_days') {
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, p.employmentId);
      hasHalfScheduleDate = eachDate(p.startDate, p.endDate).some((d) => sched.halfDaysIso.includes(isoWeekday(d)));
      if (durationType === 'full_day' || isEmergencySplit) {
        const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
        days = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
      } else {
        days = 0.5; // half_day_am / half_day_pm — D4: unaffected by the half-schedule toggle
      }
    } else if (durationType === 'full_day' || isEmergencySplit) {
      days = dayCount(p.startDate, p.endDate);
    } else {
      days = 0.5;
    }

    return {
      days,
      balanceAvailable,
      balanceAfter: round2(balanceAvailable - days),
      hasHalfScheduleDate,
      isEmergencySplit,
    };
  });
}

/** Phase-B #15: resolve the request's effective (country, state) and span years, then emit a non-blocking
 *  holiday-completeness warning event for any (state, year) below the s.60D minimum. Returns the warnings so
 *  the leave screen can surface them. Threaded onto the leave-request aggregate for the audit trail. */
async function warnLeaveHolidayCompleteness(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  startDate: string,
  endDate: string,
  leaveRequestId: string,
): Promise<HolidayCompletenessWarning[]> {
  const eff = await effectiveHolidayState(tx, employmentId);
  if (!eff) return [];
  // ADR-0067: a Custom location-calendar deliberately ignores the public gazette, so the s.60D "<11" guard
  // is false noise — suppress it entirely (no event, no returned warning) for those employees.
  if (eff.skipCompleteness) return [];
  return warnIfHolidaysIncomplete(tx, ctx, {
    country: eff.country,
    state: eff.state,
    years: yearsSpanned(startDate, endDate),
    module: 'leave',
    aggregateType: 'leave-request',
    aggregateId: leaveRequestId,
    subjectEmploymentId: employmentId,
    context: { leaveRequestId, startDate, endDate },
  });
}

/**
 * Emergency-Leave decomposition (0106 + Phase-B #12 / ADR-0061). EL is an application type only: this resolves
 * the paid→UPL split at submission against the employee's balances and creates up to three ordinary child
 * requests over the same dates, linked by one parent_group_id. Each child is a full-day request of its own
 * type, so it counts in its own mode natively (ANNUAL/SICK = their own counting, UNPAID = calendar-days).
 *
 * Cascade (frozen at submit):
 *   - reasonCategory 'illness' → paid SICK FIRST (EA s.60F), then ANNUAL, then UNPAID(consent). (Phase-B #12B)
 *   - otherwise               → ANNUAL, then UNPAID(consent). (the original 0106 behaviour, unchanged)
 *
 * Boundary policy (earliest-working-days-to-paid): each paid segment carves the earliest WHOLE working-days
 * (its day count floored to ≤ its real balance, H4) off the front of the span; the UNPAID child takes the
 * remaining calendar-day suffix. The split is frozen at submission; each child still gates its own balance at
 * its own approval (InsufficientLeaveBalanceError if drained meanwhile — predictable, already-tested).
 *
 * Consent gate (Phase-B #12A): when the cascade would create an UNPAID child, `unpaidConsent` MUST be true —
 * else UnpaidConsentRequiredError is thrown BEFORE any insert (nothing persisted). With consent the UNPAID
 * child is stamped with unpaid_consent_at/by and the EL event records the consent.
 */
async function requestEmergencyLeave(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    durationType?: LeaveDurationType;
    reasonCategory?: EmergencyReasonCategory;
    unpaidConsent?: boolean;
  },
): Promise<RequestLeaveResult> {
  // EL is full-day-range only (no durations allow-list) — reject a non-full-day request explicitly.
  if (p.durationType && p.durationType !== 'full_day') {
    throw new LeaveDurationNotAllowedError();
  }
  const isIllness = p.reasonCategory === 'illness';
  // Resolve ANNUAL + UNPAID (+ SICK for illness) type ids for the tenant. ANNUAL + UNPAID are required for the
  // decomposition; SICK is only needed (and only used) for the illness path.
  const childTypes = await tx
    .select({ id: leaveType.id, code: leaveType.code })
    .from(leaveType)
    .where(inArray(leaveType.code, ['ANNUAL', 'UNPAID', 'SICK']));
  const annualId = childTypes.find((t) => t.code === 'ANNUAL')?.id;
  const unpaidId = childTypes.find((t) => t.code === 'UNPAID')?.id;
  const sickId = childTypes.find((t) => t.code === 'SICK')?.id;
  if (!annualId || !unpaidId) {
    throw new Error('Emergency Leave requires Annual and Unpaid leave types to be configured');
  }

  // Count the span as the working-days (paid) children would (honouring the employee's holidays/state +
  // configured rest-day roster + Half-day markers) and as the UNPAID child would (calendar-days).
  // Day Type Inclusion (feedback ef6d7146): DELIBERATELY NOT applied here. Emergency Leave decomposes into
  // ANNUAL (+ SICK) + UNPAID children; EA-1955 s.60E forbids counting rest days / public holidays inside paid
  // ANNUAL leave, so re-including them via a day-type vector would be unlawful. EL therefore always counts its
  // paid portion in the byte-identical legacy working-days frame (no inclusion vector passed below).
  const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
  const sched = await resolveSchedule(tx, p.employmentId);
  const workingDaysIso = [...new Set([...sched.workingDaysIso, ...sched.halfDaysIso])];
  // spanWorkingDays is the WEIGHTED total (Feedback 31474452 4d) — the balance-cover math below must consume
  // the same weighted figure a half-day-aware span would deduct, not a plain date count.
  const spanWorkingDays = workingDaysWeighted(p.startDate, p.endDate, hols, sched);
  const uplSpanDays = dayCount(p.startDate, p.endDate);
  if (uplSpanDays <= 0) throw new LeaveNoDaysInRangeError();

  // The span's working-day dates in order — paid segments cut at boundary working-days off the front. Rest
  // days come from the SAME configured roster as the count above (audit H#3), not a hardcoded Sat/Sun.
  const workingDates = eachDate(p.startDate, p.endDate).filter((d) => isWorkingDay(d, workingDaysIso, hols));

  // Build the ordered list of PAID segments and the unpaid remainder. SICK is prepended only for an illness
  // emergency with a real SICK type + positive balance; ANNUAL always follows. Each segment's `cover` is its
  // balance-limited WEIGHTED working-day count from resolveEmergencyIllnessCascade (sickCovered then
  // alCovered) — which degrades to exactly the AL→UPL split when there is no sick component, so the
  // non-illness path is unchanged.
  const sickBalance = isIllness && sickId ? await leaveBalance(tx, p.employmentId, sickId) : 0;
  const alBalance = await leaveBalance(tx, p.employmentId, annualId);
  const { sickCovered, alCovered, alShortfall } = resolveEmergencyIllnessCascade(
    sickBalance,
    alBalance,
    spanWorkingDays,
  );

  // Each paid segment carves working-dates off the front, in order, up to its balance-limited WEIGHT.
  const paidSegments: { typeId: string; code: string; cover: number }[] = [];
  if (isIllness && sickId && sickCovered > 0) paidSegments.push({ typeId: sickId, code: 'SICK', cover: sickCovered });
  if (alCovered > 0) paidSegments.push({ typeId: annualId, code: 'ANNUAL', cover: alCovered });

  // Feedback 31474452 (4d): date-boundary WEIGHT WALK, not a naive floor/index whole-day carve — a Half-day
  // date with the toggle ON weighs 1.0 (so it consumes like a Full day) but with the toggle OFF weighs only
  // 0.5, and a Half date can only ever be consumed WHOLE (never split across two paid segments or split
  // paid/unpaid mid-date). datesConsumed (an index into workingDates) and weightConsumed are tracked
  // SEPARATELY: hasUnpaid must compare datesConsumed to workingDates.length (a date count), never a weight
  // sum to a date count — that mismatch is exactly what would spuriously manufacture an unpaid child on a
  // span with a half date and ample balance (the panel's Fri-Mon / Sat=half scenario).
  let datesConsumed = 0;
  const plannedPaid: { typeId: string; code: string; dateCount: number; segDays: number }[] = [];
  for (const seg of paidSegments) {
    let segDates = 0;
    let segWeight = 0;
    // Consume leading unconsumed working dates while the segment's remaining cover can absorb the NEXT
    // date's weight whole (a date is never partially consumed across segments).
    while (datesConsumed + segDates < workingDates.length) {
      const nextDate = workingDates[datesConsumed + segDates];
      const nextWeight = dayWeight(nextDate, sched, hols);
      if (segWeight + nextWeight > seg.cover + 1e-9) break; // would exceed this segment's balance-limited cover
      segWeight += nextWeight;
      segDates += 1;
    }
    if (segDates > 0) {
      plannedPaid.push({ typeId: seg.typeId, code: seg.code, dateCount: segDates, segDays: round2(segWeight) });
      datesConsumed += segDates;
    }
  }
  // The unpaid remainder is every calendar day after the last paid working-DATE (or the whole span if no
  // paid dates were carved) — a DATE-COUNT compare (datesConsumed < workingDates.length), never a weight
  // compare, so a half-weighted-but-fully-consumed span never manufactures a spurious unpaid child.
  const hasUnpaid = datesConsumed < workingDates.length;

  // Consent gate (Phase-B #12A): an UNPAID child requires explicit consent — throw BEFORE any insert so a
  // missing acknowledgement leaves nothing persisted.
  if (hasUnpaid && !p.unpaidConsent) {
    // The unpaid remainder in calendar-days, for the error message (the form shows the full split itself).
    const lastPaidWorkingDay = datesConsumed > 0 ? workingDates[datesConsumed - 1] : null;
    const uplStart = lastPaidWorkingDay ? eachDate(lastPaidWorkingDay, p.endDate)[1] : p.startDate;
    const uplDays = dayCount(uplStart, p.endDate);
    throw new UnpaidConsentRequiredError(uplDays);
  }

  const parentGroupId = randomUUID();
  const consentAt = hasUnpaid ? new Date() : null;
  const children: { id: string; code: string; days: number }[] = [];

  // Insert each paid segment as a contiguous full-day child [segStart, boundaryWorkingDay]. segDays is the
  // segment's WEIGHTED total (asserted in tests to equal workingDaysWeighted(segStart, boundary)).
  let cursor = 0; // index into workingDates of the next un-assigned working-date
  for (const seg of plannedPaid) {
    const segStart = cursor === 0 ? p.startDate : eachDate(workingDates[cursor - 1], p.endDate)[1];
    const boundaryWorkingDay = workingDates[cursor + seg.dateCount - 1];
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: seg.typeId, startDate: segStart, endDate: boundaryWorkingDay,
      days: seg.segDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id, code: seg.code, days: seg.segDays });
    cursor += seg.dateCount;
  }

  // Insert the UNPAID remainder child (consent-stamped), if any.
  if (hasUnpaid) {
    const uplStart = cursor > 0 ? eachDate(workingDates[cursor - 1], p.endDate)[1] : p.startDate;
    const uplDays = dayCount(uplStart, p.endDate);
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: unpaidId, startDate: uplStart, endDate: p.endDate,
      days: uplDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
      unpaidConsentAt: consentAt, unpaidConsentBy: ctx.userId ?? null,
    });
    children.push({ id, code: 'UNPAID', days: uplDays });
  }

  const sickChild = children.find((c) => c.code === 'SICK');
  const alChild = children.find((c) => c.code === 'ANNUAL');
  const uplChild = children.find((c) => c.code === 'UNPAID');
  // A single EL command event keyed on parentGroupId, alongside each child's own leave-request.submitted —
  // gives the audit trail / substrate one traceable EL submission. The day counts report the ACTUAL child
  // counts (paid segments floored to whole working-days, UNPAID carries the rest — H4). The consent stamp is
  // recorded here so the audit trail proves the unpaid days were elected.
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: parentGroupId,
    eventType: 'leave-request.emergency.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      employmentId: p.employmentId,
      reasonCategory: p.reasonCategory ?? 'other',
      ...(sickChild ? { sickChildId: sickChild.id } : {}),
      ...(alChild ? { alChildId: alChild.id } : {}),
      ...(uplChild ? { uplChildId: uplChild.id } : {}),
      sickDays: sickChild?.days ?? 0,
      alDays: alChild?.days ?? 0,
      uplDays: uplChild?.days ?? 0,
      startDate: p.startDate,
      endDate: p.endDate,
      ...(hasUnpaid ? { unpaidConsent: true, unpaidConsentAt: consentAt!.toISOString() } : {}),
    },
  });

  // Keep `leaveRequestId` populated (the first paid child when present, else the UPL child) so the existing
  // action layer's destructure stays valid; `days` is the total covered span for parity with the ordinary path.
  const firstChildId = (sickChild ?? alChild ?? uplChild)!.id;
  return {
    leaveRequestId: firstChildId,
    days: round2(sickCovered + alCovered + alShortfall),
    parentGroupId,
    children,
  };
}

/** Generate the approval chain for a new request when its company opts into multi-step approval.
 *  2B-1 chain is fixed: direct manager (when one exists) then HR. 2B-2 made it configurable per
 *  company/leave-type; ADR-0071 makes it a SCOPED RULE MATRIX resolved against the requester's CURRENT
 *  assignment attributes + day count. `days` is the request's leave-day count — the fractional
 *  day-equivalent for hourly/partial requests (ADR-0071 1(h)), so an hourly request still participates in
 *  day-range matching. The generated steps are snapshotted here at submission time and NEVER re-resolved
 *  (ADR-0071 1(g)) — editing/archiving a rule later cannot change a pending request's routing. */
async function generateApprovalSteps(
  tx: Tx,
  tenantId: string,
  leaveRequestId: string,
  employmentId: string,
  leaveTypeId: string,
  days: number,
) {
  const [co] = await tx
    .select({ multi: company.leaveMultiApproval, companyId: company.id })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!co?.multi) return; // single-step company — no chain

  // Include a manager step only when the employee has a current administrative reporting line;
  // otherwise direct_manager levels are dropped (no dead step that nobody can clear).
  const [mgr] = await tx
    .select({ id: reportingLine.id })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        lte(reportingLine.validFrom, sql`current_date`),
        or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
      ),
    )
    .limit(1);
  const hasManager = !!mgr;

  // ADR-0071: gather the requester's OWN current-assignment attributes (validTo/supersededAt null — the
  // same currentAssignment predicate used across the read layer) plus grade (on the employment row) and
  // the department's business unit (nullable — a BU-scoped rule simply fails to match when unset, never
  // errors). Scoped strictly to THIS employmentId — never a concurrent employment at another company
  // (ADR-0071 1(f)).
  const [attr] = await tx
    .select({
      gradeId: employment.gradeId,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      employmentType: assignment.employmentType,
      businessUnitId: department.businessUnitId,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .where(eq(employment.id, employmentId))
    .limit(1);

  // R41 72800eda: map the requester's individual grade → its GRADE GROUP (grade_group_member) so a
  // grade-group-scoped approval rule can match. A grade belongs to at most one group (unique index); an
  // ungrouped/ungraded requester resolves to null and simply never matches a group-scoped rule.
  let gradeGroupId: string | null = null;
  if (attr?.gradeId) {
    const [gm] = await tx
      .select({ gradeGroupId: gradeGroupMember.gradeGroupId })
      .from(gradeGroupMember)
      .where(eq(gradeGroupMember.gradeId, attr.gradeId))
      .limit(1);
    gradeGroupId = gm?.gradeGroupId ?? null;
  }

  // 2B-2 / ADR-0071: the chain is data — resolve the most-specific matching rule for this request.
  const chain = await resolveApprovalChain(tx, co.companyId, leaveTypeId, {
    gradeId: attr?.gradeId ?? null,
    gradeGroupId,
    departmentId: attr?.departmentId ?? null,
    positionId: attr?.positionId ?? null,
    employmentType: attr?.employmentType ?? null,
    businessUnitId: attr?.businessUnitId ?? null,
    days,
  });
  // 6fadb036 (gap-close): head-kind steps route to an org-chart head. Resolve the subject's department and
  // business-unit heads once; a head step is DROPPED when its head is unset, mirroring the direct_manager
  // drop (no dead step nobody can clear). HR / HR Manager / Payroll / Custom Role steps are role-based and
  // are never dropped here — they resolve to role authority at decision time.
  let deptHead: string | null = null;
  if (attr?.departmentId) {
    const [d] = await tx
      .select({ head: department.headEmploymentId })
      .from(department)
      .where(eq(department.id, attr.departmentId))
      .limit(1);
    deptHead = d?.head ?? null;
  }
  let buHead: string | null = null;
  if (attr?.businessUnitId) {
    const [b] = await tx
      .select({ head: businessUnit.headEmploymentId })
      .from(businessUnit)
      .where(eq(businessUnit.id, attr.businessUnitId))
      .limit(1);
    buHead = b?.head ?? null;
  }
  const kinds = chain.filter((k) => {
    if (k === 'direct_manager') return hasManager;
    if (k === 'department_head') return !!deptHead;
    if (k === 'business_unit_head') return !!buHead;
    return true;
  });
  if (kinds.length === 0) return;
  await tx.insert(leaveApprovalStep).values(
    kinds.map((approverKind, stepIndex) => ({
      tenantId,
      leaveRequestId,
      subjectEmploymentId: employmentId,
      stepIndex,
      approverKind,
    })),
  );
}

/** Attach a supporting document to a pending leave request (2A-2). employment_id is denormalized from
 *  the request so the attachment's RLS matches the request (subject + manager + admin). */
export async function addLeaveAttachment(
  ctx: SessionContext,
  p: { leaveRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new Error('Empty file');
  return withTenant(ctx, async (tx) => {
    // Doc-config: join the type to read its mime/size rule. The /me flow already validated upstream (so
    // a bad file never created an orphan request); this is defence-in-depth for any other caller and
    // replaces the previously hard-coded 10 MB ceiling with the type's configured limit.
    const [req] = await tx
      .select({
        employmentId: leaveRequest.employmentId,
        status: leaveRequest.status,
        allowedMimeTypes: leaveType.allowedMimeTypes,
        maxDocBytes: leaveType.maxDocBytes,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(eq(leaveRequest.id, p.leaveRequestId))
      .limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error('Documents can only be added while the request is pending');
    validateLeaveDocument(
      { allowedMimeTypes: req.allowedMimeTypes, maxDocBytes: req.maxDocBytes },
      { mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    );
    const [row] = await tx
      .insert(leaveRequestAttachment)
      .values({
        tenantId: ctx.tenantId,
        leaveRequestId: p.leaveRequestId,
        employmentId: req.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: leaveRequestAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: p.leaveRequestId,
      eventType: 'leave-request.document.attached',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** Stream a leave request's supporting document. Runs under RLS (subject + manager + admin). */
export async function getLeaveAttachment(
  ctx: SessionContext,
  leaveRequestId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: leaveRequestAttachment.content,
        fileName: leaveRequestAttachment.fileName,
        mimeType: leaveRequestAttachment.mimeType,
      })
      .from(leaveRequestAttachment)
      .where(eq(leaveRequestAttachment.leaveRequestId, leaveRequestId))
      .orderBy(desc(leaveRequestAttachment.createdAt))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

/** Only HR (hr_admin / super_admin) may clear an hr_admin step; an HR admin still cannot decide their
 *  own request (mirrors assertCanDecide's self-ban). */
async function assertIsHrAdmin(tx: Tx, ctx: SessionContext, subjectEmploymentId: string, label: string) {
  const roles = ctx.roles ?? [];
  const isSuper = roles.includes('super_admin');
  if (!(isSuper || roles.includes('hr_admin'))) throw new Error(`Only HR can decide this ${label}`);
  if (!isSuper && ctx.personId != null) {
    const [subj] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, subjectEmploymentId))
      .limit(1);
    if (subj?.personId === ctx.personId) throw new Error(`You cannot decide your own ${label}`);
  }
}

/** 6fadb036 (gap-close) — dispatch a leave approval step to the right decider-authority check for its kind.
 *  Each kind's semantics are documented on LEVEL_KINDS (core/leave-approval-policy.ts). The self-approval
 *  ban applies to every kind (super_admin keeps the sole-admin escape hatch), matching assertCanDecide. */
async function assertCanDecideLeaveStep(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  kind: string,
  label: string,
) {
  const roles = ctx.roles ?? [];
  const isSuper = roles.includes('super_admin');
  // HR admins hold full leave visibility + authority, so they can clear ANY step — this guarantees every
  // chain completes even when the designated role-holder/head lacks RLS visibility to the request (a payroll
  // partner or a dept/BU head who is not also the subject's admin manager cannot see it). The designated
  // decider still clears their own step when they DO have access (checked below). Documented in the
  // approver-vocabulary note (ADR-0071 §i follow-up: dedicated approver-role visibility).
  const isAdminRole = isSuper || roles.includes('hr_admin');
  // Shared self-approval ban (skipped for super_admin, like assertCanDecide / assertIsHrAdmin).
  const banSelf = async () => {
    if (isSuper || ctx.personId == null) return;
    const [subj] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, subjectEmploymentId))
      .limit(1);
    if (subj?.personId === ctx.personId) throw new Error(`You cannot decide your own ${label}`);
  };

  switch (kind) {
    case 'direct_manager':
      // The direct-manager chain step is a leave APPLICATION decision — a scoped delegation must cover it.
      return assertCanDecide(tx, ctx, subjectEmploymentId, label, scopeOf('leave.application'));
    // HR-tier / generic-admin gates. hr_manager and custom_role are cleared by HR/admins today; a distinct
    // ranked hr_manager role and a per-step bound custom role are documented follow-ups (ADR-0071 §i).
    case 'hr_admin':
    case 'hr_manager':
    case 'custom_role':
      return assertIsHrAdmin(tx, ctx, subjectEmploymentId, label);
    case 'payroll': {
      await banSelf();
      if (isAdminRole) return; // HR/super clears it (guaranteed visibility)
      const [subj] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, subjectEmploymentId))
        .limit(1);
      const ok = (ctx.grants ?? []).some(
        (g) => g.role === 'payroll_partner' && (g.companyId == null || g.companyId === subj?.companyId),
      );
      if (!ok) throw new Error(`Only Payroll or HR can decide this ${label}`);
      return;
    }
    case 'department_head':
    case 'business_unit_head': {
      await banSelf();
      if (isAdminRole) return; // HR/super clears it (guaranteed visibility)
      const head = await resolveSubjectHead(tx, subjectEmploymentId, kind);
      const roleLabel = kind === 'department_head' ? 'department head' : 'business unit head';
      if (head == null) throw new Error(`No ${roleLabel} is set for this employee — an admin must decide or assign one`);
      const [h] = await tx
        .select({ personId: employment.personId })
        .from(employment)
        .where(eq(employment.id, head))
        .limit(1);
      if (ctx.personId != null && h?.personId === ctx.personId) return;
      throw new Error(`Only the ${roleLabel} or HR can decide this ${label}`);
    }
    default:
      throw new Error(`Unknown approver step for this ${label}`);
  }
}

/** Resolve the subject's current department-head or business-unit-head employment id (null when unset).
 *  Uses the subject's CURRENT assignment (validTo/supersededAt null), the same predicate as elsewhere. */
async function resolveSubjectHead(
  tx: Tx,
  subjectEmploymentId: string,
  kind: 'department_head' | 'business_unit_head',
): Promise<string | null> {
  if (kind === 'department_head') {
    const [row] = await tx
      .select({ head: department.headEmploymentId })
      .from(assignment)
      .innerJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          eq(assignment.employmentId, subjectEmploymentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);
    return row?.head ?? null;
  }
  const [row] = await tx
    .select({ head: businessUnit.headEmploymentId })
    .from(assignment)
    .innerJoin(department, eq(department.id, assignment.departmentId))
    .innerJoin(businessUnit, eq(businessUnit.id, department.businessUnitId))
    .where(
      and(
        eq(assignment.employmentId, subjectEmploymentId),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .limit(1);
  return row?.head ?? null;
}

// endDate is widened in (alongside days/startDate) for the on-approval payroll-impact enrichment below. At
// runtime decideLeave passes the full leave_request row, so endDate is always present; the type just exposes it.
type DecidableLeave = { id: string; employmentId: string; leaveTypeId: string; days: string; startDate: string; endDate: string };

/** Final approval: balance gate + ledger debit + status flip + event. daysOverride (ADR-0068 §4E) lets the
 *  per-date finalization debit only the sum of APPROVED dates instead of the whole request span; it defaults
 *  to req.days for every non-per-date caller (byte-identical behaviour). Guard: since §4C excludes REPLACEMENT
 *  from per-date approval, the daysOverride path never reaches the consumeReplacementLeaveTx branch with a
 *  partial `need`; we assert that invariant so the TOIL consume-on-approve register is never under-consumed.
 *  `mixed` (Partial Leave Approval notification fix): the sole caller that sets it is decideLeaveDate's
 *  finalization when ≥1 date was approved AND ≥1 was rejected — it tags the approved-event payload so the
 *  notification renderer emits the honest "partially approved — see the breakdown" body instead of a flat
 *  "approved". It defaults to false/omitted so every non-per-date call site's event payload is byte-identical
 *  to today (the multi-step chain finalization and the single-step whole-request approval never pass it). */
/** The per-date outcome carried into a MIXED approval event so the notification renderer can list which
 *  dates were approved / rejected (and why) instead of a generic "see the breakdown". Only populated for the
 *  mixed case; omitted for every whole-request / all-approved caller so their payload stays byte-identical. */
type PerDateOutcome = { approved: string[]; rejected: { date: string; reason: string | null }[] };

async function finalizeLeaveApproval(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  daysOverride?: number,
  mixed = false,
  perDateOutcome?: PerDateOutcome,
) {
  const balance = await leaveBalance(tx, req.employmentId, req.leaveTypeId);
  const need = daysOverride ?? Number(req.days);
  if (balance - need < 0) throw new InsufficientLeaveBalanceError();
  // Combined Leave Type Limit (R44 4c48fd1f, Stage 2): re-check the shared pool at approval time (a second
  // approver / stale pending set could otherwise breach it). Exclude THIS request from the usage sum and add
  // its `need` back, so the pending row it represents is counted exactly once.
  await enforceCombinedLeaveLimit(tx, {
    employmentId: req.employmentId,
    leaveTypeId: req.leaveTypeId,
    startDate: req.startDate,
    requestedDays: need,
    excludeRequestId: req.id,
  });
  await tx.insert(leaveLedger).values({
    tenantId: ctx.tenantId,
    employmentId: req.employmentId,
    leaveTypeId: req.leaveTypeId,
    entryType: 'debit',
    days: (-need).toFixed(2),
    sourceRequestId: req.id,
    effectiveOn: req.startDate,
  });
  await tx
    .update(leaveRequest)
    .set({ status: 'approved', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  // Unpaid-leave payroll-impact: fetch the type's code + payroll-signal gate once. Both approval paths
  // (multi-step final clearance and single-step) funnel through this function, so the enrichment fires
  // exactly once at terminal approval and never at intermediate leave-request.step.approved.
  const [lt] = await tx
    .select({ code: leaveType.code, paid: leaveType.paid, sendToPayroll: leaveType.sendToPayroll })
    .from(leaveType)
    .where(eq(leaveType.id, req.leaveTypeId))
    .limit(1);
  // RL Control Engine (0113): when the consumed type is REPLACEMENT, decrement the toil_accrual register
  // FIFO-by-expiry so the active/expired split stays authoritative and the year-end close never double-debits
  // already-spent credits. The ledger debit above is the balance authority; this only updates the register.
  // NOT gated by TOIL_ENABLED (bug #21): if a register row exists it MUST be consumed on approval, else a
  // later expiry/close re-debits the full credit (negative balance + spurious convert-to-pay). The flag
  // gates accrual/UI, not this consume-on-approve invariant — consumeReplacementLeaveTx is a safe no-op
  // when there is no active accrual to decrement.
  if (lt?.code === 'REPLACEMENT') {
    // ADR-0068 §4E guard: a partial (per-date) debit must never reach REPLACEMENT — §4C excludes REPLACEMENT
    // from per-date approval, so daysOverride is always undefined here. Assert it so a future regression that
    // wires per-date approval to a REPLACEMENT type fails loudly instead of under-consuming the TOIL register.
    if (daysOverride !== undefined) {
      throw new Error('per-date (partial) approval is not supported for REPLACEMENT leave');
    }
    await consumeReplacementLeaveTx(tx, ctx, {
      employmentId: req.employmentId,
      requestId: req.id,
      need,
      effectiveOn: req.startDate,
    });
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.approved',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: {
      decision: 'approved',
      deciderEmploymentId: deciderEmploymentId ?? null,
      // Partial Leave Approval notification fix (ADR-0068 follow-up): only the mixed per-date outcome
      // (≥1 approved + ≥1 rejected) sets this. It is the single minimal signal the notification renderer
      // reads to emit the "partially approved" body. Omitted (not `mixed: false`) for every other caller so
      // the whole-request / all-approved payload shape stays byte-identical to today.
      ...(mixed ? { mixed: true } : {}),
      // Partial Leave Approval (R17 600be8ac): when mixed, carry the per-date breakdown into the payload so
      // the notification renderer emits a self-contained body listing the approved + rejected dates and the
      // rejection reason — the reporter's ask #5. Only spread when present ⇒ byte-identical for every other caller.
      ...(mixed && perDateOutcome ? { perDateOutcome } : {}),
      // When the type opts in (sendToPayroll), attach an ADVISORY payroll-impact contract for a future
      // payroll integration to consume. It is telemetry, NOT a deduction source: the authoritative deduction
      // remains unpaidDaysByEmployment()'s live status='approved' re-query (which auto-corrects on any future
      // cancellation/reversal). No payPeriod is emitted — the consumer derives it with its own cutoff rule.
      ...(lt?.sendToPayroll
        ? {
            payrollImpact: {
              employmentId: req.employmentId,
              leaveTypeId: req.leaveTypeId,
              leaveTypeCode: lt.code,
              // ADR-0068 §4E: for a per-date request the payroll-impact advisory reflects the APPROVED days,
              // not the raw request span (need === sum of approved dates when daysOverride is passed).
              days: daysOverride !== undefined ? need : req.days,
              startDate: req.startDate,
              endDate: req.endDate,
              approvalStatus: 'approved' as const,
            },
          }
        : {}),
    },
  });
}

/** Terminal rejection: status flip + event (no ledger write). */
async function finalizeLeaveRejection(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  extra?: Record<string, unknown>,
) {
  await tx
    .update(leaveRequest)
    .set({ status: 'rejected', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.rejected',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: { decision: 'rejected', deciderEmploymentId: deciderEmploymentId ?? null, ...(extra ?? {}) },
  });
}

/** Decide a leave request. With a multi-step chain (2B-1) this advances the current step and only
 *  finalizes when the last step clears; a rejection at any step is terminal. Without a chain it is a
 *  single approval (the original behavior). */
export async function decideLeave(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    // Partial Leave Approval (0131): a reason is MANDATORY whenever a date is rejected (so the employee knows
    // why). Enforced uniformly here for whole-request, single-day, half/hourly, and per-date-child rejections.
    rejectReason?: string;
  },
) {
  // Partial Leave Approval (0131): refuse a blank reject reason BEFORE opening the transaction, so a missing
  // reason persists nothing (no status flip, no ledger row, no event). Trim to reject whitespace-only input.
  const rejectReason = p.rejectReason?.trim() || null;
  if (p.decision === 'rejected' && !rejectReason) throw new MissingRejectReasonError();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);

    const steps = await tx
      .select()
      .from(leaveApprovalStep)
      .where(eq(leaveApprovalStep.leaveRequestId, req.id))
      .orderBy(asc(leaveApprovalStep.stepIndex));
    const current = steps.find((s) => s.status === 'pending');

    // Multi-step chain: decide the current step.
    if (steps.length > 0 && current) {
      // 6fadb036 (gap-close): dispatch to the right decider-authority for the step's kind (the full
      // 7-role vocabulary). direct_manager / department_head / business_unit_head / hr_admin / hr_manager /
      // payroll / custom_role each have their own resolver in assertCanDecideLeaveStep.
      await assertCanDecideLeaveStep(tx, ctx, req.employmentId, current.approverKind, 'leave request');
      await tx
        .update(leaveApprovalStep)
        .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
        .where(eq(leaveApprovalStep.id, current.id));
      if (p.decision === 'rejected') {
        // Partial Leave Approval (0131): stamp the mandatory reject reason onto the rejected event payload.
        await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { step: current.stepIndex, kind: current.approverKind, rejectReason });
        return { status: 'rejected' as const };
      }
      const next = steps.find((s) => s.stepIndex > current.stepIndex && s.status === 'pending');
      if (next) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: req.id,
          eventType: 'leave-request.step.approved',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { step: current.stepIndex, kind: current.approverKind, nextKind: next.approverKind },
        });
        return { status: 'pending' as const, advancedTo: next.approverKind };
      }
      await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
      return { status: 'approved' as const };
    }

    // Single-step (no chain) — original behavior.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));
    if (p.decision === 'approved') await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
    // Partial Leave Approval (0131): stamp the mandatory reject reason onto the rejected event payload.
    else await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { rejectReason });
    return { status: p.decision };
  });
}

// ═════════════ Partial Leave Approval — single-request per-date decision (ADR-0068) ═════════════

/** ADR-0068 §4A — the set of EFFECTIVELY-APPROVED leave dates per employment in [from, to]. This is the ONE
 *  authority every span consumer (attendance daily+monthly, roster onLeave, plannedAbsences, unpaid payroll)
 *  reads so a per-date request's interior REJECTED dates never count as leave anywhere. Semantics:
 *   - a request WITHOUT leave_request_date rows → expand [start,end] where the REQUEST status='approved'
 *     (the unchanged, cheap whole-span behaviour — full_day only, mirroring the consumers' existing filter);
 *   - a request WITH leave_request_date rows → the individual leave_dates whose ROW status='approved'.
 *  One SQL: LEFT JOIN leave_request_date and COALESCE(row status, request status). generate_series expands
 *  the whole-span (no-child) case to individual dates so the caller always gets a flat Set<date> per emp.
 *  full_day filter matches the consumers (half/hourly are worked partial days, never "on leave"). */
async function approvedLeaveDates(
  tx: Tx,
  empIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (empIds.length === 0) return out;
  const add = (emp: string, d: string) => {
    let s = out.get(emp);
    if (!s) out.set(emp, (s = new Set()));
    s.add(d);
  };

  // (a) per-date requests: every APPROVED sub-row in the window is one on-leave date.
  const dateRows = await tx
    .select({ employmentId: leaveRequest.employmentId, d: leaveRequestDate.leaveDate })
    .from(leaveRequestDate)
    .innerJoin(leaveRequest, eq(leaveRequest.id, leaveRequestDate.leaveRequestId))
    .where(
      and(
        inArray(leaveRequest.employmentId, empIds),
        eq(leaveRequest.durationType, 'full_day'),
        eq(leaveRequestDate.status, 'approved'),
        gte(leaveRequestDate.leaveDate, from),
        lte(leaveRequestDate.leaveDate, to),
      ),
    );
  for (const r of dateRows) add(r.employmentId, r.d);

  // (b) whole-span requests (no per-date rows): expand [start,end] ∩ [from,to] where the REQUEST is approved.
  const spanRows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      startDate: leaveRequest.startDate,
      endDate: leaveRequest.endDate,
    })
    .from(leaveRequest)
    .where(
      and(
        inArray(leaveRequest.employmentId, empIds),
        eq(leaveRequest.durationType, 'full_day'),
        eq(leaveRequest.status, 'approved'),
        lte(leaveRequest.startDate, to),
        gte(leaveRequest.endDate, from),
        sql`NOT EXISTS (SELECT 1 FROM leave_request_date x WHERE x.leave_request_id = ${leaveRequest.id})`,
      ),
    );
  for (const r of spanRows) {
    const lo = r.startDate < from ? from : r.startDate;
    const hi = r.endDate > to ? to : r.endDate;
    for (const d of eachDate(lo, hi)) add(r.employmentId, d);
  }
  return out;
}

/** ADR-0068 §4A (exported for the span consumers in attendance/roster/read). See approvedLeaveDates. */
export { approvedLeaveDates };

/** ADR-0068 §4D — decide ONE requested date of a per-date-approval request in the request detail view. The
 *  request itself stays a single inbox row; each date is approved/rejected here. Reject requires a reason
 *  (MissingRejectReasonError, enforced before the transaction). No ledger effect per date — the balance gate +
 *  single ledger debit run once at finalization (§4E) when no pending dates remain. Single-step only (reuses
 *  assertCanDecide), which §4C guarantees because per-date rows are only created for single-step companies. */
export async function decideLeaveDate(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    leaveDate: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    rejectReason?: string;
  },
) {
  const rejectReason = p.rejectReason?.trim() || null;
  if (p.decision === 'rejected' && !rejectReason) throw new MissingRejectReasonError();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);
    // Single-step authority (§4C): per-date rows only exist for single-step companies, so the whole-request
    // assertCanDecide (manager/admin, no self-approval) is the correct gate — no chain-step logic here.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));

    const [row] = await tx
      .select()
      .from(leaveRequestDate)
      .where(and(eq(leaveRequestDate.leaveRequestId, req.id), eq(leaveRequestDate.leaveDate, p.leaveDate)))
      .limit(1);
    if (!row) throw new Error('leave date not found on this request');
    if (row.status !== 'pending') throw new Error(`leave date is already ${row.status}`);

    await tx
      .update(leaveRequestDate)
      .set({
        status: p.decision,
        rejectReason: p.decision === 'rejected' ? rejectReason : null,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
      })
      .where(eq(leaveRequestDate.id, row.id));
    // Substrate: the per-date write is audited by this event on the leave-request aggregate.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.date.decided',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveDate: p.leaveDate, decision: p.decision, ...(rejectReason ? { rejectReason } : {}) },
    });

    // §4E finalization: only when NO pending dates remain (shared with the batch decideLeaveDates path).
    return finalizePerDateIfComplete(tx, ctx, req, p.deciderEmploymentId);
  });
}

/** §4E finalization tail, shared by the single-date decideLeaveDate and the batch decideLeaveDates. Re-reads
 *  every leave_request_date row: while any is still pending the request stays pending; once none are pending it
 *  finalizes exactly once — all-rejected ⇒ terminal rejection (no debit, per-date reasons captured);
 *  ≥1 approved ⇒ single ledger debit = sum(approved weighted days) + status='approved'. A MIXED outcome
 *  (≥1 approved AND ≥1 rejected) tags the approved event (mixed + perDateOutcome) so the employee's
 *  notification honestly reads "partially approved" and lists the approved/rejected dates + reason. */
async function finalizePerDateIfComplete(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
): Promise<{ status: 'pending' | 'approved' | 'rejected' }> {
  const remaining = await tx
    .select()
    .from(leaveRequestDate)
    .where(eq(leaveRequestDate.leaveRequestId, req.id));
  const stillPending = remaining.filter((d) => d.status === 'pending');
  if (stillPending.length > 0) return { status: 'pending' as const };

  const approved = remaining.filter((d) => d.status === 'approved');
  const rejected = remaining.filter((d) => d.status === 'rejected');
  if (approved.length === 0) {
    // All rejected → terminal rejection, no debit. Collect the per-date reasons for the audit trail.
    await finalizeLeaveRejection(tx, ctx, req, deciderEmploymentId, {
      rejectReason: rejected.map((d) => `${d.leaveDate}: ${d.rejectReason ?? ''}`).join('; '),
      perDate: rejected.map((d) => ({ date: d.leaveDate, rejectReason: d.rejectReason })),
    });
    return { status: 'rejected' as const };
  }
  // All-approved OR mixed (≥1 approved) → single ledger debit for sum(approved days) + status='approved'.
  // §4A makes balance/calendar/attendance/payroll count ONLY the approved dates regardless of top-level
  // status, so a mixed outcome uses 'approved' + per-date truth (no new "partially_approved" enum this round).
  const approvedDays = approved.reduce((s, d) => s + Number(d.days), 0);
  const mixed = rejected.length > 0;
  const perDateOutcome: PerDateOutcome | undefined = mixed
    ? {
        approved: approved.map((d) => d.leaveDate),
        rejected: rejected.map((d) => ({ date: d.leaveDate, reason: d.rejectReason })),
      }
    : undefined;
  await finalizeLeaveApproval(tx, ctx, req, deciderEmploymentId, approvedDays, mixed, perDateOutcome);
  return { status: 'approved' as const };
}

/** ADR-0068 §4D (R17 600be8ac) — decide MANY requested dates of a per-date-approval request in ONE submit.
 *  The approver fills the decision table (one row per requested date, Approve/Reject + a reason for each
 *  rejected date) and submits once. Same guards as decideLeaveDate: pending request, assertCanDecide, each
 *  date exists & is pending, every rejected date carries a non-blank reason (all validated BEFORE the write so
 *  a bad batch persists nothing). Applies every row update, appends one leave-request.date.decided event PER
 *  date (uniform audit stream), then runs the shared finalization once. Single-step only (§4C). */
export async function decideLeaveDates(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    decisions: { leaveDate: string; decision: 'approved' | 'rejected'; rejectReason?: string }[];
    deciderEmploymentId?: string;
  },
) {
  // Normalize + validate reject reasons BEFORE opening the transaction — a blank reason on any rejected date
  // aborts the whole batch and persists nothing (no status flip, no ledger row, no event).
  const decisions = p.decisions.map((d) => ({
    leaveDate: d.leaveDate,
    decision: d.decision,
    rejectReason: d.rejectReason?.trim() || null,
  }));
  if (decisions.length === 0) throw new Error('no decisions provided');
  for (const d of decisions) {
    if (d.decision === 'rejected' && !d.rejectReason) throw new MissingRejectReasonError();
  }
  // Reject a batch that names the same date twice (ambiguous decision).
  if (new Set(decisions.map((d) => d.leaveDate)).size !== decisions.length) {
    throw new Error('duplicate leave date in batch');
  }
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);
    // Single-step authority (§4C): per-date rows only exist for single-step companies.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));

    for (const d of decisions) {
      const [row] = await tx
        .select()
        .from(leaveRequestDate)
        .where(and(eq(leaveRequestDate.leaveRequestId, req.id), eq(leaveRequestDate.leaveDate, d.leaveDate)))
        .limit(1);
      if (!row) throw new Error('leave date not found on this request');
      if (row.status !== 'pending') throw new Error(`leave date is already ${row.status}`);
      await tx
        .update(leaveRequestDate)
        .set({
          status: d.decision,
          rejectReason: d.decision === 'rejected' ? d.rejectReason : null,
          decidedByEmploymentId: p.deciderEmploymentId ?? null,
          decidedAt: sql`now()`,
        })
        .where(eq(leaveRequestDate.id, row.id));
      // Substrate: one event per date keeps the audit stream identical to the single-date path.
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-request',
        aggregateId: req.id,
        eventType: 'leave-request.date.decided',
        actor: actorOf(ctx),
        subjectEmploymentId: req.employmentId,
        payload: { leaveDate: d.leaveDate, decision: d.decision, ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}) },
      });
    }
    return finalizePerDateIfComplete(tx, ctx, req, p.deciderEmploymentId);
  });
}

// ═════════════════════ Partial Leave Cancellation (ADR-0065) ═════════════════════
// After a leave is approved, the employee can give back a SUBSET of the approved dates. The approval splits
// the approved span into contiguous sibling leave_request rows (the Emergency-Leave parent_group_id model),
// each with its own ledger debit, then flips the cancelled segment(s) to status='cancelled' and reverses
// their debit. Because every span consumer (payroll unpaidDaysByEmployment, attendance onLeave,
// plannedAbsences) filters status='approved', a cancelled segment disappears from balance/calendar/payroll
// for free — no read-layer span math. See ADR-0065.

/** A working date paired with its leave-deduction weight (Feedback 31474452 4e) — 1 for a Full working day,
 *  0.5/1.0 for a Half day per the company toggle. */
export type WeightedDate = { date: string; weight: number };

/** Pure date math (no DB) so the service and tests share one implementation. Given the request's full ordered
 *  list of WORKING dates (each optionally carrying its deduction WEIGHT — Feedback 31474452 4e) and the set of
 *  dates to cancel, partition the working dates into maximal contiguous runs such that every cancelled date
 *  sits in its own single-date segment. Returns the segments (each `{ from, to, days }`, days = the SUM of the
 *  run's weights — 1 per date when no weights are supplied, so callers passing a plain `string[]` see exactly
 *  today's behaviour) in date order, plus the indexes of the segments that are fully cancelled. Cancelling ALL
 *  working dates yields every segment cancelled — the "cancel-all == cancel request" case falls out with no
 *  special path.
 *
 *  Accepts either a plain `string[]` (back-compat — every date weighs 1) or `WeightedDate[]` (the caller
 *  supplies each date's real weight, e.g. from dayWeight/resolveSchedule). */
export function splitSpanForCancellation(
  allWorkingDates: string[] | WeightedDate[],
  cancelDates: string[],
): { segments: { from: string; to: string; days: number }[]; cancelledSegmentIndexes: number[] } {
  const weighted: WeightedDate[] = allWorkingDates.map((d) =>
    typeof d === 'string' ? { date: d, weight: 1 } : d,
  );
  const cancelSet = new Set(cancelDates);
  const ordered = [...weighted].sort((a, b) => a.date.localeCompare(b.date));
  const segments: { from: string; to: string; days: number }[] = [];
  const cancelledSegmentIndexes: number[] = [];
  let run: WeightedDate[] = [];
  let runCancelled: boolean | null = null;
  const flush = () => {
    if (run.length === 0) return;
    const idx = segments.length;
    const days = round2(run.reduce((s, r) => s + r.weight, 0));
    segments.push({ from: run[0].date, to: run[run.length - 1].date, days });
    if (runCancelled) cancelledSegmentIndexes.push(idx);
    run = [];
    runCancelled = null;
  };
  for (const wd of ordered) {
    const isCancelled = cancelSet.has(wd.date);
    // A cancelled date is always its own single-date segment; a surviving date extends the current surviving
    // run. So flush whenever the cancelled-ness flips OR the current date is cancelled (force a new segment).
    if (run.length > 0 && (isCancelled || runCancelled !== isCancelled)) flush();
    run.push(wd);
    runCancelled = isCancelled;
    if (isCancelled) flush(); // a cancelled date never merges with a following date
  }
  flush();
  return { segments, cancelledSegmentIndexes };
}

/** ADR-0065 §4 — the request's real WORKING dates in [start, end] (roster + holiday aware, the SAME frame the
 *  service splits/validates against). Exported so the read layer can surface the exact cancellable candidates
 *  to the UI instead of a Mon–Fri heuristic that disagrees with the service (offering a holiday it rejects or
 *  hiding a working Saturday). This is a read of already-tx-bound calendar data — no mutation surface. */
export async function workingDatesForSpan(
  tx: Tx,
  employmentId: string,
  start: string,
  end: string,
  // Day Type Inclusion (feedback ef6d7146): the leave type's re-inclusion vector. When ABSENT (undefined ⇒
  // every existing type / all-off config) this is byte-identical to before (roster + holiday-aware working
  // dates). When present the cancellable candidate set additionally admits the re-included day types, so the
  // cancellation gate + give-back stay in agreement with how the leave was originally deducted.
  inclusion?: DayTypeInclusion,
): Promise<string[]> {
  const hols = await resolveHolidaySet(tx, employmentId, start, end);
  if (inclusion === undefined) {
    const workingDaysIso = await resolveWorkingDaysIso(tx, employmentId);
    return eachDate(start, end).filter((d) => isWorkingDay(d, workingDaysIso, hols));
  }
  const sched = await resolveSchedule(tx, employmentId);
  return eachDate(start, end).filter((d) => isDeductibleDay(d, sched, hols, inclusion));
}

/** ADR-0065 (R5 Build #2 — iterative cancellation). True when the parent_group_id names a CANCELLATION-SPLIT
 *  group (produced by decideLeaveCancellation), as opposed to an Emergency-Leave / per-date-approval group.
 *  A cancellation split ALWAYS leaves ≥1 sibling row with status='cancelled' sharing the group; an EL /
 *  per-date group never has a 'cancelled' sibling. So a surviving cancellation-split row (which now carries a
 *  parentGroupId) can still be cancelled again — the reporter's "give back Wednesday now, Thursday later"
 *  scenario — while genuine EL children stay blocked by the same gate. No discriminator column, no migration. */
async function isCancellationSplitGroup(tx: Tx, parentGroupId: string): Promise<boolean> {
  const [sib] = await tx
    .select({ id: leaveRequest.id })
    .from(leaveRequest)
    .where(and(eq(leaveRequest.parentGroupId, parentGroupId), eq(leaveRequest.status, 'cancelled')))
    .limit(1);
  return !!sib;
}

/** Resolve the person behind an employment (for the subject-only assertion). */
async function personIdForEmployment(tx: Tx, employmentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ personId: employment.personId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.personId ?? null;
}

/** True when the cancel date's payroll period (YYYY-MM by start date) has a CLOSED batch that already produced
 *  THIS employee's payslip — the deduction was finalised, so the day can't be retroactively given back
 *  (ADR-0065 §2). We join payroll_batch → payslip on the employee so the check works under the employee's own
 *  RLS session (an employee can see their own payslip, and therefore the batch it belongs to). Checking the
 *  employee's OWN finalised payslip is also more precise than "any closed batch in the period". */
async function cancelDatePeriodClosed(tx: Tx, employmentId: string, cancelDate: string): Promise<boolean> {
  const period = cancelDate.slice(0, 7); // YYYY-MM
  const [closed] = await tx
    .select({ id: payrollBatch.id })
    .from(payrollBatch)
    .innerJoin(payslip, eq(payslip.batchId, payrollBatch.id))
    .where(
      and(
        eq(payrollBatch.payPeriod, period),
        eq(payrollBatch.status, 'closed'),
        eq(payslip.employmentId, employmentId),
      ),
    )
    .limit(1);
  return !!closed;
}

/**
 * Employee-initiated request to cancel a SUBSET of an approved leave's dates. Runs every §2 gate + the §6
 * subject check + the §3 pending-overlap guard, then inserts a pending leave_cancellation_request and
 * appends `leave-cancellation.requested`. No ledger / leave_request change here — the give-back happens only
 * on manager approval (decideLeaveCancellation).
 */
export async function requestLeaveCancellation(
  ctx: SessionContext,
  // R5 Build #2 (Fix B — MYT boundary): `today` is injectable (default MYT, mirroring requestLeave) so the
  // "hasn't started yet" per-date gate uses Malaysia time, not a UTC-skewed global clock near midnight.
  p: { leaveRequestId: string; cancelDates: string[]; reason?: string; today?: string },
) {
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // §6(1): subject-only. RLS is symmetric (a manager can SEE a subordinate's leave) so the "employee-
    // initiated" rule is enforced here in code, not by RLS. Resolve the person behind the leave's employment
    // and require the caller is that person.
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveCancellationNotAllowedError('only the employee can cancel their own leave');
    }

    // §2 gates against the request itself.
    if (req.status !== 'approved') throw new LeaveCancellationNotAllowedError('the leave is not approved');
    if (req.durationType !== 'full_day') {
      throw new LeaveCancellationNotAllowedError('only full-day leave can be partially cancelled');
    }
    if (req.parentGroupId != null && !(await isCancellationSplitGroup(tx, req.parentGroupId))) {
      // Blocks Emergency-Leave / per-date-approval child rows (each already a single date under a group), but
      // ADMITS a surviving row of a prior CANCELLATION split so the employee can give back more days later
      // (R5 Build #2 — iterative cancellation; ADR-0065). A cancellation-split group is detected by a
      // 'cancelled' sibling; an EL / per-date group never has one.
      throw new LeaveCancellationNotAllowedError('this leave cannot be partially cancelled');
    }
    const [lt] = await tx
      // Day Type Inclusion (feedback ef6d7146): the type's re-inclusion vector — cancellation must offer + give
      // back exactly the day types the original deduction counted, or the ledger reversal/re-debit drifts.
      .select({ code: leaveType.code, dayTypeInclusion: leaveType.dayTypeInclusion })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);
    if (lt?.code === 'REPLACEMENT') {
      // Restoring a REPLACEMENT day via the ledger without re-crediting the toil_accrual register would
      // reintroduce the ghost-credit / negative-balance bug — and there is no inverse of consumeReplacementLeaveTx.
      throw new LeaveCancellationNotAllowedError('replacement (time-off-in-lieu) leave cannot be cancelled');
    }
    const cancelIncl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);

    // The request's working dates (the only cancellable dates), in the tenant calendar frame. Shared helper so
    // the read layer (UI candidate list) and this gate agree exactly (R5 Build #2 — Fix C, no Mon–Fri drift).
    let workingDates = await workingDatesForSpan(tx, req.employmentId, req.startDate, req.endDate, cancelIncl);
    // ADR-0068 §6: a per-date-approval request is now a single parentGroupId=NULL row, so it reaches here.
    // Its interior REJECTED dates are NOT approved leave — exclude them from the cancellable set so an employee
    // can only give back a date that was actually approved (mirrors §4A's effectively-approved-dates rule).
    const dateRows = await tx
      .select({ leaveDate: leaveRequestDate.leaveDate, status: leaveRequestDate.status })
      .from(leaveRequestDate)
      .where(eq(leaveRequestDate.leaveRequestId, req.id));
    if (dateRows.length > 0) {
      const approvedSet = new Set(dateRows.filter((d) => d.status === 'approved').map((d) => d.leaveDate));
      workingDates = workingDates.filter((d) => approvedSet.has(d));
    }
    const workingSet = new Set(workingDates);
    // Per-date future check: each cancelDate must be strictly after `today` (MYT — resolved at the top of this
    // function, injectable for tests). R5 Build #2 Fix B: was a UTC clock, wrong near KL midnight.
    const cancelDates = [...new Set(p.cancelDates.map((d) => d.trim()))].sort();
    if (cancelDates.length === 0) throw new LeaveCancellationDateInvalidError();
    for (const d of cancelDates) {
      if (!workingSet.has(d)) throw new LeaveCancellationDateInvalidError(d); // outside span or non-working day
      if (d <= today) throw new LeaveCancellationTooLateError(d); // per-date future gate
      if (await cancelDatePeriodClosed(tx, req.employmentId, d)) throw new LeaveCancellationPeriodClosedError(d);
    }

    // §3: another PENDING cancellation request on the same leave may already target one of these dates.
    // Reject the overlap so two pending requests can't both approve and double-restore.
    const pendings = await tx
      .select({ cancelDates: leaveCancellationRequest.cancelDates })
      .from(leaveCancellationRequest)
      .where(
        and(
          eq(leaveCancellationRequest.leaveRequestId, req.id),
          eq(leaveCancellationRequest.status, 'pending'),
        ),
      );
    const pendingSet = new Set(pendings.flatMap((r) => (r.cancelDates as string[]) ?? []));
    if (cancelDates.some((d) => pendingSet.has(d))) {
      throw new LeaveCancellationNotAllowedError('a pending cancellation already covers one of these dates');
    }

    // requestedDays = the WEIGHTED total of the cancel dates (Feedback 31474452 4e) — each is a working date
    // by the check above; a Half date contributes 0.5 (toggle OFF) or 1.0 (toggle ON) rather than always 1,
    // so the manager's approval screen previews the real give-back amount decideLeaveCancellation will apply.
    const hols = await resolveHolidaySet(tx, req.employmentId, req.startDate, req.endDate);
    const sched = await resolveSchedule(tx, req.employmentId);
    // Day Type Inclusion (feedback ef6d7146): weigh each cancel date through the SAME vector the leave was
    // deducted under (cancelIncl above), so a re-included public-holiday/rest date previews its real weight.
    const requestedDays = round2(cancelDates.reduce((s, d) => s + dayWeight(d, sched, hols, cancelIncl), 0));
    const [row] = await tx
      .insert(leaveCancellationRequest)
      .values({
        tenantId: ctx.tenantId,
        leaveRequestId: req.id,
        employmentId: req.employmentId,
        cancelDates,
        requestedDays: requestedDays.toFixed(2),
        reason: p.reason?.trim() || null,
        status: 'pending',
      })
      .returning({ id: leaveCancellationRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-cancellation-request',
      aggregateId: row.id,
      eventType: 'leave-cancellation.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveRequestId: req.id, cancelDates, requestedDays },
    });
    return { cancellationRequestId: row.id, requestedDays };
  });
}

/**
 * Manager decision on a cancellation request (single step). Reject ⇒ flip to 'rejected', nothing else. Approve
 * ⇒ in one transaction: split the approved span into contiguous sibling rows (each with its own debit), flip
 * the cancelled segment(s) to 'cancelled' and reverse their debit, and append events on BOTH aggregates.
 */
export async function decideLeaveCancellation(
  ctx: SessionContext,
  p: { cancellationRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cr] = await tx
      .select()
      .from(leaveCancellationRequest)
      .where(eq(leaveCancellationRequest.id, p.cancellationRequestId))
      .limit(1);
    if (!cr) throw new Error('cancellation request not found (or not visible)');
    if (cr.status !== 'pending') throw new Error(`cancellation request is already ${cr.status}`);

    // Self-approval ban + manager/admin authorization — service-layer (RLS is symmetric, §6(2)).
    await assertCanDecide(tx, ctx, cr.employmentId, 'leave cancellation', scopeOf('leave.cancellation'));

    if (p.decision === 'rejected') {
      await tx
        .update(leaveCancellationRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
        .where(eq(leaveCancellationRequest.id, cr.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-cancellation-request',
        aggregateId: cr.id,
        eventType: 'leave-cancellation.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: cr.employmentId,
        payload: { leaveRequestId: cr.leaveRequestId, cancelDates: cr.cancelDates },
      });
      return { status: 'rejected' as const };
    }

    // ── Approved ──────────────────────────────────────────────────────────────────────────────────────
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, cr.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found');
    // Re-assert the request is still a cancellable approved row. A prior cancellation may have split it (giving
    // it a parentGroupId) — that survivor is STILL cancellable (R5 Build #2 — iterative cancellation), so admit
    // a cancellation-split group here as well; only genuine EL / per-date children stay blocked.
    if (
      req.status !== 'approved' ||
      (req.parentGroupId != null && !(await isCancellationSplitGroup(tx, req.parentGroupId)))
    ) {
      throw new LeaveCancellationNotAllowedError('the leave is no longer in a cancellable state');
    }

    const cancelDates = (cr.cancelDates as string[]) ?? [];
    const hols = await resolveHolidaySet(tx, req.employmentId, req.startDate, req.endDate);
    // Day Type Inclusion (feedback ef6d7146): resolve the type's re-inclusion vector so the give-back split
    // spans exactly the day types the original debit counted. Without this a re-included rest/PH date would be
    // absent from workingDates, so sum(segment days) < req.days and the whole-span reversal below would
    // over-restore. undefined ⇒ byte-identical legacy split.
    const [decLt] = await tx
      .select({ dayTypeInclusion: leaveType.dayTypeInclusion })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);
    const decIncl = normalizeDayTypeInclusion(decLt?.dayTypeInclusion);
    // Feedback 31474452 (4e): resolve the CURRENT schedule/toggle config (as today — a pre-existing property,
    // not a new behaviour) and thread each working date's real WEIGHT through the split, so a cancelled Half
    // date gives back exactly the configured amount (0.5 OFF / 1.0 ON) instead of always 1.
    const sched = await resolveSchedule(tx, req.employmentId);
    const workingDates = eachDate(req.startDate, req.endDate)
      .filter((d) => isDeductibleDay(d, sched, hols, decIncl))
      .map((date) => ({ date, weight: dayWeight(date, sched, hols, decIncl) }));
    const { segments, cancelledSegmentIndexes } = splitSpanForCancellation(workingDates, cancelDates);

    // Split-and-cancel. We REUSE the original row id for the first segment (preserving attachments / FKs) and
    // create new sibling rows for the rest, all sharing a fresh parent_group_id. The original carried ONE
    // debit over the whole span (finalizeLeaveApproval), so we first reverse that whole-span debit, then give
    // each segment its own debit — net zero for survivors, net +1×cancelled-days restored for cancelled ones.
    const parentGroupId = randomUUID();
    // 1) Reverse the original whole-span debit (inverse of finalizeLeaveApproval's single debit).
    await tx.insert(leaveLedger).values({
      tenantId: ctx.tenantId,
      employmentId: req.employmentId,
      leaveTypeId: req.leaveTypeId,
      entryType: 'debit',
      days: Number(req.days).toFixed(2), // positive = reversal of the original negative debit
      sourceRequestId: req.id,
      effectiveOn: req.startDate, // same cycle/carry window as the original debit (window-consistent, §1 caveat)
    });

    const cancelledRowIds: string[] = [];
    const remainingDates: string[] = [];
    // R5 Build #2: surviving NEW sibling rows (i>0, approved). The attachment(s) live on the reused segment[0]
    // row only; when segment[0] is itself cancelled (the employee gave back the FIRST date), a survivor that is
    // NOT segment[0] would show no MC. So we copy the original attachment(s) onto these survivors after the loop.
    const survivingNewRowIds: string[] = [];
    let restoredDays = 0;
    let remainingDays = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isCancelled = cancelledSegmentIndexes.includes(i);
      const segDays = seg.days;
      let rowId: string;
      if (i === 0) {
        // Reuse the original row for the first segment (preserve its attachments / approval-step FKs).
        rowId = req.id;
        await tx
          .update(leaveRequest)
          .set({
            startDate: seg.from,
            endDate: seg.to,
            days: segDays.toFixed(2),
            parentGroupId,
            status: isCancelled ? 'cancelled' : 'approved',
          })
          .where(eq(leaveRequest.id, req.id));
      } else {
        const [created] = await tx
          .insert(leaveRequest)
          .values({
            tenantId: ctx.tenantId,
            employmentId: req.employmentId,
            leaveTypeId: req.leaveTypeId,
            startDate: seg.from,
            endDate: seg.to,
            days: segDays.toFixed(2),
            durationType: 'full_day',
            status: isCancelled ? 'cancelled' : 'approved',
            reason: req.reason,
            parentGroupId,
            decidedByEmploymentId: req.decidedByEmploymentId,
            decidedAt: req.decidedAt,
          })
          .returning({ id: leaveRequest.id });
        rowId = created.id;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: rowId,
          eventType: 'leave-request.split',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { parentGroupId, from: seg.from, to: seg.to, days: segDays },
        });
      }

      // Each segment gets its OWN debit sourced to its own row (mirrors the EL per-row sourcing). A cancelled
      // segment is NOT debited (its days were restored by the whole-span reversal above), so the net effect is
      // exactly: balance up + taken down by the cancelled days, survivors unchanged.
      if (!isCancelled) {
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: req.employmentId,
          leaveTypeId: req.leaveTypeId,
          entryType: 'debit',
          days: (-segDays).toFixed(2),
          sourceRequestId: rowId,
          effectiveOn: seg.from,
        });
        remainingDates.push(...eachDate(seg.from, seg.to).filter((d) => isDeductibleDay(d, sched, hols, decIncl)));
        remainingDays += segDays;
        if (i > 0) survivingNewRowIds.push(rowId); // a survivor that is NOT the reused segment[0] row
      } else {
        cancelledRowIds.push(rowId);
        restoredDays += segDays;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: rowId,
          eventType: 'leave-request.cancelled',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { cancelDate: seg.from, restoredDays: segDays, parentGroupId },
        });
      }
    }

    // R5 Build #2: copy the original request's attachment(s) onto surviving NEW sibling rows so the MC stays
    // visible on whichever survivor the employee holds — including when they gave back the FIRST date (segment[0]
    // is reused for that cancelled date, so its survivors are all new rows). The attachment rows live on req.id;
    // duplicating the (small) MC bytes onto each survivor keeps getLeaveAttachment(survivorId) truthful without a
    // schema change. Only runs when there IS at least one attachment AND at least one new-row survivor.
    if (survivingNewRowIds.length > 0) {
      const atts = await tx
        .select({
          content: leaveRequestAttachment.content,
          fileName: leaveRequestAttachment.fileName,
          mimeType: leaveRequestAttachment.mimeType,
          sizeBytes: leaveRequestAttachment.sizeBytes,
          uploadedByUserId: leaveRequestAttachment.uploadedByUserId,
        })
        .from(leaveRequestAttachment)
        .where(eq(leaveRequestAttachment.leaveRequestId, req.id));
      if (atts.length > 0) {
        await tx.insert(leaveRequestAttachment).values(
          survivingNewRowIds.flatMap((survivorId) =>
            atts.map((a) => ({
              tenantId: ctx.tenantId,
              leaveRequestId: survivorId,
              employmentId: req.employmentId,
              content: a.content as Buffer,
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              uploadedByUserId: a.uploadedByUserId,
            })),
          ),
        );
      }
    }

    await tx
      .update(leaveCancellationRequest)
      .set({ status: 'approved', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
      .where(eq(leaveCancellationRequest.id, cr.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-cancellation-request',
      aggregateId: cr.id,
      eventType: 'leave-cancellation.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveRequestId: req.id, parentGroupId, cancelledRowIds, restoredDays, remainingDays, remainingDates },
    });
    return { status: 'approved' as const, restoredDays, remainingDays, remainingDates };
  });
}

/**
 * HR-initiated cancellation of an employee's WHOLE leave request, on their behalf (feedback 22e68ff0).
 *
 * Unlike the employee-driven partial give-back (requestLeaveCancellation → decideLeaveCancellation), this is
 * an immediate, no-approval-workflow HR power: an HR admin cancels a PENDING or APPROVED leave for another
 * employee for operational/payroll/audit reasons. It flips the request to 'cancelled', restores the entitlement
 * balance (by reversing the net ledger debit), supersedes any open give-back on the same leave, and appends a
 * distinct `leave-request.admin-cancelled` event carrying the REAL HR actor (the audit must show HR did it,
 * not the employee) plus the display fields the employee notification needs.
 *
 * Deliberately NOT `assertCanDecide` (which admits managers) — immediate on-behalf cancellation is HR-only.
 * A manager keeps the existing decide paths. Company scope is free: the row is loaded under RLS, so a
 * company-scoped hr_admin can't see (⇒ can't cancel) another company's request.
 */
export async function adminCancelLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string; reason?: string; cancelledByEmploymentId?: string },
): Promise<{ previousStatus: 'pending' | 'approved'; restoredDays: number }> {
  return withTenant(ctx, async (tx) => {
    // HR-only. isAdmin() = hr_admin OR super_admin; a manager (or any other role) is refused here.
    if (!isAdmin(ctx)) {
      throw new LeaveCancellationNotAllowedError('only an HR administrator can cancel leave on behalf of an employee');
    }
    const isSuper = ctx.roles?.includes('super_admin') ?? false;

    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Self-ban: an HR admin's own leave goes through the normal employee flow, not this on-behalf power
    // (mirrors assertCanDecide's self-approval ban). super_admin keeps the sole-admin escape hatch.
    if (!isSuper) {
      const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
      if (ctx.personId && ctx.personId === subjectPersonId) {
        throw new LeaveCancellationNotAllowedError('an HR administrator cannot cancel their own leave here');
      }
    }

    // Status gate: only pending | approved are cancellable. Already-cancelled / rejected → refuse, naming the
    // current status (localizeLeaveError maps the typed error to the localized cancellationNotAllowed message).
    if (req.status !== 'pending' && req.status !== 'approved') {
      throw new LeaveCancellationNotAllowedError(`the leave is already ${req.status}`);
    }
    const previousStatus = req.status as 'pending' | 'approved';

    const [lt] = await tx
      .select({ code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);

    // An APPROVED REPLACEMENT (time-off-in-lieu) leave already consumed the toil_accrual register at approval,
    // and there is no inverse of consumeReplacementLeaveTx — restoring it via the ledger would reintroduce the
    // ghost-credit bug. A PENDING replacement never consumed the register, so it cancels cleanly.
    if (previousStatus === 'approved' && lt?.code === 'REPLACEMENT') {
      throw new LeaveCancellationNotAllowedError('replacement (time-off-in-lieu) leave cannot be cancelled');
    }

    // Closed-payroll gate: never retroactively alter a period whose payslip was finalised. For each DISTINCT
    // month spanned by the leave, reject if that employee's batch is closed. (HR may cancel past/started leave —
    // the admin override vs. the employee's future-only rule — but never a finalised payroll month.)
    const months = [...new Set(eachDate(req.startDate, req.endDate).map((d) => d.slice(0, 7)))];
    for (const m of months) {
      if (await cancelDatePeriodClosed(tx, req.employmentId, `${m}-01`)) {
        throw new LeaveCancellationPeriodClosedError(`${m}-01`);
      }
    }

    // ── Effect ──────────────────────────────────────────────────────────────────────────────────────────
    // 1) Restore the balance by reversing the NET ledger debit sourced to this request. Net-sum (not req.days)
    //    is robust to per-date partial approvals, survivors of a prior cancellation split (whose rows net to
    //    the survivor's current debit), half-day/hourly fractions, and unpaid types that never debited (net 0
    //    ⇒ nothing to reverse). Pending leave has no debit ⇒ net 0 ⇒ restoredDays 0.
    const [netRow] = await tx
      .select({ net: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
      .from(leaveLedger)
      .where(eq(leaveLedger.sourceRequestId, req.id));
    const net = Number(netRow?.net ?? 0);
    let restoredDays = 0;
    if (net < 0) {
      restoredDays = round2(-net);
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: req.employmentId,
        leaveTypeId: req.leaveTypeId,
        entryType: 'debit',
        days: restoredDays.toFixed(2), // positive = reversal of the original negative debit
        sourceRequestId: req.id,
        effectiveOn: req.startDate, // same cycle/carry window as the original debit
      });
    }

    // 2) Flip the request to cancelled. decidedByEmploymentId/decidedAt are left untouched (they record the
    //    ORIGINAL approval decision; the cancellation's who/when lives in the event below).
    await tx.update(leaveRequest).set({ status: 'cancelled' }).where(eq(leaveRequest.id, req.id));

    // 3) Supersede any open employee give-back on this leave, so no dangling pending card sits in /approvals
    //    (decideLeaveCancellation would then error on it). The column CHECK is pending|approved|rejected, so a
    //    superseded row becomes 'rejected' with HR as decider, plus a per-row rejected event.
    const openGiveBacks = await tx
      .select({ id: leaveCancellationRequest.id })
      .from(leaveCancellationRequest)
      .where(
        and(
          eq(leaveCancellationRequest.leaveRequestId, req.id),
          eq(leaveCancellationRequest.status, 'pending'),
        ),
      );
    if (openGiveBacks.length > 0) {
      await tx
        .update(leaveCancellationRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.cancelledByEmploymentId ?? null, decidedAt: sql`now()` })
        .where(
          and(
            eq(leaveCancellationRequest.leaveRequestId, req.id),
            eq(leaveCancellationRequest.status, 'pending'),
          ),
        );
      for (const gb of openGiveBacks) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-cancellation-request',
          aggregateId: gb.id,
          eventType: 'leave-cancellation.rejected',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { leaveRequestId: req.id, supersededByAdminCancellation: true },
        });
      }
    }

    // 4) Substrate discipline — the audit trail for this HR action. A DISTINCT event type (not the split
    //    machinery's leave-request.cancelled) so the notification registry keys the employee notice without
    //    also firing on a manager approving an employee's own give-back. Payload carries the display fields
    //    (type/dates) the notification renderer needs (renderers are payload-only) + the full audit facts.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.admin-cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: {
        previousStatus,
        newStatus: 'cancelled',
        restoredDays,
        reason: p.reason?.trim() || null,
        cancelledByEmploymentId: p.cancelledByEmploymentId ?? null,
        leaveTypeCode: lt?.code ?? null,
        leaveTypeName: lt?.name ?? null,
        startDate: req.startDate,
        endDate: req.endDate,
      },
    });

    return { previousStatus, restoredDays };
  });
}

// ═════════════════════ Edit / cancel own leave by status (item c9a19e34) ═════════════════════
// Employee self-service on their OWN leave, status-gated:
//   • PENDING  → editLeaveRequest (modify details, stays pending) + cancelOwnLeave (immediate self-withdraw).
//   • APPROVED → cancellation is routed through the manager-approved give-back flow (requestLeaveCancellation),
//                NOT an immediate unilateral self-cancel — that preserves the balance invariant + ADR-0065's
//                deliberate "a manager confirms giving back approved leave" rule. So cancelOwnLeave refuses a
//                non-pending row (the action layer sends approved rows to requestLeaveCancellation instead).
//   • REJECTED → view-only (no write path).
// The "creator-only" rule lives in the SERVICE (RLS is symmetric — a manager can SEE a subordinate's leave —
// so the subject assertion is enforced in code, mirroring requestLeaveCancellation :2614-2620). v1 restricts
// both edit and self-withdraw to PLAIN single-request rows (parentGroupId null, no per-date sub-rows, not an
// EL/REPLACEMENT type): an Emergency-Leave submission is two coupled child rows and a per-date-approval span
// carries its own decision sub-rows, so editing/withdrawing just one half would strand the other. Those groups
// keep the existing give-back / admin-cancel paths and are deferred to a later pass.

/**
 * Edit a PENDING leave request in place, keeping it pending. Subject-only (the creator). Re-runs the same
 * validation gates requestLeave applies (eligibility, backdating 0133, min-advance 0159, duration allow-list,
 * document/remark, day recompute) against the NEW details, updates the row, and regenerates the approval-step
 * chain (day count / type may have changed the scoped chain). Pending leave has NO ledger debit (the debit
 * posts only at final approval :1915) so there is nothing to reverse. Appends `leave-request.edited`
 * {before, after, diff} for the audit trail (CLAUDE.md substrate discipline).
 */
export async function editLeaveRequest(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    employeeRemark?: string;
    durationType?: LeaveDurationType;
    fromTime?: string;
    toTime?: string;
    today?: string;
  },
): Promise<{ leaveRequestId: string; days: number }> {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Subject-only: RLS is symmetric so the creator-only rule is enforced here (mirrors requestLeaveCancellation).
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveEditNotAllowedError('only the employee who applied can edit their leave');
    }

    // Status gate: only a PENDING request is editable (expected_function 3.i — "available only for pending").
    if (req.status !== 'pending') throw new LeaveEditNotAllowedError(`the leave is already ${req.status}`);

    // v1 edge-case exclusions: plain single-request rows only.
    if (req.parentGroupId != null) {
      throw new LeaveEditNotAllowedError('grouped (emergency / split) leave cannot be edited here');
    }
    const [hasDateRows] = await tx
      .select({ id: leaveRequestDate.id })
      .from(leaveRequestDate)
      .where(eq(leaveRequestDate.leaveRequestId, req.id))
      .limit(1);
    if (hasDateRows) {
      throw new LeaveEditNotAllowedError('per-date-approval leave cannot be edited here');
    }

    const [lt] = await tx
      .select({
        code: leaveType.code,
        name: leaveType.name,
        counting: leaveType.counting,
        eligibility: leaveType.eligibility,
        // Probation eligibility (d6bdbd55): merged into the eligibility object below (same as requestLeave).
        probationEligibility: leaveType.probationEligibility,
        dayTypeInclusion: leaveType.dayTypeInclusion,
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        durations: leaveType.durations,
        backdatingLimitDays: leaveType.backdatingLimitDays,
        minAdvanceDays: leaveType.minAdvanceDays,
        customMessages: leaveType.customMessages,
        // Duplicate Leave Application Restriction (d5e51c34): same-date double-booking policy — enforced below
        // after the AM/PM slot-clash guard, EXCLUDING this very request. null ⇒ 'allow'.
        duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
        // Configurable Negative Leave Balance Validation (0ef0defd): submit/edit-time balance guard flag —
        // enforced below (excluding this very request from its own pending reservation). false ⇒ block.
        allowNegativeBalance: leaveType.allowNegativeBalance,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    if (!lt) throw new Error('leave type not found');
    // EMERGENCY / REPLACEMENT decompose or consume registers — never edited in place (v1).
    if (lt.code === EMERGENCY_LEAVE_CODE || lt.code === 'REPLACEMENT') {
      throw new LeaveEditNotAllowedError('this leave type cannot be edited here');
    }

    // ── Re-validate the NEW details (fail fast, same gates + errors as requestLeave) ─────────────────────
    const baseElig = (lt.eligibility ?? null) as LeaveEligibility | null;
    const probation = (lt.probationEligibility ?? null) as ProbationEligibility | null;
    const elig: LeaveEligibility | null =
      baseElig || probation ? { ...(baseElig ?? {}), ...(probation ? { probation } : {}) } : null;
    if (elig && (elig.gender || elig.maritalStatus || elig.minServiceMonths || elig.probation)) {
      const [emp] = await tx
        .select({
          gender: person.gender,
          marital: person.maritalStatus,
          hiredOn: employment.hiredOn,
          confirmationDate: employment.confirmationDate,
          finalConfirmationDate: employment.finalConfirmationDate,
        })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, req.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
    }

    const today = p.today ?? todayInKualaLumpur();
    if (!isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, lt.backdatingLimitDays ?? null)) {
      throw new LeaveBackdatingNotAllowedError(
        lt.backdatingLimitDays!,
        lt.name,
        lt.customMessages?.backdatingLimitDays || undefined,
      );
    }
    if (!isAdmin(ctx) && lacksMinAdvanceNotice(p.startDate, today, lt.minAdvanceDays ?? null)) {
      throw new LeaveAdvanceNoticeRequiredError(
        lt.minAdvanceDays!,
        lt.name,
        lt.customMessages?.minAdvanceDays || undefined,
      );
    }

    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    let fromTime: string | null = null;
    let toTime: string | null = null;
    let hours: number | null = null;
    if (durationType === 'hourly') {
      if (p.fromTime || p.toTime) {
        hours = hoursBetween(p.fromTime ?? '', p.toTime ?? '');
        fromTime = (p.fromTime ?? '').slice(0, 5);
        toTime = (p.toTime ?? '').slice(0, 5);
      } else {
        throw new HourlyLeaveTimeRangeError();
      }
    }
    if (durationType !== 'full_day') {
      const allow = (lt.durations as string[] | null) ?? [];
      if (!allow.includes(durationType)) throw new LeaveDurationNotAllowedError();
      if (p.startDate !== p.endDate) {
        throw new Error('Half-day and hourly leave must be a single day (start and end dates must match)');
      }
    }

    let workingDayCount: number | null = null;
    let workingDayWeight: number | null = null;
    if (lt.counting === 'working_days') {
      const hols = await resolveHolidaySet(tx, req.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, req.employmentId);
      const incl = normalizeDayTypeInclusion(lt.dayTypeInclusion);
      workingDayCount = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl)).length;
      workingDayWeight = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt.counting === 'working_days' ? workingDayWeight! : dayCount(p.startDate, p.endDate);
    } else {
      if (lt.counting === 'working_days' && workingDayCount === 0) throw new LeaveNoDaysInRangeError();
      if (durationType === 'hourly') {
        const h = hours ?? 0;
        if (!(h > 0 && h <= 24)) throw new Error('Hourly leave must be more than 0 and at most 24 hours');
        days = Math.round((h / DEFAULT_STANDARD_HOURS) * 100) / 100;
      } else {
        days = 0.5;
      }
      // AM/PM same-date conflict guard, EXCLUDING this very request (an edit must not clash with itself).
      const existing = await tx
        .select({ durationType: leaveRequest.durationType })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, req.employmentId),
            eq(leaveRequest.startDate, p.startDate),
            eq(leaveRequest.endDate, p.endDate),
            inArray(leaveRequest.status, ['pending', 'approved']),
            sql`${leaveRequest.id} <> ${req.id}`,
          ),
        );
      for (const e of existing) {
        const conflicts =
          e.durationType === durationType ||
          e.durationType === 'full_day' ||
          e.durationType === 'hourly' ||
          durationType === 'hourly';
        if (conflicts) throw new Error('This date already has a conflicting leave request');
      }
    }

    // Duplicate Leave Application Restriction (d5e51c34): mirror of the requestLeave guard, EXCLUDING this very
    // request (an edit must not clash with itself). Runs for ALL durations. Range-overlap (not same-slot) of a
    // pending/approved application; 'restrict_same' scopes to the SAME type, 'restrict_any' matches any type.
    // 'allow'/null ⇒ no extra check. Fires for admins too (data-integrity rule, not a permission).
    const dupPolicy = lt.duplicateApplicationPolicy ?? 'allow';
    if (dupPolicy === 'restrict_same' || dupPolicy === 'restrict_any') {
      const overlap = await tx
        .select({ id: leaveRequest.id })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, req.employmentId),
            inArray(leaveRequest.status, ['pending', 'approved']),
            lte(leaveRequest.startDate, p.endDate),
            gte(leaveRequest.endDate, p.startDate),
            sql`${leaveRequest.id} <> ${req.id}`,
            ...(dupPolicy === 'restrict_same' ? [eq(leaveRequest.leaveTypeId, p.leaveTypeId)] : []),
          ),
        )
        .limit(1);
      if (overlap.length > 0) throw new DuplicateLeaveApplicationError();
    }

    if (days <= 0) throw new LeaveNoDaysInRangeError();

    // Configurable Negative Leave Balance Validation (0ef0defd): submit/edit-time balance guard, mirroring the
    // requestLeave check. availableLeaveBalance EXCLUDES this very request (req.id) from its own pending
    // reservation, so the NEW days are re-checked against everything else. allow_negative_balance=false ⇒ block
    // an edit that would take the balance negative; =true ⇒ skip. round2 matches the leave math.
    if (lt.allowNegativeBalance === false) {
      const available = await availableLeaveBalance(tx, req.employmentId, p.leaveTypeId, req.id);
      if (round2(available - days) < 0) throw new InsufficientLeaveBalanceOnSubmitError();
    }

    // Document + remark gates (identical to requestLeave). hasDocument = an attachment already exists on this
    // request (edit does not re-upload; changing to a doc-required type with no attachment is refused).
    const [att] = await tx
      .select({ id: leaveRequestAttachment.id })
      .from(leaveRequestAttachment)
      .where(eq(leaveRequestAttachment.leaveRequestId, req.id))
      .limit(1);
    const hasDocument = !!att;
    if (lt.requiresDocument && !hasDocument) {
      const after = lt.mandatoryAfterDays;
      if (after == null || after === 0 || days > after) {
        throw new LeaveDocumentRequiredError(lt.name, after ?? undefined);
      }
    }
    const employeeRemark = p.employeeRemark?.trim() || null;
    if (lt.employeeRemarkRequired && !employeeRemark) throw new LeaveRemarkRequiredError(lt.name);

    // ── Apply the edit ───────────────────────────────────────────────────────────────────────────────────
    const before = {
      leaveTypeId: req.leaveTypeId,
      startDate: req.startDate,
      endDate: req.endDate,
      days: Number(req.days),
      durationType: req.durationType,
      reason: req.reason,
      employeeRemark: req.employeeRemark,
    };
    await tx
      .update(leaveRequest)
      .set({
        leaveTypeId: p.leaveTypeId,
        startDate: p.startDate,
        endDate: p.endDate,
        days: days.toFixed(2),
        durationType,
        hours: hours != null ? hours.toFixed(2) : null,
        fromTime,
        toTime,
        reason: p.reason?.trim() || null,
        employeeRemark,
      })
      .where(eq(leaveRequest.id, req.id));

    // Regenerate the approval-step chain from scratch — the day count / leave type may now resolve a different
    // scoped chain. Only pending steps existed (the request is pending), so deleting + regenerating is safe.
    await tx.delete(leaveApprovalStep).where(eq(leaveApprovalStep.leaveRequestId, req.id));
    await generateApprovalSteps(tx, ctx.tenantId, req.id, req.employmentId, p.leaveTypeId, days);

    const after = {
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      days,
      durationType,
      reason: p.reason?.trim() || null,
      employeeRemark,
    };
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      if ((before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]) {
        diff[k] = { before: (before as Record<string, unknown>)[k], after: (after as Record<string, unknown>)[k] };
      }
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.edited',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { before, after, diff },
    });

    return { leaveRequestId: req.id, days };
  });
}

/**
 * Employee self-withdrawal of their OWN PENDING leave — an immediate cancel (no approval workflow), because a
 * pending request was never approved so there is nothing for a manager to confirm giving back. Subject-only.
 * Restricted to PENDING (an approved row must go through requestLeaveCancellation's manager-approved give-back,
 * per Option A / ADR-0065). Pending leave has no ledger debit (net 0 ⇒ nothing to restore); the net-sum
 * reversal is kept for defense-in-depth. Appends a DISTINCT `leave-request.self-cancelled` event (separate
 * from admin-cancelled + give-back) so the notification registry can key "notify approver + HR" (req 4.v).
 */
export async function cancelOwnLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string },
): Promise<{ previousStatus: 'pending'; restoredDays: number }> {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Subject-only (creator). Enforced in code (RLS is symmetric).
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveCancellationNotAllowedError('only the employee can cancel their own leave');
    }

    // Status gate: PENDING only. An approved row is routed to the give-back flow at the action layer.
    if (req.status !== 'pending') {
      throw new LeaveCancellationNotAllowedError(
        req.status === 'approved'
          ? 'approved leave must be cancelled through the give-back flow'
          : `the leave is already ${req.status}`,
      );
    }
    // v1: plain single-request rows only (an EL child would strand its sibling).
    if (req.parentGroupId != null) {
      throw new LeaveCancellationNotAllowedError('grouped (emergency / split) leave cannot be cancelled here');
    }

    const [lt] = await tx
      .select({ code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);

    // Reverse the NET ledger debit (net 0 for pending ⇒ restoredDays 0; kept robust for defense-in-depth).
    const [netRow] = await tx
      .select({ net: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
      .from(leaveLedger)
      .where(eq(leaveLedger.sourceRequestId, req.id));
    const net = Number(netRow?.net ?? 0);
    let restoredDays = 0;
    if (net < 0) {
      restoredDays = round2(-net);
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: req.employmentId,
        leaveTypeId: req.leaveTypeId,
        entryType: 'debit',
        days: restoredDays.toFixed(2),
        sourceRequestId: req.id,
        effectiveOn: req.startDate,
      });
    }

    await tx.update(leaveRequest).set({ status: 'cancelled' }).where(eq(leaveRequest.id, req.id));

    // Substrate: distinct self-cancelled event (audit + notification key). Carries the display fields the
    // approver/HR notification renderer needs (payload-only renderers).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.self-cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: {
        previousStatus: 'pending',
        newStatus: 'cancelled',
        restoredDays,
        leaveTypeCode: lt?.code ?? null,
        leaveTypeName: lt?.name ?? null,
        startDate: req.startDate,
        endDate: req.endDate,
      },
    });

    return { previousStatus: 'pending', restoredDays };
  });
}

// ───────────────────── Leave-year boundary (STATUTORY-SOURCES §5) ─────────────────────

/** Types granted as standing yearly entitlements; situational types are claimed per event. */
export const STANDING_LEAVE_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION'] as const;

/**
 * Carry-forward-report feature — reason codes stamped on the AUTOMATIC negative `adjustment` rows the
 * carry-forward engine posts (openLeaveYear cap-excess, accrueEarnedLeave 2D-3 cap-excess, and
 * expireCarriedLeave's later expiry forfeit). Prefixed `sys:` — no human would type this, and
 * grantAdHocLeave only ever writes POSITIVE days (validated `days <= 0` throws), so a machine-forfeit
 * reason can never collide with a human festive-grant reason under the (leaveTypeId, effectiveOn,
 * reason) idempotency key (core/leave.ts grantAdHocLeave). Purely additive tagging — no behaviour
 * change to any forfeit amount, timing, or idempotency check (all of which stay reason-blind).
 */
export const CARRY_FORFEIT_REASON_CAP = 'sys:carry_forward_cap';
export const CARRY_FORFEIT_REASON_EXPIRY = 'sys:carry_forward_expiry';
/**
 * Leave Type Expiry Field (fec49317) — reason stamped on the automatic negative `adjustment` the
 * expireAgedLeave sweep posts when an earned portion lapses `leave_type.expiry_value expiry_unit` after the
 * date it was earned. A DISTINCT `sys:` code so its idempotency (reason + date + magnitude) can never
 * collide with the carry-forward forfeit codes above or a human festive-grant reason. Reason-blind readers
 * (leaveBalance, leaveEntitlementBreakdown) treat it exactly like any other negative adjustment — the day
 * leaves the balance but stays a real ledger row, so it remains visible in reports.
 */
export const AGED_FORFEIT_REASON = 'sys:leave_type_expiry';
/**
 * Configurable Earned Leave Entitlement Rules (feedback 49809272) — reason PREFIX stamped on the
 * compensating `adjustment` rows `reprojectEntitlementForPolicy` posts when an admin corrects an
 * entitlement policy IN PLACE (updateLeavePolicy). The full reason is `sys:policy_recalc:<policyId>` so
 * the audit trail names the exact policy version that drove the correction. `sys:`-prefixed like the
 * forfeit codes above, so it can never collide with a human festive-grant reason. Rows carrying this
 * prefix count as "already granted this cycle" in BOTH the recalc's own delta (idempotency — a re-saved
 * identical correction computes delta 0) and accrueEarnedLeave's top-up sum (so the monthly cron never
 * re-grants a delta the recalc already posted).
 */
export const POLICY_RECALC_REASON_PREFIX = 'sys:policy_recalc';

/** Completed years of service at a date (calendar-accurate, not /365.25). */
export const serviceYearsAt = (hiredOn: string, asOf: string): number => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let y = a.getUTCFullYear() - h.getUTCFullYear();
  if (
    a.getUTCMonth() < h.getUTCMonth() ||
    (a.getUTCMonth() === h.getUTCMonth() && a.getUTCDate() < h.getUTCDate())
  ) {
    y -= 1;
  }
  return Math.max(0, y);
};

/**
 * Length of service between `hiredOn` and `asOf` broken into whole years + residual whole months — the
 * "XX Years XX Months" reference figure shown on the Employment tab (feedback 24c4d02e). Pure + UTC-correct
 * calendar math, consistent with serviceYearsAt (its `.years` equals serviceYearsAt for the same inputs). A
 * future `asOf` before `hiredOn` clamps to { years: 0, months: 0 }. Display-only; drives no entitlement.
 */
export const serviceYearsMonthsAt = (
  hiredOn: string,
  asOf: string,
): { years: number; months: number } => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let months =
    (a.getUTCFullYear() - h.getUTCFullYear()) * 12 + (a.getUTCMonth() - h.getUTCMonth());
  if (a.getUTCDate() < h.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12 };
};

/**
 * Open a leave year: for every active employment hired before 1 Jan of `year`, post the
 * new year's accrual per standing type at the employee's CURRENT service band — so the
 * 2y/5y band upgrades happen here — resolved as max(statutory floor, company policy).
 *
 * Carry-forward: ANNUAL carries up to the policy's `carryForwardMax` (statutory default
 * 0 — s.60E expects leave taken within the year); the rest is forfeited via a negative
 * adjustment. SICK / HOSPITALIZATION are per-calendar-year entitlements and reset.
 *
 * Idempotent: a Jan-1 accrual for an (employment, type) pair marks that pair open — a
 * Jan-1 hire grant counts too, which is exactly right. Hires during `year` are skipped
 * entirely (their hire grant covers the year). Overdrawn balances are never "forfeited"
 * (the debt simply rolls and the new grant lands on top).
 */
// ── Leave Year Configuration (9aa894a4) ──────────────────────────────────────────────────────────────
/** Row shape returned to the admin surface (the managed leave-year table). Dates are ISO yyyy-mm-dd. */
export type LeaveYearConfigView = {
  id: string;
  year: number;
  status: LeaveYearStatus;
  openLeaveYearDate: string | null;
  employeeApplicationStartDate: string | null;
  // Future Leave Year Opening Rule (d9e41725): the advance-opening policy attached to this row.
  openingRuleEnabled: boolean;
  openBeforeAmount: number | null;
  openBeforeUnit: LeaveOpeningUnit | null;
  openedAt: string | null;
  openedBy: string | null;
};

/** List every managed leave-year record for the tenant, newest year first. Read-only (RLS: tenant-read). */
export async function listLeaveYearConfigs(ctx: SessionContext): Promise<LeaveYearConfigView[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(leaveYearConfig)
      .where(eq(leaveYearConfig.tenantId, ctx.tenantId))
      .orderBy(desc(leaveYearConfig.year));
    return rows.map((r) => ({
      id: r.id,
      year: r.year,
      status: (isLeaveYearStatus(r.status) ? r.status : 'draft') as LeaveYearStatus,
      openLeaveYearDate: r.openLeaveYearDate ?? null,
      employeeApplicationStartDate: r.employeeApplicationStartDate ?? null,
      openingRuleEnabled: r.openingRuleEnabled,
      openBeforeAmount: r.openBeforeAmount ?? null,
      openBeforeUnit: isLeaveOpeningUnit(r.openBeforeUnit) ? r.openBeforeUnit : null,
      openedAt: r.openedAt ? r.openedAt.toISOString() : null,
      openedBy: r.openedBy ?? null,
    }));
  });
}

/** Create or edit a managed leave-year record's two control dates (status is NOT changed here — use
 *  setLeaveYearStatus for the Draft→Open transition). Idempotent on (tenant, year). Appends
 *  leave-year.configured. Substrate: config write → event. */
export async function upsertLeaveYearConfig(
  ctx: SessionContext,
  p: { year: number; openLeaveYearDate?: string | null; employeeApplicationStartDate?: string | null },
) {
  if (!Number.isInteger(p.year) || p.year < 2020 || p.year > 2100) {
    throw new Error('Invalid leave year (must be an integer between 2020 and 2100)');
  }
  const openDate = p.openLeaveYearDate?.trim() || null;
  const appStart = p.employeeApplicationStartDate?.trim() || null;
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select()
      .from(leaveYearConfig)
      .where(and(eq(leaveYearConfig.tenantId, ctx.tenantId), eq(leaveYearConfig.year, p.year)))
      .limit(1);
    const [row] = await tx
      .insert(leaveYearConfig)
      .values({
        tenantId: ctx.tenantId,
        year: p.year,
        status: 'draft',
        openLeaveYearDate: openDate,
        employeeApplicationStartDate: appStart,
      })
      .onConflictDoUpdate({
        target: [leaveYearConfig.tenantId, leaveYearConfig.year],
        // Status is left untouched on edit (only setLeaveYearStatus moves the lifecycle).
        set: { openLeaveYearDate: openDate, employeeApplicationStartDate: appStart, updatedAt: new Date() },
      })
      .returning({ id: leaveYearConfig.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: row.id,
      eventType: 'leave-year.configured',
      actor: actorOf(ctx),
      payload: {
        year: p.year,
        before: before
          ? { openLeaveYearDate: before.openLeaveYearDate ?? null, employeeApplicationStartDate: before.employeeApplicationStartDate ?? null }
          : null,
        after: { openLeaveYearDate: openDate, employeeApplicationStartDate: appStart },
      },
    });
    return { id: row.id };
  });
}

/**
 * Transition a managed leave-year record's status. On →open, CALL the existing openLeaveYear grant sweep
 * (idempotent — never duplicated here) so the record and the ledger move in lockstep, then stamp opened_at /
 * opened_by on the record. draft/closed transitions just flip the badge (v1: closed is informational, no
 * carry-forward sweep). Substrate: each write appends leave-year.configured (the status change), and →open
 * additionally emits leave-year.opened via openLeaveYear.
 */
export async function setLeaveYearStatus(ctx: SessionContext, p: { year: number; status: LeaveYearStatus }) {
  if (!Number.isInteger(p.year) || p.year < 2020 || p.year > 2100) {
    throw new Error('Invalid leave year (must be an integer between 2020 and 2100)');
  }
  const target: LeaveYearStatus = isLeaveYearStatus(p.status) ? p.status : 'draft';
  // On →open, run the grant sweep FIRST in its own transaction (idempotent; emits leave-year.opened). Doing
  // it before the record write keeps record + ledger in lockstep even if a caller retries.
  let opened: { granted: number; skipped: number; forfeits: number } | null = null;
  if (target === 'open') {
    opened = await openLeaveYear(ctx, { year: p.year });
  }
  const result = await withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select()
      .from(leaveYearConfig)
      .where(and(eq(leaveYearConfig.tenantId, ctx.tenantId), eq(leaveYearConfig.year, p.year)))
      .limit(1);
    const now = new Date();
    const openedAt = target === 'open' ? now : (before?.openedAt ?? null);
    const openedBy = target === 'open' ? (ctx.userId ?? null) : (before?.openedBy ?? null);
    const [row] = await tx
      .insert(leaveYearConfig)
      .values({
        tenantId: ctx.tenantId,
        year: p.year,
        status: target,
        openedAt,
        openedBy,
      })
      .onConflictDoUpdate({
        target: [leaveYearConfig.tenantId, leaveYearConfig.year],
        set: { status: target, openedAt, openedBy, updatedAt: now },
      })
      .returning({ id: leaveYearConfig.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: row.id,
      eventType: 'leave-year.configured',
      actor: actorOf(ctx),
      payload: {
        year: p.year,
        before: { status: (before?.status ?? 'draft') as LeaveYearStatus },
        after: { status: target },
        ...(opened ? { opened } : {}),
      },
    });
    return { id: row.id, status: target };
  });
  return { ...result, opened };
}

// ── Future Leave Year Opening Rule (d9e41725) ─────────────────────────────────────────────────────────
/** The advance-opening window unit. Days / Weeks / Months, mirroring the reporter's field. */
export type LeaveOpeningUnit = 'days' | 'weeks' | 'months';
export const LEAVE_OPENING_UNITS: readonly LeaveOpeningUnit[] = ['days', 'weeks', 'months'] as const;
export function isLeaveOpeningUnit(v: unknown): v is LeaveOpeningUnit {
  return typeof v === 'string' && (LEAVE_OPENING_UNITS as readonly string[]).includes(v);
}

/**
 * Compute the advance opening date for a leave `year`: 1-Jan-of-year MINUS `amount × unit`, returned as ISO
 * yyyy-mm-dd. Pure + UTC-correct calendar math (mirrors serviceYearsAt / subtractMonths — NEVER amount/365.25):
 *   - days   → subtract `amount` calendar days
 *   - weeks  → subtract `amount × 7` calendar days
 *   - months → subtract `amount` WHOLE calendar months (day clamped to the target month's length)
 * The anchor is deliberately the LEAVE YEAR START (Jan 1). Example: LY2027, 14 days → 2026-12-18; LY2027,
 * 1 month → 2026-12-01; LY2027, 2 weeks → 2026-12-18. Amount must be a positive integer.
 */
export function computeOpenLeaveYearDate(year: number, amount: number, unit: LeaveOpeningUnit): string {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Open-before amount must be a positive integer');
  }
  const leaveYearStart = `${year}-01-01`;
  if (unit === 'months') return subtractMonths(leaveYearStart, amount);
  const days = unit === 'weeks' ? amount * 7 : amount;
  // Calendar-day subtraction via a UTC epoch (no DST/timezone drift — dates are date-only).
  const [y, m, d] = leaveYearStart.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - days);
  const ty = base.getUTCFullYear();
  const tm = base.getUTCMonth() + 1;
  const td = base.getUTCDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
}

/**
 * Save the Future Leave Year Opening Rule for a leave `year` (the "Effective Leave Year"). This is the
 * advance-opening POLICY layered on the managed leave_year_config row (9aa894a4): HR Admin says "open this
 * year `amount` `unit` before it starts" and the system COMPUTES open_leave_year_date = Jan-1-minus-window and
 * stamps it on the same row. Idempotent on (tenant, year) — upserts the record (creating it as `draft` if it
 * does not exist, matching upsertLeaveYearConfig). Lifecycle `status` is left untouched here.
 *
 * v1 is COMPUTE-ONLY (a documented product decision): enabling the rule SETS open_leave_year_date but does NOT
 * auto-transition the year to `open`. An automatic cron (open the year once today >= open_leave_year_date) is
 * DEFERRED — when built it belongs in scripts/ (like accrue-earned.ts), iterating tenants under RLS, relying
 * on openLeaveYear's idempotent openedSet. Disabling the rule (enabled=false) clears the rule columns and
 * leaves open_leave_year_date as-is (a previously computed date is not wiped — an admin can still edit it by
 * hand via upsertLeaveYearConfig). Substrate: config write → leave-year.opening-rule.configured.
 */
export async function saveFutureOpeningRule(
  ctx: SessionContext,
  p: { year: number; enabled: boolean; amount?: number | null; unit?: string | null },
) {
  if (!Number.isInteger(p.year) || p.year < 2020 || p.year > 2100) {
    throw new Error('Invalid leave year (must be an integer between 2020 and 2100)');
  }
  let amount: number | null = null;
  let unit: LeaveOpeningUnit | null = null;
  let computedOpenDate: string | null = null;
  if (p.enabled) {
    amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Open-before amount must be a positive integer when the rule is enabled');
    }
    if (!isLeaveOpeningUnit(p.unit)) {
      throw new Error('Unit must be one of days, weeks, months when the rule is enabled');
    }
    unit = p.unit;
    computedOpenDate = computeOpenLeaveYearDate(p.year, amount, unit);
  }
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select()
      .from(leaveYearConfig)
      .where(and(eq(leaveYearConfig.tenantId, ctx.tenantId), eq(leaveYearConfig.year, p.year)))
      .limit(1);
    const now = new Date();
    // When enabling, the computed date overwrites open_leave_year_date. When disabling, keep whatever date is
    // already on the record (don't wipe a hand-set/previously-computed date) and null out the rule columns.
    const openLeaveYearDate = p.enabled ? computedOpenDate : (before?.openLeaveYearDate ?? null);
    const [row] = await tx
      .insert(leaveYearConfig)
      .values({
        tenantId: ctx.tenantId,
        year: p.year,
        status: 'draft',
        openLeaveYearDate,
        openingRuleEnabled: p.enabled,
        openBeforeAmount: amount,
        openBeforeUnit: unit,
      })
      .onConflictDoUpdate({
        target: [leaveYearConfig.tenantId, leaveYearConfig.year],
        // Status stays untouched (only setLeaveYearStatus moves the lifecycle). open_leave_year_date is only
        // rewritten when enabling; on disable it is left as-is via the openLeaveYearDate computed above.
        set: {
          openLeaveYearDate,
          openingRuleEnabled: p.enabled,
          openBeforeAmount: amount,
          openBeforeUnit: unit,
          updatedAt: now,
        },
      })
      .returning({ id: leaveYearConfig.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: row.id,
      eventType: 'leave-year.opening-rule.configured',
      actor: actorOf(ctx),
      payload: {
        year: p.year,
        before: before
          ? {
              openingRuleEnabled: before.openingRuleEnabled,
              openBeforeAmount: before.openBeforeAmount ?? null,
              openBeforeUnit: before.openBeforeUnit ?? null,
              openLeaveYearDate: before.openLeaveYearDate ?? null,
            }
          : null,
        after: {
          openingRuleEnabled: p.enabled,
          openBeforeAmount: amount,
          openBeforeUnit: unit,
          openLeaveYearDate,
        },
      },
    });
    return { id: row.id, openLeaveYearDate, enabled: p.enabled };
  });
}

// ── Benefit Scheme entitlement resolution for the grant sweeps (feedback b83c6a3b) ───────────────────
/** The per-employee attributes the scheme resolver needs beyond what the grant loops already select. */
type SchemeEmp = {
  employmentId: string;
  companyId: string;
  gradeId: string | null;
  overrideSchemeId: string | null;
};

/**
 * Build the scheme-entitlement lookup used by openLeaveYear / accrueEarnedLeave. Pre-loads (all within the
 * current tenant tx): every benefit scheme, the grade→group membership map, the current-assignment
 * employment type per employee, and the scheme×leave-type service-band tables — then resolves each
 * employee's EFFECTIVE scheme once (override → auto-match → none via `resolveEffectiveSchemeId`). Returns a
 * closure `(employmentId, leaveTypeId, serviceYears) => number | null`: the scheme's band days for that
 * service length, or null when the employee has no scheme or the scheme has no entitlement for the type
 * (⇒ caller falls back to the grade leave_policy days). READ-ONLY — no events (CLAUDE.md skip rule).
 */
async function buildSchemeEntitlementResolver(
  tx: Tx,
  emps: SchemeEmp[],
  typeIds: string[],
): Promise<(employmentId: string, leaveTypeId: string, serviceYears: number) => number | null> {
  const empIds = emps.map((e) => e.employmentId);
  if (empIds.length === 0 || typeIds.length === 0) return () => null;

  const schemes = await tx
    .select({
      id: benefitScheme.id,
      companyId: benefitScheme.companyId,
      employmentType: benefitScheme.employmentType,
      gradeGroupId: benefitScheme.gradeGroupId,
      status: benefitScheme.status,
    })
    .from(benefitScheme);
  // No schemes at all ⇒ pure back-compat: everyone resolves via the grade policy.
  if (schemes.length === 0) return () => null;
  const schemeRows: BenefitSchemeRow[] = schemes.map((s) => ({
    id: s.id,
    companyId: s.companyId,
    employmentType: s.employmentType,
    gradeGroupId: s.gradeGroupId,
    status: s.status,
  }));

  // grade → group membership.
  const distinctGradeIds = [...new Set(emps.map((e) => e.gradeId).filter((g): g is string => !!g))];
  const gradeGroupByGrade = new Map<string, string>();
  if (distinctGradeIds.length) {
    const members = await tx
      .select({ gradeId: gradeGroupMember.gradeId, gradeGroupId: gradeGroupMember.gradeGroupId })
      .from(gradeGroupMember)
      .where(inArray(gradeGroupMember.gradeId, distinctGradeIds));
    for (const m of members) gradeGroupByGrade.set(m.gradeId, m.gradeGroupId);
  }

  // Current-assignment employment type per employee (validTo / supersededAt null = the current row).
  const assigns = await tx
    .select({ employmentId: assignment.employmentId, employmentType: assignment.employmentType })
    .from(assignment)
    .where(
      and(
        inArray(assignment.employmentId, empIds),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    );
  const empTypeByEmp = new Map<string, string>();
  for (const a of assigns) empTypeByEmp.set(a.employmentId, a.employmentType);

  // Resolve each employee's effective scheme id once.
  const schemeByEmp = new Map<string, string | null>();
  for (const e of emps) {
    const gradeGroupId = e.gradeId ? (gradeGroupByGrade.get(e.gradeId) ?? null) : null;
    const sid = resolveEffectiveSchemeId(schemeRows, {
      companyId: e.companyId,
      employmentType: empTypeByEmp.get(e.employmentId) ?? null,
      gradeGroupId,
      overrideSchemeId: e.overrideSchemeId,
    });
    schemeByEmp.set(e.employmentId, sid);
  }

  // Scheme × leave-type service bands, only for the schemes actually resolved (bounded query).
  const usedSchemeIds = [...new Set([...schemeByEmp.values()].filter((s): s is string => !!s))];
  const bandsBySchemeType = new Map<string, unknown>();
  if (usedSchemeIds.length) {
    const ents = await tx
      .select({
        benefitSchemeId: schemeLeaveEntitlement.benefitSchemeId,
        leaveTypeId: schemeLeaveEntitlement.leaveTypeId,
        serviceBands: schemeLeaveEntitlement.serviceBands,
      })
      .from(schemeLeaveEntitlement)
      .where(
        and(
          inArray(schemeLeaveEntitlement.benefitSchemeId, usedSchemeIds),
          inArray(schemeLeaveEntitlement.leaveTypeId, typeIds),
        ),
      );
    for (const en of ents) bandsBySchemeType.set(`${en.benefitSchemeId}|${en.leaveTypeId}`, en.serviceBands);
  }

  return (employmentId: string, leaveTypeId: string, serviceYears: number): number | null => {
    const sid = schemeByEmp.get(employmentId);
    if (!sid) return null;
    const bands = bandsBySchemeType.get(`${sid}|${leaveTypeId}`);
    if (bands === undefined) return null;
    return schemeBandDays(bands, serviceYears);
  };
}

export async function openLeaveYear(ctx: SessionContext, p: { year: number }) {
  return withTenant(ctx, async (tx) => {
    const yearStart = `${p.year}-01-01`;

    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(and(inArray(leaveType.code, [...STANDING_LEAVE_CODES]), isNull(leaveType.archivedAt)));
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        country: company.country,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        benefitSchemeId: employment.benefitSchemeId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          lt(employment.hiredOn, yearStart),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        ),
      );
    if (types.length === 0 || emps.length === 0) return { granted: 0, skipped: 0, forfeits: 0 };
    const empIds = emps.map((e) => e.employmentId);
    const typeIds = types.map((t) => t.id);

    const already = await tx
      .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, typeIds),
          eq(leaveLedger.entryType, 'accrual'),
          eq(leaveLedger.effectiveOn, yearStart),
        ),
      );
    const openedSet = new Set(already.map((r) => `${r.employmentId}|${r.leaveTypeId}`));

    // ADR-0069: skip any (employment, leave type) with an ACTIVE frozen encashment snapshot — the balance
    // is locked, so this sweep must not touch it. The DB trigger would reject the write anyway; skipping
    // here avoids aborting the whole batch on one frozen employee.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, typeIds);

    // 2E (ADR-0041): active policies per type as of Jan 1, grouped so each employee resolves the policy
    // for their grade (resolveGradePolicy) — same resolution the hire grant uses.
    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, companyId: leavePolicy.companyId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          inArray(leavePolicy.leaveTypeId, typeIds),
          lte(leavePolicy.validFrom, yearStart),
          or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, yearStart)),
        ),
      );
    const policyByType = new Map<string, GradePolicyRow[]>();
    for (const pol of policies) {
      const arr = policyByType.get(pol.leaveTypeId);
      if (arr) arr.push(pol);
      else policyByType.set(pol.leaveTypeId, [pol]);
    }

    // Benefit Scheme & Leave Entitlement (b83c6a3b): resolve each employee's scheme entitlement days for the
    // standing types. Returns null (fall back to grade policy) when no scheme is assigned/matched. Byte-
    // identical behaviour for tenants with no schemes (the resolver short-circuits to `() => null`).
    const schemeDaysFor = await buildSchemeEntitlementResolver(
      tx,
      emps.map((e) => ({
        employmentId: e.employmentId,
        companyId: e.companyId,
        gradeId: e.gradeId,
        overrideSchemeId: e.benefitSchemeId,
      })),
      typeIds,
    );

    const balances = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(and(inArray(leaveLedger.employmentId, empIds), inArray(leaveLedger.leaveTypeId, typeIds)))
      .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
    const balanceBy = new Map(balances.map((b) => [`${b.employmentId}|${b.leaveTypeId}`, Number(b.balance)]));

    let granted = 0;
    let skipped = 0;
    let forfeits = 0;
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) continue;
      const years = serviceYearsAt(e.hiredOn, yearStart);
      for (const t of types) {
        const key = `${e.employmentId}|${t.id}`;
        if (openedSet.has(key)) {
          skipped += 1;
          continue;
        }
        if (frozenSet.has(key)) {
          skipped += 1; // ADR-0069: leave balance frozen for encashment
          continue;
        }
        // Leave Entitlement Rules Engine: `years` (service at year-open) drives custom band upgrades here,
        // same as the statutory floor's own 2y/5y band upgrades.
        const pol = resolveGradePolicy(policyByType.get(t.id) ?? [], e.gradeId, e.companyId, years);
        // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not this lump grant.
        if (isEarnedMethod(pol?.method)) continue;
        // Benefit Scheme (b83c6a3b): a resolved scheme entitlement SUPERSEDES the grade policy days for this
        // type; the EA-1955 floor still clamps on top (Math.max below). null ⇒ no scheme ⇒ use policy days.
        const schemeDays = schemeDaysFor(e.employmentId, t.id, years);
        const policyDays = schemeDays ?? (pol?.days ?? 0);
        const days = Math.max(pack.leave.entitlement(t.code, years), policyDays);
        if (days <= 0) continue;
        const before = balanceBy.get(key) ?? 0;
        // Carry-forward enhancement: ANNUAL carries only when the explicit toggle is on (back-compat
        // default = cap > 0). When disabled, carryMax collapses to 0 ⇒ full forfeit — the requested
        // "disable carry" behaviour. SICK/HOSPITALIZATION stay 0 (statutory annual reset, EA s.60F).
        const carryMax = t.code === 'ANNUAL' && carryEnabled(pol) ? (pol?.carryMax ?? 0) : 0;
        const rawCarry = Math.min(Math.max(before, 0), carryMax);
        // Feedback 9d8cf621 — Maximum Balance Days: clamp the carry-in AND this year's grant so the
        // resulting balance (carry + grant) never exceeds the resolved band's cap. Reducing the carry
        // increases the forfeit below by construction (forfeit = before − carry). No cap ⇒ pass-through.
        const { carry, grant: grantDays } = applyMaxBalance(rawCarry, days, pol?.maxBalanceDays);
        const forfeit = Math.max(0, before - carry);
        if (forfeit > 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: yearStart,
            reason: CARRY_FORFEIT_REASON_CAP,
          });
          forfeits += 1;
        }
        // Feedback 9d8cf621: post the (possibly Maximum-Balance-clamped) grant. The row is ALWAYS written —
        // even at 0 days when the cap is already reached — because it is openLeaveYear's own idempotency
        // open-marker (openedSet) and the expiry sweep's "year was opened" marker.
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: e.employmentId,
          leaveTypeId: t.id,
          entryType: 'accrual',
          days: grantDays.toFixed(2),
          effectiveOn: yearStart,
        });
        granted += 1;
      }
    }

    // One summary event; the ledger rows are the per-item audit (high-volume per-item
    // writes with their own append-only table — deliberate substrate skip).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave-year.opened',
      actor: actorOf(ctx),
      payload: { year: p.year, granted, skipped, forfeits },
    });
    return { granted, skipped, forfeits };
  });
}

// ── Earned accrual (ADR-0040 / 2D-1) ──────────────────────────────────────────────────────────────
/** Lump-sum policies (the default) grant at hire + year-open; these earn through the year instead. */
export const EARNED_METHODS = ['earned_monthly', 'earned_quarterly'] as const;
export function isEarnedMethod(m: unknown): m is (typeof EARNED_METHODS)[number] {
  return m === 'earned_monthly' || m === 'earned_quarterly';
}
/** Accrual periods from `start` through `asOf`, inclusive of the current period (month or quarter). */
function accrualPeriods(start: string, asOf: string, method: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ay, am] = asOf.split('-').map(Number);
  if (method === 'earned_quarterly') {
    return Math.max(0, (ay - sy) * 4 + (Math.floor((am - 1) / 3) - Math.floor((sm - 1) / 3)) + 1);
  }
  return Math.max(0, (ay - sy) * 12 + (am - sm) + 1);
}

/** ADR-0040 2D-2: the start of an employee's current earned-accrual cycle as of `asOf`.
 *  calendar → 1 Jan of asOf's year. anniversary → the most-recent hire-month anniversary on/before
 *  asOf (so each employee's cycle is anchored to their hire month; a joiner's first cycle starts at
 *  hire). Returns ISO yyyy-mm-01. */
export function earnedCycleStart(hiredOn: string, asOf: string, cycle: string | null | undefined): string {
  if (cycle !== 'anniversary') return `${asOf.slice(0, 4)}-01-01`;
  const hireMonth = hiredOn.slice(5, 7);
  const [ay, am] = asOf.split('-').map(Number);
  const cycleYear = am >= Number(hireMonth) ? ay : ay - 1;
  return `${cycleYear}-${hireMonth}-01`;
}

// ── Grade-based policy resolution (ADR-0041 / 2E) — extracted to ./leave-compute (RSC-safe pure module,
// see its header) and re-exported below via the `export {` block near the top of this file's imports so
// every existing caller/test keeps importing GradePolicyRow / resolveGradePolicy / carryEnabled / etc. from
// '@/core/leave' unchanged. Leave Entitlement Rules Engine (feedback a0228655) added serviceBands +
// bandDaysFor + previewEntitlement there and made resolveGradePolicy's serviceYears param required.

// ── Run Earned Accrual — scope + preview (feedback 2c7c6385) ────────────────────────────────────────
/** One grouped row of the "Run Earned Accrual" preview/summary table — Company × Grade × Leave Type.
 *  `entitlementGenerated` is the Σ of the actual per-employee top-ups (`toGrant`) for the group, so the
 *  preview (dryRun) and the real commit produce IDENTICAL numbers (they share one computation pass). */
export type EarnedAccrualGroup = {
  companyId: string;
  companyName: string;
  gradeId: string | null;
  gradeName: string | null;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  /** Distinct active employees in this Company×Grade whose resolved policy for the type is earned. */
  employeeCount: number;
  /** The accrual leave year (asOf's year) — the "Accrual Period" column. */
  accrualPeriod: number;
  /** 'earned_monthly' | 'earned_quarterly' — the resolved accrual method for the group. */
  method: string;
  /** Σ of per-employee `toGrant` (days) for the group. */
  entitlementGenerated: number;
};
export type EarnedAccrualResult = {
  granted: number;
  forfeits: number;
  breakdown: EarnedAccrualGroup[];
};

/**
 * Leave Year → asOf mapping for the "Run Earned Accrual" scope selector (feedback 2c7c6385, product
 * decision 1). The engine derives the accrual cycle from `asOf.slice(0,4)`, so the chosen Leave Year must
 * map to an asOf INSIDE that year:
 *  • current year  → today (progressive, to-date accrual — identical to the bare button / monthly cron).
 *  • past year     → that year's 31-Dec (full historical cycle; idempotent, harmless if already run).
 *  • future year   → that year's 31-Dec (full-year projection — this is the "600 days = 50×12" case in the
 *                    spec: HR opens next year and generates its full entitlement ahead of time).
 * A naive min(today, {year}-12-31) would collapse a FUTURE year to today (→ the wrong year's cycle), so the
 * branch is by year comparison, not a numeric min. Exported for the scope test.
 */
export function asOfForLeaveYear(year: number, today: string): string {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (today < yearStart) return yearEnd; // future year → full-year projection
  if (today > yearEnd) return yearEnd; // past year → full cycle
  return today; // current year → to-date
}

/** ADR-0040: top every earned policy up to the amount accrued by `asOf`. Idempotent — only the
 *  shortfall is written — so it is safe to run repeatedly (admin button + monthly cron, 2D-2).
 *  The cycle is per company (`leave_cycle`): calendar (1 Jan, joiners pro-rate from their join month)
 *  or anniversary (each employee's cycle anchored to their hire-month anniversary). The full-cycle
 *  total equals max(EA-floor, policy days), so the statutory floor still holds.
 *
 *  Feedback 2c7c6385 (Run Earned Accrual button): the manual admin trigger now carries an optional SCOPE
 *  ({companyIds, gradeIds, leaveTypeIds}) and a `dryRun` flag, and returns a GROUPED breakdown accumulated
 *  in the SAME pass as the commit. When `dryRun` is set NOTHING is written (no ledger inserts, no event) —
 *  the returned breakdown/counters are exactly what a real run would produce, so the HR preview can never
 *  lie. Absent scope filters ⇒ "all" on that axis (byte-identical to the cron's unscoped run). */
export async function accrueEarnedLeave(
  ctx: SessionContext,
  p: {
    asOf: string;
    companyIds?: string[];
    gradeIds?: string[];
    leaveTypeIds?: string[];
    dryRun?: boolean;
  },
): Promise<EarnedAccrualResult> {
  const scopeCompanyIds = (p.companyIds ?? []).filter(Boolean);
  const scopeGradeIds = (p.gradeIds ?? []).filter(Boolean);
  const scopeTypeIds = (p.leaveTypeIds ?? []).filter(Boolean);
  const dryRun = p.dryRun === true;
  const accrualPeriod = Number(p.asOf.slice(0, 4));
  return withTenant(ctx, async (tx): Promise<EarnedAccrualResult> => {
    const yearStart = `${p.asOf.slice(0, 4)}-01-01`;
    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(
        and(
          inArray(leaveType.code, [...STANDING_LEAVE_CODES]),
          isNull(leaveType.archivedAt),
          // Leave-Type scope filter (feedback 2c7c6385). Empty ⇒ all standing types.
          scopeTypeIds.length ? inArray(leaveType.id, scopeTypeIds) : undefined,
        ),
      );
    const typeIds = types.map((t) => t.id);
    if (typeIds.length === 0) return { granted: 0, forfeits: 0, breakdown: [] };

    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, companyId: leavePolicy.companyId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          inArray(leavePolicy.leaveTypeId, typeIds),
          lte(leavePolicy.validFrom, p.asOf),
          or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, p.asOf)),
        ),
      );
    // 2E (ADR-0041): group active policies per type so each employee resolves the policy for their grade.
    // A type is "earned" if ANY of its active policies is earned — that tells us which ledger rows to read
    // for the already-accrued sum; the per-employee resolution below decides what actually accrues.
    const policyByType = new Map<string, GradePolicyRow[]>();
    for (const pol of policies) {
      const arr = policyByType.get(pol.leaveTypeId);
      if (arr) arr.push(pol);
      else policyByType.set(pol.leaveTypeId, [pol]);
    }
    const earnedTypeIds = [...policyByType.entries()]
      .filter(([, rows]) => rows.some((r) => isEarnedMethod((r.accrual as { method?: string } | null)?.method)))
      .map(([id]) => id);
    if (earnedTypeIds.length === 0) return { granted: 0, forfeits: 0, breakdown: [] };

    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        country: company.country,
        leaveCycle: company.leaveCycle,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        companyName: company.legalName,
        benefitSchemeId: employment.benefitSchemeId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          lte(employment.hiredOn, p.asOf),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
          // Scope filters (feedback 2c7c6385). Empty axis ⇒ all (matches countEmployeesInScope).
          scopeCompanyIds.length ? inArray(employment.companyId, scopeCompanyIds) : undefined,
          scopeGradeIds.length ? inArray(employment.gradeId, scopeGradeIds) : undefined,
        ),
      );
    if (emps.length === 0) return { granted: 0, forfeits: 0, breakdown: [] };
    const empIds = emps.map((e) => e.employmentId);

    // Benefit Scheme & Leave Entitlement (b83c6a3b): resolve each employee's scheme entitlement days for the
    // earned types. When a scheme is assigned+matched and carries an entitlement for the type, its band days
    // SUPERSEDE the grade policy's `days` as the annual accrual TARGET (the accrual cadence/method still
    // comes from the earned grade policy). null ⇒ no scheme ⇒ use policy days (byte-identical back-compat).
    const schemeDaysFor = await buildSchemeEntitlementResolver(
      tx,
      emps.map((e) => ({
        employmentId: e.employmentId,
        companyId: e.companyId,
        gradeId: e.gradeId,
        overrideSchemeId: e.benefitSchemeId,
      })),
      earnedTypeIds,
    );

    // Grade-name lookup for the grouped preview breakdown (feedback 2c7c6385). A null gradeId row is the
    // ungraded/company-default bucket — no jobGrade name.
    const gradeNameById = new Map<string, string>();
    const distinctGradeIds = [...new Set(emps.map((e) => e.gradeId).filter((g): g is string => !!g))];
    if (distinctGradeIds.length) {
      const gradeRows = await tx
        .select({ id: jobGrade.id, name: jobGrade.name })
        .from(jobGrade)
        .where(inArray(jobGrade.id, distinctGradeIds));
      for (const g of gradeRows) gradeNameById.set(g.id, g.name);
    }
    // Grouped breakdown accumulator, keyed company|grade|type — filled in the SAME pass as the commit so
    // the dryRun preview and the real run are guaranteed to report identical numbers (preview-must-not-lie).
    const groupBy = new Map<
      string,
      { companyId: string; companyName: string; gradeId: string | null; leaveTypeId: string; method: string; count: number; entitlementGenerated: number }
    >();

    // 2D-2: the cycle start varies per employee (calendar = yearStart; anniversary = their hire-month
    // anniversary), so we can't sum "already accrued this cycle" in SQL with one bound. Fetch the
    // trailing ~12 months of accrual rows (covers any cycle start) and sum per employee in JS below.
    const accrualFrom = `${Number(p.asOf.slice(0, 4)) - 1}-${p.asOf.slice(5, 7)}-01`;
    const accrualRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, earnedTypeIds),
          // Feedback 49809272: the `already` sum must ALSO see the compensating `sys:policy_recalc:*`
          // adjustments an in-place policy correction posts mid-cycle (reprojectEntitlementForPolicy) —
          // otherwise this top-up would re-grant the same delta on top of the recalc credit. No
          // pre-existing row carries that reason, so behaviour is byte-identical for tenants that never
          // corrected a policy in place.
          or(
            eq(leaveLedger.entryType, 'accrual'),
            and(
              eq(leaveLedger.entryType, 'adjustment'),
              like(leaveLedger.reason, `${POLICY_RECALC_REASON_PREFIX}:%`),
            ),
          ),
          gte(leaveLedger.effectiveOn, accrualFrom),
        ),
      );
    const accrualRowsBy = new Map<string, { days: number; effectiveOn: string }[]>();
    for (const r of accrualRows) {
      const k = `${r.employmentId}|${r.leaveTypeId}`;
      const row = { days: Number(r.days), effectiveOn: r.effectiveOn };
      const arr = accrualRowsBy.get(k);
      if (arr) arr.push(row);
      else accrualRowsBy.set(k, [row]);
    }

    // 2D-3 (ADR-0040): cap carried-forward earned leave at the cycle boundary. openLeaveYear skips earned
    // types, so this is where their carry-forward cap lands. Group employees by their cycle start (≤12
    // distinct month-starts for anniversary, 1 for calendar) so the prior-cycle balance + the "already
    // forfeited this cycle" guard stay bounded queries, not one-per-employee.
    const byCycleStart = new Map<string, string[]>();
    for (const e of emps) {
      const cs = earnedCycleStart(e.hiredOn, p.asOf, e.leaveCycle);
      const arr = byCycleStart.get(cs);
      if (arr) arr.push(e.employmentId);
      else byCycleStart.set(cs, [e.employmentId]);
    }
    const priorBalanceBy = new Map<string, number>(); // emp|type -> balance carried into the current cycle
    const forfeited = new Set<string>(); // emp|type that already has a boundary forfeit at its cycle start
    for (const [cs, ids] of byCycleStart) {
      const prior = await tx
        .select({
          employmentId: leaveLedger.employmentId,
          leaveTypeId: leaveLedger.leaveTypeId,
          sum: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            lt(leaveLedger.effectiveOn, cs),
          ),
        )
        .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
      for (const r of prior) priorBalanceBy.set(`${r.employmentId}|${r.leaveTypeId}`, Number(r.sum));
      // A boundary forfeit is an adjustment dated exactly at the cycle start; its presence means we've
      // already rolled this (emp, type) over (idempotency — also skips if a manual adjustment lands there).
      const adj = await tx
        .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            eq(leaveLedger.entryType, 'adjustment'),
            eq(leaveLedger.effectiveOn, cs),
          ),
        );
      for (const r of adj) forfeited.add(`${r.employmentId}|${r.leaveTypeId}`);
    }

    // ADR-0069: skip (employment, leave type) pairs with an ACTIVE frozen encashment snapshot.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, earnedTypeIds);

    let granted = 0;
    let forfeits = 0;
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) continue;
      // 2D-2: the cycle start anchors both the entitlement band (service years measured at it) and the
      // accrual window. Calendar joiners still pro-rate from their join month; anniversary employees
      // accrue from their own cycle start (which, for a joiner, is their hire month).
      const cycleStart = earnedCycleStart(e.hiredOn, p.asOf, e.leaveCycle);
      const years = serviceYearsAt(e.hiredOn, cycleStart);
      for (const typeId of earnedTypeIds) {
        // 2E: this employee's grade may resolve to a lump (or no) policy even when the type is earned for
        // another grade — accrue only when THEIR resolved policy is earned. ADR-0066: scoped to the
        // employee's company so a company override drives their accrued amount.
        // Leave Entitlement Rules Engine: service measured at cycleStart (same as the 2D-2 comment above).
        const pol = resolveGradePolicy(policyByType.get(typeId) ?? [], e.gradeId, e.companyId, years);
        if (!isEarnedMethod(pol?.method)) continue;
        const type = types.find((t) => t.id === typeId);
        if (!type) continue;
        if (frozenSet.has(`${e.employmentId}|${typeId}`)) continue; // ADR-0069: balance frozen for encashment
        // Grouped preview accumulator (feedback 2c7c6385): this (employee, type) resolves an earned policy,
        // so it belongs to the Company×Grade×Type group. Count it here (regardless of `toGrant`) — the
        // "Employee Count" column is the eligible population, not only those with a non-zero top-up.
        const groupKey = `${e.companyId}|${e.gradeId ?? ''}|${typeId}`;
        let group = groupBy.get(groupKey);
        if (!group) {
          group = {
            companyId: e.companyId,
            companyName: e.companyName,
            gradeId: e.gradeId ?? null,
            leaveTypeId: typeId,
            method: pol!.method!,
            count: 0,
            entitlementGenerated: 0,
          };
          groupBy.set(groupKey, group);
        }
        group.count += 1;
        // 2D-3: cap what carries into the new cycle. ANNUAL carries up to its policy cap; other earned
        // types reset (cap 0). Posted once per cycle, dated at the cycle start (guarded by `forfeited`).
        const carryKey = `${e.employmentId}|${typeId}`;
        const priorBalance = priorBalanceBy.get(carryKey) ?? 0;
        const baseCap = type.code === 'ANNUAL' ? pol!.carryMax : 0;
        // Feedback 9d8cf621 — Maximum Balance Days also bounds the earned carry cap: nothing more than the
        // cap can be retained into the new cycle. null ⇒ pass-through (baseCap unchanged).
        const cap = pol!.maxBalanceDays != null ? Math.min(baseCap, Math.max(0, pol!.maxBalanceDays)) : baseCap;
        const retainedCarry = Math.min(Math.max(priorBalance, 0), cap);
        if (!forfeited.has(carryKey)) {
          const forfeit = Math.round((priorBalance - retainedCarry) * 100) / 100;
          if (forfeit > 0) {
            // dryRun (feedback 2c7c6385): compute the same forfeit but write NOTHING — preview == commit.
            if (!dryRun) {
              await tx.insert(leaveLedger).values({
                tenantId: ctx.tenantId,
                employmentId: e.employmentId,
                leaveTypeId: typeId,
                entryType: 'adjustment',
                days: (-forfeit).toFixed(2),
                effectiveOn: cycleStart,
                reason: CARRY_FORFEIT_REASON_CAP,
              });
            }
            forfeited.add(carryKey);
            forfeits += 1;
          }
        }
        // Benefit Scheme (b83c6a3b): scheme band days supersede pol.days as the annual target; EA floor still
        // clamps. null ⇒ fall back to the earned policy's own days.
        const schemeTargetDays = schemeDaysFor(e.employmentId, typeId, years);
        const entitlement = Math.max(pack.leave.entitlement(type.code, years), schemeTargetDays ?? pol!.days);
        if (entitlement <= 0) continue;
        const totalPeriods = pol!.method === 'earned_quarterly' ? 4 : 12;
        const accrualStart =
          e.leaveCycle === 'anniversary' || e.hiredOn <= cycleStart ? cycleStart : `${e.hiredOn.slice(0, 7)}-01`;
        const elapsed = Math.min(totalPeriods, accrualPeriods(accrualStart, p.asOf, pol!.method!));
        let earnedToDate = Math.round((entitlement / totalPeriods) * elapsed * 100) / 100;
        // Feedback 9d8cf621 — Maximum Balance Days: cap the cumulative earned so retainedCarry + earned
        // never exceeds the cap (i.e. the running balance stays ≤ cap across the cycle). null ⇒ no cap.
        if (pol!.maxBalanceDays != null) {
          const room = Math.max(0, Math.round((Math.max(0, pol!.maxBalanceDays) - retainedCarry) * 100) / 100);
          earnedToDate = Math.min(earnedToDate, room);
        }
        const rows = accrualRowsBy.get(`${e.employmentId}|${typeId}`) ?? [];
        const already = rows.reduce((s, r) => (r.effectiveOn >= cycleStart ? s + r.days : s), 0);
        const toGrant = Math.round((earnedToDate - already) * 100) / 100;
        if (toGrant > 0) {
          // dryRun (feedback 2c7c6385): compute the same top-up but write NOTHING — preview == commit.
          if (!dryRun) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: e.employmentId,
              leaveTypeId: typeId,
              entryType: 'accrual',
              days: toGrant.toFixed(2),
              effectiveOn: p.asOf,
            });
          }
          granted += 1;
          group.entitlementGenerated = Math.round((group.entitlementGenerated + toGrant) * 100) / 100;
        }
      }
    }
    // Materialise the grouped breakdown for the preview/summary table (feedback 2c7c6385).
    const breakdown: EarnedAccrualGroup[] = [...groupBy.values()]
      .map((g) => {
        const type = types.find((t) => t.id === g.leaveTypeId)!;
        return {
          companyId: g.companyId,
          companyName: g.companyName,
          gradeId: g.gradeId,
          gradeName: g.gradeId ? (gradeNameById.get(g.gradeId) ?? null) : null,
          leaveTypeId: g.leaveTypeId,
          leaveTypeCode: type.code,
          leaveTypeName: type.name,
          employeeCount: g.count,
          accrualPeriod,
          method: g.method,
          entitlementGenerated: g.entitlementGenerated,
        };
      })
      .sort(
        (a, b) =>
          a.companyName.localeCompare(b.companyName) ||
          (a.gradeName ?? '').localeCompare(b.gradeName ?? '') ||
          a.leaveTypeName.localeCompare(b.leaveTypeName),
      );

    // dryRun (feedback 2c7c6385): a PREVIEW must leave no trace — skip the audit event entirely. A real
    // run appends ONE summary event; the ledger rows are the per-item audit (deliberate skip, as openLeaveYear).
    if (!dryRun) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-year',
        aggregateId: ctx.tenantId,
        eventType: 'leave.earned-accrual.run',
        actor: actorOf(ctx),
        // feedback 2c7c6385 (product decision 4): stamp the scope so a manual scoped run is distinguishable
        // from the unscoped monthly cron in the audit log. Empty arrays ⇒ "all" on that axis. IDs only (no
        // PII — see test/event-payload-pii-guard.test.ts).
        payload: {
          asOf: p.asOf,
          granted,
          forfeits,
          companyIds: scopeCompanyIds,
          gradeIds: scopeGradeIds,
          leaveTypeIds: scopeTypeIds,
        },
      });
    }
    return { granted, forfeits, breakdown };
  });
}

// ── Policy-correction recalculation (feedback 49809272) ────────────────────────────────────────────
/** The (gradeId, companyId) scope of a leave_policy row. null = all grades / group default. */
export type PolicyScope = { gradeId: string | null; companyId: string | null };

/**
 * Configurable Earned Leave Entitlement Rules (feedback 49809272) — when an admin CORRECTS an
 * entitlement policy IN PLACE (updateLeavePolicy: same effective date, "fix a mis-typed value"), the
 * employees who were ALREADY granted under the old values this cycle must not keep a stale balance.
 * This helper re-projects the CURRENT cycle only and posts ONE compensating `adjustment` per affected
 * (employment) for the delta between what the corrected policy says should be materialized to date and
 * what the ledger already holds. Runs INSIDE updateLeavePolicy's transaction (takes the live `tx`).
 *
 * Guardrails (the approved-plan invariants — read before changing):
 *  - ONLY the current cycle. Closed prior years were governed by the version active at their year-open
 *    (validFrom/validTo model) and are never rewritten — the window sum below starts at the cycle open.
 *  - ONLY employees whose current-cycle entitlement is ALREADY MATERIALIZED (≥1 `accrual` row in the
 *    window). An un-granted employee is skipped: hire/openLeaveYear/accrueEarnedLeave will grant from
 *    the corrected policy when they run, and their idempotency markers can't see an adjustment — posting
 *    here would double-grant.
 *  - EA-FLOOR INVARIANT: expected = max(statutory floor, band-resolved policy days) — byte-identical to
 *    the granting engines (openLeaveYear / hire grant / accrueEarnedLeave). A correction below the floor
 *    only claws back down TO the floor.
 *  - Idempotent: prior `sys:policy_recalc:*` adjustments count into `alreadyPosted`, so re-saving the
 *    same values computes delta 0 and posts nothing.
 *  - Earned methods: re-projects elapsed periods to `asOf` only — future periods stay with the cron.
 *  - The adjustment is dated `asOf` (inside the cycle window), NOT the cycle start: a cycle-start date
 *    could be pre-hire for a mid-cycle joiner and would read as accrueEarnedLeave's 2D-3 boundary-forfeit
 *    marker (any adjustment dated exactly at the cycle start suppresses that cycle's carry sweep).
 *
 * Substrate: one `leave.entitlement.recalculated` DomainEvent per posted adjustment (the per-row audit),
 * subject-scoped to the employment; the caller's enriched `leave-policy.updated` event is the summary —
 * deliberately no extra bulk duplicate (openLeaveYear/accrueEarnedLeave convention).
 */
export async function reprojectEntitlementForPolicy(
  tx: Tx,
  ctx: SessionContext,
  p: {
    policyId: string;
    leaveTypeId: string;
    /** `accrual` JSONB before / after the in-place correction. */
    before: AccrualConfig | null;
    after: AccrualConfig | null;
    beforeScope: PolicyScope;
    afterScope: PolicyScope;
    /** The corrected row's validity window (post-update values). */
    validFrom: string;
    validTo: string | null;
    /** Tenant-local (MYT) "today" — threaded from the action layer; anchors the current cycle. */
    asOf: string;
  },
): Promise<{ affected: number; totalDelta: number }> {
  const none = { affected: 0, totalDelta: 0 };

  // 1. Recalculate only when the correction moves ENTITLEMENT (days / method / bands) or the policy's
  //    scope. Carry-forward-only edits (cap, expiry, toggles) never changed what was granted — skip.
  //    Method is normalized the way the writers persist it (absent ⇒ the lump-sum default). Bands are
  //    canonical by construction (validated contiguous-ascending), so a JSON compare is stable.
  const norm = (a: AccrualConfig | null) => ({
    annualDays: Number(a?.annualDays ?? 0),
    method: a?.method || 'grant_on_hire_prorated',
    bands: JSON.stringify(a?.serviceBands ?? null),
  });
  const nb = norm(p.before);
  const na = norm(p.after);
  const entitlementChanged =
    nb.annualDays !== na.annualDays || nb.method !== na.method || nb.bands !== na.bands;
  const scopeChanged =
    p.beforeScope.gradeId !== p.afterScope.gradeId || p.beforeScope.companyId !== p.afterScope.companyId;
  if (!entitlementChanged && !scopeChanged) return none;

  // 2. Only a version ACTIVE at asOf can have driven this cycle's materialized grants. A forward-dated
  //    version (validFrom > asOf) applies from its own date per effective-date logic; a closed historical
  //    version governs frozen prior years. Neither recalculates — the effective-date model is preserved.
  if (p.validFrom > p.asOf) return none;
  if (p.validTo != null && p.validTo <= p.asOf) return none;

  const [type] = await tx
    .select({ id: leaveType.id, code: leaveType.code })
    .from(leaveType)
    .where(and(eq(leaveType.id, p.leaveTypeId), isNull(leaveType.archivedAt)))
    .limit(1);
  if (!type) return none; // archived type: nothing grants it anymore

  // 3. ALL active policies for the type as of asOf (accrueEarnedLeave's exact filters) — each employee's
  //    winner is resolved among ALL of them (resolveGradePolicy), so a grade/company override that beats
  //    the corrected policy naturally yields delta 0 for that employee.
  const policyRows: GradePolicyRow[] = await tx
    .select({
      gradeId: leavePolicy.gradeId,
      companyId: leavePolicy.companyId,
      accrual: leavePolicy.accrual,
    })
    .from(leavePolicy)
    .where(
      and(
        eq(leavePolicy.leaveTypeId, p.leaveTypeId),
        lte(leavePolicy.validFrom, p.asOf),
        or(isNull(leavePolicy.validTo), gt(leavePolicy.validTo, p.asOf)),
      ),
    );

  // 4. Candidate employments = the UNION of the policy's before/after scope (a scope move must true up
  //    BOTH the cohort that lost the rule and the one that gained it). null company/grade = match all.
  //    Membership predicates mirror openLeaveYear/accrueEarnedLeave so the target set can't drift.
  const yearStart = `${p.asOf.slice(0, 4)}-01-01`;
  const scopeCond = (s: PolicyScope) => {
    const companyCond = s.companyId != null ? eq(employment.companyId, s.companyId) : undefined;
    const gradeCond = s.gradeId != null ? eq(employment.gradeId, s.gradeId) : undefined;
    if (companyCond && gradeCond) return and(companyCond, gradeCond);
    return companyCond ?? gradeCond; // undefined = unbounded scope (group default, all grades)
  };
  const condBefore = scopeCond(p.beforeScope);
  const condAfter = scopeCond(p.afterScope);
  // Either side unbounded ⇒ the union is every employment (no scope filter).
  const scopeFilter =
    condBefore === undefined || condAfter === undefined ? undefined : or(condBefore, condAfter);
  const emps = await tx
    .select({
      employmentId: employment.id,
      hiredOn: employment.hiredOn,
      country: company.country,
      leaveCycle: company.leaveCycle,
      gradeId: employment.gradeId,
      companyId: employment.companyId,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(
      and(
        lte(employment.hiredOn, p.asOf),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        scopeFilter, // drizzle's and() drops undefined members
      ),
    );
  if (emps.length === 0) return none;
  const empIds = emps.map((e) => e.employmentId);

  // 5. Bulk ledger read (never per-employee): trailing ~12 months covers every possible cycle start
  //    (calendar Jan-1 and any anniversary month) — the accrueEarnedLeave pattern. Fetch the `accrual`
  //    grants PLUS prior policy-recalc adjustments; both count as "already posted" (idempotency).
  const accrualFrom = `${Number(p.asOf.slice(0, 4)) - 1}-${p.asOf.slice(5, 7)}-01`;
  const ledgerRows = await tx
    .select({
      employmentId: leaveLedger.employmentId,
      entryType: leaveLedger.entryType,
      days: leaveLedger.days,
      effectiveOn: leaveLedger.effectiveOn,
    })
    .from(leaveLedger)
    .where(
      and(
        inArray(leaveLedger.employmentId, empIds),
        eq(leaveLedger.leaveTypeId, p.leaveTypeId),
        gte(leaveLedger.effectiveOn, accrualFrom),
        or(
          eq(leaveLedger.entryType, 'accrual'),
          and(
            eq(leaveLedger.entryType, 'adjustment'),
            like(leaveLedger.reason, `${POLICY_RECALC_REASON_PREFIX}:%`),
          ),
        ),
      ),
    );
  const rowsBy = new Map<string, { entryType: string; days: number; effectiveOn: string }[]>();
  for (const r of ledgerRows) {
    const row = { entryType: r.entryType, days: Number(r.days), effectiveOn: r.effectiveOn };
    const arr = rowsBy.get(r.employmentId);
    if (arr) arr.push(row);
    else rowsBy.set(r.employmentId, [row]);
  }

  // ADR-0069: never touch a balance frozen for encashment (the DB trigger would abort the whole tx).
  const frozenSet = await frozenSnapshotKeySet(tx, empIds, [p.leaveTypeId]);

  let affected = 0;
  let totalDelta = 0;
  for (const e of emps) {
    const pack = packFor(e.country);
    if (!pack) continue;
    if (frozenSet.has(`${e.employmentId}|${p.leaveTypeId}`)) continue;

    // Resolve the employee's winner. Earned-ness decides the projection window: earned re-projects the
    // employee's accrual cycle (2D-2, calendar or anniversary); upfront re-projects the calendar leave
    // year (hire grants and openLeaveYear are calendar-anchored regardless of company leaveCycle).
    const cycleStartEarned = earnedCycleStart(e.hiredOn, p.asOf, e.leaveCycle);
    let years = serviceYearsAt(e.hiredOn, cycleStartEarned);
    let pol = resolveGradePolicy(policyRows, e.gradeId, e.companyId, years);
    const earnedMethod = isEarnedMethod(pol?.method);
    if (!earnedMethod && cycleStartEarned !== yearStart) {
      // Anniversary company whose winner is upfront: re-resolve with service measured at the calendar
      // year-open (openLeaveYear's own band anchor). If a banded config flips the winner to an earned
      // method under these years, skip defensively rather than mix windows.
      years = serviceYearsAt(e.hiredOn, yearStart);
      pol = resolveGradePolicy(policyRows, e.gradeId, e.companyId, years);
      if (isEarnedMethod(pol?.method)) continue;
    }
    const windowStart = earnedMethod ? cycleStartEarned : yearStart;

    // ⚠️ EA-FLOOR INVARIANT — identical to openLeaveYear / the hire grant / accrueEarnedLeave: the
    // resolved entitlement is max(statutory floor, policy). A below-floor correction claws back only
    // down TO the floor, never below it.
    const days = Math.max(pack.leave.entitlement(type.code, years), pol?.days ?? 0);
    let expected: number;
    if (earnedMethod) {
      const totalPeriods = pol!.method === 'earned_quarterly' ? 4 : 12;
      const accrualStart =
        e.leaveCycle === 'anniversary' || e.hiredOn <= windowStart ? windowStart : `${e.hiredOn.slice(0, 7)}-01`;
      const elapsed = Math.min(totalPeriods, accrualPeriods(accrualStart, p.asOf, pol!.method!));
      expected = days > 0 ? round2((days / totalPeriods) * elapsed) : 0;
    } else if (e.hiredOn >= windowStart && type.code === 'ANNUAL') {
      // Joiner during the current leave year: ANNUAL pro-rates by hire month (core/org.ts formula).
      const month = Number(e.hiredOn.slice(5, 7));
      expected = round2((days * (12 - (month - 1))) / 12);
    } else {
      // Existing employee (year-open grant) or a non-prorating type: the full resolved amount.
      expected = days;
    }

    const inWindow = (rowsBy.get(e.employmentId) ?? []).filter((r) => r.effectiveOn >= windowStart);
    // Materialized-only guard (see the docblock): no `accrual` row this cycle ⇒ nothing to correct here.
    if (!inWindow.some((r) => r.entryType === 'accrual')) continue;
    const alreadyPosted = round2(inWindow.reduce((s, r) => s + r.days, 0));
    const delta = round2(expected - alreadyPosted);
    if (delta === 0) continue;

    // Append-only ledger: the compensating row is a signed `adjustment` (the sanctioned ± channel the
    // breakdown surfaces separately). A negative delta CAN push the balance below days already taken —
    // a real over-granted situation, surfaced honestly rather than hidden.
    const [row] = await tx
      .insert(leaveLedger)
      .values({
        tenantId: ctx.tenantId,
        employmentId: e.employmentId,
        leaveTypeId: p.leaveTypeId,
        entryType: 'adjustment',
        days: delta.toFixed(2),
        effectiveOn: p.asOf,
        reason: `${POLICY_RECALC_REASON_PREFIX}:${p.policyId}`,
      })
      .returning({ id: leaveLedger.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-ledger',
      aggregateId: row.id,
      eventType: 'leave.entitlement.recalculated',
      actor: actorOf(ctx),
      subjectEmploymentId: e.employmentId,
      payload: {
        policyId: p.policyId,
        leaveTypeId: p.leaveTypeId,
        employmentId: e.employmentId,
        before: alreadyPosted,
        after: expected,
        delta,
        cycleStart: windowStart,
        reason: 'policy_recalc',
      },
    });
    affected += 1;
    totalDelta = round2(totalDelta + delta);
  }
  return { affected, totalDelta };
}

// ── Carry reconstruction (shared by expireCarriedLeave + the read-only breakdown view) ─────────────
/**
 * Pure reconstruction of the carried-forward ANNUAL quantity for one leave year, derived ENTIRELY from
 * the flat signed ledger — no tags, no new schema (ADR-0038). Inputs:
 *  - priorYearEndBalance — the signed ledger balance immediately before the year's Jan-1 open.
 *  - carryMax            — the policy's carryForwardMax cap.
 *  - debitsInWindow      — total ANNUAL days TAKEN inside [yearStart, expiryDate] (a positive number).
 *  - currentBalance      — the signed ledger balance as at the point being evaluated.
 * Returns:
 *  - carried          = min(max(priorYearEndBalance, 0), carryMax)  — what openLeaveYear posted at open.
 *  - unconsumedCarry  = max(0, round2(carried − debitsInWindow))     — carry still un-eaten in the window.
 *  - forfeitable      = round2(min(unconsumedCarry, max(0, currentBalance))) — never taxes fresh
 *    entitlement, never double-forfeits already-taken days (the WEAKER, balance-based forfeit rule).
 * This is the single source of truth for both the cron sweep and the read; keeping the arithmetic here
 * guarantees the breakdown can never diverge from what expireCarriedLeave actually forfeits.
 */
export function reconstructCarry(p: {
  priorYearEndBalance: number;
  carryMax: number;
  debitsInWindow: number;
  currentBalance: number;
}): { carried: number; unconsumedCarry: number; forfeitable: number } {
  const carried = Math.min(Math.max(p.priorYearEndBalance, 0), p.carryMax);
  const unconsumedCarry = Math.max(0, round2(carried - p.debitsInWindow));
  const forfeitable = round2(Math.min(unconsumedCarry, Math.max(0, p.currentBalance)));
  return { carried, unconsumedCarry, forfeitable };
}

/**
 * Carry-forward-report feature — the per-employment carry/expiry/forfeit computation shared by
 * `leaveEntitlementBreakdown` (core/read.ts) and the new `carryForwardReport` (core/analytics.ts).
 * Extracted verbatim from `leaveEntitlementBreakdown` so its output is byte-identical to before the
 * extraction (existing 363-line breakdown test suite is the regression gate — see ORDERED STEPS #2 in
 * the approved plan). Pure — no DB access; callers resolve the cycle start, the winning policy, and the
 * ledger aggregates (prior balance / debits-in-window / current balance) and pass them in here.
 *
 * `carryMax`/`expiry` should already be zeroed/nulled by the caller for non-ANNUAL types (only ANNUAL
 * carries — see openLeaveYear/expireCarriedLeave), so this helper does not re-check the leave-type code.
 */
export function resolveCarryBreakdown(p: {
  cycleStart: string;
  carryMax: number;
  /** {month, day} OFFSET, or null (never expires). Already resolved from the winning policy. */
  expiry: CarryExpiry | null;
  priorBalanceAtCycleStart: number;
  debitsInWindow: number;
  currentBalance: number;
  /** The date this reconstruction is evaluated as-at (drives whether the expiry has "passed"). */
  asOf: string;
}): {
  /** {cycleYear}-{expiry.month}-{expiry.day} (clamped to a real calendar day), or null. */
  carryForwardExpiryDate: string | null;
  /** min(max(priorBalance,0), carryMax) — what openLeaveYear posted at this cycle's open. */
  carried: number;
  /** Cap-excess forfeited AT OPEN: max(0, priorBalance − carried). */
  capExcess: number;
  /** How much of `carried` is still un-consumed as at `asOf` (0 once the expiry has passed). */
  unconsumedCarry: number;
  /** Realised expiry forfeit — 0 until the expiry date has arrived (≤ asOf), else the reconstructed
   *  forfeitable amount (min(unconsumedCarry, max(0, currentBalance))). */
  expiryForfeit: number;
  /** capExcess + expiryForfeit, rounded to 2dp. */
  forfeited: number;
} {
  const cycleYear = p.cycleStart.slice(0, 4);
  const carryForwardExpiryDate =
    p.carryMax > 0 && p.expiry
      ? `${cycleYear}-${String(p.expiry.month).padStart(2, '0')}-${String(
          Math.min(p.expiry.day, lastRealDayOfMonth(Number(cycleYear), p.expiry.month)),
        ).padStart(2, '0')}`
      : null;
  const { carried, unconsumedCarry: unconsumedRaw, forfeitable } = reconstructCarry({
    priorYearEndBalance: p.priorBalanceAtCycleStart,
    carryMax: p.carryMax,
    debitsInWindow: p.debitsInWindow,
    currentBalance: p.currentBalance,
  });
  const capExcess = Math.max(0, round2(Math.max(p.priorBalanceAtCycleStart, 0) - carried));
  const expiryPassed = carryForwardExpiryDate != null && carryForwardExpiryDate <= p.asOf;
  const expiryForfeit = expiryPassed ? forfeitable : 0;
  const forfeited = round2(capExcess + expiryForfeit);
  const unconsumedCarry = expiryPassed ? 0 : unconsumedRaw;
  return { carryForwardExpiryDate, carried, capExcess, unconsumedCarry, expiryForfeit, forfeited };
}

// ── Carry-forward expiry / auto-forfeit (ADR-0038 carry-forward enhancement) ───────────────────────
/**
 * Forfeit the still-unused carried-forward ANNUAL days whose configured expiry date has arrived.
 *
 * Design rationale (the panel-refined model — read before changing):
 *  - "Maximum Carry Forward Days" already exists: openLeaveYear (and the earned path) cap the carry at
 *    `carryForwardMax` at year-open and forfeit the excess. This function adds the SECOND, later forfeit
 *    of whatever survived the cap but stayed UNUSED past the policy's expiry date.
 *  - Expiry is configured as a month+day OFFSET on the policy JSONB (carryForwardExpiryMonth/Day), not a
 *    hardcoded date — so it holds for any leave-year start. The carry posted at year-open Y expires on
 *    {Y}-{month}-{day} (e.g. carry into 2026 expires 2026-03-31).
 *  - NO new schema / enum value / tagged "carry lot" row. The carried days stay folded into the plain
 *    `accrual` row that openLeaveYear already posts, so read aggregates (accrued/taken) and the earned
 *    path's `already`-sum are untouched. We RECONSTRUCT the carried quantity the same way openLeaveYear
 *    computed it: carriedAmount = min(max(priorYearEndBalance, 0), carryForwardMax).
 *  - WEAKER (correct) forfeit rule — NO consumption-ordering claim: there is no debit→accrual tag in the
 *    flat signed ledger, so we cannot say "the carry was consumed first/last". We forfeit only what is
 *    *still in the balance*: forfeit = min(unconsumedCarry, max(0, currentBalance)). This never taxes the
 *    fresh entitlement and never double-forfeits already-taken days.
 *  - Back-compat: only carry whose origin year-open is on/after the policy's validFrom year is swept;
 *    the reconstruction window is bounded to [yearStart, expiryDate] of the cycle being expired, so prior
 *    years are not retroactively swept. No backfill of legacy carry.
 *
 * Idempotency: the forfeit `adjustment` is dated at the YEAR-QUALIFIED expiry date of the cycle being
 * swept (not just month/day) so consecutive years (each ending e.g. 03-31) forfeit independently. We
 * compute the intended forfeit first and only treat an existing adjustment at that exact date as the
 * prior sweep when there would otherwise be something to forfeit — so a manual unrelated adjustment on
 * the same date does not suppress the real sweep.
 *
 * SYSTEM context (cron path): the negative-adjustment ledger inserts follow the deliberate-skip
 * convention in openLeaveYear/accrueEarnedLeave (ledger rows are the per-item audit). One summary
 * DomainEvent is appended below.
 */
export async function expireCarriedLeave(ctx: SessionContext, p: { today: string }) {
  return withTenant(ctx, async (tx) => {
    const todayYear = Number(p.today.slice(0, 4));
    const annualTypes = await tx
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(and(eq(leaveType.code, 'ANNUAL'), isNull(leaveType.archivedAt)));
    if (annualTypes.length === 0) return { swept: 0, forfeited: 0 };
    const typeIds = annualTypes.map((t) => t.id);

    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(lte(employment.hiredOn, p.today), or(isNull(employment.terminatedOn), gte(employment.terminatedOn, `${todayYear}-01-01`))));
    if (emps.length === 0) return { swept: 0, forfeited: 0 };
    const empIds = emps.map((e) => e.employmentId);

    // Every dated ANNUAL policy version (not just the currently-active one): the cycle being swept may be
    // governed by the policy version that was active at that year's open. resolveGradePolicy below picks
    // the most-generous one per (year, grade).
    const policies = await tx
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, companyId: leavePolicy.companyId, accrual: leavePolicy.accrual, validFrom: leavePolicy.validFrom, validTo: leavePolicy.validTo })
      .from(leavePolicy)
      .where(inArray(leavePolicy.leaveTypeId, typeIds));
    if (policies.length === 0) return { swept: 0, forfeited: 0 };

    // The earliest leave-year a carry-expiry policy could apply to (back-compat boundary): the year of the
    // earliest validFrom among policies that carry an expiry offset. Never sweep before it.
    // Feedback 9d8cf621: a policy counts if it carries ANY carry-expiry — policy-level OR per service band
    // (hasAnyCarryExpiry) — so a purely per-range expiry still sets the sweepable-year floor.
    const expiryPolicyYears = policies
      .filter((pol) => hasAnyCarryExpiry(pol.accrual as AccrualConfig | null))
      .map((pol) => Number(pol.validFrom.slice(0, 4)));
    if (expiryPolicyYears.length === 0) return { swept: 0, forfeited: 0 };
    const earliestYear = Math.min(...expiryPolicyYears);

    // For a given leave year, the policies active at its year-open (Jan 1). ADR-0066: carry companyId so
    // the resolver short-circuits onto the employee's own company tier (never another company's carry-cap).
    const activeAt = (yearOpen: string): GradePolicyRow[] =>
      policies
        .filter((pol) => pol.validFrom <= yearOpen && (pol.validTo == null || pol.validTo > yearOpen))
        .map((pol) => ({ gradeId: pol.gradeId, companyId: pol.companyId, accrual: pol.accrual }));

    // ADR-0069: skip (employment, ANNUAL type) pairs with an ACTIVE frozen encashment snapshot.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, typeIds);

    let swept = 0;
    let forfeitedTotal = 0;
    for (const e of emps) {
      for (const t of annualTypes) {
        if (frozenSet.has(`${e.employmentId}|${t.id}`)) continue; // ADR-0069: balance frozen for encashment
        // Sweep each candidate leave year Y from the back-compat boundary up to today whose expiry date has
        // arrived. Each year is independently reconstructed + idempotent on its own year-qualified date.
        for (let y = earliestYear; y <= todayYear; y++) {
          const yearStart = `${y}-01-01`;
          // Leave Entitlement Rules Engine: service length AS OF THIS SWEPT YEAR's open (not today) — a
          // band-vs-flat winner flip is only reachable when the employee's service band differed at that
          // year's open, so this must be computed per-y inside the loop, not hoisted.
          const pol = resolveGradePolicy(activeAt(yearStart), e.gradeId, e.companyId, serviceYearsAt(e.hiredOn, yearStart));
          // Carry-forward enhancement: a policy whose carry rule is explicitly disabled never carries
          // anything (openLeaveYear forfeits the whole prior balance at open), so there is nothing for
          // the later expiry sweep to forfeit — skip even if a stale expiry offset is still populated.
          if (!carryEnabled(pol)) continue;
          const expiry = pol?.carryExpiry ?? null;
          if (!expiry) continue;
          // R4 Build #1 crash fix: clamp the offset `day` to the real last day of `expiry.month` in THIS
          // leave-year so the emitted date is always a real calendar day. This covers months-mode (day=31
          // sentinel ⇒ the month's true last day), a date-mode 29-Feb in a common year (⇒ 28 Feb), and any
          // legacy garbage that survives `parseCarryExpiry`. Without it, an impossible date (e.g. 2027-02-29)
          // would insert into a `date` column and abort the whole tenant sweep.
          const dd = Math.min(expiry.day, lastRealDayOfMonth(y, expiry.month));
          const expiryDate = `${y}-${String(expiry.month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          if (expiryDate > p.today) continue; // not yet due
          // Only sweep a year whose leave-year was actually OPENED: openLeaveYear posts the carry as a
          // Jan-1 accrual (its own open-marker). Without that marker no carry was ever posted for this year,
          // so there is nothing to expire (back-compat: a year never run is never retroactively swept).
          const [openMarker] = await tx
            .select({ n: sql<string>`count(*)` })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                eq(leaveLedger.entryType, 'accrual'),
                eq(leaveLedger.effectiveOn, yearStart),
              ),
            );
          if (Number(openMarker?.n ?? 0) === 0) continue;
          // The carried amount openLeaveYear posted at this year-open: prior-year-end balance, capped.
          const carryMax = pol!.carryMax;
          if (carryMax <= 0) continue; // nothing could have carried
          const [priorRow] = await tx
            .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
            .from(leaveLedger)
            .where(and(eq(leaveLedger.employmentId, e.employmentId), eq(leaveLedger.leaveTypeId, t.id), lt(leaveLedger.effectiveOn, yearStart)));
          const priorYearEndBalance = Number(priorRow?.bal ?? 0);
          if (Math.min(Math.max(priorYearEndBalance, 0), carryMax) <= 0) continue;
          // Annual debits inside [yearStart, expiryDate] reduce the still-unconsumed carry. (Weaker rule:
          // no ordering claim — just "how much of the window's leave could have eaten the carry".)
          const [debitRow] = await tx
            .select({ taken: sql<string>`coalesce(-sum(${leaveLedger.days}), 0)` })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                eq(leaveLedger.entryType, 'debit'),
                gte(leaveLedger.effectiveOn, yearStart),
                lte(leaveLedger.effectiveOn, expiryDate),
              ),
            );
          const debitsInWindow = Number(debitRow?.taken ?? 0);
          // Cap at what is actually still in the balance now — never tax fresh entitlement / re-forfeit.
          const currentBalance = await leaveBalance(tx, e.employmentId, t.id);
          const { unconsumedCarry, forfeitable: forfeit } = reconstructCarry({
            priorYearEndBalance,
            carryMax,
            debitsInWindow,
            currentBalance,
          });
          if (unconsumedCarry <= 0) continue;
          if (forfeit <= 0) continue;
          // Idempotency (year-qualified): if a forfeit adjustment of this magnitude already sits at exactly
          // this expiry date, this year was already swept — skip. A manual unrelated adjustment of a
          // DIFFERENT amount does not match, so the real sweep still fires.
          const priorSweeps = await tx
            .select({ days: leaveLedger.days })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                eq(leaveLedger.entryType, 'adjustment'),
                eq(leaveLedger.effectiveOn, expiryDate),
              ),
            );
          if (priorSweeps.some((r) => Number(r.days) === -forfeit)) continue;
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: expiryDate,
            reason: CARRY_FORFEIT_REASON_EXPIRY,
          });
          swept += 1;
          forfeitedTotal = Math.round((forfeitedTotal + forfeit) * 100) / 100;
        }
      }
    }

    // One summary event; the ledger rows are the per-item audit (deliberate substrate skip, as
    // openLeaveYear / accrueEarnedLeave).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave.carry-forward.swept',
      actor: actorOf(ctx),
      payload: { today: p.today, swept, forfeited: forfeitedTotal },
    });
    return { swept, forfeited: forfeitedTotal };
  });
}

// ═════════════════════ Leave Type Expiry Field (fec49317) — age-from-earning sweep ═════════════════════
// Reuses the TOIL expires-on / oldest-first pattern (toil_accrual aged from its worked date), NOT the
// carry-forward reconstruction. For every leave type that has BOTH expiry_value and expiry_unit configured
// AND whose code is NOT ANNUAL (ANNUAL is owned by expireCarriedLeave; a second age-based forfeit there
// would double-count against the carry-cap / boundary / carry-expiry writers), each `accrual` ledger row
// lapses `expiry_value expiry_unit` after its effective_on. When that date has passed, the still-unconsumed
// remainder of that batch is forfeited as one negative `adjustment` dated at the batch's expiry date and
// stamped AGED_FORFEIT_REASON. Because leaveBalance is a plain signed ledger sum, the forfeit immediately
// leaves the balance (and the manual encashment advisory that reads it) while remaining a real ledger row
// (so it still shows in reports).
//
// Consumption model (oldest batch first): a batch's forfeitable = min( batchRemaining, currentBalance ),
// where batchRemaining is what is left of THAT accrual after subtracting everything the ledger has already
// removed against it — later debits, earlier aged-forfeits, and forfeits posted earlier in THIS run — and
// currentBalance is re-read live before each posted batch. Capping at the live balance is what makes it
// safe to coexist with the other negative-adjustment writers: we can never forfeit days that some other
// mechanism already forfeited, because they are no longer in the balance. Idempotent: the distinct reason
// code + (effective_on, magnitude) key means a re-run forfeits nothing.

/** Real-calendar expiry date for an earned batch: `effectiveOn` plus N months (day clamped to the target
 *  month's real last day, leap-correct) or N days. Pure + unit-testable. Mirrors expireCarriedLeave's
 *  lastRealDayOfMonth clamp so the emitted string is always a valid `date`. */
export function agedExpiryDate(effectiveOn: string, value: number, unit: 'months' | 'days'): string {
  const [y, m, d] = effectiveOn.split('-').map(Number);
  if (unit === 'days') {
    // Day arithmetic via UTC epoch (DST-free) — matches toil.ts addDays semantics.
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + value);
    return base.toISOString().slice(0, 10);
  }
  // months: advance the month, then clamp the day to that month's real last day (29 Feb → 28 Feb, etc.).
  const targetMonthIndex = m - 1 + value;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1; // 1-based
  const dd = Math.min(d, lastRealDayOfMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export async function expireAgedLeave(ctx: SessionContext, p: { today: string }) {
  return withTenant(ctx, async (tx) => {
    // Types with a configured age-expiry pair, excluding ANNUAL (owned by the carry-expiry engine).
    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code, expiryValue: leaveType.expiryValue, expiryUnit: leaveType.expiryUnit })
      .from(leaveType)
      .where(
        and(
          isNull(leaveType.archivedAt),
          isNotNull(leaveType.expiryValue),
          isNotNull(leaveType.expiryUnit),
          ne(leaveType.code, 'ANNUAL'),
        ),
      );
    if (types.length === 0) return { swept: 0, forfeited: 0 };
    const typeIds = types.map((t) => t.id);

    const emps = await tx
      .select({ employmentId: employment.id })
      .from(employment)
      .where(and(lte(employment.hiredOn, p.today), or(isNull(employment.terminatedOn), gte(employment.terminatedOn, `${Number(p.today.slice(0, 4))}-01-01`))));
    if (emps.length === 0) return { swept: 0, forfeited: 0 };
    const empIds = emps.map((e) => e.employmentId);

    // ADR-0069: never touch (employment, type) pairs frozen for an active encashment snapshot.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, typeIds);

    let swept = 0;
    let forfeitedTotal = 0;
    for (const t of types) {
      const value = t.expiryValue!;
      const unit = (t.expiryUnit as 'months' | 'days');
      for (const e of emps) {
        if (frozenSet.has(`${e.employmentId}|${t.id}`)) continue;
        // Every accrual portion, oldest first. accrual rows only: this auto-covers hire-grant + monthly
        // earned accruals and auto-excludes ad-hoc festive grants (entryType 'adjustment') and TOIL credits
        // (entryType 'in_lieu_accrual'), which have their own expiry engine.
        const accruals = await tx
          .select({ days: leaveLedger.days, effectiveOn: leaveLedger.effectiveOn })
          .from(leaveLedger)
          .where(
            and(
              eq(leaveLedger.employmentId, e.employmentId),
              eq(leaveLedger.leaveTypeId, t.id),
              eq(leaveLedger.entryType, 'accrual'),
            ),
          )
          .orderBy(asc(leaveLedger.effectiveOn));
        if (accruals.length === 0) continue;

        // Prior aged-forfeits already posted for this pair, keyed by their effective_on (the batch expiry
        // date), so a re-run recognises what it already forfeited and never doubles it.
        const priorAged = await tx
          .select({ days: leaveLedger.days, effectiveOn: leaveLedger.effectiveOn })
          .from(leaveLedger)
          .where(
            and(
              eq(leaveLedger.employmentId, e.employmentId),
              eq(leaveLedger.leaveTypeId, t.id),
              eq(leaveLedger.entryType, 'adjustment'),
              eq(leaveLedger.reason, AGED_FORFEIT_REASON),
            ),
          );
        const agedByDate = new Map<string, number>();
        for (const r of priorAged) agedByDate.set(r.effectiveOn, round2((agedByDate.get(r.effectiveOn) ?? 0) + -Number(r.days)));

        // Total debits taken against this pair (all-time). Debits reduce the OLDEST unconsumed accrual first
        // (a weak FIFO assumption consistent with the carry engine's "how much could have been eaten"). We
        // walk accruals oldest→newest, letting the running debit pool consume each batch before it can be
        // forfeited, so a day that was actually TAKEN is never forfeited.
        const [debitRow] = await tx
          .select({ taken: sql<string>`coalesce(-sum(${leaveLedger.days}), 0)` })
          .from(leaveLedger)
          .where(
            and(
              eq(leaveLedger.employmentId, e.employmentId),
              eq(leaveLedger.leaveTypeId, t.id),
              eq(leaveLedger.entryType, 'debit'),
            ),
          );
        let debitPool = Number(debitRow?.taken ?? 0);
        // Prior aged-forfeits also permanently consumed part of an earlier batch — pool them in with debits
        // so a batch already forfeited (in a previous run) is not reconsumed here.
        let priorAgedPool = round2([...agedByDate.values()].reduce((s, v) => s + v, 0));

        for (const a of accruals) {
          const batch = Number(a.days);
          if (batch <= 0) continue;
          // Consume this batch with the debit pool first (FIFO), then with the prior-aged pool.
          let remaining = batch;
          const eatDebit = Math.min(remaining, debitPool);
          remaining = round2(remaining - eatDebit);
          debitPool = round2(debitPool - eatDebit);
          const eatAged = Math.min(remaining, priorAgedPool);
          remaining = round2(remaining - eatAged);
          priorAgedPool = round2(priorAgedPool - eatAged);
          if (remaining <= 0) continue; // fully consumed by debits / earlier forfeits

          const expiryDate = agedExpiryDate(a.effectiveOn, value, unit);
          if (expiryDate > p.today) continue; // not yet due

          // Idempotency: a forfeit of this magnitude at this expiry date already exists ⇒ this batch was
          // swept before (matches expireCarriedLeave's date+magnitude guard, but reason-scoped).
          if ((agedByDate.get(expiryDate) ?? 0) >= remaining - 0.001) continue;

          // Cap at what is actually still in the balance now — never forfeit days some other writer already
          // removed, and never drive the balance negative (R1 safety net across all forfeit engines).
          const currentBalance = await leaveBalance(tx, e.employmentId, t.id);
          const forfeit = round2(Math.min(remaining, Math.max(currentBalance, 0)));
          if (forfeit <= 0) continue;

          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: expiryDate,
            reason: AGED_FORFEIT_REASON,
          });
          agedByDate.set(expiryDate, round2((agedByDate.get(expiryDate) ?? 0) + forfeit));
          swept += 1;
          forfeitedTotal = round2(forfeitedTotal + forfeit);
        }
      }
    }

    // One summary event; the ledger rows are the per-item audit (deliberate substrate skip, mirroring
    // expireCarriedLeave / accrueEarnedLeave / openLeaveYear).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave.aged.swept',
      actor: actorOf(ctx),
      payload: { today: p.today, swept, forfeited: forfeitedTotal },
    });
    return { swept, forfeited: forfeitedTotal };
  });
}

// ═════════════════════ Festive / one-off leave grant (ADR-0066, Model 3) ═════════════════════
// A festive grant credits N extra days to EVERY active employee in a chosen (company, leave_type) on a chosen
// date, with a human reason (e.g. "CNY 2026"). No new table: each grant is one `leaveLedger` `adjustment`
// (+days) per targeted employment + ONE summary DomainEvent. Festive leave types are expected to live OUTSIDE
// STANDING_LEAVE_CODES so the accrual / openLeaveYear / expiry engines never touch them (deliberate — see
// ADR-0066: this is why festive days escape annual carry-cap/forfeit). Expiry clawback is DEFERRED; `expiresOn`
// is accepted and stored only as a payload/reason note (no sweep this pass).

/** Credit `days` to every active employee of (companyId, leaveTypeId) as a dated `adjustment`. Returns the
 *  number of newly-credited employments (idempotent re-runs return 0 newly credited). */
export async function grantAdHocLeave(
  ctx: SessionContext,
  p: {
    /** Target company. null = group-wide (every active employment) — requires a GROUP admin. */
    companyId: string | null;
    leaveTypeId: string;
    days: number;
    reason: string;
    /** Date the grant takes effect (the ledger `effective_on`). */
    effectiveOn: string;
    /** Optional metadata only — DEFERRED: no auto-clawback this pass (ADR-0066). Stored in the event payload. */
    expiresOn?: string | null;
  },
) {
  // ── Validation (before opening the transaction; a bad grant persists nothing) ──
  // Order matters (re-plan round 5): the finite/positive check runs on the RAW value first (so NaN still
  // yields "Days must be a positive number."), THEN the 0.5-increment check ALSO runs on the raw value —
  // BEFORE the 2-dp rounding below. Halves are exact in binary floats, so raw*2 is an integer iff the value
  // is a genuine half-day step; checking after rounding would silently accept e.g. 0.501 (rounds to 0.5).
  const raw = Number(p.days);
  if (!Number.isFinite(raw) || raw <= 0) throw new AdHocLeaveGrantError('Days must be a positive number.');
  if (!Number.isInteger(raw * 2)) {
    throw new AdHocLeaveGrantError('Days must be in 0.5 increments (e.g. 0.5, 1.0, 1.5, 2.0).');
  }
  if (raw > 366) throw new AdHocLeaveGrantError('Days cannot exceed 366.');
  const days = Math.round(raw * 100) / 100;
  const reason = p.reason?.trim();
  if (!reason) throw new AdHocLeaveGrantError('A reason is required (e.g. "CNY 2026").');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveOn)) throw new AdHocLeaveGrantError('A valid effective date is required.');

  // ── Authority (resolves the silent-partial-write critique): a group-wide grant needs a GROUP admin; a
  // company-scoped grant needs admin authority over that company. A company-scoped admin attempting a
  // group-wide grant is rejected outright — never silently scoped down. ──
  // Back-compat: a roles-only session (no `grants`) is group-wide, exactly as withTenant treats it.
  // withEffectiveGrants (lib/authz.ts) builds the effective grants the same way so isGroupAdmin / hasGrantFor
  // see a group-wide admin (e.g. test adminCtx).
  const effective: SessionContext = withEffectiveGrants(ctx);
  if (p.companyId == null) {
    if (!isGroupAdmin(effective)) {
      throw new AdHocLeaveGrantError('A group-wide festive grant requires a group administrator.');
    }
  } else if (!(isGroupAdmin(effective) || hasGrantFor(effective, 'hr_admin', p.companyId))) {
    throw new AdHocLeaveGrantError('You are not permitted to grant leave for this company.');
  }

  return withTenant(ctx, async (tx) => {
    // Validate the leave type exists (visible) so a typo doesn't post orphaned ledger rows.
    const [lt] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    if (!lt) throw new AdHocLeaveGrantError('Leave type not found.');

    // Target set = active employments as of effectiveOn. Edge rules (documented): include only employments
    // hired on/before effectiveOn and not terminated before it (mirror openLeaveYear's terminatedOn >= start
    // convention). Target by employment.companyId so multi-company employment isn't double-granted under one
    // company-scoped grant.
    const targets = await tx
      .select({ employmentId: employment.id })
      .from(employment)
      .where(
        and(
          p.companyId != null ? eq(employment.companyId, p.companyId) : undefined,
          lte(employment.hiredOn, p.effectiveOn),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, p.effectiveOn)),
        ),
      );
    // Resolved cohort count = intent. Surfaced in the return so a partial write under can_see_employment RLS
    // shows up as an explicit number, never a silent partial.
    const targeted = targets.length;

    // Idempotency (resolves the double-click critique): skip any employment that already has an adjustment
    // for this exact (leaveTypeId, effectiveOn, reason) — re-running the identical grant is a no-op. Mirrors
    // openLeaveYear's openedSet dedupe.
    const existing = await tx
      .select({ employmentId: leaveLedger.employmentId })
      .from(leaveLedger)
      .where(
        and(
          targeted > 0 ? inArray(leaveLedger.employmentId, targets.map((e) => e.employmentId)) : sql`false`,
          eq(leaveLedger.leaveTypeId, p.leaveTypeId),
          eq(leaveLedger.entryType, 'adjustment'),
          eq(leaveLedger.effectiveOn, p.effectiveOn),
          eq(leaveLedger.reason, reason),
        ),
      );
    const already = new Set(existing.map((r) => r.employmentId));

    // ADR-0069: skip any target employment with an ACTIVE frozen encashment snapshot for this leave type —
    // the DB trigger would reject the write anyway; skipping here avoids aborting the whole grant on one
    // frozen employee.
    const frozenSet =
      targeted > 0 ? await frozenSnapshotKeySet(tx, targets.map((e) => e.employmentId), [p.leaveTypeId]) : new Set<string>();

    let granted = 0;
    for (const e of targets) {
      if (already.has(e.employmentId)) continue;
      if (frozenSet.has(`${e.employmentId}|${p.leaveTypeId}`)) continue; // ADR-0069: balance frozen
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: e.employmentId,
        leaveTypeId: p.leaveTypeId,
        entryType: 'adjustment',
        days: days.toFixed(2),
        effectiveOn: p.effectiveOn,
        reason,
      });
      granted += 1;
    }

    // Substrate: ONE summary DomainEvent. The per-employment ledger rows are the per-item audit (deliberate
    // skip documented inline, matching openLeaveYear / accrueEarnedLeave).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-grant',
      aggregateId: ctx.tenantId,
      eventType: 'leave.ad-hoc.granted',
      actor: actorOf(ctx),
      payload: {
        leaveTypeId: p.leaveTypeId,
        companyId: p.companyId,
        days,
        count: granted,
        targeted,
        reason,
        effectiveOn: p.effectiveOn,
        expiresOn: p.expiresOn ?? null,
      },
    });
    return { granted, targeted, days, reason, effectiveOn: p.effectiveOn };
  });
}

// ═════════════════════ Multi-company festive grant (re-plan, round 5) ═════════════════════
// One submission targets several companies at once. NOT atomic across companies — this is N sequential
// per-company calls to the existing `grantAdHocLeave`, each its own `withTenant` transaction, its own
// authority gate, and its own `leave.ad-hoc.granted` DomainEvent (companyId in the payload). The per-company
// events ARE the per-company audit trail (core/admin.ts listAdHocLeaveGrants renders one row per event) — no
// extra summary event is appended here (deliberate skip, same pattern as the shipped single-company grant).
// A mid-loop failure leaves earlier companies granted and later ones not; the thrown error names the
// companies completed so far and instructs HR to re-submit the identical form. The idempotency dedupe key
// inside grantAdHocLeave (employmentId, leaveTypeId, entryType, effectiveOn, reason — DAYS EXCLUDED) means an
// unchanged resubmit safely skips already-granted companies and only completes the rest. A resubmit with
// CHANGED days or reason is treated as a brand-new grant — this is pre-existing single-company behavior,
// deliberately left unaltered.

/** Credit `days` to every active employee across MULTIPLE companies in one call. Loops the existing
 *  `grantAdHocLeave` per company (all-or-nothing pre-flight authority check; NOT an atomic transaction
 *  across companies — see the block comment above). */
export async function grantAdHocLeaveMulti(
  ctx: SessionContext,
  p: {
    companyIds: string[];
    leaveTypeId: string;
    days: number;
    reason: string;
    effectiveOn: string;
    expiresOn?: string | null;
  },
) {
  const dedupedIds = [...new Set(p.companyIds)];
  if (dedupedIds.length === 0) throw new AdHocLeaveGrantError('Select at least one company.');

  // ── Pre-flight authority (all-or-nothing): every selected company must be grantable BEFORE any write, so a
  // forged request naming one company the admin cannot administer fails cleanly with none granted. The UI
  // (app/admin/leave/page.tsx) already narrows the offered options to administered companies — this is a
  // backstop against a tampered/forged submission, not the primary gate. grantAdHocLeave still re-checks
  // authority per call below; nothing is bypassed. ──
  const effective = withEffectiveGrants(ctx);
  if (!isGroupAdmin(effective)) {
    const denied = dedupedIds.filter((id) => !hasGrantFor(effective, 'hr_admin', id));
    if (denied.length > 0) {
      throw new AdHocLeaveGrantError(`You are not permitted to grant leave for: ${denied.join(', ')}.`);
    }
  }

  // ── Resolve companies (id, legalName, archivedAt) via withTenant so RLS still applies. Unknown id → hard
  // error (nothing granted). Archived companies are skipped as a defense-in-depth safety net ONLY — the
  // form's options come from listCompanies (core/read.ts), which already excludes archived companies, so in
  // normal use there is nothing to skip; this only matters against a stale or tampered submission. ──
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({ id: company.id, legalName: company.legalName, archivedAt: company.archivedAt })
      .from(company)
      .where(inArray(company.id, dedupedIds)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of dedupedIds) {
    if (!byId.has(id)) throw new AdHocLeaveGrantError('Unknown company selected.');
  }
  const skipped: string[] = [];
  const active = dedupedIds.filter((id) => {
    const c = byId.get(id)!;
    if (c.archivedAt != null) {
      skipped.push(id);
      return false;
    }
    return true;
  });
  if (active.length === 0) throw new AdHocLeaveGrantError('No active companies selected.');

  // ── Sequential per-company grants (NOT atomic — see block comment above). ──
  let granted = 0;
  let targeted = 0;
  const grantedNames: string[] = [];
  for (const id of active) {
    const legalName = byId.get(id)!.legalName;
    try {
      const res = await grantAdHocLeave(ctx, {
        companyId: id,
        leaveTypeId: p.leaveTypeId,
        days: p.days,
        reason: p.reason,
        effectiveOn: p.effectiveOn,
        expiresOn: p.expiresOn,
      });
      granted += res.granted;
      targeted += res.targeted;
      grantedNames.push(legalName);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const doneList = grantedNames.length > 0 ? grantedNames.join(', ') : '(none)';
      throw new AdHocLeaveGrantError(
        `Granted for ${doneList}. Failed at ${legalName}: ${message} ` +
          `Re-submit the same form unchanged to grant the remaining companies; already-granted companies will not be double-credited.`,
      );
    }
  }

  return { granted, targeted, companies: grantedNames.length, skipped: skipped.length };
}
