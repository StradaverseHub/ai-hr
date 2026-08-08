/**
 * Shift rosters (ADR-0032 Phase C, slice C1). Shift templates per company + per-employee roster
 * assignments — the "expected" schedule the time engine will consume (C2). Each mutation runs inside
 * withTenant and appends a DomainEvent. RLS gates writes (shift → company admin; roster → can_admin_employment).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  attendance,
  employment,
  leaveRequest,
  person,
  rosterAssignment,
  shift,
  shiftOtWindow,
  SHIFT_DAY_TYPES,
  type BreakPeriod,
  type ShiftDayType,
  type ShiftDifferential,
  type ShiftOtRule,
  type ShiftType,
} from '../db/schema';
import { isoWeekday, shiftSpan } from './attendance';
import { approvedLeaveDates } from './leave';
import { listEmployeesPage } from './read';

import { todayInKualaLumpur } from '../lib/hr-date';

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

// ── cf21e554 stage 1 · the General-tab field validators ───────────────────────────────────────────────

/** Trim, and collapse a blank to null. Every new General box is optional and an empty form field must
 *  store NULL ("not configured"), never an empty string that reads as a configured blank. */
const optText = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/** An optional 'HH:MM[:SS]' box. Blank ⇒ null; anything else must parse. */
const optTime = (v: string | null | undefined, label: string): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : asShiftTime(s, label);
};

/** An optional whole-minutes box: non-negative, integral, and no larger than a day. The upper bound is
 *  not decoration — a rounding unit or a full-day figure larger than 24h can only be a typo, and the DB
 *  CHECKs in migration 0417 carry the same bounds so the two cannot drift. */
const optMinutes = (v: number | null | undefined, label: string): number | null => {
  if (v == null) return null;
  const n = Math.trunc(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number of minutes`);
  if (n > 1440) throw new Error(`${label} must not exceed 24 hours`);
  return n;
};

/** RECORDED ONLY in stage 1. Blank ⇒ null; any other value must be one of the product's own day types. */
function validateShiftDayType(v: string | null | undefined): ShiftDayType | null {
  const s = optText(v);
  if (s == null) return null;
  if (!(SHIFT_DAY_TYPES as readonly string[]).includes(s)) throw new Error(`Invalid shift day type: ${s}`);
  return s as ShiftDayType;
}

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
   *  inherit the company-policy grace (core/attendance.ts). UNDEFINED ⇒ leave the stored value unchanged
   *  (7c834696 rev 2: the shift form dropped this input in favour of the rule's grace, so saving a shift
   *  must not clear an override a caller never asked about). */
  lateGraceMinutes?: number | null;
  /** R17 3e8350db — per-shift early-leave grace (minutes): a checkout before shift-end − this is short.
   *  Null ⇒ inherit the legacy shift-midpoint threshold. UNDEFINED ⇒ leave unchanged, as above. */
  earlyLeaveGraceMinutes?: number | null;
  /** R17 3e8350db — the reporter's per-shift "OT Rules". Shapes WORKDAY OT accrual (eligibility / minimum
   *  block / daily cap); statutory multipliers stay company-level. Null ⇒ legacy behaviour. UNDEFINED ⇒
   *  leave the stored value unchanged (88e94371: the shift form dropped this field for the rule dropdown, so
   *  editing a shift no longer wipes a pre-existing per-shift OT-shape override). */
  otRule?: ShiftOtRule | null;
  /** 88e94371 — the chosen attendance-calculation rule ("Lateness, Early Out & Overtime Settings"). Null ⇒
   *  fall back to the tenant's Standard rule at resolve time (6da67ab7 — the library is no longer scoped by
   *  the employee's company). UNDEFINED ⇒ leave unchanged. */
  ruleId?: string | null;
  differential?: ShiftDifferential | null;
  // ── cf21e554 stage 1 · the reference General tab ────────────────────────────────────────────────────
  // ABSENT ⇒ NULL, deliberately NOT the "undefined preserves" contract lateGraceMinutes / otRule / ruleId
  // use. Those three are fields the shift FORM no longer shows, so a save must not erase them. Every box
  // below IS on the form, so absent genuinely means "the operator cleared it" — and a field that cannot be
  // cleared is a field HR has to ask an engineer to fix.
  /** The reference "Description" box. MB28's description is currently squatting in shift.name. */
  description?: string | null;
  /** RECORDED ONLY in stage 1 — no engine consumer, and the form says so on the box. */
  dayType?: ShiftDayType | string | null;
  /** RECORDED ONLY in stage 1 — free-text grouping label. */
  category?: string | null;
  /** Earliest allowed clock-in. Must be at or before startTime. */
  earlyIn?: string | null;
  /** Latest allowed clock-out, plus the reference screen's next-day marker. Must be at or after the shift
   *  end on the SHIFT'S timeline (a cross-midnight shift's end already sits on the next day). */
  lateOut?: string | null;
  lateOutNextDay?: boolean | null;
  /** RECORDED ONLY in stage 1. */
  fullDayLeaveMinutes?: number | null;
  /** APPLIED — rounds the shift's net scheduled minutes DOWN to a multiple of this, inside
   *  core/attendance.ts netScheduledMinutes. Null/0 ⇒ no rounding. */
  normalHoursRoundingMinutes?: number | null;
  /** RECORDED ONLY in stage 1. */
  fullDayOtMinutes?: number | null;
  /** The half-day pair. `halfDayFirstOut` WINS over the company-wide attendance_policy.half_day_before for
   *  this shift; null keeps today's behaviour. `halfDaySecondIn` is recorded + validated against it. */
  halfDayFirstOut?: string | null;
  halfDaySecondIn?: string | null;
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
  // UNDEFINED ⇒ omit from the write (preserve stored value); null ⇒ explicitly clear. Same contract as
  // otRule / ruleId below, for the same reason: the field's editor no longer lives on the shift form.
  lateGraceMinutes: number | null | undefined;
  earlyLeaveGraceMinutes: number | null | undefined;
  // 88e94371 — UNDEFINED ⇒ omit from the write (preserve stored value); null ⇒ explicitly clear.
  otRule: ShiftOtRule | null | undefined;
  ruleId: string | null | undefined;
  differential: ShiftDifferential | null;
  // cf21e554 stage 1 — plain values: absent ⇒ null (see ShiftInput for why these are not "preserve on
  // undefined" like the three above).
  description: string | null;
  dayType: ShiftDayType | null;
  category: string | null;
  earlyIn: string | null;
  lateOut: string | null;
  lateOutNextDay: boolean | null;
  fullDayLeaveMinutes: number | null;
  normalHoursRoundingMinutes: number | null;
  fullDayOtMinutes: number | null;
  halfDayFirstOut: string | null;
  halfDaySecondIn: string | null;
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

  // b7b886e2 — the periods are no longer storage-only: the day derivation deducts the window minutes a
  // clocking actually spanned. The breakMinutes scalar below stays canonical (Σ durations) and is what
  // scheduled/normal hours are built from, so it must keep being written in step with the windows.
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
      // cf21e554 stage 1 — the "Paid?" tick. Written ONLY when true, so an unpaid break stays byte-identical
      // to every row stored before this change (absent means unpaid — see BreakPeriod in db/schema.ts).
      if (bp.paid === true) out.paid = true;
      return out;
    });
    // Canonical scalar = Σ break durations of the UNPAID windows.
    //
    // cf21e554 stage 1 — THIS IS THE SINGLE BEHAVIOUR CHANGE ON STORED DATA IN STAGE 1, and it is a NO-OP
    // today: production carries 2 shifts with break windows and NOT ONE window carries `paid`, so every
    // stored row still sums to exactly what it summed to before. A PAID break is time the employer pays
    // for, so it must not be subtracted from the shift's scheduled hours; an unpaid one comes off exactly
    // as it does today. break_minutes stays the canonical scalar every other consumer reads (scheduled /
    // normal hours, the punch import, the hourly clamp, and the cap on the spanned-break deduction in
    // core/attendance.ts), which is why the paid/unpaid split has to land HERE rather than at each reader.
    breakMinutes = breakPeriods
      .filter((bp) => bp.paid !== true)
      .reduce((acc, bp) => acc + (hhmmToMin(bp.end) - hhmmToMin(bp.start)), 0);
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

  // R17 3e8350db — per-shift grace windows. Explicit null ⇒ clear (inherit the legacy behaviour); when
  // supplied they must be non-negative integers. No upper bound beyond the shift span is enforced (a grace
  // larger than the span simply means "never late" / "always short", which is a valid operational choice).
  // 7c834696 rev 2 — UNDEFINED is now distinct from null and PRESERVES the stored value: the shift form no
  // longer offers these boxes, and a form that cannot show a field must not be able to erase it.
  const grace = (v: number | null | undefined, label: string): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const g = Math.trunc(v);
    if (!Number.isFinite(g) || g < 0) throw new Error(`${label} must be a non-negative number of minutes`);
    return g;
  };
  const lateGraceMinutes = grace(p.lateGraceMinutes, 'Late grace');
  const earlyLeaveGraceMinutes = grace(p.earlyLeaveGraceMinutes, 'Early-leave grace');
  // 88e94371 — otRule is now edited via the attendance-rule library, not this form. UNDEFINED ⇒ preserve the
  // stored value (omit from the write); an explicit value/null still flows through validateOtRule.
  const otRule = p.otRule === undefined ? undefined : validateOtRule(p.otRule);
  // 88e94371 — the shift's chosen rule. UNDEFINED ⇒ preserve; '' / null ⇒ clear (fall back to Standard).
  const ruleId = p.ruleId === undefined ? undefined : p.ruleId === null || p.ruleId === '' ? null : p.ruleId;

  // ── cf21e554 stage 1 · the General tab ──────────────────────────────────────────────────────────────
  const description = optText(p.description);
  const dayType = validateShiftDayType(p.dayType as string | null | undefined);
  const category = optText(p.category);
  const fullDayLeaveMinutes = optMinutes(p.fullDayLeaveMinutes, 'Full-day leave hours');
  const normalHoursRoundingMinutes = optMinutes(p.normalHoursRoundingMinutes, 'Normal-hours rounding');
  const fullDayOtMinutes = optMinutes(p.fullDayOtMinutes, 'Full-day overtime hours');

  // Earliest clock-in must not sit AFTER the shift starts — a shift that opens its doors later than it
  // begins cannot be worked. Compared on the plain time-of-day: an early-in on the PREVIOUS calendar day is
  // not expressible (there is no early_in_prev_day column, by design — the reference screen has no such
  // marker, only the late-out one).
  const earlyIn = optTime(p.earlyIn, 'Earliest clock-in');
  if (earlyIn != null && hhmmToMin(earlyIn) > hhmmToMin(startTime)) {
    throw new Error('Earliest clock-in must be at or before the shift start time');
  }

  // Latest clock-out must not sit BEFORE the shift ends, measured on the SHIFT'S OWN timeline: a
  // cross-midnight shift's end is already on the next day, and the reference screen's next-day marker
  // ("0430+") is what puts a late-out there too. Comparing plain times would refuse every legitimate
  // night-shift late-out and accept every wrong one.
  const lateOut = optTime(p.lateOut, 'Latest clock-out');
  // A next-day flag with no time is meaningless — drop it rather than store a flag nothing qualifies.
  const lateOutNextDay = lateOut == null ? null : p.lateOutNextDay === true;
  if (lateOut != null) {
    const endAbs = hhmmToMin(endTime) + (crossesMidnight ? 1440 : 0);
    const lateAbs = hhmmToMin(lateOut) + (lateOutNextDay ? 1440 : 0);
    if (lateAbs < endAbs) {
      throw new Error('Latest clock-out must be at or after the shift end time (tick “next day” if it falls after midnight)');
    }
  }

  // The half-day pair. Either box may stand alone — the FIRST one is the per-shift replacement for the
  // company-wide attendance_policy.half_day_before and is useful on its own — but when both are set the
  // morning clock-out must precede the afternoon clock-in, or the two halves overlap.
  const halfDayFirstOut = optTime(p.halfDayFirstOut, 'First half-day clock-out');
  const halfDaySecondIn = optTime(p.halfDaySecondIn, 'Second half-day clock-in');
  if (halfDayFirstOut != null && halfDaySecondIn != null && hhmmToMin(halfDayFirstOut) >= hhmmToMin(halfDaySecondIn)) {
    throw new Error('The first half-day clock-out must be before the second half-day clock-in');
  }

  // The auto figure (used when no override): netScheduledMinutes(startTime, endTime, crossesMidnight,
  // breakMinutes, normalHoursRoundingMinutes) — derived on the fly by scheduleFor / the UI readout,
  // deliberately not stored.
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
    ruleId,
    differential,
    description,
    dayType,
    category,
    earlyIn,
    lateOut,
    lateOutNextDay,
    fullDayLeaveMinutes,
    normalHoursRoundingMinutes,
    fullDayOtMinutes,
    halfDayFirstOut,
    halfDaySecondIn,
  };
}

/** cf21e554 stage 1 — the General-tab columns, in one place so createShift, updateShift and copyShift
 *  cannot drift apart (the drift that let 7c834696's grace columns be silently cleared by a save). */
const generalColumns = (n: NormalizedShift) => ({
  description: n.description,
  dayType: n.dayType,
  category: n.category,
  earlyIn: n.earlyIn,
  lateOut: n.lateOut,
  lateOutNextDay: n.lateOutNextDay,
  fullDayLeaveMinutes: n.fullDayLeaveMinutes,
  normalHoursRoundingMinutes: n.normalHoursRoundingMinutes,
  fullDayOtMinutes: n.fullDayOtMinutes,
  halfDayFirstOut: n.halfDayFirstOut,
  halfDaySecondIn: n.halfDaySecondIn,
});

function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

/** cf21e554 — the two friendly messages, extracted so the DB-violation mapper below and the EXPLICIT
 *  pre-checks in copyShift / unarchiveShift all speak with one voice. A user who hits the same clash from
 *  three different buttons must not get three different sentences. */
const shiftCodeTakenMessage = (code: string) => `A shift with code “${code}” already exists.`;
const shiftNameTakenMessage = (name: string) => `A shift named “${name}” already exists.`;

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
    if (/shift_tenant_code_uq/i.test(msg)) return new Error(shiftCodeTakenMessage(n.code));
    if (/shift_tenant_name_uq/i.test(msg)) return new Error(shiftNameTakenMessage(n.name));
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
          // A brand-new row has nothing to preserve, so undefined collapses to null here (unlike updateShift).
          lateGraceMinutes: n.lateGraceMinutes ?? null,
          earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes ?? null,
          otRule: n.otRule ?? null,
          ruleId: n.ruleId ?? null,
          differential: n.differential,
          ...generalColumns(n),
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
        lateGraceMinutes: n.lateGraceMinutes ?? null,
        earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes ?? null,
        otRule: n.otRule ?? null,
        ruleId: n.ruleId ?? null,
        hasDifferential: !!n.differential,
        ...generalColumns(n),
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
          // 88e94371 + 7c834696 rev 2 — omit when undefined so a form that no longer carries these fields
          // preserves the stored value (drizzle skips undefined keys in .set).
          ...(n.lateGraceMinutes === undefined ? {} : { lateGraceMinutes: n.lateGraceMinutes }),
          ...(n.earlyLeaveGraceMinutes === undefined ? {} : { earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes }),
          ...(n.otRule === undefined ? {} : { otRule: n.otRule }),
          ...(n.ruleId === undefined ? {} : { ruleId: n.ruleId }),
          differential: n.differential,
          ...generalColumns(n),
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
        ...(n.lateGraceMinutes === undefined ? {} : { lateGraceMinutes: n.lateGraceMinutes }),
        ...(n.earlyLeaveGraceMinutes === undefined ? {} : { earlyLeaveGraceMinutes: n.earlyLeaveGraceMinutes }),
        ...(n.otRule === undefined ? {} : { otRule: n.otRule }),
        ...(n.ruleId === undefined ? {} : { ruleId: n.ruleId }),
        hasDifferential: !!n.differential,
        ...generalColumns(n),
      },
    });
    return { id: p.shiftId };
  });
}

// R33 f21d6eee — duplicateShift (R17 same-company / copy-to-company duplication) was RETIRED: the shared
// tenant-wide library removes the reason to duplicate a template (expected_function: "No duplication of
// shifts between companies"). A shift is created once and assigned to any employee.

/**
 * cf21e554 stage 1 — COPY SHIFT. The reporter's "HR Administrator can create, edit, COPY, activate,
 * deactivate and delete a shift".
 *
 * READ THE PARAGRAPH ABOVE BEFORE ASSUMING THIS UNDOES R33. It does not. What f21d6eee retired was
 * duplicateShift's CROSS-COMPANY duplication — "the same template copied into nine companies", which the
 * shared tenant-wide library made both unnecessary and harmful (nine rows drifting apart, and the reason
 * eight of them existed disappeared the moment one template became assignable to any employee). This is a
 * different operation with a different purpose: ONE new template in the SAME shared library, seeded from an
 * existing one, because a company with a 08:00–17:00 morning shift usually wants a 20:00–05:00 night shift
 * with the same breaks, working days, rule and premium rather than fourteen boxes retyped. It cannot
 * re-create the R33 problem: there is no company argument and nothing to copy INTO.
 *
 * NAMING. Code gains a numeric suffix and the name gains " (copy)", and BOTH are probed against the
 * tenant's live rows until a free pair is found — so copying twice yields MB28-2 and MB28-3 rather than a
 * dead end at the second click. The partial unique indexes ignore archived rows, so an archived MB28-2 is
 * genuinely free and re-using its code is correct. If nothing is free the friendly shiftUniqueError message
 * comes back, identical to the one the create form gives.
 *
 * The copy lands ACTIVE even when copied from an archived shift (you copy a template to use it), keeps the
 * source's company_id (legacy per-company rows stay where they are), and carries the stage-2 OT windows
 * with it — a copy that silently lost its overtime schedule would be worse than no copy at all.
 *
 * Returns the NEW shift's id; the caller (shift-actions.ts) redirects onto the edit form for it, which is
 * where the operator changes the times that made them copy in the first place.
 */
export async function copyShift(ctx: SessionContext, p: { shiftId: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx.select().from(shift).where(eq(shift.id, p.shiftId)).limit(1);
    if (!src) throw new Error('Shift not found (or not visible)');

    // Every LIVE name/code in the tenant, lower-cased. Archived rows are excluded exactly as the partial
    // unique indexes exclude them, so the probe and the constraint agree on what "taken" means.
    const live = await tx
      .select({ name: shift.name, code: shift.code })
      .from(shift)
      .where(isNull(shift.archivedAt));
    const takenNames = new Set(live.map((r) => r.name.trim().toLowerCase()));
    const takenCodes = new Set(live.map((r) => (r.code ?? '').trim().toLowerCase()));

    const baseCode = (src.code ?? 'SHIFT').trim();
    const baseName = src.name.trim();
    let name = '';
    let code = '';
    let found = false;
    for (let n = 2; n <= 99; n++) {
      const candidateCode = `${baseCode}-${n}`;
      const candidateName = n === 2 ? `${baseName} (copy)` : `${baseName} (copy ${n - 1})`;
      if (takenCodes.has(candidateCode.toLowerCase()) || takenNames.has(candidateName.toLowerCase())) continue;
      code = candidateCode;
      name = candidateName;
      found = true;
      break;
    }
    if (!found) throw new Error(shiftCodeTakenMessage(`${baseCode}-2`));

    let row: { id: string };
    try {
      [row] = await tx
        .insert(shift)
        .values({
          tenantId: ctx.tenantId,
          companyId: src.companyId,
          name,
          code,
          type: src.type,
          startTime: src.startTime,
          endTime: src.endTime,
          breakMinutes: src.breakMinutes,
          breakPeriods: src.breakPeriods,
          normalMinutesOverride: src.normalMinutesOverride,
          weeklyPattern: src.weeklyPattern,
          crossesMidnight: src.crossesMidnight,
          lateGraceMinutes: src.lateGraceMinutes,
          earlyLeaveGraceMinutes: src.earlyLeaveGraceMinutes,
          otRule: src.otRule,
          ruleId: src.ruleId,
          differential: src.differential,
          description: src.description,
          dayType: src.dayType,
          category: src.category,
          earlyIn: src.earlyIn,
          lateOut: src.lateOut,
          lateOutNextDay: src.lateOutNextDay,
          fullDayLeaveMinutes: src.fullDayLeaveMinutes,
          normalHoursRoundingMinutes: src.normalHoursRoundingMinutes,
          fullDayOtMinutes: src.fullDayOtMinutes,
          halfDayFirstOut: src.halfDayFirstOut,
          halfDaySecondIn: src.halfDaySecondIn,
          // archivedAt deliberately omitted ⇒ the copy is ACTIVE even when the source is archived.
        })
        .returning({ id: shift.id });
    } catch (e) {
      throw shiftUniqueError(e, { name, code });
    }

    // cf21e554 stage 2 — the overtime schedule travels with the copy.
    const windows = await tx.select().from(shiftOtWindow).where(eq(shiftOtWindow.shiftId, p.shiftId));
    if (windows.length > 0) {
      await tx.insert(shiftOtWindow).values(
        windows.map((w) => ({
          tenantId: ctx.tenantId,
          shiftId: row.id,
          sortOrder: w.sortOrder,
          label: w.label,
          startTime: w.startTime,
          endTime: w.endTime,
          endNextDay: w.endNextDay,
          minMinutes: w.minMinutes,
          maxMinutes: w.maxMinutes,
          adjustAfterMinutes: w.adjustAfterMinutes,
          adjustDeltaMinutes: w.adjustDeltaMinutes,
        })),
      );
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: row.id,
      eventType: 'shift.copied',
      actor: actorOf(ctx),
      payload: { sourceShiftId: p.shiftId, sourceCode: src.code, sourceName: src.name, name, code, otWindows: windows.length },
    });
    return { id: row.id };
  });
}

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

/**
 * cf21e554 stage 1 — REACTIVATE a deactivated shift (the reporter's "activate, deactivate"). Only
 * archiveShift existed, so switching a shift off was a one-way door in the UI.
 *
 * THE TRAP THIS FUNCTION EXISTS TO CLOSE. shift_tenant_name_uq / shift_tenant_code_uq are PARTIAL indexes —
 * `WHERE archived_at IS NULL` — which is deliberate: archiving a shift FREES its name and code for re-use.
 * So while MB28 sat archived, someone may well have created a new live MB28. Un-archiving is therefore not
 * a field flip; it is a re-entry into a uniqueness namespace the row left. The DB would refuse it (the row
 * re-enters the index on update) but with `duplicate key value violates unique constraint …`, which tells
 * an HR administrator nothing. We check FIRST and refuse with the same sentence the create form uses, and
 * keep the constraint mapping underneath as the backstop that makes the check impossible to outrun.
 *
 * Idempotent: un-archiving a shift that is already active is a no-op, not an error.
 */
export async function unarchiveShift(ctx: SessionContext, p: { shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx
      .select({ id: shift.id, name: shift.name, code: shift.code, archivedAt: shift.archivedAt })
      .from(shift)
      .where(eq(shift.id, p.shiftId))
      .limit(1);
    if (!src) throw new Error('Shift not found (or not visible)');
    if (!src.archivedAt) return { id: p.shiftId };

    // Case-insensitive, exactly like the indexes (lower(name) / lower(code)), and scoped to LIVE rows only.
    const live = await tx
      .select({ id: shift.id, name: shift.name, code: shift.code })
      .from(shift)
      .where(isNull(shift.archivedAt));
    const name = src.name.trim().toLowerCase();
    const code = (src.code ?? '').trim().toLowerCase();
    if (live.some((r) => r.name.trim().toLowerCase() === name)) throw new Error(shiftNameTakenMessage(src.name));
    if (code !== '' && live.some((r) => (r.code ?? '').trim().toLowerCase() === code)) {
      throw new Error(shiftCodeTakenMessage(src.code!));
    }

    try {
      await tx.update(shift).set({ archivedAt: null, updatedAt: new Date() }).where(eq(shift.id, p.shiftId));
    } catch (e) {
      throw shiftUniqueError(e, { name: src.name, code: src.code ?? '' });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.unarchived',
      actor: actorOf(ctx),
      payload: { shiftId: p.shiftId, name: src.name, code: src.code },
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

// ── cf21e554 STAGE 2 · the shift's own Overtime Schedule ────────────────────────────────────────────

/** One row of the Overtime Schedule tab, as the form posts it. */
export type ShiftOtWindowInput = {
  label?: string | null;
  startTime: string;
  endTime: string;
  endNextDay?: boolean | null;
  minMinutes?: number | null;
  maxMinutes?: number | null;
  adjustAfterMinutes?: number | null;
  adjustDeltaMinutes?: number | null;
};

/** Every overtime window of one shift, in grid order. Read by the settings screen AND (through the engine's
 *  own query) by attendance derivation — one ordering, so what HR sees is what the engine applied. */
export function listShiftOtWindows(ctx: SessionContext, shiftId: string) {
  return withTenant(ctx, (tx) =>
    tx.select().from(shiftOtWindow).where(eq(shiftOtWindow.shiftId, shiftId)).orderBy(asc(shiftOtWindow.sortOrder)),
  );
}

/**
 * Replace a shift's whole overtime grid in one write — the same shape as the break rows on the General tab,
 * and for the same reason: the tab is edited as a grid, so a partial update path would need per-row identity
 * the UI does not have. Delete-then-insert inside one transaction; an empty array clears the grid, which is
 * how a shift goes back to plain past-the-shift-end overtime.
 */
export async function replaceShiftOtWindows(
  ctx: SessionContext,
  p: { shiftId: string; windows: ShiftOtWindowInput[] },
): Promise<{ id: string; windows: number }> {
  return withTenant(ctx, async (tx) => {
    const [sh] = await tx
      .select({ id: shift.id, startTime: shift.startTime })
      .from(shift)
      .where(eq(shift.id, p.shiftId))
      .limit(1);
    if (!sh) throw new Error('Shift not found (or not visible)');

    const rows = p.windows.map((w, i) => {
      const startTime = asShiftTime(w.startTime, 'Overtime window start');
      const endTime = asShiftTime(w.endTime, 'Overtime window end');
      const endNextDay = w.endNextDay === true;
      const length = hhmmToMin(endTime) + (endNextDay ? 1440 : 0) - hhmmToMin(startTime);
      if (length <= 0) {
        throw new Error('An overtime window must start before it ends (tick “next day” if it ends after midnight)');
      }
      if (length > 1440) throw new Error('An overtime window must not be longer than 24 hours');
      const minMinutes = optMinutes(w.minMinutes, 'Overtime window minimum');
      const maxMinutes = optMinutes(w.maxMinutes, 'Overtime window maximum');
      if (minMinutes != null && maxMinutes != null && minMinutes > maxMinutes) {
        throw new Error('An overtime window’s minimum must not exceed its maximum');
      }
      const adjustAfterMinutes = optMinutes(w.adjustAfterMinutes, 'Overtime adjustment threshold');
      // The DELTA is the one signed figure in the shift model: the reporter's own row deducts 30 minutes.
      let adjustDeltaMinutes: number | null = null;
      if (w.adjustDeltaMinutes != null) {
        const d = Math.trunc(w.adjustDeltaMinutes);
        if (!Number.isFinite(d)) throw new Error('Overtime adjustment must be a whole number of minutes');
        if (Math.abs(d) > 1440) throw new Error('Overtime adjustment must not exceed 24 hours');
        adjustDeltaMinutes = d;
      }
      // Both or neither — mirrors the DB CHECK. A threshold with no delta is a rule the engine would have
      // to guess at, and a delta with no threshold is one that would apply to every minute.
      if ((adjustAfterMinutes == null) !== (adjustDeltaMinutes == null)) {
        throw new Error('An overtime adjustment needs both a threshold and an amount');
      }
      return {
        tenantId: ctx.tenantId,
        shiftId: p.shiftId,
        sortOrder: i,
        label: optText(w.label),
        startTime,
        endTime,
        endNextDay,
        minMinutes,
        maxMinutes,
        adjustAfterMinutes,
        adjustDeltaMinutes,
      };
    });

    // OVERLAPPING WINDOWS WOULD DOUBLE-COUNT. The engine credits each window independently and sums them
    // (core/shift-ot-window.ts), so two windows sharing an hour would pay that hour twice — silently, with
    // no figure anywhere reading wrong. Refuse it at the only place it can be refused: the write. The check
    // runs on the SHIFT'S OWN timeline, anchored exactly as the engine anchors, so "22:00–02:00 next day"
    // and "01:00–03:00" are correctly seen as overlapping on a night shift.
    const startAbs = hhmmToMin(sh.startTime);
    const anchored = rows
      .map((r) => {
        const s = hhmmToMin(r.startTime) < startAbs - 720 ? hhmmToMin(r.startTime) + 1440 : hhmmToMin(r.startTime);
        return { s, e: s + (hhmmToMin(r.endTime) + (r.endNextDay ? 1440 : 0) - hhmmToMin(r.startTime)) };
      })
      .sort((a, b) => a.s - b.s);
    for (let i = 1; i < anchored.length; i++) {
      if (anchored[i].s < anchored[i - 1].e) throw new Error('Overtime windows must not overlap each other');
    }

    await tx.delete(shiftOtWindow).where(eq(shiftOtWindow.shiftId, p.shiftId));
    if (rows.length > 0) await tx.insert(shiftOtWindow).values(rows);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.ot-windows.replaced',
      actor: actorOf(ctx),
      payload: {
        shiftId: p.shiftId,
        windows: rows.map((r) => ({
          sortOrder: r.sortOrder,
          label: r.label,
          startTime: r.startTime,
          endTime: r.endTime,
          endNextDay: r.endNextDay,
          minMinutes: r.minMinutes,
          maxMinutes: r.maxMinutes,
          adjustAfterMinutes: r.adjustAfterMinutes,
          adjustDeltaMinutes: r.adjustDeltaMinutes,
        })),
      },
    });
    return { id: p.shiftId, windows: rows.length };
  });
}

// ── Per-employee default shift (ec4cbf63 rev-6: "assigned to the staff in their profile") ──────────

// R33 f21d6eee — ShiftCompanyMismatchError was REMOVED. Shifts are a tenant-wide shared library, so a
// template may be assigned to ANY employee in the tenant regardless of which company (if any) authored it.
// The same-company guard is gone; ArchivedShiftError + BackupShiftRequiredError still apply.

/**
 * b8aa3466 — refuses a backup shift that declares no working weekday. See assignEmployeeShift for why an
 * empty weekly pattern is not merely useless but actively wrong once the backup shift is mandatory.
 */
export class ShiftHasNoWorkingPatternError extends Error {
  constructor() {
    super('That shift has no working days set, so it cannot be used as a backup shift. Set its weekly pattern first.');
    this.name = 'ShiftHasNoWorkingPatternError';
  }
}

export class ArchivedShiftError extends Error {
  constructor(message = 'An archived shift cannot be assigned as a default shift') {
    super(message);
    this.name = 'ArchivedShiftError';
  }
}

/**
 * b8aa3466 — every employment must carry a BACKUP SHIFT (the profile's `default_shift_id`), whichever
 * arrangement they are on. Replaces R17's FixedShiftRequiresShiftError, which only demanded one for the
 * Fixed arrangement and so left "Roster" as a way to decline — the decline path this item removes.
 */
export class BackupShiftRequiredError extends Error {
  constructor(message = 'A backup shift is required — it is the shift used on any day the employee is not rostered') {
    super(message);
    this.name = 'BackupShiftRequiredError';
  }
}

export type EmployeeShiftType = 'fixed' | 'roster';

/**
 * R17 3e8350db — set an employee's shift ARRANGEMENT (the reporter's "Shift Type") plus their BACKUP SHIFT.
 * This is the single write path that keeps `shift_type` and `default_shift_id` consistent.
 *
 * b8aa3466 CHANGED THE INVARIANT. R17 read: Fixed ⇒ a default shift is required, Roster ⇒ default_shift_id
 * is FORCED to null. That second half is why 30 of the reporter's 31 employments had no shift: "Roster" was
 * a way to decline the field, and a declined field means scheduleFor falls all the way through to the flat
 * company policy on every unrostered day. The rule is now:
 *   • Fixed  ⇒ the person follows their backup shift every working day; the roster is for exceptions.
 *   • Roster ⇒ the person is normally scheduled from /roster, and the backup shift covers any day that has
 *     no roster row.
 * Both REQUIRE a shift. `shift_type` survives as a statement of intent (nothing in the engine branches on
 * it — grep it: the profile UI and this invariant are its only readers); `default_shift_id` remains the
 * engine's single source of truth, resolved roster row → backup shift → company policy, unchanged.
 *
 * Nothing here touches attendance ALREADY RECORDED: the engine stamps its figures onto the attendance row
 * at write time and never re-derives history, so changing a backup shift moves how future days calculate
 * and no more.
 */
export async function assignEmployeeShift(
  ctx: SessionContext,
  p: { employmentId: string; shiftType: EmployeeShiftType; shiftId: string | null },
): Promise<{ id: string }> {
  const shiftId = p.shiftId || null;
  if (!shiftId) throw new BackupShiftRequiredError();
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
    const [sh] = await tx
      .select({ id: shift.id, archivedAt: shift.archivedAt, pattern: shift.weeklyPattern })
      .from(shift)
      .where(eq(shift.id, shiftId))
      .limit(1);
    if (!sh) throw new Error('Shift not found');
    // R33 f21d6eee — no same-company check: a shared-library shift is assignable to any tenant employee.
    if (sh.archivedAt) throw new ArchivedShiftError();
    // b8aa3466 — A BACKUP SHIFT WITH NO WEEKLY WORKING PATTERN MAKES EVERY DAY A REST DAY.
    //
    // Found in verification, and it is the trap this item's own change opens. Making the backup shift
    // MANDATORY means it is now the fallback for every employee on every date that no roster covers, and
    // core/attendance.ts resolves that branch as `ds.pattern?.includes(isoWeekday(date))`. A shift whose
    // weekly_pattern is NULL or empty therefore matches NOTHING, falls through to policyBranch('rest_day'),
    // and the employee silently books every working day as a rest day — which pays rest-day overtime rates
    // on ordinary work and shows nobody an error. Before this item that shift was merely one option among
    // several; now it is the floor, so the floor has to be walkable.
    if (!Array.isArray(sh.pattern) || sh.pattern.length === 0) throw new ShiftHasNoWorkingPatternError();
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
 *  arrangement. b8aa3466 — CLEARING is no longer a thing: `shiftId: null` now raises
 *  BackupShiftRequiredError instead of quietly dropping the employee onto the flat company policy. */
export async function assignDefaultShift(
  ctx: SessionContext,
  p: { employmentId: string; shiftId: string | null },
): Promise<{ id: string }> {
  return assignEmployeeShift(ctx, {
    employmentId: p.employmentId,
    shiftType: 'fixed',
    shiftId: p.shiftId,
  });
}

// ── Backup-shift coverage (b8aa3466) ───────────────────────────────────────────────────────────────

export type UncoveredEmployment = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  companyId: string;
};

/**
 * b8aa3466 — every ACTIVE employment that has no backup shift, i.e. every person for whom an unrostered
 * day still falls through to the flat company work schedule. This is the coverage gate the Attendance
 * Policy screen reads and the backfill script prints BEFORE and AFTER: "how many employees would notice
 * if the company schedule went away" is the only honest way to ask whether it can.
 *
 * Active = not terminated (there is no stored status column — see core/employment-status.ts; a terminated
 * employment is not scheduled, so it cannot be uncovered). Ordered by employee code so two runs of the
 * script produce diffable output.
 */
export function employmentsWithoutBackupShift(
  ctx: SessionContext,
  p?: { companyIds?: string[] },
): Promise<UncoveredEmployment[]> {
  // b8aa3466 — `companyIds` exists because the screen that renders this is COMPANY-SCOPED and this read was
  // not. Every other list on Attendance Policy is filtered through getScopeIds, so an admin who can see one
  // of nine companies was being told "12 employees have no backup shift" and shown names from companies
  // they cannot open, with a Fix button that would not reach them. Omitted ⇒ tenant-wide, which is what the
  // backfill script wants (it names its own tenant) and what the coverage gate wants before a global claim.
  const scope = p?.companyIds;
  if (scope && scope.length === 0) return Promise.resolve([]);
  return withTenant(ctx, async (tx) =>
    tx
      .select({
        employmentId: employment.id,
        employeeCode: employment.employeeCode,
        name: person.fullName,
        companyId: employment.companyId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          isNull(employment.defaultShiftId),
          ...(scope ? [inArray(employment.companyId, scope)] : []),
        ),
      )
      .orderBy(asc(employment.employeeCode), asc(person.fullName)),
  );
}

export type BackfillBackupShiftResult = {
  /** The uncovered employments as they were BEFORE the run — the reversal record. */
  before: UncoveredEmployment[];
  /** Still uncovered AFTER the run. Empty on a successful apply; identical to `before` on a dry run. */
  after: UncoveredEmployment[];
  /** The shift every `before` row was pointed at (null on a dry run — nothing was written). */
  assignedShiftId: string | null;
  applied: boolean;
};

/**
 * b8aa3466 — point every ACTIVE employment with no backup shift at one named shift (the reporter asked for
 * AM03: 09:00–18:00, 60-minute break).
 *
 * Deliberately NOT a migration. A migration is invisible and irreversible-by-inspection; this is a data
 * decision that changes how every future day calculates for the people it touches, so it runs as an
 * explicit admin action that reports the exact list BEFORE and AFTER, writes through assignEmployeeShift
 * (so each row gets its own audited employment.shift-arrangement.assigned event carrying before → after,
 * which IS the reversal instruction), and does nothing at all unless `apply` is passed.
 *
 * Attendance already recorded is untouched — the engine froze those rows' figures when they were written.
 *
 * `shiftCode` is resolved case-insensitively and MUST match exactly one non-archived shift: shift codes are
 * not unique in this tenant (two rows both coded AM1, plus AM1-copy / Test / Test-2 on production), so a
 * code that resolves to two shifts is an error, never a coin-flip.
 */
export async function backfillBackupShift(
  ctx: SessionContext,
  p: { shiftCode: string; apply: boolean },
): Promise<BackfillBackupShiftResult> {
  const before = await employmentsWithoutBackupShift(ctx);
  const wanted = p.shiftCode.trim().toLowerCase();
  const matches = (await listShiftsForTenant(ctx)).filter((sh) => (sh.code ?? '').trim().toLowerCase() === wanted);
  if (matches.length === 0) throw new Error(`No active shift with code "${p.shiftCode}"`);
  if (matches.length > 1) {
    throw new Error(
      `Shift code "${p.shiftCode}" matches ${matches.length} shifts (${matches
        .map((sh) => `${sh.name} ${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)}`)
        .join(', ')}) — codes are not unique in this tenant, so pick one and re-run.`,
    );
  }
  if (!p.apply) return { before, after: before, assignedShiftId: null, applied: false };
  const target = matches[0];
  for (const row of before) {
    // The arrangement is stamped FIXED, not left alone, and that is deliberate. Migration 0162 defaulted
    // shift_type to 'roster' for everyone who had no default shift — which is precisely this population —
    // so preserving it would leave 30 profiles reading "Roster shift" for people nobody rosters. Fixed is
    // the truthful label for "works this shift every working day, roster the exceptions", and it is one
    // click to change per employee afterwards. Nothing in the engine branches on shift_type either way.
    // One call per row on purpose — each needs its own DomainEvent to be individually reversible.
    await assignEmployeeShift(ctx, { employmentId: row.employmentId, shiftType: 'fixed', shiftId: target.id });
  }
  return { before, after: await employmentsWithoutBackupShift(ctx), assignedShiftId: target.id, applied: true };
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
    const today = p.today ?? todayInKualaLumpur();
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
