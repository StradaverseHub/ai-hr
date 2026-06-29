/**
 * 2.1.1 Payroll Policy — Monthly "General Settings" typed config + cleanX validation (ADR-0064). This is the
 * ONE blob stored as `payroll_policy.config jsonb`. A NULL config (no policy, inactive policy, or a policy
 * with config=null) and an all-default config BOTH reproduce today's exact payslip numbers — every default
 * here equals the legacy hardcoded behaviour. The default-equals-legacy golden matrix
 * (test/payroll-policy-config.test.ts) proves it across a prorated mid-month hire, an OT-present case, an
 * unpaid-days case, and each rounding mode.
 *
 * Follows the existing cleanDay/cleanBasis pattern (core/payroll-config.ts) and validatePayRule
 * (core/pay-rule.ts): coerce + clamp, NEVER throw on a stray value — a bad value falls back to the safe
 * default so a malformed admin input can never silently corrupt payroll. NOT a versioned discriminated-union
 * framework — it is one concern (the General Settings group).
 *
 * Statutory floors are NON-NEGOTIABLE: a configured OT multiplier is floored at the EA s.60A minimum
 * (1.5× workday) via max(EA-floor, policy). The rest-day half-day threshold and the ORP/26 divisor stay
 * statutory and are NOT user-configurable.
 */
import type {
  LeaveDivisor,
  NegativeNetMode,
  OtDayType,
  PayrollPolicyConfig,
  ProrationDivisor,
  RoundingMode,
} from '../db/schema';

export type { PayrollPolicyConfig };

// EA s.60A(3) statutory minimum workday-OT multiplier. A configured multiplier is floored at this — it can
// be raised (employer generosity) but never dropped below the legal floor.
export const EA_S60A_WORKDAY_OT_FLOOR = 1.5;

const ROUNDING_MODES: RoundingMode[] = ['none', 'up', 'down', 'nearest'];
const PRORATION_DIVISORS: ProrationDivisor[] = ['calendar_month', 'custom_days'];
const OT_DAY_TYPES: OtDayType[] = ['workday', 'rest_day', 'holiday'];
const NEGATIVE_NET_MODES: NegativeNetMode[] = ['retain', 'set_zero'];
const LEAVE_DIVISORS: LeaveDivisor[] = [
  'calendar_month',
  'custom_days',
  'cutoff_days',
  'working_days',
  'custom_hours',
  'custom_minutes',
];

const cleanRounding = (v: unknown): RoundingMode => (ROUNDING_MODES.includes(v as RoundingMode) ? (v as RoundingMode) : 'none');
const cleanProrationDivisor = (v: unknown): ProrationDivisor =>
  PRORATION_DIVISORS.includes(v as ProrationDivisor) ? (v as ProrationDivisor) : 'calendar_month';
const cleanLeaveDivisor = (v: unknown): LeaveDivisor =>
  LEAVE_DIVISORS.includes(v as LeaveDivisor) ? (v as LeaveDivisor) : 'calendar_month';

// `carry_forward` is rejected here (ADR-0064 §1d gated follow-up): any value that is not a known mode (incl.
// 'carry_forward') falls back to 'retain' = today's behaviour.
const cleanNegativeNet = (v: unknown): NegativeNetMode =>
  NEGATIVE_NET_MODES.includes(v as NegativeNetMode) ? (v as NegativeNetMode) : 'retain';

const cleanBool = (v: unknown): boolean => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';

/** A positive integer in [min,max], else undefined (absent ⇒ inherit the legacy default). */
const cleanPosInt = (v: unknown, min: number, max: number): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/** A non-negative finite number, else undefined. */
const cleanNonNegNum = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const cleanDayTypes = (v: unknown): OtDayType[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((x): x is OtDayType => OT_DAY_TYPES.includes(x as OtDayType)))];
  return out.length ? out : undefined;
};

/**
 * Coerce + clamp a raw config blob into a clean PayrollPolicyConfig, dropping every unknown/invalid field so
 * it falls back to its legacy default. Returns `null` when the input is null/undefined/empty (NULL config =
 * today's behaviour) AND when every cleaned sub-group is empty — so a no-op config never bloats the row.
 * NEVER throws.
 */
export function cleanPayrollPolicyConfig(raw: unknown): PayrollPolicyConfig | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const out: PayrollPolicyConfig = {};

  // 1a rounding — only persist a sub-key when it is non-default ('none'), so an all-'none' rounding group is
  // dropped and the row stays byte-identical to a null config.
  const rRaw = (r.rounding ?? {}) as Record<string, unknown>;
  const rounding: NonNullable<PayrollPolicyConfig['rounding']> = {};
  const e = cleanRounding(rRaw.earnings);
  const d = cleanRounding(rRaw.deductions);
  const np = cleanRounding(rRaw.netPay);
  if (e !== 'none') rounding.earnings = e;
  if (d !== 'none') rounding.deductions = d;
  if (np !== 'none') rounding.netPay = np;
  if (Object.keys(rounding).length) out.rounding = rounding;

  // 1b proration — divisor + working-day basis. Only persisted when divisor is non-default OR a basis flag is
  // set, so the legacy calendar_month default drops out.
  const pRaw = (r.proration ?? {}) as Record<string, unknown>;
  const divisor = cleanProrationDivisor(pRaw.divisor);
  const customDays = cleanPosInt(pRaw.customDays, 1, 31);
  const proration: NonNullable<PayrollPolicyConfig['proration']> = {};
  // A 'custom_days' divisor is meaningless without a valid customDays — drop it back to the calendar default
  // (a custom_days divisor with no count would be a silent no-op, so never persist it).
  if (divisor === 'custom_days' && customDays !== undefined) {
    proration.divisor = 'custom_days';
    proration.customDays = customDays;
  }
  if ('includeSaturday' in pRaw) proration.includeSaturday = cleanBool(pRaw.includeSaturday);
  if ('includeSunday' in pRaw) proration.includeSunday = cleanBool(pRaw.includeSunday);
  if ('includeHoliday' in pRaw) proration.includeHoliday = cleanBool(pRaw.includeHoliday);
  if (Object.keys(proration).length) out.proration = proration;

  // 1c salary-increment proration — only persisted when true (false = legacy single-row read).
  if (cleanBool(r.salaryIncrementProration)) out.salaryIncrementProration = true;

  // 1d negative-net — only persisted when non-default ('retain').
  const negativeNet = cleanNegativeNet(r.negativeNet);
  if (negativeNet !== 'retain') out.negativeNet = negativeNet;

  // 1e OT caps — multiplier floored at the EA s.60A minimum.
  const otRaw = (r.overtime ?? {}) as Record<string, unknown>;
  const overtime: NonNullable<PayrollPolicyConfig['overtime']> = {};
  const maxHours = cleanNonNegNum(otRaw.maxHoursPerMonth);
  if (maxHours !== undefined && maxHours > 0) overtime.maxHoursPerMonth = maxHours;
  const maxAmount = cleanNonNegNum(otRaw.maxAmount);
  if (maxAmount !== undefined && maxAmount > 0) overtime.maxAmount = maxAmount;
  const dayTypes = cleanDayTypes(otRaw.eligibleDayTypes);
  // Persist eligibleDayTypes only when it is a PROPER subset (restricting) — all three = no restriction.
  if (dayTypes && dayTypes.length < OT_DAY_TYPES.length) overtime.eligibleDayTypes = dayTypes;
  const mult = cleanNonNegNum(otRaw.multiplier);
  if (mult !== undefined && mult > 0) {
    const floored = Math.max(EA_S60A_WORKDAY_OT_FLOOR, mult); // s.60A floor — never under-pay
    if (floored !== EA_S60A_WORKDAY_OT_FLOOR) overtime.multiplier = floored;
  }
  if (Object.keys(overtime).length) out.overtime = overtime;

  // 1f leave divisors — only persisted when at least one divisor is non-default.
  const lRaw = (r.leave ?? {}) as Record<string, unknown>;
  const leave: NonNullable<PayrollPolicyConfig['leave']> = {};
  const ul = cleanLeaveDivisor(lRaw.unpaidLeaveDivisor);
  const uto = cleanLeaveDivisor(lRaw.unpaidTimeOffDivisor);
  const enc = cleanLeaveDivisor(lRaw.encashmentDivisor);
  if (ul !== 'calendar_month') leave.unpaidLeaveDivisor = ul;
  if (uto !== 'calendar_month') leave.unpaidTimeOffDivisor = uto;
  if (enc !== 'calendar_month') leave.encashmentDivisor = enc;
  const lcd = cleanPosInt(lRaw.customDays, 1, 31);
  if (lcd !== undefined) leave.customDays = lcd;
  const lch = cleanNonNegNum(lRaw.customHours);
  if (lch !== undefined && lch > 0) leave.customHours = lch;
  const lcm = cleanNonNegNum(lRaw.customMinutes);
  if (lcm !== undefined && lcm > 0) leave.customMinutes = lcm;
  if (Object.keys(leave).length) out.leave = leave;

  return Object.keys(out).length ? out : null;
}

// ─────────────────────────── Run-time resolvers (read by core/payroll.ts) ───────────────────────────
// Each takes the (possibly null) config and returns the SAME number the legacy hardcoded path produced when
// the relevant field is absent. They are pure + synchronous — the kernel passes the already-resolved config.

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 1a — apply a config rounding mode to a money amount. 'none'/absent ⇒ exact 2dp (legacy). Mirrors the
 *  kernel's existing `roundAmount` so a component-level and a policy-level rounding never diverge. */
export function applyRounding(n: number, mode: RoundingMode | undefined): number {
  switch (mode) {
    case 'up':
      return Math.ceil(round2(n));
    case 'down':
      return Math.floor(round2(n));
    case 'nearest':
      return Math.round(round2(n));
    default:
      return round2(n);
  }
}

/**
 * 1b — the proration DENOMINATOR (days-in-period basis) for an employment's incomplete-month factor. Default
 * (calendar_month, no config) returns `daysInMonth` exactly as the legacy `prorationFactor` used, so the
 * factor is unchanged. `custom_days` returns the configured fixed divisor (e.g. a 26-working-day basis).
 *
 * The working-day basis flags (includeSaturday/Sunday/Holiday) are passed through to the caller, which counts
 * the ELIGIBLE days employed against a working-day calendar (the kernel resolves the holiday set + roster);
 * here we only resolve the denominator. When no working-day basis is requested the caller counts plain
 * calendar days (legacy).
 */
export function prorationDivisorDays(
  config: PayrollPolicyConfig | null,
  calendarDaysInMonth: number,
): number {
  const p = config?.proration;
  if (!p || p.divisor !== 'custom_days') return calendarDaysInMonth;
  return p.customDays && p.customDays > 0 ? p.customDays : calendarDaysInMonth;
}

/** True when the proration should count WORKING days (a basis flag is present) rather than plain calendar
 *  days. Absent/empty ⇒ false (legacy calendar-day counting). */
export function usesWorkingDayProration(config: PayrollPolicyConfig | null): boolean {
  const p = config?.proration;
  if (!p) return false;
  return (
    p.includeSaturday !== undefined ||
    p.includeSunday !== undefined ||
    p.includeHoliday !== undefined
  );
}

/** The ISO-weekday roster (1=Mon … 7=Sun) implied by the working-day basis flags, defaulting to Mon–Fri.
 *  includeSaturday adds 6, includeSunday adds 7. */
export function workingDayRoster(config: PayrollPolicyConfig | null): number[] {
  const p = config?.proration;
  const roster = [1, 2, 3, 4, 5];
  if (p?.includeSaturday) roster.push(6);
  if (p?.includeSunday) roster.push(7);
  return roster;
}

/** 1f — the divisor DAYS used to value one unpaid-leave day, given the policy config + the calendar facts of
 *  the period. Default (calendar_month/absent) returns `calendarDaysInMonth` so the legacy
 *  `basicRaw / dim` ORP deduction is reproduced exactly. */
export function leaveDivisorDays(
  divisor: LeaveDivisor | undefined,
  config: PayrollPolicyConfig | null,
  facts: { calendarDaysInMonth: number; cutoffDays: number; workingDays: number },
): number {
  switch (divisor) {
    case 'custom_days':
      return config?.leave?.customDays && config.leave.customDays > 0
        ? config.leave.customDays
        : facts.calendarDaysInMonth;
    case 'cutoff_days':
      return facts.cutoffDays > 0 ? facts.cutoffDays : facts.calendarDaysInMonth;
    case 'working_days':
      return facts.workingDays > 0 ? facts.workingDays : facts.calendarDaysInMonth;
    case 'calendar_month':
    default:
      // custom_hours / custom_minutes resolve to a calendar-day divisor for the per-DAY deduction the kernel
      // computes (those modes value per hour/minute, a Daily/Hourly concern deferred to later builds); for the
      // Monthly path they conservatively fall back to the calendar-month divisor (no number change).
      return facts.calendarDaysInMonth;
  }
}

/**
 * 1e — cap a prefilled OT figure per the policy config: floor the eligible day types, cap total hours, cap
 * total amount. Returns the (possibly reduced) total. Default (no config) returns `total` unchanged. The
 * per-day statutory rates inside `overtimePay` are untouched — this is a POST-HOC wrapper around the engine.
 *
 *  - `eligibleDayTypes` (when a proper subset) zeroes the non-eligible buckets BEFORE the caps apply.
 *  - `maxHoursPerMonth` scales the surviving total down proportionally if worked hours exceed the cap.
 *  - `maxAmount` is a hard ceiling on the final figure.
 * The configured `multiplier` (already floored at s.60A) is NOT re-applied here — the engine emits the
 * statutory 1.5× workday leg; a higher policy multiplier scales the workday bucket up by
 * `multiplier / 1.5`.
 */
export function applyOvertimeCaps(
  config: PayrollPolicyConfig | null,
  parts: { workday: number; restDay: number; holiday: number; workedOtHours: number },
): number {
  const ot = config?.overtime;
  let workday = parts.workday;
  let restDay = parts.restDay;
  let holiday = parts.holiday;

  if (ot?.eligibleDayTypes && ot.eligibleDayTypes.length < 3) {
    if (!ot.eligibleDayTypes.includes('workday')) workday = 0;
    if (!ot.eligibleDayTypes.includes('rest_day')) restDay = 0;
    if (!ot.eligibleDayTypes.includes('holiday')) holiday = 0;
  }

  // A configured workday multiplier (already floored at 1.5) scales the workday leg up proportionally — the
  // engine paid the statutory 1.5×, so multiply by multiplier/1.5 to reach the policy rate.
  if (ot?.multiplier && ot.multiplier > EA_S60A_WORKDAY_OT_FLOOR) {
    workday = round2(workday * (ot.multiplier / EA_S60A_WORKDAY_OT_FLOOR));
  }

  let total = round2(workday + restDay + holiday);

  // maxHoursPerMonth: proportional scale-down when worked OT hours exceed the cap.
  if (ot?.maxHoursPerMonth && ot.maxHoursPerMonth > 0 && parts.workedOtHours > ot.maxHoursPerMonth) {
    total = round2(total * (ot.maxHoursPerMonth / parts.workedOtHours));
  }
  // maxAmount: hard RM ceiling.
  if (ot?.maxAmount && ot.maxAmount > 0 && total > ot.maxAmount) {
    total = round2(ot.maxAmount);
  }
  return total;
}
