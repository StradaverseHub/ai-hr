/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { assertCanDecide } from './approvals';
import { isAdmin, isGroupAdmin, hasGrantFor } from '../lib/authz';
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
  bandDaysFor,
  carryEnabled,
  isValidMonthDay,
  isWellFormedBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  previewEntitlement,
  resolveGradePolicy,
  type AccrualConfig,
  type CarryExpiry,
  type GradePolicyRow,
  type PreviewResult,
  type ResolvedPolicy,
  type ServiceBand,
} from './leave-compute';
// Re-export the pure module's surface so every existing caller/test keeps importing these from '@/core/leave'.
export {
  bandDaysFor,
  carryEnabled,
  isValidMonthDay,
  isWellFormedBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  previewEntitlement,
  resolveGradePolicy,
  type AccrualConfig,
  type CarryExpiry,
  type GradePolicyRow,
  type PreviewResult,
  type ResolvedPolicy,
  type ServiceBand,
};
import {
  attendancePolicy,
  company,
  employment,
  leaveApprovalStep,
  leaveCancellationRequest,
  leaveLedger,
  leavePolicy,
  leaveRequest,
  leaveRequestAttachment,
  leaveRequestDate,
  leaveType,
  payrollBatch,
  payslip,
  person,
  reportingLine,
} from '../db/schema';

/** The engine default working-day roster (ISO weekday 1=Mon … 7=Sun) — Mon–Fri. Mirrors core/attendance.ts
 *  DEFAULTS.workingDays so leave classifies rest days the same way attendance does (audit H#3). */
const DEFAULT_WORKING_DAYS_ISO = [1, 2, 3, 4, 5];

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
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
export type LeaveEligibility = { gender?: string; maritalStatus?: string; minServiceMonths?: number };

export class LeaveIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveIneligibleError';
  }
}

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
  constructor(limitDays: number, typeName?: string) {
    super(`${typeName ?? 'This leave type'} cannot be backdated more than ${limitDays} day(s).`);
    this.name = 'LeaveBackdatingNotAllowedError';
    this.typeName = typeName;
    this.limitDays = limitDays;
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

function assertEligible(
  elig: LeaveEligibility,
  emp: { gender: string | null; marital: string | null; hiredOn: string } | undefined,
  asOf: string,
): void {
  if (elig.gender && emp?.gender !== elig.gender) {
    throw new LeaveIneligibleError(`This leave type is available to ${elig.gender} employees only.`);
  }
  if (elig.maritalStatus && emp?.marital !== elig.maritalStatus) {
    throw new LeaveIneligibleError(`This leave type requires marital status “${elig.maritalStatus}”.`);
  }
  if (elig.minServiceMonths && (!emp || monthsBetween(emp.hiredOn, asOf) < elig.minServiceMonths)) {
    throw new LeaveIneligibleError(`This leave type requires at least ${elig.minServiceMonths} months of service.`);
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
  emp: { gender: string | null; marital: string | null; hiredOn: string } | undefined,
  asOf: string,
): boolean {
  if (!elig) return true;
  if (elig.gender && emp?.gender !== elig.gender) return false;
  if (elig.maritalStatus && emp?.marital !== elig.maritalStatus) return false;
  if (elig.minServiceMonths && (!emp || monthsBetween(emp.hiredOn, asOf) < elig.minServiceMonths)) return false;
  return true;
}

export async function leaveBalance(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
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

/** True when `date` is a working day for the given ISO working-day roster (1=Mon … 7=Sun) and is not a
 *  holiday. Resolves rest days from the SAME source the attendance engine uses (audit H#3), never a
 *  hardcoded Sat/Sun. */
function isWorkingDay(date: string, workingDaysIso: number[], holidays: Set<string>): boolean {
  return workingDaysIso.includes(isoWeekday(date)) && !holidays.has(date);
}

/** Working days in [start, end]: counts only days on the employee's configured working-day roster (ISO
 *  weekdays, default Mon–Fri) that are not holidays. */
function workingDays(start: string, end: string, holidays: Set<string>, workingDaysIso: number[]): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    if (isWorkingDay(d, workingDaysIso, holidays)) n++;
  }
  return n;
}

/** The company's configured working-day roster for an employment (ISO weekday array, 1=Mon … 7=Sun),
 *  resolved from attendance_policy.workingDays — the SAME source core/attendance.ts uses. Falls back to the
 *  Mon–Fri default when no policy row exists, so existing single-company behaviour is unchanged (audit H#3). */
async function resolveWorkingDaysIso(tx: Tx, employmentId: string): Promise<number[]> {
  const [row] = await tx
    .select({ workingDays: attendancePolicy.workingDays })
    .from(employment)
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.workingDays ?? DEFAULT_WORKING_DAYS_ISO;
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
    },
  });
  // 2B-1/2B-2: if the company runs a multi-step chain, generate the instance approval steps.
  await generateApprovalSteps(tx, ctx.tenantId, row.id, v.employmentId, v.leaveTypeId);
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
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        durations: leaveType.durations,
        perDateApproval: leaveType.perDateApproval,
        backdatingLimitDays: leaveType.backdatingLimitDays,
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

    // Eligibility gate (2A-1, #25) — fail fast before anything is created.
    const elig = (lt?.eligibility ?? null) as LeaveEligibility | null;
    if (elig && (elig.gender || elig.maritalStatus || elig.minServiceMonths)) {
      const [emp] = await tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
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
      throw new LeaveBackdatingNotAllowedError(limit!, lt?.name);
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
    let workingDayCount: number | null = null;
    if (lt?.counting === 'working_days') {
      // 2C (ADR-0038) + holiday grouping: holidays apply per the employee's effective set of states —
      // national (state null) ∪ those states, resolved holiday_group → work_state →
      // company.default_work_state → national-only (see resolveHolidaySet).
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const workingDaysIso = await resolveWorkingDaysIso(tx, p.employmentId);
      workingDayCount = workingDays(p.startDate, p.endDate, hols, workingDaysIso);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt?.counting === 'working_days' ? workingDayCount! : dayCount(p.startDate, p.endDate);
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
    if (days <= 0) throw new LeaveNoDaysInRangeError();

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
      const workingDaysIso = await resolveWorkingDaysIso(tx, p.employmentId);
      const dates = eachDate(p.startDate, p.endDate).filter((d) => isWorkingDay(d, workingDaysIso, hols));
      if (dates.length > 1) {
        // Each date is one whole working day by construction, so sum(perDate.days) === the request's
        // working-day count (guards fractional drift, mirroring the old split's per-child math).
        perDate = dates.map((d) => ({ date: d, days: workingDays(d, d, hols, workingDaysIso) }));
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
  // configured rest-day roster) and as the UNPAID child would (calendar-days).
  const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
  const workingDaysIso = await resolveWorkingDaysIso(tx, p.employmentId);
  const spanWorkingDays = workingDays(p.startDate, p.endDate, hols, workingDaysIso);
  const uplSpanDays = dayCount(p.startDate, p.endDate);
  if (uplSpanDays <= 0) throw new LeaveNoDaysInRangeError();

  // The span's working-day dates in order — paid segments cut at boundary working-days off the front. Rest
  // days come from the SAME configured roster as the count above (audit H#3), not a hardcoded Sat/Sun.
  const workingDates = eachDate(p.startDate, p.endDate).filter((d) => isWorkingDay(d, workingDaysIso, hols));

  // Build the ordered list of PAID segments and the unpaid remainder. SICK is prepended only for an illness
  // emergency with a real SICK type + positive balance; ANNUAL always follows. Each segment's `cover` is its
  // balance-limited working-day count from resolveEmergencyIllnessCascade (sickCovered then alCovered) — which
  // degrades to exactly the AL→UPL split when there is no sick component, so the non-illness path is unchanged.
  const sickBalance = isIllness && sickId ? await leaveBalance(tx, p.employmentId, sickId) : 0;
  const alBalance = await leaveBalance(tx, p.employmentId, annualId);
  const { sickCovered, alCovered, alShortfall } = resolveEmergencyIllnessCascade(
    sickBalance,
    alBalance,
    spanWorkingDays,
  );

  // Each paid segment carves whole working-days (FLOORed to ≤ its real balance — H4) off the front in order.
  const paidSegments: { typeId: string; code: string; cover: number }[] = [];
  if (isIllness && sickId && sickCovered > 0) paidSegments.push({ typeId: sickId, code: 'SICK', cover: sickCovered });
  if (alCovered > 0) paidSegments.push({ typeId: annualId, code: 'ANNUAL', cover: alCovered });

  // How many whole working-days each paid segment will actually consume, walking the span front-to-back. A
  // fractional remainder of any segment's balance (prorated accrual / half-day debit) cannot be carved as a
  // whole-day child, so it falls through to the next segment / the unpaid remainder.
  let wholeConsumed = 0;
  const plannedPaid: { typeId: string; code: string; wholeDays: number }[] = [];
  for (const seg of paidSegments) {
    const whole = Math.min(Math.floor(seg.cover), workingDates.length - wholeConsumed);
    if (whole > 0) {
      plannedPaid.push({ typeId: seg.typeId, code: seg.code, wholeDays: whole });
      wholeConsumed += whole;
    }
  }
  // The unpaid remainder is every calendar day after the last paid working-day (or the whole span if no paid
  // days were carved). uplDays is in calendar-days, the UNPAID type's own counting mode.
  const hasUnpaid = wholeConsumed < spanWorkingDays;

  // Consent gate (Phase-B #12A): an UNPAID child requires explicit consent — throw BEFORE any insert so a
  // missing acknowledgement leaves nothing persisted.
  if (hasUnpaid && !p.unpaidConsent) {
    // The unpaid remainder in calendar-days, for the error message (the form shows the full split itself).
    const lastPaidWorkingDay = wholeConsumed > 0 ? workingDates[wholeConsumed - 1] : null;
    const uplStart = lastPaidWorkingDay ? eachDate(lastPaidWorkingDay, p.endDate)[1] : p.startDate;
    const uplDays = dayCount(uplStart, p.endDate);
    throw new UnpaidConsentRequiredError(uplDays);
  }

  const parentGroupId = randomUUID();
  const consentAt = hasUnpaid ? new Date() : null;
  const children: { id: string; code: string; days: number }[] = [];

  // Insert each paid segment as a contiguous full-day child [segStart, boundaryWorkingDay].
  let cursor = 0; // index into workingDates of the next un-assigned working-day
  for (const seg of plannedPaid) {
    const segStart = cursor === 0 ? p.startDate : eachDate(workingDates[cursor - 1], p.endDate)[1];
    const boundaryWorkingDay = workingDates[cursor + seg.wholeDays - 1];
    const segDays = workingDays(segStart, boundaryWorkingDay, hols, workingDaysIso);
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: seg.typeId, startDate: segStart, endDate: boundaryWorkingDay,
      days: segDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id, code: seg.code, days: segDays });
    cursor += seg.wholeDays;
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
 *  2B-1 chain is fixed: direct manager (when one exists) then HR. 2B-2 will make this configurable. */
async function generateApprovalSteps(
  tx: Tx,
  tenantId: string,
  leaveRequestId: string,
  employmentId: string,
  leaveTypeId: string,
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

  // 2B-2 (ADR-0039): the chain is data — resolve the company's configured levels.
  const chain = await resolveApprovalChain(tx, co.companyId, leaveTypeId);
  const kinds = chain.filter((k) => k !== 'direct_manager' || hasManager);
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

// endDate is widened in (alongside days/startDate) for the on-approval payroll-impact enrichment below. At
// runtime decideLeave passes the full leave_request row, so endDate is always present; the type just exposes it.
type DecidableLeave = { id: string; employmentId: string; leaveTypeId: string; days: string; startDate: string; endDate: string };

/** Final approval: balance gate + ledger debit + status flip + event. daysOverride (ADR-0068 §4E) lets the
 *  per-date finalization debit only the sum of APPROVED dates instead of the whole request span; it defaults
 *  to req.days for every non-per-date caller (byte-identical behaviour). Guard: since §4C excludes REPLACEMENT
 *  from per-date approval, the daysOverride path never reaches the consumeReplacementLeaveTx branch with a
 *  partial `need`; we assert that invariant so the TOIL consume-on-approve register is never under-consumed. */
async function finalizeLeaveApproval(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  daysOverride?: number,
) {
  const balance = await leaveBalance(tx, req.employmentId, req.leaveTypeId);
  const need = daysOverride ?? Number(req.days);
  if (balance - need < 0) throw new InsufficientLeaveBalanceError();
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
      if (current.approverKind === 'hr_admin') await assertIsHrAdmin(tx, ctx, req.employmentId, 'leave request');
      else await assertCanDecide(tx, ctx, req.employmentId, 'leave request'); // direct_manager
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
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request');
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
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request');

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

    // §4E finalization: only when NO pending dates remain.
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
      await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, {
        rejectReason: rejected.map((d) => `${d.leaveDate}: ${d.rejectReason ?? ''}`).join('; '),
        perDate: rejected.map((d) => ({ date: d.leaveDate, rejectReason: d.rejectReason })),
      });
      return { status: 'rejected' as const };
    }
    // All-approved OR mixed (≥1 approved) → single ledger debit for sum(approved days) + status='approved'.
    // §4A makes balance/calendar/attendance/payroll count ONLY the approved dates regardless of top-level
    // status, so a mixed outcome uses 'approved' + per-date truth (no new "partially_approved" enum this round).
    const approvedDays = approved.reduce((s, d) => s + Number(d.days), 0);
    await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId, approvedDays);
    return { status: 'approved' as const };
  });
}

// ═════════════════════ Partial Leave Cancellation (ADR-0065) ═════════════════════
// After a leave is approved, the employee can give back a SUBSET of the approved dates. The approval splits
// the approved span into contiguous sibling leave_request rows (the Emergency-Leave parent_group_id model),
// each with its own ledger debit, then flips the cancelled segment(s) to status='cancelled' and reverses
// their debit. Because every span consumer (payroll unpaidDaysByEmployment, attendance onLeave,
// plannedAbsences) filters status='approved', a cancelled segment disappears from balance/calendar/payroll
// for free — no read-layer span math. See ADR-0065.

/** Pure date math (no DB) so the service and tests share one implementation. Given the request's full
 *  ordered list of WORKING dates and the set of dates to cancel, partition the working dates into maximal
 *  contiguous runs such that every cancelled date sits in its own single-date segment. Returns the segments
 *  (each `{ from, to, days }`, days = the run's working-day count) in date order, plus the indexes of the
 *  segments that are fully cancelled. Cancelling ALL working dates yields every segment cancelled — the
 *  "cancel-all == cancel request" case falls out with no special path. */
export function splitSpanForCancellation(
  allWorkingDates: string[],
  cancelDates: string[],
): { segments: { from: string; to: string; days: number }[]; cancelledSegmentIndexes: number[] } {
  const cancelSet = new Set(cancelDates);
  const ordered = [...allWorkingDates].sort();
  const segments: { from: string; to: string; days: number }[] = [];
  const cancelledSegmentIndexes: number[] = [];
  let run: string[] = [];
  let runCancelled: boolean | null = null;
  const flush = () => {
    if (run.length === 0) return;
    const idx = segments.length;
    segments.push({ from: run[0], to: run[run.length - 1], days: run.length });
    if (runCancelled) cancelledSegmentIndexes.push(idx);
    run = [];
    runCancelled = null;
  };
  for (const d of ordered) {
    const isCancelled = cancelSet.has(d);
    // A cancelled date is always its own single-date segment; a surviving date extends the current surviving
    // run. So flush whenever the cancelled-ness flips OR the current date is cancelled (force a new segment).
    if (run.length > 0 && (isCancelled || runCancelled !== isCancelled)) flush();
    run.push(d);
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
): Promise<string[]> {
  const hols = await resolveHolidaySet(tx, employmentId, start, end);
  const workingDaysIso = await resolveWorkingDaysIso(tx, employmentId);
  return eachDate(start, end).filter((d) => isWorkingDay(d, workingDaysIso, hols));
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
      .select({ code: leaveType.code })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);
    if (lt?.code === 'REPLACEMENT') {
      // Restoring a REPLACEMENT day via the ledger without re-crediting the toil_accrual register would
      // reintroduce the ghost-credit / negative-balance bug — and there is no inverse of consumeReplacementLeaveTx.
      throw new LeaveCancellationNotAllowedError('replacement (time-off-in-lieu) leave cannot be cancelled');
    }

    // The request's working dates (the only cancellable dates), in the tenant calendar frame. Shared helper so
    // the read layer (UI candidate list) and this gate agree exactly (R5 Build #2 — Fix C, no Mon–Fri drift).
    let workingDates = await workingDatesForSpan(tx, req.employmentId, req.startDate, req.endDate);
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

    // requestedDays = working-day count of the cancel dates (each is a working day by the check above).
    const requestedDays = cancelDates.length;
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
    await assertCanDecide(tx, ctx, cr.employmentId, 'leave cancellation');

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
    const workingDaysIso = await resolveWorkingDaysIso(tx, req.employmentId);
    const workingDates = eachDate(req.startDate, req.endDate).filter((d) => isWorkingDay(d, workingDaysIso, hols));
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
        remainingDates.push(...eachDate(seg.from, seg.to).filter((d) => isWorkingDay(d, workingDaysIso, hols)));
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

// ───────────────────── Leave-year boundary (STATUTORY-SOURCES §5) ─────────────────────

/** Types granted as standing yearly entitlements; situational types are claimed per event. */
export const STANDING_LEAVE_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION'] as const;

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
        // Leave Entitlement Rules Engine: `years` (service at year-open) drives custom band upgrades here,
        // same as the statutory floor's own 2y/5y band upgrades.
        const pol = resolveGradePolicy(policyByType.get(t.id) ?? [], e.gradeId, e.companyId, years);
        // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not this lump grant.
        if (isEarnedMethod(pol?.method)) continue;
        const days = Math.max(pack.leave.entitlement(t.code, years), pol?.days ?? 0);
        if (days <= 0) continue;
        const before = balanceBy.get(key) ?? 0;
        // Carry-forward enhancement: ANNUAL carries only when the explicit toggle is on (back-compat
        // default = cap > 0). When disabled, carryMax collapses to 0 ⇒ full forfeit — the requested
        // "disable carry" behaviour. SICK/HOSPITALIZATION stay 0 (statutory annual reset, EA s.60F).
        const carryMax = t.code === 'ANNUAL' && carryEnabled(pol) ? (pol?.carryMax ?? 0) : 0;
        const carry = Math.min(Math.max(before, 0), carryMax);
        const forfeit = Math.max(0, before - carry);
        if (forfeit > 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: yearStart,
          });
          forfeits += 1;
        }
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: e.employmentId,
          leaveTypeId: t.id,
          entryType: 'accrual',
          days: days.toFixed(2),
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

/** ADR-0040: top every earned policy up to the amount accrued by `asOf`. Idempotent — only the
 *  shortfall is written — so it is safe to run repeatedly (admin button + monthly cron, 2D-2).
 *  The cycle is per company (`leave_cycle`): calendar (1 Jan, joiners pro-rate from their join month)
 *  or anniversary (each employee's cycle anchored to their hire-month anniversary). The full-cycle
 *  total equals max(EA-floor, policy days), so the statutory floor still holds. */
export async function accrueEarnedLeave(ctx: SessionContext, p: { asOf: string }) {
  return withTenant(ctx, async (tx) => {
    const yearStart = `${p.asOf.slice(0, 4)}-01-01`;
    const types = await tx
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(and(inArray(leaveType.code, [...STANDING_LEAVE_CODES]), isNull(leaveType.archivedAt)));
    const typeIds = types.map((t) => t.id);
    if (typeIds.length === 0) return { granted: 0, forfeits: 0 };

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
    if (earnedTypeIds.length === 0) return { granted: 0, forfeits: 0 };

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
        ),
      );
    if (emps.length === 0) return { granted: 0, forfeits: 0 };
    const empIds = emps.map((e) => e.employmentId);

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
          eq(leaveLedger.entryType, 'accrual'),
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
        // 2D-3: cap what carries into the new cycle. ANNUAL carries up to its policy cap; other earned
        // types reset (cap 0). Posted once per cycle, dated at the cycle start (guarded by `forfeited`).
        const carryKey = `${e.employmentId}|${typeId}`;
        if (!forfeited.has(carryKey)) {
          const priorBalance = priorBalanceBy.get(carryKey) ?? 0;
          const cap = type.code === 'ANNUAL' ? pol!.carryMax : 0;
          const carry = Math.min(Math.max(priorBalance, 0), cap);
          const forfeit = Math.round((priorBalance - carry) * 100) / 100;
          if (forfeit > 0) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: e.employmentId,
              leaveTypeId: typeId,
              entryType: 'adjustment',
              days: (-forfeit).toFixed(2),
              effectiveOn: cycleStart,
            });
            forfeited.add(carryKey);
            forfeits += 1;
          }
        }
        const entitlement = Math.max(pack.leave.entitlement(type.code, years), pol!.days);
        if (entitlement <= 0) continue;
        const totalPeriods = pol!.method === 'earned_quarterly' ? 4 : 12;
        const accrualStart =
          e.leaveCycle === 'anniversary' || e.hiredOn <= cycleStart ? cycleStart : `${e.hiredOn.slice(0, 7)}-01`;
        const elapsed = Math.min(totalPeriods, accrualPeriods(accrualStart, p.asOf, pol!.method!));
        const earnedToDate = Math.round((entitlement / totalPeriods) * elapsed * 100) / 100;
        const rows = accrualRowsBy.get(`${e.employmentId}|${typeId}`) ?? [];
        const already = rows.reduce((s, r) => (r.effectiveOn >= cycleStart ? s + r.days : s), 0);
        const toGrant = Math.round((earnedToDate - already) * 100) / 100;
        if (toGrant > 0) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: typeId,
            entryType: 'accrual',
            days: toGrant.toFixed(2),
            effectiveOn: p.asOf,
          });
          granted += 1;
        }
      }
    }
    // One summary event; ledger rows are the per-item audit (deliberate skip, as openLeaveYear).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave.earned-accrual.run',
      actor: actorOf(ctx),
      payload: { asOf: p.asOf, granted, forfeits },
    });
    return { granted, forfeits };
  });
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
    const expiryPolicyYears = policies
      .filter((pol) => parseCarryExpiry(pol.accrual as AccrualConfig | null) != null)
      .map((pol) => Number(pol.validFrom.slice(0, 4)));
    if (expiryPolicyYears.length === 0) return { swept: 0, forfeited: 0 };
    const earliestYear = Math.min(...expiryPolicyYears);

    // For a given leave year, the policies active at its year-open (Jan 1). ADR-0066: carry companyId so
    // the resolver short-circuits onto the employee's own company tier (never another company's carry-cap).
    const activeAt = (yearOpen: string): GradePolicyRow[] =>
      policies
        .filter((pol) => pol.validFrom <= yearOpen && (pol.validTo == null || pol.validTo > yearOpen))
        .map((pol) => ({ gradeId: pol.gradeId, companyId: pol.companyId, accrual: pol.accrual }));

    let swept = 0;
    let forfeitedTotal = 0;
    for (const e of emps) {
      for (const t of annualTypes) {
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
  const days = Math.round(Number(p.days) * 100) / 100;
  if (!Number.isFinite(days) || days <= 0) throw new AdHocLeaveGrantError('Days must be a positive number.');
  const reason = p.reason?.trim();
  if (!reason) throw new AdHocLeaveGrantError('A reason is required (e.g. "CNY 2026").');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveOn)) throw new AdHocLeaveGrantError('A valid effective date is required.');

  // ── Authority (resolves the silent-partial-write critique): a group-wide grant needs a GROUP admin; a
  // company-scoped grant needs admin authority over that company. A company-scoped admin attempting a
  // group-wide grant is rejected outright — never silently scoped down. ──
  // Back-compat: a roles-only session (no `grants`) is group-wide, exactly as withTenant treats it. Build the
  // effective grants the same way so isGroupAdmin / hasGrantFor see a group-wide admin (e.g. test adminCtx).
  const effective: SessionContext =
    ctx.grants != null
      ? ctx
      : { ...ctx, grants: (ctx.roles ?? []).map((role) => ({ role, companyId: null as string | null })) };
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

    let granted = 0;
    for (const e of targets) {
      if (already.has(e.employmentId)) continue;
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
