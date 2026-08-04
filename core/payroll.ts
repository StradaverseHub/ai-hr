/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  PAYROLL_PERMISSION_DEFAULTS,
  decidePayrollPermission,
  type PayrollPermissionKey,
} from '../lib/payroll-permissions';
import { encashableDaysForEmployment } from './leave-encashment';
import { packFor } from '../localization/registry';
import { assertStatutory } from './company-tier';
import { toCsv } from '../lib/csv';
import {
  assignment,
  attendance,
  claimRequest,
  company,
  companyPayrollConfig,
  companyStatutoryMy,
  compensation,
  domainEvent,
  employeeLoan,
  employeeStatutoryMy,
  employment,
  employmentPayComponent,
  loanRepayment,
  payComponent,
  payrollBatchComponent,
  leaveLedger,
  leaveRequest,
  leaveRequestDate,
  leaveType,
  payPeriod,
  payrollBatch,
  payrollEmployeeResultHistory,
  payrollIndividualTxn,
  payrollInput,
  payrollPermissionGrant,
  payrollPolicy,
  payrollReprocessJob,
  payrollStatusHistory,
  payrollStepUpChallenge,
  payslip,
  person,
  rosterAssignment,
  shift,
  statutoryReport,
  tp1Relief,
} from '../db/schema';
import { setPayrollBatchComponent } from './pay-components';
import { cp38ForPeriod } from './cp38';
import { applyLoansForBatch } from './loans';
import { warnIfHolidaysIncomplete, holidayDatesFor, type HolidayCompletenessWarning } from './holidays';
import type { ShiftDifferential, PayRule, PayrollPolicyConfig } from '../db/schema';
import { resolvePayComponentSet, type PayRuleScope } from './pay-rule';
// Feedback 3c473773 — the payslip-box vocabulary. PRESENTATION ONLY: nothing imported here reaches a
// statutory base, a stored payslip column, or any EA/CP39/KWSP/PERKESO grouping.
import { defaultCategoryOfBucket, resolveDisplayCategory, type PayDisplayCategory } from './pay-display-category';
import { resolveAssignedPolicy } from './payroll-policy';
import {
  applyOvertimeCaps,
  applyOvertimeCapsDetailed,
  applyRounding,
  type CompanyCutOffConfig,
  cutOffWindowFor,
  disburseNetAcrossCycles,
  encashmentDivisorDays,
  ENCASHMENT_ORP_DIVISOR,
  leaveDivisorDays,
  unpaidTimeOffDailyRate,
  payrollFrequencyOf,
  payrollScheduleFor,
  payslipReleaseAt,
  prorationDivisorDays,
  resolveProrationSettings,
  usesWorkingDayProration,
  workingDayRoster,
} from './payroll-policy-config';
import type { CutOffType } from '../db/schema';
import { ModuleNotEnabledError, SettingNotEnabledError, isModuleEnabled, settingEnabled } from './entitlements';

export class BatchNotDraftError extends Error {
  constructor() {
    super('Payslips can only be generated for a draft batch');
    this.name = 'BatchNotDraftError';
  }
}

/** Payroll Reset (feedback a03b2d9b): the batch is not in the one state a reset is defined for.
 *  Draft = nothing to reset; Closed = permanently immutable (0011 trigger is the DB backstop). */
export class BatchNotResettableError extends Error {
  constructor() {
    super('Only a processed payroll process can be reset');
    this.name = 'BatchNotResettableError';
  }
}
/**
 * A blank / whitespace-only reason was supplied to resetProcessedBatch (feedback d1ed1e99). Reverting a
 * processed run to draft zeroizes payslips/totals + unwinds loans/claims — a sensitive, audited action, so
 * the reason is MANDATORY, letting the history log always explain WHY a run was reset. Thrown BEFORE any
 * deletion / status change so nothing is mutated. Mirrors UnlockReasonRequiredError. */
export class ResetReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to revert a processed payroll to draft.');
    this.name = 'ResetReasonRequiredError';
  }
}

/** Pre-processing validation (feedback f1564110, Phase 1): one or more in-scope, period-active
 *  employees have NO current compensation row. Before this check they were SILENTLY dropped from the
 *  run (the generation employee query inner-joins compensation) — now generation fails closed until
 *  the employee profiles are completed (or the batch scope is narrowed to exclude them). */
export class PreProcessBlockedError extends Error {
  constructor(public readonly count: number) {
    super(
      `Payroll cannot be processed: ${count} employee${count === 1 ? '' : 's'} in scope ${count === 1 ? 'has' : 'have'} no current salary record`,
    );
    this.name = 'PreProcessBlockedError';
  }
}

/** A typed pay component that v1 cannot compute correctly (a non-payable/BIK or PCB-only taxable
 *  earning) reached payroll generation. Fail-closed rather than silently under-tax (ADR-0025 §5). */
export class UnsupportedPayComponentError extends Error {
  constructor(code: string) {
    super(`Pay component "${code}" is taxable but not supported in this version (non-payable/PCB-only). Remove it from payroll or wait for a later release.`);
    this.name = 'UnsupportedPayComponentError';
  }
}

/** f1564110 Phase 3 — INDIVIDUAL_TXN_PAY_ENABLED's earning/deduction fold RIDES the typed-pay-component
 *  path (the picked component's statutory flags/rounding drive the treatment). With
 *  TYPED_PAY_COMPONENTS_ENABLED off there is no per-component fold to ride, so a batch that carries
 *  payable one-off rows FAILS CLOSED at generation instead of silently leaving the rows unpaid
 *  (documented dependency — the anchor target and the demo run both flags on). */
export class IndividualTxnRequiresTypedComponentsError extends Error {
  constructor() {
    super('Individual-transaction pay requires typed pay components: this run carries one-off earning/deduction rows but TYPED_PAY_COMPONENTS_ENABLED is off. Enable typed components or remove the rows.');
    this.name = 'IndividualTxnRequiresTypedComponentsError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ADR-0033 — a worked day already banked as time-in-lieu contributes NO overtime. Cash XOR leave.
 *
 * ONE PREDICATE, TWO READERS, and that is the point of hoisting it (review r2). `attendance.otMinutes`
 * is read twice in this file: once to prefill the OT lines (`prefillOvertime`) and once to weight the
 * cross-cycle net disbursement for weekly/bi-weekly runs (`generatePayslips`). Only the first carried
 * this clause, so on those schedules a TOIL-banked day contributed nothing to the OT total while still
 * pulling the employee's net toward the cycle it fell in — two reads of the same column answering
 * different questions about the same day. Sharing the expression makes them agree by construction.
 *
 * `status <> 'lapsed'` because a lapsed accrual was never compensated as leave, so its day is legitimately
 * back on the cash side.
 *
 * UNCONDITIONAL, i.e. NOT behind the `toil` entitlement (finding F15). The clause used to sit inside the
 * TOIL_ENABLED branch, which made the cash-XOR-TOIL invariant itself a feature flag: bank a day while
 * the gate is on, lose the gate, and the same worked day is also paid as overtime cash. Under a
 * deployment flag that took an operator editing .env; under a per-tenant entitlement it becomes an
 * ordinary commercial event — a lapsed trial, a downgrade — silently double-paying everyone who had
 * banked TOIL. With no `toil_accrual` rows the `not exists` is always true, so this is byte-identical
 * for a tenant that never used TOIL.
 *
 * THE INVARIANT IS ONE-DIRECTIONAL, and saying otherwise would be false. This closes TOIL-then-cash. The
 * reverse ordering — prefill a rest day's OT, then bank the same day as TOIL — is not closed here or in
 * `accrueToilTx`, which reads neither `payroll_input` nor `payslip`; see the note at core/toil.ts's
 * duplicate check, which also records why slice 3 is what makes that ordering REACHABLE (the accrual
 * path used to refuse everyone) and why the mirror guard cannot be a `payroll_input` existence test:
 * `overtime_amount` is a per-batch aggregate with no per-day attribution. Closing it is an ADR-0033
 * question about payroll-run state, not an entitlement one; test/toil.ts pins the current behaviour.
 */
const EXCLUDE_TOIL_BANKED_DAYS = sql`not exists (
  select 1 from toil_accrual ta
   where ta.employment_id = ${attendance.employmentId}
     and ta.worked_date = ${attendance.attendanceDate}
     and ta.status <> 'lapsed')`;

// Per-component payable-amount rounding (ADR-0035 1A, #15). 'none' keeps exact 2dp (legacy ⇒ the gated
// path stays byte-identical when no component opts in); up/down/nearest round to a whole ringgit. This
// only shapes a component's own cash amount — statutory contribution rounding is untouched.
const roundAmount = (n: number, method?: string | null): number => {
  switch (method) {
    case 'up':
      return Math.ceil(round2(n));
    case 'down':
      return Math.floor(round2(n));
    case 'nearest':
      return Math.round(round2(n));
    default:
      return round2(n);
  }
};

// Wave 2C (ADR-0024): an additional same-month run's statutory contribution is the INCREMENT of the
// cumulative month — re-run the month with/without this run's additional remuneration and take the
// delta (clamped ≥ 0, §6). Non-contribution fields (version, …) carry from `now`.
const DELTA_KEYS = [
  'epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer', 'pcb', 'pcbBonus',
] as const;
function deltaStat<T extends Record<string, unknown>>(now: T, before: T): T {
  const out = { ...now };
  for (const k of DELTA_KEYS) {
    (out as Record<string, unknown>)[k] = Math.max(0, round2(Number(now[k] ?? 0) - Number(before[k] ?? 0)));
  }
  return out;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Exported for core/payroll-individual-txn.ts (1.2.2) so the dated-ledger date-in-period check derives the
// same month bounds the kernel uses, rather than replicating drifting calendar math.
export function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month1 - 1];
}

/** Payroll Process wizard (1d) — default payment date for a 'YYYY-MM' period from the company's
 *  configured pay day (company_payroll_config.payDay), clamped into the period so e.g. payDay=31 in a
 *  30-day month lands on the 30th. Null payDay ⇒ month-end (same default the pre-wizard '<period>-28'
 *  fallback approximated). Pure/unit-testable — no DB access. */
export function defaultPaymentDate(payPeriod: string, payDay: number | null | undefined): string {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const day = payDay == null ? dim : Math.min(Math.max(1, payDay), dim);
  return `${payPeriod}-${String(day).padStart(2, '0')}`;
}

/**
 * c7fdfcf6 (Payroll Schedule) — the COMPANY-level cut-off schedule for a batch: the company_payroll_config day
 * columns (the fallback tier) plus the company-default payroll policy's config (the policy tier). Loaded ONCE
 * per batch flow; each transaction type's window is then resolved via `cutOffWindowFor`. A company with no
 * config + no default policy resolves every window to the plain calendar month, so the kernel reads that swap
 * their hard-coded `[M-01 … M-end]` for the resolved window stay byte-identical. Derived read ⇒ no DomainEvent.
 */
async function loadBatchCutOffSchedule(
  tx: Tx,
  companyId: string,
): Promise<{ companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null }> {
  const [cpc] = await tx
    .select({
      cutOffDay: companyPayrollConfig.cutOffDay,
      overtimeCutOffDay: companyPayrollConfig.overtimeCutOffDay,
      claimCutOffDay: companyPayrollConfig.claimCutOffDay,
      unpaidLeaveCutOffDay: companyPayrollConfig.unpaidLeaveCutOffDay,
      attendanceCutOffDay: companyPayrollConfig.attendanceCutOffDay,
      defaultPayrollPolicyId: companyPayrollConfig.defaultPayrollPolicyId,
    })
    .from(companyPayrollConfig)
    .where(eq(companyPayrollConfig.companyId, companyId))
    .limit(1);
  const companyCfg: CompanyCutOffConfig | null = cpc
    ? {
        cutOffDay: cpc.cutOffDay,
        overtimeCutOffDay: cpc.overtimeCutOffDay,
        claimCutOffDay: cpc.claimCutOffDay,
        unpaidLeaveCutOffDay: cpc.unpaidLeaveCutOffDay,
        attendanceCutOffDay: cpc.attendanceCutOffDay,
      }
    : null;
  let defaultConfig: PayrollPolicyConfig | null = null;
  if (cpc?.defaultPayrollPolicyId) {
    const [pol] = await tx
      .select({ config: payrollPolicy.config, status: payrollPolicy.status })
      .from(payrollPolicy)
      .where(eq(payrollPolicy.id, cpc.defaultPayrollPolicyId))
      .limit(1);
    if (pol && pol.status === 'active') defaultConfig = (pol.config ?? null) as PayrollPolicyConfig | null;
  }
  return { companyCfg, defaultConfig };
}

/** Resolve the company-level cut-off window for one transaction type of a batch's period, from a loaded
 *  schedule. Byte-identical to `[M-01 … M-end]` when nothing is configured. */
function batchTypeWindow(
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  type: CutOffType,
  payPeriod: string,
): { start: string; end: string } {
  return cutOffWindowFor(type, sched.defaultConfig, sched.companyCfg, payPeriod);
}

/** c7fdfcf6 (Payroll Schedule) — resolve the company-level cut-off window for a transaction TYPE + period in one
 *  call (loads the schedule, then resolves). Exported so sibling prefills (e.g. claims) select transactions by
 *  the same schedule the payroll kernel uses. Calendar month when nothing is configured (byte-identical). */
export async function resolveBatchCutOffWindow(
  tx: Tx,
  companyId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const sched = await loadBatchCutOffSchedule(tx, companyId);
  return batchTypeWindow(sched, type, payPeriod);
}

/**
 * c7fdfcf6 gap-fix (per-employment cut-off) — the UNION of a transaction TYPE's cut-off window across the
 * company-default schedule and EVERY active payroll policy in the company. A prefill query that must bound a
 * single fetch (it discovers which employments have rows only after the fetch) widens to this union, then filters
 * each row down to that employment's OWN policy window. When nothing anywhere shifts the window the union equals
 * the plain calendar month, so an unconfigured company fetches exactly `[M-01 … M-end]` (byte-identical).
 */
async function unionTypeWindow(
  tx: Tx,
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  companyId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const windows = [cutOffWindowFor(type, sched.defaultConfig, sched.companyCfg, payPeriod)];
  const pols = await tx
    .select({ config: payrollPolicy.config })
    .from(payrollPolicy)
    .where(and(eq(payrollPolicy.companyId, companyId), eq(payrollPolicy.status, 'active')));
  for (const pol of pols) {
    windows.push(cutOffWindowFor(type, (pol.config ?? null) as PayrollPolicyConfig | null, sched.companyCfg, payPeriod));
  }
  let start = windows[0].start;
  let end = windows[0].end;
  for (const w of windows) {
    if (w.start < start) start = w.start;
    if (w.end > end) end = w.end;
  }
  return { start, end };
}

/**
 * c7fdfcf6 gap-fix (per-employment cut-off) — resolve one transaction TYPE's cut-off window for a SPECIFIC
 * employment, from its ASSIGNED policy (company-default fallback, via resolveAssignedPolicy) → company column →
 * calendar month. Salary already resolves per-employment in the payslip loop; this extends the SAME per-employee
 * resolution to OT / attendance / leave so employments on different (non-default) policies each get their own
 * window instead of sharing the company default. Cached per employmentId; NEVER throws.
 */
async function employmentTypeWindow(
  tx: Tx,
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  cache: Map<string, { start: string; end: string }>,
  employmentId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const cached = cache.get(employmentId);
  if (cached) return cached;
  const cfg = (await resolveAssignedPolicy(tx, employmentId))?.config ?? null;
  const w = cutOffWindowFor(type, cfg, sched.companyCfg, payPeriod);
  cache.set(employmentId, w);
  return w;
}

/**
 * EA-1955 incomplete-month proration factor for a 'YYYY-MM' wage period: the employee is paid for
 * the calendar days they were employed within the month, over the number of days in that month
 * (Employment Act 1955 s.18A ordinary-rate basis). Returns 1 for a full month, 0 if not employed
 * during the period. Date strings are ISO ('YYYY-MM-DD'), so lexical comparison is chronological.
 *
 * 2.1.1 (ADR-0064): the DENOMINATOR and the eligible-day COUNT are now policy-configurable:
 *  - `divisorDays` overrides the calendar `daysInMonth` denominator (CustomDays divisor). null ⇒ calendar.
 *  - `workingDayBasis` (when supplied) counts only the employee's working days (Sat/Sun/PH include/exclude),
 *    matching the working-day calendar the leave module uses; absent ⇒ plain calendar days (legacy).
 * With NEITHER supplied this reduces EXACTLY to the legacy formula (proven byte-identical by the golden
 * matrix). The min(1,…) clamp is preserved so a CustomDays divisor < calendar days employed can never pay
 * more than a full month.
 */
function prorationFactor(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  opts?: {
    divisorDays?: number;
    workingDayBasis?: { roster: number[]; holidays: Set<string> };
    // c7fdfcf6 (Payroll Schedule) — the SALARY cut-off window overriding the calendar-month bounds. Absent ⇒
    // the calendar month `[M-01 … M-end]` (byte-identical to the legacy formula). When a policy/company cut-off
    // is configured, the join-date / resignation proration is counted against this window (e.g. anchor 26 ⇒
    // [26 of M-1 … 25 of M]) and the denominator is the window's own length in days — delivering the reporter's
    // "salary cut-off determines Basic Salary / Join-Date / Resignation proration".
    window?: { start: string; end: string };
  },
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = opts?.window?.start ?? `${payPeriod}-01`;
  const periodEnd = opts?.window?.end ?? `${payPeriod}-${String(dim).padStart(2, '0')}`;
  // Inclusive length of the window in days (cross-month safe). For the calendar-month default this equals `dim`.
  const windowDays =
    Math.round((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000) + 1;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  const denom = opts?.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : windowDays;
  if (opts?.workingDayBasis) {
    // Count the employee's WORKING days within [start, end] vs the working days across the whole period.
    const { roster, holidays } = opts.workingDayBasis;
    const isWork = (d: string): boolean => {
      const dt = new Date(`${d}T00:00:00Z`);
      const iso = ((dt.getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
      return roster.includes(iso) && !holidays.has(d);
    };
    let eligibleWork = 0;
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
      if (isWork(new Date(t).toISOString().slice(0, 10))) eligibleWork++;
    }
    // Working-day denominator: the configured CustomDays divisor when set, else the period's own working days.
    let denomWork = opts.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : 0;
    if (denomWork === 0) {
      for (let t = Date.parse(`${periodStart}T00:00:00Z`); t <= Date.parse(`${periodEnd}T00:00:00Z`); t += 86_400_000) {
        if (isWork(new Date(t).toISOString().slice(0, 10))) denomWork++;
      }
    }
    if (denomWork === 0) return 0;
    return Math.min(1, eligibleWork / denomWork);
  }
  // Cross-month-safe eligible-day count (inclusive). For a same-month calendar window this is identical to the
  // legacy `end.day − start.day + 1`.
  const eligibleDays =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return Math.min(1, Math.max(0, eligibleDays) / denom);
}

/**
 * 2.1.2 — Eligible WORKING days for a DAILY-rated employee in a wage period. Counts the employee's working
 * days (Mon–Fri roster) within [hiredOn, terminatedOn] ∩ the calendar month, MINUS public holidays. This is a
 * raw day COUNT (not a proration factor): a daily employee is paid `rate × this count`, so the monthly
 * proration path is bypassed entirely. A fully-out-of-window employment (hired after the period, or terminated
 * before it) yields 0 — the multiply then makes basic = 0, never a divide-by-zero. The Mon–Fri roster mirrors
 * the working-day basis the leave/proration primitives use; Sat/Sun and listed holidays are non-working.
 */
function eligibleWorkingDays(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  holidays: Set<string>,
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  let days = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
    if (iso <= 5 && !holidays.has(d)) days++;
  }
  return days;
}

/**
 * Unpaid-leave days per employment for a wage period, auto-derived from APPROVED requests of an
 * unpaid leave type (leave_type.paid = false) that START within the period. Single source of truth
 * with the leave module — no double entry. (Requests straddling a month boundary are attributed to
 * their start month; cross-month splitting is a documented future refinement.)
 */
/**
 * Approved unpaid-leave days to deduct this period, by employment. Policy: a request is deducted in
 * full in the month it STARTS (filter on startDate ∈ period). Splitting a request that straddles a
 * month boundary across both months would need per-day expansion keyed to each leave type's counting
 * mode (the model stores per-request totals, not per-day) — deliberately deferred as a rare edge case.
 */
async function unpaidDaysByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  // c7fdfcf6 gap-fix (per-employment leave cut-off) — optionally scope to a set of employments so the caller
  // can resolve the LEAVE window PER employment (its assigned policy), then query per window-group. Omitted ⇒
  // tenant-wide (the legacy behaviour); the batch loop only ever reads its own employments' entries either way.
  employmentIds?: string[],
  // f3148da1 Step 5 (R17 gap-fix reinstatement) — when true, count ONLY partial-day unpaid absences (half-day
  // AM/PM + hourly requests, duration_type != 'full_day'): the "unpaid TIME OFF" subset the policy's
  // unpaidTimeOffDivisor values with its own formula. The batch loop queries this subset only for employments
  // whose config sets a distinct time-off divisor, so the default path issues no extra query.
  timeOffOnly = false,
): Promise<Map<string, number>> {
  // ADR-0068 §4A: for a per-date-approval request, deduct only the APPROVED dates, not the raw request span —
  // reading leave_request.days would count a mid-span rejected date as unpaid leave. We keep the current
  // "deduct in the month it STARTS" policy (filter on start_date ∈ period) and, per request, use the sum of
  // APPROVED leave_request_date.days when such rows exist, else the request's own `days` (unchanged path).
  const perDateDays = sql<string>`coalesce(
    (select sum(lrd.days) from leave_request_date lrd
      where lrd.leave_request_id = ${leaveRequest.id} and lrd.status = 'approved'),
    ${leaveRequest.days}
  )`;
  // Allow Unpaid Leave (feedback a7fab30b): a request can now be PARTLY unpaid — a paid leave type where the
  // balance covered only some of the days. Such a request must contribute its unpaid_days and nothing more,
  // whereas a wholly-unpaid request still contributes its whole (per-date-adjusted) span. Expressed as one
  // CASE so a request is counted exactly once whichever branch admitted it: a wholly-unpaid type never has
  // unpaid_days set, and a part-unpaid request is of a PAID type, so the two are disjoint by construction.
  // unpaid_days is NULL on every row that predates this column ⇒ the figure is unchanged for existing data.
  const unpaidDaysExpr = sql<string>`case
    when ${leaveType.paid} = false or ${leaveRequest.allowanceEligible} = false then ${perDateDays}
    else coalesce(${leaveRequest.unpaidDays}, 0)
  end`;
  const rows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${unpaidDaysExpr}), 0)`,
    })
    .from(leaveRequest)
    .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(
      and(
        eq(leaveRequest.status, 'approved'),
        // Unpaid days are: (a) any request of an unpaid leave type, OR (b) Phase-B #13 (ADR-0062) — a
        // MATERNITY request whose s.37 paid ALLOWANCE was withheld (allowance_eligible=false), which keeps
        // the paid MATERNITY leave-type but is unpaid for the period. The per-request override wins over the
        // type default; allowance_eligible TRUE/NULL on a paid type stays paid. Plus (c) a7fab30b — the
        // uncovered portion of a request on a type that allows unpaid leave, which is what this route was
        // always for: the deduction is then worked out exactly as it is for any other unpaid day.
        or(
          eq(leaveType.paid, false),
          eq(leaveRequest.allowanceEligible, false),
          sql`${leaveRequest.unpaidDays} > 0`,
        ),
        gte(leaveRequest.startDate, periodStart),
        lte(leaveRequest.startDate, periodEnd),
        employmentIds && employmentIds.length > 0 ? inArray(leaveRequest.employmentId, employmentIds) : undefined,
        timeOffOnly ? ne(leaveRequest.durationType, 'full_day') : undefined,
      ),
    )
    .groupBy(leaveRequest.employmentId);
  return new Map(rows.map((r) => [r.employmentId, Number(r.days)]));
}

/** ADR-0068 §4A / §8 test #6 — the unpaid-leave days payroll would deduct for a period, by employment. A thin
 *  session wrapper around unpaidDaysByEmployment so the span-consumer correctness test can assert a per-date
 *  request's APPROVED-only days are deducted (2, not the raw 3), without standing up a full payroll batch. */
export function unpaidLeaveDaysForPeriod(
  ctx: SessionContext,
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, number>> {
  return withTenant(ctx, (tx) => unpaidDaysByEmployment(tx, periodStart, periodEnd));
}

/** Optional batch subset (ADR-0035 1E, #23). Empty/absent ⇒ the whole company. */
export type BatchScope = { departmentIds?: string[]; employmentIds?: string[] };

/** Drop empty arrays; null when nothing specific is selected (⇒ whole company). */
function normalizeScope(scope?: BatchScope): BatchScope | null {
  const departmentIds = (scope?.departmentIds ?? []).filter(Boolean);
  const employmentIds = (scope?.employmentIds ?? []).filter(Boolean);
  if (!departmentIds.length && !employmentIds.length) return null;
  return { ...(departmentIds.length ? { departmentIds } : {}), ...(employmentIds.length ? { employmentIds } : {}) };
}

/**
 * Resolve a batch's scope to a concrete employment-id filter, shared by generatePayslips and every
 * prefill (OT/shift-diff/zakat/claims). Selected departments resolve to their CURRENT assignees, unioned
 * with any explicitly-named individuals. Returns `undefined` (no filter ⇒ whole company) when the scope
 * is empty/absent — identical to today's dynamic whole-company behaviour.
 */
export async function resolveBatchScopeFilter(
  tx: Tx,
  scope: BatchScope | null,
): Promise<{ filter: ReturnType<typeof inArray> | undefined; employmentIds: string[] | null }> {
  const scopeDeptIds = scope?.departmentIds ?? [];
  const scopeExplicitIds = scope?.employmentIds ?? [];
  if (!scopeDeptIds.length && !scopeExplicitIds.length) return { filter: undefined, employmentIds: null };
  const deptAssignees = scopeDeptIds.length
    ? await tx
        .select({ id: assignment.employmentId })
        .from(assignment)
        .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
    : [];
  const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
  return {
    filter: inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000']),
    employmentIds: scopeEmploymentIds,
  };
}

/** Payroll Process wizard (Step 1) — validate a user-supplied payment date (ISO 'YYYY-MM-DD'). Returns
 *  the date unchanged when valid, else null (caller falls back to the period default). */
function validPaymentDate(paymentDate?: string | null): string | null {
  if (!paymentDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return null;
  const d = new Date(`${paymentDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : paymentDate;
}

export async function createBatch(
  ctx: SessionContext,
  p: { companyId: string; payPeriod: string; scope?: BatchScope; paymentDate?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): this is the REGULAR run for a (company, month). Reject a second one exactly
    // as before — with MULTI_CYCLE_PAYROLL_ENABLED off there is still one run per month. Additional
    // same-month runs are a separate, gated path (2C-4); this function always creates run_seq=1/regular.
    const [existing] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.payPeriod)))
      .limit(1);
    if (existing) throw new Error('A payroll process already exists for this period');

    // Every batch belongs to a pay_period parent (the statutory month). Find-or-create it; a period
    // row may already exist (e.g. an earlier draft run was deleted) — reuse it. The month-level
    // ruleset version is snapshotted onto the period when payslips are first generated (2C-4), so it
    // is left null here.
    const [existingPeriod] = await tx
      .select({ id: payPeriod.id })
      .from(payPeriod)
      .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, p.payPeriod)))
      .limit(1);
    let periodId = existingPeriod?.id;
    if (!periodId) {
      const [createdPeriod] = await tx
        .insert(payPeriod)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, period: p.payPeriod, status: 'open' })
        .returning({ id: payPeriod.id });
      periodId = createdPeriod.id;
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: periodId,
        eventType: 'pay-period.opened',
        actor: actorOf(ctx),
        payload: { companyId: p.companyId, period: p.payPeriod },
      });
    }

    // Payroll Process wizard (1a/1d): batch_date now carries the USER-SET payment date (previously
    // write-only — no report/export read it). A validated ISO date wins; else fall back to the
    // existing '<period>-28' default (unchanged behaviour for every pre-wizard caller/test).
    const batchDate = validPaymentDate(p.paymentDate) ?? `${p.payPeriod}-28`;
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: periodId,
        runSeq: 1,
        runType: 'regular',
        payPeriod: p.payPeriod,
        batchDate,
        status: 'draft',
        scope: normalizeScope(p.scope),
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.created',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        payPeriodId: periodId,
        runSeq: 1,
        runType: 'regular',
        scope: normalizeScope(p.scope),
        paymentDate: batchDate,
      },
    });

    // Phase-B #15 — holiday-completeness guard. The payroll period spans a (company-state, year); if fewer
    // than the EA s.60D minimum of 11 gazetted holidays are loaded for it, the rest-day / OT-class day
    // arithmetic may be wrong. Warn LOUDLY (domain event + returned warning) but never block the batch.
    const holidayWarnings = await warnBatchHolidayCompleteness(tx, ctx, p.companyId, p.payPeriod, row.id);
    return { batchId: row.id, ...(holidayWarnings.length ? { holidayWarnings } : {}) };
  });
}

/** Phase-B #15: for a payroll batch, resolve the company's country + default work state and the period's
 *  year, then emit a non-blocking holiday-completeness warning when the loaded gazette is below the s.60D
 *  minimum. Returns the warnings so the payroll screen can surface them. */
async function warnBatchHolidayCompleteness(
  tx: Tx,
  ctx: SessionContext,
  companyId: string,
  payPeriod: string,
  batchId: string,
): Promise<HolidayCompletenessWarning[]> {
  const [co] = await tx
    .select({ country: company.country, state: company.defaultWorkState })
    .from(company)
    .where(eq(company.id, companyId))
    .limit(1);
  if (!co) return [];
  const year = Number(payPeriod.slice(0, 4));
  return warnIfHolidaysIncomplete(tx, ctx, {
    country: co.country,
    state: co.state ?? null,
    years: [year],
    module: 'payroll',
    aggregateType: 'payroll-batch',
    aggregateId: batchId,
    context: { companyId, payPeriod },
  });
}

/**
 * Wave 2C (ADR-0024) — create an ADDITIONAL same-month run (bonus / off-cycle / adjustment) under the
 * existing pay_period. GATED behind MULTI_CYCLE_PAYROLL_ENABLED, and the regular run must already exist.
 * The run is computed as additional remuneration (the increment method) at generatePayslips.
 */
export async function createAdditionalRun(
  ctx: SessionContext,
  p: {
    companyId: string;
    payPeriod: string;
    runType: 'off_cycle' | 'bonus' | 'adjustment';
    /** Payroll Process wizard (1b): optional payment date (validated, else '<period>-28' default). */
    paymentDate?: string;
    /** Payroll Process wizard (1b): a cycle label for off-cycle presets, e.g. 'Advance Salary' / 'Mid-Month'. */
    remarks?: string;
    /** Payroll Process wizard (1b): optional subset — generatePayslips already resolves batch.scope for
     *  every runType, so an additional run can legitimately be scoped the same way the regular run is. */
    scope?: BatchScope;
  },
) {
  if (!isModuleEnabled(ctx, 'multi_cycle_payroll')) {
    // Message preserved verbatim: it is user-visible and asserted by existing tests. The TYPE is now
    // ModuleNotEnabledError so a caller can distinguish "not entitled" from any other failure.
    throw new ModuleNotEnabledError('multi_cycle_payroll', 'Multiple payroll runs per month are not enabled.');
  }
  return withTenant(ctx, async (tx) => {
    const [period] = await tx
      .select({ id: payPeriod.id, status: payPeriod.status })
      .from(payPeriod)
      .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, p.payPeriod)))
      .limit(1);
    if (!period) throw new Error('No pay period for this month yet — create the regular run first.');
    if (period.status === 'closed') throw new Error('This pay period is closed.');
    const runs = await tx
      .select({ runSeq: payrollBatch.runSeq, runType: payrollBatch.runType })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, period.id));
    if (!runs.some((r) => r.runType === 'regular')) {
      throw new Error('Create the regular run for this month before adding a run.');
    }
    const nextSeq = Math.max(...runs.map((r) => r.runSeq)) + 1;
    const batchDate = validPaymentDate(p.paymentDate) ?? `${p.payPeriod}-28`;
    const scope = normalizeScope(p.scope);
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: period.id,
        runSeq: nextSeq,
        runType: p.runType,
        payPeriod: p.payPeriod,
        batchDate,
        status: 'draft',
        scope,
        remarks: p.remarks || null,
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.run-added',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        payPeriodId: period.id,
        runSeq: nextSeq,
        runType: p.runType,
        paymentDate: batchDate,
        remarks: p.remarks || null,
        scope,
      },
    });
    return { batchId: row.id };
  });
}

/**
 * Payroll Process wizard — resume a DRAFT batch and re-set its employee-selection scope (the "who's in
 * this run" step, formerly bypassed for drafts). Draft-only (mirrors generatePayslips' BatchNotDraftError
 * guard); the status read + the scope write happen inside ONE transaction so a concurrent double-submit
 * cannot both pass a stale "still draft" read before either write lands.
 *
 * `employmentIds` is the resolved explicit selection the wizard posts when the admin narrowed the set
 * (any filter use or manual deselect). It is intersected against the batch company's employees — the SAME
 * cross-company membership guard createRunAction applies — so a stale/cross-company id can never widen or
 * silently under-set the run. An empty/absent selection normalises to null scope (whole company), exactly
 * as a fresh run's no-filter default.
 *
 * Cleanup (orphan-data safeguard): any employment present in the PREVIOUS scope but absent from the NEW
 * scope has its payroll_input row deleted, and any loan instalment RESERVED to this batch for them is
 * RELEASED back to 'scheduled' (reservedBatchId cleared) so a stale reservation is never stranded against
 * the loan balance. Nothing is released for an employment that stays in scope.
 */
export async function updateBatchScope(
  ctx: SessionContext,
  p: { batchId: string; scope?: BatchScope },
) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId, scope: payrollBatch.scope })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    // Cross-company membership guard (same intersection createRunAction applies): keep only submitted ids
    // that belong to this batch's company, so a stale/cross-company id can never reach the persisted scope.
    const submittedEmploymentIds = (p.scope?.employmentIds ?? []).filter(Boolean);
    let validEmploymentIds = submittedEmploymentIds;
    if (submittedEmploymentIds.length) {
      const companyEmps = await tx
        .select({ id: employment.id })
        .from(employment)
        .where(and(eq(employment.companyId, batch.companyId), inArray(employment.id, submittedEmploymentIds)));
      const valid = new Set(companyEmps.map((e) => e.id));
      validEmploymentIds = submittedEmploymentIds.filter((id) => valid.has(id));
    }
    // Department ids in the scope carry through unchanged (the wizard's resume path posts explicit
    // employment ids, not department filters, but keep the department dimension intact if present).
    const nextScope = normalizeScope({
      ...(p.scope?.departmentIds?.length ? { departmentIds: p.scope.departmentIds } : {}),
      ...(validEmploymentIds.length ? { employmentIds: validEmploymentIds } : {}),
    });

    const prevScope = (batch.scope ?? null) as BatchScope | null;
    // Resolve the CONCRETE employment-id membership of the previous and next scope so the removed set is
    // computed off actual assignees (department scopes resolve to their current members), not raw arrays.
    const prevResolved = await resolveBatchScopeFilter(tx, prevScope);
    const nextResolved = await resolveBatchScopeFilter(tx, nextScope);
    // A null resolved set means "whole company" (no filter). Removal only makes sense when the PREVIOUS
    // scope was explicit — widening to whole-company removes nobody, and narrowing FROM whole-company can't
    // enumerate a concrete removed set, so we only clean up when the previous scope was a concrete subset.
    const prevIds = prevResolved.employmentIds;
    const nextIds = new Set(nextResolved.employmentIds ?? []);
    const removedEmploymentIds = prevIds ? prevIds.filter((id) => !nextIds.has(id)) : [];

    await tx.update(payrollBatch).set({ scope: nextScope }).where(eq(payrollBatch.id, p.batchId));

    for (const employmentId of removedEmploymentIds) {
      // Release any loan instalment reserved to THIS batch for the removed employment back to 'scheduled'
      // so its reservation is not stranded (the loan balance is untouched — nothing was applied yet).
      const releasedRepayments = await tx
        .update(loanRepayment)
        .set({ status: 'scheduled', reservedBatchId: null })
        .where(
          and(
            eq(loanRepayment.reservedBatchId, p.batchId),
            eq(loanRepayment.employmentId, employmentId),
            eq(loanRepayment.status, 'reserved'),
          ),
        )
        .returning({ id: loanRepayment.id, loanId: loanRepayment.loanId });
      for (const r of releasedRepayments) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'loan-repayment',
          aggregateId: r.id,
          eventType: 'loan.instalment.reservation-released',
          actor: actorOf(ctx),
          subjectEmploymentId: employmentId,
          payload: { batchId: p.batchId, loanId: r.loanId, reason: 'removed-from-batch-scope' },
        });
      }
      // Clear any keyed inputs (OT/bonus/claims/loan-deduction/…) for the removed employment on this batch.
      await tx
        .delete(payrollInput)
        .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, employmentId)));
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.scope.updated',
      actor: actorOf(ctx),
      payload: { before: prevScope, after: nextScope, removedEmploymentIds },
    });
    return { ok: true, removedEmploymentIds };
  });
}

/**
 * Tear down a DRAFT batch's child rows inside the caller's transaction (feedback 4f00d8f0 — draft
 * delete). This is the batch-wide generalisation of the per-removed-employee cleanup updateBatchScope
 * performs:
 *   1. Loan instalments still RESERVED to this batch are RELEASED back to 'scheduled' (reservedBatchId
 *      cleared) so no reservation is stranded against a loan balance — one
 *      `loan.instalment.reservation-released` event per row, same as the scope-removal path. APPLIED
 *      loan state (`appliedBatchId` / status='applied') is deliberately untouched: it only exists on a
 *      processed batch, which every draft-only caller refuses; unwinding it is the processed→draft
 *      Reset's mechanic (sibling feedback a03b2d9b).
 *   2. Draft-stage child rows are deleted: payroll_input, payroll_batch_component, and — defensively —
 *      payslip (expected empty for a draft, since generation flips the batch off 'draft'; deleting-if-any
 *      keeps the teardown total).
 *   3. Claims stamped onto this batch are DETACHED (payroll_batch_id → null), not deleted — the claim
 *      is an approved business record that must survive and become re-queueable; one
 *      `claim-request.unqueued-from-payroll` event per claim (mirrors claim-request.queued-for-payroll).
 *   4. Individual one-off transactions are likewise DETACHED (batch_id → null; f1564110 Phase 2, amending
 *      ADR-0056) — they keep their (company_id, pay_period) home and re-attach automatically when the
 *      month's regular run is next generated; one `payroll.individual-txn.detached` event per row.
 *
 * Shared seam: deleteDraftBatch calls this before removing the batch row, and the processed→draft
 * Reset (a03b2d9b) can reuse it for its final draft-cleanup step. Events are appended HERE so no
 * caller can perform the teardown silently (substrate discipline).
 */
export async function teardownDraftChildren(tx: Tx, ctx: SessionContext, batchId: string) {
  const releasedRepayments = await tx
    .update(loanRepayment)
    .set({ status: 'scheduled', reservedBatchId: null })
    .where(and(eq(loanRepayment.reservedBatchId, batchId), eq(loanRepayment.status, 'reserved')))
    .returning({ id: loanRepayment.id, loanId: loanRepayment.loanId, employmentId: loanRepayment.employmentId });
  for (const r of releasedRepayments) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'loan-repayment',
      aggregateId: r.id,
      eventType: 'loan.instalment.reservation-released',
      actor: actorOf(ctx),
      subjectEmploymentId: r.employmentId,
      payload: { batchId, loanId: r.loanId, reason: 'draft-batch-teardown' },
    });
  }

  const inputs = await tx.delete(payrollInput).where(eq(payrollInput.batchId, batchId)).returning({ id: payrollInput.id });
  // f1564110 Phase 2 (amends ADR-0056): individual one-off transactions are DETACHED (batch_id → NULL),
  // not deleted — like claims, they are keyed-in business records that must survive a draft delete/reset
  // and re-attach automatically when the month's regular run is next generated. Their (company_id,
  // pay_period) home was stamped at write time (backfilled by 0175 for older rows), so the 0175 CHECK
  // holds through the detach. One event per row (cross-aggregate state change, same as the claim detach).
  // Stamp (company, pay month) from the batch during the detach — the service stamps them on every write
  // and 0175 backfilled old rows, but a defensively-inserted row without them must still satisfy the 0175
  // CHECK (batch_id OR company+period) once batch_id goes NULL. The batch row still exists here.
  const [teardownBatch] = await tx
    .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  const detachedIndividualTxns = await tx
    .update(payrollIndividualTxn)
    .set({ batchId: null, companyId: teardownBatch?.companyId, payPeriod: teardownBatch?.payPeriod })
    .where(eq(payrollIndividualTxn.batchId, batchId))
    .returning({ id: payrollIndividualTxn.id, employmentId: payrollIndividualTxn.employmentId, payPeriod: payrollIndividualTxn.payPeriod });
  for (const t of detachedIndividualTxns) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: t.id,
      eventType: 'payroll.individual-txn.detached',
      actor: actorOf(ctx),
      subjectEmploymentId: t.employmentId,
      payload: { batchId, payPeriod: t.payPeriod, reason: 'draft-batch-teardown' },
    });
  }
  const components = await tx
    .delete(payrollBatchComponent)
    .where(eq(payrollBatchComponent.batchId, batchId))
    .returning({ id: payrollBatchComponent.id });
  const payslips = await tx.delete(payslip).where(eq(payslip.batchId, batchId)).returning({ id: payslip.id });

  // ── Batch-keyed audit / control rows (feedback ec3873a6) ──────────────────────────────────────────
  // A hard draft delete must clear EVERY child that FK-references payroll_batch.id, else the final
  // tx.delete(payrollBatch) hits a foreign-key violation and the raw SQL leaks to the UI. A FRESH draft
  // carries none of these, but a draft that was reverted from Processed (resetProcessedBatch) — or that
  // was unlocked/reprocessed on its way there — leaves rows keyed to the batch:
  //   • payroll_status_history   — the 'rollback' (and any 'unlock'/'reprocess') snapshot rows the reset
  //     writes; NO onDelete cascade, so THIS was the reported bug (batch deff8c3c stuck on 2 rollback rows).
  //   • payroll_employee_result_history — per-employee before/after snapshots written by a reprocess.
  //   • payroll_reprocess_job    — the reprocess job queue rows keyed to the batch.
  //   • payroll_step_up_challenge — the step-up (2FA) unlock challenge rows an unlock-before-reset leaves.
  // A hard delete leaves NO trace of the batch, so its audit/control history goes with it — the durable
  // record of the deletion itself is the payroll-batch.deleted DomainEvent the caller appends (which
  // carries these counts). NOT enumerated here because they can never point at a DRAFT: loan_repayment
  // .applied_batch_id (reset NULLs it; only processing sets it) and payslip/input/component/individual-txn/
  // claim (handled above). Prefer this explicit draft-only teardown over ON DELETE CASCADE on the FKs —
  // it stays controlled and needs no migration.
  const statusHistory = await tx
    .delete(payrollStatusHistory)
    .where(eq(payrollStatusHistory.batchId, batchId))
    .returning({ id: payrollStatusHistory.id });
  const resultHistory = await tx
    .delete(payrollEmployeeResultHistory)
    .where(eq(payrollEmployeeResultHistory.batchId, batchId))
    .returning({ id: payrollEmployeeResultHistory.id });
  const reprocessJobs = await tx
    .delete(payrollReprocessJob)
    .where(eq(payrollReprocessJob.batchId, batchId))
    .returning({ id: payrollReprocessJob.id });
  const stepUpChallenges = await tx
    .delete(payrollStepUpChallenge)
    .where(eq(payrollStepUpChallenge.batchId, batchId))
    .returning({ id: payrollStepUpChallenge.id });
  // Note: the child-row deletes above are covered by the batch-level teardown/deleted event the caller
  // appends (their per-row history lives on their own aggregates' earlier events); only the two rows with
  // cross-aggregate state (loan reservation, claim link) get per-row events here.

  const detachedClaims = await tx
    .update(claimRequest)
    .set({ payrollBatchId: null })
    .where(eq(claimRequest.payrollBatchId, batchId))
    .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
  for (const c of detachedClaims) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: c.id,
      eventType: 'claim-request.unqueued-from-payroll',
      actor: actorOf(ctx),
      subjectEmploymentId: c.employmentId,
      payload: { batchId, reason: 'draft-batch-teardown' },
    });
  }

  return {
    releasedLoanRepaymentIds: releasedRepayments.map((r) => r.id),
    detachedClaimIds: detachedClaims.map((c) => c.id),
    detachedIndividualTxnIds: detachedIndividualTxns.map((t) => t.id),
    deletedChildCounts: {
      inputs: inputs.length,
      components: components.length,
      payslips: payslips.length,
      statusHistory: statusHistory.length,
      resultHistory: resultHistory.length,
      reprocessJobs: reprocessJobs.length,
      stepUpChallenges: stepUpChallenges.length,
    },
  };
}

/**
 * Payroll Process listing (feedback 4f00d8f0) — permanently DELETE a DRAFT batch and all its draft-stage
 * child data. DRAFT-ONLY: any other status throws BatchNotDraftError — this is the hard seam that keeps
 * processed/closed runs undeletable from the listing; reversing a PROCESSED run back to draft is the
 * Reset/Zeroize mechanic (sibling feedback a03b2d9b), never this method. The DB additionally freezes
 * 'closed' batches via the 0011 immutability trigger.
 *
 * The status read and every destructive write share ONE transaction (same double-submit rationale as
 * updateBatchScope). RLS scopes the batch lookup — a batch outside this admin's payroll scope resolves
 * to no row ("batch not found"), so a company-scoped admin can never delete another company's draft.
 *
 * Orphan-parent tidy-up: when the deleted run was the LAST batch under its pay_period AND the period is
 * still 'open', the period row is deleted too (createBatch's find-or-reuse already anticipates a period
 * surviving a draft delete, so leaving it would also be safe — removing it just avoids stray open
 * months). A closed period is never touched.
 */
export async function deleteDraftBatch(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriodId: payrollBatch.payPeriodId,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const teardown = await teardownDraftChildren(tx, ctx, p.batchId);

    await tx.delete(payrollBatch).where(eq(payrollBatch.id, p.batchId));

    // Orphan-parent cleanup: delete the pay_period only when NO sibling run still references it and it
    // is still 'open' (guard: never delete a closed statutory month — the 0067 trigger also enforces it).
    const [sibling] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, batch.payPeriodId))
      .limit(1);
    let payPeriodDeleted = false;
    if (!sibling) {
      const deletedPeriods = await tx
        .delete(payPeriod)
        .where(and(eq(payPeriod.id, batch.payPeriodId), eq(payPeriod.status, 'open')))
        .returning({ id: payPeriod.id });
      if (deletedPeriods.length > 0) {
        payPeriodDeleted = true;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'pay-period',
          aggregateId: batch.payPeriodId,
          eventType: 'pay-period.deleted',
          actor: actorOf(ctx),
          payload: { companyId: batch.companyId, period: batch.payPeriod, reason: 'last-run-deleted' },
        });
      }
    }

    // The event log is the durable audit trail for a hard delete — record WHAT was removed (child
    // counts, released reservations, detached claims), not just that it happened.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.deleted',
      actor: actorOf(ctx),
      payload: {
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        payPeriodId: batch.payPeriodId,
        runType: batch.runType,
        runSeq: batch.runSeq,
        payPeriodDeleted,
        ...teardown,
      },
    });
    return { id: p.batchId };
  });
}

/** Upsert a draft batch's manual overtime input for one employee. Draft-only; appends an event. */
export async function setPayrollInput(
  ctx: SessionContext,
  p: {
    batchId: string;
    employmentId: string;
    overtimeAmount: number;
    bonusAmount?: number;
    tp1Deduction?: number;
    zakat?: number;
    /** OT rate-bucket decomposition (RM amounts). The caller has already summed these into
     *  `overtimeAmount` — this is persisted only so the four UI inputs can be re-prefilled; nothing
     *  downstream reads it. Omit to leave the stored decomposition untouched (insert ⇒ NULL). */
    otBreakdown?: { flat: number; normal: number; rest: number; holiday: number };
    /** Fix-5 (M#17) provenance. `setPayrollInput` IS the manual-save path, so it stamps ot_source='manual'
     *  by DEFAULT — a direct call (admin form, importer, test) records that the OT figure was hand-keyed,
     *  so a later attendance prefill (and the editor's clobber warning) can tell. The read-modify-write
     *  callers that merely carry the existing OT forward unchanged — the deduction-only (TP1/zakat) wrapper
     *  and the bonus enact — pass `'preserve'` to leave the stored provenance untouched (NULL on insert).
     */
    otSource?: 'manual' | 'preserve';
    /** ADR-0050 §0.4 TP1 provenance. `setPayrollInput` is the manual-save path, so it stamps
     *  tp1_source=null ('manual') by DEFAULT — a direct call (admin form, importer, test) records that the
     *  TP1 figure is a hand-keyed override, so a later TP1 self-relief prefill leaves it untouched. The
     *  deduction-only wrapper passes `'preserve'` for a ZAKAT-only write (no TP1 edit) so the untouched TP1
     *  keeps its stored provenance ('tp1_self' stays auto-tracked) — mirrors the otSource:'preserve' path. */
    tp1SourceMode?: 'manual' | 'preserve';
  },
  /** Optional caller transaction — pass it so this participates in an enclosing transaction
   *  (the performance bonus enact) and commits/rolls back atomically with it. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const overtimeAmount = Math.max(0, Number(p.overtimeAmount) || 0);
    const bonusAmount = Math.max(0, Number(p.bonusAmount) || 0);
    const tp1Deduction = Math.max(0, Number(p.tp1Deduction) || 0);
    const zakat = Math.max(0, Number(p.zakat) || 0);
    // OT rate-bucket decomposition: persist only when the caller supplied it; clamp each bucket >= 0.
    // `undefined` ⇒ leave the stored column untouched on update (do not coalesce to NULL), NULL on insert.
    const otBreakdown =
      p.otBreakdown === undefined
        ? undefined
        : {
            flat: Math.max(0, Number(p.otBreakdown.flat) || 0),
            normal: Math.max(0, Number(p.otBreakdown.normal) || 0),
            rest: Math.max(0, Number(p.otBreakdown.rest) || 0),
            holiday: Math.max(0, Number(p.otBreakdown.holiday) || 0),
          };
    // Fix-5 (M#17): resolve OT provenance. Default 'manual' (this is the manual-save path); 'preserve'
    // (deduction-only / bonus-enact) ⇒ leave the stored column untouched on update, NULL on insert.
    const otSource: 'manual' | undefined = p.otSource === 'preserve' ? undefined : 'manual';
    // ADR-0050 §0.4: resolve TP1 provenance. Default 'manual' (a direct/admin TP1 write resets provenance
    // to a sticky manual override, exactly as today). 'preserve' (a zakat-only deduction write that does NOT
    // touch TP1) ⇒ omit tp1_source from the update .set() so a live 'tp1_self' relief keeps auto-tracking.
    // Mirrors the otSource:'preserve' mechanism above. On INSERT there is no prior TP1, so both modes NULL.
    const stampTp1Source: boolean = p.tp1SourceMode !== 'preserve';
    const [existing] = await tx
      .select({ id: payrollInput.id })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    let payrollInputId: string;
    if (existing) {
      await tx
        .update(payrollInput)
        .set({
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          tp1Deduction: tp1Deduction.toFixed(2),
          // ADR-0050 §0.4: a TP1 write resets provenance to manual (null) → sticky, so a later TP1
          // self-relief prefill leaves this override untouched. A zakat-only write ('preserve') omits the
          // key entirely, leaving a 'tp1_self' relief auto-tracked (same conditional-spread as otSource).
          ...(stampTp1Source ? { tp1Source: null } : {}),
          zakat: zakat.toFixed(2),
          // Persist the OT decomposition only when supplied; omit the key entirely otherwise so a
          // TP1-only / bonus-enact round-trip leaves the existing breakdown untouched (not nulled).
          ...(otBreakdown !== undefined ? { otBreakdown } : {}),
          // Fix-5 (M#17): stamp OT provenance ('manual') unless the caller asked to preserve it; a
          // 'preserve' (deduction-only / bonus-enact) round-trip leaves the existing ot_source untouched.
          ...(otSource !== undefined ? { otSource } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(payrollInput.id, existing.id));
      payrollInputId = existing.id;
    } else {
      const [row] = await tx
        .insert(payrollInput)
        .values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId: p.employmentId,
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          tp1Deduction: tp1Deduction.toFixed(2),
          // Manual provenance (null is the column default; set explicitly for clarity).
          tp1Source: null,
          zakat: zakat.toFixed(2),
          // NULL when the caller omitted the decomposition (legacy / wrapper paths).
          otBreakdown: otBreakdown ?? null,
          // Fix-5 (M#17): 'manual' by default; NULL when the caller asked to preserve (deduction-only /
          // bonus-enact inserts have no OT figure of their own to attribute).
          otSource: otSource ?? null,
        })
        .returning({ id: payrollInput.id });
      payrollInputId = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.input-set',
      actor: actorOf(ctx),
      // ADR-0030 Layer 0: the figures live on payroll_input[payrollInputId]; reference, not cleartext pay.
      // Only the field NAME 'otBreakdown' is recorded (and only when it was actually written) — never the
      // per-bucket RM amounts.
      payload: {
        employmentId: p.employmentId,
        payrollInputId,
        fieldsChanged: [
          'overtimeAmount',
          'bonusAmount',
          'tp1Deduction',
          'zakat',
          ...(otBreakdown !== undefined ? ['otBreakdown'] : []),
          ...(otSource !== undefined ? ['otSource'] : []),
        ],
      },
    });
    return { ok: true };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Feature 1.2 (Transaction sub-module) — set ONLY the statutory deduction scalars (TP1, zakat) on a
 * draft batch input row, preserving the sibling earnings fields. `setPayrollInput` is a full-row
 * overwrite that coalesces any omitted field to 0; a TP1/zakat-only form posting through it would
 * silently zero overtime/bonus. This is a READ-MODIFY-WRITE wrapper: it reads the current row's
 * overtime/bonus, merges the changed deduction fields, and delegates to setPayrollInput so the event
 * shape (payroll-batch.input-set) and the draft-only / clamp rules stay identical. Either field may be
 * left undefined to keep its current value.
 */
export async function setPayrollDeductionInput(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string; tp1Deduction?: number; zakat?: number },
) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        overtimeAmount: payrollInput.overtimeAmount,
        bonusAmount: payrollInput.bonusAmount,
        tp1Deduction: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        otBreakdown: payrollInput.otBreakdown,
      })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    return setPayrollInput(
      ctx,
      {
        batchId: p.batchId,
        employmentId: p.employmentId,
        // Preserve the sibling earnings — do NOT let the full-row overwrite reset them.
        overtimeAmount: Number(existing?.overtimeAmount ?? 0),
        bonusAmount: Number(existing?.bonusAmount ?? 0),
        tp1Deduction: p.tp1Deduction ?? Number(existing?.tp1Deduction ?? 0),
        zakat: p.zakat ?? Number(existing?.zakat ?? 0),
        // Preserve the OT decomposition too (undefined ⇒ leave the column untouched).
        otBreakdown: existing?.otBreakdown ?? undefined,
        // Fix-5 (M#17): a TP1/zakat-only write is NOT an OT change — preserve the existing ot_source
        // (attendance-derived stays attendance-derived).
        otSource: 'preserve',
        // ADR-0050 §0.4: preserve the stored TP1 provenance UNLESS this call actually edits TP1. A TP1 edit
        // (p.tp1Deduction provided) is a real manual override → 'manual' (reset provenance, matches today);
        // a zakat-only write (p.tp1Deduction undefined) must NOT poison a live 'tp1_self' relief → 'preserve'
        // so the untouched TP1 keeps auto-tracking. This also fixes the pre-existing prefillFixedZakat
        // poisoning, which reaches this wrapper with zakat only.
        tp1SourceMode: p.tp1Deduction === undefined ? 'preserve' : 'manual',
      },
      tx,
    );
  });
}

/**
 * Prefill a draft batch's TP1 personal-relief deduction from the employee's yearly self-service
 * declaration (ADR-0050, #1.1.3). The employee declares ONE annual TP1 amount per assessment year on
 * /me; the latest SUBMITTED row feeds monthly PCB here.
 *
 * The kernel SUMS each month's `st.lp` into `acc.lpAccumulated` and PCB consumes `∑LP + LP₁`, so feeding
 * the full annual every month over-relieves. Per ADR-0050 §0.1 (delta method) the feed is
 *   feed = max(0, annual − ∑LP_already_accumulated_this_year_for_the_paymaster_employment)
 * reading `∑LP` by replaying this assessment year's prior payslips' `st.lp` — the SAME source the kernel
 * uses — so `∑LP + LP₁` converges to the declared annual, claimed exactly once. Self-correcting under
 * mid-year adoption, re-run/idempotency, and mid-year correction.
 *
 * Routing (§0.5): the relief is keyed by person but tp1_deduction is per-employment, so for a person with
 * concurrent employments in the batch it is written ONLY to `designated_paymaster_employment_id` (when set;
 * else the single employment of that person in the batch). Other employments are left untouched.
 *
 * Provenance (§0.4): writes/refreshes only a tp1_deduction whose `tp1_source = 'tp1_self'` (or a row that
 * has none yet), and stamps `tp1_source = 'tp1_self'`. A row last set by the admin form (`tp1_source` null)
 * is a manual override and is left untouched. Uses a targeted `.update().set({ tp1Deduction })` that
 * preserves overtime/bonus/zakat/claimAllowance — never `setPayrollInput` (which would zero them).
 * Draft-only; throws `BatchNotDraftError` otherwise.
 */
export async function prefillTp1FromSelfRelief(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number; skipped: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Active employees of this batch's company in the period (same active-set rule as generatePayslips).
    const emps = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        designatedPaymaster: person.designatedPaymasterEmploymentId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      );
    if (emps.length === 0) return { applied: 0, skipped: 0 };

    // §0.5 routing: per person, the employment that should carry the relief in THIS batch — the
    // designated paymaster if it is among the batch's employments, else (no paymaster set) the person's
    // single employment here. A person with >1 employment in the batch and no paymaster is ambiguous: skip
    // to avoid double-counting (the kernel can't know which one is the paymaster).
    const batchEmpIds = new Set(emps.map((e) => e.employmentId));
    const byPerson = new Map<string, typeof emps>();
    for (const e of emps) {
      const list = byPerson.get(e.personId) ?? [];
      list.push(e);
      byPerson.set(e.personId, list);
    }
    const targetByPerson = new Map<string, string>(); // personId → employmentId to feed
    for (const [personId, list] of byPerson) {
      const paymaster = list[0].designatedPaymaster;
      if (paymaster && batchEmpIds.has(paymaster)) targetByPerson.set(personId, paymaster);
      else if (list.length === 1) targetByPerson.set(personId, list[0].employmentId);
      // else: >1 employment in this batch and no paymaster among them → ambiguous, skip.
    }
    if (targetByPerson.size === 0) return { applied: 0, skipped: 0 };

    // Latest SUBMITTED annual declaration per person for this assessment year (§0.6: payPeriod's year).
    const personIds = [...targetByPerson.keys()];
    const declarations = await tx
      .select({
        personId: tp1Relief.personId,
        amount: tp1Relief.tp1Amount,
        createdAt: tp1Relief.createdAt,
      })
      .from(tp1Relief)
      .where(
        and(
          inArray(tp1Relief.personId, personIds),
          eq(tp1Relief.assessmentYear, pYear),
          eq(tp1Relief.status, 'submitted'),
        ),
      )
      .orderBy(desc(tp1Relief.createdAt));
    const annualByPerson = new Map<string, number>();
    for (const d of declarations) {
      if (!annualByPerson.has(d.personId)) annualByPerson.set(d.personId, Number(d.amount)); // latest wins
    }
    if (annualByPerson.size === 0) return { applied: 0, skipped: 0 };

    // ∑LP already accumulated this assessment year per target employment — replay prior payslips' st.lp,
    // the SAME ledger the PCB accumulator uses (generatePayslips). Prior = earlier pay periods this year.
    const targetEmpIds = personIds.map((pid) => targetByPerson.get(pid)!).filter(Boolean);
    const priorSlips = targetEmpIds.length
      ? await tx
          .select({ employmentId: payslip.employmentId, period: payrollBatch.payPeriod, statutory: payslip.statutory })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, targetEmpIds),
              like(payrollBatch.payPeriod, `${pYear}-%`),
              lt(payrollBatch.payPeriod, batch.payPeriod),
            ),
          )
      : [];
    const lpAccByEmp = new Map<string, number>();
    for (const s of priorSlips) {
      const st = (s.statutory ?? {}) as { lp?: number };
      lpAccByEmp.set(s.employmentId, round2((lpAccByEmp.get(s.employmentId) ?? 0) + Number(st.lp ?? 0)));
    }

    // Existing draft inputs for these target employments — preserve siblings; honour provenance.
    const existingInputs = await tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        tp1Deduction: payrollInput.tp1Deduction,
        tp1Source: payrollInput.tp1Source,
      })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), inArray(payrollInput.employmentId, targetEmpIds)));
    const existingByEmp = new Map(existingInputs.map((r) => [r.employmentId, r]));

    let applied = 0;
    let skipped = 0;
    for (const personId of personIds) {
      const employmentId = targetByPerson.get(personId)!;
      const annual = annualByPerson.get(personId);
      if (annual == null) continue; // no submitted declaration this year
      const lpAcc = lpAccByEmp.get(employmentId) ?? 0;
      const feed = Math.max(0, round2(annual - lpAcc)); // §0.1/0.2 delta — never grows ∑LP past the annual
      const prior = existingByEmp.get(employmentId);
      // §0.4: refresh only a prefill-set row (or one with no row yet). A manual admin override
      // (tp1_source null but a tp1_deduction already keyed) is sticky — skip it.
      if (prior) {
        const manualOverride = prior.tp1Source !== 'tp1_self' && Number(prior.tp1Deduction) > 0;
        if (manualOverride) {
          skipped += 1;
          continue;
        }
        await tx
          .update(payrollInput)
          .set({ tp1Deduction: feed.toFixed(2), tp1Source: 'tp1_self', updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          tp1Deduction: feed.toFixed(2),
          tp1Source: 'tp1_self',
        });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.input-set',
        actor: actorOf(ctx),
        // ADR-0030 Layer 0: figures live on payroll_input; reference, not cleartext.
        payload: { employmentId, source: 'tp1_self', fieldsChanged: ['tp1Deduction'] },
      });
      applied += 1;
    }
    return { applied, skipped };
  });
}

/**
 * 1.2.4 Zakat — prefill a draft batch's `payroll_input.zakat` from each in-scope employee's FIXED zakat
 * election, as a visibility/edit convenience: the kernel already auto-applies the fixed amount at generate
 * time (effectiveZakat resolution), so this only lets an admin see/override the figure on the batch row
 * before generating. The percent_of_pcb path needs none — it is derived live in the kernel.
 *
 * Scope: mirror `generatePayslips` exactly — the batch's company AND its `batch.scope` (departments +
 * explicit individuals). NOT a company-wide select (that would write orphan rows for employees outside the
 * batch's subset). Draft-only is enforced inside `setPayrollDeductionInput` → `setPayrollInput`, which also
 * preserves the sibling earnings/TP1 fields. We DON'T emit a second event: the input-set call already logs
 * it, and the derivation here is a trivial constant (fixedAmount), not an OT-style computation that would
 * warrant a derivation payload. Writes ONLY for active employees; never zeroes others (an employee whose
 * setup became inactive keeps any prior manual zakat — admin must clear it, same as OT/bonus preservation).
 *
 * NOTE (feedback d435673e): the Zakat screen's one-off override section was removed, so this prefill, the
 * batch input grid and the batch import are now the ONLY writers of `payroll_input.zakat`. Kernel precedence
 * is unchanged (manual > fixed > percent_of_pcb) — see the effectiveZakat resolution in generatePayslips.
 */
export async function prefillFixedZakat(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        scope: payrollBatch.scope,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Scope resolution identical to generatePayslips: empty/absent scope ⇒ whole company.
    const sc = (batch.scope ?? null) as BatchScope | null;
    const scopeDeptIds = sc?.departmentIds ?? [];
    const scopeExplicitIds = sc?.employmentIds ?? [];
    const deptAssignees = scopeDeptIds.length
      ? await tx
          .select({ id: assignment.employmentId })
          .from(assignment)
          .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
      : [];
    const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
    const scopeFilter =
      scopeDeptIds.length || scopeExplicitIds.length
        ? inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'])
        : undefined;

    // Active employees of the batch's company/scope in the period WITH an active FIXED zakat election.
    const rows = await tx
      .select({ employmentId: employment.id, zakatFixed: employeeStatutoryMy.zakatFixed })
      .from(employment)
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          eq(employeeStatutoryMy.zakatActive, true),
          eq(employeeStatutoryMy.zakatMethod, 'fixed'),
          scopeFilter,
        ),
      );

    let applied = 0;
    for (const r of rows) {
      const amount = round2(Number(r.zakatFixed ?? 0));
      if (amount <= 0) continue;
      await setPayrollDeductionInput(ctx, { batchId: p.batchId, employmentId: r.employmentId, zakat: amount });
      applied += 1;
    }
    return { applied };
  });
}

/**
 * Prefill a draft batch's overtime inputs from classified attendance (ADR-0011 → money).
 * Per employee, the period's per-day OT minutes (workday / rest day / holiday) are
 * monetized by the country pack — ORP = wages/26, 1.5× workday, rest-day ½/1-day rule
 * + 2×, holiday +2 days' ORP + 3×, and the First Schedule RM4,000 eligibility gate
 * (STATUTORY-SOURCES §6). Existing bonus inputs are preserved; the admin can still
 * override any figure. Each applied row appends an input-set event carrying the
 * derivation, so every ringgit is traceable to hours and rates.
 */
export async function prefillOvertimeFromAttendance(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        country: company.country,
        statutoryTier: company.statutoryTier,
        companyName: company.legalName,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    // ADR-0080 D-14 — payroll is a statutory computation and is refused for a non-statutory company,
    // BY TIER rather than by the pack happening to be missing. The distinction matters to whoever reads
    // the error: "No localization pack for country TH" reads as a bug to be fixed, while "this is a
    // non-statutory company" reads as the deliberate arrangement it is. Checked BEFORE the pack lookup
    // so the tier is what speaks.
    assertStatutory(batch.statutoryTier, 'Payroll', batch.companyName);
    const pack = packFor(batch.country);
    if (!pack) throw new Error(`No localization pack for country ${batch.country}`);

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019): DB override or the verified default. The
    // statutory month stays CALENDAR-bound by law — the cut-off window below moves only which OT transactions
    // land in the run, never the statutory month they contribute in.
    const rules = await pack.payroll.loadRuleset(tx, { asOf: periodEnd });

    // c7fdfcf6 (Payroll Schedule) — resolve the OVERTIME cut-off window for this run: OT transactions are pulled
    // from `[cut-off window]` instead of the fixed calendar month. Absent/calendar config ⇒ the window IS the
    // calendar month, so the query below is byte-identical for an unconfigured company.
    // Gap-fix (per-employment cut-off): the OT window is resolved PER employment (its assigned policy), not only
    // against the company default. The SQL fetch widens to the UNION of every active policy's OT window, then each
    // row is filtered to its own employment's window below. When no policy shifts the window the union equals the
    // calendar month, so the fetch is byte-identical for an unconfigured company.
    const otSched = await loadBatchCutOffSchedule(tx, batch.companyId);
    const otWindow = await unionTypeWindow(tx, otSched, batch.companyId, 'overtime', batch.payPeriod);
    // When the union already IS the calendar month, every per-employment window is the calendar month too, so the
    // per-row filter is a no-op and we skip the per-employment policy resolution entirely (byte-identical path).
    const otPerEmployment = otWindow.start !== periodStart || otWindow.end !== periodEnd;
    const otWindowCache = new Map<string, { start: string; end: string }>();

    // Per-day classified OT minutes within the cut-off window (per-day matters: the
    // rest-day ½/1-day rule cannot be computed from monthly aggregates). A day already banked as
    // time-in-lieu is excluded — see EXCLUDE_TOIL_BANKED_DAYS for why it is unconditional and why the
    // per-cycle read below shares the same expression.
    const excludeToilDays = EXCLUDE_TOIL_BANKED_DAYS;
    const otRowsRaw = await tx
      .select({
        employmentId: attendance.employmentId,
        attendanceDate: attendance.attendanceDate,
        dayType: attendance.dayType,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(attendance.attendanceDate, otWindow.start),
          lte(attendance.attendanceDate, otWindow.end),
          gt(attendance.otMinutes, 0),
          excludeToilDays,
        ),
      );
    // Gap-fix: keep only rows inside each employment's OWN overtime window (no-op when otPerEmployment is false).
    const otRows: typeof otRowsRaw = [];
    for (const r of otRowsRaw) {
      if (!otPerEmployment) {
        otRows.push(r);
        continue;
      }
      const w = await employmentTypeWindow(tx, otSched, otWindowCache, r.employmentId, 'overtime', batch.payPeriod);
      if (r.attendanceDate >= w.start && r.attendanceDate <= w.end) otRows.push(r);
    }
    if (otRows.length === 0) return { applied: 0, ineligible: 0 };
    const empIds = [...new Set(otRows.map((r) => r.employmentId))];

    // Current s.2 wages (basic + fixed allowance) — the ORP basis.
    const comps = await tx
      .select({
        employmentId: compensation.employmentId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, empIds),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      );
    const wagesBy = new Map(
      comps.map((c) => [c.employmentId, round2(Number(c.basic) + Number(c.allowance ?? 0))]),
    );

    // Existing inputs: bonus must survive the prefill.
    const existing = await tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        bonus: payrollInput.bonusAmount,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const existingBy = new Map(existing.map((r) => [r.employmentId, r]));

    const daysBy = new Map<string, { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number }[]>();
    for (const r of otRows) {
      const arr = daysBy.get(r.employmentId) ?? [];
      arr.push({ dayType: r.dayType ?? 'workday', minutes: r.otMinutes ?? 0 });
      daysBy.set(r.employmentId, arr);
    }

    let applied = 0;
    let ineligible = 0;
    for (const employmentId of empIds) {
      const wages = wagesBy.get(employmentId);
      if (wages == null) continue; // no active compensation — nothing to monetize against
      const result = pack.payroll.overtimePay({
        monthlyWages: wages,
        days: daysBy.get(employmentId) ?? [],
        wageCeiling: rules.ot.wageCeiling,
        restDayExcessMultiplier: rules.ot.restDayExcessMultiplier,
        holidayExcessMultiplier: rules.ot.holidayExcessMultiplier,
      });
      if (!result.eligible) {
        ineligible += 1;
        continue; // > RM4,000 wages: no statutory OT — left for a manual (ex-gratia) entry
      }
      const prior = existingBy.get(employmentId);
      const bonusAmount = prior ? Number(prior.bonus) : 0;
      if (prior) {
        await tx
          .update(payrollInput)
          // Reset any prior manual rate-bucket split: the statutory total is now the source, and a stale
          // decomposition that no longer sums to overtimeAmount would only confuse a later re-edit. Nothing
          // downstream reads ot_breakdown, so NULL is harmless and avoids the mismatch.
          // Fix-5 (M#17): stamp ot_source='attendance' so the editor knows this row is engine-derived and
          // warns before a casual manual Save overwrites it.
          .set({ overtimeAmount: result.total.toFixed(2), otBreakdown: null, otSource: 'attendance', updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          overtimeAmount: result.total.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          // Fix-5 (M#17): attendance-derived provenance.
          otSource: 'attendance',
        });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.input-set',
        actor: actorOf(ctx),
        payload: {
          employmentId,
          overtimeAmount: result.total,
          bonusAmount,
          source: 'attendance',
          derivation: {
            orp: result.orp,
            hourly: result.hourly,
            workday: result.workday,
            restDay: result.restDay,
            holiday: result.holiday,
          },
        },
      });
      applied += 1;
    }
    return { applied, ineligible };
  });
}

/**
 * Prefill the SHIFT_DIFFERENTIAL pay-component from worked differential shifts in the period (ADR-0032 C5).
 * A shift's `differential` is a CONFIGURABLE employer premium (NOT statutory): flat_per_shift (RM/shift),
 * flat_hourly (RM/worked hour), or percent (% uplift on the ORP hourly rate × worked hours). Rides the
 * typed-pay-component path: gated by TYPED_PAY_COMPONENTS_ENABLED (off ⇒ no-op, since the kernel wouldn't
 * read the batch component anyway). The component's flags (EPF/SOCSO/PCB yes, HRDF no) drive the statutory
 * treatment when the payslip is generated.
 */
export async function prefillShiftDifferentialFromRoster(ctx: SessionContext, p: { batchId: string }) {
  if (!isModuleEnabled(ctx, 'typed_pay_components')) return { applied: 0, gated: true as const };
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [comp] = await tx.select({ id: payComponent.id }).from(payComponent).where(eq(payComponent.code, 'SHIFT_DIFFERENTIAL')).limit(1);
    if (!comp) throw new Error('SHIFT_DIFFERENTIAL pay-component is not seeded — run the catalog seed first');

    // c7fdfcf6 (Payroll Schedule) — shift-differential is derived from ATTENDANCE, so it follows the attendance
    // cut-off window. Absent/calendar config ⇒ the window is the calendar month (byte-identical).
    // Gap-fix (per-employment cut-off): the attendance window is resolved PER employment (its assigned policy).
    // The SQL fetch widens to the UNION of every active policy's attendance window, then each row is filtered to
    // its own employment's window below. Union == calendar month when nothing shifts it ⇒ byte-identical fetch.
    const shiftSched = await loadBatchCutOffSchedule(tx, batch.companyId);
    const attWindow = await unionTypeWindow(tx, shiftSched, batch.companyId, 'attendance', batch.payPeriod);
    const [sy, sm] = batch.payPeriod.split('-').map(Number);
    const shiftPeriodStart = `${batch.payPeriod}-01`;
    const shiftPeriodEnd = `${batch.payPeriod}-${String(daysInMonth(sy, sm)).padStart(2, '0')}`;
    const attPerEmployment = attWindow.start !== shiftPeriodStart || attWindow.end !== shiftPeriodEnd;
    const attWindowCache = new Map<string, { start: string; end: string }>();

    // Worked differential shifts in the cut-off window for this company (the actual attendance row joined to the
    // rostered shift, keeping only shifts that carry a differential).
    const rowsRaw = await tx
      .select({ employmentId: attendance.employmentId, attendanceDate: attendance.attendanceDate, workedMinutes: attendance.workedMinutes, differential: shift.differential })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .innerJoin(
        rosterAssignment,
        and(eq(rosterAssignment.employmentId, attendance.employmentId), eq(rosterAssignment.shiftDate, attendance.attendanceDate)),
      )
      .innerJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(attendance.attendanceDate, attWindow.start),
          lte(attendance.attendanceDate, attWindow.end),
          gt(attendance.workedMinutes, 0),
          isNotNull(shift.differential),
        ),
      );
    // Gap-fix: keep only rows inside each employment's OWN attendance window (no-op when attPerEmployment false).
    const rows: typeof rowsRaw = [];
    for (const r of rowsRaw) {
      if (!attPerEmployment) {
        rows.push(r);
        continue;
      }
      const w = await employmentTypeWindow(tx, shiftSched, attWindowCache, r.employmentId, 'attendance', batch.payPeriod);
      if (r.attendanceDate >= w.start && r.attendanceDate <= w.end) rows.push(r);
    }
    if (rows.length === 0) return { applied: 0 };
    const empIds = [...new Set(rows.map((r) => r.employmentId))];

    // ORP hourly rate (s.2 wages / 26 / 8) — only needed for percent differentials.
    const comps = await tx
      .select({ employmentId: compensation.employmentId, basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
      .from(compensation)
      .where(and(inArray(compensation.employmentId, empIds), isNull(compensation.validTo), isNull(compensation.supersededAt)));
    const hourlyBy = new Map(comps.map((c) => [c.employmentId, (Number(c.basic) + Number(c.allowance ?? 0)) / 26 / 8]));

    const totalBy = new Map<string, number>();
    for (const r of rows) {
      const diff = r.differential as ShiftDifferential | null;
      if (!diff) continue;
      const hours = (r.workedMinutes ?? 0) / 60;
      let amt = 0;
      if (diff.kind === 'flat_per_shift') amt = diff.value;
      else if (diff.kind === 'flat_hourly') amt = diff.value * hours;
      else if (diff.kind === 'percent') amt = (hourlyBy.get(r.employmentId) ?? 0) * hours * (diff.value / 100);
      totalBy.set(r.employmentId, (totalBy.get(r.employmentId) ?? 0) + amt);
    }

    let applied = 0;
    for (const [employmentId, total] of totalBy) {
      if (total <= 0) continue;
      await setPayrollBatchComponent(ctx, { batchId: batch.id, employmentId, componentId: comp.id, amount: round2(total), notes: 'Shift differential (from roster)' }, tx);
      applied += 1;
    }
    return { applied };
  });
}

export async function generatePayslips(
  ctx: SessionContext,
  p: {
    batchId: string;
    /**
     * Selective in-place reprocessing (feedback 9bc442bc, reporter ask #3 + #8). When present, the batch
     * must already be PROCESSED: only these employees' payslips are recomputed, the others stay physically
     * untouched, batch totals/GL are updated BY DELTA (old-subset subtracted, new-subset added), and the
     * batch stays processed. This reuses the whole compute path below for byte-faithful figures; only the
     * employee filter and the final write differ. Loan-ledger apply + claim-paid side-effects run ONLY on
     * the full draft→processed generation, never on a subset reprocess (those were already applied at the
     * original processing and the preserved payroll_input rows reproduce the same loan/claim lines).
     */
    reprocessSubset?: { employmentIds: string[]; reason?: string; actorId?: string };
  },
) {
  const subset = p.reprocessSubset ?? null;
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, p.batchId)).limit(1);
    if (!batch) throw new Error('batch not found');
    if (subset) {
      // Reprocess target must be a processed run (a draft has nothing to reprocess; a closed run is frozen).
      if (batch.status !== 'processed') throw new BatchNotResettableError();
    } else if (batch.status !== 'draft') {
      throw new BatchNotDraftError();
    }

    // Pre-processing validation (feedback f1564110, Phase 1): a full draft→processed generation is
    // BLOCKED while any scoped, period-active employee has no current compensation row — previously
    // those employees were silently dropped by the inner join below. Fails closed BEFORE any write,
    // so there is deliberately no DomainEvent (nothing changed state). Warning-class gaps (missing
    // statutory profile / bank details) do not block here — the operator confirms them explicitly in
    // generateAction. A subset reprocess targets a processed run that already passed this gate.
    if (!subset) {
      const checks = await preProcessChecksTx(tx, { companyId: batch.companyId, payPeriod: batch.payPeriod, scope: batch.scope }, isModuleEnabled(ctx, 'typed_pay_components'));
      // BLOCKER: no compensation row covering the period (a missing open row is silently dropped by the
      // earnings inner-join; an effective date past the period is a salary the period never had) OR a zero
      // basic/rate (feedback 64fb5e48 — the Personnel record would pay nothing). The old BASIC-component
      // existence blocker is GONE (feedback 64fb5e48): the Personnel Basic Salary record is the
      // authoritative pay source, so an internal BASIC pay item is never a processing prerequisite.
      // ADR-0078 adds unpayablePayMode: a custom_period employee has NO calculation and must not be quietly
      // paid their monthly-equivalent basic. staleBasicComponent is a WARNING and never blocks.
      const blocked =
        checks.missingCompensation.length +
        (checks.zeroBasic?.length ?? 0) +
        (checks.unpayablePayMode?.length ?? 0);
      if (blocked > 0) throw new PreProcessBlockedError(blocked);
    }

    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, batch.companyId))
      .limit(1);
    const pack = packFor(co?.country);
    if (!pack) throw new Error(`No localization pack for ${co?.country ?? 'company'}`);

    // HRD Corp levy registration band for this employer (Wave 2A). Default not_registered = no levy,
    // so a company that hasn't set its band produces byte-identical payroll to pre-HRDF.
    const [coStat] = await tx
      .select({ hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, batch.companyId))
      .limit(1);
    const hrdfStatus = coStat?.hrdfStatus ?? 'not_registered';

    // Active employees with current compensation.
    const { payPeriod } = batch;
    const [pYear, pMonth] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019 / ADR-0020). Loaded ONCE with its provenance
    // (source + packVersion + signedKeyId) and threaded into the (pure, synchronous) calculators below; the
    // ruleset `version` + pack provenance are snapshotted onto every payslip so a later edit/pack can never
    // alter this batch, and a forged/wrong-pack incident is traceable to the key + packVersion that produced it.
    const resolved = await pack.payroll.loadRulesetResolved(tx, { asOf: periodEnd });
    const rules = resolved.ruleset;
    // #6 (ADR-0037): per-body provenance to stamp on each payslip — but ONLY when a component override
    // is actually in effect, so a tenant with no overrides keeps a byte-identical statutory snapshot.
    const anyComponentOverride = Object.values(resolved.components).some((c) => c.source === 'component');
    const componentVersions = anyComponentOverride
      ? (Object.fromEntries(Object.entries(resolved.components).map(([b, c]) => [b, c.version])) as Record<string, string>)
      : null;
    const statutoryProvenance =
      resolved.source === 'pack' ? { packVersion: resolved.packVersion, signedKeyId: resolved.signedKeyId } : {};

    // Subset selection (1E, #23): narrow the active set to the chosen departments / individuals; an
    // absent/empty scope ⇒ the whole company (unchanged behaviour).
    const sc = (batch.scope ?? null) as BatchScope | null;
    const scopeDeptIds = sc?.departmentIds ?? [];
    const scopeExplicitIds = sc?.employmentIds ?? [];
    // Employment has no department column — the link is the effective-dated assignment. Resolve chosen
    // departments → their current assignees, unioned with any explicitly-named individuals.
    const deptAssignees = scopeDeptIds.length
      ? await tx
          .select({ id: assignment.employmentId })
          .from(assignment)
          .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
      : [];
    const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
    const scopeFilter =
      scopeDeptIds.length || scopeExplicitIds.length
        ? inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'])
        : undefined;
    const scopeConstrained = scopeDeptIds.length > 0 || scopeExplicitIds.length > 0;

    // f1564110 Phase 2 — attach-on-generate (amends ADR-0056). One-off individual transactions keyed in
    // BEFORE this run existed (batch_id NULL, matching company + pay month) are stamped onto this batch now,
    // inside the same transaction, so the ledger they belong to is the run that pays the month. REGULAR run
    // only: in multi-cycle months the off-cycle/bonus/adjustment runs keep explicit-batch targeting via the
    // wizard, so an unattached row can never be double-collected by a sibling run. Full draft→processed
    // generation only (a subset reprocess recomputes a processed run whose ledger is already attached).
    // Scope-constrained runs collect only in-scope employees' rows; the rest stay unattached for a later
    // (re)generation or a widened scope. Kernel consumption of the attached rows is Phase 3 (flag-gated);
    // attaching here is the substrate that makes that fold — and the payslip-side audit trail — possible.
    if (!subset && batch.runType === 'regular') {
      const attachedTxns = await tx
        .update(payrollIndividualTxn)
        .set({ batchId: p.batchId })
        .where(
          and(
            isNull(payrollIndividualTxn.batchId),
            eq(payrollIndividualTxn.companyId, batch.companyId),
            eq(payrollIndividualTxn.payPeriod, batch.payPeriod),
            scopeConstrained
              ? inArray(
                  payrollIndividualTxn.employmentId,
                  scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'],
                )
              : undefined,
          ),
        )
        .returning({
          id: payrollIndividualTxn.id,
          employmentId: payrollIndividualTxn.employmentId,
          kind: payrollIndividualTxn.kind,
        });
      for (const t of attachedTxns) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: t.id,
          eventType: 'payroll.individual-txn.attached',
          actor: actorOf(ctx),
          subjectEmploymentId: t.employmentId,
          payload: { batchId: p.batchId, companyId: batch.companyId, payPeriod: batch.payPeriod, kind: t.kind },
        });
      }
    }

    // Anyone employed for at least part of the period: hired on/before period end AND not
    // terminated before period start. Mid-period joiners/leavers get a prorated (final) payslip.
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        // ADR-0078 (642ecc55) — the employee's OWN salary structure: `basic` stays the monthly-equivalent
        // wage for every statutory/derived read; payMode + rateAmount drive the daily/hourly basic-pay
        // branches below (the rate source moved here from policy.payRule in migration 0290).
        payMode: compensation.payMode,
        rateAmount: compensation.rateAmount,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
        // Item d64d0df4 — registered disabled individual (OKU). Drives the FURTHER annual deduction in the
        // PCB projection of P; the amount itself is statutory and comes from the country pack's ruleset.
        disabledIndividual: employeeStatutoryMy.disabledIndividual,
        // Item d64d0df4 — the spouse's OKU status (a further deduction, gated by the pack to tax
        // category 2 exactly as the spouse deduction is), plus the child-relief MODE and the keyed
        // category GRID. The grid is read ONLY when the mode is 'auto_table'; num_children below stays
        // the whole head count for Form E / CP8D / EA regardless of mode.
        disabledSpouse: employeeStatutoryMy.disabledSpouse,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
        isResident: employeeStatutoryMy.isResident,
        // Item 8b5334db — tax residency drives the PCB method (resident MTD / non-resident flat 30% / REP +
        // Knowledge Worker flat 15%); employer_bears_tax funds the employee's PCB from employer cost.
        taxResidency: employeeStatutoryMy.taxResidency,
        employerBearsTax: employeeStatutoryMy.employerBearsTax,
        eisEligible: employeeStatutoryMy.eisEligible,
        // SOCSO / EIS contribution-category override (item a7271737) — 'auto' keeps the age/citizenship
        // derivation below; 'first'/'second' pin the SOCSO band; 'none' zeroes the SOCSO/EIS leg respectively.
        socsoCategory: employeeStatutoryMy.socsoCategory,
        eisCategory: employeeStatutoryMy.eisCategory,
        // SOCSO & EIS statutory controls (item 5a461b99) — subject_to_* gate the scheme; employer_bears_*
        // fund the employee's share from employer cost without deducting it from net.
        subjectToSocso: employeeStatutoryMy.subjectToSocso,
        subjectToSkbbk: employeeStatutoryMy.subjectToSkbbk,
        employerBearsSocso: employeeStatutoryMy.employerBearsSocso,
        employerBearsEis: employeeStatutoryMy.employerBearsEis,
        employerBearsSkbbk: employeeStatutoryMy.employerBearsSkbbk,
        // Item 0d9bb2da — employer bears the employee's EPF share (EPF still computed + reported in full;
        // only the funding of the employee leg moves to employer cost). Off by default ⇒ byte-identical.
        employerBearsEpf: employeeStatutoryMy.employerBearsEpf,
        // Feedback 0df0c635 — per-employee "Subject to HRDF" (Others Statutory card). Tri-state: null
        // follows the company registration default (byte-identical); explicit false excludes the
        // employee's base from the HRD Corp levy; explicit true keeps it in.
        subjectToHrdf: employeeStatutoryMy.subjectToHrdf,
        epfCitizenship: employeeStatutoryMy.epfCitizenship,
        epfMode: employeeStatutoryMy.epfMode,
        epfEmployeeRate: employeeStatutoryMy.epfEmployeeRate,
        epfEmployerRate: employeeStatutoryMy.epfEmployerRate,
        dateOfBirth: person.dateOfBirth,
        tp3Year: employeeStatutoryMy.tp3Year,
        tp3Net: employeeStatutoryMy.tp3NetRemuneration,
        tp3Epf: employeeStatutoryMy.tp3EpfClaimed,
        tp3Pcb: employeeStatutoryMy.tp3PcbPaid,
        tp3Zakat: employeeStatutoryMy.tp3ZakatPaid,
        // 1.2.4 Zakat election (per-employee). The current row is read like every other statutory field
        // (this config class is not effective-dated); effective from/to are display-only and not read here.
        zakatActive: employeeStatutoryMy.zakatActive,
        zakatMethod: employeeStatutoryMy.zakatMethod,
        zakatPercent: employeeStatutoryMy.zakatPercent,
        zakatFixed: employeeStatutoryMy.zakatFixed,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          scopeFilter,
          // Selective reprocess (9bc442bc): narrow the recompute to exactly the picked employees, intersected
          // with the company set above so a stale/cross-company id can never widen the run.
          subset
            ? inArray(
                employment.id,
                subset.employmentIds.length ? subset.employmentIds : ['00000000-0000-0000-0000-000000000000'],
              )
            : undefined,
        ),
      );

    // Per-employee inputs: manual overtime (entered on the draft batch) + auto-derived unpaid days.
    const dim = daysInMonth(pYear, pMonth);
    const inputRows = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        claimAllowance: payrollInput.claimAllowance,
        loanDeduction: payrollInput.loanDeduction,
        // Fix-5 (M#17): OT provenance, snapshotted onto each payslip below so an auditor can see whether the
        // overtime figure was attendance-derived (statutory engine) or hand-keyed by the admin.
        otSource: payrollInput.otSource,
        // 2.1.1 (ADR-0064 1e): the OT rate-bucket decomposition — read here so the policy OT-cap wrapper can
        // filter by eligible day type / re-rate the workday leg. NULL ⇒ a flat figure (caps degrade to the
        // total-only ceilings: maxAmount). Nothing else downstream reads it.
        otBreakdown: payrollInput.otBreakdown,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const overtimeByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.overtime)]));
    // Widened to string: f1564110 Phase 3 stamps 'individual-txn' provenance when one-off OT rows feed the
    // figure (the payslip snapshot is plain jsonb, so the wider type is safe end-to-end).
    const otSourceByEmp = new Map<string, string | null>(inputRows.map((r) => [r.employmentId, r.otSource ?? null]));
    const otBreakdownByEmp = new Map(inputRows.map((r) => [r.employmentId, r.otBreakdown ?? null]));
    const bonusByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1ByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.zakat)]));
    // Approved taxable claims prefilled into this batch (ADR-0021): ride the taxable allowance base.
    const claimAllowanceByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.claimAllowance)]));
    // 1.2.8 Loan instalment(s) reserved on this batch (ADR-0060): POST-TAX, read unconditionally, subtracted
    // after statutory like tp1/zakat. The ledger is advanced by applyLoansForBatch AFTER the payslip loop.
    const loanByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.loanDeduction)]));
    // 1.2.8 C1 fix: the ACTUAL loan recovered per employee after the authoritative net≥0 clamp (cents). The
    // payslip loop fills this; applyLoansForBatch advances the ledger by these actuals (NOT the reserved due).
    const appliedLoanCentsByEmp = new Map<string, number>();
    // M#16 (EA s.24 net-floor): per-employee record of any post-tax deduction the period's headroom could
    // not fully recover (manual deduct / CP38 / loan clamped). Surfaced as a batch-level warning event so a
    // clamp is never silent. Empty ⇒ no event (byte-identical no-clamp path).
    const deductionClampsByEmp = new Map<
      string,
      { manualRequested: number; manualApplied: number; cp38Requested: number; cp38Applied: number; loanRequested: number; loanApplied: number }
    >();
    // c7fdfcf6 (Payroll Schedule) — the company-level cut-off schedule (company_payroll_config day columns +
    // the company-default policy's config). Loaded ONCE; each transaction type's window resolves against it,
    // falling back to the plain calendar month when nothing is configured (byte-identical). Per-employment
    // policy overrides for the SALARY window are applied in the loop below (the policy is resolved there).
    const cutOffSchedule = await loadBatchCutOffSchedule(tx, batch.companyId);
    // c7fdfcf6 gap-fix — the run READS the company-default schedule's payroll FREQUENCY and GENERATES the
    // ordered cut-off periods it produces for this statutory month (monthly ⇒ one period; weekly/biweekly ⇒ the
    // tiled 7/14-day cycles). Recorded on the processed event for audit + surfaced to operators; the wages still
    // aggregate into the one calendar month for EPF/SOCSO/EIS/PCB by law.
    const runFrequency = payrollFrequencyOf(cutOffSchedule.defaultConfig);
    const runSchedule = payrollScheduleFor(cutOffSchedule.defaultConfig, cutOffSchedule.companyCfg, payPeriod);
    // Unpaid-leave selection follows the LEAVE cut-off window. Gap-fix (per-employment cut-off): the leave window
    // is resolved PER employment (its assigned policy → company column → calendar), then employments are GROUPED
    // by window and unpaid days are queried per group — so employments on different (non-default) policies each
    // get their own leave window instead of sharing the company default. Populated in the policy loop below, then
    // queried after it. Absent/calendar config ⇒ one group == [M-01 … M-end] (byte-identical to the legacy query).
    const leaveWindowByEmp = new Map<string, { start: string; end: string }>();
    const unpaidByEmp = new Map<string, number>();
    // f3148da1 Step 5 (R17 gap-fix reinstatement) — the PARTIAL-DAY (time-off) subset of unpaidByEmp, populated
    // ONLY for employments whose policy configures a distinct unpaidTimeOffDivisor (see the group query below).
    const unpaidTimeOffByEmp = new Map<string, number>();

    // ── 2.1.1 (ADR-0064) — Monthly payroll-policy General Settings, resolved at RUN TIME ──
    // The load-bearing new plumbing: for each employment, resolve its assigned policy's config (raw
    // tenant-scoped SQL inside this Tx, under the caller's session). A null/inactive/unassigned policy ⇒
    // null config ⇒ the legacy code path is unchanged (the default-equals-legacy golden matrix proves it).
    // This is a DERIVED READ on every compute — it appends NO DomainEvent (substrate "no event for derived
    // recomputation" rule). Resolved ONCE here, before the loop, so each primitive reads a map not a re-query.
    const policyConfigByEmp = new Map<string, PayrollPolicyConfig | null>();
    // Working-day proration needs the holiday set per employment; resolve it lazily only when a config asks
    // for a working-day basis, so the default (calendar) path issues NO extra query.
    const prorationOptsByEmp = new Map<
      string,
      { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> }; window?: { start: string; end: string } }
    >();
    // c7fdfcf6 (Payroll Schedule) — per-employment SALARY cut-off window day count, feeding the `cutoff_days`
    // leave-divisor fact (activating the already-shipped 'cutoff_days' divisor selector). Absent config ⇒ `dim`.
    const salaryCutoffDaysByEmp = new Map<string, number>();
    // ── 2.1.2 — Daily payroll policy: rate × eligible days worked, NO monthly proration ──
    // For an employment on an ACTIVE policyType='daily' policy carrying a per_day PayRule, basic pay is the
    // per-day rate × the number of eligible working days in the period (Mon–Fri roster minus holidays, clamped
    // to the employment's tenure window) — the monthly-salary proration path is BYPASSED entirely. A null /
    // inactive / monthly / unassigned policy never populates this map, so the legacy monthly path is unchanged
    // (proven byte-identical). Resolved ONCE here so the per-employee loop reads a map, not a re-query.
    const dailyPayByEmp = new Map<string, { rate: number; eligibleDays: number; basic: number }>();
    for (const e of emps) {
      const policy = await resolveAssignedPolicy(tx, e.employmentId);
      const cfg = policy?.config ?? null;
      policyConfigByEmp.set(e.employmentId, cfg);
      // 1b / Step 3 (f3148da1) — proration divisor + working-day basis, resolved once per employee. The formula
      // is PER-EVENT: a resigned partial month uses the "Resigned Employee Basic Salary Formula", a new-hire
      // partial month uses the "New Hire Basic Salary Formula", each falling back to the shared proration. A
      // full month (neither) uses the shared default (inert — the factor is 1 regardless).
      const isHire = e.hiredOn > periodStart;
      const isResign = !!(e.terminatedOn && e.terminatedOn < periodEnd);
      const prorationSettings = resolveProrationSettings(cfg, { isHire, isResign });
      const divisorDays = prorationDivisorDays(prorationSettings, dim);
      const opts: { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> }; window?: { start: string; end: string } } = {};
      if (divisorDays !== dim) opts.divisorDays = divisorDays;
      if (usesWorkingDayProration(prorationSettings)) {
        const holidays = (prorationSettings?.includeHoliday ?? false)
          ? new Set<string>() //              holidays count as worked days ⇒ empty exclusion set
          : await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        opts.workingDayBasis = { roster: workingDayRoster(prorationSettings), holidays };
      }
      // c7fdfcf6 (Payroll Schedule) — the SALARY cut-off window for this employment (policy override → company
      // column → calendar). When it is a real (non-calendar) window, drive the join-date/resignation proration
      // by it and record its length for the cutoff_days leave divisor; a calendar/absent config leaves both at
      // the legacy calendar-month behaviour (byte-identical).
      const salaryWindow = cutOffWindowFor('salary', cfg, cutOffSchedule.companyCfg, payPeriod);
      const salaryWindowDays =
        Math.round((Date.parse(`${salaryWindow.end}T00:00:00Z`) - Date.parse(`${salaryWindow.start}T00:00:00Z`)) / 86_400_000) + 1;
      if (salaryWindow.start !== periodStart || salaryWindow.end !== periodEnd) {
        opts.window = salaryWindow;
        salaryCutoffDaysByEmp.set(e.employmentId, salaryWindowDays);
      }
      if (opts.divisorDays !== undefined || opts.workingDayBasis || opts.window) prorationOptsByEmp.set(e.employmentId, opts);
      // Gap-fix (per-employment cut-off) — this employment's LEAVE cut-off window (policy → company → calendar).
      leaveWindowByEmp.set(e.employmentId, cutOffWindowFor('leave', cfg, cutOffSchedule.companyCfg, payPeriod));
      // 2.1.2 daily branch — ADR-0078: keyed off the EMPLOYEE'S pay_mode (compensation.pay_mode), with the
      // rate from compensation.rate_amount. The former policy.payRule source (and its fallback) is gone —
      // it could never express one daily employee among monthly colleagues on the same policy (resolveRule
      // accepts a per_day rule only on a daily policy). Eligible days = the employee's working days
      // (Mon–Fri) in the period, less public holidays, within their tenure window. Zero eligible days ⇒
      // basic = 0 (no divide-by-zero: this is a multiply, not a divide).
      if (e.payMode === 'daily' && e.rateAmount != null) {
        const rate = Number(e.rateAmount);
        const dailyHolidays = await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        const eligibleDays = eligibleWorkingDays(payPeriod, e.hiredOn, e.terminatedOn, dailyHolidays);
        dailyPayByEmp.set(e.employmentId, { rate, eligibleDays, basic: round2(rate * eligibleDays) });
      }
    }

    // Gap-fix (per-employment cut-off) — GROUP employments by their resolved LEAVE cut-off window, then query
    // unpaid days once per distinct window. Most companies: a single group == the calendar month, so this is one
    // query with the same result as the legacy tenant-wide call (byte-identical). A company with per-policy leave
    // cut-offs gets each group its own window.
    {
      const groups = new Map<string, string[]>();
      for (const e of emps) {
        const w = leaveWindowByEmp.get(e.employmentId) ?? { start: periodStart, end: periodEnd };
        const key = `${w.start}|${w.end}`;
        const arr = groups.get(key);
        if (arr) arr.push(e.employmentId);
        else groups.set(key, [e.employmentId]);
      }
      for (const [key, ids] of groups) {
        const [start, end] = key.split('|');
        const part = await unpaidDaysByEmployment(tx, start, end, ids);
        for (const [k, v] of part) unpaidByEmp.set(k, v);
      }
      // f3148da1 Step 5 (R17 gap-fix reinstatement) — UNPAID TIME OFF: for employments whose policy configures
      // a DISTINCT unpaidTimeOffDivisor, also count the PARTIAL-DAY unpaid subset (half-day / hourly requests)
      // per the same leave windows. The payslip loop values these days with the time-off formula and the
      // remaining full-day unpaid days with unpaidLeaveDivisor. No distinct divisor anywhere (the default) ⇒
      // this issues NO query and every unpaid day rides the legacy pooled path, byte-identical.
      const utoIds = new Set(
        emps
          .filter((e) => policyConfigByEmp.get(e.employmentId)?.leave?.unpaidTimeOffDivisor)
          .map((e) => e.employmentId),
      );
      if (utoIds.size > 0) {
        for (const [key, ids] of groups) {
          const scoped = ids.filter((id) => utoIds.has(id));
          if (scoped.length === 0) continue;
          const [start, end] = key.split('|');
          const part = await unpaidDaysByEmployment(tx, start, end, scoped, true);
          for (const [k, v] of part) unpaidTimeOffByEmp.set(k, v);
        }
      }
    }

    // c7fdfcf6 gap-fix (functional weekly/bi-weekly) — when the run's frequency is weekly/biweekly the statutory
    // month is split into the ordered cut-off CYCLES (runSchedule.periods). We bucket, PER cycle, each employee's
    // OT minutes (from attendance) and unpaid-leave days (from approved leave) by their transaction dates. The
    // payslip loop then disburses each employee's NET across the cycles proportional to each cycle's operational
    // earnings — turning a weekly employment into N distinct per-cycle pay amounts the employer can actually pay
    // out weekly, instead of one byte-identical monthly figure. Statutory contributions stay computed ONCE on the
    // calendar month by law; the single monthly payslip stays the compliance artifact + carries the cycle
    // breakdown. Monthly frequency (periods.length === 1) skips this whole block ⇒ monthly is byte-identical.
    const perCycle = runFrequency !== 'monthly' && runSchedule.periods.length > 1;
    const cycleOtMinutesByEmp = new Map<string, number[]>();
    const cycleUnpaidDaysByEmp = new Map<string, number[]>();
    if (perCycle) {
      const wStart = runSchedule.periods[0].start;
      const wEnd = runSchedule.periods[runSchedule.periods.length - 1].end;
      const cycleIndexOf = (date: string): number => runSchedule.periods.findIndex((pd) => date >= pd.start && date <= pd.end);
      // EXCLUDE_TOIL_BANKED_DAYS, same as the OT prefill. These are the two reads of
      // `attendance.otMinutes` in this file and they must agree about which days count: a day banked as
      // TOIL contributes no OT to the payslip, so letting it weight the cross-cycle disbursement pulled
      // the employee's net toward a cycle on the strength of minutes that were never paid as cash. It
      // only ever bit weekly/bi-weekly runs, which is why one read carried the clause and the other did
      // not — monthly skips this block entirely.
      const otCycleRows = await tx
        .select({ employmentId: attendance.employmentId, d: attendance.attendanceDate, m: attendance.otMinutes })
        .from(attendance)
        .innerJoin(employment, eq(employment.id, attendance.employmentId))
        .where(and(eq(employment.companyId, batch.companyId), gte(attendance.attendanceDate, wStart), lte(attendance.attendanceDate, wEnd), gt(attendance.otMinutes, 0), EXCLUDE_TOIL_BANKED_DAYS));
      for (const r of otCycleRows) {
        const ci = cycleIndexOf(r.d);
        if (ci < 0) continue;
        const arr = cycleOtMinutesByEmp.get(r.employmentId) ?? runSchedule.periods.map(() => 0);
        arr[ci] += r.m ?? 0;
        cycleOtMinutesByEmp.set(r.employmentId, arr);
      }
      // Unpaid days are attributed to the cycle the request STARTS in (mirrors unpaidDaysByEmployment's "deduct in
      // the period it starts" policy), using the approved per-date sum when present, else the request's own days.
      const perDateDays = sql<string>`coalesce((select sum(lrd.days) from leave_request_date lrd where lrd.leave_request_id = ${leaveRequest.id} and lrd.status = 'approved'), ${leaveRequest.days})`;
      const lvCycleRows = await tx
        .select({ employmentId: leaveRequest.employmentId, d: leaveRequest.startDate, days: perDateDays })
        .from(leaveRequest)
        .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
        .where(and(eq(leaveRequest.status, 'approved'), or(eq(leaveType.paid, false), eq(leaveRequest.allowanceEligible, false)), gte(leaveRequest.startDate, wStart), lte(leaveRequest.startDate, wEnd)));
      for (const r of lvCycleRows) {
        const ci = cycleIndexOf(r.d);
        if (ci < 0) continue;
        const arr = cycleUnpaidDaysByEmp.get(r.employmentId) ?? runSchedule.periods.map(() => 0);
        arr[ci] += Number(r.days);
        cycleUnpaidDaysByEmp.set(r.employmentId, arr);
      }
    }

    // 1f — working-days-in-period per employment, computed ONLY for employments whose leave config selects a
    // `working_days` divisor (so the default calendar path issues no extra query). Counts the employee's
    // working-day roster minus holidays across the whole period.
    const workingDaysByEmp = new Map<string, number>();
    const wdEmpIds = emps
      .filter((e) => {
        const l = policyConfigByEmp.get(e.employmentId)?.leave;
        return l?.unpaidLeaveDivisor === 'working_days' || l?.unpaidTimeOffDivisor === 'working_days' || l?.encashmentDivisor === 'working_days';
      })
      .map((e) => e.employmentId);
    for (const employmentId of wdEmpIds) {
      const holidays = await holidayDatesFor(tx, { employmentId, startDate: periodStart, endDate: periodEnd });
      const roster = [1, 2, 3, 4, 5]; // Mon–Fri working-day basis for the leave divisor (no Sat/Sun override here)
      let n = 0;
      for (let t = Date.parse(`${periodStart}T00:00:00Z`); t <= Date.parse(`${periodEnd}T00:00:00Z`); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        if (roster.includes(iso) && !holidays.has(d)) n++;
      }
      workingDaysByEmp.set(employmentId, n);
    }
    const workingDaysInPeriodFor = (employmentId: string): number => workingDaysByEmp.get(employmentId) ?? 0;

    // Step 4 (f3148da1) — OT exceed handling: resolve the "convert excess to pay item" component for every
    // employment whose policy configures `overtime.exceedHandling.action='convert'`. Loaded ONCE here (a
    // component is tenant-scoped, so RLS confines it to this tenant); a missing/archived component falls back
    // to today's cap-and-drop (the map simply has no entry ⇒ excess dropped). Default (no such policy) ⇒ the
    // map is empty and the legacy OT path is byte-identical.
    const otConvertByEmp = new Map<string, { code: string; name: string }>();
    const convertComponentIds = [
      ...new Set(
        emps
          .map((e) => policyConfigByEmp.get(e.employmentId)?.overtime?.exceedHandling)
          .filter((eh): eh is { action: 'convert'; componentId: string } => eh?.action === 'convert')
          .map((eh) => eh.componentId),
      ),
    ];
    if (convertComponentIds.length) {
      const comps = await tx
        .select({ id: payComponent.id, code: payComponent.code, name: payComponent.name, archivedAt: payComponent.archivedAt })
        .from(payComponent)
        .where(inArray(payComponent.id, convertComponentIds));
      const byId = new Map(comps.filter((c) => c.archivedAt == null).map((c) => [c.id, { code: c.code, name: c.name }]));
      for (const e of emps) {
        const eh = policyConfigByEmp.get(e.employmentId)?.overtime?.exceedHandling;
        if (eh?.action === 'convert') {
          const found = byId.get(eh.componentId);
          if (found) otConvertByEmp.set(e.employmentId, found);
        }
      }
    }

    // Step 2 carry_forward (f3148da1) — the outstanding negative-net balance carried from PRIOR CLOSED cycles,
    // DERIVED (no mutable balance table, mirroring the PCB accumulator replay) by summing each employment's
    // closed payslips' carry-forward stamps: balance = Σ(added − applied), positive = the employee still owes.
    // Computed ONLY for employments whose policy sets negativeNet='carry_forward' and ONLY on a regular run (an
    // additional/off-cycle run neither recovers nor defers). A rolled-back batch (status ≠ 'closed') drops out
    // automatically, so the balance always reflects finalized history. Default (no carry_forward policy) ⇒ the
    // map is empty and the legacy net path is byte-identical.
    const carryForwardByEmp = new Map<string, number>();
    if (batch.runType === 'regular') {
      const cfEmpIds = emps
        .filter((e) => policyConfigByEmp.get(e.employmentId)?.negativeNet === 'carry_forward')
        .map((e) => e.employmentId);
      if (cfEmpIds.length) {
        const cfRows = await tx
          .select({ employmentId: payslip.employmentId, statutory: payslip.statutory })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, cfEmpIds),
              eq(payrollBatch.status, 'closed'),
              lt(payrollBatch.payPeriod, payPeriod),
            ),
          );
        for (const r of cfRows) {
          const cf = (r.statutory as { carryForward?: { applied?: number; added?: number } } | null)?.carryForward;
          if (!cf) continue;
          const delta = round2(Number(cf.added ?? 0) - Number(cf.applied ?? 0));
          carryForwardByEmp.set(r.employmentId, round2((carryForwardByEmp.get(r.employmentId) ?? 0) + delta));
        }
      }
    }

    // 1c — salary-increment proration: the two straddling compensation rows (superseded old + open new) for
    // any employment whose policy enables it AND that has a mid-period increment. Resolved once; the loop
    // reads a per-employee blended basic. Default (off / single row) ⇒ the kernel's single open-row read is
    // untouched. Only fires when the new comp row exists at generate time (snapshot immutability, ADR-0036).
    const incrementBasicByEmp = new Map<string, number>();
    const incrementEmpIds = emps
      .filter((e) => policyConfigByEmp.get(e.employmentId)?.salaryIncrementProration)
      .map((e) => e.employmentId);
    if (incrementEmpIds.length) {
      const straddleRows = await tx
        .select({
          employmentId: compensation.employmentId,
          basic: compensation.basicSalary,
          validFrom: compensation.validFrom,
          validTo: compensation.validTo,
        })
        .from(compensation)
        .where(
          and(
            inArray(compensation.employmentId, incrementEmpIds),
            isNull(compensation.supersededAt),
            lte(compensation.validFrom, periodEnd),
            or(isNull(compensation.validTo), gte(compensation.validTo, periodStart)),
          ),
        );
      const byEmp = new Map<string, { basic: number; validFrom: string; validTo: string | null }[]>();
      for (const r of straddleRows) {
        const list = byEmp.get(r.employmentId) ?? [];
        list.push({ basic: Number(r.basic), validFrom: r.validFrom, validTo: r.validTo });
        byEmp.set(r.employmentId, list);
      }
      for (const [employmentId, rows] of byEmp) {
        if (rows.length < 2) continue; // no straddle ⇒ leave the kernel's single-row read alone
        rows.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
        const oldRow = rows[0];
        const newRow = rows[rows.length - 1];
        // The increment takes effect at the new row's validFrom. Blend: old × days-before + new × days-from.
        const incrementDate = newRow.validFrom;
        if (incrementDate <= periodStart || incrementDate > periodEnd) continue; // not a mid-period increment
        const daysBefore = Math.max(0, Number(incrementDate.slice(8, 10)) - 1); // days on the OLD rate
        const daysFrom = dim - daysBefore; //                                      days on the NEW rate
        const blended = round2((oldRow.basic * daysBefore + newRow.basic * daysFrom) / dim);
        incrementBasicByEmp.set(employmentId, blended);
      }
    }

    // ── PCB accumulators (ADR-0014) ──
    // The accumulators (∑(Y−K), K claimed, X) are DERIVED by replaying this tax year's prior
    // payslips per employment, in period order, applying the cumulative EPF relief cap — the
    // payslip history is the ledger; no mutable accumulator state. TP3 / opening balances on the
    // statutory profile seed the replay for mid-year joiners or mid-year system adoption.
    const EPF_RELIEF_CAP = pack.payroll.epfReliefCap; // pack-owned: cap math always matches the calculator
    type Acc = {
      netRemuneration: number;
      epfClaimed: number;
      pcbPaid: number;
      zakatPaid: number;
      lpAccumulated: number;
    };
    const empIds = emps.map((e) => e.employmentId);
    // 1.2.3 CP38 Deduction — the LHDN/court instalment in effect for THIS payroll month, per employment
    // (auto-apply by month). Folded into deductions + stamped onto statutory.cp38 below; an additional run
    // re-charges nothing (handled per-employee with isAdditionalRun, like slipUnpaid/hrdf).
    const cp38ByEmp = await cp38ForPeriod(tx, empIds, payPeriod);
    const priorSlips = empIds.length
      ? await tx
          .select({
            employmentId: payslip.employmentId,
            period: payrollBatch.payPeriod,
            gross: payslip.grossPay,
            statutory: payslip.statutory,
          })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, empIds),
              like(payrollBatch.payPeriod, `${pYear}-%`),
              lt(payrollBatch.payPeriod, payPeriod),
            ),
          )
      : [];
    priorSlips.sort((a, b) => a.period.localeCompare(b.period));
    const accByEmp = new Map<string, Acc>();
    for (const e of emps) {
      const tp3Applies = e.tp3Year === pYear;
      accByEmp.set(e.employmentId, {
        netRemuneration: tp3Applies ? Number(e.tp3Net ?? 0) : 0,
        epfClaimed: tp3Applies ? Math.min(Number(e.tp3Epf ?? 0), EPF_RELIEF_CAP) : 0,
        pcbPaid: tp3Applies ? Number(e.tp3Pcb ?? 0) : 0,
        zakatPaid: tp3Applies ? Number(e.tp3Zakat ?? 0) : 0,
        lpAccumulated: 0,
      });
    }
    // LHDN PCB 2026 (feedback 09b554e9) — per-code YTD exemption usage, DERIVED like the PCB accumulators:
    // each slip stamps the month's per-code exempt/claimed amounts as statutory.exemptionUsed, and the
    // replay sums them so the annual caps carry across months (no mutable balance table).
    const exemptUsedByEmp = new Map<string, Record<string, number>>();
    for (const s of priorSlips) {
      const acc = accByEmp.get(s.employmentId);
      if (!acc) continue;
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; lp?: number; zakat?: number; exemptionUsed?: Record<string, number> };
      const claimed = Math.min(Number(st.epfEmployee ?? 0), Math.max(0, EPF_RELIEF_CAP - acc.epfClaimed));
      acc.netRemuneration = round2(acc.netRemuneration + Number(s.gross) - claimed);
      acc.epfClaimed = round2(acc.epfClaimed + claimed);
      acc.pcbPaid = round2(acc.pcbPaid + Number(st.pcb ?? 0));
      acc.zakatPaid = round2(acc.zakatPaid + Number(st.zakat ?? 0)); // §E.5: full zakat accrues to Z
      acc.lpAccumulated = round2(acc.lpAccumulated + Number(st.lp ?? 0));
      if (st.exemptionUsed) {
        const used = exemptUsedByEmp.get(s.employmentId) ?? {};
        for (const [code, amt] of Object.entries(st.exemptionUsed)) {
          used[code] = round2((used[code] ?? 0) + Number(amt ?? 0));
        }
        exemptUsedByEmp.set(s.employmentId, used);
      }
    }

    // ── Multi-cycle (Wave 2C, ADR-0024) ──
    // For an ADDITIONAL run (run_type != regular), this run is additional remuneration computed by the
    // increment method (re-run the cumulative month, take the delta). Gather the additional remuneration
    // paid in earlier runs of this period + the month's overtime (carried by the regular run). The normal
    // wage (Y1) is recomputed per employee from compensation below — identical to the regular run's, so
    // the runs sum to the single-batch month by construction.
    const isAdditionalRun = batch.runType !== 'regular';
    const earlierRunByEmp = new Map<string, { additional: number; overtime: number }>();
    if (isAdditionalRun) {
      const earlier = await tx
        .select({
          employmentId: payslip.employmentId,
          bonus: payslip.bonus,
          ot: payslip.overtimePay,
          runType: payrollBatch.runType,
        })
        .from(payslip)
        .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
        .where(and(eq(payrollBatch.payPeriodId, batch.payPeriodId), lt(payrollBatch.runSeq, batch.runSeq)));
      for (const r of earlier) {
        const cur = earlierRunByEmp.get(r.employmentId) ?? { additional: 0, overtime: 0 };
        cur.additional = round2(cur.additional + Number(r.bonus));
        if (r.runType === 'regular') cur.overtime = round2(cur.overtime + Number(r.ot));
        earlierRunByEmp.set(r.employmentId, cur);
      }
    }

    // ── Typed pay components (Wave 3 #9, ADR-0025) ──
    // GATED: only when TYPED_PAY_COMPONENTS_ENABLED do we read the component tables as the earnings
    // source instead of compensation + payroll_input. The seeded component flags reproduce the legacy
    // agency split exactly, so a back-filled batch is byte-identical (proven by the compat test).
    const typedComponents = isModuleEnabled(ctx, 'typed_pay_components');
    type CompRow = {
      code: string; name: string; kind: string; amount: number; rounding: string;
      epf: boolean; socso: boolean; pcb: boolean; hrdf: boolean; nonPayable: boolean; prorates: boolean;
      // 1.2.1 Fixed Transaction — per-employee override of the catalog `prorates` flag (null = inherit). A
      // one-off batch component has no override, so this is null there too (⇒ catalog flag, unchanged).
      prorateOverride: boolean | null;
      rule: PayRule | null; // Payroll Setup — configurable pay-rule; null ⇒ stored amount (legacy behaviour).
      // 61bf109d — the rank recorded at save time (migration 0330). Components resolve in ascending order so
      // a rule that reads another pay item sees that item's final figure. 0 on every legacy row.
      resolutionOrder: number;
      // LHDN PCB 2026 classification (feedback 09b554e9). epfBonus2012 routes the amount down the
      // additional-remuneration EPF path regardless of the SOCSO flag; pcbRemunerationType (when declared)
      // overrides the epf/socso stream inference; pcbExemptionCode selects the annual exemption cap.
      // All null/false on legacy rows ⇒ byte-identical legacy fold.
      epfBonus2012: boolean;
      pcbRemunerationType: 'normal' | 'additional' | 'optional_deduction' | null;
      pcbExemptionCode: string | null;
      // Feedback 3c473773 — the DISPLAY box (payroll category), migration 0393. Presentation only: it never
      // reaches a statutory base, never changes the kernel bucket the amount is routed into, and never
      // changes a stored payslip column. null = unclassified ⇒ the box is inferred from the bucket exactly
      // as before. Backfilled to each row's CURRENT box, so a run is byte-identical unless someone has
      // deliberately re-categorised an item.
      displayCategory: string | null;
    };
    const recurringByEmp = new Map<string, CompRow[]>();
    const batchCompByEmp = new Map<string, CompRow[]>();
    if (typedComponents && empIds.length) {
      // Catalog + amount columns shared by both the recurring and the one-off batch query.
      const catCols = {
        amount: employmentPayComponent.amount,
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        epf: payComponent.includedInEpf,
        socso: payComponent.includedInSocsoEis,
        pcb: payComponent.includedInPcb,
        hrdf: payComponent.includedInHrdfBase,
        nonPayable: payComponent.isNonPayable,
        prorates: payComponent.prorates,
        rounding: payComponent.roundingMethod,
        rule: payComponent.rule, // Payroll Setup — read for the resolver (null on every legacy row).
        resolutionOrder: payComponent.resolutionOrder, // 61bf109d — recorded dependency rank (0 on legacy rows).
        // LHDN PCB 2026 classification (feedback 09b554e9) — null/false on every legacy row.
        epfBonus2012: payComponent.epfBonus2012,
        pcbRemunerationType: payComponent.pcbRemunerationType,
        pcbExemptionCode: payComponent.pcbExemptionCode,
        // Feedback 3c473773 — the declared payslip box (migration 0393). Read-only here; it is applied to
        // the DISPLAY overlay in earningsOf and to nothing else.
        displayCategory: payComponent.displayCategory,
      };
      const push = (map: Map<string, CompRow[]>, r: { employmentId: string; amount: string; prorateOverride?: boolean | null } & Omit<CompRow, 'amount' | 'prorateOverride'>) => {
        const list = map.get(r.employmentId) ?? [];
        list.push({ ...r, amount: Number(r.amount), prorateOverride: r.prorateOverride ?? null });
        map.set(r.employmentId, list);
      };
      const rec = await tx
        .select({
          ...catCols,
          employmentId: employmentPayComponent.employmentId,
          // 1.2.1 Fixed Transaction — per-employee prorate override (null = inherit catalog `prorates`).
          prorateOverride: employmentPayComponent.prorateOverride,
        })
        .from(employmentPayComponent)
        .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
        .where(
          and(
            inArray(employmentPayComponent.employmentId, empIds),
            // 1.2.1 Fixed Transaction — PERIOD-AWARE window, mirroring the employment/compensation filter
            // above (lte(hiredOn, periodEnd) / or(isNull(terminatedOn), gte(terminatedOn, periodStart))):
            //   • valid_from <= periodEnd        → the item has started by the end of this period
            //   • valid_to IS NULL OR >= periodStart → the item has not ended before this period starts
            //   • superseded_at IS NULL          → never apply a row that was replaced by a newer value
            // valid_to is an INCLUSIVE end-date: validTo == periodStart still applies (gte). The lte(valid_from,
            // periodEnd) clause is a no-op for legacy/backfilled rows (their valid_from is a past month, so
            // it is <= periodEnd) — proven by the legacy-window test. The activate/deactivate semantics here
            // are BINARY in/out of window by design: an item active for any part of the period pays its full
            // amount (times the employee tenure `factor`); per-item mid-month day-proration of the item's OWN
            // window is an explicit v1 non-goal (the spec ties prorate to join/resign, not the item window).
            lte(employmentPayComponent.validFrom, periodEnd),
            or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
            isNull(employmentPayComponent.supersededAt),
          ),
        );
      for (const r of rec) push(recurringByEmp, r);
      const bat = await tx
        .select({ ...catCols, employmentId: payrollBatchComponent.employmentId, amount: payrollBatchComponent.amount })
        .from(payrollBatchComponent)
        .innerJoin(payComponent, eq(payComponent.id, payrollBatchComponent.componentId))
        .where(eq(payrollBatchComponent.batchId, p.batchId));
      for (const r of bat) push(batchCompByEmp, r);
    }

    // ── f1564110 Phase 3 — individual (one-off) transaction consumption (amends ADR-0056) ──
    // GATED by INDIVIDUAL_TXN_PAY_ENABLED (default OFF ⇒ the ledger stays record-only and every payslip is
    // byte-identical to the pre-Phase-3 kernel — test/payroll-individual-txn.test.ts's inert test is the
    // flag-off guard). Flag on, the batch's (post-attach-on-generate) ledger rows fold into pay:
    //   • earning/deduction WITH a component → pushed into the existing batchCompByEmp fold as a CompRow, so
    //     the catalog's statutory flags (EPF/SOCSO/PCB/HRDF), rounding, prorates and non-payable treatment
    //     apply IDENTICALLY to a one-off batch component. The keyed amount is authoritative: the catalog
    //     `rule` is deliberately NOT applied (a per_day/percent rule would REPLACE the keyed figure), so
    //     rule=null ⇒ stored-amount behaviour.
    //   • earning/deduction WITHOUT a component (legacy rows keyed before the flag; new writes require a
    //     component, service-enforced) → conservative statutory defaults: an earning is EPF+SOCSO-liable
    //     wages (and thereby in the PCB base via wagesExOt); a deduction is post-statutory (reduces net
    //     only, EA s.24-clamped exactly like a manual deduction). prorates=false — a dated one-off amount
    //     is an actual, not a contractual monthly figure.
    //   • overtime / unpaid kinds fold in the payslip loop below (the OT figure with otSource provenance /
    //     the unpaid deduction); leave is RECORD-ONLY in v1 (documented skip below).
    // DEPENDENCY (documented): the earning/deduction fold rides TYPED_PAY_COMPONENTS_ENABLED — with typed
    // components off there is no per-component fold to ride, so payable rows FAIL CLOSED (typed error)
    // rather than silently staying unpaid. Read-only fold — no DomainEvent (the generated event + payslip
    // rows are the audit record, as for batch components).
    const individualTxnPay = settingEnabled(ctx, 'payroll.individual_txn_pay_enabled');
    const txnOtByEmp = new Map<string, number>();
    const txnUnpaidByEmp = new Map<string, number>();
    // Named payslip provenance for every consumed row (merged into statutory.recordLines below) so the
    // payslip shows the one-off items by name; deductions carry a negative sign.
    const txnRecordLinesByEmp = new Map<string, { code: string; name: string; amount: number }[]>();
    if (individualTxnPay) {
      const ledger = await tx
        .select({
          employmentId: payrollIndividualTxn.employmentId,
          kind: payrollIndividualTxn.kind,
          amount: payrollIndividualTxn.amount,
          notes: payrollIndividualTxn.notes,
          componentId: payrollIndividualTxn.componentId,
          compCode: payComponent.code,
          compName: payComponent.name,
          compKind: payComponent.kind,
          compEpf: payComponent.includedInEpf,
          compSocso: payComponent.includedInSocsoEis,
          compPcb: payComponent.includedInPcb,
          compHrdf: payComponent.includedInHrdfBase,
          compNonPayable: payComponent.isNonPayable,
          compProrates: payComponent.prorates,
          compRounding: payComponent.roundingMethod,
          compEpfBonus2012: payComponent.epfBonus2012,
          compPcbRemunerationType: payComponent.pcbRemunerationType,
          compPcbExemptionCode: payComponent.pcbExemptionCode,
          // Feedback 3c473773 — the catalog row's declared payslip box rides the one-off transaction too.
          // This is the reporter's exact path: an Overtime 1.5 one-off landed in Bonus because the box was
          // inferred from the pay code's PCB stream.
          compDisplayCategory: payComponent.displayCategory,
        })
        .from(payrollIndividualTxn)
        .leftJoin(payComponent, eq(payComponent.id, payrollIndividualTxn.componentId))
        .where(eq(payrollIndividualTxn.batchId, p.batchId));
      const pushTxnLine = (empId: string, line: { code: string; name: string; amount: number }) => {
        const list = txnRecordLinesByEmp.get(empId) ?? [];
        list.push(line);
        txnRecordLinesByEmp.set(empId, list);
      };
      for (const t of ledger) {
        const amt = round2(Number(t.amount));
        if (t.kind === 'overtime') {
          txnOtByEmp.set(t.employmentId, round2((txnOtByEmp.get(t.employmentId) ?? 0) + amt));
          pushTxnLine(t.employmentId, { code: 'TXN_OVERTIME', name: t.notes ?? 'Overtime (one-off)', amount: amt });
          continue;
        }
        if (t.kind === 'unpaid') {
          txnUnpaidByEmp.set(t.employmentId, round2((txnUnpaidByEmp.get(t.employmentId) ?? 0) + amt));
          pushTxnLine(t.employmentId, { code: 'TXN_UNPAID', name: t.notes ?? 'Unpaid (one-off)', amount: -amt });
          continue;
        }
        if (t.kind === 'leave') {
          // DOCUMENTED SKIP (v1): a 'leave' row is RECORD-ONLY — leave pay flows through the leave module
          // (unpaid-leave derivation / entitlements), so folding a raw leave amount here would double-count.
          // The row still surfaces on the payslip as a named record line (provenance, no cash effect).
          pushTxnLine(t.employmentId, { code: 'TXN_LEAVE', name: t.notes ?? 'Leave (one-off)', amount: amt });
          continue;
        }
        // earning / deduction — the payable classes ride the typed-component fold (dependency above).
        if (!typedComponents) throw new IndividualTxnRequiresTypedComponentsError();
        const row: CompRow =
          t.componentId != null && t.compCode != null
            ? {
                code: t.compCode,
                name: t.compName ?? t.compCode,
                kind: t.compKind ?? t.kind,
                amount: amt,
                rounding: t.compRounding ?? 'none',
                epf: t.compEpf ?? false,
                socso: t.compSocso ?? false,
                pcb: t.compPcb ?? false,
                hrdf: t.compHrdf ?? false,
                nonPayable: t.compNonPayable ?? false,
                prorates: t.compProrates ?? false,
                prorateOverride: null,
                rule: null, // keyed amount is authoritative — never re-derive via a catalog rule
                // 61bf109d — a null rule short-circuits to `amount`, so the rank is inert here; 0 keeps the
                // one-off row in the first resolution group, exactly where an unranked row belonged before.
                resolutionOrder: 0,
                // LHDN PCB 2026 classification rides the catalog row (feedback 09b554e9).
                epfBonus2012: t.compEpfBonus2012 ?? false,
                pcbRemunerationType: t.compPcbRemunerationType ?? null,
                pcbExemptionCode: t.compPcbExemptionCode ?? null,
                // Feedback 3c473773 — display box from the catalog row (null ⇒ inferred, as before).
                displayCategory: t.compDisplayCategory ?? null,
              }
            : t.kind === 'earning'
              ? { code: 'TXN_EARNING', name: t.notes ?? 'One-off earning', kind: 'allowance', amount: amt, rounding: 'none', epf: true, socso: true, pcb: true, hrdf: false, nonPayable: false, prorates: false, prorateOverride: null, rule: null, resolutionOrder: 0, epfBonus2012: false, pcbRemunerationType: null, pcbExemptionCode: null, displayCategory: null }
              : { code: 'TXN_DEDUCTION', name: t.notes ?? 'One-off deduction', kind: 'deduction', amount: amt, rounding: 'none', epf: false, socso: false, pcb: false, hrdf: false, nonPayable: false, prorates: false, prorateOverride: null, rule: null, resolutionOrder: 0, epfBonus2012: false, pcbRemunerationType: null, pcbExemptionCode: null, displayCategory: null };
        const list = batchCompByEmp.get(t.employmentId) ?? [];
        list.push(row);
        batchCompByEmp.set(t.employmentId, list);
        // Provenance: a non-payable (BIK) component row already surfaces via the fold's own record line —
        // skip the duplicate. Every cash row gets a named line (deductions negative).
        if (!row.nonPayable) {
          pushTxnLine(t.employmentId, { code: row.code, name: t.notes ?? row.name, amount: row.kind === 'deduction' ? -amt : amt });
        }
      }
      // OT provenance (feedback plan: otSource='individual-txn'): a slip whose OT includes one-off ledger
      // rows is stamped 'individual-txn' unless a manual/attendance figure also contributes — the earlier
      // provenance then still names the larger origin (the ledger rows remain visible as record lines).
      for (const [empId, v] of txnOtByEmp) {
        if (v <= 0) continue;
        const existingOt = round2(overtimeByEmp.get(empId) ?? 0);
        if (!(existingOt > 0) || !otSourceByEmp.get(empId)) otSourceByEmp.set(empId, 'individual-txn');
      }
    }

    // Payroll Setup — attendance worked HOURS per employment, for `per_hour` rules only. Computed once here
    // (gated on typedComponents) so the per-component resolver reads a map, not a re-query. No attendance
    // rows ⇒ 0 hours, a real, non-erroring outcome (paid by the hour, worked no hours) — there is NO division
    // in the resolver, so a zero-hours employee never aborts the batch.
    // ADR-0078 — an employee whose OWN pay_mode is hourly also needs the worked-hours map (rate × hours),
    // independent of the typed-components flag, so the gate widens when any such employee is in scope. A
    // batch with neither typed components nor an hourly-mode employee issues NO extra query (byte-identical).
    const hourlyModeEmps = emps.filter((e) => e.payMode === 'hourly' && e.rateAmount != null);
    const hoursByEmp = new Map<string, number>();
    if ((typedComponents || hourlyModeEmps.length > 0) && empIds.length) {
      const att = await tx
        .select({ employmentId: attendance.employmentId, minutes: sql<string>`coalesce(sum(${attendance.workedMinutes}), 0)` })
        .from(attendance)
        .where(
          and(
            inArray(attendance.employmentId, empIds),
            gte(attendance.attendanceDate, periodStart),
            lte(attendance.attendanceDate, periodEnd),
          ),
        )
        .groupBy(attendance.employmentId);
      for (const a of att) hoursByEmp.set(a.employmentId, Number(a.minutes) / 60);
    }

    // ── ADR-0078 (642ecc55) — Hourly pay mode: basic = per-hour rate × attendance hours in the period ──
    // With the rate now living on the employee's own compensation row, hourly becomes genuinely usable: one
    // hourly employee can sit among monthly colleagues on the same policy (the catalog per_hour rule could
    // only ever be tenant-wide). Zero worked hours ⇒ basic = 0 — a real outcome, not an error (multiply,
    // never divide). custom_period has NO calculation and is blocked at pre-flight (preProcessChecksTx), so
    // it never reaches this loop through a generated run.
    const hourlyPayByEmp = new Map<string, { rate: number; hours: number; basic: number }>();
    for (const e of hourlyModeEmps) {
      const rate = Number(e.rateAmount);
      const hours = hoursByEmp.get(e.employmentId) ?? 0;
      hourlyPayByEmp.set(e.employmentId, { rate, hours, basic: round2(rate * hours) });
    }

    // LHDN PCB 2026 (feedback 09b554e9) — the exemption tables ride the resolved statutory ruleset (a
    // pack/override predating 2026.5 omits them and falls back to the verified built-ins, mirroring hrdf).
    // Rung 5a (ADR-0080 D6 — the corrected R55 shape): the built-in fallback tables come from the batch's
    // resolved country pack, not a direct MY import.
    const exemptionTables = rules.pcbExemptions ?? pack.payroll.pcbExemptionTables;

    /** Per-employee earnings, from the typed components (flag on) or the legacy comp+input (flag off).
     *  Returns the exact variables the loop already used so the rest of the kernel is unchanged.
     *  Feedback 09b554e9 adds `lpDeclared` (this month's optional-deduction claims, fed into LP₁ beside
     *  TP1) and `exemptionUsed` (per-code exempt/claimed amounts, stamped onto the slip for the YTD replay). */
    /** Which summarised figure on the payslip a component's money landed in (feedback 862ed0ad). */
    type PayComponentBucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';
    type PayComponentLine = {
      code: string;
      name: string;
      /** The whole resolved+prorated amount, before it was split across buckets. */
      amount: number;
      buckets: { bucket: PayComponentBucket; amount: number }[];
    };

    // ── Feedback 3c473773 — the DISPLAY overlay ────────────────────────────────────────────────────────
    // The buckets above are STATUTORY: `wage` feeds the EPF/SOCSO/EIS/PCB normal-wage base, `ot` feeds the
    // overtime leg (EPF-exempt), `bonus` feeds additional remuneration (EPF + PCB difference method,
    // outside SOCSO/EIS). They are NOT touched by anything below — moving an amount between them would
    // change EPF, SOCSO, EIS and PCB, i.e. change what is filed with KWSP/PERKESO/LHDN for money that is
    // being computed correctly today.
    //
    // What IS new is a second, parallel tally of the same amounts under the box each pay item DECLARES.
    // Same money, same totals, different labels — see core/pay-display-category.ts for why the two
    // questions were ever conflated. `moved` stays false unless someone deliberately re-categorised an
    // item, and a run with moved===false stamps nothing at all, which is what keeps every other payslip
    // byte-identical.
    type DisplayTally = Record<PayDisplayCategory, number>;
    const emptyTally = (): DisplayTally => ({ basic: 0, overtime: 0, bonus: 0, allowance: 0, claim: 0, deduction: 0 });

    const earningsOf = (
      e: { employmentId: string; basic: unknown; allowance: unknown },
      factor: number,
    ): {
      basicRaw: number; basicGross: number; allowanceApplied: number; hrdfAllowApplied: number;
      overtime: number; bonus: number; reimburse: number; deduct: number;
      recordLines: { code: string; name: string; amount: number }[];
      componentLines: PayComponentLine[];
      lpDeclared: number; exemptionUsed: Record<string, number>;
      // Feedback 3c473773 — the same component money tallied under each item's DECLARED payslip box, plus
      // how much left the `ot` bucket for another box (the one direction whose display arithmetic has to be
      // reconciled against the OT caps downstream). `displayMoved` is false whenever nothing was
      // re-categorised, and the kernel then stamps no overlay at all.
      display: DisplayTally; displayMoved: boolean; displayOtOutbound: number;
    } => {
      if (!typedComponents) {
        const basicRaw = Number(e.basic);
        const allowRaw = Number(e.allowance ?? 0);
        const claim = round2(claimAllowanceByEmp.get(e.employmentId) ?? 0);
        return {
          basicRaw,
          basicGross: round2(basicRaw * factor),
          allowanceApplied: round2(allowRaw * factor + claim),
          hrdfAllowApplied: round2(allowRaw * factor),
          overtime: round2(overtimeByEmp.get(e.employmentId) ?? 0),
          bonus: round2(bonusByEmp.get(e.employmentId) ?? 0),
          reimburse: 0,
          deduct: 0,
          recordLines: [],
          // Nothing to itemise: with typed components off there IS no per-component detail — the figures
          // come from compensation + payroll_input, which is a different shape entirely.
          componentLines: [],
          lpDeclared: 0,
          exemptionUsed: {},
          // Flag off ⇒ there are no typed pay items, so there is no declared box to honour and nothing to
          // re-categorise. The legacy path stays exactly as it was.
          display: emptyTally(),
          displayMoved: false,
          displayOtOutbound: 0,
        };
      }
      let basicRaw = 0, basicGross = 0, wageAllow = 0, hrdfAllow = 0, ot = 0, bonusAmt = 0, reimburse = 0, deduct = 0;
      const recordLines: { code: string; name: string; amount: number }[] = [];
      // Feedback 862ed0ad — per-component provenance for the CASH buckets. recordLines already itemises
      // record-only components, which is why one-off items could always be broken down; the PAID recurring
      // ones were summed into wageAllow/ot/bonusAmt/reimburse/deduct with nothing kept, so a summarised
      // figure on Transaction View had no stored detail behind it to disclose.
      //
      // One line per component carrying EVERY bucket it contributed to, so a component that splits — an
      // exempt portion paid untaxed plus a taxable remainder — is represented as it actually behaved
      // rather than flattened into one number against one bucket.
      //
      // INVARIANT, pinned by test: for each bucket, the sum of the lines' contributions equals that
      // bucket's total. That is what makes a breakdown incapable of disagreeing with the figure beside it,
      // which the plan made a precondition of showing one at all.
      const componentLines: PayComponentLine[] = [];
      let currentLine: PayComponentLine | null = null;
      /** Record a component's contribution. Enrolled LAZILY: a component that never moves cash (a
       *  record-only BIK) never appears here — it belongs to recordLines and would otherwise be listed
       *  twice, under a heading about money it does not affect. */
      // Feedback 3c473773 — the display tally, filled at the SAME call sites as the statutory buckets so
      // the two can never see different money. `currentCategory` is the box the component in hand declares
      // (null ⇒ unclassified ⇒ resolveDisplayCategory falls back to the bucket's own box, byte-identical).
      const display = emptyTally();
      let displayMoved = false;
      let displayOtOutbound = 0;
      let currentCategory: string | null = null;
      const contributes = (bucket: PayComponentBucket, amount: number) => {
        if (!currentLine || amount === 0) return;
        if (currentLine.buckets.length === 0) componentLines.push(currentLine);
        currentLine.buckets.push({ bucket, amount });
        const box = resolveDisplayCategory(currentCategory, bucket);
        display[box] = round2(display[box] + amount);
        if (box !== defaultCategoryOfBucket(bucket)) {
          displayMoved = true;
          // Money leaving the `ot` bucket is the one move the overlay cannot always express downstream: the
          // stored overtime figure is the CAPPED one, so subtracting a pre-cap amount from it could go
          // negative. Track it here; the kernel refuses to stamp the overlay if the cap ever bit.
          if (bucket === 'ot') displayOtOutbound = round2(displayOtOutbound + amount);
        }
      };
      // LHDN PCB 2026 (feedback 09b554e9) — this month's optional-deduction (LP) claims and per-code
      // exemption usage. `priorUsed` is the YTD usage replayed from the year's earlier slips; `exemptionUsed`
      // accumulates THIS month's usage (so two components sharing a code share the remaining cap headroom).
      let lpDeclared = 0;
      const exemptionUsed: Record<string, number> = {};
      const priorUsed = exemptUsedByEmp.get(e.employmentId) ?? {};
      /** Remaining annual headroom for a code under `cap` (cap < 0 = fully exempt sentinel ⇒ unlimited). */
      const roomFor = (code: string, cap: number): number =>
        cap < 0 ? Number.POSITIVE_INFINITY : Math.max(0, round2(cap - (priorUsed[code] ?? 0) - (exemptionUsed[code] ?? 0)));
      const useRoom = (code: string, amount: number) => {
        if (amount <= 0) return;
        exemptionUsed[code] = round2((exemptionUsed[code] ?? 0) + amount);
      };
      const comps = [...(recurringByEmp.get(e.employmentId) ?? []), ...(batchCompByEmp.get(e.employmentId) ?? [])];

      // Payroll Setup — pay-rule scope (shared by all components). `daysWorked` reflects the partial period
      // (factor × dim); `hours` is the employee's attendance hours. NOTE: `per_day`/`per_hour` rules require
      // the component to have prorates=false (validatePayRule rejects the combo), so the kernel's `factor`
      // multiplier below does NOT also apply to them — no double-proration. `percent_of basic` reads the
      // Personnel compensation basic (seeded once below, order-independent). There is NO division in
      // the resolver, so a zero-days / zero-hours employee can never abort the batch.
      // 61bf109d — `components` carries each pay item's resolved amount for rules that read another item.
      // It starts with BASIC PINNED to the authoritative Personnel figure (seeded just below): the BASIC
      // component row is inert in this engine, so a rule reading `component:'BASIC'` must get the same
      // number the `basic` operand gives, never the stale component amount. resolvePayComponentSet does not
      // overwrite a caller-pinned code.
      const rscope: PayRuleScope = { basic: 0, daysWorked: factor * dim, hours: hoursByEmp.get(e.employmentId) ?? 0, components: {} };
      // ── Feedback 64fb5e48 (supersedes the R37 62e370b0 fallback): Personnel is the ONLY basic source ──
      // The BASIC line always reads the Personnel Basic Salary record (the compensation join, `e.basic`) —
      // exactly what the legacy path reads. A BASIC employment_pay_component never supplies the amount any
      // more (previously a stale one silently OVERRODE the Personnel record — a payment-integrity risk);
      // it is skipped in the loop below and pre-flight surfaces a staleBasicComponent WARNING when its
      // amount disagrees. `rscope.basic` therefore feeds `percent_of basic` rules from the same
      // authoritative figure, and basicRaw/basicGross mirror the legacy path: basicRaw is the unfactored
      // monthly basic; basicGross applies the EA-1955 tenure `factor` (mid-period joiner/leaver
      // proration). Daily/hourly modes override both in the payslip loop, as before.
      const compensationBasic = Number(e.basic ?? 0);
      rscope.basic = compensationBasic;
      rscope.components = { BASIC: compensationBasic }; // pinned — see the rscope comment above
      basicRaw = compensationBasic;
      basicGross = round2(compensationBasic * factor);
      // A single resolved value per component, substituted at BOTH read sites (the line-868 amount and the
      // line-877 basicRaw accumulator) so the gross AND the statutory base see the same number.
      //
      // 61bf109d — resolution is now a SET operation over the recorded dependency order, not a per-row map.
      // A `percent_of base:'component'` or `formula` rule reads ANOTHER pay item, so the value of that item
      // must already exist when this one is computed; resolvePayComponentSet walks the groups in ascending
      // pay_component.resolution_order (planned and refused-if-cyclic at save time, migration 0330), which
      // is what makes two runs of the same payroll agree. For an all-fixed catalog every rank is 0 and each
      // entry short-circuits to `c.amount` — the exact expression this line used before, hence byte-identical.
      // The SAME function backs the admin preview, so the preview cannot drift from the run.
      const resolvedByIdx = resolvePayComponentSet(comps, rscope);

      for (const [ci, c] of comps.entries()) {
        // Feedback 64fb5e48 — a BASIC component is inert in the engine: the Personnel record above already
        // seeded basicRaw/basicGross/rscope.basic, and a stale component amount must never override pay.
        if (c.code === 'BASIC') continue;
        const resolved = resolvedByIdx[ci];
        // 1.2.1 Fixed Transaction — the per-employee override wins over the catalog `prorates` flag; null
        // (every legacy/backfilled row + every one-off batch component) inherits the catalog flag, so this is
        // byte-identical to the prior `c.prorates` behaviour. `factor` is the EA-1955 join/resign tenure
        // factor (prorate ON = proportional for a mid-period joiner/resigner, OFF = full amount).
        const prorate = c.prorateOverride ?? c.prorates;
        const applied = roundAmount(prorate ? resolved * factor : resolved, c.rounding);
        currentLine = { code: c.code, name: c.name, amount: applied, buckets: [] };
        // Feedback 3c473773 — the box THIS item declares, read for the display tally only.
        currentCategory = c.displayCategory ?? null;
        // ── LHDN PCB 2026 declared classification (feedback 09b554e9) ──
        // Optional Deduction: the amount reduces this month's PCB exactly like an approved TP1 deduction
        // (fed into LP₁ below), capped by the LP code's remaining ANNUAL headroom (YTD replay). Cash-wise
        // the component keeps its kind: a deduction deducts from net (e.g. LP_VOLUNTARY_EPF via salary), a
        // non-payable records only, and any other kind is paid untaxed (it is a relief claim, not remuneration).
        if (c.pcbRemunerationType === 'optional_deduction') {
          const cap = c.pcbExemptionCode != null ? (exemptionTables.lp[c.pcbExemptionCode] ?? 0) : 0;
          const claim = c.pcbExemptionCode != null ? round2(Math.min(applied, roomFor(c.pcbExemptionCode, cap))) : 0;
          if (claim > 0) {
            lpDeclared = round2(lpDeclared + claim);
            useRoom(c.pcbExemptionCode!, claim);
          }
          if (c.kind === 'deduction') { deduct = round2(deduct + applied); contributes('deduct', applied); continue; }
          if (c.nonPayable) { recordLines.push({ code: c.code, name: c.name, amount: applied }); continue; }
          reimburse = round2(reimburse + applied);
          contributes('reimburse', applied);
          continue;
        }
        if (c.kind === 'deduction') { deduct = round2(deduct + applied); contributes('deduct', applied); continue; }
        // FAIL-CLOSED (ADR-0025 §5): a PCB-taxable non-payable/BIK, or a PCB-only earning (not EPF and not
        // SOCSO), would be SILENTLY under-taxed — v1 does not compute the tax, so reject rather than produce
        // a wrong payslip. (Write-time guards in core/pay-components.ts now reject the same at entry/import.)
        // PRECEDENCE: the flag check runs on the resolved value — a rule does not let an unsupported
        // component through (an unsupported-PCB component still throws regardless of what its rule resolves to).
        // Feedback 09b554e9: a DECLARED pcb_remuneration_type makes the code computable (the kernel routes it
        // by the declaration below), so the guard only fires for PCB-ticked codes LACKING classification.
        if (c.pcb && c.pcbRemunerationType == null && (c.nonPayable || (!c.epf && !c.socso))) {
          throw new UnsupportedPayComponentError(c.code);
        }
        // A non-payable, non-taxable component (e.g. a record-only BIK) carries onto the payslip as an
        // INFORMATIONAL record line — it does NOT affect any cash bucket, gross, or net (ADR-0025 §5 / Option A).
        if (c.nonPayable) { recordLines.push({ code: c.code, name: c.name, amount: applied }); continue; }
        // ── Feedback 09b554e9: declared Normal/Additional remuneration, with per-code annual exemption ──
        // The exempt portion (up to the PCB code's remaining annual headroom; cap -1 = fully exempt,
        // cap 0 = fully taxable) is PAID but stays out of every statutory base (the reimburse bucket);
        // the taxable remainder rides the declared stream: normal → the Y1 wage bucket, additional → the
        // Yt bonus bucket. EPF Bonus 2012 forces the bonus (additional-remuneration EPF) routing regardless
        // of the SOCSO flag — the amount is a bonus payment for EPF purposes (and bonuses sit outside
        // SOCSO/EIS by law). Legacy rows (both null/false) fall through to the flag inference unchanged.
        const stream = c.epfBonus2012 ? 'additional' : c.pcbRemunerationType;
        if (stream === 'normal' || stream === 'additional') {
          let taxable = applied;
          const code = c.pcbExemptionCode; // optional_deduction already consumed above — always a PCB_* code here
          if (code != null) {
            const cap = exemptionTables.pcb[code] ?? 0;
            const exempt = cap === 0 ? 0 : round2(Math.min(applied, roomFor(code, cap)));
            if (exempt > 0) {
              taxable = round2(applied - exempt);
              reimburse = round2(reimburse + exempt);
              contributes('reimburse', exempt);
              useRoom(code, exempt);
            }
          }
          if (stream === 'normal') {
            wageAllow = round2(wageAllow + taxable);
            contributes('wage', taxable);
            if (c.hrdf) hrdfAllow = round2(hrdfAllow + taxable);
          } else {
            bonusAmt = round2(bonusAmt + taxable);
            contributes('bonus', taxable);
          }
          continue;
        }
        if (c.epf && c.socso) { wageAllow = round2(wageAllow + applied); contributes('wage', applied); if (c.hrdf) hrdfAllow = round2(hrdfAllow + applied); }
        else if (!c.epf && c.socso) { ot = round2(ot + applied); contributes('ot', applied); }
        else if (c.epf && !c.socso) { bonusAmt = round2(bonusAmt + applied); contributes('bonus', applied); }
        else { reimburse = round2(reimburse + applied); contributes('reimburse', applied); } // all-false earning: paid but untaxed
      }
      return { basicRaw, basicGross, allowanceApplied: wageAllow, hrdfAllowApplied: hrdfAllow, overtime: ot, bonus: bonusAmt, reimburse, deduct, recordLines, componentLines, lpDeclared, exemptionUsed, display, displayMoved, displayOtOutbound };
    };

    /** Age at the period end; null when DOB is not captured (treated as < 60). */
    const ageAt = (dob: string | null): number | null => {
      if (!dob) return null;
      const d = new Date(`${dob}T00:00:00Z`);
      const ref = new Date(`${periodEnd}T00:00:00Z`);
      let age = ref.getUTCFullYear() - d.getUTCFullYear();
      if (
        ref.getUTCMonth() < d.getUTCMonth() ||
        (ref.getUTCMonth() === d.getUTCMonth() && ref.getUTCDate() < d.getUTCDate())
      ) {
        age -= 1;
      }
      return age;
    };

    const totals = {
      gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0,
      socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, hrdfEmployer: 0,
      deductions: 0, employerCost: 0,
    };

    // Selective reprocess (9bc442bc, reporter #5/#6/#8): before recomputing, snapshot + ROW-LOCK the
    // subset's existing payslips (optimistic-concurrency + before/after audit), tally their OLD
    // contribution for the delta-totals update, then delete them so the loop below re-inserts fresh
    // rows. `FOR UPDATE` locks ONLY these rows — unrelated employees' payslips stay unlocked, so a
    // concurrent reprocess of a different subset never blocks (and a concurrent reprocess of the SAME
    // employee serialises and re-reads the bumped version).
    const oldTotals = { ...totals };
    const versionByEmp = new Map<string, number>();
    const beforeByEmp = new Map<string, Record<string, unknown>>();
    if (subset) {
      if (emps.length === 0) throw new Error('None of the selected employees are active in this period.');
      const subsetIds = emps.map((e) => e.employmentId);
      const existing = await tx
        .select()
        .from(payslip)
        .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, subsetIds)))
        .for('update');
      for (const sl of existing) {
        versionByEmp.set(sl.employmentId, sl.version);
        const st = (sl.statutory ?? {}) as Record<string, number>;
        beforeByEmp.set(sl.employmentId, {
          grossPay: sl.grossPay, netPay: sl.netPay, totalDeductions: sl.totalDeductions,
          employerCost: sl.employerCost, statutory: sl.statutory, version: sl.version,
        });
        oldTotals.gross += Number(sl.grossPay);
        oldTotals.net += Number(sl.netPay);
        oldTotals.deductions += Number(sl.totalDeductions);
        oldTotals.employerCost += Number(sl.employerCost);
        oldTotals.epfEmployee += Number(st.epfEmployee ?? 0);
        oldTotals.epfEmployer += Number(st.epfEmployer ?? 0);
        oldTotals.socsoEmployee += Number(st.socsoEmployee ?? 0);
        oldTotals.socsoEmployer += Number(st.socsoEmployer ?? 0);
        oldTotals.eisEmployee += Number(st.eisEmployee ?? 0);
        oldTotals.eisEmployer += Number(st.eisEmployer ?? 0);
        oldTotals.pcb += Number(st.pcb ?? 0);
        oldTotals.hrdfEmployer += Number(st.hrdf ?? 0);
      }
      await tx.delete(payslip).where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, subsetIds)));
    }

    // 1e — apply the policy OT caps to a prefilled OT total. Uses the stored rate-bucket decomposition
    // (otBreakdown) when present so eligible-day-type filtering + multiplier re-rating are exact; when only a
    // flat figure exists, the breakdown is the whole total as a workday leg (so maxAmount still bites and a
    // workday-only restriction is a no-op). Default (no OT config) ⇒ returns `total` unchanged.
    // Returns the capped OT figure AND the excess the HOUR/AMOUNT caps removed (Step 4 f3148da1 reroutes the
    // excess onto a pay item when configured). Default (no OT config) ⇒ { capped: total, excess: 0 }.
    const applyOvertimeCapsForEmp = (cfg: PayrollPolicyConfig | null, employmentId: string, total: number): { capped: number; excess: number } => {
      if (!cfg?.overtime || total <= 0) return { capped: total, excess: 0 };
      const bd = otBreakdownByEmp.get(employmentId) as { flat: number; normal: number; rest: number; holiday: number } | null;
      // Map the stored buckets onto the three OT day types. `flat` (a hand-keyed lump with no day type) rides
      // the workday leg so it is still capped by maxAmount but not zeroed by a rest/holiday-only restriction.
      const parts = bd
        ? { workday: round2(bd.normal + bd.flat), restDay: round2(bd.rest), holiday: round2(bd.holiday), workedOtHours: 0 }
        : { workday: total, restDay: 0, holiday: 0, workedOtHours: 0 };
      const d = applyOvertimeCapsDetailed(cfg, parts);
      return { capped: d.capped, excess: d.excess };
    };

    for (const e of emps) {
      // 2.1.1 (ADR-0064) — the resolved policy config for this employment (null ⇒ legacy path unchanged).
      const cfg = policyConfigByEmp.get(e.employmentId) ?? null;
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      // Allowance prorates with basic — EA-1955 incomplete-month treats fixed monthly wages as a whole.
      // 1b — the divisor + working-day basis come from the policy (default ⇒ EA s.18A calendar daysInMonth).
      const factor = prorationFactor(payPeriod, e.hiredOn, e.terminatedOn, prorationOptsByEmp.get(e.employmentId));
      // 2.1.2 — a daily-rated employee is paid rate × eligible days; the monthly proration basis does not apply.
      // Surface the eligible-day count as `daysWorked` (a real day count, not factor×dim) for the daily path.
      const daily = dailyPayByEmp.get(e.employmentId) ?? null;
      // ADR-0078 — hourly pay mode mirrors the daily override: basic = rate × attendance hours; daysWorked
      // keeps the factor-based surface (attendance days are not the proration basis for an hourly worker).
      const hourly = hourlyPayByEmp.get(e.employmentId) ?? null;
      const daysWorked = daily ? daily.eligibleDays : Math.round(factor * dim); // proration basis surfaced on the payslip
      // Earnings come from the typed components (flag on) or compensation + payroll_input (flag off).
      // Either way these reproduce the same variables, so the agency-base math below is unchanged.
      const en = earningsOf(e, factor);
      // 1c — salary-increment proration: when the policy enables it AND a mid-period increment straddles the
      // period, the basic is the two-row blend (already day-weighted across the increment date), NOT
      // basic×factor. Default (off / no straddle) ⇒ undefined ⇒ the kernel's normal basicGross is used.
      // 2.1.2 — for a daily pay mode, basic = per-day rate × eligible days (no proration, no increment
      // blend); hourly = per-hour rate × worked hours. D4's period-boundary rule means a mode never changes
      // mid-period, so these overrides and the increment blend cannot both legitimately fire.
      const incrementBasic = incrementBasicByEmp.get(e.employmentId);
      const basicRaw = daily ? daily.basic : hourly ? hourly.basic : (incrementBasic ?? en.basicRaw);
      const basic = daily
        ? daily.basic
        : hourly
          ? hourly.basic
          : incrementBasic !== undefined
            ? round2(incrementBasic)
            : en.basicGross;
      // 1e — OT caps: wrap the prefilled/keyed OT figure with the policy's caps (eligible day types, max
      // hours, max amount, floored multiplier). Default (no overtime config) ⇒ the figure is unchanged.
      // f1564110 Phase 3 — one-off 'overtime' ledger rows ADD to the OT figure BEFORE the caps (flag off ⇒
      // txnOt is 0 ⇒ byte-identical). Regular run only: an additional/off-cycle run pays no OT (slipOvertime
      // is zeroed and its statutory delta reads the regular run's OT), so folding there would distort nothing
      // but is skipped for clarity.
      const txnOt = isAdditionalRun ? 0 : round2(txnOtByEmp.get(e.employmentId) ?? 0);
      const otCap = applyOvertimeCapsForEmp(cfg, e.employmentId, round2(en.overtime + txnOt));
      const overtime = otCap.capped;
      // Step 4 (f3148da1) — OT exceed handling. When the policy configures "convert excess to pay item" AND a
      // valid component was resolved, the amount the HOUR/AMOUNT caps cut off is redirected to that pay item so
      // it is still paid to the employee (regular run only — an additional/off-cycle run carries no OT).
      // Statutory character: the excess retains OVERTIME's treatment (SOCSO/EIS/PCB base, EPF-exempt) — the
      // legally-correct treatment for overtime remuneration — while the chosen component controls the payslip
      // line label/name. Default (no exceedHandling / no excess) ⇒ 0 ⇒ byte-identical.
      const otConvertComp = otConvertByEmp.get(e.employmentId);
      const otConvertAmount = !isAdditionalRun && otConvertComp ? round2(otCap.excess) : 0;
      // Allowance line: wage-bucket non-basic components (incl. the taxable claim) + any all-false
      // "reimbursement" earning (paid but untaxed) + the converted OT excess (paid; taxed via the OT stat leg).
      const allowance = round2(en.allowanceApplied + en.reimburse + otConvertAmount);
      const bonus = en.bonus;
      // Unpaid leave deducts at the EA-1955 ordinary rate of pay (monthly basic / divisor days). 1f — the
      // divisor is policy-configurable (default calendar_month ⇒ `dim`, byte-identical).
      const unpaidDivisor = leaveDivisorDays(cfg?.leave?.unpaidLeaveDivisor, cfg, {
        calendarDaysInMonth: dim,
        cutoffDays: salaryCutoffDaysByEmp.get(e.employmentId) ?? dim, // c7fdfcf6 — salary cut-off window length; calendar fallback = dim
        workingDays: workingDaysInPeriodFor(e.employmentId),
      });
      // f3148da1 Step 5 (R17 gap-fix reinstatement) — the Unpaid Time Off Deduction Formula. When the policy
      // configures a distinct unpaidTimeOffDivisor, the PARTIAL-DAY unpaid subset (half-day / hourly requests)
      // deducts at its own per-day rate (day divisor, or per-hour/per-minute × the 8h standard day) while the
      // remaining FULL-DAY unpaid days keep the unpaidLeaveDivisor rate. No distinct divisor (the default) ⇒
      // timeOffRate is null and the whole figure stays the single legacy expression, byte-identical.
      const unpaidDaysAll = unpaidByEmp.get(e.employmentId) ?? 0;
      const timeOffDays = Math.min(unpaidTimeOffByEmp.get(e.employmentId) ?? 0, unpaidDaysAll);
      const timeOffRate =
        timeOffDays > 0
          ? unpaidTimeOffDailyRate(basicRaw, cfg, {
              calendarDaysInMonth: dim,
              cutoffDays: salaryCutoffDaysByEmp.get(e.employmentId) ?? dim,
              workingDays: workingDaysInPeriodFor(e.employmentId),
            })
          : null;
      // 2.1.2 — a daily wage already pays ONLY eligible worked days, so an unpaid-leave day is simply not a
      // worked day (never counted into `basic`); deducting again off basicRaw/divisor would double-count it.
      // f1564110 Phase 3 — one-off 'unpaid' ledger rows ADD their keyed RM amount to the unpaid deduction
      // (pre-statutory: it reduces wagesExOt/hrdfBase like derived unpaid leave). Flag off ⇒ txnUnpaid is 0 ⇒
      // byte-identical. Regular run only (an additional run charges no unpaid, like cp38/hrdf). Applied even
      // on the daily path — a keyed amount is an explicit instruction, not the derived not-a-worked-day case.
      const txnUnpaid = isAdditionalRun ? 0 : round2(txnUnpaidByEmp.get(e.employmentId) ?? 0);
      const unpaidDeduction = round2(
        (daily
          ? 0
          : timeOffRate !== null
            ? round2((basicRaw / unpaidDivisor) * (unpaidDaysAll - timeOffDays) + timeOffRate * timeOffDays)
            : round2((basicRaw / unpaidDivisor) * unpaidDaysAll)) + txnUnpaid,
      );
      const normalWage = round2(basic + allowance + overtime); // regular monthly remuneration
      // Agency bases differ (STATUTORY-SOURCES §6): EPF EXCLUDES overtime, SOCSO/EIS/PCB
      // include it — so the calculator takes wages ex-OT and the OT separately. The all-false
      // reimbursement is paid (in `allowance`/gross) but NOT in any statutory base.
      const wagesExOt = Math.max(0, round2(basic + en.allowanceApplied - unpaidDeduction));
      // Bonus is additional remuneration: EPF + PCB (difference method), excluded from SOCSO/EIS.
      // LP₁ — this month's optional deductions: the approved TP1 amounts PLUS the declared
      // optional-deduction pay codes (feedback 09b554e9; capped per LP code in earningsOf). Charged on the
      // REGULAR run only, like cp38/hrdf — an additional run re-folds the same recurring components and
      // would otherwise double-claim the month's LP.
      const lp = round2((tp1ByEmp.get(e.employmentId) ?? 0) + (isAdditionalRun ? 0 : en.lpDeclared));
      const zakat = round2(zakatByEmp.get(e.employmentId) ?? 0);
      const age = ageAt(e.dateOfBirth);
      // HRD Corp levy (Wave 2A) — employer-only. Base = basic + FIXED (HRDF-flagged) allowance net of
      // unpaid leave; NOT the EPF/SOCSO wage (overtime, bonus, and reimbursed claims are excluded).
      const fixedAllowance = en.hrdfAllowApplied;
      const hrdfBase = Math.max(0, round2(basic + fixedAllowance - unpaidDeduction));
      // Feedback 0df0c635 — per-employee "Subject to HRDF" (Others Statutory card), resolved via the pack
      // (D6 vocabulary — no direct core→localization/my import). Explicit false excludes this employee's
      // base from the levy entirely; explicit true keeps it in (the registration band below still sets the
      // rate — not_registered stays 0); null follows the company default, byte-identical to pre-flag runs.
      const hrdfSubject = pack.payroll.hrdfSubject(e.subjectToHrdf ?? null, hrdfStatus);
      // #6: HRDF rates come from the resolved ruleset (rules.hrdf) when overridden, else the built-in MY_HRDF.
      const hrdf = hrdfSubject ? pack.payroll.hrdfLevy(hrdfBase, hrdfStatus, rules.hrdf) : 0;
      // r79 — the levy above is UNCHANGED (an unregistered employer owes nothing; r75 settled that). What
      // changes is what the SLIP claims: stamping `hrdfSubject: true` next to a levy that can never be
      // anything but zero makes the payslip contradict itself. Suppression is keyed on the REGISTRATION
      // band, not on the computed amount — a subject employee whose base happened to be zero (a fully
      // unpaid month) is genuinely subject and still stamps true.
      const hrdfChargeable = hrdfStatus !== 'not_registered';
      const suppressHrdfSubject = hrdfSubject && !hrdfChargeable;
      // 1.2.3 CP38 — the month's LHDN instalment. Charged on the REGULAR run only: like basic/OT/unpaid/hrdf,
      // an additional (off-cycle/bonus/adjustment) run carries cp38 = 0 (a re-issue re-runs the regular batch,
      // not an adjustment run). So a regular + bonus run in one month charges exactly one instalment.
      const cp38 = isAdditionalRun ? 0 : round2(cp38ByEmp.get(e.employmentId)?.amount ?? 0);
      // Statutory contribution. Regular run: computed directly as today (byte-identical). Additional run
      // (Wave 2C): the INCREMENT of the cumulative month — re-run with/without this run's additional
      // remuneration and take the delta, so the normal wage's SOCSO/EPF (already charged by the regular
      // run) cancels, SOCSO/EIS add 0, and PCB nets against earlier same-month MTD (ADR-0024 §4).
      // Item d64d0df4 — `disabled` is the employee's CIRCUMSTANCE; the deduction it entitles them to is a
      // figure in the pack's ruleset, applied inside pcbMonth. `?? false` keeps a row that predates
      // migration 0341 (or a person with no statutory row at all) computing exactly as it does today.
      // Item d64d0df4 — the CHILD leg. Only an employee in 'auto_table' mode supplies a worked-out
      // amount: the pack turns their keyed category grid into RM using the resolved ruleset's
      // per-category figures (halving any 50%-share child). 'manual' and 'auto' employees supply
      // `undefined`, and pcbMonth then computes `children × perChild` — the identical expression it used
      // before this item, so their projection of P is unchanged to the cent.
      const childReliefAmount =
        e.childReliefMode === 'auto_table' && pack.payroll.childReliefAmountFor
          ? pack.payroll.childReliefAmountFor(e.childReliefTable, rules.pcb?.reliefs)
          : undefined;
      const taxProfile = {
        category: (e.taxCategory ?? 1) as 1 | 2 | 3,
        children: e.numChildren ?? 0,
        disabled: e.disabledIndividual ?? false,
        // `?? false` keeps a row that predates migration 0356 (or a person with no statutory row at all)
        // computing exactly as it does today.
        disabledSpouse: e.disabledSpouse ?? false,
        childReliefAmount,
      };
      // Item a7271737 — persisted SOCSO / EIS category override. 'auto' reproduces the age/citizenship derivation
      // below byte-for-byte; 'first'/'second' pin the SOCSO band; 'none' gates the respective scheme off (exactly
      // like subject_to_socso=false / eis_eligible=false do — the setter also derives those legacy booleans from
      // the category, so this is belt-and-braces and stays correct even for a legacy row that predates the column).
      const socsoCatSel = (e.socsoCategory ?? 'auto') as 'auto' | 'first' | 'second' | 'none';
      const eisCatSel = (e.eisCategory ?? 'auto') as 'auto' | 'none';
      const autoSocsoCategory = ((age != null && age >= 60) || (e.epfCitizenship ?? 'citizen') === 'non_citizen' ? 2 : 1) as 1 | 2;
      const stOpts = {
        // SOCSO Second Category (employer Injury-only) for age 60+ AND foreign workers (#156); both
        // still pay the employee SKBBK leg. EIS (Act 800) is Malaysian 18–60 only — not 60+, not foreign.
        // 'auto' keeps that derivation; 'first'/'second' force the band (item a7271737).
        socsoCategory: (socsoCatSel === 'first' ? 1 : socsoCatSel === 'second' ? 2 : autoSocsoCategory) as 1 | 2,
        eisEligible:
          eisCatSel === 'none'
            ? false
            : (e.eisEligible ?? true) && (age == null || age < 60) && (e.epfCitizenship ?? 'citizen') !== 'non_citizen',
        // Item 5a461b99 — "Subject to SOCSO"/"Subject to SKBBK". Default on (a person with no statutory row
        // keeps today's SOCSO + mandatory SKBBK) so this is byte-identical for every currently-covered
        // employee; unchecking exempts that scheme (zero reported contribution). Item a7271737: SOCSO category
        // 'none' also gates SOCSO off (the two are kept in sync by the setter).
        subjectToSocso: socsoCatSel === 'none' ? false : (e.subjectToSocso ?? true),
        subjectToSkbbk: e.subjectToSkbbk ?? true,
        resident: e.isResident ?? true,
        // Item 8b5334db — resolve the flat PCB rate from tax residency (falling back to isResident for a legacy
        // row with no residency set). resident ⇒ null (full MTD); non_resident ⇒ 0.30 (identical to the old
        // resident:false path); rep / knowledge_worker ⇒ 0.15 (Returning Expert Programme / Knowledge Worker in a
        // specific region — flat incentive rate, no reliefs). Byte-identical for every existing resident/non-res row.
        flatTaxRate: (() => {
          const r = e.taxResidency ?? (e.isResident === false ? 'non_resident' : 'resident');
          if (r === 'non_resident') return 0.3;
          if (r === 'rep' || r === 'knowledge_worker') return 0.15;
          return null;
        })(),
        // EPF rule selection (#95): age + citizenship pick Part A / Part E senior / non-citizen 2%/2%.
        epfAge: age,
        epfCitizenship: e.epfCitizenship ?? 'citizen',
        // EPF contribution mode (Wave 2B): i-Topup excess / exempt. Rates are decimals; null = statutory.
        epfElection: {
          mode: e.epfMode ?? 'auto',
          employeeRate: e.epfEmployeeRate != null ? Number(e.epfEmployeeRate) : null,
          employerRate: e.epfEmployerRate != null ? Number(e.epfEmployerRate) : null,
        },
      };
      // 1.2.4 Zakat — resolve THIS month's zakat at generate time so percent never goes stale (declared up
      // front so `computeMonth`'s default can read it; the percent branch is filled in after the closure):
      //  1) a manual `payroll_input.zakat > 0` (admin override) wins — preserves today's behaviour. NOTE
      //     (feedback d435673e): the Zakat screen no longer writes payroll_input.zakat (its one-off override
      //     section was removed); this manual tier is now fed ONLY by the batch input grid, prefillFixedZakat,
      //     and the batch import. Precedence is unchanged (manual > fixed > percent_of_pcb).
      //  2) else (REGULAR run only) an active 'fixed' election uses its flat amount;
      //  3) else (REGULAR run only) an active 'percent_of_pcb' election multiplies the LIVE pre-offset normal
      //     MTD — derived by a single zero-zakat probe call that reuses this loop's already-built
      //     wages/profile/acc/opts/rules (no shadow re-derivation), so the figure tracks the current PCB;
      //  4) else 0. The figure then drives `applyZakatOffset` (PCB reduction) + the Z accumulator unchanged.
      // The election is gated to the regular run (like CP38/HRDF): an additional/off-cycle run carries ONLY
      // the manual `payroll_input.zakat`, so a one-month regular + bonus pair applies the election ONCE.
      let effectiveZakat =
        zakat > 0
          ? zakat
          : !isAdditionalRun && e.zakatActive && e.zakatMethod === 'fixed'
            ? round2(Number(e.zakatFixed ?? 0))
            : 0;
      // `zakatCurrent` defaults to the resolved figure, but the percent_of_pcb probe passes 0 to read the
      // pre-offset normal MTD without a circular dependency.
      const computeMonth = (additional: number, ot: number, zakatCurrent = effectiveZakat) =>
        pack.payroll.statutory(
          wagesExOt,
          taxProfile,
          additional,
          ot,
          { month: pMonth, acc: accByEmp.get(e.employmentId), lpCurrent: lp, zakatCurrent },
          stOpts,
          rules,
        );
      // Step 4 (f3148da1) — the OT figure fed to the statutory engine INCLUDES the converted excess, so the
      // redirected amount keeps overtime's statutory character (SOCSO/EIS/PCB, EPF-exempt). The DISPLAYED
      // overtime line stays the capped figure; the excess shows under the chosen pay item. Convert=0 ⇒ otStat===overtime.
      const otStat = round2(overtime + otConvertAmount);
      if (zakat <= 0 && !isAdditionalRun && e.zakatActive && e.zakatMethod === 'percent_of_pcb') {
        const probe = computeMonth(bonus, otStat, 0);
        effectiveZakat = round2(Number(e.zakatPercent ?? 0) * (probe.pcbNormalPreZakat ?? 0));
      }
      const earlierRun = earlierRunByEmp.get(e.employmentId) ?? { additional: 0, overtime: 0 };
      const stCore = isAdditionalRun
        ? deltaStat(
            computeMonth(earlierRun.additional + bonus, earlierRun.overtime),
            computeMonth(earlierRun.additional, earlierRun.overtime),
          )
        : computeMonth(bonus, otStat);
      const st = {
        ...stCore,
        // Stamped so future months' replay can accumulate Z and ∑LP (spec §E.5 / §D.1).
        lp,
        zakat: effectiveZakat,
        // HRD Corp levy rides the normal wage (regular run only); a bonus/off-cycle run adds none.
        hrdf: isAdditionalRun ? 0 : hrdf,
        // 1.2.3 CP38 — stamped as the DISTINCT CP39 source (separate from PCB) + its LHDN ref, only when
        // non-zero (regular run). `statutory` is plain jsonb with no allow-list validator, so this is safe;
        // it is NOT a DELTA_KEY (that would corrupt additional-run delta math). The net figure is folded
        // once into otherDeductions below, so net/total reconcile without double-counting.
        ...(cp38 > 0 ? { cp38, cp38Ref: cp38ByEmp.get(e.employmentId)?.cp38Ref } : {}),
        // EPF contribution mode applied (Wave 2B audit) — 'auto' unless an i-Topup/exempt election.
        epfMode: e.epfMode ?? 'auto',
        // Step 4 (f3148da1) — the OT excess redirected to a pay item (regular run, amount>0 only). Drives the
        // dedicated earnings line on the payslip; the amount is already folded into `allowance`/gross above.
        ...(otConvertAmount > 0 && otConvertComp
          ? { otConvert: { code: otConvertComp.code, name: otConvertComp.name, amount: otConvertAmount } }
          : {}),
        // #6 (ADR-0037): per-body version map, present only when a component override is in effect.
        ...(componentVersions ? { componentVersions } : {}),
        // ADR-0025 §5 (Option A): non-payable, non-taxable components recorded for the payslip only — they
        // do NOT affect gross/net (key present only when there is at least one, to preserve byte-identical
        // parity with the legacy path which never produces record lines). Carried on the regular run only —
        // an additional/off-cycle run pays solely its bonus and would otherwise re-list the same record.
        // f1564110 Phase 3 — consumed one-off transactions append NAMED provenance lines (flag off ⇒ the
        // txn list is empty ⇒ byte-identical): the payslip shows each one-off item by name; deductions
        // carry a negative sign; 'leave' rows appear here record-only.
        ...(!isAdditionalRun && (en.recordLines.length || (txnRecordLinesByEmp.get(e.employmentId)?.length ?? 0))
          ? { recordLines: [...en.recordLines, ...(txnRecordLinesByEmp.get(e.employmentId) ?? [])] }
          : {}),
        // Feedback 862ed0ad — the per-component detail behind the summarised earnings/deduction figures.
        // Written from THIS run onward only: the detail was never stored before, so the runs already
        // completed cannot be itemised retrospectively and Transaction View says so on screen rather than
        // rendering an empty breakdown. Key absent when there is nothing to say, which keeps payslips from
        // the flag-off path (and every historical slip) byte-identical.
        //
        // Regular run only, for the same reason recordLines is: an additional/off-cycle run re-folds the
        // same recurring components, so stamping there would list them twice for one month.
        ...(!isAdditionalRun && en.componentLines.length ? { componentLines: en.componentLines } : {}),
        // Feedback 09b554e9 — per-code exemption/LP usage this month, replayed by future months' YTD
        // accumulator (like st.lp) and summed into the EA exempt-allowances figure. Regular run only
        // (an additional run re-folds the same recurring components; stamping again would double-count
        // the replay). Key present only when at least one code was used — legacy slips are byte-identical.
        ...(!isAdditionalRun && Object.keys(en.exemptionUsed).length ? { exemptionUsed: en.exemptionUsed } : {}),
      };

      // Item 5a461b99 — "Employer bears" reassignment. The contribution is still computed AND reported in
      // full (st.socsoEmployee / st.eisEmployee / st.socsoSkbbk are untouched, so SOCSO/EIS reports + the
      // submitted PERKESO file are unchanged). What changes is WHO funds the employee's share: when a flag is
      // on, that share is NOT deducted from the employee (removed from statDeductions below) and is instead
      // added to employer cost. Off by default ⇒ 0 ⇒ byte-identical. On an additional run the SOCSO/EIS deltas
      // are ~0 (bonus excluded), so employer-borne is naturally ~0 there too.
      const bearsSocso = e.employerBearsSocso ?? false;
      const bearsEis = e.employerBearsEis ?? false;
      const bearsSkbbk = e.employerBearsSkbbk ?? false;
      const employerBorneSocso = bearsSocso ? round2(st.socsoEmployee) : 0;
      const employerBorneEis = bearsEis ? round2(st.eisEmployee) : 0;
      const employerBorneSkbbk = bearsSkbbk ? round2(st.socsoSkbbk) : 0;
      // Item 8b5334db — "Employer bears tax": the PCB is still computed + reported in full (st.pcb untouched, so
      // CP39/PCB reports + the amount remitted to LHDN are unchanged), but the employee's take-home is NOT reduced
      // by it — the employer funds it. Same funding plumbing as the SOCSO/EIS employer-bears flags: subtract from
      // statutory deductions, add to employer cost. Off by default ⇒ 0 ⇒ byte-identical. NOTE (documented
      // follow-up): under LHDN, tax the employer pays on an employee's behalf is itself a taxable benefit, so a
      // fully-correct treatment grosses up (tax-on-tax). This implements the funding/plumbing; gross-up is deferred.
      const bearsTax = e.employerBearsTax ?? false;
      const employerBorneTax = bearsTax ? round2(st.pcb) : 0;
      // Item 0d9bb2da — "Employer bears EPF": the EPF employee + employer contributions are still computed +
      // reported in full (st.epfEmployee / st.epfEmployer untouched, so the KWSP file + EPF report + the amount
      // remitted to KWSP are unchanged), but the employee's EPF share is NOT deducted from take-home — the
      // employer funds it. Same funding plumbing as the SOCSO/EIS/tax employer-bears flags: subtract from
      // statutory deductions, add to employer cost. Off by default ⇒ 0 ⇒ byte-identical. NOTE (documented
      // follow-up, same as the tax control): under LHDN, EPF the employer pays on an employee's behalf is a
      // taxable perquisite; a fully-correct treatment grosses it up. This implements funding/plumbing only.
      const bearsEpf = e.employerBearsEpf ?? false;
      const employerBorneEpf = bearsEpf ? round2(st.epfEmployee) : 0;
      const employerBorneTotal = round2(
        employerBorneSocso + employerBorneEis + employerBorneSkbbk + employerBorneTax + employerBorneEpf,
      );

      // Payslip amounts. An additional run pays ONLY its additional remuneration — the normal wage,
      // allowance and OT were paid by the regular run — so basic/allowance/OT are 0 and gross = the bonus.
      const slipBasic = isAdditionalRun ? 0 : basic;
      const slipAllowance = isAdditionalRun ? 0 : allowance;
      const slipOvertime = isAdditionalRun ? 0 : overtime;
      const slipUnpaid = isAdditionalRun ? 0 : unpaidDeduction;
      const grossPay = isAdditionalRun ? round2(bonus) : round2(normalWage + bonus);
      // Item 5a461b99 — subtract any employer-borne employee shares so they are NOT deducted from net pay
      // (employerBorneTotal is 0 unless an "Employer bears" flag is set ⇒ byte-identical default path).
      const statDeductions = round2(
        st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb - employerBorneTotal,
      );
      // M#16 (EA s.24 net-floor): clamp EVERY post-tax deduction in priority order so net ≥ 0 BY
      // CONSTRUCTION, never as a downstream patch. Headroom after statutory + unpaid is the cash that
      // remains; manual deduction (en.deduct) takes first claim, then CP38 (court/LHDN order — exempt from
      // the private 50% cap but still cannot produce a negative net), then the loan (ADR-0060, lowest
      // priority). Each clamp is round2()'d. The byte-identical guarantee holds: with no manual deduct, no
      // CP38, and no loan, manual/cp38/loan all clamp to 0 ⇒ slipExtraDeduct=0, slipLoan=0, exactly as
      // before. Statutory: EA 1955 s.24(1)/(8).
      const rawManual = isAdditionalRun ? 0 : round2(en.deduct);
      const rawCp38 = isAdditionalRun ? 0 : round2(cp38);
      // 1.2.8 Loan instalment (ADR-0060) — POST-TAX: only reduces net, touches NO statutory base. An
      // additional/off-cycle run charges no loan (handled like cp38/hrdf).
      const rawLoan = isAdditionalRun ? 0 : round2(loanByEmp.get(e.employmentId) ?? 0);
      const avail = round2(grossPay - statDeductions - slipUnpaid);
      const manualApplied = Math.max(0, Math.min(rawManual, avail));
      const afterManual = round2(avail - manualApplied);
      const cp38Applied = Math.max(0, Math.min(rawCp38, afterManual));
      const afterCp38 = round2(afterManual - cp38Applied);
      const slipLoan = Math.max(0, Math.min(rawLoan, afterCp38));
      // 1.2.3 CP38 + the manual deduction fold into the SINGLE extra-deduction source: otherDeductions
      // (line below) and totalDeductions/net then reflect them automatically — no separate add-to-total.
      const slipExtraDeduct = round2(manualApplied + cp38Applied);
      // Record any deduction the headroom could not fully recover so the batch warns (M#16) — never silent.
      if (manualApplied + 0.005 < rawManual || cp38Applied + 0.005 < rawCp38 || slipLoan + 0.005 < rawLoan) {
        deductionClampsByEmp.set(e.employmentId, {
          manualRequested: rawManual, manualApplied,
          cp38Requested: rawCp38, cp38Applied,
          loanRequested: rawLoan, loanApplied: slipLoan,
        });
      }
      // Record the ACTUAL loan recovered (cents) so applyLoansForBatch advances the ledger by the clamped
      // amount — the reserved due may exceed it; the shortfall re-schedules (C2/H1/H3 fix).
      appliedLoanCentsByEmp.set(e.employmentId, Math.round(slipLoan * 100));
      // 1a — policy rounding (earnings → gross, deductions → total, net → net). Default 'none'/null config ⇒
      // applyRounding === round2 ⇒ byte-identical. Applied as a thin shell so the gross/deductions/net the
      // payslip stores already reflect the policy; net is then re-derived from the rounded components so it
      // reconciles, then net-rounding (if any) applies last.
      const roundedGross = applyRounding(grossPay, cfg?.rounding?.earnings);
      const totalDeductionsRaw = round2(statDeductions + slipUnpaid + slipExtraDeduct + slipLoan);
      let totalDeductions = applyRounding(totalDeductionsRaw, cfg?.rounding?.deductions);
      let net = applyRounding(round2(roundedGross - totalDeductions), cfg?.rounding?.netPay);
      // 1d — negative-net handling. 'set_zero' floors a negative net at 0; 'retain'/null leaves it (the s.24
      // clamp above already keeps net ≥ 0 on the standard path, so 'retain' is a no-op there — byte-identical).
      // Step 2 'carry_forward' (f3148da1): holds a negative net at 0 THIS cycle and recovers a PRIOR carried
      // balance from this cycle's positive net — the running balance is DERIVED (carryForwardByEmp) from earlier
      // closed cycles and re-stamped below for the next cycle to read. Both adjustments are folded into
      // totalDeductions so the payslip invariant net = gross − totalDeductions still holds.
      let carryForward: { applied: number; added: number; balanceBefore: number } | null = null;
      if (cfg?.negativeNet === 'set_zero' && net < 0) {
        net = 0;
      } else if (cfg?.negativeNet === 'carry_forward' && !isAdditionalRun) {
        const owed = round2(carryForwardByEmp.get(e.employmentId) ?? 0); // >0 ⇒ carried from prior cycle(s)
        let applied = 0;
        let added = 0;
        // Recover the prior balance from this cycle's positive net (never pushing net below 0 in one hit).
        if (owed > 0 && net > 0) {
          applied = Math.min(owed, net);
          net = round2(net - applied);
        }
        // A still-negative net (statutory + unpaid exceeded gross) is deferred: raise it to 0 and carry the
        // shortfall forward. (Mutually exclusive with `applied` — net can't be both > 0 and < 0.)
        if (net < 0) {
          added = round2(-net);
          net = 0;
        }
        if (applied > 0 || added > 0) {
          // Recovery rides deductions (net ↓); a deferred shortfall is a negative deduction (net ↑).
          totalDeductions = round2(totalDeductions + applied - added);
          carryForward = { applied, added, balanceBefore: owed };
        }
      }
      // Item 5a461b99 — any employer-borne employee share is real employer outlay, so it adds to employer
      // cost (employerBorneTotal is 0 unless an "Employer bears" flag is set ⇒ byte-identical default path).
      const employerCost = isAdditionalRun
        ? round2(bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer + employerBorneTotal)
        // Step 4 (f3148da1) — the converted OT excess is real employer outlay (paid to the employee), so it
        // adds to employer cost alongside the OT it was rerouted from. Default (no convert) ⇒ 0 ⇒ unchanged.
        : round2(wagesExOt + overtime + otConvertAmount + bonus + en.reimburse + st.epfEmployer + st.socsoEmployer + st.eisEmployer + hrdf + employerBorneTotal);

      // c7fdfcf6 gap-fix (functional weekly/bi-weekly) — disburse this employee's NET across the run's cut-off
      // CYCLES. Recurring pay (basic + allowance + bonus) prorates by cycle days; OT follows each cycle's OT
      // minutes (from attendance, bucketed by date); the unpaid-leave deduction follows each cycle's unpaid days;
      // each cycle's NET operational earnings then weight the NET split. The per-cycle amounts sum EXACTLY to net
      // (the residual lands on the last cycle). Only produced for weekly/biweekly (perCycle) regular runs; monthly
      // and additional runs produce no schedule ⇒ their payslip statutory blob is byte-identical to before.
      let paymentSchedule: { seq: number; from: string; to: string; amount: number }[] | null = null;
      if (perCycle && !isAdditionalRun) {
        const periods = runSchedule.periods;
        const otMin = cycleOtMinutesByEmp.get(e.employmentId) ?? periods.map(() => 0);
        const upDays = cycleUnpaidDaysByEmp.get(e.employmentId) ?? periods.map(() => 0);
        const cycleDays = periods.map(
          (pd) => Math.round((Date.parse(`${pd.end}T00:00:00Z`) - Date.parse(`${pd.start}T00:00:00Z`)) / 86_400_000) + 1,
        );
        const amounts = disburseNetAcrossCycles({
          net,
          recurring: round2(slipBasic + slipAllowance + bonus),
          overtime: slipOvertime,
          unpaid: slipUnpaid,
          cycleDays,
          otMinutes: otMin,
          unpaidDays: upDays,
        });
        paymentSchedule = periods.map((pd, i) => ({ seq: pd.seq, from: pd.start, to: pd.end, amount: amounts[i] }));
      }

      // ── Feedback 3c473773 — the display overlay, stamped ONLY when it says something ─────────────────
      // The four stored columns keep the kernel's statutory bucketing (and every statutory form keeps
      // reading them). This is the SAME money re-labelled under the boxes the pay items declare, so a
      // payslip screen can print an overtime code under Overtime while LHDN still sees it as additional
      // remuneration. Derived here, where the OT caps, the one-off OT and the converted OT excess are all
      // in scope, so the overlay reconciles with grossPay by construction rather than by a screen's
      // arithmetic (pinned by test/pay-display-category.test.ts).
      //
      //   allowance  keeps otConvertAmount inside it, exactly as the stored column does, so a caller that
      //              subtracts otConvert for its own line keeps the identical expression.
      //   overtime   is the stored (capped) figure, plus what moved in, less what moved out.
      //
      // NOT stamped when: nothing was re-categorised (⇒ every existing payslip and every ordinary run is
      // byte-identical); an additional/off-cycle run (which pays only its additional remuneration and
      // re-folds the same recurring components — the same reason componentLines is regular-run only); or an
      // OT cap clipped an amount that also moved OUT of the overtime box, where subtracting a pre-cap
      // figure from a post-cap one is not well defined. In every one of those cases the screens fall back
      // to the stored columns, which is the correct answer and not a degraded one.
      const otOutbound = Math.min(en.displayOtOutbound, slipOvertime);
      const displayEarnings =
        !isAdditionalRun && en.displayMoved && otOutbound === en.displayOtOutbound
          ? {
              basic: round2(slipBasic + en.display.basic),
              allowance: round2(otConvertAmount + en.display.allowance),
              overtime: round2(slipOvertime - en.overtime + en.display.overtime),
              bonus: round2(bonus - en.bonus + en.display.bonus),
              claim: round2(en.display.claim),
            }
          : null;

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: slipBasic.toFixed(2),
        allowance: slipAllowance.toFixed(2),
        overtimePay: slipOvertime.toFixed(2),
        bonus: bonus.toFixed(2),
        daysWorked: isAdditionalRun ? null : String(daysWorked),
        grossPay: roundedGross.toFixed(2),
        // Fix-5 (M#17): carry the OT provenance onto the immutable statutory snapshot so an auditor reading a
        // closed payslip can tell whether the overtime was attendance-derived or manually keyed. Only stamped
        // when this slip actually pays OT and the input row carries a provenance (no misleading flag on a
        // zero-OT slip / additional run, which sets slipOvertime to 0).
        statutory: {
          ...st,
          ...statutoryProvenance,
          ...(slipOvertime > 0 && otSourceByEmp.get(e.employmentId)
            ? { otSource: otSourceByEmp.get(e.employmentId) }
            : {}),
          // Step 2 carry_forward (f3148da1) — the recovered/deferred amounts + the balance before this cycle.
          // Only stamped when non-zero (byte-identical to today for every other path); the NEXT cycle's balance
          // derivation replays these stamps (Σ added − applied) off closed payslips.
          ...(carryForward ? { carryForward } : {}),
          // c7fdfcf6 gap-fix — the per-cycle DISBURSEMENT schedule for a weekly/bi-weekly run (present only when
          // the run frequency is weekly/biweekly; absent ⇒ byte-identical monthly slip). The employer pays each
          // cycle's `amount` on its cadence; statutory contributions stay settled monthly on this same payslip.
          ...(paymentSchedule ? { paymentSchedule: { frequency: runFrequency, cycles: paymentSchedule } } : {}),
          // Feedback 3c473773 — the payslip's OWN record of which box each figure belongs in, so a screen
          // never has to re-derive it from today's pay-item setup (which would let a category changed in
          // March silently rewrite January). Absent ⇒ read the stored columns, unchanged.
          ...(displayEarnings ? { displayEarnings } : {}),
          // Feedback 0df0c635 — snapshot the EFFECTIVE per-employee HRDF subjectivity, ONLY when HR set an
          // explicit override (a null/untouched row stays absent ⇒ byte-identical to pre-flag slips). The
          // audited-inputs convention: a closed payslip records the setting as it was when it was computed.
          // r79 — "effective" now means effective, not merely stored: when the employer is not registered no
          // levy can be charged, so the slip records hrdfSubject: false. HR's intent is NOT lost —
          // hrdfSubjectSet carries what was ticked and hrdfSubjectSuppressed carries why it could not take
          // effect, so the audit trail is richer than before while the slip no longer says "subject" beside
          // a structural zero. Registered companies (and every explicit No) are byte-identical to today.
          ...(e.subjectToHrdf != null
            ? suppressHrdfSubject
              ? { hrdfSubject: false, hrdfSubjectSet: true, hrdfSubjectSuppressed: 'company_not_registered' }
              : { hrdfSubject }
            : {}),
          // Item 5a461b99 — snapshot the "Employer bears" decision + the amounts the employer absorbed for
          // provenance, ONLY when at least one flag is set (absent ⇒ byte-identical to today). The reported
          // socso/eis/skbbk figures above are unchanged; this records that their EMPLOYEE share was not deducted.
          ...(bearsSocso || bearsEis || bearsSkbbk || bearsTax || bearsEpf
            ? {
                // Item 8b5334db — `tax` extends the employer-bears snapshot (absent ⇒ byte-identical to the
                // SOCSO/EIS-only snapshot). Records that the employee's PCB share was funded by the employer.
                // Item 0d9bb2da — `epf` extends it again (records the employee's EPF share funded by the
                // employer). The whole block stays absent when EVERY flag is off ⇒ byte-identical default.
                employerBears: { socso: bearsSocso, eis: bearsEis, skbbk: bearsSkbbk, tax: bearsTax, epf: bearsEpf },
                employerBorne: {
                  socso: employerBorneSocso,
                  eis: employerBorneEis,
                  skbbk: employerBorneSkbbk,
                  tax: employerBorneTax,
                  epf: employerBorneEpf,
                  total: employerBorneTotal,
                },
              }
            : {}),
        }, // `version` + (when source=pack) packVersion/signedKeyId snapshot + (when OT paid) otSource
        // Carry-forward recovery/deferral rides otherDeductions too, so the invariant
        // totalDeductions = statDeductions + otherDeductions holds (0 for every non-carry_forward path).
        otherDeductions: round2(
          slipUnpaid + slipExtraDeduct + slipLoan + (carryForward ? carryForward.applied - carryForward.added : 0),
        ).toFixed(2),
        totalDeductions: totalDeductions.toFixed(2),
        netPay: net.toFixed(2),
        employerCost: employerCost.toFixed(2),
        // OCC (9bc442bc): a fresh generation is version 1; a selective reprocess bumps the prior version.
        version: subset ? (versionByEmp.get(e.employmentId) ?? 0) + 1 : 1,
      });

      totals.gross += roundedGross;
      totals.net += net;
      totals.epfEmployee += st.epfEmployee;
      totals.epfEmployer += st.epfEmployer;
      totals.socsoEmployee += st.socsoEmployee;
      totals.socsoEmployer += st.socsoEmployer;
      totals.eisEmployee += st.eisEmployee;
      totals.eisEmployer += st.eisEmployer;
      totals.pcb += st.pcb;
      totals.hrdfEmployer += isAdditionalRun ? 0 : hrdf;
      totals.deductions += totalDeductions;
      totals.employerCost += employerCost;
    }
    (Object.keys(totals) as (keyof typeof totals)[]).forEach((k) => {
      totals[k] = round2(totals[k]);
    });

    // ── Selective reprocess (9bc442bc, reporter #8): delta-update batch totals/GL, keep status
    //    processed + headcount unchanged, record OCC + before/after per-employee history + status
    //    history, and DO NOT re-run loan/claim side-effects (already applied at original processing). ──
    if (subset) {
      const stored = (batch.totals ?? {}) as Record<string, number>;
      const deltaTotals = { ...totals };
      (Object.keys(deltaTotals) as (keyof typeof deltaTotals)[]).forEach((k) => {
        deltaTotals[k] = round2((Number(stored[k]) || 0) + totals[k] - oldTotals[k]);
      });
      await tx.update(payrollBatch).set({ totals: deltaTotals }).where(eq(payrollBatch.id, p.batchId));

      // Per-employee before/after result snapshots (dedicated audit table — reporter req.).
      const newSlips = await tx
        .select()
        .from(payslip)
        .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, emps.map((e) => e.employmentId))));
      const actor = subset.actorId ? { type: 'user' as const, id: subset.actorId } : actorOf(ctx);
      for (const sl of newSlips) {
        await tx.insert(payrollEmployeeResultHistory).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId: sl.employmentId,
          action: 'reprocess',
          actorType: actor.type,
          actorId: actor.id ?? null,
          reason: subset.reason ?? null,
          versionBefore: versionByEmp.get(sl.employmentId) ?? null,
          versionAfter: sl.version,
          before: beforeByEmp.get(sl.employmentId) ?? null,
          after: {
            grossPay: sl.grossPay, netPay: sl.netPay, totalDeductions: sl.totalDeductions,
            employerCost: sl.employerCost, statutory: sl.statutory, version: sl.version,
          },
        });
      }
      // Status history (status is unchanged processed→processed, but the reprocess IS a status-control
      // event the reporter wants captured with actor/timestamp/reason + before/after totals).
      await tx.insert(payrollStatusHistory).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        action: 'reprocess',
        fromStatus: 'processed',
        toStatus: 'processed',
        actorType: actor.type,
        actorId: actor.id ?? null,
        reason: subset.reason ?? null,
        before: { totals: stored },
        after: { totals: deltaTotals, reprocessedEmploymentIds: emps.map((e) => e.employmentId) },
      });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.selective-reprocessed',
        actor,
        payload: {
          batchId: p.batchId,
          companyId: batch.companyId,
          payPeriod: batch.payPeriod,
          reprocessedCount: emps.length,
          headcount: batch.employeeCount,
          reason: subset.reason ?? null,
          employmentIds: emps.map((e) => e.employmentId),
        },
      });
      return { reprocessed: emps.length, headcount: batch.employeeCount, totals: deltaTotals };
    }

    await tx
      .update(payrollBatch)
      .set({ status: 'processed', employeeCount: emps.length, totals })
      .where(eq(payrollBatch.id, p.batchId));

    // 1.2.8 Loan instalments reserved on this batch are now on a finalized payslip → advance the loan ledger
    // (decrement outstanding, increment instalments_paid, mark applied, auto-settle) — ADR-0060 two-phase.
    // Placed beside the claim-paid block so every irreversible loan mutation ties to a written payslip.
    await applyLoansForBatch(tx, ctx, p.batchId, appliedLoanCentsByEmp);

    // Money-safety fix (Payroll Process wizard plan): taxable claims prefilled into this batch are marked
    // paid ONLY for employments that actually received a payslip in THIS run — not every claim reserved on
    // the batch. Before the filters, an unfiltered run always covered the whole company so `emps` and "every
    // reserved claim" were the same set; a scoped run made that assumption false — a claim reserved for
    // someone outside the run (or comp-less, so no payslip was written) would otherwise be marked paid with
    // nothing actually disbursed. Claims whose employment got no payslip here are UNLINKED (payrollBatchId
    // reset to null, status stays 'approved') so `prefillClaimsForBatch`'s isNull(payrollBatchId) filter
    // re-queues them on the next batch instead of stranding them forever.
    const paidEmploymentIds = new Set(emps.map((e) => e.employmentId));
    const reservedClaims = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId })
      .from(claimRequest)
      .where(and(eq(claimRequest.payrollBatchId, p.batchId), eq(claimRequest.status, 'approved')));
    const toMarkPaid = reservedClaims.filter((c) => paidEmploymentIds.has(c.employmentId)).map((c) => c.id);
    const toRequeue = reservedClaims.filter((c) => !paidEmploymentIds.has(c.employmentId)).map((c) => c.id);
    const paidClaims = toMarkPaid.length
      ? await tx
          .update(claimRequest)
          .set({ status: 'paid', paidAt: new Date(), payoutRef: `payroll:${batch.payPeriod}` })
          .where(inArray(claimRequest.id, toMarkPaid))
          .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId })
      : [];
    if (toRequeue.length) {
      await tx.update(claimRequest).set({ payrollBatchId: null }).where(inArray(claimRequest.id, toRequeue));
    }
    for (const c of paidClaims) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.paid',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { via: 'payroll', batchId: p.batchId },
      });
    }

    // M#16 (EA s.24 net-floor): if the period's headroom could not fully recover a manual deduction, CP38,
    // or loan for any employee, emit a batch-level clamp warning so the reduction is never silent (visible
    // on the batch summary / audit trail). Only the field NAMES + per-employee RM amounts of the clamped
    // deductions are recorded; no other cleartext pay. Omitted entirely when nothing was clamped.
    if (deductionClampsByEmp.size > 0) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 's24.deduction.clamped',
        actor: actorOf(ctx),
        payload: {
          batchId: p.batchId,
          clampedCount: deductionClampsByEmp.size,
          clamps: [...deductionClampsByEmp.entries()].map(([employmentId, c]) => ({ employmentId, ...c })),
        },
      });
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.processed',
      actor: actorOf(ctx),
      payload: {
        count: emps.length,
        totalNet: totals.net,
        // c7fdfcf6 gap-fix — the resolved payroll frequency + generated cut-off periods for this run. When the
        // frequency is weekly/biweekly (`disbursedPerCycle`), each payslip carries a per-cycle disbursement
        // schedule (statutory.paymentSchedule) so the run is FUNCTIONALLY processed per cycle, not audit-only.
        cutOffSchedule: { frequency: runFrequency, periods: runSchedule.periods, disbursedPerCycle: perCycle },
      },
    });
    return { payslips: emps.length, totalNet: totals.net };
  });
}

export async function closeBatch(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, payPeriodId: payrollBatch.payPeriodId, companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    // Granular RBAC (9bc442bc): payroll.close (configurable per company/tenant), not a coarse admin check.
    await assertPayrollPermission(tx, ctx, 'payroll.close', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotCloseableError();
    // Step 6 (f3148da1) — compute the payslip RELEASE instant NOW, under this admin session (which can read the
    // company release config; the ESS employee session cannot, so the gate must be materialized here, not at
    // read time). We read the company's release config + pay-day and derive releasedAt from the close instant;
    // NULL config ⇒ immediate ⇒ releasedAt = closedAt (today's behaviour). The ESS reads gate on released_at.
    const closedAt = new Date();
    const [cpc] = await tx
      .select({ payDay: companyPayrollConfig.payDay, payslipRelease: companyPayrollConfig.payslipRelease })
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, batch.companyId))
      .limit(1);
    const releasedAt = payslipReleaseAt(closedAt, batch.payPeriod, cpc?.payDay ?? null, cpc?.payslipRelease ?? null) ?? closedAt;
    await tx
      .update(payrollBatch)
      .set({ status: 'closed', closedAt: sql`now()`, releasedAt })
      .where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.closed',
      actor: actorOf(ctx),
      payload: { releasedAt: releasedAt.toISOString() },
    });

    // Wave 2C (ADR-0024): close the parent pay_period once ALL its runs are closed, so the statutory
    // month becomes immutable. A single-run month closes its period when that run closes.
    const siblings = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, batch.payPeriodId));
    if (siblings.every((s) => s.status === 'closed')) {
      await tx.update(payPeriod).set({ status: 'closed' }).where(eq(payPeriod.id, batch.payPeriodId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: batch.payPeriodId,
        eventType: 'pay-period.closed',
        actor: actorOf(ctx),
        payload: {},
      });
    }
  });
}

/**
 * Payroll Reset / Zeroization (feedback a03b2d9b) — revert a PROCESSED run to DRAFT by reversing
 * exactly what generatePayslips did:
 *   1. loan-ledger advance is unwound (outstanding restored, instalments_paid decremented, the
 *      applied repayment back to 'reserved' on this batch, an apply-time shortfall re-schedule row
 *      removed, an auto-settled loan reopened);
 *   2. claims this batch marked paid go back to 'approved' (paidAt/payoutRef cleared) and STAY
 *      queued on the batch (payroll_batch_id kept) so the re-run re-picks them;
 *   3. the payslips are deleted and the batch's derived results (totals, employee_count) cleared;
 *   4. status returns to 'draft'.
 * The admin's keyed DRAFT inputs (payroll_input, payroll_individual_txn, payroll_batch_component)
 * are deliberately PRESERVED — the approved plan's "return to Draft so they can amend and
 * reprocess" semantics — so an unchanged reset → regenerate is byte-identical. That is also why
 * teardownDraftChildren is NOT called here: it is the draft-DELETE cascade, which wipes the keyed
 * inputs and detaches claims; a reset keeps both. (generatePayslips never touches those tables, so
 * reversing it must not either.)
 *
 * Safety vs 0011_payroll_immutability.sql: the triggers freeze 'closed' batches/payslips ONLY —
 * 'processed' is deliberately not trigger-frozen, which is what makes this reset DB-legal. The
 * status guard below refuses anything but 'processed'; a closed batch stays permanently immutable
 * (the trigger is the hard backstop even if this app-level guard were ever bypassed). The parent
 * pay_period needs no work: it only closes when ALL runs close, so a processed run's period is
 * still 'open'.
 *
 * Event sourcing: history is never deleted — the earlier payroll-batch.processed /
 * claim-request.paid / loan.instalment.applied events stay; this appends reversal events so the
 * log reads processed → reset → (re)processed. Statutory-report artefacts already recorded for
 * this company+period are counted into the reset payload for audit visibility (the approved plan
 * gates reset on batch status only — recorded reports are append-only artefacts, reproducible
 * after the corrected re-run).
 */
export async function resetProcessedBatch(ctx: SessionContext, p: { batchId: string; reason?: string }) {
  // Ships dark behind a flag (approved plan): enable per environment after review.
  if (!settingEnabled(ctx, 'payroll.reset_enabled')) {
    // SettingNotEnabledError, not ModuleNotEnabledError('payroll'): this tenant owns Payroll. What is
    // off is an operator-controlled risk switch, and `ModuleNotEnabledError.moduleCode` exists so a
    // caller can say "not on your plan" — which would be a false billing statement here.
    throw new SettingNotEnabledError('payroll.reset_enabled', 'Payroll reset is not enabled.');
  }
  // Mandatory reason (feedback d1ed1e99): reverting a processed run to draft is a sensitive, audited
  // action (zeroizes payslips/totals + unwinds loans/claims) — reject a blank/whitespace-only reason
  // BEFORE any deletion or status change so nothing is mutated. Mirrors unlockClosedBatch.
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new ResetReasonRequiredError();
  const toC = (v: unknown) => Math.round(Number(v) * 100);
  const fromC = (c: number) => (c / 100).toFixed(2);
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        totals: payrollBatch.totals,
        employeeCount: payrollBatch.employeeCount,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    // Granular RBAC (9bc442bc): payroll.rollback (configurable per company/tenant). Defaults to
    // hr_admin/super_admin — a payroll_partner is refused exactly as before — but now an operator can
    // re-map it. RLS still scopes WHICH batches resolve (a cross-company batch reads as "batch not found").
    await assertPayrollPermission(tx, ctx, 'payroll.rollback', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotResettableError();

    // ── 1. Unwind the loan-ledger advance (mirror-image of applyLoansForBatch, ADR-0060) ──
    const appliedReps = await tx
      .select()
      .from(loanRepayment)
      .where(and(eq(loanRepayment.appliedBatchId, p.batchId), eq(loanRepayment.status, 'applied')));
    let loansReopened = 0;
    for (const rep of appliedReps) {
      const [loan] = await tx.select().from(employeeLoan).where(eq(employeeLoan.id, rep.loanId)).limit(1);
      if (!loan) continue;
      const appliedCents = toC(rep.appliedAmount);
      const dueCents = toC(rep.dueAmount);

      // Apply-time shortfall: when the net≥0 clamp funded less than the reserved due, apply inserted a
      // 'scheduled' remainder row. Remove it and restore the full due on the reservation; if it can no
      // longer be found (amended / re-reserved by a later cycle since processing), fall back to
      // restoring only the actually-recovered amount so the schedule still sums to outstanding exactly.
      let restoredDue = rep.dueAmount;
      if (appliedCents < dueCents) {
        const shortfall = fromC(dueCents - appliedCents);
        const [sfRow] = await tx
          .select({ id: loanRepayment.id })
          .from(loanRepayment)
          .where(
            and(
              eq(loanRepayment.loanId, rep.loanId),
              eq(loanRepayment.status, 'scheduled'),
              eq(loanRepayment.dueAmount, shortfall),
            ),
          )
          .orderBy(desc(loanRepayment.sequenceNo))
          .limit(1);
        if (sfRow) {
          await tx.delete(loanRepayment).where(eq(loanRepayment.id, sfRow.id));
        } else {
          restoredDue = fromC(appliedCents);
        }
      }

      // Back to the exact pre-generation state: RESERVED on this batch (reserved_batch_id was never
      // cleared by apply), applied fields zeroed. If another batch reserved a row for this loan since
      // processing, the one-reserved-per-loan partial unique forbids a second reservation — release to
      // 'scheduled' instead (the next prefill converges).
      const [otherReserved] = await tx
        .select({ id: loanRepayment.id })
        .from(loanRepayment)
        .where(and(eq(loanRepayment.loanId, rep.loanId), eq(loanRepayment.status, 'reserved')))
        .limit(1);
      await tx
        .update(loanRepayment)
        .set({
          ...(otherReserved ? { status: 'scheduled', reservedBatchId: null } : { status: 'reserved' }),
          dueAmount: restoredDue,
          appliedBatchId: null,
          appliedAmount: '0',
          appliedAt: null,
        })
        .where(eq(loanRepayment.id, rep.id));

      // Restore the single authoritative ledger; reopen a loan this apply auto-settled. (A loan
      // manually settled AFTER processing also reopens here — the event trail tells that story.)
      const reopen = loan.status === 'settled' && appliedCents > 0;
      await tx
        .update(employeeLoan)
        .set({
          outstandingBalance: fromC(toC(loan.outstandingBalance) + appliedCents),
          instalmentsPaid: Math.max(0, loan.instalmentsPaid - (appliedCents > 0 ? 1 : 0)),
          ...(reopen ? { status: 'active' as const } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(employeeLoan.id, loan.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'loan-repayment',
        aggregateId: rep.id,
        eventType: 'loan.instalment.reversed',
        actor: actorOf(ctx),
        subjectEmploymentId: rep.employmentId,
        payload: { batchId: p.batchId, loanId: rep.loanId, reason: 'payroll-reset' },
      });
      if (reopen) {
        loansReopened += 1;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employee-loan',
          aggregateId: loan.id,
          eventType: 'loan.reopened',
          actor: actorOf(ctx),
          subjectEmploymentId: loan.employmentId,
          payload: { batchId: p.batchId, reason: 'payroll-reset' },
        });
      }
    }

    // ── 2. Un-mark the claims THIS batch paid (mirror-image of the generate-time paid block) ──
    // They go back to 'approved' but STAY stamped on the batch, exactly the pre-generation queued
    // state, so the corrected re-run re-picks them. (Claims the generation UNLINKED — out-of-scope
    // employments — already have payroll_batch_id null and need no reversal.)
    const revertedClaims = await tx
      .update(claimRequest)
      .set({ status: 'approved', paidAt: null, payoutRef: null })
      .where(and(eq(claimRequest.payrollBatchId, p.batchId), eq(claimRequest.status, 'paid')))
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
    for (const c of revertedClaims) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.payment-reversed',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { batchId: p.batchId, reason: 'payroll-reset' },
      });
    }

    // ── 3. Clear the calculation results; 4. back to draft ──
    // (Per-payslip history lives on the earlier processed-batch events; the batch-level reset event
    // below records the count — same convention as teardownDraftChildren's child deletes.)
    const clearedSlips = await tx.delete(payslip).where(eq(payslip.batchId, p.batchId)).returning({ id: payslip.id });
    await tx
      .update(payrollBatch)
      .set({ status: 'draft', totals: null, employeeCount: 0 })
      .where(eq(payrollBatch.id, p.batchId));

    // Audit visibility (not a gate): statutory-report artefacts already recorded for this
    // company+month — the resetting admin's cue that agency files may need regenerating.
    const statReports = await tx
      .select({ id: statutoryReport.id })
      .from(statutoryReport)
      .where(and(eq(statutoryReport.companyId, batch.companyId), eq(statutoryReport.periodKey, batch.payPeriod)));

    // Dedicated status-history row (reporter expected_function: payroll_status_history captures actor,
    // timestamp, reason, and before/after snapshot for every rollback / unlock / reprocess). Mirrors the
    // unlock/reprocess inserts so the rollback path is uniformly queryable, not only via the domain event.
    const resetActor = actorOf(ctx);
    await tx.insert(payrollStatusHistory).values({
      tenantId: ctx.tenantId,
      batchId: p.batchId,
      action: 'rollback',
      fromStatus: 'processed',
      toStatus: 'draft',
      actorType: resetActor.type,
      actorId: resetActor.id ?? null,
      reason,
      before: { status: 'processed', totals: batch.totals, employeeCount: batch.employeeCount },
      after: {
        status: 'draft',
        totals: null,
        employeeCount: 0,
        payslipsCleared: clearedSlips.length,
        loanInstalmentsReversed: appliedReps.length,
        loansReopened,
        claimsReverted: revertedClaims.length,
      },
    });

    // ONE batch-level reset event summarising every reversal (reporter req. #5: who / when /
    // period / company / optional reason — actor + occurredAt + this payload).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.reset',
      actor: resetActor,
      payload: {
        fromStatus: 'processed',
        toStatus: 'draft',
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        payPeriodId: batch.payPeriodId,
        runType: batch.runType,
        runSeq: batch.runSeq,
        reason,
        payslipsCleared: clearedSlips.length,
        loanInstalmentsReversed: appliedReps.length,
        loansReopened,
        claimsReverted: revertedClaims.length,
        statutoryReportsForPeriod: statReports.length,
      },
    });
    return {
      payslipsCleared: clearedSlips.length,
      loanInstalmentsReversed: appliedReps.length,
      claimsReverted: revertedClaims.length,
    };
  });
}

// ─────────────── Granular payroll RBAC (feedback 9bc442bc, reporter expected_function) ───────────────
export class PayrollPermissionDeniedError extends Error {
  constructor(public key: string) {
    super(`You do not have the '${key}' payroll permission.`);
    this.name = 'PayrollPermissionDeniedError';
  }
}
/** Unlock target is not a closed run (nothing to unlock). */
export class BatchNotUnlockableError extends Error {
  constructor() {
    super('Only a closed payroll process can be unlocked');
    this.name = 'BatchNotUnlockableError';
  }
}
/**
 * Close target is not a processed run (feedback ef31d251). Named, rather than the bare Error it replaced,
 * for the same two reasons BatchNotUnlockableError is named: closeAction can map the refusal to translated
 * copy instead of pushing a raw English core string into the URL, and a test can assert the constraint
 * NAME rather than a message string that would also match the wrong throw. Message text is unchanged from
 * the bare Error so anything that logs it reads identically.
 */
export class BatchNotCloseableError extends Error {
  constructor() {
    super('Only a processed batch can be closed');
    this.name = 'BatchNotCloseableError';
  }
}
/**
 * A blank / whitespace-only reason was supplied to unlockClosedBatch (feedback 2108c01f). Reopening a
 * finalised run is a sensitive, audited action — the reason is MANDATORY so the history log always
 * explains WHY a closed run was reopened. Thrown BEFORE the status flip so nothing is mutated.
 */
export class UnlockReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to unlock a closed payroll process.');
    this.name = 'UnlockReasonRequiredError';
  }
}

const callerRolesOf = (ctx: SessionContext): string[] => [
  ...(ctx.roles ?? []),
  ...(ctx.grants ?? []).map((g) => g.role),
];

/**
 * Resolve a granular payroll permission for the caller (reporter req.: payroll.rollback / unlock /
 * reprocess.selective / close, configurable per company/tenant). Company-scoped override rows win over
 * tenant-wide rows, which win over the code defaults (lib/payroll-permissions.ts). Read within the
 * caller's tx (the grant table is tenant-readable under RLS).
 */
export async function resolvePayrollPermission(
  tx: Tx,
  ctx: SessionContext,
  key: PayrollPermissionKey,
  companyId?: string | null,
): Promise<boolean> {
  const rows = await tx
    .select({ role: payrollPermissionGrant.role, allowed: payrollPermissionGrant.allowed, companyId: payrollPermissionGrant.companyId })
    .from(payrollPermissionGrant)
    .where(
      and(
        eq(payrollPermissionGrant.tenantId, ctx.tenantId),
        eq(payrollPermissionGrant.permissionKey, key),
        companyId
          ? or(isNull(payrollPermissionGrant.companyId), eq(payrollPermissionGrant.companyId, companyId))
          : isNull(payrollPermissionGrant.companyId),
      ),
    );
  return decidePayrollPermission({
    key,
    callerRoles: callerRolesOf(ctx),
    overrides: rows.map((r) => ({ role: r.role, allowed: r.allowed, companyScoped: r.companyId != null })),
  });
}

async function assertPayrollPermission(tx: Tx, ctx: SessionContext, key: PayrollPermissionKey, companyId?: string | null) {
  if (!(await resolvePayrollPermission(tx, ctx, key, companyId))) throw new PayrollPermissionDeniedError(key);
}

// Note (feedback 62e85140): the step-up (OTP) confirmation-code flow that used to gate Unlock has been
// removed — the UI now uses a single confirm dialog instead. The `payroll_step_up_challenge` table
// (db/schema.ts, migration 0173) is intentionally LEFT IN PLACE (no destructive migration) and is now
// UNUSED by the unlock path; deleteDraftBatch still cascades its rows on a draft teardown.

/**
 * Unlock a CLOSED payroll run back to PROCESSED (feedback 9bc442bc, reporter ask #2; simplified in
 * 62e85140). This is the controlled, auditable reversal of the 0011 closed-immutability freeze:
 *   • gated on the granular payroll.unlock permission (hr_admin + super_admin by default, per-company configurable);
 *   • a mandatory reason is captured for the audit log (the on-screen step is a single confirm dialog);
 *   • WARNS when the run's payment summary was already exported and/or statutory returns were already
 *     recorded for the month (EPF/SOCSO/EIS/LHDN), so the operator knows an amended filing may be needed;
 *   • flips status via a transaction-local escape hatch the 0011 trigger honours ONLY for this batch id;
 *   • reopens the parent pay_period (it was cascaded closed) so a correction re-run is possible;
 *   • records a payroll_status_history row (before/after + reason + warnings) and appends domain events.
 * Gated behind PAYROLL_UNLOCK_ENABLED so an environment can keep Closed permanently frozen if it prefers
 * the same-month adjustment-run correction path instead.
 */
export async function unlockClosedBatch(ctx: SessionContext, p: { batchId: string; reason?: string }) {
  if (!settingEnabled(ctx, 'payroll.unlock_enabled')) {
    // See resetProcessedBatch — a risk switch being off is not "Payroll is not on your plan".
    throw new SettingNotEnabledError('payroll.unlock_enabled', 'Payroll unlock is not enabled.');
  }
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new UnlockReasonRequiredError();
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    await assertPayrollPermission(tx, ctx, 'payroll.unlock', batch.companyId);
    if (batch.status !== 'closed') throw new BatchNotUnlockableError();

    // Warning flags (reporter req.: warn if payment disbursed or statutory submission filed).
    const [{ n: paymentExports } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(domainEvent)
      .where(and(eq(domainEvent.aggregateId, p.batchId), eq(domainEvent.eventType, 'payroll-batch.payment-summary.exported')));
    const statReports = await tx
      .select({ id: statutoryReport.id })
      .from(statutoryReport)
      .where(and(eq(statutoryReport.companyId, batch.companyId), eq(statutoryReport.periodKey, batch.payPeriod)));
    const warnings = {
      paymentDisbursed: Number(paymentExports) > 0,
      statutoryFiled: statReports.length > 0,
      statutoryReportCount: statReports.length,
    };

    // Flip status via the 0011 escape hatch (transaction-local; cleared at COMMIT — see migration 0163).
    await tx.execute(sql`select set_config('app.unlock_batch', ${p.batchId}, true)`);
    await tx.update(payrollBatch).set({ status: 'processed' }).where(eq(payrollBatch.id, p.batchId));

    // Reopen the parent pay_period (closeBatch cascaded it closed once all runs closed).
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    const reopenedPeriod = period?.status === 'closed';
    if (reopenedPeriod) {
      // Reopening a closed period is blocked by the guard_closed_pay_period trigger (migration 0067) unless we
      // signal a controlled unlock via the app.unlock_pay_period escape hatch (migration 0202) — same pattern as
      // the batch guard's app.unlock_batch above. Transaction-local; cleared at COMMIT.
      await tx.execute(sql`select set_config('app.unlock_pay_period', ${batch.payPeriodId}, true)`);
      await tx.update(payPeriod).set({ status: 'open' }).where(eq(payPeriod.id, batch.payPeriodId));
    }

    const actor = actorOf(ctx);
    await tx.insert(payrollStatusHistory).values({
      tenantId: ctx.tenantId,
      batchId: p.batchId,
      action: 'unlock',
      fromStatus: 'closed',
      toStatus: 'processed',
      actorType: actor.type,
      actorId: actor.id ?? null,
      reason,
      before: { status: 'closed', periodReopened: reopenedPeriod },
      after: { status: 'processed', warnings },
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.unlocked',
      actor,
      payload: { companyId: batch.companyId, payPeriod: batch.payPeriod, reason, warnings, reopenedPeriod },
    });
    if (reopenedPeriod) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: batch.payPeriodId,
        eventType: 'pay-period.reopened',
        actor,
        payload: { batchId: p.batchId, reason },
      });
    }
    return { warnings, reopenedPeriod };
  });
}

/**
 * Selective per-employee reprocessing (feedback 9bc442bc, reporter ask #3 + #8) — QUEUE-BASED.
 *
 * The public entry: validate + permission-check + enqueue an idempotent job, then run it. Enqueue creates
 * ONE `payroll_reprocess_job` row keyed by an idempotency key (a double-clicked/retried submit reuses the
 * same job instead of spawning a duplicate run — the reporter's double-submit guard), whose status the UI
 * polls (getReprocessJob + the /api/payroll/reprocess-job route). Running the job performs a TRUE in-place
 * recompute of exactly the selected employees via generatePayslips' reprocessSubset path: their payslips
 * are recomputed + version-bumped (OCC), everyone else's stay physically untouched, and batch totals/GL
 * are updated BY DELTA — the reporter's ask #8, not a scope substitution.
 */
export async function reprocessSelectedEmployees(
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[]; reason?: string; idempotencyKey?: string },
) {
  if (!isModuleEnabled(ctx, 'multi_cycle_payroll')) {
    throw new ModuleNotEnabledError('multi_cycle_payroll', 'Multiple payroll runs per month are not enabled.');
  }
  const requested = [...new Set(p.employmentIds.filter(Boolean))].sort();
  if (requested.length === 0) throw new Error('Select at least one employee to reprocess.');

  // Phase 1 — validate + permission + enqueue (idempotent). Its own tx so the job row commits before the
  // recompute runs (so a poll can observe 'running', and a crash mid-recompute leaves a re-runnable job).
  const enq = await withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId, payPeriodId: payrollBatch.payPeriodId, employeeCount: payrollBatch.employeeCount })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    await assertPayrollPermission(tx, ctx, 'payroll.reprocess.selective', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotResettableError();
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    if (period?.status === 'closed') throw new Error('This pay period is closed.');

    // Cross-company membership intersection (a stale/cross-company id can never widen the run).
    const companyEmps = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(and(eq(employment.companyId, batch.companyId), inArray(employment.id, requested)));
    const employmentIds = requested.filter((id) => companyEmps.some((e) => e.id === id));
    if (employmentIds.length === 0) throw new Error('None of the selected employees belong to this run.');

    // Idempotency: default key binds batch + exact selection + reason so an identical resubmit dedupes,
    // while a genuinely different request (different pick) enqueues its own job.
    const idempotencyKey =
      p.idempotencyKey?.trim() ||
      createHash('sha256').update(`${p.batchId}:${employmentIds.join(',')}:${p.reason ?? ''}`).digest('hex');

    // ON CONFLICT DO NOTHING → a duplicate submit reuses the existing job row.
    await tx
      .insert(payrollReprocessJob)
      .values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        idempotencyKey,
        status: 'queued',
        employmentIds,
        reason: p.reason ?? null,
        requestedBy: ctx.userId ?? null,
      })
      .onConflictDoNothing({ target: [payrollReprocessJob.tenantId, payrollReprocessJob.idempotencyKey] });
    const [job] = await tx
      .select()
      .from(payrollReprocessJob)
      .where(and(eq(payrollReprocessJob.tenantId, ctx.tenantId), eq(payrollReprocessJob.idempotencyKey, idempotencyKey)))
      .limit(1);
    return { job, employmentIds };
  });

  const job = enq.job;
  // Idempotent replay: a completed job returns its stored result without re-running (double-submit safety).
  if (job.status === 'completed') {
    return { jobId: job.id, status: 'completed' as const, ...(job.result as Record<string, unknown> | null) };
  }
  if (job.status === 'running') {
    return { jobId: job.id, status: 'running' as const };
  }

  // Phase 2 — atomically CLAIM the job (queued→running) so a concurrent duplicate request can never
  // run the recompute twice; if the claim updates no row, another worker already took it → don't re-run.
  const claimed = await withTenant(ctx, (tx) =>
    tx
      .update(payrollReprocessJob)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(payrollReprocessJob.id, job.id), eq(payrollReprocessJob.status, 'queued')))
      .returning({ id: payrollReprocessJob.id }),
  );
  if (claimed.length === 0) {
    return { jobId: job.id, status: 'running' as const };
  }
  try {
    const result = await generatePayslips(ctx, {
      batchId: p.batchId,
      reprocessSubset: { employmentIds: enq.employmentIds, reason: p.reason, actorId: ctx.userId },
    });
    await withTenant(ctx, (tx) =>
      tx
        .update(payrollReprocessJob)
        .set({ status: 'completed', result: result as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(payrollReprocessJob.id, job.id)),
    );
    return { jobId: job.id, status: 'completed' as const, ...result };
  } catch (e) {
    await withTenant(ctx, (tx) =>
      tx
        .update(payrollReprocessJob)
        .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
        .where(eq(payrollReprocessJob.id, job.id)),
    );
    throw e;
  }
}

/** Job-status read for the polling endpoint (reporter req.: a job-status endpoint for the UI). */
export async function getReprocessJob(ctx: SessionContext, jobId: string) {
  return withTenant(ctx, async (tx) => {
    const [job] = await tx
      .select({
        id: payrollReprocessJob.id,
        batchId: payrollReprocessJob.batchId,
        status: payrollReprocessJob.status,
        result: payrollReprocessJob.result,
        error: payrollReprocessJob.error,
        updatedAt: payrollReprocessJob.updatedAt,
      })
      .from(payrollReprocessJob)
      .where(eq(payrollReprocessJob.id, jobId))
      .limit(1);
    return job ?? null;
  });
}

// Read-only list (no events.append per the CLAUDE.md skip rule). `payPeriod` is an OPTIONAL
// additive filter: when a non-empty string is passed it is AND-ed onto the existing tenant-RLS +
// companyIds guard, so it can only NARROW the result (Build #10). Omitting it (or passing '')
// reproduces the prior behaviour byte-identically — the three existing callers pass ≤2 args.
//
// 7f6ca478 — it now also accepts a SET of periods. The Payroll Process dashboard shows a whole YEAR
// at once (twelve month cells, each carrying its own run count), so it asks for twelve periods in one
// round trip rather than filtering an unbounded "every batch this tenant ever ran" fetch in JS, which
// is what the single-period signature forced the old list to do. A string still means exactly one
// period; an EMPTY array means "no period can match" and is honoured as such (`inArray(…, [])` ⇒ no
// rows) rather than being quietly widened to "all" — a caller that computed an empty set wants an
// empty result, and silently returning everything is how a filter becomes a data leak.
export function listBatches(
  ctx: SessionContext,
  companyIds?: string[],
  payPeriod?: string | readonly string[],
) {
  const periodFilter = Array.isArray(payPeriod)
    ? inArray(payrollBatch.payPeriod, payPeriod as string[])
    : typeof payPeriod === 'string' && payPeriod
      ? eq(payrollBatch.payPeriod, payPeriod)
      : undefined;
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        // 7f6ca478 — the dashboard renders Net Pay through lib/money.formatMoney, which refuses to
        // guess a currency (an unlabelled figure over a claim). The list spans every company in scope,
        // which is exactly where one hard-coded "RM" mislabels somebody's payroll.
        currency: company.currency,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        employeeCount: payrollBatch.employeeCount,
        totals: payrollBatch.totals,
        batchDate: payrollBatch.batchDate,
        // Build #10 follow-up: `remarks` carries the wizard's real cycle selection for advance/midmonth
        // runs (both stored as runType='off_cycle'). Surfaced in the listing's "Payroll Cycle" column so
        // they display distinctly, matching the batch detail page. Read-only; no schema/migration change.
        remarks: payrollBatch.remarks,
        // ef31d251 — the payroll LIST has to say which months have actually reached employees, and it
        // cannot tell 'published' from 'scheduled' without the release instant (lib/payroll-publication.ts).
        // Purely additive: all three callers filter/map explicit fields, and the by-batches context test
        // compares two listBatches results to each other rather than to a literal row shape.
        closedAt: payrollBatch.closedAt,
        releasedAt: payrollBatch.releasedAt,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(
        and(
          companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined,
          periodFilter,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq),
  );
}

export type LeaverAdvisoryRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  terminatedOn: string;
  basic: number;
  annualBalance: number;
  /** Suggested pay-in-lieu for unused annual leave at ORP (basic / 26 per day, EA 1955). */
  suggested: number;
  /** ADR-0069: where annualBalance came from. 'frozen_snapshot' — a resignation-approval freeze exists,
   *  so annualBalance/suggested derive from the LOCKED (or HR-overridden) day-count, not the live ledger.
   *  'live_balance' — no snapshot (policy off, or the employment was terminated directly, bypassing the
   *  resignation flow) — annualBalance is the live ledger sum, exactly as before this feature. */
  encashmentSource: 'frozen_snapshot' | 'live_balance';
  frozenAsOf?: string;
  overridden?: boolean;
};

/**
 * Final-pay ADVISORY for employees terminating within a draft batch's period: unused annual
 * leave × ORP daily rate, per EA 1955 s.60E pay-in-lieu. Deliberately NO auto-pay — the
 * EPF/PCB treatment of encashment is not yet sourced, so the admin keys the amount into the
 * bonus input consciously (documented in STATUTORY-SOURCES.md). f3148da1 Step 5: the ORP day-divisor
 * used for the `suggested` figure is policy-configurable (`leave.encashmentDivisor`), defaulting to the
 * statutory 26-day divisor — see encashmentDivisorDays.
 */
export function leaverAdvisory(ctx: SessionContext, batchId: string): Promise<LeaverAdvisoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [y, m] = batch.payPeriod.split('-').map(Number);
    const start = `${batch.payPeriod}-01`;
    const end = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
    const leavers = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
      )
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(employment.terminatedOn, start),
          lte(employment.terminatedOn, end),
        ),
      );
    if (leavers.length === 0) return [];
    const [annual] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(eq(leaveType.code, 'ANNUAL'))
      .limit(1);
    const out: LeaverAdvisoryRow[] = [];
    for (const l of leavers) {
      let balance = 0;
      if (annual) {
        const [row] = await tx
          .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
          .from(leaveLedger)
          .where(and(eq(leaveLedger.employmentId, l.employmentId), eq(leaveLedger.leaveTypeId, annual.id)));
        balance = Number(row?.bal ?? 0);
      }
      // ADR-0069: a frozen encashment snapshot (resignation-approval freeze), when present, wins over the
      // live ledger balance — that is the point of the feature (a locked/HR-adjusted figure instead of a
      // number that can still drift). No snapshot (policy off, or a direct termination bypassing the
      // resignation flow) falls back to the live balance exactly as before this feature.
      const encashment = await encashableDaysForEmployment(tx, l.employmentId);
      const effectiveBalance = encashment ? encashment.days : balance;
      const basic = Number(l.basic);
      // f3148da1 Step 5 — the leave-encashment ORP day-divisor is policy-configurable (default = the statutory
      // 26-day ordinary-rate divisor, so `basic / 26` is byte-identical when no policy overrides it). Resolve
      // the employment's assigned policy (and, only for a `working_days` divisor, count the pay-month working
      // days) LAZILY — a zero balance keeps the legacy 0 with no extra query.
      let encDivisor = ENCASHMENT_ORP_DIVISOR;
      if (effectiveBalance > 0) {
        const encCfg = (await resolveAssignedPolicy(tx, l.employmentId))?.config ?? null;
        let workingDays = 0;
        if (encCfg?.leave?.encashmentDivisor === 'working_days') {
          const holidays = await holidayDatesFor(tx, { employmentId: l.employmentId, startDate: start, endDate: end });
          for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
            const d = new Date(t).toISOString().slice(0, 10);
            const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
            if (iso <= 5 && !holidays.has(d)) workingDays++; // Mon–Fri working-day basis, less holidays
          }
        }
        encDivisor = encashmentDivisorDays(encCfg, { workingDays });
      }
      out.push({
        employmentId: l.employmentId,
        name: l.name,
        employeeCode: l.employeeCode,
        terminatedOn: l.terminatedOn!,
        basic,
        annualBalance: effectiveBalance,
        suggested: effectiveBalance > 0 ? round2((basic / encDivisor) * effectiveBalance) : 0,
        encashmentSource: encashment ? 'frozen_snapshot' : 'live_balance',
        ...(encashment ? { frozenAsOf: encashment.calculatedAsOf, overridden: encashment.overridden } : {}),
      });
    }
    return out;
  });
}

// ── Pre-processing checks (feedback f1564110, Phase 1; feedback 64fb5e48) ─────────────────────────
// Validates employee master data BEFORE the run is calculated, per the reporter's proposed workflow
// ("maintain employee info → validate → process as the final step"). All salary checks read the
// Personnel Basic Salary record (compensation) — the authoritative source; the internal BASIC pay
// item is NEVER a processing prerequisite (feedback 64fb5e48). Classes:
//   • missingCompensation — BLOCKER. No open compensation row (the generation employee query
//     inner-joins compensation, so these employees were previously dropped from the run with no
//     warning at all), or no salary record covering the pay period. Generation fails closed
//     (PreProcessBlockedError) until fixed.
//   • zeroBasic — BLOCKER. The record would pay nothing: zero basic (monthly/custom) or zero/missing
//     rate (daily/hourly).
//   • staleBasicComponent — WARNING. A leftover BASIC pay item disagrees with the Personnel basic;
//     pay follows Personnel, the item should be cleaned up.
//   • missingStatutory — WARNING. No employee_statutory_my row: EPF/SOCSO/PCB fall back to defaults.
//     The operator must explicitly confirm to proceed (enforced in generateAction).
//   • missingBank — WARNING. Statutory profile exists but bank name/account is incomplete: the
//     payment file cannot carry this employee. Confirm-to-proceed like missingStatutory.
//   • currencyMismatch — WARNING (297ae65a). The employee's salary record carries a currency other
//     than MYR while this run computes under the MY pack (Malaysian statutory maths, MYR figures) —
//     a mixed-currency batch or a wholly non-MYR one. Currency CONVERSION is explicitly a future
//     enhancement, so the run warns instead of calculating something misleading; no math change.
//   • hrdfSubjectUnregistered — WARNING (r79). The employee carries an EXPLICIT "Subject to HRDF = Yes"
//     while their company has no HRD Corp registration band, so hrdfLevy rates them to 0 (correctly —
//     an unregistered employer owes nothing). Before this check the contradiction was visible only on
//     the employee's own Bank & Statutory screen: the run itself said nothing, and one company processed
//     eight payrolls in that state. WARNS rather than blocks — the stored flag is legitimate forward
//     setup (see 57840a6e/efece4ce), the employees still need paying, and the operator often cannot
//     complete the company's HRD Corp registration in the moment. It joins the confirm-to-proceed
//     warnings, so generation requires an explicit acknowledgement rather than passing silently.

export type PreProcessCheckRow = { employmentId: string; name: string; employeeCode: string | null };

export type PreProcessAdvisory = {
  missingCompensation: PreProcessCheckRow[];
  // BLOCKER (ADR-0078 / 642ecc55). The employee's open compensation row carries pay_mode='custom_period',
  // which has NO calculation behind it — letting the run proceed would quietly pay the monthly-equivalent
  // basic for a structure the admin explicitly marked as NOT monthly. Named per employee, blocked at
  // pre-flight (generatePayslips re-asserts fail-closed) rather than thrown inside the engine: the batch
  // is all-or-nothing, so an engine throw would take down the whole company's run. OPTIONAL so pre-0290
  // literals stay valid; absent ⇒ no such employees.
  unpayablePayMode?: PreProcessCheckRow[];
  // BLOCKER (feedback 64fb5e48, replaces the R37 62e370b0 missingBasicComponent check). The employee's
  // authoritative Personnel Basic Salary record (the OPEN compensation row) would pay nothing: monthly /
  // custom modes with basic_salary <= 0, or daily/hourly modes without a positive rate_amount.
  // assertRateForMode (core/comp.ts) only guards NEW writes, so this also catches legacy rows. OPTIONAL so
  // pre-existing advisory literals stay valid; absent ⇒ no such employees.
  zeroBasic?: PreProcessCheckRow[];
  // WARNING (feedback 64fb5e48) — typed path only: a period-active BASIC employment_pay_component exists
  // whose amount disagrees with the Personnel Basic Salary (compensation.basic_salary). The engine now
  // ALWAYS pays basic from the Personnel record (the component never supplies the amount), so this is
  // stale data flagged for cleanup — it never blocks processing. OPTIONAL like unpayablePayMode.
  staleBasicComponent?: PreProcessCheckRow[];
  missingStatutory: PreProcessCheckRow[];
  missingBank: PreProcessCheckRow[];
  // WARNING (297ae65a — Currency on Basic Salary). The employee's OPEN compensation row is denominated in
  // a currency other than MYR while payroll computes under the MY pack: the amount is processed AS ENTERED
  // (recording/reporting first; conversion is a future enhancement), so the operator must explicitly
  // confirm a mixed-currency / non-MYR run instead of it calculating something misleading silently.
  // OPTIONAL so pre-existing advisory literals stay valid; absent ⇒ no such employees.
  currencyMismatch?: PreProcessCheckRow[];
  // WARNING (r79). An explicit per-employee "Subject to HRDF = Yes" at a company with no HRD Corp
  // registration band: the tick is honoured by hrdfSubject() but hrdfLevy() rates `not_registered` to 0,
  // so the run records the employee as subject and charges nothing. Never blocks (see the class notes
  // above) — it is a confirm-to-proceed warning so the contradiction is stated at the moment it has an
  // effect. OPTIONAL so pre-existing advisory literals stay valid; absent ⇒ no such employees.
  hrdfSubjectUnregistered?: PreProcessCheckRow[];
};

/** Shared tx-level core: the same scoped, period-active population as generatePayslips' employee
 *  query (hired ≤ period end, not terminated before period start, batch scope applied) but with
 *  compensation/statutory LEFT-joined so the gaps are visible instead of silently dropped. */
async function preProcessChecksTx(
  tx: Tx,
  batch: { companyId: string; payPeriod: string; scope: unknown },
  /**
   * Whether the tenant has the typed-pay-components module (ADR-0077 slice 3).
   *
   * Passed as a BOOLEAN rather than threading a SessionContext into a Tx-level helper: this function
   * is deliberately session-free — it takes a `tx` and plain data — and pulling an entitlement context
   * into it would invert that layering for one predicate. Every caller has a ctx in scope and computes
   * it there.
   */
  typedComponents: boolean,
): Promise<PreProcessAdvisory> {
  const [y, m] = batch.payPeriod.split('-').map(Number);
  const periodStart = `${batch.payPeriod}-01`;
  const periodEnd = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
  const { filter: scopeFilter } = await resolveBatchScopeFilter(tx, (batch.scope ?? null) as BatchScope | null);
  const rows = await tx
    .select({
      employmentId: employment.id,
      name: person.fullName,
      employeeCode: employment.employeeCode,
      compId: compensation.id,
      compPayMode: compensation.payMode,
      // Feedback 64fb5e48 — the fields the strengthened checks read off the Personnel record: effective
      // date (period coverage), basic amount (zeroBasic + stale comparison) and daily/hourly rate.
      compValidFrom: compensation.validFrom,
      compBasic: compensation.basicSalary,
      compRate: compensation.rateAmount,
      // 297ae65a — the record's salary currency, for the non-MYR / mixed-currency warning below.
      compCurrency: compensation.currency,
      statPersonId: employeeStatutoryMy.personId,
      bankName: employeeStatutoryMy.bankName,
      bankAccountNo: employeeStatutoryMy.bankAccountNo,
      // r79 — the tri-state per-employee HRDF flag. Only an EXPLICIT true can contradict an unregistered
      // employer; null (follow the company default) resolves to "not subject" and is no contradiction at all.
      subjectToHrdf: employeeStatutoryMy.subjectToHrdf,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .leftJoin(
      compensation,
      and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
    )
    .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(
      and(
        eq(employment.companyId, batch.companyId),
        lte(employment.hiredOn, periodEnd),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        scopeFilter,
      ),
    )
    .orderBy(person.fullName);
  // Feedback 64fb5e48 — effective-date coverage. The engine reads the OPEN compensation row; when that row
  // only takes effect AFTER the period end, the period itself may still be covered by the (closed, non-
  // superseded) predecessor the revision truncated — a future-dated increment is not a data gap. Only
  // employments whose open row starts after the period need this history lookup, so the common case (open
  // row already in effect) issues NO extra query.
  const futureOnlyIds = rows.filter((r) => r.compId && r.compValidFrom! > periodEnd).map((r) => r.employmentId);
  const coveredEmpIds = new Set<string>();
  if (futureOnlyIds.length > 0) {
    const covRows = await tx
      .selectDistinct({ employmentId: compensation.employmentId })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, futureOnlyIds),
          isNull(compensation.supersededAt),
          lte(compensation.validFrom, periodEnd),
          or(isNull(compensation.validTo), gte(compensation.validTo, periodStart)),
        ),
      );
    for (const c of covRows) coveredEmpIds.add(c.employmentId);
  }
  // Feedback 64fb5e48 (supersedes the R37 62e370b0 missingBasicComponent blocker) — typed path only: the
  // period-active BASIC employment_pay_component AMOUNTS per in-scope employee. The engine now always pays
  // basic from the Personnel compensation record, so a MISSING BASIC component is no gap at all; a PRESENT
  // one whose amount disagrees with the Personnel basic is stale data, surfaced below as the
  // staleBasicComponent WARNING (pay follows Personnel either way). Gated: with the flag off the legacy
  // path never reads components, so the query is skipped entirely.
  const basicAmountsByEmp = new Map<string, number[]>();
  if (typedComponents && rows.length > 0) {
    const basicRows = await tx
      .select({ employmentId: employmentPayComponent.employmentId, amount: employmentPayComponent.amount })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          inArray(employmentPayComponent.employmentId, rows.map((r) => r.employmentId)),
          eq(payComponent.code, 'BASIC'),
          // Same period-active window as the earnings query (lte valid_from / valid_to open-or-future /
          // not superseded) so the check agrees exactly with what the kernel would read.
          lte(employmentPayComponent.validFrom, periodEnd),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
          isNull(employmentPayComponent.supersededAt),
        ),
      );
    for (const bRow of basicRows) {
      const list = basicAmountsByEmp.get(bRow.employmentId) ?? [];
      list.push(Number(bRow.amount));
      basicAmountsByEmp.set(bRow.employmentId, list);
    }
  }
  // r79 — the employer's HRD Corp registration band, read ONLY when at least one in-scope employee carries
  // an explicit "Subject to HRDF = Yes" (so the overwhelmingly common case issues no extra query, and a
  // company that has genuinely registered simply produces no rows below). Mirrors generatePayslips' own
  // default exactly (`companyStatutoryMy` absent ⇒ not_registered), so what this check reports is what the
  // run will actually do — six of eight live companies have no row at all.
  const anyExplicitHrdfYes = rows.some((r) => r.subjectToHrdf === true);
  let hrdfUnregistered = false;
  if (anyExplicitHrdfYes) {
    const [coStat] = await tx
      .select({ hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, batch.companyId))
      .limit(1);
    hrdfUnregistered = (coStat?.hrdfStatus ?? 'not_registered') === 'not_registered';
  }
  const out: PreProcessAdvisory = { missingCompensation: [], unpayablePayMode: [], zeroBasic: [], staleBasicComponent: [], missingStatutory: [], missingBank: [], currencyMismatch: [], hrdfSubjectUnregistered: [] };
  for (const r of rows) {
    const row: PreProcessCheckRow = { employmentId: r.employmentId, name: r.name, employeeCode: r.employeeCode };
    // Feedback 64fb5e48 — the OPEN row must exist (the generation employee query inner-joins it, so a
    // missing one silently drops the employee) AND the pay period must actually be covered by a salary
    // record: an open row already in effect covers it, else a period-overlapping predecessor must exist.
    if (!r.compId || (r.compValidFrom! > periodEnd && !coveredEmpIds.has(r.employmentId))) out.missingCompensation.push(row);
    // ADR-0078 — pay_mode='custom_period' has no calculation: BLOCKER, named per employee. Checked before
    // the zero-amount gap so one row lands in exactly one blocker list (the mode gap subsumes it —
    // there is nothing to compute regardless of amounts).
    else if (r.compPayMode === 'custom_period') out.unpayablePayMode!.push(row);
    // Feedback 64fb5e48 — zeroBasic: the Personnel record would pay nothing. Daily/hourly modes pay
    // rate × time so the RATE must be positive (basic_salary keeps its monthly-equivalent role for
    // statutory reads); every other mode requires basic_salary > 0. assertRateForMode only guards new
    // writes — this covers legacy rows too.
    else if (
      r.compPayMode === 'daily' || r.compPayMode === 'hourly'
        ? !(Number(r.compRate ?? 0) > 0)
        : !(Number(r.compBasic ?? 0) > 0)
    ) out.zeroBasic!.push(row);
    // Feedback 64fb5e48 — WARNING (never blocks): a period-active BASIC component whose amount disagrees
    // with the authoritative Personnel basic. The engine pays the Personnel record regardless; this only
    // flags the stale row for cleanup. Independent of the statutory warnings below (a row can carry both).
    if (r.compId && (basicAmountsByEmp.get(r.employmentId) ?? []).some((amt) => round2(amt) !== round2(Number(r.compBasic)))) {
      out.staleBasicComponent!.push(row);
    }
    // 297ae65a — WARNING (never blocks): the salary record is denominated in a currency other than MYR
    // while this run computes under the MY pack (the only pack today). Covers both a MIXED batch (some
    // non-MYR) and a wholly non-MYR one; the amount is processed as entered — recording/reporting first,
    // conversion is an explicit future enhancement — so the operator confirms rather than the engine
    // silently computing Malaysian statutory maths over a foreign-currency figure.
    if (r.compId && (r.compCurrency ?? 'MYR') !== 'MYR') out.currencyMismatch!.push(row);
    // r79 — WARNING (never blocks): an explicit "Subject to HRDF = Yes" that the employer's registration
    // makes structurally uncollectable. Independent of every check above (a row can carry both) and NOT
    // gated on a compensation row: the contradiction is in the statutory setup, not in the salary record.
    if (hrdfUnregistered && r.subjectToHrdf === true) out.hrdfSubjectUnregistered!.push(row);
    if (!r.statPersonId) out.missingStatutory.push(row);
    // Bank readiness is only meaningful once a statutory profile exists (a missing profile already
    // covers the row above — listing it twice would be noise, not signal).
    else if (!r.bankName?.trim() || !r.bankAccountNo?.trim()) out.missingBank.push(row);
  }
  return out;
}

/** Read-only pre-processing advisory for a batch (no events.append per the CLAUDE.md skip rule —
 *  derived read, nothing written). Rendered as the "Pre-processing checks" card on a draft run and
 *  re-asserted server-side in generateAction/generatePayslips before calculation. */
export function preProcessAdvisory(ctx: SessionContext, batchId: string): Promise<PreProcessAdvisory> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, scope: payrollBatch.scope })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return { missingCompensation: [], missingStatutory: [], missingBank: [] };
    return preProcessChecksTx(tx, batch, isModuleEnabled(ctx, 'typed_pay_components'));
  });
}

/** Read-only pre-processing advisory for a PROSPECTIVE run that has no batch yet (R37 70764928 — the
 *  Payroll Process wizard's Validation step, which runs BEFORE the batch is created). Reuses the exact
 *  same `preProcessChecksTx` core as the batch-scoped `preProcessAdvisory` above (no duplicate check
 *  logic), evaluating the same period/scope population the terminal Process action will run over. Multi-
 *  company runs are checked per company and merged. `employmentIds` mirrors the wizard's touched-selection
 *  scope: present ⇒ only those employees; absent/empty ⇒ the whole-company default. No events.append per
 *  the CLAUDE.md skip rule — derived read, nothing written. */
export function preProcessAdvisoryForSelection(
  ctx: SessionContext,
  input: { companyIds: string[]; payPeriod: string; employmentIds?: string[] },
): Promise<PreProcessAdvisory> {
  return withTenant(ctx, async (tx) => {
    const scope: BatchScope | null =
      input.employmentIds && input.employmentIds.length ? { employmentIds: input.employmentIds } : null;
    const merged: PreProcessAdvisory = {
      missingCompensation: [],
      unpayablePayMode: [],
      zeroBasic: [],
      staleBasicComponent: [],
      missingStatutory: [],
      missingBank: [],
      // r79 — the wizard renders exactly the same groups as the batch card, so every optional list the
      // per-company core produces must be initialised AND merged here. `currencyMismatch` was declared on
      // the type and rendered by the wizard but never merged, so the non-MYR warning could not reach the
      // Validation step at all; merging it restores the parity this function's contract claims.
      currencyMismatch: [],
      hrdfSubjectUnregistered: [],
    };
    for (const companyId of input.companyIds) {
      const a = await preProcessChecksTx(tx, { companyId, payPeriod: input.payPeriod, scope }, isModuleEnabled(ctx, 'typed_pay_components'));
      merged.missingCompensation.push(...a.missingCompensation);
      merged.unpayablePayMode!.push(...(a.unpayablePayMode ?? []));
      merged.zeroBasic!.push(...(a.zeroBasic ?? []));
      merged.staleBasicComponent!.push(...(a.staleBasicComponent ?? []));
      merged.missingStatutory.push(...a.missingStatutory);
      merged.missingBank.push(...a.missingBank);
      merged.currencyMismatch!.push(...(a.currencyMismatch ?? []));
      merged.hrdfSubjectUnregistered!.push(...(a.hrdfSubjectUnregistered ?? []));
    }
    return merged;
  });
}

export function batchDetail(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, batchId)).limit(1);
    if (!batch) return null;
    const slips = await tx
      .select({
        id: payslip.id,
        employmentId: payslip.employmentId,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        basic: payslip.basicSalary,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
        // 97a9b0ab — the revision counter (1 = as first generated, >1 = selectively reprocessed).
        // It has always been stored and never shown, which is why a moved figure looked unexplainable.
        // The RULESET version rides `statutory.version` (already selected above) — no column, no DDL.
        version: payslip.version,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    return { batch, slips };
  });
}

export class PaymentSummaryNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentSummaryNotReadyError';
  }
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';

/**
 * Batch payment summary for manual bank upload. A plain, neutral CSV — employee, bank, account,
 * net pay — deliberately NOT a byte-exact bank giro / IBG file: every bank's bulk-payment format
 * differs and must be verified against that bank's own portal (tracked separately as Layer-B).
 * Available once the batch is processed/closed (payslips exist). Logs an export event on the
 * batch so this egress of bank + net-pay data is auditable.
 */
export function paymentSummaryForBatch(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        payPeriod: payrollBatch.payPeriod,
        company: company.legalName,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) throw new PaymentSummaryNotReadyError('Payroll batch not found.');
    if (batch.status === 'draft') {
      throw new PaymentSummaryNotReadyError(
        'Process the batch before exporting a payment summary — a draft has no payslips yet.',
      );
    }

    const rows = await tx
      .select({
        name: person.fullName,
        code: employment.employeeCode,
        ic: employeeStatutoryMy.icNumber,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        // Custom payment holder (item ef720d3a): where a banking restriction requires salary to be paid into a
        // third party's account, the payee NAME / ID resolve to the custom holder instead of the employee. The
        // bank + account number remain the statutory-row values (the receiving account is still that row).
        enableCustomHolderName: employeeStatutoryMy.enableCustomHolderName,
        customHolderName: employeeStatutoryMy.customHolderName,
        enableCustomHolderId: employeeStatutoryMy.enableCustomHolderId,
        customHolderId: employeeStatutoryMy.customHolderId,
        // R46 79eb7151 — HOW this employee is paid. The bank-upload file is only meaningful for the rows
        // that are actually paid BY bank transfer; cheque and cash rows have to be settled another way.
        // Emitting the method turns a flat list into something the payment run can be split on, instead of
        // whoever opens the CSV having to remember who is not on transfer.
        paymentMethod: employment.paymentMethod,
        net: payslip.netPay,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    if (rows.length === 0) throw new PaymentSummaryNotReadyError('This batch has no payslips to export.');

    // Resolve the payee identity per row: custom holder when its switch is on (+ has a value), else the
    // employee. This changes ONLY who is named as the account holder — never the bank, account, or amount.
    const payeeFor = (r: (typeof rows)[number]) => ({
      holderName: r.enableCustomHolderName && r.customHolderName?.trim() ? r.customHolderName : r.name,
      holderId: r.enableCustomHolderId && r.customHolderId?.trim() ? r.customHolderId : (r.ic ?? ''),
    });

    const header = [
      'No',
      'Employee',
      'Employee Code',
      'IC',
      'Payment Holder Name',
      'Payment Holder ID',
      'Bank',
      'Account No',
      'Net Pay (RM)',
      // R46 79eb7151 — appended strictly LAST so every pre-existing column keeps its INDEX (0..8 unchanged).
      // A row with no method set emits an empty cell, so the data in every existing column is byte-identical
      // to before. Note the one thing that does change: Net Pay is no longer the final cell, so a consumer
      // reading "the last column" rather than a fixed index or the header sees the method instead. That is
      // unavoidable when widening a CSV; last-position is still the least disruptive placement, and the
      // header row names every column for anything parsing by name.
      'Payment Method',
    ];
    const body = rows.map((r, i) => {
      const payee = payeeFor(r);
      return [
        i + 1,
        r.name,
        r.code ?? '',
        r.ic ?? '',
        payee.holderName,
        payee.holderId,
        r.bankName ?? '',
        r.bankAccountNo ?? '',
        Number(r.net).toFixed(2),
        r.paymentMethod ?? '',
      ];
    });
    const content = toCsv([header, ...body]);
    const netTotalCents = rows.reduce((sum, r) => sum + Math.round(Number(r.net) * 100), 0);
    const missingBank = rows.filter((r) => !r.bankName || !r.bankAccountNo).length;
    const filename = `payment-summary_${slugify(batch.company)}_${batch.payPeriod}.csv`;

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: batchId,
      eventType: 'payroll-batch.payment-summary.exported',
      actor: actorOf(ctx),
      payload: { payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod },
    });

    return { content, filename, payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod };
  });
}

/** A single payslip's full breakdown for the employee detail/print view. RLS scopes it to
 *  what the caller may see (the employee sees their own via can_see_employment). */
export function payslipDetail(ctx: SessionContext, payslipId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: payslip.id,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        company: company.legalName,
        companyReg: company.registrationNo,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        otherDeductions: payslip.otherDeductions,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
        // 97a9b0ab — revision counter for the payslip's own provenance footer (the ruleset version it
        // sits beside is already in `statutory`). Read-side only; both values predate this change.
        version: payslip.version,
        // Step 6 (f3148da1) — the release instant, materialized at close time (RLS-safe: readable by the
        // employee via their own payslip's batch, unlike the admin-only company_payroll_config).
        releasedAt: payrollBatch.releasedAt,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.id, payslipId))
      .limit(1);
    if (!row) return null;
    // Step 6 — hide a payslip whose batch is not yet closed OR whose release instant has not passed, so the ESS
    // detail page + PDF route (which both call this) return notFound/404 until release. Admin surfaces use
    // different reads (payroll-view.ts) and are unaffected. A closed batch with a NULL releasedAt is a legacy
    // batch (backfilled to created_at by migration 0164), treated as released.
    const released = row.status === 'closed' && (row.releasedAt == null || row.releasedAt.getTime() <= Date.now());
    if (!released) return null;
    const { releasedAt: _r, ...rest } = row;
    return rest;
  });
}

/**
 * Rows for the draft-batch input editor: each active-in-period employee with their current manual
 * overtime and the auto-derived unpaid-leave days (read-only preview of what generation will apply).
 */
export function batchInputRows(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, country: company.country })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;
    // Fix-5 (#4/#29): resolve the OT engine + statutory ruleset so we can surface each employee's
    // s.60I(1A) ORP (wages/26) + hourly (ORP/8) basis and the RM4,000 eligibility — READ-ONLY, computed
    // from the same overtimePay/compensation source the kernel uses. Pack may be absent (non-MY) ⇒ skip.
    const pack = packFor(batch.country);
    const otRules = pack ? (await pack.payroll.loadRuleset(tx, { asOf: periodEnd })).ot : undefined;
    const otCeiling = otRules?.wageCeiling;
    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      )
      .orderBy(person.fullName);
    const inputs = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        loanDeduction: payrollInput.loanDeduction,
        otBreakdown: payrollInput.otBreakdown,
        otSource: payrollInput.otSource,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, batchId));
    const otMap = new Map(inputs.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusMap = new Map(inputs.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1Map = new Map(inputs.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatMap = new Map(inputs.map((r) => [r.employmentId, Number(r.zakat)]));
    // 1.2.8 (ADR-0060): surface the reserved loan deduction so the admin's pre-generation net preview
    // matches the generated payslip (omitting it would create a silent reconciliation gap).
    const loanMap = new Map(inputs.map((r) => [r.employmentId, Number(r.loanDeduction)]));
    const otBreakdownMap = new Map(inputs.map((r) => [r.employmentId, r.otBreakdown ?? null]));
    const otSourceMap = new Map(inputs.map((r) => [r.employmentId, r.otSource ?? null]));
    const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd);
    return emps.map((e) => {
      const wages = round2(Number(e.basic) + Number(e.allowance ?? 0));
      // s.60I(1A): ORP = wages/26, hourly = ORP/8. Run the engine with no days to get just the basis +
      // eligibility against the statutory wage ceiling — the SAME computation that monetizes a prefill.
      const basis = pack
        ? pack.payroll.overtimePay({
            monthlyWages: wages,
            days: [],
            wageCeiling: otCeiling,
            restDayExcessMultiplier: otRules?.restDayExcessMultiplier,
            holidayExcessMultiplier: otRules?.holidayExcessMultiplier,
          })
        : null;
      return {
        employmentId: e.employmentId,
        name: e.name,
        employeeCode: e.employeeCode,
        basic: Number(e.basic),
        overtimeAmount: otMap.get(e.employmentId) ?? 0,
        // Per-bucket rate split for prefilling the four OT inputs; null ⇒ inputs default to 0 each.
        otBreakdown: otBreakdownMap.get(e.employmentId) ?? null,
        // Fix-5 (M#17): provenance of the current OT figure ('attendance' | 'manual' | null) — drives the
        // editor's clobber warning before a manual Save overwrites an attendance-derived row.
        otSource: otSourceMap.get(e.employmentId) ?? null,
        // Fix-5 (#4): read-only s.60I(1A) basis surfaced beside the manual OT inputs so the admin keys
        // against the correct ORP/hourly. orp/hourly null when no pack resolves (non-MY).
        orp: basis ? basis.orp : null,
        hourly: basis ? basis.hourly : null,
        // Fix-5 (#29): false ⇒ wages above the s.60A RM4,000 ceiling, statutory OT not mandated (any OT
        // here is contractual). null ⇒ no pack/ceiling to assess against.
        otEligible: basis ? basis.eligible : null,
        otWageCeiling: otCeiling ?? null,
        bonusAmount: bonusMap.get(e.employmentId) ?? 0,
        tp1Deduction: tp1Map.get(e.employmentId) ?? 0,
        zakat: zakatMap.get(e.employmentId) ?? 0,
        loanDeduction: loanMap.get(e.employmentId) ?? 0,
        unpaidDays: unpaid.get(e.employmentId) ?? 0,
      };
    });
  });
}
