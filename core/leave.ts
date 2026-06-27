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
import { resolveApprovalChain } from './leave-approval-policy';
import { holidayDatesFor } from './holidays';
import { packFor } from '../localization/registry';
import {
  company,
  employment,
  leaveApprovalStep,
  leaveLedger,
  leavePolicy,
  leaveRequest,
  leaveRequestAttachment,
  leaveType,
  person,
  reportingLine,
} from '../db/schema';

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
  }
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

/** Working days in [start, end]: excludes Sat/Sun and the given holiday dates. */
function workingDays(start: string, end: string, holidays: Set<string>): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(d)) continue;
    n++;
  }
  return n;
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
    reason: string | null;
    employeeRemark: string | null;
    parentGroupId: string | null;
    mandatoryAfterDays: number | null;
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
      status: 'pending',
      reason: v.reason,
      employeeRemark: v.employeeRemark,
      parentGroupId: v.parentGroupId,
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
      mandatoryAfterDays: v.mandatoryAfterDays,
      hasRemark: !!v.employeeRemark,
      ...(v.parentGroupId ? { parentGroupId: v.parentGroupId } : {}),
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
    hours?: number; // ADR-0048: required (and only used) when durationType === 'hourly'
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

    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    const hours = durationType === 'hourly' ? (p.hours ?? null) : null;

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
      workingDayCount = workingDays(p.startDate, p.endDate, hols);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt?.counting === 'working_days' ? workingDayCount! : dayCount(p.startDate, p.endDate);
    } else {
      // Single day already enforced. Working-day guard: reject a half/hourly request that falls on a
      // weekend/holiday for working_days types (workingDayCount === 0) — same error as an empty range.
      if (lt?.counting === 'working_days' && workingDayCount === 0) {
        throw new Error('No leave days in range (end before start, or all non-working)');
      }
      if (durationType === 'hourly') {
        const h = hours ?? 0;
        if (!(h > 0 && h <= DEFAULT_STANDARD_HOURS)) {
          throw new Error(`Hourly leave must be between 0 and ${DEFAULT_STANDARD_HOURS} hours`);
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
    if (days <= 0) throw new Error('No leave days in range (end before start, or all non-working)');

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

    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      days,
      durationType,
      hours,
      reason: p.reason ?? null,
      employeeRemark,
      parentGroupId: null,
      mandatoryAfterDays: lt?.mandatoryAfterDays ?? null,
    });
    return { leaveRequestId: id, days, parentGroupId: null, children: [{ id, code: lt?.code ?? '', days }] };
  });
}

/**
 * Emergency-Leave decomposition (0106). EL is an application type only: this resolves the AL→UPL split at
 * submission against the Annual balance and creates up to two ordinary child requests over the same dates,
 * linked by one parent_group_id. Each child is a full-day request of its own type, so it counts in its own
 * mode natively (ANNUAL = working-days, UNPAID = calendar-days) — the counting-mode mismatch cannot occur.
 *
 * Boundary policy (earliest-days-to-AL): the ANNUAL child covers the earliest working-days up to the
 * AL-covered amount and the UNPAID child covers the remainder of the span. The common cases are trivial —
 * one child spans the whole range when the split is all-AL or all-UPL. For a partial split we walk the
 * span's working days and cut at the boundary working-day: the ANNUAL child runs [start, boundary] and the
 * UNPAID child runs [dayAfterBoundary, end].
 *
 * The split is frozen at submission (against AL balance at that instant). Each child still gates its own
 * balance at its own approval — the ANNUAL child throws InsufficientLeaveBalanceError if AL was drained
 * meanwhile, exactly as a normal AL request would (predictable, already-tested behaviour).
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
  },
): Promise<RequestLeaveResult> {
  // EL is full-day-range only (no durations allow-list) — reject a non-full-day request explicitly.
  if (p.durationType && p.durationType !== 'full_day') {
    throw new LeaveDurationNotAllowedError();
  }
  // Resolve ANNUAL + UNPAID type ids for the tenant. Both are seeded in MY_LEAVE_TYPES; if either is
  // absent, EL cannot decompose — a plain Error (no typed-error / i18n scaffolding).
  const childTypes = await tx
    .select({ id: leaveType.id, code: leaveType.code })
    .from(leaveType)
    .where(inArray(leaveType.code, ['ANNUAL', 'UNPAID']));
  const annualId = childTypes.find((t) => t.code === 'ANNUAL')?.id;
  const unpaidId = childTypes.find((t) => t.code === 'UNPAID')?.id;
  if (!annualId || !unpaidId) {
    throw new Error('Emergency Leave requires Annual and Unpaid leave types to be configured');
  }

  // Count the span twice — once as the ANNUAL child would (working-days, honouring the employee's
  // holidays/state) and once as the UNPAID child would (calendar-days).
  const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
  const alSpanDays = workingDays(p.startDate, p.endDate, hols);
  const uplSpanDays = dayCount(p.startDate, p.endDate);
  if (uplSpanDays <= 0) throw new Error('No leave days in range (end before start, or all non-working)');

  const alBalance = await leaveBalance(tx, p.employmentId, annualId);
  const { alCovered, alShortfall } = resolveEmergencyCascade(alBalance, alSpanDays);

  const parentGroupId = randomUUID();
  const children: { id: string; code: string; days: number }[] = [];

  // The span's working-day dates (ANNUAL counts these). The boundary split assigns the earliest `alCovered`
  // working-days to ANNUAL; the UNPAID child starts the calendar day after the last AL working-day.
  const workingDates = eachDate(p.startDate, p.endDate).filter((d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !hols.has(d);
  });

  if (alShortfall === 0 && alCovered > 0) {
    // Annual fully covers the working-days span → a single ANNUAL child over the whole range.
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: annualId, startDate: p.startDate, endDate: p.endDate,
      days: alCovered, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id, code: 'ANNUAL', days: alCovered });
  } else if (alCovered === 0) {
    // No Annual balance (or empty working-days span) → a single UNPAID child over the whole range.
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: unpaidId, startDate: p.startDate, endDate: p.endDate,
      days: uplSpanDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id, code: 'UNPAID', days: uplSpanDays });
  } else {
    // Partial split: ANNUAL covers the earliest `alCovered` working-days [start, boundary]; UNPAID covers
    // the suffix [dayAfter(boundary), end] counted in calendar-days. alCovered is an integer working-day
    // count here (a full-day EL range has no fractional AL coverage).
    const boundaryWorkingDay = workingDates[Math.ceil(alCovered) - 1];
    const annualEnd = boundaryWorkingDay;
    const uplStart = eachDate(boundaryWorkingDay, p.endDate)[1]; // the calendar day after the boundary
    const uplDays = dayCount(uplStart, p.endDate);
    const annualDays = workingDays(p.startDate, annualEnd, hols);
    const { id: alId } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: annualId, startDate: p.startDate, endDate: annualEnd,
      days: annualDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id: alId, code: 'ANNUAL', days: annualDays });
    const { id: uplId } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: unpaidId, startDate: uplStart, endDate: p.endDate,
      days: uplDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
    });
    children.push({ id: uplId, code: 'UNPAID', days: uplDays });
  }

  const alChildId = children.find((c) => c.code === 'ANNUAL')?.id;
  const uplChildId = children.find((c) => c.code === 'UNPAID')?.id;
  // A single EL command event keyed on parentGroupId, alongside each child's own leave-request.submitted —
  // gives the audit trail / substrate one traceable EL submission.
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: parentGroupId,
    eventType: 'leave-request.emergency.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      employmentId: p.employmentId,
      ...(alChildId ? { alChildId } : {}),
      ...(uplChildId ? { uplChildId } : {}),
      alDays: alCovered,
      uplDays: alShortfall,
      startDate: p.startDate,
      endDate: p.endDate,
    },
  });

  // Keep `leaveRequestId` populated (the AL child when present, else the UPL child) so the existing action
  // layer's destructure stays valid; `days` is the total span (AL + UPL) for parity with the ordinary path.
  return {
    leaveRequestId: (alChildId ?? uplChildId)!,
    days: round2(alCovered + alShortfall),
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

/** Final approval: balance gate + ledger debit + status flip + event. */
async function finalizeLeaveApproval(tx: Tx, ctx: SessionContext, req: DecidableLeave, deciderEmploymentId?: string) {
  const balance = await leaveBalance(tx, req.employmentId, req.leaveTypeId);
  const need = Number(req.days);
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
              days: req.days,
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
  p: { leaveRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
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
        await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { step: current.stepIndex, kind: current.approverKind });
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
    else await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId);
    return { status: p.decision };
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
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, accrual: leavePolicy.accrual })
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
        const pol = resolveGradePolicy(policyByType.get(t.id) ?? [], e.gradeId);
        // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not this lump grant.
        if (isEarnedMethod(pol?.method)) continue;
        const days = Math.max(pack.leave.entitlement(t.code, years), pol?.days ?? 0);
        if (days <= 0) continue;
        const before = balanceBy.get(key) ?? 0;
        const carryMax = t.code === 'ANNUAL' ? (pol?.carryMax ?? 0) : 0;
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

// ── Grade-based policy resolution (ADR-0041 / 2E) ─────────────────────────────────────────────────
export type GradePolicyRow = { gradeId: string | null; accrual: unknown };
/** ADR-0038 carry-forward expiry: the month+day on which the carried-forward ANNUAL portion expires
 *  (e.g. {month:3, day:31} = 31 March of the leave year following the one it was carried into). Stored
 *  as an OFFSET, not a hardcoded date, so it works for any leave-year start. null = never expires. */
export type CarryExpiry = { month: number; day: number };
export type ResolvedPolicy = { days: number; carryMax: number; method?: string; carryExpiry?: CarryExpiry | null };
/** Shape of the `leave_policy.accrual` JSONB (a documented JSONB extension point — no DDL). */
type AccrualConfig = {
  annualDays?: number;
  carryForwardMax?: number;
  method?: string;
  carryForwardExpiryMonth?: number;
  carryForwardExpiryDay?: number;
};
/** Parse the two optional offset fields into a {month, day} (or null when either is absent/out of range). */
function parseCarryExpiry(acc: AccrualConfig | null): CarryExpiry | null {
  const m = Number(acc?.carryForwardExpiryMonth ?? 0);
  const d = Number(acc?.carryForwardExpiryDay ?? 0);
  if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { month: m, day: d };
  return null;
}
/** Resolve the leave policy for an employee's grade among a type's active policies: the most-generous
 *  policy scoped to the employee's grade, else the most-generous null-grade (all-grades) policy, else
 *  null. With no grades assigned (employee + every policy null-grade) this is exactly the pre-2E
 *  "most generous active policy" pick, so existing behavior is unchanged. */
export function resolveGradePolicy(rows: GradePolicyRow[], employeeGradeId: string | null): ResolvedPolicy | null {
  const pick = (subset: GradePolicyRow[]): ResolvedPolicy | null => {
    let best: ResolvedPolicy | null = null;
    for (const r of subset) {
      const acc = r.accrual as AccrualConfig | null;
      const days = Number(acc?.annualDays ?? 0);
      // CRITICAL (panel): carryExpiry must be chosen from the SAME winning policy as days/carryMax/method.
      // Assign it inside this block — never outside — or a rejected lower-`days` policy's expiry can leak
      // onto the selected policy.
      if (!best || days > best.days) {
        best = {
          days,
          carryMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)),
          method: acc?.method,
          carryExpiry: parseCarryExpiry(acc),
        };
      }
    }
    return best;
  };
  const graded = employeeGradeId ? pick(rows.filter((r) => r.gradeId === employeeGradeId)) : null;
  return graded ?? pick(rows.filter((r) => r.gradeId == null));
}

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
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, accrual: leavePolicy.accrual })
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
        // another grade — accrue only when THEIR resolved policy is earned.
        const pol = resolveGradePolicy(policyByType.get(typeId) ?? [], e.gradeId);
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
      .select({ leaveTypeId: leavePolicy.leaveTypeId, gradeId: leavePolicy.gradeId, accrual: leavePolicy.accrual, validFrom: leavePolicy.validFrom, validTo: leavePolicy.validTo })
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

    // For a given leave year, the policies active at its year-open (Jan 1).
    const activeAt = (yearOpen: string): GradePolicyRow[] =>
      policies
        .filter((pol) => pol.validFrom <= yearOpen && (pol.validTo == null || pol.validTo > yearOpen))
        .map((pol) => ({ gradeId: pol.gradeId, accrual: pol.accrual }));

    let swept = 0;
    let forfeitedTotal = 0;
    for (const e of emps) {
      for (const t of annualTypes) {
        // Sweep each candidate leave year Y from the back-compat boundary up to today whose expiry date has
        // arrived. Each year is independently reconstructed + idempotent on its own year-qualified date.
        for (let y = earliestYear; y <= todayYear; y++) {
          const yearStart = `${y}-01-01`;
          const pol = resolveGradePolicy(activeAt(yearStart), e.gradeId);
          const expiry = pol?.carryExpiry ?? null;
          if (!expiry) continue;
          const expiryDate = `${y}-${String(expiry.month).padStart(2, '0')}-${String(expiry.day).padStart(2, '0')}`;
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
          const carriedAmount = Math.min(Math.max(Number(priorRow?.bal ?? 0), 0), carryMax);
          if (carriedAmount <= 0) continue;
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
          const unconsumedCarry = Math.max(0, Math.round((carriedAmount - debitsInWindow) * 100) / 100);
          if (unconsumedCarry <= 0) continue;
          // Cap at what is actually still in the balance now — never tax fresh entitlement / re-forfeit.
          const currentBalance = await leaveBalance(tx, e.employmentId, t.id);
          const forfeit = Math.round(Math.min(unconsumedCarry, Math.max(0, currentBalance)) * 100) / 100;
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
