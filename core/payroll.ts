/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  PAYROLL_PERMISSION_DEFAULTS,
  decidePayrollPermission,
  type PayrollPermissionKey,
} from '../lib/payroll-permissions';
import { encashableDaysForEmployment } from './leave-encashment';
import { packFor } from '../localization/registry';
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
import { resolvePayRule } from './pay-rule';
import { resolveAssignedPolicy } from './payroll-policy';
import {
  applyOvertimeCaps,
  applyOvertimeCapsDetailed,
  applyRounding,
  leaveDivisorDays,
  payslipReleaseAt,
  prorationDivisorDays,
  resolveProrationSettings,
  usesWorkingDayProration,
  workingDayRoster,
} from './payroll-policy-config';

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

/** A typed pay component that v1 cannot compute correctly (a non-payable/BIK or PCB-only taxable
 *  earning) reached payroll generation. Fail-closed rather than silently under-tax (ADR-0025 §5). */
export class UnsupportedPayComponentError extends Error {
  constructor(code: string) {
    super(`Pay component "${code}" is taxable but not supported in this version (non-payable/PCB-only). Remove it from payroll or wait for a later release.`);
    this.name = 'UnsupportedPayComponentError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  opts?: { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> } },
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  const denom = opts?.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : dim;
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
  const eligibleDays = Math.max(0, Number(end.slice(8, 10)) - Number(start.slice(8, 10)) + 1);
  return Math.min(1, eligibleDays / denom);
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
  const rows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${perDateDays}), 0)`,
    })
    .from(leaveRequest)
    .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(
      and(
        eq(leaveRequest.status, 'approved'),
        // Unpaid days are: (a) any request of an unpaid leave type, OR (b) Phase-B #13 (ADR-0062) — a
        // MATERNITY request whose s.37 paid ALLOWANCE was withheld (allowance_eligible=false), which keeps
        // the paid MATERNITY leave-type but is unpaid for the period. The per-request override wins over the
        // type default; allowance_eligible TRUE/NULL on a paid type stays paid.
        or(
          eq(leaveType.paid, false),
          eq(leaveRequest.allowanceEligible, false),
        ),
        gte(leaveRequest.startDate, periodStart),
        lte(leaveRequest.startDate, periodEnd),
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
  if (process.env.MULTI_CYCLE_PAYROLL_ENABLED !== 'true') {
    throw new Error('Multiple payroll runs per month are not enabled.');
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
 *   2. Draft-stage child rows are deleted: payroll_input, payroll_individual_txn,
 *      payroll_batch_component, and — defensively — payslip (expected empty for a draft, since
 *      generation flips the batch off 'draft'; deleting-if-any keeps the teardown total).
 *   3. Claims stamped onto this batch are DETACHED (payroll_batch_id → null), not deleted — the claim
 *      is an approved business record that must survive and become re-queueable; one
 *      `claim-request.unqueued-from-payroll` event per claim (mirrors claim-request.queued-for-payroll).
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
  const individualTxns = await tx
    .delete(payrollIndividualTxn)
    .where(eq(payrollIndividualTxn.batchId, batchId))
    .returning({ id: payrollIndividualTxn.id });
  const components = await tx
    .delete(payrollBatchComponent)
    .where(eq(payrollBatchComponent.batchId, batchId))
    .returning({ id: payrollBatchComponent.id });
  const payslips = await tx.delete(payslip).where(eq(payslip.batchId, batchId)).returning({ id: payslip.id });
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
    deletedChildCounts: {
      inputs: inputs.length,
      individualTxns: individualTxns.length,
      components: components.length,
      payslips: payslips.length,
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
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const pack = packFor(batch.country);
    if (!pack) throw new Error(`No localization pack for country ${batch.country}`);

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019): DB override or the verified default.
    const rules = await pack.payroll.loadRuleset(tx, { asOf: periodEnd });

    // Per-day classified OT minutes within the pay period (per-day matters: the
    // rest-day ½/1-day rule cannot be computed from monthly aggregates).
    // ADR-0033: when TOIL is on, a day already banked as time-in-lieu is excluded here — the worked OT is
    // compensated once, as cash XOR leave. Flag off ⇒ no clause ⇒ byte-identical.
    const excludeToilDays =
      process.env.TOIL_ENABLED === 'true'
        ? sql`not exists (select 1 from toil_accrual ta where ta.employment_id = ${attendance.employmentId} and ta.worked_date = ${attendance.attendanceDate} and ta.status <> 'lapsed')`
        : undefined;
    const otRows = await tx
      .select({
        employmentId: attendance.employmentId,
        dayType: attendance.dayType,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(attendance.attendanceDate, periodStart),
          lte(attendance.attendanceDate, periodEnd),
          gt(attendance.otMinutes, 0),
          excludeToilDays,
        ),
      );
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
  if (process.env.TYPED_PAY_COMPONENTS_ENABLED !== 'true') return { applied: 0, gated: true as const };
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

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Worked differential shifts in the period for this company (the actual attendance row joined to the
    // rostered shift, keeping only shifts that carry a differential).
    const rows = await tx
      .select({ employmentId: attendance.employmentId, workedMinutes: attendance.workedMinutes, differential: shift.differential })
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
          gte(attendance.attendanceDate, periodStart),
          lte(attendance.attendanceDate, periodEnd),
          gt(attendance.workedMinutes, 0),
          isNotNull(shift.differential),
        ),
      );
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

    // Anyone employed for at least part of the period: hired on/before period end AND not
    // terminated before period start. Mid-period joiners/leavers get a prorated (final) payslip.
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
        isResident: employeeStatutoryMy.isResident,
        eisEligible: employeeStatutoryMy.eisEligible,
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
    const otSourceByEmp = new Map(inputRows.map((r) => [r.employmentId, r.otSource ?? null]));
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
    const unpaidByEmp = await unpaidDaysByEmployment(tx, periodStart, periodEnd);

    // ── 2.1.1 (ADR-0064) — Monthly payroll-policy General Settings, resolved at RUN TIME ──
    // The load-bearing new plumbing: for each employment, resolve its assigned policy's config (raw
    // tenant-scoped SQL inside this Tx, under the caller's session). A null/inactive/unassigned policy ⇒
    // null config ⇒ the legacy code path is unchanged (the default-equals-legacy golden matrix proves it).
    // This is a DERIVED READ on every compute — it appends NO DomainEvent (substrate "no event for derived
    // recomputation" rule). Resolved ONCE here, before the loop, so each primitive reads a map not a re-query.
    const policyConfigByEmp = new Map<string, PayrollPolicyConfig | null>();
    // Working-day proration needs the holiday set per employment; resolve it lazily only when a config asks
    // for a working-day basis, so the default (calendar) path issues NO extra query.
    const prorationOptsByEmp = new Map<string, { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> } }>();
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
      const opts: { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> } } = {};
      if (divisorDays !== dim) opts.divisorDays = divisorDays;
      if (usesWorkingDayProration(prorationSettings)) {
        const holidays = (prorationSettings?.includeHoliday ?? false)
          ? new Set<string>() //              holidays count as worked days ⇒ empty exclusion set
          : await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        opts.workingDayBasis = { roster: workingDayRoster(prorationSettings), holidays };
      }
      if (opts.divisorDays !== undefined || opts.workingDayBasis) prorationOptsByEmp.set(e.employmentId, opts);
      // 2.1.2 daily branch — only when the resolved policy is daily AND carries a per_day rate. Eligible days
      // = the employee's working days (Mon–Fri) in the period, less public holidays, within their tenure
      // window. Zero eligible days ⇒ basic = 0 (no divide-by-zero: this is a multiply, not a divide).
      if (policy?.policyType === 'daily' && policy.payRule?.kind === 'per_day') {
        const rate = Number(policy.payRule.rate);
        const dailyHolidays = await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        const eligibleDays = eligibleWorkingDays(payPeriod, e.hiredOn, e.terminatedOn, dailyHolidays);
        dailyPayByEmp.set(e.employmentId, { rate, eligibleDays, basic: round2(rate * eligibleDays) });
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
    for (const s of priorSlips) {
      const acc = accByEmp.get(s.employmentId);
      if (!acc) continue;
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; lp?: number; zakat?: number };
      const claimed = Math.min(Number(st.epfEmployee ?? 0), Math.max(0, EPF_RELIEF_CAP - acc.epfClaimed));
      acc.netRemuneration = round2(acc.netRemuneration + Number(s.gross) - claimed);
      acc.epfClaimed = round2(acc.epfClaimed + claimed);
      acc.pcbPaid = round2(acc.pcbPaid + Number(st.pcb ?? 0));
      acc.zakatPaid = round2(acc.zakatPaid + Number(st.zakat ?? 0)); // §E.5: full zakat accrues to Z
      acc.lpAccumulated = round2(acc.lpAccumulated + Number(st.lp ?? 0));
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
    const typedComponents = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';
    type CompRow = {
      code: string; name: string; kind: string; amount: number; rounding: string;
      epf: boolean; socso: boolean; pcb: boolean; hrdf: boolean; nonPayable: boolean; prorates: boolean;
      // 1.2.1 Fixed Transaction — per-employee override of the catalog `prorates` flag (null = inherit). A
      // one-off batch component has no override, so this is null there too (⇒ catalog flag, unchanged).
      prorateOverride: boolean | null;
      rule: PayRule | null; // Payroll Setup — configurable pay-rule; null ⇒ stored amount (legacy behaviour).
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

    // Payroll Setup — attendance worked HOURS per employment, for `per_hour` rules only. Computed once here
    // (gated on typedComponents) so the per-component resolver reads a map, not a re-query. No attendance
    // rows ⇒ 0 hours, a real, non-erroring outcome (paid by the hour, worked no hours) — there is NO division
    // in the resolver, so a zero-hours employee never aborts the batch.
    const hoursByEmp = new Map<string, number>();
    if (typedComponents && empIds.length) {
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

    /** Per-employee earnings, from the typed components (flag on) or the legacy comp+input (flag off).
     *  Returns the exact variables the loop already used so the rest of the kernel is unchanged. */
    const earningsOf = (
      e: { employmentId: string; basic: unknown; allowance: unknown },
      factor: number,
    ): {
      basicRaw: number; basicGross: number; allowanceApplied: number; hrdfAllowApplied: number;
      overtime: number; bonus: number; reimburse: number; deduct: number;
      recordLines: { code: string; name: string; amount: number }[];
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
        };
      }
      let basicRaw = 0, basicGross = 0, wageAllow = 0, hrdfAllow = 0, ot = 0, bonusAmt = 0, reimburse = 0, deduct = 0;
      const recordLines: { code: string; name: string; amount: number }[] = [];
      const comps = [...(recurringByEmp.get(e.employmentId) ?? []), ...(batchCompByEmp.get(e.employmentId) ?? [])];

      // Payroll Setup — pay-rule scope (shared by all components). `daysWorked` reflects the partial period
      // (factor × dim); `hours` is the employee's attendance hours. NOTE: `per_day`/`per_hour` rules require
      // the component to have prorates=false (validatePayRule rejects the combo), so the kernel's `factor`
      // multiplier below does NOT also apply to them — no double-proration. `percent_of basic` reads the
      // BASIC component's resolved amount (computed once below, order-independent). There is NO division in
      // the resolver, so a zero-days / zero-hours employee can never abort the batch.
      const rscope = { basic: 0, daysWorked: factor * dim, hours: hoursByEmp.get(e.employmentId) ?? 0 };
      // Resolve the BASIC component's amount first so `percent_of basic` is order-independent. BASIC itself
      // never references percent_of basic, so basic=0 in its own scope is harmless.
      const basicComp = comps.find((c) => c.code === 'BASIC');
      rscope.basic = basicComp ? resolvePayRule(basicComp.rule, rscope, basicComp.amount) : 0;
      // A single resolved value per component, substituted at BOTH read sites (the line-868 amount and the
      // line-877 basicRaw accumulator) so the gross AND the statutory base see the same number.
      const resolveAmount = (c: (typeof comps)[number]): number =>
        c.rule && c.rule.kind !== 'fixed' ? resolvePayRule(c.rule, rscope, c.amount) : c.amount;

      for (const c of comps) {
        const resolved = resolveAmount(c);
        // 1.2.1 Fixed Transaction — the per-employee override wins over the catalog `prorates` flag; null
        // (every legacy/backfilled row + every one-off batch component) inherits the catalog flag, so this is
        // byte-identical to the prior `c.prorates` behaviour. `factor` is the EA-1955 join/resign tenure
        // factor (prorate ON = proportional for a mid-period joiner/resigner, OFF = full amount).
        const prorate = c.prorateOverride ?? c.prorates;
        const applied = roundAmount(prorate ? resolved * factor : resolved, c.rounding);
        if (c.kind === 'deduction') { deduct = round2(deduct + applied); continue; }
        // FAIL-CLOSED (ADR-0025 §5): a PCB-taxable non-payable/BIK, or a PCB-only earning (not EPF and not
        // SOCSO), would be SILENTLY under-taxed — v1 does not compute the tax, so reject rather than produce
        // a wrong payslip. (Write-time guards in core/pay-components.ts now reject the same at entry/import.)
        // PRECEDENCE: the flag check runs on the resolved value — a rule does not let an unsupported
        // component through (an unsupported-PCB component still throws regardless of what its rule resolves to).
        if (c.pcb && (c.nonPayable || (!c.epf && !c.socso))) {
          throw new UnsupportedPayComponentError(c.code);
        }
        // A non-payable, non-taxable component (e.g. a record-only BIK) carries onto the payslip as an
        // INFORMATIONAL record line — it does NOT affect any cash bucket, gross, or net (ADR-0025 §5 / Option A).
        if (c.nonPayable) { recordLines.push({ code: c.code, name: c.name, amount: applied }); continue; }
        if (c.code === 'BASIC') { basicRaw += resolved; basicGross = round2(basicGross + applied); continue; }
        if (c.epf && c.socso) { wageAllow = round2(wageAllow + applied); if (c.hrdf) hrdfAllow = round2(hrdfAllow + applied); }
        else if (!c.epf && c.socso) ot = round2(ot + applied);
        else if (c.epf && !c.socso) bonusAmt = round2(bonusAmt + applied);
        else reimburse = round2(reimburse + applied); // all-false earning: paid but untaxed (e.g. receipted reimbursement)
      }
      return { basicRaw, basicGross, allowanceApplied: wageAllow, hrdfAllowApplied: hrdfAllow, overtime: ot, bonus: bonusAmt, reimburse, deduct, recordLines };
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
      const daysWorked = daily ? daily.eligibleDays : Math.round(factor * dim); // proration basis surfaced on the payslip
      // Earnings come from the typed components (flag on) or compensation + payroll_input (flag off).
      // Either way these reproduce the same variables, so the agency-base math below is unchanged.
      const en = earningsOf(e, factor);
      // 1c — salary-increment proration: when the policy enables it AND a mid-period increment straddles the
      // period, the basic is the two-row blend (already day-weighted across the increment date), NOT
      // basic×factor. Default (off / no straddle) ⇒ undefined ⇒ the kernel's normal basicGross is used.
      // 2.1.2 — for a daily policy, basic = per_day rate × eligible days (no proration, no increment blend).
      const incrementBasic = incrementBasicByEmp.get(e.employmentId);
      const basicRaw = daily ? daily.basic : (incrementBasic ?? en.basicRaw);
      const basic = daily ? daily.basic : (incrementBasic !== undefined ? round2(incrementBasic) : en.basicGross);
      // 1e — OT caps: wrap the prefilled/keyed OT figure with the policy's caps (eligible day types, max
      // hours, max amount, floored multiplier). Default (no overtime config) ⇒ the figure is unchanged.
      const otCap = applyOvertimeCapsForEmp(cfg, e.employmentId, en.overtime);
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
        cutoffDays: dim, //                       cut-off-day-driven divisor is a deferred spec; calendar fallback
        workingDays: workingDaysInPeriodFor(e.employmentId),
      });
      // 2.1.2 — a daily wage already pays ONLY eligible worked days, so an unpaid-leave day is simply not a
      // worked day (never counted into `basic`); deducting again off basicRaw/divisor would double-count it.
      const unpaidDeduction = daily ? 0 : round2((basicRaw / unpaidDivisor) * (unpaidByEmp.get(e.employmentId) ?? 0));
      const normalWage = round2(basic + allowance + overtime); // regular monthly remuneration
      // Agency bases differ (STATUTORY-SOURCES §6): EPF EXCLUDES overtime, SOCSO/EIS/PCB
      // include it — so the calculator takes wages ex-OT and the OT separately. The all-false
      // reimbursement is paid (in `allowance`/gross) but NOT in any statutory base.
      const wagesExOt = Math.max(0, round2(basic + en.allowanceApplied - unpaidDeduction));
      // Bonus is additional remuneration: EPF + PCB (difference method), excluded from SOCSO/EIS.
      const lp = round2(tp1ByEmp.get(e.employmentId) ?? 0);
      const zakat = round2(zakatByEmp.get(e.employmentId) ?? 0);
      const age = ageAt(e.dateOfBirth);
      // HRD Corp levy (Wave 2A) — employer-only. Base = basic + FIXED (HRDF-flagged) allowance net of
      // unpaid leave; NOT the EPF/SOCSO wage (overtime, bonus, and reimbursed claims are excluded).
      const fixedAllowance = en.hrdfAllowApplied;
      const hrdfBase = Math.max(0, round2(basic + fixedAllowance - unpaidDeduction));
      // #6: HRDF rates come from the resolved ruleset (rules.hrdf) when overridden, else the built-in MY_HRDF.
      const hrdf = pack.payroll.hrdfLevy(hrdfBase, hrdfStatus, rules.hrdf);
      // 1.2.3 CP38 — the month's LHDN instalment. Charged on the REGULAR run only: like basic/OT/unpaid/hrdf,
      // an additional (off-cycle/bonus/adjustment) run carries cp38 = 0 (a re-issue re-runs the regular batch,
      // not an adjustment run). So a regular + bonus run in one month charges exactly one instalment.
      const cp38 = isAdditionalRun ? 0 : round2(cp38ByEmp.get(e.employmentId)?.amount ?? 0);
      // Statutory contribution. Regular run: computed directly as today (byte-identical). Additional run
      // (Wave 2C): the INCREMENT of the cumulative month — re-run with/without this run's additional
      // remuneration and take the delta, so the normal wage's SOCSO/EPF (already charged by the regular
      // run) cancels, SOCSO/EIS add 0, and PCB nets against earlier same-month MTD (ADR-0024 §4).
      const taxProfile = { category: (e.taxCategory ?? 1) as 1 | 2 | 3, children: e.numChildren ?? 0 };
      const stOpts = {
        // SOCSO Second Category (employer Injury-only) for age 60+ AND foreign workers (#156); both
        // still pay the employee SKBBK leg. EIS (Act 800) is Malaysian 18–60 only — not 60+, not foreign.
        socsoCategory: ((age != null && age >= 60) || (e.epfCitizenship ?? 'citizen') === 'non_citizen' ? 2 : 1) as 1 | 2,
        eisEligible:
          (e.eisEligible ?? true) && (age == null || age < 60) && (e.epfCitizenship ?? 'citizen') !== 'non_citizen',
        resident: e.isResident ?? true,
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
        ...(!isAdditionalRun && en.recordLines.length ? { recordLines: en.recordLines } : {}),
      };

      // Payslip amounts. An additional run pays ONLY its additional remuneration — the normal wage,
      // allowance and OT were paid by the regular run — so basic/allowance/OT are 0 and gross = the bonus.
      const slipBasic = isAdditionalRun ? 0 : basic;
      const slipAllowance = isAdditionalRun ? 0 : allowance;
      const slipOvertime = isAdditionalRun ? 0 : overtime;
      const slipUnpaid = isAdditionalRun ? 0 : unpaidDeduction;
      const grossPay = isAdditionalRun ? round2(bonus) : round2(normalWage + bonus);
      const statDeductions = round2(st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb);
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
      const employerCost = isAdditionalRun
        ? round2(bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer)
        // Step 4 (f3148da1) — the converted OT excess is real employer outlay (paid to the employee), so it
        // adds to employer cost alongside the OT it was rerouted from. Default (no convert) ⇒ 0 ⇒ unchanged.
        : round2(wagesExOt + overtime + otConvertAmount + bonus + en.reimburse + st.epfEmployer + st.socsoEmployer + st.eisEmployer + hrdf);

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
      payload: { count: emps.length, totalNet: totals.net },
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
    if (batch.status !== 'processed') throw new Error('Only a processed batch can be closed');
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
  if (process.env.PAYROLL_RESET_ENABLED !== 'true') {
    throw new Error('Payroll reset is not enabled.');
  }
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
      reason: p.reason ?? null,
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
        reason: p.reason ?? null,
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
/** Step-up (OTP) confirmation is required / failed for a high-risk payroll action. */
export class StepUpRequiredError extends Error {
  constructor(msg = 'A valid confirmation code is required.') {
    super(msg);
    this.name = 'StepUpRequiredError';
  }
}
/** Unlock target is not a closed run (nothing to unlock). */
export class BatchNotUnlockableError extends Error {
  constructor() {
    super('Only a closed payroll process can be unlocked');
    this.name = 'BatchNotUnlockableError';
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

const stepUpHash = (code: string, userId: string | undefined, batchId: string) =>
  createHash('sha256').update(`${code}:${userId ?? ''}:${batchId}`).digest('hex');

/**
 * Issue a one-time step-up (OTP) code for the high-risk Unlock action (reporter req.: confirmation step,
 * password re-entry or OTP). The code is hashed at rest, single-use, TTL 10 min, and returned to the
 * caller so the demo can surface it (a production build would deliver it out-of-band). Requires the
 * payroll.unlock permission — you cannot mint an unlock challenge you could never complete.
 */
export async function requestUnlockChallenge(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    await assertPayrollPermission(tx, ctx, 'payroll.unlock', batch.companyId);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    // Invalidate any earlier unconsumed challenge for this user+batch so only the newest code works.
    await tx
      .update(payrollStepUpChallenge)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(payrollStepUpChallenge.batchId, p.batchId),
          eq(payrollStepUpChallenge.userId, ctx.userId ?? ''),
          eq(payrollStepUpChallenge.purpose, 'unlock'),
          isNull(payrollStepUpChallenge.consumedAt),
        ),
      );
    await tx.insert(payrollStepUpChallenge).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId ?? '',
      batchId: p.batchId,
      purpose: 'unlock',
      codeHash: stepUpHash(code, ctx.userId, p.batchId),
      expiresAt,
    });
    return { code, expiresAt };
  });
}

/** Verify + consume a step-up code within the caller's tx. Returns true iff a valid code was consumed. */
async function verifyStepUp(tx: Tx, ctx: SessionContext, batchId: string, code: string): Promise<boolean> {
  if (!code) return false;
  const [challenge] = await tx
    .select({ id: payrollStepUpChallenge.id, codeHash: payrollStepUpChallenge.codeHash, expiresAt: payrollStepUpChallenge.expiresAt })
    .from(payrollStepUpChallenge)
    .where(
      and(
        eq(payrollStepUpChallenge.batchId, batchId),
        eq(payrollStepUpChallenge.userId, ctx.userId ?? ''),
        eq(payrollStepUpChallenge.purpose, 'unlock'),
        isNull(payrollStepUpChallenge.consumedAt),
      ),
    )
    .orderBy(desc(payrollStepUpChallenge.createdAt))
    .limit(1);
  if (!challenge) return false;
  if (new Date(challenge.expiresAt).getTime() < Date.now()) return false;
  if (challenge.codeHash !== stepUpHash(code, ctx.userId, batchId)) return false;
  await tx.update(payrollStepUpChallenge).set({ consumedAt: new Date() }).where(eq(payrollStepUpChallenge.id, challenge.id));
  return true;
}

/**
 * Unlock a CLOSED payroll run back to PROCESSED (feedback 9bc442bc, reporter ask #2). This is the
 * controlled, auditable reversal of the 0011 closed-immutability freeze:
 *   • gated on the granular payroll.unlock permission (super_admin by default, per-company configurable);
 *   • a step-up OTP (requestUnlockChallenge) must be confirmed — the reporter's password-re-entry/OTP ask;
 *   • WARNS when the run's payment summary was already exported and/or statutory returns were already
 *     recorded for the month (EPF/SOCSO/EIS/LHDN), so the operator knows an amended filing may be needed;
 *   • flips status via a transaction-local escape hatch the 0011 trigger honours ONLY for this batch id;
 *   • reopens the parent pay_period (it was cascaded closed) so a correction re-run is possible;
 *   • records a payroll_status_history row (before/after + reason + warnings) and appends domain events.
 * Gated behind PAYROLL_UNLOCK_ENABLED so an environment can keep Closed permanently frozen if it prefers
 * the same-month adjustment-run correction path instead.
 */
export async function unlockClosedBatch(ctx: SessionContext, p: { batchId: string; reason?: string; code: string }) {
  if (process.env.PAYROLL_UNLOCK_ENABLED !== 'true') {
    throw new Error('Payroll unlock is not enabled.');
  }
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new Error('A reason is required to unlock a closed payroll process.');
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
    if (!(await verifyStepUp(tx, ctx, p.batchId, p.code))) {
      throw new StepUpRequiredError('The confirmation code is invalid or expired — request a new one.');
    }

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
  if (process.env.MULTI_CYCLE_PAYROLL_ENABLED !== 'true') {
    throw new Error('Multiple payroll runs per month are not enabled.');
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
export function listBatches(ctx: SessionContext, companyIds?: string[], payPeriod?: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        company: company.legalName,
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
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(
        and(
          companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined,
          payPeriod ? eq(payrollBatch.payPeriod, payPeriod) : undefined,
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
 * bonus input consciously (documented in STATUTORY-SOURCES.md).
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
      out.push({
        employmentId: l.employmentId,
        name: l.name,
        employeeCode: l.employeeCode,
        terminatedOn: l.terminatedOn!,
        basic,
        annualBalance: effectiveBalance,
        suggested: effectiveBalance > 0 ? round2((basic / 26) * effectiveBalance) : 0,
        encashmentSource: encashment ? 'frozen_snapshot' : 'live_balance',
        ...(encashment ? { frozenAsOf: encashment.calculatedAsOf, overridden: encashment.overridden } : {}),
      });
    }
    return out;
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
        net: payslip.netPay,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    if (rows.length === 0) throw new PaymentSummaryNotReadyError('This batch has no payslips to export.');

    const header = ['No', 'Employee', 'Employee Code', 'IC', 'Bank', 'Account No', 'Net Pay (RM)'];
    const body = rows.map((r, i) => [
      i + 1,
      r.name,
      r.code ?? '',
      r.ic ?? '',
      r.bankName ?? '',
      r.bankAccountNo ?? '',
      Number(r.net).toFixed(2),
    ]);
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
