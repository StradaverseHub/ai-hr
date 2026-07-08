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
  CutOffMode,
  LeaveDivisor,
  NegativeNetMode,
  OtDayType,
  PayrollPolicyConfig,
  PayslipRelease,
  PayslipReleaseMode,
  ProrationDivisor,
  ProrationSettings,
  RoundingMode,
} from '../db/schema';

export type { PayrollPolicyConfig, PayslipRelease };

// UUID v4-ish shape — the OT exceed-handling component id + company-default policy id are validated against
// this shape before being persisted (a malformed id is dropped, not stored).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanUuid = (v: unknown): string | undefined =>
  typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : undefined;

// EA s.60A(3) statutory minimum workday-OT multiplier. A configured multiplier is floored at this — it can
// be raised (employer generosity) but never dropped below the legal floor.
export const EA_S60A_WORKDAY_OT_FLOOR = 1.5;

// 2.1.4 (Custom period) — the inclusive anchor-day range for a custom cut-off window. Capped at 28 (not
// 29–31) so the window opens on the SAME day-of-month in every calendar month, side-stepping the February /
// 30-day month-length trap. A value outside [1,28] (or a non-custom mode) falls back to the calendar default.
export const CUT_OFF_ANCHOR_MIN = 1;
export const CUT_OFF_ANCHOR_MAX = 28;

const ROUNDING_MODES: RoundingMode[] = ['none', 'up', 'down', 'nearest'];
const PRORATION_DIVISORS: ProrationDivisor[] = ['calendar_month', 'custom_days'];
const OT_DAY_TYPES: OtDayType[] = ['workday', 'rest_day', 'holiday'];
const NEGATIVE_NET_MODES: NegativeNetMode[] = ['retain', 'set_zero', 'carry_forward'];
const LEAVE_DIVISORS: LeaveDivisor[] = [
  'calendar_month',
  'custom_days',
  'cutoff_days',
  'working_days',
  'custom_hours',
  'custom_minutes',
];

const CUT_OFF_MODES: CutOffMode[] = ['calendar', 'custom'];
const cleanCutOffMode = (v: unknown): CutOffMode => (CUT_OFF_MODES.includes(v as CutOffMode) ? (v as CutOffMode) : 'calendar');

const cleanRounding = (v: unknown): RoundingMode => (ROUNDING_MODES.includes(v as RoundingMode) ? (v as RoundingMode) : 'none');
const cleanProrationDivisor = (v: unknown): ProrationDivisor =>
  PRORATION_DIVISORS.includes(v as ProrationDivisor) ? (v as ProrationDivisor) : 'calendar_month';
const cleanLeaveDivisor = (v: unknown): LeaveDivisor =>
  LEAVE_DIVISORS.includes(v as LeaveDivisor) ? (v as LeaveDivisor) : 'calendar_month';

// f3148da1 Step 2 — 'retain' | 'set_zero' | 'carry_forward' are all accepted; any unknown value falls back to
// 'retain' (today's behaviour). 'carry_forward' holds a negative net at 0 this cycle and recovers it next cycle.
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

/**
 * f3148da1 Step 3 — coerce + clamp ONE proration formula (divisor + working-day basis). Returns null when it
 * collapses to the calendar-month default (byte-identical). Used for the shared `proration` and both per-event
 * overrides (`prorationHire` / `prorationResign`). A 'custom_days' divisor without a valid 1..31 customDays is
 * a silent no-op ⇒ dropped. Working-day basis flags are keyed off PRESENCE (the kernel switches to working-day
 * counting when any flag is set), so they are only carried when the raw object actually contains them.
 */
function cleanProrationSettings(raw: unknown): ProrationSettings | null {
  if (raw == null || typeof raw !== 'object') return null;
  const pRaw = raw as Record<string, unknown>;
  const divisor = cleanProrationDivisor(pRaw.divisor);
  const customDays = cleanPosInt(pRaw.customDays, 1, 31);
  const out: ProrationSettings = {};
  if (divisor === 'custom_days' && customDays !== undefined) {
    out.divisor = 'custom_days';
    out.customDays = customDays;
  }
  if ('includeSaturday' in pRaw) out.includeSaturday = cleanBool(pRaw.includeSaturday);
  if ('includeSunday' in pRaw) out.includeSunday = cleanBool(pRaw.includeSunday);
  if ('includeHoliday' in pRaw) out.includeHoliday = cleanBool(pRaw.includeHoliday);
  return Object.keys(out).length ? out : null;
}

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
  // set, so the legacy calendar_month default drops out. f3148da1 Step 3: the same cleaner also validates the
  // per-event overrides (prorationHire / prorationResign).
  const proration = cleanProrationSettings(r.proration);
  if (proration) out.proration = proration;
  const prorationHire = cleanProrationSettings(r.prorationHire);
  if (prorationHire) out.prorationHire = prorationHire;
  const prorationResign = cleanProrationSettings(r.prorationResign);
  if (prorationResign) out.prorationResign = prorationResign;

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
  // Step 4 (f3148da1) — exceed handling. Only 'convert' is a real action, and only with a valid UUID component
  // id (an absent/blank action, or a convert without a UUID, drops back to today's cap-and-drop = byte-identical).
  const ehRaw = (otRaw.exceedHandling ?? {}) as Record<string, unknown>;
  if (ehRaw.action === 'convert') {
    const componentId = cleanUuid(ehRaw.componentId);
    if (componentId) overtime.exceedHandling = { action: 'convert', componentId };
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

  // 2.1.4 (Custom period) — the cut-off WINDOW. Only persisted when mode='custom' AND anchorDay is a valid
  // 1..28 integer; a 'calendar' mode (or a custom mode missing/with an out-of-range anchorDay) is the legacy
  // default and drops out, so a non-custom config stays byte-identical to NULL. NEVER throws (clamp-not-throw):
  // an out-of-range anchorDay simply falls back to the calendar default rather than corrupting the row.
  const coRaw = (r.cutOff ?? {}) as Record<string, unknown>;
  const cutOffMode = cleanCutOffMode(coRaw.mode);
  if (cutOffMode === 'custom') {
    const anchorDay = cleanPosInt(coRaw.anchorDay, CUT_OFF_ANCHOR_MIN, CUT_OFF_ANCHOR_MAX);
    if (anchorDay !== undefined) out.cutOff = { mode: 'custom', anchorDay };
  }

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
  p: ProrationSettings | null | undefined,
  calendarDaysInMonth: number,
): number {
  if (!p || p.divisor !== 'custom_days') return calendarDaysInMonth;
  return p.customDays && p.customDays > 0 ? p.customDays : calendarDaysInMonth;
}

/** True when the proration should count WORKING days (a basis flag is present) rather than plain calendar
 *  days. Absent/empty ⇒ false (legacy calendar-day counting). */
export function usesWorkingDayProration(p: ProrationSettings | null | undefined): boolean {
  if (!p) return false;
  return (
    p.includeSaturday !== undefined ||
    p.includeSunday !== undefined ||
    p.includeHoliday !== undefined
  );
}

/** The ISO-weekday roster (1=Mon … 7=Sun) implied by the working-day basis flags, defaulting to Mon–Fri.
 *  includeSaturday adds 6, includeSunday adds 7. */
export function workingDayRoster(p: ProrationSettings | null | undefined): number[] {
  const roster = [1, 2, 3, 4, 5];
  if (p?.includeSaturday) roster.push(6);
  if (p?.includeSunday) roster.push(7);
  return roster;
}

/**
 * f3148da1 Step 3 — resolve the effective proration formula for one employee event. A RESIGNED partial month
 * (terminated mid-period) uses `prorationResign`; a NEW-HIRE partial month uses `prorationHire`; each falls
 * back to the shared `proration` when its override is absent. A full month uses `proration` (the factor is 1
 * regardless, so the choice is inert). Resignation takes precedence when an employee is both hired AND
 * terminated within the same period (the leaving event governs the final pay).
 */
export function resolveProrationSettings(
  config: PayrollPolicyConfig | null,
  ev: { isHire: boolean; isResign: boolean },
): ProrationSettings | undefined {
  if (ev.isResign && config?.prorationResign) return config.prorationResign;
  if (ev.isHire && config?.prorationHire) return config.prorationHire;
  return config?.proration;
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
  return applyOvertimeCapsDetailed(config, parts).capped;
}

/**
 * Same cap logic as {@link applyOvertimeCaps} but also returns the multiplier-adjusted PRE-cap total, so the
 * caller can compute the excess (preCap − capped) the caps removed. Step 4 (f3148da1) redirects that excess
 * onto a chosen pay item when the policy configures `overtime.exceedHandling.action='convert'`. `excess` is the
 * money the HOUR/AMOUNT caps cut off — eligible-day-type filtering + the multiplier re-rating are applied to
 * BOTH figures first, so a day-type restriction is never treated as an "excess" to reroute (it is a genuine
 * exclusion, not a cap). Default (no config) ⇒ capped === preCap ⇒ excess 0.
 */
export function applyOvertimeCapsDetailed(
  config: PayrollPolicyConfig | null,
  parts: { workday: number; restDay: number; holiday: number; workedOtHours: number },
): { capped: number; preCap: number; excess: number } {
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

  // The eligible + multiplier-adjusted figure BEFORE the hour/amount caps — the reference the excess is measured against.
  const preCap = round2(workday + restDay + holiday);
  let total = preCap;

  // maxHoursPerMonth: proportional scale-down when worked OT hours exceed the cap.
  if (ot?.maxHoursPerMonth && ot.maxHoursPerMonth > 0 && parts.workedOtHours > ot.maxHoursPerMonth) {
    total = round2(total * (ot.maxHoursPerMonth / parts.workedOtHours));
  }
  // maxAmount: hard RM ceiling.
  if (ot?.maxAmount && ot.maxAmount > 0 && total > ot.maxAmount) {
    total = round2(ot.maxAmount);
  }
  return { capped: total, preCap, excess: Math.max(0, round2(preCap - total)) };
}

// ─────────────────────────── Step 6: payslip release (f3148da1) ───────────────────────────

const PAYSLIP_RELEASE_MODES: PayslipReleaseMode[] = ['immediate', 'fixed_day', 'relative'];

/**
 * Coerce + clamp a raw payslip-release blob into a clean PayslipRelease, or `null` when it is empty / equals the
 * legacy default (mode='immediate'). NEVER throws (clamp-not-throw). day ∈ 1..31 (fixed_day); offsetDays ∈
 * -15..15 (relative). A mode missing its parameter falls back to 'immediate' (so a half-filled form is a safe
 * no-op = today's behaviour).
 */
export function cleanPayslipRelease(raw: unknown): PayslipRelease | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mode = PAYSLIP_RELEASE_MODES.includes(r.mode as PayslipReleaseMode) ? (r.mode as PayslipReleaseMode) : 'immediate';
  if (mode === 'fixed_day') {
    const day = cleanPosInt(r.day, 1, 31);
    return day !== undefined ? { mode: 'fixed_day', day } : null;
  }
  if (mode === 'relative') {
    if (r.offsetDays === null || r.offsetDays === undefined || r.offsetDays === '') return null;
    const n = Math.trunc(Number(r.offsetDays));
    const offsetDays = Number.isFinite(n) ? Math.max(-15, Math.min(15, n)) : undefined;
    return offsetDays !== undefined ? { mode: 'relative', offsetDays } : null;
  }
  return null; // 'immediate' = default ⇒ store NULL
}

/** Days in a Gregorian month (1..12). */
function daysInMonthUTC(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * The instant a payslip becomes visible in ESS, given the batch close instant, the pay-period ('YYYY-MM'), the
 * company pay-day (1..31 or null=month-end), and the release config. Pure + deterministic (UTC-day anchored):
 *  - null cfg / mode='immediate' ⇒ `closedAt` (today's behaviour).
 *  - 'fixed_day' ⇒ `day` of the month AFTER the pay-period month (payday convention), clamped to month length.
 *  - 'relative' ⇒ the company pay-day anchor (payDay of the month after the pay period; null ⇒ month-end) ± offsetDays.
 * The result is NEVER earlier than `closedAt` (a payslip cannot be released before its batch is finalized). When
 * `closedAt` is null (legacy batch) the batch is treated as ALREADY released (returns null = no gate).
 */
export function payslipReleaseAt(
  closedAt: Date | null,
  payPeriod: string,
  payDay: number | null,
  cfg: PayslipRelease | null,
): Date | null {
  if (closedAt == null) return null; // legacy / not-yet-closed handled by caller; null ⇒ released
  const mode = cfg?.mode ?? 'immediate';
  if (mode === 'immediate') return closedAt;

  const [y, m] = payPeriod.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return closedAt;
  // Payday convention: salaries for month M are paid in month M+1.
  const payYear = m === 12 ? y + 1 : y;
  const payMonth = m === 12 ? 1 : m + 1; // 1..12
  const dim = daysInMonthUTC(payYear, payMonth);

  let anchorDay: number;
  if (mode === 'fixed_day') {
    anchorDay = Math.min(Math.max(1, cfg?.day ?? 1), dim);
  } else {
    // relative: anchor on the company pay-day (null = month-end), then apply the ± offset (may cross months).
    anchorDay = payDay != null ? Math.min(Math.max(1, payDay), dim) : dim;
  }
  const base = Date.UTC(payYear, payMonth - 1, anchorDay);
  const offset = mode === 'relative' ? (cfg?.offsetDays ?? 0) : 0;
  const candidate = new Date(base + offset * 24 * 60 * 60 * 1000);
  // Never before close.
  return candidate.getTime() > closedAt.getTime() ? candidate : closedAt;
}
