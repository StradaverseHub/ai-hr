/**
 * 7c834696 POINT 3 — the working behind one day's Lateness, Early Out and Overtime figures.
 *
 * WHY THIS IS STORED RATHER THAN RECOMPUTED, which is the whole design decision.
 *
 * The approved plan's build note said the breakdown "depends on nothing new being stored" and should be
 * emitted from deriveAttendance. Both halves cannot hold: deriveAttendance runs at WRITE time (check-in,
 * check-out, correction approval, punch import), and the Records screens read rows written weeks ago.
 * Explaining a historical row therefore means either storing a trace or reconstructing one at read time.
 *
 * Reconstruction is not safe here. Shifts, rosters and attendance rules are all effective-dated AND
 * editable in place — a rule's OT bands can be re-typed without moving any effective date. A day computed
 * in June under one band ladder, re-explained in August against the edited ladder, would print working
 * that does not add up to the number beside it, on the one screen whose entire purpose is auditability.
 *
 * core/pcb-explain.ts settled this pattern already and says so in its own header: "PURE, AND DELIBERATELY
 * INCAPABLE OF RECOMPUTING. A panel that re-derived the figure could disagree with the figure it claims
 * to explain, which is worse than no panel." It explains from a stored snapshot and reports which source
 * it used. This is the same shape: the engine stamps the trace as it computes, and a day with no trace
 * says so instead of guessing.
 *
 * THE TRACE IS DATA, NOT PROSE. Every field is a number, a boolean or an enum key. Nothing here is a
 * sentence. The hover renders it through next-intl like every other screen, so the working reads in the
 * user's language — a trace of English strings would have been a monolingual panel in a six-locale
 * product, and unfixable afterwards without a backfill.
 *
 * MINUTES ARE "MINUTES FROM MIDNIGHT OF THE ATTENDANCE DATE", on the shift's own anchored timeline —
 * the same convention core/attendance-calc.ts uses, so a cross-midnight shift needs no special case and a
 * 00:30 arrival on a 22:00 shift reads as 2.5h late rather than 21.5h early.
 */
/*
 * A LEAF: this module imports NOTHING, and that is deliberate — db/schema.ts types the jsonb column with
 * `AttendanceTraceV1`, and db/schema.ts imports nothing from core/ today. Importing DayType from
 * core/attendance.ts (which imports db/schema.ts) would close a cycle. `import type` is erased at
 * runtime so it could not bite today, but core/movement-kinds.ts was extracted for exactly this reason
 * and records the failure mode: "a `const` array that is `undefined` at module-init time depending on
 * which file was loaded first". The two shapes below are re-declared rather than imported, and
 * test/attendance-trace-shape.test.ts asserts they still match their originals.
 */

/** Structurally identical to core/attendance.ts `DayType`. Pinned by test. */
export type TraceDayType = 'workday' | 'rest_day' | 'holiday';

/** Structurally identical to core/attendance-calc.ts `OtSplit`. Pinned by test. */
export type TraceOtSplit = {
  flat: number;
  ot00: number;
  ot10: number;
  ot15: number;
  ot20: number;
  ot30: number;
};

/** Bump when a field's MEANING changes. A reader that does not recognise the version reports
 *  `unavailable` rather than mis-explaining — an old trace read under new rules is exactly the failure
 *  this whole module exists to prevent. */
export const ATTENDANCE_TRACE_VERSION = 1 as const;

/** How the day's schedule was resolved. Mirrors ResolvedSchedule's own `source`. */
export type TraceScheduleSource = 'policy' | 'roster-shift' | 'roster-rest' | 'default-shift' | 'default-shift-rest';

export type LatenessTrace = {
  /** Scheduled start, and the grace window applied on top of it. */
  startAbs: number;
  graceMinutes: number;
  /** startAbs + grace. An arrival at or before this is not late at all. */
  thresholdAbs: number;
  checkInAbs: number;
  /** true ⇒ counted from the scheduled start; false ⇒ from the end of the grace window. */
  includeGrace: boolean;
  minutes: number;
};

export type EarlyOutTrace = {
  endAbs: number;
  graceMinutes: number;
  /** endAbs − grace. A departure at or after this is not early at all. */
  thresholdAbs: number;
  checkOutAbs: number;
  includeGrace: boolean;
  minutes: number;
};

/**
 * The wage deduction a measured lateness / early-out earned.
 *
 * `applies:false` is NOT the same as a zero deduction and the panel must say which. Every rule in the
 * product ships with deductions switched OFF, and they never exist for a date before the rule's
 * switch-on — so "your rule does not deduct" and "your rule deducts, and this day earned none" are
 * different answers to "why was nothing taken off?".
 */
export type DeductionTrace = {
  applies: boolean;
  everyMinutes: number | null;
  deductPerBlock: number | null;
  /** floor(measured / every) — whole blocks only, which is why 25 minutes under "every 15" is one block. */
  blocks: number;
  minutes: number;
};

export type OvertimeTrace = {
  /**
   * Which arithmetic produced the raw figure:
   *  • 'window'     — worked BEYOND the shift's time-out (a resolved shift, no manual override)
   *  • 'duration'   — worked minus normal minutes (company-policy branch, or a manual normal-hours override)
   *  • 'nonWorkday' — every worked minute is overtime (rest day / holiday)
   */
  basis: 'window' | 'duration' | 'nonWorkday';
  /** Normal minutes the day was measured against. Null on 'nonWorkday', which has none. */
  normalMinutes: number | null;
  /** True when normalMinutes came from the shift's manual override rather than its span. */
  normalIsOverride: boolean;
  rawMinutes: number;
  /** Pre-shift minutes, and whether the rule opted to fold them in (applyToEarlyOt). */
  earlyMinutes: number;
  earlyIncluded: boolean;
  /** The per-shift OT rule's shaping, in the order the engine applies it. Null ⇒ no rule on the shift. */
  shiftRule: {
    eligible: boolean;
    minMinutes: number | null;
    dailyCapMinutes: number | null;
    /** After eligibility, minimum block and cap — before rounding. */
    minutesAfter: number;
  } | null;
  /** Band rounding. `applied:false` with equal before/after means a rule with no rounding configured. */
  rounding: { applied: boolean; beforeMinutes: number; afterMinutes: number } | null;
  /** The canonical total. Always equals the sum of `split`. */
  minutes: number;
  split: TraceOtSplit;
};

export type AttendanceTraceV1 = {
  v: typeof ATTENDANCE_TRACE_VERSION;
  schedule: {
    source: TraceScheduleSource;
    dayType: TraceDayType;
    /** Null on a branch with no resolved start/end (a rest day resolved from company policy). */
    startAbs: number | null;
    endAbs: number | null;
    scheduledMinutes: number;
    normalMinutesOverride: number | null;
    crossesMidnight: boolean;
    /** The shift's declared break, and what was actually taken off. */
    breakMinutes: number;
    /**
     * Minutes deducted because the clocking SPANNED a declared break window (b7b886e2). Null means no
     * break windows were declared and the legacy 6-hour cliff decided it instead — a real difference in
     * how the figure was reached, so the panel names it rather than printing the same sentence for both.
     */
    breakSpanned: number | null;
    /** The resolved attendance rule ("Lateness, Early Out & Overtime Settings"). Null ⇒ legacy behaviour. */
    ruleId: string | null;
  };
  punch: {
    inAbs: number;
    /** Null on an open day (checked in, not yet out) — worked and overtime are unknowable then. */
    outAbs: number | null;
    spanMinutes: number | null;
    workedMinutes: number | null;
  };
  /** Null when the concept does not apply to the day at all (no lateness on a rest day, for instance). */
  lateness: LatenessTrace | null;
  latenessDeduction: DeductionTrace | null;
  earlyOut: EarlyOutTrace | null;
  earlyOutDeduction: DeductionTrace | null;
  overtime: OvertimeTrace | null;
};

/** Runtime guard for a value read out of jsonb. Structural, not exhaustive: it proves the version and
 *  the two always-present sections, which is what separates "a trace we wrote" from "anything else". */
export function isAttendanceTrace(v: unknown): v is AttendanceTraceV1 {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<AttendanceTraceV1>;
  return t.v === ATTENDANCE_TRACE_VERSION && !!t.schedule && !!t.punch;
}
