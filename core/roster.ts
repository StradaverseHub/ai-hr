/**
 * Shift rosters (ADR-0032 Phase C, slice C1). Shift templates per company + per-employee roster
 * assignments — the "expected" schedule the time engine will consume (C2). Each mutation runs inside
 * withTenant and appends a DomainEvent. RLS gates writes (shift → company admin; roster → can_admin_employment).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  attendance,
  attendanceRule,
  employment,
  employmentShiftArrangement,
  leaveRequest,
  person,
  reportingLine,
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
import {
  isWorkingDayKind,
  netScheduledMinutes,
  shiftDayKindFor,
  shiftSpan,
  weekLookupTx,
  weekPatternWorkingDayCount,
} from './attendance';
import { approvedLeaveDates } from './leave';
import { listEmployees, listEmployeesPage, myEmployment } from './read';
import { isAdmin } from '../lib/authz';
import {
  ROSTER_MAX_RANGE_DAYS,
  cellKey,
  datesBetween,
  daysInWindow,
  isIsoDate,
  monthRange,
  cellIsWorking,
  resolveRosterCell,
  shiftCodeOf,
  type AssignedCell,
  type ResolvedCell,
  type UsualShift,
} from '../lib/roster-month';
import { isShiftColorToken, type ShiftColorToken } from '../lib/shift-visual';
// f513ec02 — the dated shift ladder, for the reverse check's "which shift is this person on TODAY".
// core/shift-arrangement-resolve.ts is a declared LEAF (its only value import is db/schema), which is
// exactly why the resolver lives there and not in core/shift-arrangement.ts: that module imports THIS
// one, so importing it back would close a cycle. See its header.
import { arrangementsForEmploymentTx, pickArrangementOn } from './shift-arrangement-resolve';

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

/** b8aa3466 — how many WORKING weekdays a shift has, Full ∪ Half. Used by the "a backup shift with no
 *  working pattern makes every day a rest day" guards, which must not reject an all-half-days shift.
 *
 *  07ebd04d — the arithmetic moved to core/attendance.ts `weekPatternWorkingDayCount`, beside
 *  `shiftDayKindFor`, because core/shift-arrangement.ts carried a SECOND hand-written copy of this exact
 *  set union guarding the same invariant. Two copies of one rule is how the two guards drift. This alias
 *  stays only so the call sites below keep reading in the shift's own vocabulary. */
const workingDayCount = weekPatternWorkingDayCount;

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

/**
 * 6340aecb — the shift's DISPLAY-ONLY colour. Blank ⇒ null (no colour), otherwise one of the closed
 * palette. Validated against the same token list the DB CHECK in migration 0457 carries and the same one
 * the swatches render from, so the screen, the service and the database cannot disagree about what a
 * colour is — the shape lib/leave-visual.ts + migration 0179 already established for leave_type.color.
 */
function validateShiftColor(v: string | null | undefined): ShiftColorToken | null {
  const s = optText(v);
  if (s == null) return null;
  if (!isShiftColorToken(s)) throw new Error(`Invalid shift colour: ${s}`);
  return s;
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
   *  attendance_policy.working_days. Null/empty ⇒ no pattern; the shift cannot drive roster generation.
   *  b8aa3466 — this is the FULL-day list of the four-way row; see halfPattern / offPattern. */
  weeklyPattern?: number[] | null;
  /** b8aa3466 — the other two day kinds (migration 0429). HALF = a working day with half the normal hours.
   *  OFF = a non-working day that is NOT the statutory rest day. A weekday in none of the three arrays is
   *  a Rest day, which is exactly what "not in weekly_pattern" means today. Absent/empty ⇒ '{}', i.e. the
   *  pre-0429 two-way meaning, byte-identical. Validated pairwise-disjoint here AND by a DB CHECK. */
  halfPattern?: number[] | null;
  offPattern?: number[] | null;
  /** b8aa3466 — the DAILY CUT-OFF (migration 0429). When enabled, core/attendance.ts anchorToShift uses this
   *  clock time as the attendance-day boundary instead of its hard-coded 12-hour rule. Absent ⇒ off, which
   *  is byte-identical to today. Enabling without a time is refused (and by a DB CHECK too). */
  dailyCutoffEnabled?: boolean | null;
  dailyCutoffTime?: string | null;
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
  // ── 6340aecb · Shift Settings redesign (migration 0457) ──────────────────────────────────────────────
  /** DISPLAY-ONLY colour token (lib/shift-visual.ts SHIFT_COLOR_TOKENS). Blank/absent ⇒ null ⇒ the Duty
   *  Roster keeps its rotating position-keyed palette for this shift, i.e. today's exact appearance. */
  color?: string | null;
  /** The FLEXIBLE BREAK. On ⇒ `flexibleBreakMinutes` is an ALLOWANCE the employee may take whenever they
   *  like, so the engine deducts it outright instead of the punch's overlap with the break windows, and it
   *  becomes the shift's canonical breakMinutes on save. Absent/false ⇒ byte-identical to today. */
  flexibleBreakEnabled?: boolean | null;
  flexibleBreakMinutes?: number | null;
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
  halfPattern: number[];
  offPattern: number[];
  dailyCutoffEnabled: boolean;
  dailyCutoffTime: string | null;
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
  // 6340aecb — absent ⇒ null / false, exactly like the General columns above.
  color: ShiftColorToken | null;
  flexibleBreakEnabled: boolean;
  flexibleBreakMinutes: number | null;
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
  // 6340aecb — read BEFORE the windows are normalised, because the shift-level switch decides what a
  // window's own `flexible` flag is allowed to say (see the loop below). The validation of the ALLOWANCE
  // still happens after the windows, where `span` and the window sum are both known.
  const flexibleBreakEnabled = p.flexibleBreakEnabled === true;
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
      //
      // 6340aecb — THE SHIFT-LEVEL FLEXIBLE BREAK OVERRIDES IT TOO, for the same reason and by the same
      // rule. The two flags are about the same thing at two scales: `flexible` on a window says that
      // window is a target rather than a clock to be kept, and the shift-level switch says the whole
      // shift's break is an allowance the engine never tests any window against. A stored
      // `flexible: false` beside `flexible_break_enabled = true` would be the record asserting both at
      // once — a window the operator is told is FIXED that nothing will ever check. Only the shift-level
      // switch has a reader (core/attendance.ts: `spannedBreak = flexibleBreak ?? spannedBreakMinutes(…)`
      // — the allowance REPLACES the whole window computation, and spannedBreakMinutes never consults
      // `bp.flexible` at all), so it is the one that wins, and the window flag is made to agree with it
      // instead of being left to contradict it.
      //
      // With the switch OFF — every row stored before migration 0457, and every shift that never turns it
      // on — this is `bp.flexible` unchanged, so nothing about an existing shift moves.
      const flexible = semiFlexi || flexibleBreakEnabled ? true : bp.flexible;
      const clockingRequired = semiFlexi ? false : bp.clockingRequired;
      if (flexible != null) out.flexible = flexible;
      if (clockingRequired != null) out.clockingRequired = clockingRequired;
      // cf21e554 stage 1 — the "Paid?" tick. Written ONLY when true, so an unpaid break stays byte-identical
      // to every row stored before this change (absent means unpaid — see BreakPeriod in db/schema.ts).
      if (bp.paid === true) out.paid = true;
      // ── r277 (439565ff) · THIS ROW'S OWN ALLOWANCE ──────────────────────────────────────────────
      // ABSENT is the overwhelming majority and absent writes nothing: the row keeps the { start, end }
      // (+flags) shape it has today and the engine keeps deducting the clocking's overlap with it. The
      // three refusals below are the three ways the number could be stored next to something that
      // contradicts it, and each is refused rather than silently dropped BECAUSE THIS IS MONEY: an
      // operator who typed thirty minutes and got a shift that deducts sixty would find out on a payslip.
      if (bp.flexibleMinutes != null) {
        if (flexibleBreakEnabled) {
          throw new Error(
            'This shift already has one flexible break allowance for the whole shift. Switch that off to give each break its own duration.',
          );
        }
        if (flexible !== true) {
          throw new Error('Only a Flexible break can have its own duration — a Fixed break is defined by its start and end times.');
        }
        if (bp.paid === true) {
          throw new Error('A paid break is not deducted from worked hours, so it cannot carry an allowed duration.');
        }
        const mins = Math.trunc(Number(bp.flexibleMinutes));
        if (!Number.isFinite(mins) || mins <= 0) {
          throw new Error('A flexible break needs an allowed duration in minutes — set one, or set the break to Fixed');
        }
        // Validated against ITS OWN window, the way the shift-level allowance is validated against the
        // shift span. NOT the shift-level rule's strict `>=`: that one refuses a break as long as the
        // whole shift (which would leave no work in the day), whereas an allowance equal to its own
        // window is the ordinary case — a 12:00–13:00 lunch with a sixty-minute allowance.
        if (mins > hhmmToMin(end) - hhmmToMin(start)) {
          throw new Error('A break’s allowed duration cannot be longer than the break window itself');
        }
        out.flexibleMinutes = mins;
      }
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
    //
    // r277 — A ROW WITH ITS OWN ALLOWANCE CONTRIBUTES THAT ALLOWANCE, not its window length. This is the
    // same rule 6340aecb applied at shift scale, and it is here for the same reason: break_minutes is what
    // scheduled/normal hours, the punch import and the payroll hourly clamp all read as "this shift's
    // break", so it has to equal what core/attendance.ts will actually take off a full day. Leaving it as
    // Σ window lengths while the engine deducted Σ allowances would give one shift two different break
    // figures depending on which screen you asked. With no row carrying an allowance — every shift that
    // exists today — `?? the window length` makes this the identical expression it has always been.
    breakMinutes = breakPeriods
      .filter((bp) => bp.paid !== true)
      .reduce((acc, bp) => acc + (bp.flexibleMinutes ?? hhmmToMin(bp.end) - hhmmToMin(bp.start)), 0);
  }

  // ── 6340aecb · THE FLEXIBLE BREAK (migration 0457) ──────────────────────────────────────────────────
  // A flexible break is an ALLOWANCE, not a clock window: "you may take up to 45 minutes, whenever you
  // like". Two consequences, and both are decided HERE rather than at each reader:
  //
  //   1. The allowance BECOMES the shift's canonical break_minutes. break_minutes is what every other
  //      consumer already reads as "this shift's break" — scheduled/normal hours (netScheduledMinutes), the
  //      punch import, the hourly clamp, and the cap on the spanned-break deduction. Leaving them reading a
  //      window sum while the engine deducted an allowance would give the same shift two different break
  //      figures depending on which screen you asked, which is exactly the drift cf21e554's paid-break
  //      change moved into this function to avoid.
  //   2. The break WINDOWS are still stored and still editable. That is the reporter's point 12 — the
  //      allowance applies EVEN WHEN a Break Start / Break End is configured — so a shift keeps its
  //      12:00–13:00 on the screen as the intended time while the engine stops requiring the clocking to
  //      have covered it.
  //
  // OFF (absent, and every row stored before 0457) changes nothing at all: break_minutes keeps the value
  // computed above and the engine keeps the deduction it applies today.
  let flexibleBreakMinutes = optMinutes(p.flexibleBreakMinutes, 'Flexible break');
  if (flexibleBreakEnabled) {
    // Refused rather than stored: a flexible break with no allowance is a switch the engine cannot honour
    // (and the DB CHECK in 0457 says the same thing — this is the sentence HR sees).
    if (flexibleBreakMinutes == null || flexibleBreakMinutes <= 0) {
      throw new Error('A flexible break needs an allowed duration in minutes — set one, or switch Flexible off');
    }
    if (flexibleBreakMinutes >= span) {
      throw new Error('The flexible break allowance must be shorter than the shift span');
    }
    breakMinutes = flexibleBreakMinutes;
  } else {
    // A stored allowance with the switch off would be a number nothing reads; drop it so "off" has exactly
    // one representation, the same rule lateOutNextDay follows for its own orphaned flag.
    flexibleBreakMinutes = null;
  }

  let normalMinutesOverride: number | null = null;
  /**
   * r274 (439565ff) — A FULL FLEXI SHIFT WITHOUT REQUIRED HOURS IS A TRAP, AND THE SERVICE REFUSES IT.
   *
   * On this type the start and end times are only the earliest and latest clocking accepted, so the span
   * between them is not a working day. Without an override the engine would fall back to that span:
   * SemiFlex01 on production is 07:00-20:00 with no override, which reads as a twelve-hour normal day and
   * accrues no overtime until the twelfth hour. The form marks the field required; this is the rule behind
   * it, so the same trap cannot be created through the service or an import.
   */
  if (type === 'full_flexi' && (p.normalMinutesOverride == null || Math.trunc(p.normalMinutesOverride) <= 0)) {
    throw new Error('A Full Flexi shift needs its total normal working hours: they are what decides whether the day is complete.');
  }
  if (p.normalMinutesOverride != null) {
    const o = Math.trunc(p.normalMinutesOverride);
    if (!Number.isFinite(o) || o < 0 || o > span) throw new Error('Normal-hours override must be between 0 and the shift span');
    normalMinutesOverride = o;
  }

  // R7 Phase 2 — weekly pattern: validated ISO weekdays, deduped + sorted. Empty ⇒ null (a shift with zero
  // working days is "no pattern", not a 7-day rest week).
  //
  // b8aa3466 — the row is now FOUR-way (Full / Half / Rest / Off) and this is the FULL list. Half and Off
  // get an array each; Rest stays the complement, so a shift saved before 0429 — and a caller that never
  // heard of the new arrays — reads back exactly as it does today. The three lists must be pairwise
  // disjoint: a Monday cannot be both Full and Off. The DB enforces it too (0429
  // shift_day_kinds_disjoint); this check exists so HR gets a sentence instead of a Postgres error.
  const isoDays = (v: number[] | null | undefined, label: string): number[] => {
    if (!v || v.length === 0) return [];
    const days = [...new Set(v.map((d) => Math.trunc(d)))].sort((a, b) => a - b);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error(`${label} must be ISO weekday numbers 1 (Mon) \u2026 7 (Sun)`);
    }
    return days;
  };
  const fullDays = isoDays(p.weeklyPattern, 'Weekly pattern days');
  const halfPattern = isoDays(p.halfPattern, 'Half-day weekdays');
  const offPattern = isoDays(p.offPattern, 'Off-day weekdays');
  for (const [a, b] of [
    [fullDays, halfPattern],
    [fullDays, offPattern],
    [halfPattern, offPattern],
  ] as const) {
    if (a.some((d) => b.includes(d))) throw new Error('Each weekday can only be one of Full, Half, Rest or Off');
  }
  // Empty ⇒ null, preserving "no pattern" — a shift with zero FULL days is not a 7-day rest week.
  const weeklyPattern: number[] | null = fullDays.length > 0 ? fullDays : null;

  // b8aa3466 — the daily cut-off. Enabled with no time is refused rather than stored: the reader could not
  // honour it, and a pair that can hold nonsense eventually does. (0429 shift_daily_cutoff_time_required
  // says the same thing at the DB; this is the sentence HR sees.)
  const dailyCutoffTime = optTime(p.dailyCutoffTime, 'Daily cut-off');
  const dailyCutoffEnabled = p.dailyCutoffEnabled === true;
  if (dailyCutoffEnabled && dailyCutoffTime == null) {
    throw new Error('A daily cut-off needs a time \u2014 set one, or switch the cut-off off');
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
  // 6340aecb — the DISPLAY-ONLY colour (see validateShiftColor). Blank ⇒ null ⇒ the Duty Roster keeps its
  // rotating position-keyed palette for this shift, i.e. today's exact appearance.
  const color = validateShiftColor(p.color);

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
    halfPattern,
    offPattern,
    dailyCutoffEnabled,
    dailyCutoffTime,
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
    color,
    flexibleBreakEnabled,
    flexibleBreakMinutes,
  };
}

/** cf21e554 stage 1 — the General-tab columns, in one place so createShift, updateShift and copyShift
 *  cannot drift apart (the drift that let 7c834696's grace columns be silently cleared by a save). */
const generalColumns = (n: NormalizedShift) => ({
  // b8aa3466 — the 0429 columns ride here so createShift, updateShift and copyShift cannot drift apart.
  halfPattern: n.halfPattern,
  offPattern: n.offPattern,
  dailyCutoffEnabled: n.dailyCutoffEnabled,
  dailyCutoffTime: n.dailyCutoffTime,
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
  // 6340aecb — the colour and the flexible-break pair ride here for the same reason every column above
  // does: createShift, updateShift and copyShift cannot drift apart.
  color: n.color,
  flexibleBreakEnabled: n.flexibleBreakEnabled,
  flexibleBreakMinutes: n.flexibleBreakMinutes,
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
          // b8aa3466 — the four-way day kinds and the daily cut-off travel with the copy, like every other
          // column here. A copy that quietly dropped them would turn Half/Off days back into Rest days.
          halfPattern: src.halfPattern,
          offPattern: src.offPattern,
          dailyCutoffEnabled: src.dailyCutoffEnabled,
          dailyCutoffTime: src.dailyCutoffTime,
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
          // 6340aecb — a copy that silently dropped the colour would land uncoloured on the roster, and one
          // that dropped the flexible break would quietly compute a different day than the shift it copied.
          color: src.color,
          flexibleBreakEnabled: src.flexibleBreakEnabled,
          flexibleBreakMinutes: src.flexibleBreakMinutes,
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
  constructor(message = 'This shift is referenced by roster entries, assigned as an employee default, or recorded in employee shift history — archive it instead of deleting.') {
    super(message);
    this.name = 'ShiftInUseError';
  }
}

/**
 * R17 3e8350db — HARD delete a shift template (the reporter's "Delete", distinct from "Archive"). Archive is
 * the soft path that preserves history and frees the name/code; Delete is for a template created in error /
 * never used. To keep attendance + payroll history intact we REFUSE to hard-delete a shift that is still
 * referenced — any roster_assignment (past or future), any employee's default_shift_id, or any dated period
 * on the shift-arrangement ladder — and steer HR to Archive instead (ShiftInUseError). Only a
 * genuinely-unreferenced row is removed. RLS (migration 0075: is_admin_for(company_id)) gates who may delete
 * which company's shifts; the GRANT includes DELETE.
 *
 * 18504ca6 — WHY THE THIRD CHECK EXISTS, AND WHY IT DOES NOT FILTER superseded_at. Migration 0421's
 * employment_shift_arrangement.shift_id REFERENCES shift(id) with no ON DELETE, i.e. a hard RESTRICT. Once HR
 * moves someone OFF a shift with an effective date, employment.default_shift_id names the NEW shift and there
 * may be no roster row, so the OLD shift looks unreferenced to the two checks above — but the closed ladder
 * period still holds the FK, and the delete would fail in Postgres with a raw `Failed query: delete from
 * "shift" …` banner on the HR screen. A SUPERSEDED row holds the FK just as hard as a live one, so this check
 * deliberately looks at EVERY row: the answer HR needs is "archive it", not a database error. The practical
 * consequence, and it is the correct one: once anybody has ever been moved off a shift, that shift can only
 * be Archived. db/schema.ts's employment.default_shift_id note ("deleting a shift never errors an FK") is
 * about the SET NULL on that column and still holds; this guard is what keeps the same promise for the ladder.
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
    // 18504ca6 — recorded on ANY dated shift-arrangement period, live OR superseded. A superseded row still
    // holds employment_shift_arrangement.shift_id's RESTRICT FK, so filtering it out here would hand HR the
    // raw Postgres delete error this guard exists to prevent.
    const [arr] = await tx
      .select({ id: employmentShiftArrangement.id })
      .from(employmentShiftArrangement)
      .where(eq(employmentShiftArrangement.shiftId, p.shiftId))
      .limit(1);
    if (arr) throw new ShiftInUseError();
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

// ── The Schedule Group's allowed shifts (870b79e2, r277) ───────────────────────────────────────────

/**
 * 870b79e2 — "refuse an employee being put on a shift that is not in their group's allowed list, with a
 * clear message saying which shifts are allowed".
 *
 * THE ALLOWED LIST IS NOT A NEW TABLE. It is `shift.rule_id` read backwards: a shift points at exactly one
 * attendance_rule, so the set of shifts pointing at a rule IS that rule's allowed list. The employee's
 * group is `employment.attendance_rule_id` (migration 0464). Nothing new is stored to answer this
 * question, and the one-rule-per-shift cardinality that makes the answer single-valued is preserved —
 * which is also why rule resolution in core/attendance.ts can never have two answers.
 *
 * ⚠️ WHY THIS IS A SERVICE REFUSAL AND NOT A DB CHECK OR A FORM CHECK.
 *   · Not a CHECK: the rule spans two tables (employment.attendance_rule_id vs shift.rule_id), so it is
 *     not expressible as a column constraint at all, and a NOT VALID check still fires on every UPDATE
 *     (CLAUDE.md §6) — it would start rejecting writes from terminations and erasure sweeps.
 *   · Not a form check: there are FOUR writers of "which shift is this person on", and a check on one
 *     form would miss three — roster generation (assignShiftBulk, via generateRosterFromTemplate), the
 *     per-date roster brush (assignShift, via assignRosterRow), the dated arrangement ladder
 *     (core/shift-arrangement.ts assignEmployeeShiftDated) and the profile backup shift
 *     (assignEmployeeShift → employment.default_shift_id). Every one of them calls this.
 *   · copyRoster calls it too, and that is not belt-and-braces: it writes rows FORWARD in time from a
 *     source window, so a group assigned AFTER the source rows were created would otherwise be bypassed
 *     by the one path whose rows nobody re-examined.
 *
 * ⚠️ AN EMPTY GROUP REFUSES EVERYTHING, DELIBERATELY. A group with no shifts pointing at it permits no
 * shift, and the refusal says exactly that and where to fix it. The alternative — "empty means allow
 * anything" — is silently permissive on precisely the configuration mistake this guard exists to catch.
 *
 * Employments with NO group (all of them at release: the column ships NULL with no backfill) are not
 * constrained at all, so this function is a no-op on release day and every existing caller is unchanged.
 */
export class ShiftNotInScheduleGroupError extends Error {
  constructor(p: { groupName: string; shiftName: string | null; allowed: readonly string[] }) {
    const subject = p.shiftName ? `“${p.shiftName}”` : 'That shift';
    super(
      p.allowed.length === 0
        ? `${subject} cannot be assigned: the Schedule Group “${p.groupName}” does not allow any shift yet. Add shifts to that group on the Schedule Group screen first.`
        : `${subject} is not allowed by the Schedule Group “${p.groupName}”. That group allows: ${p.allowed.join(', ')}.`,
    );
    this.name = 'ShiftNotInScheduleGroupError';
  }
}

/**
 * Refuse every (employment, shift) pair whose employment belongs to a Schedule Group that does not allow
 * that shift. Batched so the bulk writers cost three queries rather than three per row, and so the
 * per-row writers share ONE definition of the rule with them.
 *
 * Runs inside the caller's transaction: RLS has already pinned the tenant, and the check must see the same
 * snapshot as the write it guards.
 *
 * Pairs with a null shiftId (a rest day) are skipped — a rest day puts nobody on a shift.
 */
/** 07ebd04d — one employment's SCHEDULE GROUP id (`employment.attendance_rule_id`), or null. Read on its
 *  own rather than folded into a caller's select because the two walkability guards live in different
 *  files and must ask the question the same way. */
export async function groupRuleIdTx(tx: Tx, employmentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.ruleId ?? null;
}

export async function assertShiftsAllowedForEmploymentsTx(
  tx: Tx,
  pairs: readonly { employmentId: string; shiftId: string | null }[],
): Promise<void> {
  const real = pairs.filter((p): p is { employmentId: string; shiftId: string } => !!p.shiftId);
  if (real.length === 0) return;
  const employmentIds = [...new Set(real.map((p) => p.employmentId))];

  // 1. Which of these employments are in a group at all? None ⇒ nothing to enforce, and this is the
  //    release-day path for every caller.
  const grouped = await tx
    .select({ employmentId: employment.id, ruleId: employment.attendanceRuleId })
    .from(employment)
    .where(and(inArray(employment.id, employmentIds), isNotNull(employment.attendanceRuleId)));
  const groupOf = new Map<string, string>();
  for (const row of grouped) if (row.ruleId) groupOf.set(row.employmentId, row.ruleId);
  if (groupOf.size === 0) return;

  const ruleIds = [...new Set(groupOf.values())];
  const attemptedShiftIds = [...new Set(real.filter((p) => groupOf.has(p.employmentId)).map((p) => p.shiftId))];

  // 2. Every shift that matters in one read: the ones these groups ALLOW (rule_id ∈ ruleIds) and the ones
  //    actually being assigned (so the refusal can name the shift by name rather than by uuid).
  //    ORDER BY name — the allowed list goes into an error message, and an unordered list from a query
  //    makes the same refusal read differently on two runs (CLAUDE.md §8, pin invariants not positions).
  const shifts = await tx
    .select({ id: shift.id, name: shift.name, ruleId: shift.ruleId })
    .from(shift)
    .where(or(inArray(shift.ruleId, ruleIds), inArray(shift.id, attemptedShiftIds)))
    .orderBy(asc(shift.name), asc(shift.id));
  const shiftName = new Map(shifts.map((r) => [r.id, r.name]));
  const allowedByRule = new Map<string, { ids: Set<string>; names: string[] }>(ruleIds.map((r) => [r, { ids: new Set<string>(), names: [] }]));
  for (const r of shifts) {
    if (!r.ruleId) continue;
    const bucket = allowedByRule.get(r.ruleId);
    if (!bucket) continue;
    bucket.ids.add(r.id);
    bucket.names.push(r.name);
  }

  // 3. The group NAMES, for the message. The reporter reads these refusals, not uuids.
  const ruleRows = await tx
    .select({ id: attendanceRule.id, name: attendanceRule.name })
    .from(attendanceRule)
    .where(inArray(attendanceRule.id, ruleIds));
  const ruleName = new Map(ruleRows.map((r) => [r.id, r.name]));

  for (const pair of real) {
    const ruleId = groupOf.get(pair.employmentId);
    if (!ruleId) continue;
    const bucket = allowedByRule.get(ruleId);
    if (bucket?.ids.has(pair.shiftId)) continue;
    throw new ShiftNotInScheduleGroupError({
      groupName: ruleName.get(ruleId) ?? 'this Schedule Group',
      shiftName: shiftName.get(pair.shiftId) ?? null,
      allowed: bucket?.names ?? [],
    });
  }
}

// ── Putting a PERSON in a Schedule Group (f513ec02, r281) ──────────────────────────────────────────

/**
 * f513ec02 — THE WRITER r277 DID NOT SHIP, and with it the REVERSE of the refusal above.
 *
 * r277 shipped `employment.attendance_rule_id` (migration 0464), the additive rule resolution that reads
 * it (core/attendance.ts scheduleFor) and the allowed-shift refusal that four shift writers call. What it
 * did not ship was anything that PUTS a person in a group: the column had no writer and no screen, which
 * is what this item closes. The screen is the Schedule Group card on the Personnel → Attendance tab; this
 * is the service behind it.
 *
 * ⚠️ THE REFUSAL HAS TO RUN IN BOTH DIRECTIONS, AND UNTIL NOW IT RAN IN ONE. Every existing caller of
 * `assertShiftsAllowedForEmploymentsTx` asks "may this person go on that shift?" while the person's group
 * stands still. This writer moves the OTHER side of the same pair: it changes the group while the shift
 * stands still. Without the check below, the one write that could not be refused is the one that seats
 * somebody in a group that forbids the shift they are already working — the exact state the four refusals
 * exist to make unreachable, arrived at from the other end.
 *
 * HOW THE CHECK IS REUSED RATHER THAN RE-STATED. The column is written FIRST and the assertion runs
 * AFTER, inside the same transaction, so `assertShiftsAllowedForEmploymentsTx` reads the group being
 * assigned exactly as it reads a group that was already stored — one definition of "what this group
 * allows", one error message, one place a future change to the rule has to be made. A refusal throws and
 * the transaction rolls the UPDATE back, so a rejected assignment leaves no trace and no event.
 *
 * ⚠️ CLEARING IS NEVER REFUSED. `attendanceRuleId: null` is "resolve from the shift as before" — the
 * blank option on the card — and an employment in no group is constrained by nothing, so the assertion is
 * a no-op on that path by construction rather than by a branch. Taking somebody OUT of a group can never
 * fail, which matters: the way out of a contradiction must not itself be blocked.
 *
 * WHAT THIS DOES NOT RE-EXAMINE, disclosed rather than hidden. The check reads every shift stored for the
 * employee TODAY (see `currentShiftIdsForEmploymentTx` for why all three sources, not one).
 * Roster rows dated AFTER today are not re-examined, for the same reason core/attendance-rule.ts
 * setRuleShifts does not re-examine them when a shift leaves a group: a future roster is a schedule that
 * can still be redrawn, and refusing a group assignment over one day next month would block a legitimate
 * reorganisation with no way to proceed. The four assignment-side refusals still cover every roster row
 * written from here on.
 */

/** The posted group id is not a rule this tenant has (or RLS cannot see it). */
export class ScheduleGroupNotFoundError extends Error {
  constructor() {
    super('That Schedule Group no longer exists. Choose one from the list, or leave the field blank.');
    this.name = 'ScheduleGroupNotFoundError';
  }
}

/**
 * EVERY SHIFT THIS EMPLOYMENT IS CURRENTLY ON — all THREE places the answer is stored, not merely the one
 * a resolver would stop at:
 *
 *   1. the ROSTER ROW for that date          (a brushed or generated day)
 *   2. the dated ARRANGEMENT in force        (employment_shift_arrangement, migration 0421)
 *   3. the BACKUP SHIFT cache                (employment.default_shift_id)
 *
 * ⚠️ A UNION, NOT A LADDER, AND THE DIFFERENCE IS LOAD-BEARING. core/attendance.ts stops at the first rung
 * that answers, because it is deciding what ONE day is judged against. This function is deciding whether a
 * GROUP may be assigned, which is a question about every (employment, shift) pair the row currently holds
 * — and all three are pairs the four assignment-side writers would refuse to create if the group already
 * existed. Stop at rung 1 and a person rostered onto an allowed shift today, whose BACKUP shift the group
 * forbids, is admitted into the group; tomorrow has no roster row, they fall onto that backup shift, and
 * the system is sitting in exactly the state `assertShiftsAllowedForEmploymentsTx` declares unreachable.
 * The invariant those refusals maintain is "no stored pair contradicts the group", so the reverse check
 * has to read every stored pair.
 *
 * Rung 3 is a CACHE of the period in force today and is deliberately left alone by a future-dated ladder
 * write, so it can be null or stale while rung 2 is the real answer — which is the second reason none of
 * the three may be skipped. A rest-day roster row carries no shift and contributes nothing.
 *
 * Returned in rung order and deduplicated, so the refusal names the same shift on every run (the message
 * is read by the reporter — CLAUDE.md §8, pin invariants not positions).
 */
export async function currentShiftIdsForEmploymentTx(
  tx: Tx,
  employmentId: string,
  onDate: string,
): Promise<string[]> {
  const found: string[] = [];
  const [rostered] = await tx
    .select({ shiftId: rosterAssignment.shiftId })
    .from(rosterAssignment)
    .where(and(eq(rosterAssignment.employmentId, employmentId), eq(rosterAssignment.shiftDate, onDate)))
    .limit(1); // (tenant, employment, shift_date) is UNIQUE — roster_assignment_emp_date_uq.
  if (rostered?.shiftId) found.push(rostered.shiftId);

  const inForce = pickArrangementOn(await arrangementsForEmploymentTx(tx, employmentId), onDate);
  if (inForce?.shiftId) found.push(inForce.shiftId);

  const [emp] = await tx
    .select({ shiftId: employment.defaultShiftId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (emp?.shiftId) found.push(emp.shiftId);

  return [...new Set(found)];
}

/** This employment's Schedule Group, or null when it is in none. Read-only; no event. */
export function employmentScheduleGroupId(
  ctx: SessionContext,
  employmentId: string,
): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ ruleId: employment.attendanceRuleId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    return row?.ruleId ?? null;
  });
}

/**
 * Put one employment in a Schedule Group, or take it out of one (`attendanceRuleId: null`).
 *
 * UNCHANGED IS A NO-OP, with no write and no event — the same shape `setEmployeeCode` uses. It matters
 * more here than it does there: this card sits inside the Attendance tab's consolidated Save, and an
 * employment's audit trail should not grow a "schedule group changed" row every time somebody saves the
 * tab for the sake of the Holiday Calendar next to it.
 *
 * AN INACTIVE RULE IS STILL ASSIGNABLE THROUGH THIS SERVICE, deliberately. The card offers only ACTIVE
 * rules plus the one already assigned, and the rule library's own convention is that "inactive rules stay
 * assigned but are hidden from the picker" (db/schema.ts attendance_rule.status). Refusing an inactive id
 * here would mean an employment whose group was deactivated could not have its own card saved at all.
 */
export function setEmploymentScheduleGroup(
  ctx: SessionContext,
  p: { employmentId: string; attendanceRuleId: string | null },
): Promise<{ id: string; attendanceRuleId: string | null; changed: boolean }> {
  return withTenant(ctx, (tx) => setEmploymentScheduleGroupTx(tx, ctx, p));
}

/**
 * 8cd601d0 (r329) — THE ONE WRITER OF `employment.attendance_rule_id`, extracted so the BULK path and the
 * single-employment path cannot become two.
 *
 * ⚠️ WHY THIS IS AN EXTRACTION AND NOT A SECOND FUNCTION. r329 had to put many employments in a Schedule
 * Group in one action (74 of the reporter's 75 active employments are in none, which is why the refusal
 * above is a no-op on almost everybody). The obvious shape — loop `setEmploymentScheduleGroup` — gives each
 * employment ITS OWN transaction, so a refusal on row 40 leaves rows 1-39 moved and the administrator with
 * no idea which. Extracting the body lets `setEmploymentScheduleGroupBulk` run the whole batch inside ONE
 * transaction while still executing, per employment, the identical validation, the identical REVERSE CHECK
 * and the identical DomainEvent. Nothing about the rule is stated twice; delete this function and both
 * doors stop compiling.
 *
 * Runs inside the caller's transaction, exactly like `assertShiftsAllowedForEmploymentsTx` below it: RLS has
 * already pinned the tenant, and the reverse check must see the same snapshot as the UPDATE it guards.
 */
export async function setEmploymentScheduleGroupTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; attendanceRuleId: string | null },
): Promise<{ id: string; attendanceRuleId: string | null; changed: boolean }> {
  const ruleId = p.attendanceRuleId?.trim() || null;
  const [emp] = await tx
    .select({ id: employment.id, before: employment.attendanceRuleId })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  if (!emp) throw new Error('Employment not found');
  if ((emp.before ?? null) === ruleId) {
    return { id: p.employmentId, attendanceRuleId: ruleId, changed: false };
  }

  if (ruleId) {
    // RLS scopes the read, so a rule id from another tenant simply is not found.
    const [rule] = await tx
      .select({ id: attendanceRule.id })
      .from(attendanceRule)
      .where(eq(attendanceRule.id, ruleId))
      .limit(1);
    if (!rule) throw new ScheduleGroupNotFoundError();
  }

  await tx
    .update(employment)
    .set({ attendanceRuleId: ruleId })
    .where(eq(employment.id, p.employmentId));

  // THE REVERSE CHECK. Written above, asserted here, in that order on purpose: the shared refusal reads
  // `employment.attendance_rule_id` out of the transaction's own snapshot, so it judges the group being
  // assigned without needing a second signature or a second copy of the rule. A throw rolls the UPDATE
  // back. Clearing (`ruleId === null`) cannot refuse — an employment in no group is unconstrained.
  const shiftIds = await currentShiftIdsForEmploymentTx(tx, p.employmentId, todayInKualaLumpur());
  await assertShiftsAllowedForEmploymentsTx(
    tx,
    shiftIds.map((shiftId) => ({ employmentId: p.employmentId, shiftId })),
  );

  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: p.employmentId,
    eventType: 'employment.schedule-group.changed',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: { before: emp.before ?? null, after: ruleId },
  });
  return { id: p.employmentId, attendanceRuleId: ruleId, changed: true };
}

/** Nothing was ticked. A form-shaped mistake, refused in the service so no door can post an empty batch. */
export class NoEmploymentsSelectedError extends Error {
  constructor() {
    super('Select at least one employee before assigning a Schedule Group.');
    this.name = 'NoEmploymentsSelectedError';
  }
}

/**
 * 8cd601d0 — ONE employment in the batch was refused, so NONE of them moved.
 *
 * The underlying refusal (`ShiftNotInScheduleGroupError`) names the shift and the group but not the PERSON,
 * because its four original callers are all about one employee the operator is already looking at. In a
 * batch that is not enough to act on: the administrator needs to know which of the forty they ticked is the
 * one holding the batch up. This wraps it with the name and says, in the first sentence, that nothing was
 * saved — the sentence that stops somebody re-ticking the other thirty-nine to "finish the job".
 *
 * `cause` keeps the original refusal, so a caller that wants to branch on the class still can.
 */
export class ScheduleGroupBulkRefusedError extends Error {
  constructor(
    readonly employeeName: string,
    readonly employeeCode: string | null,
    readonly reason: Error,
  ) {
    const who = employeeCode ? `${employeeName} (${employeeCode})` : employeeName;
    super(`Nobody was moved. ${who} cannot join this Schedule Group: ${reason.message}`);
    this.name = 'ScheduleGroupBulkRefusedError';
    this.cause = reason;
  }
}

/**
 * 8cd601d0 (r329) — PUT MANY EMPLOYMENTS IN A SCHEDULE GROUP IN ONE ACTION.
 *
 * ⚠️ THIS IS THE THING THAT MAKES THE EXISTING GUARD MEAN ANYTHING. 870b79e2 (r277) shipped a correct
 * service-side refusal — a grouped employee cannot be put on a shift their group forbids — and f513ec02
 * (r281) shipped a screen that puts ONE employment in a group at a time. Measured on production on
 * 2026-09-22: 1 of 75 active employments has a group. For the other 74 the refusal is a no-op by its own
 * header ("employments with NO group are not constrained at all"). The missing piece was never the
 * validation; it was that seating seventy-four people one personnel page at a time is why nobody did.
 *
 * ⚠️ THE TRANSACTION BOUNDARY IS THE WHOLE BATCH, AND THAT IS A DECISION, NOT A DEFAULT. The alternative —
 * commit each employment and report the failures — is wrong here for a reason specific to this rule: the
 * refusal fires on a CONTRADICTION between the group and the shift the employee is already working, so a
 * half-applied batch leaves some people in a group whose shifts they are not on and others not, and the
 * operator cannot tell which without re-reading seventy-four rows. One transaction means the answer is
 * always "all of them" or "none of them, and here is the one that blocked it". A batch is also small and
 * operator-initiated: this is not a sweep that must make progress.
 *
 * NO NEW EVENT TYPE. Each employment still gets its own `employment.schedule-group.changed` from the shared
 * writer, which is what the Others-tab Change History reads; a batch-level event would be a second record of
 * the same fact and would need lib/audit-format.ts taught a new shape for nothing.
 *
 * IDS ARE DEDUPLICATED AND SORTED — deterministic lock order across concurrent batches, and a deterministic
 * FIRST refusal, so the same batch names the same blocking employee on every run (CLAUDE.md §8).
 *
 * WHAT IT DOES NOT DO, disclosed rather than hidden: it does not refuse a terminated employment, does not
 * re-examine future-dated roster rows and does not touch anybody's shift. It is exactly N calls of the
 * single-employment writer, with one commit.
 */
export async function setEmploymentScheduleGroupBulk(
  ctx: SessionContext,
  p: { employmentIds: readonly string[]; attendanceRuleId: string | null },
): Promise<{ requested: number; changed: number; unchanged: number }> {
  const ids = [...new Set(p.employmentIds.map((v) => v.trim()).filter(Boolean))].sort();
  if (ids.length === 0) throw new NoEmploymentsSelectedError();
  return withTenant(ctx, async (tx) => {
    let changed = 0;
    for (const employmentId of ids) {
      try {
        const r = await setEmploymentScheduleGroupTx(tx, ctx, {
          employmentId,
          attendanceRuleId: p.attendanceRuleId,
        });
        if (r.changed) changed += 1;
      } catch (e) {
        if (e instanceof ShiftNotInScheduleGroupError) {
          // Name the person. The read is inside the same transaction that is about to roll back, which is
          // fine — it is a read, and the rollback is what makes the message true.
          const [who] = await tx
            .select({ name: person.fullName, code: employment.employeeCode })
            .from(employment)
            .innerJoin(person, eq(person.id, employment.personId))
            .where(eq(employment.id, employmentId))
            .limit(1);
          throw new ScheduleGroupBulkRefusedError(who?.name ?? employmentId, who?.code ?? null, e);
        }
        throw e;
      }
    }
    return { requested: ids.length, changed, unchanged: ids.length - changed };
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
      .select({
        id: shift.id,
        archivedAt: shift.archivedAt,
        pattern: shift.weeklyPattern,
        halfPattern: shift.halfPattern,
        offPattern: shift.offPattern,
        // 07ebd04d — the shift's Schedule Group, so the walkability test below asks about the week the
        // ENGINE will actually use (migration 0483), not the one stored on the shift.
        ruleId: shift.ruleId,
      })
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
    // b8aa3466 — "has a working pattern" is now Full ∪ HALF: a shift that is all half days is perfectly
    // walkable, and refusing it would be a new false rejection. Off and Rest are still not working days.
    //
    // 07ebd04d — AND THE WEEK THIS ASKS ABOUT IS THE RESOLVED ONE. Since migration 0483 a Schedule Group
    // can carry the working week, and core/attendance.ts scheduleFor resolves the group's ahead of the
    // shift's. A guard that kept reading only `shift.weekly_pattern` would refuse a shift that is
    // perfectly walkable under its group — a FALSE rejection with no way for the operator to see why —
    // while still failing to notice the case it exists for. The refusal itself is unchanged and is NOT
    // loosened: what is refused is still "this person's unrostered days would ALL be rest days", asked of
    // the week that decides them. Employee's group → shift's group → the tenant default, exactly the
    // chain `ruleFor` uses.
    const assignWeek = (await weekLookupTx(tx, (await groupRuleIdTx(tx, p.employmentId)), [sh.ruleId]))(sh.ruleId, sh);
    if (weekPatternWorkingDayCount(assignWeek) === 0) throw new ShiftHasNoWorkingPatternError();
    // 870b79e2 — and the shift must be one the employee's Schedule Group allows. No group ⇒ no-op, which
    // is every employment at release. See assertShiftsAllowedForEmploymentsTx for why the refusal lives
    // here rather than on the form: this is one of four writers of "which shift is this person on".
    await assertShiftsAllowedForEmploymentsTx(tx, [{ employmentId: p.employmentId, shiftId }]);
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

/** The (employee, date) row as it stood BEFORE a write, for the audit payload's `prev*` fields. Read
 *  inside the same transaction as the upsert so the "before" can never be a different row's state. */
async function rosterRowBefore(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  employmentId: string,
  shiftDate: string,
): Promise<{ prevShiftId: string | null; prevIsRestDay: boolean | null }> {
  const [prev] = await tx
    .select({ shiftId: rosterAssignment.shiftId, isRestDay: rosterAssignment.isRestDay })
    .from(rosterAssignment)
    .where(and(eq(rosterAssignment.employmentId, employmentId), eq(rosterAssignment.shiftDate, shiftDate)))
    .limit(1);
  // No row at all ⇒ nulls, not `false`: "nothing was rostered" and "an explicit working day" are
  // different befores, and the Audit Trail has to be able to say which one it was.
  return { prevShiftId: prev?.shiftId ?? null, prevIsRestDay: prev ? prev.isRestDay : null };
}

/** Assign (or re-assign) a shift to an employee on a date. Upsert: one assignment per (employee, date). */
export async function assignShift(ctx: SessionContext, p: { employmentId: string; shiftDate: string; shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    // 870b79e2 — the Schedule Group's allowed-shift list, enforced before the upsert. assignRosterRow
    // loops this primitive per date, so the per-date roster brush is covered by this one call.
    await assertShiftsAllowedForEmploymentsTx(tx, [{ employmentId: p.employmentId, shiftId: p.shiftId }]);
    const before = await rosterRowBefore(tx, p.employmentId, p.shiftDate);
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
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: p.shiftId, ...before },
    });
    return { id: row.id };
  });
}

/** Mark a date as an explicit rest day for an employee (vs no row = company-policy fallback). */
export async function setRestDay(ctx: SessionContext, p: { employmentId: string; shiftDate: string; note?: string }) {
  return withTenant(ctx, async (tx) => {
    const before = await rosterRowBefore(tx, p.employmentId, p.shiftDate);
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
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate, ...before },
    });
    return { id: row.id };
  });
}

/**
 * Remove an assignment → the date falls back to the company policy.
 *
 * 42afb2d2 → 154865f4 — THE DELETE ASYMMETRY, MEASURED 2026-08-12 AND CLOSED 2026-08-13.
 *
 * WHAT IT WAS. `roster_assignment_rls` (db/migrations/0075_shift_roster.sql:51-53) is a single FOR ALL
 * policy, so its WITH CHECK (`app.can_admin_employment`) governs INSERT and the new row of an UPDATE —
 * but a DELETE is matched against USING ALONE, which is `app.can_see_employment`, and a supervisor and
 * the employee themselves both pass that. Measured on a disposable database as `ai_hr_app` in a
 * rolled-back transaction, with a real active administrative reporting line: the same manager session
 * that gets 42501 for an INSERT and for a constraint-valid UPDATE on a future-dated row of a direct
 * report got `DELETE 1` for the delete of that row — future-dated or past-dated, no difference, because
 * the storage layer carries no date rule either. The employee's own roster day likewise deleted under a
 * plain `employee` grant. Negative control: the same employee against a row they cannot see got
 * `DELETE 0`, silently filtered rather than refused, which is what USING does.
 *
 * WHAT IT IS NOW. `0436_roster_assignment_delete_guard.sql` adds a RESTRICTIVE FOR DELETE policy
 * requiring `app.can_admin_employment`, which ANDs with the permissive FOR ALL one. All three verbs are
 * now refused underneath for anyone who may not administer the employment, and reads are untouched —
 * a supervisor and the employee still SEE the roster. test/roster-delete-rls.test.ts holds the matrix,
 * and its watched-fail (0436 dropped from the journal) puts both non-admin delete legs back to
 * `rows: 1`.
 *
 * ⚠️ THE DELETE REFUSAL IS SILENT, AND STILL DOES NOT MAKE `assertRosterAdmin` OPTIONAL. A restrictive
 * policy for DELETE is a USING clause, and USING FILTERS rather than raising: a refused delete removes
 * zero rows and reports no error (the same behaviour recorded for the identical guard on
 * leave_year_config, 0385_leave_year_config_reset.sql:13-14). So a caller that skipped the application
 * guard would now leave the roster intact — but it would also tell the operator the removal succeeded.
 * DO NOT ADD A CALLER THAT SKIPS `assertRosterAdmin`; it is what turns this into a visible refusal.
 */
export async function clearRoster(ctx: SessionContext, p: { employmentId: string; shiftDate: string }) {
  return withTenant(ctx, async (tx) => {
    // The deleted row IS the "before" — returning it costs nothing and needs no second read.
    const [row] = await tx
      .delete(rosterAssignment)
      .where(and(eq(rosterAssignment.employmentId, p.employmentId), eq(rosterAssignment.shiftDate, p.shiftDate)))
      .returning({ id: rosterAssignment.id, shiftId: rosterAssignment.shiftId, isRestDay: rosterAssignment.isRestDay });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        shiftDate: p.shiftDate,
        prevShiftId: row.shiftId,
        prevIsRestDay: row.isRestDay,
      },
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
    // 870b79e2 — one batched check for the whole grid, BEFORE any row is written, so a generation run that
    // would put somebody on a shift their group forbids fails whole rather than half. This is the
    // roster-generation writer (generateRosterFromTemplate is a thin date-splitter over this primitive).
    await assertShiftsAllowedForEmploymentsTx(
      tx,
      p.employmentIds.map((employmentId) => ({ employmentId, shiftId: p.shiftId })),
    );
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
export async function setRestDayBulk(
  ctx: SessionContext,
  p: {
    employmentIds: string[];
    shiftDates: string[];
    /** The shift template that DROVE these rest days (the generator's case). */
    forShiftId?: string | null;
    /** 23390097 — an upload's rest days are not driven by any shift, so it anchors on its company
     *  instead. Anchoring them on an arbitrary shift would put an event on a row that had nothing to
     *  do with the change; one of the two must be supplied. */
    anchorId?: string;
  },
) {
  if (p.employmentIds.length === 0 || p.shiftDates.length === 0) return { rested: 0 };
  const anchorId = p.forShiftId ?? p.anchorId;
  if (!anchorId) throw new Error('setRestDayBulk needs forShiftId or anchorId to anchor its event');
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
      aggregateId: anchorId,
      eventType: 'roster.bulk.rest-day.set',
      actor: actorOf(ctx),
      payload: {
        shiftId: p.forShiftId ?? null,
        employmentCount: p.employmentIds.length,
        dateCount: p.shiftDates.length,
        rows: values.length,
      },
    });
    return { rested: values.length };
  });
}

const DAY_MS = 86_400_000;
// a57f0584 rev 2 — the local `const isIsoDate = /^\d{4}-\d{2}-\d{2}$/` that stood here was a
// character-for-character copy of lib/roster-month's exported one, and this file now imports that module
// anyway. Two identical predicates are two things to change when the shape of a date changes.

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

  // 07ebd04d — the template's week is resolved through its SCHEDULE GROUP first (migration 0483). The
  // generator writes a row for every date in the window, so if it split the month by the shift's own week
  // while the engine measured each day against the group's, every generated rest row on a day the group
  // calls working would be a rest day the engine never agreed to — and rest-day overtime is 2.0x.
  // `weekPatternFor` hands back the shift's own week for any group that declares none, so a shift that has
  // not been put into a pattern-carrying group generates exactly the month it generates today.
  //
  // The GROUP here is the SHIFT's (shift.rule_id), not any one employee's: this call generates for a whole
  // department, and the group guard (assertShiftsAllowedForEmploymentsTx) already refuses an employment
  // whose own group does not contain this shift, so on every assignment the system accepts the two agree.
  const tpl = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        companyId: shift.companyId,
        weeklyPattern: shift.weeklyPattern,
        // b8aa3466 — the four-way row, so generation and the engine split the month the same way.
        halfPattern: shift.halfPattern,
        offPattern: shift.offPattern,
        ruleId: shift.ruleId,
        archivedAt: shift.archivedAt,
      })
      .from(shift)
      .where(eq(shift.id, p.shiftId))
      .limit(1);
    if (!row) return null;
    const week = (await weekLookupTx(tx, null, [row.ruleId]))(row.ruleId, {
      pattern: row.weeklyPattern,
      halfPattern: row.halfPattern,
      offPattern: row.offPattern,
    });
    return { ...row, ...week };
  });
  if (!tpl) throw new Error('Shift not found (or not visible)');
  if (tpl.archivedAt) throw new Error('Cannot generate a roster from an archived shift');
  // b8aa3466 — Full ∪ Half. A shift that is all half days has a perfectly usable pattern; refusing it here
  // would be a new false rejection introduced by the four-way row.
  if (workingDayCount({ pattern: tpl.pattern, halfPattern: tpl.halfPattern }) === 0) {
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

  // b8aa3466 — generation reads the FOUR-WAY row through the shared resolver. Full and Half both generate
  // a shift row (a half day is a working day; its shorter hours are decided by the engine, not by whether a
  // roster row exists); Rest and Off both generate a rest row, because neither is scheduled work. A
  // template written before migration 0429 has empty half/off arrays and therefore splits exactly as before.
  const workingDates: string[] = [];
  const restDates: string[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const iso = new Date(ms).toISOString().slice(0, 10);
    const kind = shiftDayKindFor({ pattern: tpl.pattern, halfPattern: tpl.halfPattern, offPattern: tpl.offPattern }, iso);
    (isWorkingDayKind(kind) ? workingDates : restDates).push(iso);
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
    // 870b79e2 — copied rows are NOT pre-validated by having existed once: the copy writes forward in
    // time, and a Schedule Group assigned since the source window was rostered would otherwise be
    // bypassed by the only path whose rows nobody re-examines. Rest-day rows carry a null shiftId and are
    // skipped by the checker.
    await assertShiftsAllowedForEmploymentsTx(
      tx,
      values.map((v) => ({ employmentId: v.employmentId, shiftId: v.shiftId })),
    );
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
        // 6948727a — WHEN the supervisor last touched this date. My Roster prints one "Last updated"
        // stamp per window and takes the MAX of these; the grid and the export map these rows into
        // `cells` rather than serialising them, so nothing downstream grows a byte by adding it. A
        // separate `select max(updated_at)` would be a second round trip for a value already sitting in
        // the row this query is fetching anyway.
        updatedAt: rosterAssignment.updatedAt,
      })
      .from(rosterAssignment)
      .where(and(...conds))
      .orderBy(asc(rosterAssignment.shiftDate));
  });
}

// ── 23390097 · Monthly roster grid ──────────────────────────────────
//
// The month view has to answer "what is this person doing on this date" for ~31 × N cells, including
// the dates nobody rostered. That answer is the DEFAULT (usual) shift, resolved by exactly the order
// core/attendance.ts's scheduleFor uses — see lib/roster-month.ts, which owns the pure precedence and is
// shared by the grid, the export and the upload analyzer. This half is only the BATCHED READ: one query
// for everyone's default shift, so a 200-employee month is not 200 round trips.

/** One employee's usual shift, as the grid ghosts it onto un-rostered dates. */
export type UsualShiftRow = {
  employmentId: string;
  shiftId: string;
  code: string | null;
  name: string;
  startTime: string;
  endTime: string;
  /** ISO weekdays the shift works (1=Mon…7=Sun). NULL ⇒ the shift schedules nothing (same as scheduleFor). */
  pattern: number[] | null;
};

/**
 * Every listed employee's DEFAULT shift, batched — the same join core/attendance.ts makes near line 1888
 * for its own display resolution (employment.default_shift_id → shift). Employees with no default shift
 * are simply absent from the result; their month reads as blank, which is the honest answer and is what
 * the Attendance Policy screen's "no usual shift" list already exists to fix.
 */
export function usualShiftsFor(ctx: SessionContext, employmentIds: string[]): Promise<UsualShiftRow[]> {
  if (employmentIds.length === 0) return Promise.resolve([]);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        shiftId: shift.id,
        code: shift.code,
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        pattern: shift.weeklyPattern,
        // 07ebd04d — the four-way row is read but NOT surfaced (see below), and the two Schedule Group
        // columns the ghost cells must now resolve through (migration 0483).
        halfPattern: shift.halfPattern,
        offPattern: shift.offPattern,
        shiftRuleId: shift.ruleId,
        groupRuleId: employment.attendanceRuleId,
      })
      .from(employment)
      .innerJoin(shift, eq(shift.id, employment.defaultShiftId))
      .where(inArray(employment.id, employmentIds));
    // 07ebd04d — the ghost cells follow the SCHEDULE GROUP's week when it has one, the same chain
    // scheduleFor uses (employee's group → shift's group → tenant default), so the grid cannot say OFF on
    // a day the engine pays as work. One extra set-based read for the whole grid.
    //
    // ⚠️ WHAT THIS DELIBERATELY DOES NOT FIX: `UsualShift.pattern` is still the FULL-day list alone and
    // lib/roster-month.ts resolveRosterCell still asks it a two-way question, so a HALF working day
    // renders as OFF on the duty roster while the engine treats it as a working half day. That is a
    // pre-existing display defect (it predates this item and is unchanged by it), it needs its own item,
    // and widening the type here without changing the renderer would only move it.
    const lookup = await weekLookupTx(tx, null, [...rows.map((r) => r.shiftRuleId), ...rows.map((r) => r.groupRuleId)]);
    return rows.map(({ halfPattern, offPattern, shiftRuleId, groupRuleId, ...r }) => ({
      ...r,
      pattern: lookup(groupRuleId ?? shiftRuleId, { pattern: r.pattern, halfPattern, offPattern }).pattern,
    }));
  });
}

/** One row of the month grid's pinned block. Every field comes from listEmployees, which already
 *  returns them — the month view adds no new read for the filters. */
export type RosterMonthEmployee = {
  employmentId: string;
  name: string;
  code: string | null;
  department: string | null;
  departmentId: string | null;
  businessUnit: string | null;
  businessUnitId: string | null;
  occupation: string | null;
  /** a57f0584 — whose employee this is. Carried on every row because the roster can now span companies,
   *  and a row that does not say which company it belongs to is unreadable once it can. */
  company: string | null;
  companyId: string | null;
};

export type RosterMonthView = {
  /** a57f0584 rev 2 — `month` is GONE from this type, deliberately. The read is a WINDOW now, and a week
   *  that straddles 31 August has no single month to report; a field that had to be filled with one of
   *  the two would be a value every caller could read and none could trust. The screen knows which view
   *  asked (lib/roster-month#RosterWindow carries it); the read only needs the two dates. */
  from: string;
  to: string;
  dates: string[];
  /** After Business Group / Department / Employee filtering — what the grid draws. */
  employees: RosterMonthEmployee[];
  /** Before filtering — what the filter dropdowns are built from, so choosing one never empties them. */
  allEmployees: RosterMonthEmployee[];
  /** 6340aecb — `color` is the shift's DISPLAY-ONLY colour token; NULL keeps the grid's rotating palette. */
  shifts: { id: string; code: string | null; name: string; startTime: string; endTime: string; color: string | null }[];
  /** `employmentId|date` → what is STORED (null for the dates nobody rostered). */
  cells: Record<string, AssignedCell>;
  /** employmentId → usual shift, for the grey ghost cells and the OFF markers. */
  usual: Record<string, UsualShift>;
  usualNames: Record<string, { code: string | null; name: string }>;
};

/**
 * THE month view, read once and shared by the screen and the export so the file can never disagree with
 * what was on screen. Filtering is in-memory over listEmployees' already-RLS-fenced rows: the caller sees
 * only the people they are responsible for, and the Business Group / Department / Employee filters narrow
 * that further without a second query.
 */
/**
 * a57f0584 rev 2 — WHAT THE ROSTER MAY BE ASKED FOR AT ONCE, refused in the SERVICE.
 *
 * `resolveRosterWindow` (lib/roster-month.ts) keeps the SCREEN inside the cap and explains itself when
 * it clamps. This is the other half, and it is not the same half: the export route takes `from`/`to`
 * straight off a query string, the edit screen takes them off its own, and a hand-crafted
 * `?from=2026-01-01&to=2026-12-31` must not be able to ask this read for 365 columns × every employee
 * because a form would have stopped it. A form is an affordance; this is the guard.
 *
 * The cap itself, and the arithmetic behind 92, is documented on ROSTER_MAX_RANGE_DAYS.
 */
export class RosterRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterRangeError';
  }
}

export function assertRosterWindow(from: string, to: string): void {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new RosterRangeError('The roster needs a From and a To date in YYYY-MM-DD form.');
  }
  if (to < from) throw new RosterRangeError('The roster window ends before it starts.');
  const days = daysInWindow(from, to);
  if (days > ROSTER_MAX_RANGE_DAYS) {
    throw new RosterRangeError(
      `The roster shows at most ${ROSTER_MAX_RANGE_DAYS} days at a time; that window asks for ${days}.`,
    );
  }
}

/**
 * ONE READ, THREE VIEWS. Month, Week and a Custom From/To range differ ONLY in the pair of dates handed
 * to this function — the plan's binding sentence is "The Week and Custom range views read the same
 * roster the Month view does, so a date cannot show one shift in one view and another in another", and a
 * second view-specific read is exactly how that promise gets broken six months from now.
 *
 * `rosterMonthView` below is the MONTH HELPER over this, not a second reader: it turns a `YYYY-MM` into
 * the pair and calls straight through. Callers that genuinely mean a month (the Excel round trip, whose
 * whole contract is "only dates inside {month} are saved") keep saying so; callers that mean a window
 * say that instead.
 */
export async function rosterWindowView(
  ctx: SessionContext,
  p: {
    /**
     * a57f0584 — COMPANIES, plural. This read took a single company and the Roster screen picked
     * `companies[0]` when none was chosen, so an operator with twelve companies opened the screen on
     * whichever sorted first and about a third of their people, with no indication the rest existed.
     * That is the "I cannot immediately see the overall employee roster" in the ticket — the filters were
     * never the problem.
     *
     * The caller passes the set it is authorised for, and a chosen company simply narrows that set. RLS is
     * unchanged and `listEmployees` is scoped by it either way: this widens what is ASKED FOR, never what
     * is permitted. An EMPTY array means "every company the session may see", matching `listEmployees`'
     * own contract for an absent filter — it is not a request for nothing.
     */
    companyIds: string[];
    /** First and last date ON SCREEN, inclusive. Refused by `assertRosterWindow` before any query runs. */
    from: string;
    to: string;
    businessUnitId?: string;
    departmentId?: string;
    q?: string;
    /**
     * a57f0584 rev 2 — narrow to specific employments. The per-employee Edit screen
     * (app/roster/edit/[employmentId]) is a WINDOW on this same view, not a read of its own: it must
     * resolve every cell through the same precedence the grid behind it used, or a date shows one code
     * on the roster and another in the editor that is about to overwrite it.
     *
     * It narrows what is ASKED FOR, never what is permitted: the rows still come from `listEmployees`,
     * which is RLS-fenced, so an id this session may not see simply yields no row.
     */
    employmentIds?: string[];
  },
): Promise<RosterMonthView> {
  // FIRST, before any query: an over-wide window must cost nothing to refuse.
  assertRosterWindow(p.from, p.to);
  const { from, to } = { from: p.from, to: p.to };
  const dates = datesBetween(from, to);
  const [employeeRows, shiftRows] = await Promise.all([
    listEmployees(ctx, p.companyIds.length > 0 ? p.companyIds : undefined),
    listShiftsForTenant(ctx),
  ]);

  const allEmployees: RosterMonthEmployee[] = employeeRows
    .filter((e) => !e.terminatedOn)
    .map((e) => ({
      employmentId: e.employmentId,
      name: e.name,
      code: e.employeeCode,
      department: e.department,
      departmentId: e.departmentId,
      businessUnit: e.businessUnit,
      businessUnitId: e.businessUnitId,
      occupation: e.position,
      company: e.company,
      companyId: e.companyId,
    }));

  const needle = (p.q ?? '').trim().toLowerCase();
  const wanted = p.employmentIds ? new Set(p.employmentIds) : null;
  const employees = allEmployees.filter(
    (e) =>
      (!wanted || wanted.has(e.employmentId)) &&
      (!p.businessUnitId || e.businessUnitId === p.businessUnitId) &&
      (!p.departmentId || e.departmentId === p.departmentId) &&
      (needle === '' || e.name.toLowerCase().includes(needle) || (e.code ?? '').toLowerCase().includes(needle)),
  );

  // The roster read is narrowed to the employees actually on screen. A filtered month must not drag the
  // whole company's rows across just to throw them away, and an empty result must not fall through to
  // rosterForRange's "no employmentIds ⇒ everyone" branch.
  const visible = employees.map((e) => e.employmentId);
  const [roster, usualRows] = await Promise.all([
    visible.length > 0 ? rosterForRange(ctx, { employmentIds: visible, from, to }) : Promise.resolve([]),
    usualShiftsFor(ctx, visible),
  ]);

  const cells: Record<string, AssignedCell> = {};
  for (const r of roster) {
    cells[cellKey(r.employmentId, r.shiftDate)] = r.isRestDay
      ? { kind: 'rest' }
      : r.shiftId
        ? { kind: 'shift', shiftId: r.shiftId }
        : null;
  }

  const usual: Record<string, UsualShift> = {};
  const usualNames: Record<string, { code: string | null; name: string }> = {};
  for (const u of usualRows) {
    usual[u.employmentId] = { shiftId: u.shiftId, pattern: u.pattern };
    usualNames[u.shiftId] = { code: u.code, name: u.name };
  }

  return {
    from,
    to,
    dates,
    employees,
    allEmployees,
    shifts: shiftRows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      color: s.color,
    })),
    cells,
    usual,
    usualNames,
  };
}

/**
 * THE MONTH HELPER over `rosterWindowView` — "one resolver, three callers" with month as the helper that
 * produces the pair (a57f0584 rev 2's plan, item 6).
 *
 * It is NOT a second read and must never become one: it turns `YYYY-MM` into the window and calls
 * straight through, so a month view and a custom range covering the same month return byte-identical
 * cells. Kept because two callers genuinely mean a MONTH rather than a window — the Excel round trip
 * (app/roster/import), whose contract is "only dates inside {month} are saved", and every test that was
 * written against a month — and because a month is the one window this screen can name in one word.
 */
export function rosterMonthView(
  ctx: SessionContext,
  p: {
    companyIds: string[];
    month: string;
    businessUnitId?: string;
    departmentId?: string;
    q?: string;
    employmentIds?: string[];
  },
): Promise<RosterMonthView> {
  const { month, ...rest } = p;
  return rosterWindowView(ctx, { ...rest, ...monthRange(month) });
}

/**
 * 23390097 BLOCKER — WHO MAY CHANGE THE ROSTER AT ALL, answered in the SERVER before any SQL runs.
 *
 * WRITING roster_assignment requires app.can_admin_employment → app.is_admin_for, so ROW-LEVEL SECURITY
 * refuses a supervisor all three verbs — INSERT and UPDATE since 0075, and DELETE since 154865f4 /
 * 0436_roster_assignment_delete_guard.sql. This guard is therefore belt over a brace throughout, but it
 * is NOT redundant: read the delete note on `clearRoster`, because the database's delete refusal is
 * SILENT (zero rows, no error) and this is what turns it into something an operator can see.
 * WHAT IT REFUSES WITH was the hole: drizzle wraps 42501 as
 * `Failed query: insert into "roster_assignment" … params: <tenant uuid>,<employment uuid>,…`, and the
 * roster actions copy `(e as Error).message` verbatim into a toast (the three cell actions) or into
 * `?error=`, which app/roster/page.tsx renders in ErrorBanner (Generate / Copy). The database's own
 * refusal — SQL text and internal identifiers — was being printed to whoever asked for it.
 *
 * HIDING THE BUTTONS IS NOT A GUARD, and cannot be. components/roster-grid.tsx renders a supervisor a
 * read-only month, but the three cell actions are Server Actions: their ids ship inside that same
 * supervisor's bundle and they are POST endpoints reachable with or without a button on screen. An
 * affordance that is merely absent is still callable, so the refusal has to live here.
 *
 * Deliberately SEPARATE from canWriteRosterDate below. That predicate answers "is this DATE writable",
 * is pure over (session, date, today) and is unchanged. This answers the PRIOR question — "may this
 * session write the roster at all" — which does not depend on a date and must be asked first.
 */
export class RosterAdminRequiredError extends Error {
  constructor() {
    super('Only an HR administrator can change the roster. Ask an administrator to make this change.');
    this.name = 'RosterAdminRequiredError';
  }
}

/** Throws unless this session may write the roster. Call it FIRST in every roster write action, before
 *  the date rule and before any database call. */
export function assertRosterAdmin(ctx: SessionContext): void {
  if (!isAdmin(ctx)) throw new RosterAdminRequiredError();
}

/**
 * The past-date rule (requirement 9 of the reporter's list). A date that is TODAY or earlier has usually
 * already been attended — the attendance figures for it were fixed when the day was saved — so only an
 * HR administrator may re-write it, and the UI confirms first.
 *
 * READ THIS BEFORE QUOTING THE `shiftDate > today` BRANCH AS A SUPERVISOR CAPABILITY. Inserting or
 * updating roster_assignment already requires app.can_admin_employment → app.is_admin_for, i.e. an
 * hr_admin or super_admin grant; and `assertRosterAdmin` is called before this predicate in every write
 * path, so every session that reaches it is an admin, `isAdmin(ctx)` is already true, and the left-hand
 * branch never decides anything at the write boundary. A supervisor clicking tomorrow does not get
 * "allowed" — RLS refuses the insert with 42501. The grid is rendered READ-ONLY for a non-admin for
 * exactly that reason (components/roster-grid.tsx). (DELETE used to be the exception RLS did NOT cover;
 * 0436_roster_assignment_delete_guard.sql closed it — see the note on `clearRoster` above. It changed
 * nothing here either way, because `assertRosterAdmin` runs first.)
 *
 * The predicate is kept as belt-and-braces, so that if roster_assignment's RLS is ever widened to
 * supervisors, today-and-earlier stays administrator-only without a second change. It is NOT evidence
 * that a supervisor can roster tomorrow today; that would be a separate RLS decision.
 *
 * A PURE predicate over the session, deliberately: `today` is injectable so the test does not depend on
 * the day it runs, and the server actions call `assertRosterDatesWritable` before any write.
 */
export const canWriteRosterDate = (ctx: SessionContext, shiftDate: string, today = todayInKualaLumpur()): boolean =>
  shiftDate > today || isAdmin(ctx);

export class PastRosterDateError extends Error {
  readonly dates: string[];
  constructor(dates: string[]) {
    super(
      `Only an HR administrator can change a roster date that is today or earlier (${dates.slice(0, 5).join(', ')}${
        dates.length > 5 ? `, +${dates.length - 5}` : ''
      }).`,
    );
    this.name = 'PastRosterDateError';
    this.dates = dates;
  }
}

/** Throws unless every date is writable by this session. Call it in the server action BEFORE any write. */
export function assertRosterDatesWritable(ctx: SessionContext, dates: string[], today = todayInKualaLumpur()): void {
  const blocked = dates.filter((d) => !canWriteRosterDate(ctx, d, today));
  if (blocked.length > 0) throw new PastRosterDateError([...new Set(blocked)].sort());
}

/**
 * ONE employee, MANY dates, one brush — the row Edit panel (requirement: "tick several dates and set
 * them all to one shift").
 *
 * It deliberately loops the PER-DATE primitives instead of calling assignShiftBulk / setRestDayBulk.
 * Those write a single summary event carrying only a shift id and counts: no per-date row and no
 * previous shift, which is exactly what the audit requirement asks for. The 4,500-staff event-spam
 * rationale that justifies the bulk summaries does not apply here — one employee × at most 31 dates is
 * bounded, so the row panel can afford a reversible event per date and the Audit Trail gets the
 * before/after it was promised.
 */
export async function assignRosterRow(
  ctx: SessionContext,
  p: { employmentId: string; shiftDates: string[]; brush: string },
): Promise<{ applied: number }> {
  const dates = [...new Set(p.shiftDates)].filter(isIsoDate).sort();
  // Both rights, in order: may this session write the roster at all, then may it write these dates.
  assertRosterAdmin(ctx);
  assertRosterDatesWritable(ctx, dates);
  for (const shiftDate of dates) {
    if (p.brush === 'rest') await setRestDay(ctx, { employmentId: p.employmentId, shiftDate });
    else if (p.brush === 'clear') await clearRoster(ctx, { employmentId: p.employmentId, shiftDate });
    else await assignShift(ctx, { employmentId: p.employmentId, shiftDate, shiftId: p.brush });
  }
  return { applied: dates.length };
}

/** The upload's single audit entry (requirement 10: "each upload is ONE entry with the file name,
 *  counts and rejects"). Anchored on the company so the Audit Trail groups uploads sensibly. */
export async function recordRosterUpload(
  ctx: SessionContext,
  p: {
    companyId: string;
    month: string;
    fileName: string;
    employees: number;
    rowsRead: number;
    changed: number;
    rejected: number;
  },
): Promise<void> {
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: p.companyId,
      eventType: 'roster.bulk.uploaded',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        month: p.month,
        fileName: p.fileName,
        employees: p.employees,
        rowsRead: p.rowsRead,
        changed: p.changed,
        rejected: p.rejected,
      },
    }),
  );
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
        // cf21e554 — the Roster screen must expect the SAME figure the engine schedules against, so it has
        // to fetch the shift's Normal-Hours Rounding too. Without it /roster computed the unrounded net and
        // flagged a fully-worked rounded day as 'short', contradicting the Attendance screen.
        rounding: shift.normalHoursRoundingMinutes,
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
      // cf21e554 — one shared helper, never an inlined copy. This was the FIFTH inlined span−break and the
      // only one rounding never reached, so /roster could call a fully-worked day 'short'.
      const expectedMinutes =
        r.isRestDay || !r.start || !r.end ? null : netScheduledMinutes(r.start, r.end, r.crosses ?? false, r.brk ?? 0, r.rounding);
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

/** An exception is a variance row that is NOT on track. One spelling, used by the Roster screen's count
 *  and by the Exceptions screen's list, so the number on the button can never disagree with the number of
 *  rows behind it. */
export const isRosterException = (v: RosterVarianceRow): boolean => v.kind !== 'on_track';

/**
 * a57f0584 rev 2 — HOW MANY exceptions, for the Roster screen's Exceptions button.
 *
 * The listing moved off /roster onto /roster/exceptions; the roster keeps only the count, so it stops
 * serialising rows it no longer draws into the RSC payload of every month view.
 *
 * ⚠️ THIS IS DELIBERATELY NOT A SECOND, CHEAPER SQL READ, and saying so is the point. What counts as an
 * exception is decided in JavaScript above — approved full-day leave per date (ADR-0068 §4A), half/hourly
 * leave spans, `shiftDate > today`, and `netScheduledMinutes` with the shift's own Normal-Hours Rounding
 * (cf21e554). A `select count(*)` could not ask any of those questions, and a second implementation that
 * approximated them would be a second source of truth for "is this an exception" — exactly the drift that
 * once let /roster call a fully-worked rounded day 'short' while /attendance called it on track. The
 * saving here is the PAYLOAD, not the query; buying the query back means moving the whole rule into SQL,
 * which is a different change.
 */
export async function rosterExceptionCount(
  ctx: SessionContext,
  p: { from: string; to: string; companyIds?: string[]; today?: string },
): Promise<number> {
  return (await rosterVariance(ctx, p)).filter(isRosterException).length;
}

// ── 6948727a · My Roster — the employee's OWN roster, read only ────────────────────────────────────

/** One shift as My Roster prints it: enough for a chip, a time range and a planned-hours figure. */
export type MyRosterShift = {
  id: string;
  /** `shiftCodeOf` — the code, falling back to the name, never blank (a blank chip reads as "not scheduled"). */
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  /** Net scheduled minutes: the shift's own override, else span − break with its Normal-Hours Rounding. */
  workingMinutes: number;
  color: string | null;
};

/** One date on My Roster. */
export type MyRosterDay = {
  date: string;
  /**
   * Resolved by `resolveRosterCell` — THE SAME FUNCTION the supervisor's grid, the roster export and the
   * upload analyzer resolve with. The plan's binding sentence is "Each date is worked out by the same rule
   * the supervisor's roster uses, so the two screens cannot disagree", and a second resolver here is
   * precisely how that promise gets broken six months from now.
   */
  cell: ResolvedCell;
  /** The shift behind `cell` when there is one; null for rest / off / none. */
  shift: MyRosterShift | null;
  /** What this date contributes to Planned hours. 0 unless the date is a working one. */
  plannedMinutes: number;
  /**
   * The supervisor's note on this date, read off the roster row rather than derived.
   *
   * Never present on a GHOSTED (usual) or OFF date: neither has a row to carry one. And in today's
   * product it is in practice only ever present on a REST DAY, because `setRestDay` is the ONLY writer
   * of `roster_assignment.note` in the kernel — `assignShift` does not take one.
   *
   * ⚠️ OBSERVATION, pre-existing and deliberately NOT changed here: `assignShift`'s upsert sets
   * shiftId / isRestDay / updatedAt and does not clear `note`, so a date that was a noted rest day and
   * is later given a shift keeps the old note. This screen renders whatever the row says, which is what
   * every other roster surface does; hiding it here would mean My Roster silently withholding a note
   * the supervisor can still see — the disagreement this whole design exists to prevent. Clearing it
   * belongs in `assignShift`, is a kernel WRITE change, and is not this item's to make.
   */
  note: string | null;
};

export type MyRosterView = {
  /** The caller's OWN employment. There is no parameter that could make this anybody else's — see below. */
  employmentId: string;
  name: string;
  employeeCode: string | null;
  position: string | null;
  /**
   * The caller's administrative manager, WHEN THE CALLER MAY SEE THAT EMPLOYMENT (RLS decides, not this
   * function). For a plain employee `app.can_see_person` does not admit their own manager's row, so this
   * is normally NULL and the screen says "your supervisor" rather than inventing a name. Widening RLS so
   * an employee may read their supervisor's name is a deliberate visibility decision and is NOT made here.
   */
  managerName: string | null;
  from: string;
  to: string;
  days: MyRosterDay[];
  /** The distinct shifts actually on screen, for the legend. Ordered by code, so the legend is stable. */
  legend: MyRosterShift[];
  /** Dates the employee is scheduled to work (rostered OR usual) — "Work days". */
  workDays: number;
  /** Of those, the ones the supervisor actually rostered — "Rostered by supervisor". */
  rosteredDays: number;
  /** Dates carrying an explicit rest day — "Rest days". `off` (not scheduled) is NOT a rest day. */
  restDays: number;
  /** Σ `plannedMinutes` — "Planned hours". */
  plannedMinutes: number;
  /** MAX(roster_assignment.updated_at) inside the window; NULL when the supervisor has rostered nothing. */
  lastUpdatedAt: Date | null;
};

/**
 * MY ROSTER (item 6948727a) — what the caller is rostered for, and NOBODY ELSE.
 *
 * ── THE DATA FENCE IS STRUCTURAL, NOT A COMPARISON ──────────────────────────────────────────────────
 * This function TAKES NO EMPLOYMENT ID. The employment is resolved from the session by `myEmployment`,
 * which keys on `ctx.personId`, so there is no argument a caller could pass — and no query string a page
 * could forward — that would make it return somebody else's roster. It is the r287 fence
 * (app/attendance/my-records/page.tsx) applied to the roster, and it is deliberately not "validate the
 * id you were given": a comparison is a thing to get wrong, an absent parameter is not.
 *
 * ⚠️ RLS WOULD NOT STOP A MANAGER HERE, which is exactly why the fence is in the service.
 * `roster_assignment`'s policy is `app.can_see_employment(employment_id)` (migration 0075), and
 * `can_see_employment` (0109) admits self, the RECURSIVE ADMINISTRATIVE MANAGER CHAIN and the HOD
 * department tree. A supervisor asking this read for a subordinate's id would therefore be answered by
 * the database. Nothing below asks. test/my-roster.test.ts proves both halves: that RLS hands the
 * manager the subordinate's rows through `rosterForRange`, and that this function still returns the
 * manager their own.
 *
 * Read only. No write, no DomainEvent, no server action: this screen never gets a create, edit, clear or
 * import control (the approved plan says so in as many words).
 */
export async function myRosterWindow(
  ctx: SessionContext,
  p: { from: string; to: string },
): Promise<MyRosterView | null> {
  // FIRST, before any query: an over-wide window must cost nothing to refuse, and the employee's address
  // bar can reach this read exactly as the operator's can (see assertRosterWindow's note).
  assertRosterWindow(p.from, p.to);
  const me = await myEmployment(ctx);
  if (!me) return null;

  const [roster, usualRows] = await Promise.all([
    rosterForRange(ctx, { employmentIds: [me.employmentId], from: p.from, to: p.to }),
    usualShiftsFor(ctx, [me.employmentId]),
  ]);

  return withTenant(ctx, async (tx) => {
    const usualRow = usualRows[0] ?? null;
    const usual: UsualShift | null = usualRow ? { shiftId: usualRow.shiftId, pattern: usualRow.pattern } : null;

    // Only the shifts this window actually references — the legend names what is on screen, and a
    // tenant-wide shift list would serialise every template the company has ever authored into the
    // payload of a page that draws at most a handful.
    const wantedIds = [...new Set([...roster.map((r) => r.shiftId), usualRow?.shiftId].filter((v): v is string => !!v))];
    const shiftRows = wantedIds.length
      ? await tx
          .select({
            id: shift.id,
            code: shift.code,
            name: shift.name,
            startTime: shift.startTime,
            endTime: shift.endTime,
            breakMinutes: shift.breakMinutes,
            normalMinutesOverride: shift.normalMinutesOverride,
            roundingMinutes: shift.normalHoursRoundingMinutes,
            color: shift.color,
          })
          .from(shift)
          .where(inArray(shift.id, wantedIds))
          .orderBy(asc(shift.code), asc(shift.name))
      : [];

    const shifts = new Map<string, MyRosterShift>(
      shiftRows.map((s) => [
        s.id,
        {
          id: s.id,
          code: shiftCodeOf(s),
          name: s.name,
          startTime: s.startTime,
          endTime: s.endTime,
          breakMinutes: s.breakMinutes,
          // The SHARED figure (core/attendance.ts), never a second expression: the hours this screen
          // promises and the hours the engine schedules have to be the same number.
          workingMinutes:
            s.normalMinutesOverride ??
            netScheduledMinutes(
              s.startTime,
              s.endTime,
              shiftCrossesMidnight(s.startTime, s.endTime),
              s.breakMinutes,
              s.roundingMinutes,
            ),
          color: s.color,
        },
      ]),
    );

    const assigned = new Map<string, (typeof roster)[number]>(roster.map((r) => [r.shiftDate, r]));

    const days: MyRosterDay[] = datesBetween(p.from, p.to).map((date) => {
      const row = assigned.get(date);
      const cellIn: AssignedCell = row ? (row.isRestDay ? { kind: 'rest' } : row.shiftId ? { kind: 'shift', shiftId: row.shiftId } : null) : null;
      const cell = resolveRosterCell(date, cellIn, usual);
      const sh = cell.kind === 'shift' || cell.kind === 'usual' ? (shifts.get(cell.shiftId) ?? null) : null;
      return {
        date,
        cell,
        shift: sh,
        plannedMinutes: sh ? sh.workingMinutes : 0,
        // Only a rostered date can carry a note; a ghosted date has no row behind it.
        note: row?.note ?? null,
      };
    });

    const onScreen = [...new Set(days.map((d) => d.shift?.id).filter((v): v is string => !!v))];
    const legend = onScreen
      .map((id) => shifts.get(id)!)
      .sort((a, b) => a.code.localeCompare(b.code));

    // MAX over the window's rows, in JS rather than SQL: `roster` is already in hand and is at most 92
    // rows (ROSTER_MAX_RANGE_DAYS), so a second round trip would buy nothing.
    const stamps = roster.map((r) => r.updatedAt).filter((v): v is Date => v instanceof Date);
    const lastUpdatedAt = stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;

    return {
      employmentId: me.employmentId,
      name: me.name,
      employeeCode: me.employeeCode,
      position: me.position,
      managerName: await administrativeManagerNameTx(tx, me.employmentId, todayInKualaLumpur()),
      from: p.from,
      to: p.to,
      days,
      legend,
      workDays: days.filter((d) => cellIsWorking(d.cell)).length,
      rosteredDays: days.filter((d) => d.cell.kind === 'shift').length,
      restDays: days.filter((d) => d.cell.kind === 'rest').length,
      plannedMinutes: days.reduce((n, d) => n + d.plannedMinutes, 0),
      lastUpdatedAt,
    };
  });
}

/**
 * The caller's administrative manager's NAME, or null.
 *
 * Null covers three different situations on purpose — no line, a superseded line, and a line whose
 * manager this session may not read — because the screen does the same thing in all three: it says
 * "your supervisor" instead of a name. Distinguishing them would only let the page print a confident
 * sentence about a person it cannot see. `administrative` only: a functional, project or dotted line is
 * not who plans your roster, and `delegate` is an approver stand-in rather than a supervisor at all.
 */
async function administrativeManagerNameTx(tx: Tx, employmentId: string, asOf: string): Promise<string | null> {
  const rows = await tx
    .select({ validFrom: reportingLine.validFrom, validTo: reportingLine.validTo, managerEmploymentId: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.supersededAt),
      ),
    )
    // ORDER BY, because the line in force is picked off the END of this list and an unordered query
    // would pick an arbitrary one (CLAUDE.md §8 — an asserted array from a query needs an ORDER BY).
    .orderBy(asc(reportingLine.validFrom));
  const line = rows.filter((r) => r.validFrom <= asOf && (r.validTo == null || r.validTo > asOf)).pop();
  if (!line) return null;
  const [m] = await tx
    .select({ name: person.fullName })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(eq(employment.id, line.managerEmploymentId))
    .limit(1);
  return m?.name ?? null;
}
