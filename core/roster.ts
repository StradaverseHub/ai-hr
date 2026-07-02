/**
 * Shift rosters (ADR-0032 Phase C, slice C1). Shift templates per company + per-employee roster
 * assignments — the "expected" schedule the time engine will consume (C2). Each mutation runs inside
 * withTenant and appends a DomainEvent. RLS gates writes (shift → company admin; roster → can_admin_employment).
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { attendance, employment, leaveRequest, person, rosterAssignment, shift, type BreakPeriod, type ShiftDifferential } from '../db/schema';
import { shiftSpan } from './attendance';
import { approvedLeaveDates } from './leave';

const DIFF_KINDS = ['percent', 'flat_hourly', 'flat_per_shift'] as const;

function validateDifferential(d: ShiftDifferential | null | undefined): ShiftDifferential | null {
  if (d == null) return null;
  if (!DIFF_KINDS.includes(d.kind)) throw new Error(`Invalid shift differential kind: ${d.kind}`);
  if (typeof d.value !== 'number' || !Number.isFinite(d.value) || d.value < 0) {
    throw new Error('Shift differential value must be a non-negative number');
  }
  return { kind: d.kind, value: d.value };
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
  companyId: string;
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  /** R7 Phase 1 — multiple break windows. STORAGE-ONLY this phase: the engine / punch import / hourly clamp
   *  keep reading the canonical breakMinutes scalar, persisted as Σ of these durations. */
  breakPeriods?: BreakPeriod[] | null;
  /** Manual normal-working-minutes figure; when set it is the workday OT threshold (deriveAttendance). */
  normalMinutesOverride?: number | null;
  differential?: ShiftDifferential | null;
};

type NormalizedShift = {
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  breakMinutes: number;
  breakPeriods: BreakPeriod[] | null;
  normalMinutesOverride: number | null;
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
  const startTime = asShiftTime(p.startTime, 'Shift start');
  const endTime = asShiftTime(p.endTime, 'Shift end');
  const crossesMidnight = shiftCrossesMidnight(startTime, endTime);
  const span = shiftSpan(startTime, endTime, crossesMidnight);

  // Multi-break is STORAGE-ONLY in Phase 1: the periods are saved and shown, but the deducted hours are the
  // canonical breakMinutes scalar (their sum) — workedFromSpan's all-or-nothing 6h-cliff behaviour is
  // unchanged. True per-window deduction is a deferred Phase-2+ item.
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
      return { start, end };
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
  // The auto figure (used when no override): netScheduledMinutes(startTime, endTime, crossesMidnight,
  // breakMinutes) — derived on the fly by scheduleFor / the UI readout, deliberately not stored.
  return { name, code, startTime, endTime, crossesMidnight, breakMinutes, breakPeriods, normalMinutesOverride, differential };
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
    if (/shift_company_code_uq/i.test(msg)) return new Error(`A shift with code “${n.code}” already exists in this company.`);
    if (/shift_company_name_uq/i.test(msg)) return new Error(`A shift named “${n.name}” already exists in this company.`);
    return new Error('A shift with this name or code already exists in this company.');
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
          companyId: p.companyId,
          name: n.name,
          code: n.code,
          startTime: n.startTime,
          endTime: n.endTime,
          breakMinutes: n.breakMinutes,
          breakPeriods: n.breakPeriods,
          normalMinutesOverride: n.normalMinutesOverride,
          crossesMidnight: n.crossesMidnight,
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
        companyId: p.companyId,
        name: n.name,
        code: n.code,
        startTime: n.startTime,
        endTime: n.endTime,
        breakMinutes: n.breakMinutes,
        breakPeriods: n.breakPeriods,
        normalMinutesOverride: n.normalMinutesOverride,
        hasDifferential: !!n.differential,
      },
    });
    return { id: row.id };
  });
}

export async function updateShift(ctx: SessionContext, p: { shiftId: string } & Omit<ShiftInput, 'companyId'>) {
  const n = normalizeShiftInput(p);
  return withTenant(ctx, async (tx) => {
    try {
      await tx
        .update(shift)
        .set({
          name: n.name,
          code: n.code,
          startTime: n.startTime,
          endTime: n.endTime,
          breakMinutes: n.breakMinutes,
          breakPeriods: n.breakPeriods,
          normalMinutesOverride: n.normalMinutesOverride,
          crossesMidnight: n.crossesMidnight,
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
        startTime: n.startTime,
        endTime: n.endTime,
        breakMinutes: n.breakMinutes,
        breakPeriods: n.breakPeriods,
        normalMinutesOverride: n.normalMinutesOverride,
        hasDifferential: !!n.differential,
      },
    });
    return { id: p.shiftId };
  });
}

/** First free candidate from an incrementing naming scheme (collision-safe: a second duplicate of the same
 *  source lands on "(copy 2)" / "-copy-2" instead of tripping the unique index). */
const firstFree = (mk: (i: number) => string, taken: (v: string) => boolean): string => {
  for (let i = 1; ; i++) {
    const v = mk(i);
    if (!taken(v)) return v;
  }
};

/** Duplicate a shift template: a FULL-field copy — including the differential (dropping it would silently
 *  lose the shift-premium pay rule), breakPeriods, and the normal-hours override — under collision-safe
 *  "(copy)" / "(copy 2)" name and "-copy" / "-copy-2" code suffixes chosen against the company's
 *  non-archived rows. Emits shift.created with payload.duplicatedFrom (no new event type — nothing
 *  branches on provenance). RLS scopes which source shifts are visible. */
export async function duplicateShift(ctx: SessionContext, p: { shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx.select().from(shift).where(eq(shift.id, p.shiftId)).limit(1);
    if (!src) throw new Error('Shift not found (or not visible)');
    const existing = await tx
      .select({ name: shift.name, code: shift.code })
      .from(shift)
      .where(and(eq(shift.companyId, src.companyId), isNull(shift.archivedAt)));
    const names = new Set(existing.map((r) => r.name));
    const codes = new Set(existing.map((r) => (r.code ?? '').toLowerCase()));
    const name = firstFree((i) => (i === 1 ? `${src.name} (copy)` : `${src.name} (copy ${i})`), (v) => names.has(v));
    const srcCode = src.code ?? 'SHIFT'; // legacy rows are backfilled by 0139; belt-and-braces fallback
    const code = firstFree((i) => (i === 1 ? `${srcCode}-copy` : `${srcCode}-copy-${i}`), (v) => codes.has(v.toLowerCase()));
    let row: { id: string };
    try {
      [row] = await tx
        .insert(shift)
        .values({
          tenantId: ctx.tenantId,
          companyId: src.companyId,
          name,
          code,
          startTime: src.startTime,
          endTime: src.endTime,
          breakMinutes: src.breakMinutes,
          breakPeriods: src.breakPeriods,
          normalMinutesOverride: src.normalMinutesOverride,
          crossesMidnight: src.crossesMidnight,
          differential: src.differential,
          archivedAt: null,
        })
        .returning({ id: shift.id });
    } catch (e) {
      throw shiftUniqueError(e, { name, code });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: row.id,
      eventType: 'shift.created',
      actor: actorOf(ctx),
      payload: {
        companyId: src.companyId,
        name,
        code,
        startTime: src.startTime,
        endTime: src.endTime,
        breakMinutes: src.breakMinutes,
        breakPeriods: src.breakPeriods,
        normalMinutesOverride: src.normalMinutesOverride,
        hasDifferential: !!src.differential,
        duplicatedFrom: p.shiftId,
      },
    });
    return { id: row.id, name, code };
  });
}
// NOTE (R7 Phase 1, deliberate): there is NO deleteShift. Archive is the removal path — it frees the
// name/code (partial-unique indexes skip archived rows) and preserves DomainEvent + payslip OT references,
// matching the soft-delete precedent everywhere else (leave types, pay components, business units).

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

export function listShifts(ctx: SessionContext, companyId: string, opts?: { includeArchived?: boolean }) {
  return withTenant(ctx, (tx) => {
    const conds = [eq(shift.companyId, companyId)];
    if (!opts?.includeArchived) conds.push(isNull(shift.archivedAt));
    return tx.select().from(shift).where(and(...conds)).orderBy(asc(shift.startTime), asc(shift.name));
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
