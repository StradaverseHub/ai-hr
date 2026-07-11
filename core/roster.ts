/**
 * Shift rosters (ADR-0032 Phase C, slice C1). Shift templates per company + per-employee roster
 * assignments — the "expected" schedule the time engine will consume (C2). Each mutation runs inside
 * withTenant and appends a DomainEvent. RLS gates writes (shift → company admin; roster → can_admin_employment).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { attendance, employment, leaveRequest, person, rosterAssignment, shift, type BreakPeriod, type ShiftDifferential, type ShiftOtRule, type ShiftType } from '../db/schema';
import { isoWeekday, shiftSpan } from './attendance';
import { approvedLeaveDates } from './leave';
import { listEmployeesPage } from './read';

const DIFF_KINDS = ['percent', 'flat_hourly', 'flat_per_shift'] as const;

function validateDifferential(d: ShiftDifferential | null | undefined): ShiftDifferential | null {
  if (d == null) return null;
  if (!DIFF_KINDS.includes(d.kind)) throw new Error(`Invalid shift differential kind: ${d.kind}`);
  if (typeof d.value !== 'number' || !Number.isFinite(d.value) || d.value < 0) {
    throw new Error('Shift differential value must be a non-negative number');
  }
  return { kind: d.kind, value: d.value };
}

/** R17 3e8350db — validate the per-shift "OT Rules" field. It shapes WORKDAY OT accrual only (eligibility /
 *  minimum block / daily cap); it deliberately carries NO multiplier (statutory, company-level). A rule that
 *  is fully default (eligible, no min, no cap) collapses to null so existing shifts stay byte-identical. */
function validateOtRule(r: ShiftOtRule | null | undefined): ShiftOtRule | null {
  if (r == null) return null;
  const eligible = r.eligible !== false; // default true
  const nonNeg = (v: number | undefined, label: string): number | undefined => {
    if (v == null) return undefined;
    const n = Math.trunc(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number of minutes`);
    return n;
  };
  const minMinutes = nonNeg(r.minMinutes, 'OT minimum');
  const dailyCapMinutes = nonNeg(r.dailyCapMinutes, 'OT daily cap');
  // Fully-default rule ⇒ null (legacy behaviour).
  if (eligible && minMinutes == null && dailyCapMinutes == null) return null;
  const out: ShiftOtRule = { eligible };
  if (minMinutes != null) out.minMinutes = minMinutes;
  if (dailyCapMinutes != null) out.dailyCapMinutes = dailyCapMinutes;
  return out;
}

const SHIFT_TYPES = ['normal', 'semi_flexi', 'full_flexi'] as const;

/** f3321963 — validate the shift template type. Absent/blank ⇒ 'normal' (legacy behaviour). Any other value
 *  outside the three-value enum is rejected before it can reach the DB CHECK. */
function validateShiftType(v: ShiftType | string | null | undefined): ShiftType {
  if (v == null || v === '') return 'normal';
  if (!(SHIFT_TYPES as readonly string[]).includes(v)) throw new Error(`Invalid shift type: ${v}`);
  return v as ShiftType;
}

/** end ≤ start means the shift runs past midnight (e.g. 22:00:00 → 06:00:00). Times are 'HH:MM:SS', whose
 *  lexicographic order is chronological. */
export const shiftCrossesMidnight = (startTime: string, endTime: string) => endTime <= startTime;

const asShiftTime = (v: string, label: string): string => {
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(v)) throw new Error(`${label} must be HH:MM`);
  return v.length === 5 ? `${v}:00` : v;
};

const hhmmToMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export type ShiftInput = {
  /** R33 f21d6eee — Shared shift library: shifts are tenant-global. Absent/null ⇒ company_id NULL (the new
   *  default for templates authored on the shift-settings page). Legacy callers may still pass a company_id
   *  (kept for back-compat), but the template is no longer scoped by it for assignment. */
  companyId?: string | null;
  name: string;
  code: string;
  /** f3321963 — shift template type: 'normal' | 'semi_flexi' | 'full_flexi'. Absent ⇒ 'normal' (legacy). */
  type?: ShiftType | null;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  /** R7 Phase 1 — multiple break windows. STORAGE-ONLY this phase: the engine / punch import / hourly clamp
   *  keep reading the canonical breakMinutes scalar, persisted as Σ of these durations. */
  breakPeriods?: BreakPeriod[] | null;
  /** Manual normal-working-minutes figure; when set it is the workday OT threshold (deriveAttendance). */
  normalMinutesOverride?: number | null;
  /** R7 Phase 2 — ISO weekdays (1=Mon…7=Sun) that are WORKING days (rest = complement), mirroring
   *  attendance_policy.working_days. Null/empty ⇒ no pattern; the shift cannot drive roster generation. */
  weeklyPattern?: number[] | null;
  /** R17 3e8350db — per-shift late grace (minutes): lateness is measured from shift-start + this. Null ⇒
   *  inherit the company-policy grace (core/attendance.ts). */
  lateGraceMinutes?: number | null;
  /** R17 3e8350db — per-shift early-leave grace (minutes): a checkout before shift-end − this is short.
   *  Null ⇒ inherit the legacy shift-midpoint threshold. */
  earlyLeaveGraceMinutes?: number | null;
  /** R17 3e8350db — the reporter's per-shift "OT Rules". Shapes WORKDAY OT accrual (eligibility / minimum
   *  block / daily cap); statutory multipliers stay company-level. Null ⇒ legacy behaviour. */
  otRule?: ShiftOtRule | null;
  differential?: ShiftDifferential | null;
};

type NormalizedShift = {
  name: string;
  code: string;
  type: ShiftType;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  breakMinutes: number;
  breakPeriods: BreakPeriod[] | null;
  normalMinutesOverride: number | null;
  weeklyPattern: number[] | null;
  lateGraceMinutes: number | null;
  earlyLeaveGraceMinutes: number | null;
  otRule: ShiftOtRule | null;
  differential: ShiftDifferential | null;
};

/** Shared create/update validation. Auto normal-hours is NEVER persisted — it stays span − Σ breaks via the
 *  SHARED core/attendance.ts helpers (shiftSpan / netScheduledMinutes), so the form's figure and the engine's
 *  scheduledMinutes can never drift. */
function normalizeShiftInput(p: Omit<ShiftInput, 'companyId'>): NormalizedShift {
  const name = p.name.trim();
  if (!name) throw new Error('Shift name is required');
  const code = p.code.trim();
  if (!code) throw new Error('Shift code is required');
  const differential = validateDifferential(p.differential);
  const type = validateShiftType(p.type);
  const startTime = asShiftTime(p.startTime, 'Shift start');
  const endTime = asShiftTime(p.endTime, 'Shift end');
  const crossesMidnight = shiftCrossesMidnight(startTime, endTime);
  const span = shiftSpan(startTime, endTime, crossesMidnight);

  // Multi-break is STORAGE-ONLY in Phase 1: the periods are saved and shown, but the deducted hours are the
  // canonical breakMinutes scalar (their sum) — workedFromSpan's all-or-nothing 6h-cliff behaviour is
  // unchanged. True per-window deduction is a deferred Phase-2+ item.
  //
  // f3321963 — per-break Flexible / Clocking-Required flags. A Semi-Flexi shift FORCES flexible=true and
  // clockingRequired=false on EVERY break (the reporter's fixed, non-editable rule); Normal/Full-Flexi keep
  // whatever flags were supplied (absent ⇒ unset, == legacy behaviour, so existing shifts stay byte-identical).
  const semiFlexi = type === 'semi_flexi';
  let breakPeriods: BreakPeriod[] | null = null;
  let breakMinutes = Math.trunc(p.breakMinutes ?? 0);
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0) throw new Error('Break minutes must be a non-negative number');
  if (p.breakPeriods && p.breakPeriods.length > 0) {
    breakPeriods = p.breakPeriods.map((bp) => {
      const start = asShiftTime(bp.start, 'Break start');
      const end = asShiftTime(bp.end, 'Break end');
      // start < end also rejects any break that would cross midnight (Phase 1 excludes overnight breaks).
      if (end <= start) throw new Error('Each break must start before it ends (a break cannot cross midnight)');
      const inside = crossesMidnight ? start >= startTime || end <= endTime : start >= startTime && end <= endTime;
      if (!inside) throw new Error('Each break must fall inside the shift span');
      const out: BreakPeriod = { start, end };
      // Semi-Flexi overrides the flags; otherwise persist only flags that were explicitly set (keep the
      // stored JSON minimal so a plain break is { start, end } exactly as before).
      const flexible = semiFlexi ? true : bp.flexible;
      const clockingRequired = semiFlexi ? false : bp.clockingRequired;
      if (flexible != null) out.flexible = flexible;
      if (clockingRequired != null) out.clockingRequired = clockingRequired;
      return out;
    });
    // Canonical scalar = Σ break durations, so every existing consumer of break_minutes reads byte-identically.
    breakMinutes = breakPeriods.reduce((acc, bp) => acc + (hhmmToMin(bp.end) - hhmmToMin(bp.start)), 0);
  }

  let normalMinutesOverride: number | null = null;
  if (p.normalMinutesOverride != null) {
    const o = Math.trunc(p.normalMinutesOverride);
    if (!Number.isFinite(o) || o < 0 || o > span) throw new Error('Normal-hours override must be between 0 and the shift span');
    normalMinutesOverride = o;
  }

  // R7 Phase 2 — weekly pattern: validated ISO weekdays, deduped + sorted. Empty ⇒ null (a shift with zero
  // working days is "no pattern", not a 7-day rest week).
  let weeklyPattern: number[] | null = null;
  if (p.weeklyPattern && p.weeklyPattern.length > 0) {
    const days = [...new Set(p.weeklyPattern.map((d) => Math.trunc(d)))].sort((a, b) => a - b);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error('Weekly pattern days must be ISO weekday numbers 1 (Mon) … 7 (Sun)');
    }
    weeklyPattern = days;
  }

  // R17 3e8350db — per-shift grace windows. Blank/absent ⇒ null (inherit the legacy behaviour); when
  // supplied they must be non-negative integers. No upper bound beyond the shift span is enforced (a grace
  // larger than the span simply means "never late" / "always short", which is a valid operational choice).
  const grace = (v: number | null | undefined, label: string): number | null => {
    if (v == null) return null;
    const g = Math.trunc(v);
    if (!Number.isFinite(g) || g < 0) throw new Error(`${label} must be a non-negative number of minutes`);
    return g;
  };
  const lateGraceMinutes = grace(p.lateGraceMinutes, 'Late grace');
  const earlyLeaveGraceMinutes = grace(p.earlyLeaveGraceMinutes, 'Early-leave grace');
  const otRule = validateOtRule(p.otRule);

  // The auto figure (used when no override): netScheduledMinutes(startTime, endTime, crossesMidnight,
  // breakMinutes) — derived on the fly by scheduleFor / the UI readout, deliberately not stored.
  return {
    name,
    code,
    type,
    startTime,
    endTime,
    crossesMidnight,
    breakMinutes,
    breakPeriods,
    normalMinutesOverride,
    weeklyPattern,
    lateGraceMinutes,
    earlyLeaveGraceMinutes,
    otRule,
    differential,
  };
}

function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

/** Map a unique-index violation to a friendly message (code vs name), like the admin catalog paths. */
function shiftUniqueError(e: unknown, n: { name: string; code: string }): Error {
  if (isUniqueViolation(e)) {
    let msg = '';
    let cur = e as { message?: string; cause?: unknown } | null | undefined;
    for (let i = 0; cur && i < 4; i++) {
      msg += cur.message ?? '';
      cur = cur.cause as { message?: string; cause?: unknown } | null | undefined;
    }
    // R33 f21d6eee — uniqueness is now tenant-wide (shift_tenant_name_uq / shift_tenant_code_uq).
    if (/shift_tenant_code_uq/i.test(msg)) return new Error(`A shift with code “${n.code}” already exists.`);
    if (/shift_tenant_name_uq/i.test(msg)) return new Error(`A shift named “${n.name}” already exists.`);
    return new Error('A shift with this name or code already exists.');
  }
  return e as Error;
}

export async function createShift(ctx: SessionContext, p: ShiftInput) {
  const n = normalizeShiftInput(p);
  return withTenant(ctx, async (tx) => {
    let row: { id: string };
    try {
      [row] = await tx
        .insert(shift)
        .values({
          tenantId: ctx.tenantId,
          // R33 f21d6eee — tenant-global by default; a passed company_id is honoured for back-compat.
          companyId: p.companyId ?? null,
          name: n.name,
          code: n.code,
          type: n.type,
          startTime: n.startTime,
          endTime: n.endTime,
          breakMinutes: n.breakMinutes,
          breakPeriods: n.breakPeriods,
          normalMinutesOverride: n.normalMinutesOverride,
          weeklyPattern: n.weeklyPattern,
          crossesMidnight: n.crossesMidnight,
          lateGraceMinutes: n.lateGraceMinutes,
          earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes,
          otRule: n.otRule,
          differential: n.differential,
        })
        .returning({ id: shift.id });
    } catch (e) {
      throw shiftUniqueError(e, n);
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: row.id,
      eventType: 'shift.created',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId ?? null,
        name: n.name,
        code: n.code,
        type: n.type,
        startTime: n.startTime,
        endTime: n.endTime,
        breakMinutes: n.breakMinutes,
        breakPeriods: n.breakPeriods,
        normalMinutesOverride: n.normalMinutesOverride,
        weeklyPattern: n.weeklyPattern,
        lateGraceMinutes: n.lateGraceMinutes,
        earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes,
        otRule: n.otRule,
        hasDifferential: !!n.differential,
      },
    });
    return { id: row.id };
  });
}

// R33 f21d6eee — createShiftMulti (R17 multi-company authoring) was RETIRED: shifts are now a single
// tenant-wide library, so "create the same template in several companies" is meaningless — a template is
// created once and assignable to any employee. Use createShift (tenant-global).

export async function updateShift(ctx: SessionContext, p: { shiftId: string } & Omit<ShiftInput, 'companyId'>) {
  const n = normalizeShiftInput(p);
  return withTenant(ctx, async (tx) => {
    try {
      await tx
        .update(shift)
        .set({
          name: n.name,
          code: n.code,
          type: n.type,
          startTime: n.startTime,
          endTime: n.endTime,
          breakMinutes: n.breakMinutes,
          breakPeriods: n.breakPeriods,
          normalMinutesOverride: n.normalMinutesOverride,
          weeklyPattern: n.weeklyPattern,
          crossesMidnight: n.crossesMidnight,
          lateGraceMinutes: n.lateGraceMinutes,
          earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes,
          otRule: n.otRule,
          differential: n.differential,
          updatedAt: new Date(),
        })
        .where(eq(shift.id, p.shiftId));
    } catch (e) {
      throw shiftUniqueError(e, n);
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.updated',
      actor: actorOf(ctx),
      payload: {
        name: n.name,
        code: n.code,
        type: n.type,
        startTime: n.startTime,
        endTime: n.endTime,
        breakMinutes: n.breakMinutes,
        breakPeriods: n.breakPeriods,
        normalMinutesOverride: n.normalMinutesOverride,
        weeklyPattern: n.weeklyPattern,
        lateGraceMinutes: n.lateGraceMinutes,
        earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes,
        otRule: n.otRule,
        hasDifferential: !!n.differential,
      },
    });
    return { id: p.shiftId };
  });
}

// R33 f21d6eee — duplicateShift (R17 same-company / copy-to-company duplication) was RETIRED: the shared
// tenant-wide library removes the reason to duplicate a template (expected_function: "No duplication of
// shifts between companies"). A shift is created once and assigned to any employee.

export class ShiftInUseError extends Error {
  constructor(message = 'This shift is referenced by roster entries or assigned as an employee default — archive it instead of deleting.') {
    super(message);
    this.name = 'ShiftInUseError';
  }
}

/**
 * R17 3e8350db — HARD delete a shift template (the reporter's "Delete", distinct from "Archive"). Archive is
 * the soft path that preserves history and frees the name/code; Delete is for a template created in error /
 * never used. To keep attendance + payroll history intact we REFUSE to hard-delete a shift that is still
 * referenced — any roster_assignment (past or future) or any employee's default_shift_id — and steer HR to
 * Archive instead (ShiftInUseError). Only a genuinely-unreferenced row is removed. RLS (migration 0075:
 * is_admin_for(company_id)) gates who may delete which company's shifts; the GRANT includes DELETE.
 */
export async function deleteShift(ctx: SessionContext, p: { shiftId: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx
      .select({ id: shift.id, companyId: shift.companyId, name: shift.name, code: shift.code })
      .from(shift)
      .where(eq(shift.id, p.shiftId))
      .limit(1);
    if (!src) throw new Error('Shift not found (or not visible)');
    // Referenced by any roster assignment? (RLS scopes visibility, but the count is enough — any hit blocks.)
    const [ra] = await tx
      .select({ id: rosterAssignment.id })
      .from(rosterAssignment)
      .where(eq(rosterAssignment.shiftId, p.shiftId))
      .limit(1);
    if (ra) throw new ShiftInUseError();
    // Assigned as any employee's default (Fixed-shift arrangement)?
    const [emp] = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.defaultShiftId, p.shiftId))
      .limit(1);
    if (emp) throw new ShiftInUseError();
    await tx.delete(shift).where(eq(shift.id, p.shiftId));
    // SUBSTRATE: the row is gone but the append log is independent — record the deletion (aggregateId = the
    // now-deleted shift id; the human key lives in the payload).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.deleted',
      actor: actorOf(ctx),
      payload: { companyId: src.companyId, name: src.name, code: src.code },
    });
    return { id: p.shiftId };
  });
}

// NOTE (R7 Phase 1): Archive is the DEFAULT removal path — it frees the name/code (partial-unique indexes
// skip archived rows) and preserves DomainEvent + payslip OT references, matching the soft-delete precedent
// everywhere else (leave types, pay components, business units). deleteShift (above, R17) is the hard path,
// allowed only for an unreferenced template.
export async function archiveShift(ctx: SessionContext, p: { shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(shift).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(shift.id, p.shiftId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.archived',
      actor: actorOf(ctx),
      payload: { shiftId: p.shiftId },
    });
    return { id: p.shiftId };
  });
}

/** Company-scoped shift list. R33 f21d6eee — RETAINED for back-compat with legacy per-company rows/tests;
 *  it will NOT return tenant-global templates (company_id NULL). New product surfaces use listShiftsForTenant. */
export function listShifts(ctx: SessionContext, companyId: string, opts?: { includeArchived?: boolean }) {
  return withTenant(ctx, (tx) => {
    const conds = [eq(shift.companyId, companyId)];
    if (!opts?.includeArchived) conds.push(isNull(shift.archivedAt));
    return tx.select().from(shift).where(and(...conds)).orderBy(asc(shift.startTime), asc(shift.name));
  });
}

/** R33 f21d6eee — the SHARED shift library: every shift in the tenant regardless of company_id (including the
 *  tenant-global NULL-company templates authored on the shift-settings page). RLS already scopes to the
 *  caller's tenant. This is what the shift-settings page, the roster picker, and the employee-profile
 *  Fixed-shift picker read, so a template authored once is assignable to any employee tenant-wide. */
export function listShiftsForTenant(ctx: SessionContext, opts?: { includeArchived?: boolean }) {
  return withTenant(ctx, (tx) => {
    const conds = opts?.includeArchived ? [] : [isNull(shift.archivedAt)];
    return tx
      .select()
      .from(shift)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(shift.startTime), asc(shift.name));
  });
}

// ── Per-employee default shift (ec4cbf63 rev-6: "assigned to the staff in their profile") ──────────

// R33 f21d6eee — ShiftCompanyMismatchError was REMOVED. Shifts are a tenant-wide shared library, so a
// template may be assigned to ANY employee in the tenant regardless of which company (if any) authored it.
// The same-company guard is gone; ArchivedShiftError + FixedShiftRequiresShiftError still apply.

export class ArchivedShiftError extends Error {
  constructor(message = 'An archived shift cannot be assigned as a default shift') {
    super(message);
    this.name = 'ArchivedShiftError';
  }
}

export class FixedShiftRequiresShiftError extends Error {
  constructor(message = 'A Fixed shift arrangement requires a default shift to be selected') {
    super(message);
    this.name = 'FixedShiftRequiresShiftError';
  }
}

export type EmployeeShiftType = 'fixed' | 'roster';

/**
 * R17 3e8350db — set an employee's shift ARRANGEMENT (the reporter's "Shift Type") plus, for a Fixed
 * arrangement, the default shift. This is the single write path that keeps `shift_type` and
 * `default_shift_id` consistent so the engine never sees a contradictory pair:
 *   • Fixed  ⇒ a default shift is REQUIRED (validated same-company + non-archived, exactly like the legacy
 *     assignDefaultShift). The person follows that shift every working day.
 *   • Roster ⇒ default_shift_id is FORCED to null. The person is scheduled purely from /roster; a day with
 *     no roster row falls back to the flat company policy (== the pre-default-shift behaviour).
 * The attendance engine (core/attendance.ts scheduleFor) keeps resolving roster row → default shift → policy,
 * so it needs no change: a roster employee simply has no default shift for the middle step.
 */
export async function assignEmployeeShift(
  ctx: SessionContext,
  p: { employmentId: string; shiftType: EmployeeShiftType; shiftId: string | null },
): Promise<{ id: string }> {
  // Roster arrangement never carries a permanent shift on the profile.
  const shiftId = p.shiftType === 'roster' ? null : p.shiftId;
  if (p.shiftType === 'fixed' && !shiftId) throw new FixedShiftRequiresShiftError();
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({
        id: employment.id,
        beforeShift: employment.defaultShiftId,
        beforeType: employment.shiftType,
      })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found');
    if (shiftId != null) {
      const [sh] = await tx
        .select({ id: shift.id, archivedAt: shift.archivedAt })
        .from(shift)
        .where(eq(shift.id, shiftId))
        .limit(1);
      if (!sh) throw new Error('Shift not found');
      // R33 f21d6eee — no same-company check: a shared-library shift is assignable to any tenant employee.
      if (sh.archivedAt) throw new ArchivedShiftError();
    }
    await tx
      .update(employment)
      .set({ shiftType: p.shiftType, defaultShiftId: shiftId })
      .where(eq(employment.id, p.employmentId));
    // SUBSTRATE: state change on employment → append the DomainEvent after the write succeeds.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.shift-arrangement.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        before: { shiftType: emp.beforeType, defaultShiftId: emp.beforeShift },
        after: { shiftType: p.shiftType, defaultShiftId: shiftId },
      },
    });
    return { id: p.employmentId };
  });
}

/** Legacy default-shift assignment (ec4cbf63). Kept for back-compat: setting a shift is a Fixed
 *  arrangement, clearing it is a Roster arrangement. Delegates to assignEmployeeShift so `shift_type` stays
 *  in lockstep with `default_shift_id`. */
export async function assignDefaultShift(
  ctx: SessionContext,
  p: { employmentId: string; shiftId: string | null },
): Promise<{ id: string }> {
  return assignEmployeeShift(ctx, {
    employmentId: p.employmentId,
    shiftType: p.shiftId ? 'fixed' : 'roster',
    shiftId: p.shiftId,
  });
}

// ── Roster assignments ──────────────────────────────────────────────

/** Assign (or re-assign) a shift to an employee on a date. Upsert: one assignment per (employee, date). */
export async function assignShift(ctx: SessionContext, p: { employmentId: string; shiftDate: string; shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(rosterAssignment)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: p.shiftId, isRestDay: false })
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: p.shiftId, isRestDay: false, updatedAt: new Date() },
      })
      .returning({ id: rosterAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.shift.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: p.shiftId },
    });
    return { id: row.id };
  });
}

/** Mark a date as an explicit rest day for an employee (vs no row = company-policy fallback). */
export async function setRestDay(ctx: SessionContext, p: { employmentId: string; shiftDate: string; note?: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(rosterAssignment)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: null, isRestDay: true, note: p.note ?? null })
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: null, isRestDay: true, note: p.note ?? null, updatedAt: new Date() },
      })
      .returning({ id: rosterAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.rest-day.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate },
    });
    return { id: row.id };
  });
}

/** Remove an assignment → the date falls back to the company policy. */
export async function clearRoster(ctx: SessionContext, p: { employmentId: string; shiftDate: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(rosterAssignment)
      .where(and(eq(rosterAssignment.employmentId, p.employmentId), eq(rosterAssignment.shiftDate, p.shiftDate)))
      .returning({ id: rosterAssignment.id });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate },
    });
    return { id: row.id };
  });
}

/** Bulk-assign one shift to many employees across many dates (the roster-grid workhorse). One summary
 *  event (per-row events would spam the log at 4,500-staff scale — documented skip). */
export async function assignShiftBulk(
  ctx: SessionContext,
  p: { employmentIds: string[]; shiftDates: string[]; shiftId: string },
) {
  if (p.employmentIds.length === 0 || p.shiftDates.length === 0) return { assigned: 0 };
  const values = p.employmentIds.flatMap((employmentId) =>
    p.shiftDates.map((shiftDate) => ({ tenantId: ctx.tenantId, employmentId, shiftDate, shiftId: p.shiftId, isRestDay: false })),
  );
  return withTenant(ctx, async (tx) => {
    await tx
      .insert(rosterAssignment)
      .values(values)
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: sql`excluded.shift_id`, isRestDay: false, updatedAt: new Date() },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: p.shiftId,
      eventType: 'roster.bulk.assigned',
      actor: actorOf(ctx),
      payload: { shiftId: p.shiftId, employmentCount: p.employmentIds.length, dateCount: p.shiftDates.length, rows: values.length },
    });
    return { assigned: values.length };
  });
}

/** Bulk-mark rest days for many employees across many dates — the rest-day half of roster generation,
 *  mirroring assignShiftBulk's idempotent upsert. ONE thin summary event (per-row roster.rest-day.set
 *  events would spam the log at scale — documented skip, same rationale as assignShiftBulk), anchored on
 *  the driving shift template exactly like roster.bulk.assigned. */
async function setRestDayBulk(ctx: SessionContext, p: { employmentIds: string[]; shiftDates: string[]; forShiftId: string }) {
  if (p.employmentIds.length === 0 || p.shiftDates.length === 0) return { rested: 0 };
  const values = p.employmentIds.flatMap((employmentId) =>
    p.shiftDates.map((shiftDate) => ({ tenantId: ctx.tenantId, employmentId, shiftDate, shiftId: null, isRestDay: true })),
  );
  return withTenant(ctx, async (tx) => {
    await tx
      .insert(rosterAssignment)
      .values(values)
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: null, isRestDay: true, updatedAt: new Date() },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: p.forShiftId,
      eventType: 'roster.bulk.rest-day.set',
      actor: actorOf(ctx),
      payload: { shiftId: p.forShiftId, employmentCount: p.employmentIds.length, dateCount: p.shiftDates.length, rows: values.length },
    });
    return { rested: values.length };
  });
}

const DAY_MS = 86_400_000;
const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * R7 Multi-Shift Phase 2 — generate a roster window from a shift's weekly pattern. A THIN date-splitter
 * over the EXISTING bulk primitives (assignShiftBulk / setRestDayBulk, both idempotent upserts on
 * (employee, date)) — deliberately NOT a new subsystem.
 *
 * TWO-SOURCES RECONCILIATION (the load-bearing rule): the shift's weekly_pattern and the company
 * attendance_policy.working_days can disagree, and scheduleFor prefers a roster row over the policy
 * branch. So the generator writes a row for EVERY date in the window — a WORKING row on pattern working
 * days AND an explicit isRestDay row on pattern rest days — so an uncovered date never silently falls
 * back to the company policy. The shift's Saturday-working / Saturday-rest choice always wins on
 * generated dates; dates outside the window keep the policy fallback.
 *
 * Scope: explicit employmentIds, or a departmentId resolved via listEmployeesPage's current-assignment
 * department filter (listEmployees has NO dept filter). Terminated employees are excluded — generating
 * schedule rows for leavers is never wanted.
 *
 * Events: assignShiftBulk fires its existing roster.bulk.assigned; the rest half fires one thin
 * roster.bulk.rest-day.set summary. NO separate roster.generated event (nothing would branch on it).
 */
export async function generateRosterFromTemplate(
  ctx: SessionContext,
  p: { shiftId: string; employmentIds?: string[]; departmentId?: string; from: string; to: string },
) {
  if (!isIsoDate(p.from) || !isIsoDate(p.to)) throw new Error('Dates must be YYYY-MM-DD');
  const fromMs = Date.parse(`${p.from}T00:00:00Z`);
  const toMs = Date.parse(`${p.to}T00:00:00Z`);
  if (toMs < fromMs) throw new Error('The end date must not be before the start date');
  if (toMs - fromMs > 366 * DAY_MS) throw new Error('Generate at most one year at a time');

  const [tpl] = await withTenant(ctx, (tx) =>
    tx
      .select({ companyId: shift.companyId, weeklyPattern: shift.weeklyPattern, archivedAt: shift.archivedAt })
      .from(shift)
      .where(eq(shift.id, p.shiftId))
      .limit(1),
  );
  if (!tpl) throw new Error('Shift not found (or not visible)');
  if (tpl.archivedAt) throw new Error('Cannot generate a roster from an archived shift');
  if (!tpl.weeklyPattern || tpl.weeklyPattern.length === 0) {
    throw new Error('This shift has no weekly working-day pattern — set one on the shift first');
  }

  let employmentIds: string[];
  if (p.departmentId) {
    // Department scope — the reuse path that actually exists: listEmployeesPage's current-assignment
    // (validTo IS NULL AND supersededAt IS NULL) department filter, mapped to employmentIds.
    const page = await listEmployeesPage(ctx, {
      departmentId: p.departmentId,
      // R33 f21d6eee — a tenant-global shift (company_id NULL) has no company to narrow by; the department
      // already belongs to one company, so scope by department alone. Legacy company-stamped shifts still narrow.
      companyIds: tpl.companyId ? [tpl.companyId] : undefined,
      status: 'active',
      limit: 100_000,
      offset: 0,
    });
    employmentIds = page.rows.map((r) => r.employmentId);
  } else {
    employmentIds = [...new Set(p.employmentIds ?? [])];
  }
  if (employmentIds.length === 0) throw new Error('No employees in scope — pick employees or a department with members');

  const pattern = tpl.weeklyPattern;
  const workingDates: string[] = [];
  const restDates: string[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const iso = new Date(ms).toISOString().slice(0, 10);
    (pattern.includes(isoWeekday(iso)) ? workingDates : restDates).push(iso);
  }

  const assigned = await assignShiftBulk(ctx, { employmentIds, shiftDates: workingDates, shiftId: p.shiftId });
  const rested = await setRestDayBulk(ctx, { employmentIds, shiftDates: restDates, forShiftId: p.shiftId });
  return {
    employments: employmentIds.length,
    workingDates: workingDates.length,
    restDates: restDates.length,
    workingRows: assigned.assigned,
    restRows: rested.rested,
  };
}

/**
 * R17 3e8350db — "Copy roster schedules from previous weeks or months". Copy every roster row (shift
 * assignments AND explicit rest days) from a SOURCE date window forward onto a TARGET window that starts at
 * `targetFrom`, preserving each row's day-offset from the source start. Concretely: for a source Mon–Sun
 * week and a target starting the following Monday, each day lands on the same weekday one week later. The
 * source and target may be any length (a week, a month, …); the offset = targetFrom − sourceFrom in whole
 * days is applied to every source row, so the target window mirrors the source shape exactly.
 *
 * Scope: explicit employmentIds (the roster-grid's current company roster), else every employee visible to
 * the caller under RLS. Idempotent upsert on (employee, date) — re-running overwrites the same target dates,
 * exactly like the generator. ONE thin summary event (per-row events would spam the log — same documented
 * skip rationale as assignShiftBulk). Read via rosterForRange semantics; writes respect the roster RLS
 * (can_admin_employment), so a manager can only copy rows for employees they administer.
 */
export async function copyRoster(
  ctx: SessionContext,
  p: { employmentIds?: string[]; sourceFrom: string; sourceTo: string; targetFrom: string },
): Promise<{ copied: number; sourceRows: number }> {
  if (!isIsoDate(p.sourceFrom) || !isIsoDate(p.sourceTo) || !isIsoDate(p.targetFrom)) {
    throw new Error('Dates must be YYYY-MM-DD');
  }
  const srcFromMs = Date.parse(`${p.sourceFrom}T00:00:00Z`);
  const srcToMs = Date.parse(`${p.sourceTo}T00:00:00Z`);
  if (srcToMs < srcFromMs) throw new Error('The source end date must not be before the source start date');
  if (srcToMs - srcFromMs > 366 * DAY_MS) throw new Error('Copy at most one year of source roster at a time');
  const offsetDays = Math.round((Date.parse(`${p.targetFrom}T00:00:00Z`) - srcFromMs) / DAY_MS);
  if (offsetDays === 0) throw new Error('The target start date must differ from the source start date');

  const empIds = [...new Set((p.employmentIds ?? []).filter(Boolean))];
  return withTenant(ctx, async (tx) => {
    const srcConds = [gte(rosterAssignment.shiftDate, p.sourceFrom), lte(rosterAssignment.shiftDate, p.sourceTo)];
    if (empIds.length > 0) srcConds.push(inArray(rosterAssignment.employmentId, empIds));
    const srcRows = await tx
      .select({
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        shiftId: rosterAssignment.shiftId,
        isRestDay: rosterAssignment.isRestDay,
        note: rosterAssignment.note,
      })
      .from(rosterAssignment)
      .where(and(...srcConds));
    if (srcRows.length === 0) return { copied: 0, sourceRows: 0 };

    const shift1 = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + offsetDays * DAY_MS).toISOString().slice(0, 10);
    const values = srcRows.map((r) => ({
      tenantId: ctx.tenantId,
      employmentId: r.employmentId,
      shiftDate: shift1(r.shiftDate),
      shiftId: r.shiftId,
      isRestDay: r.isRestDay,
      note: r.note ?? null,
    }));
    await tx
      .insert(rosterAssignment)
      .values(values)
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: sql`excluded.shift_id`, isRestDay: sql`excluded.is_rest_day`, note: sql`excluded.note`, updatedAt: new Date() },
      });
    // Thin summary event on a virtual aggregate (UUID-typed aggregate_id) — the copied window is described in
    // the payload; per-row events would flood the log at scale (same skip as assignShiftBulk).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: randomUUID(),
      eventType: 'roster.copied',
      actor: actorOf(ctx),
      payload: {
        sourceFrom: p.sourceFrom,
        sourceTo: p.sourceTo,
        targetFrom: p.targetFrom,
        offsetDays,
        rows: values.length,
        employmentScope: empIds.length > 0 ? empIds.length : 'all-visible',
      },
    });
    return { copied: values.length, sourceRows: srcRows.length };
  });
}

/** The roster grid for a date window (admin/manager view; RLS scopes which employees are visible). */
export function rosterForRange(ctx: SessionContext, p: { employmentIds?: string[]; from: string; to: string }) {
  return withTenant(ctx, (tx) => {
    const conds = [gte(rosterAssignment.shiftDate, p.from), lte(rosterAssignment.shiftDate, p.to)];
    if (p.employmentIds && p.employmentIds.length > 0) conds.push(inArray(rosterAssignment.employmentId, p.employmentIds));
    return tx
      .select({
        id: rosterAssignment.id,
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        shiftId: rosterAssignment.shiftId,
        isRestDay: rosterAssignment.isRestDay,
        note: rosterAssignment.note,
      })
      .from(rosterAssignment)
      .where(and(...conds))
      .orderBy(asc(rosterAssignment.shiftDate));
  });
}

// ── Roster vs actual (ADR-0032 C4) ──────────────────────────────────

export type RosterVarianceKind = 'no_show' | 'late' | 'short' | 'on_track' | 'rest_worked';
export type RosterVarianceRow = {
  employmentId: string;
  name: string;
  shiftDate: string;
  shiftName: string | null;
  isRestDay: boolean;
  expectedMinutes: number | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  status: string | null;
  kind: RosterVarianceKind;
};

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Compare the roster (expected) to attendance (actual) over a date range. For each rostered shift: a
 * no-show (rostered, no attendance, not on leave, date ≤ today), a late check-in, short hours (worked <
 * the shift's scheduled minutes), or on-track. A rostered rest day with an attendance row is rest_worked.
 * RLS scopes which employees are visible. Read-only.
 */
export function rosterVariance(
  ctx: SessionContext,
  p: { from: string; to: string; companyIds?: string[]; today?: string },
): Promise<RosterVarianceRow[]> {
  return withTenant(ctx, async (tx) => {
    const today = p.today ?? new Date().toISOString().slice(0, 10);
    const ras = await tx
      .select({
        employmentId: rosterAssignment.employmentId,
        name: person.fullName,
        shiftDate: rosterAssignment.shiftDate,
        isRestDay: rosterAssignment.isRestDay,
        shiftName: shift.name,
        start: shift.startTime,
        end: shift.endTime,
        brk: shift.breakMinutes,
        crosses: shift.crossesMidnight,
      })
      .from(rosterAssignment)
      .innerJoin(employment, eq(employment.id, rosterAssignment.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          gte(rosterAssignment.shiftDate, p.from),
          lte(rosterAssignment.shiftDate, p.to),
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
        ),
      );
    if (ras.length === 0) return [];
    const empIds = [...new Set(ras.map((r) => r.employmentId))];

    const [atts, fullDayLeaveDates, partialLeaves] = await Promise.all([
      tx
        .select({
          employmentId: attendance.employmentId,
          date: attendance.attendanceDate,
          checkInAt: attendance.checkInAt,
          checkOutAt: attendance.checkOutAt,
          workedMinutes: attendance.workedMinutes,
          status: attendance.status,
        })
        .from(attendance)
        .where(and(inArray(attendance.employmentId, empIds), gte(attendance.attendanceDate, p.from), lte(attendance.attendanceDate, p.to))),
      // ADR-0068 §4A: full-day approved leave, per-date-aware — a per-date request's interior REJECTED date no
      // longer suppresses the no-show for that day. (approvedLeaveDates filters full_day and honours per-date
      // decisions.)
      approvedLeaveDates(tx, empIds, p.from, p.to),
      // Non-full-day approved leave (half/hourly) keeps its whole-span suppression, unchanged — these have no
      // per-date decomposition and are single-day by nature.
      tx
        .select({ employmentId: leaveRequest.employmentId, startDate: leaveRequest.startDate, endDate: leaveRequest.endDate })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.status, 'approved'),
            sql`${leaveRequest.durationType} <> 'full_day'`,
            inArray(leaveRequest.employmentId, empIds),
            lte(leaveRequest.startDate, p.to),
            gte(leaveRequest.endDate, p.from),
          ),
        ),
    ]);
    const attBy = new Map(atts.map((a) => [`${a.employmentId}|${a.date}`, a]));
    const onLeave = (emp: string, d: string) =>
      (fullDayLeaveDates.get(emp)?.has(d) ?? false) ||
      partialLeaves.some((l) => l.employmentId === emp && l.startDate <= d && d <= l.endDate);

    const out: RosterVarianceRow[] = [];
    for (const r of ras) {
      const att = attBy.get(`${r.employmentId}|${r.shiftDate}`) ?? null;
      const expectedMinutes =
        r.isRestDay || !r.start || !r.end
          ? null
          : Math.max(0, (r.crosses ? toMin(r.end) + 1440 - toMin(r.start) : toMin(r.end) - toMin(r.start)) - (r.brk ?? 0));
      let kind: RosterVarianceKind;
      if (r.isRestDay) {
        if (!att) continue; // rest day with no work is expected
        kind = 'rest_worked';
      } else if (!att) {
        if (onLeave(r.employmentId, r.shiftDate)) continue; // leave is not a no-show
        if (r.shiftDate > today) continue; // future shift, not yet due
        kind = 'no_show';
      } else if (att.status === 'late') {
        kind = 'late';
      } else if (att.workedMinutes != null && expectedMinutes != null && att.workedMinutes < expectedMinutes) {
        kind = 'short';
      } else {
        kind = 'on_track';
      }
      out.push({
        employmentId: r.employmentId,
        name: r.name,
        shiftDate: r.shiftDate,
        shiftName: r.shiftName,
        isRestDay: r.isRestDay,
        expectedMinutes,
        checkInAt: att?.checkInAt ?? null,
        checkOutAt: att?.checkOutAt ?? null,
        workedMinutes: att?.workedMinutes ?? null,
        status: att?.status ?? null,
        kind,
      });
    }
    return out.sort((a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.name.localeCompare(b.name));
  });
}
