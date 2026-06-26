/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { packFor } from '../localization/registry';
import { toCsv } from '../lib/csv';
import {
  assignment,
  attendance,
  claimRequest,
  company,
  companyStatutoryMy,
  compensation,
  employeeStatutoryMy,
  employment,
  employmentPayComponent,
  payComponent,
  payrollBatchComponent,
  leaveLedger,
  leaveRequest,
  leaveType,
  payPeriod,
  payrollBatch,
  payrollInput,
  payslip,
  person,
  rosterAssignment,
  shift,
  tp1Relief,
} from '../db/schema';
import { setPayrollBatchComponent } from './pay-components';
import type { ShiftDifferential, PayRule } from '../db/schema';
import { resolvePayRule } from './pay-rule';

export class BatchNotDraftError extends Error {
  constructor() {
    super('Payslips can only be generated for a draft batch');
    this.name = 'BatchNotDraftError';
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
function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month1 - 1];
}

/**
 * EA-1955 incomplete-month proration factor for a 'YYYY-MM' wage period: the employee is paid for
 * the calendar days they were employed within the month, over the number of days in that month
 * (Employment Act 1955 s.18A ordinary-rate basis). Returns 1 for a full month, 0 if not employed
 * during the period. Date strings are ISO ('YYYY-MM-DD'), so lexical comparison is chronological.
 */
function prorationFactor(payPeriod: string, hiredOn: string, terminatedOn: string | null): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  const eligibleDays = Math.max(0, Number(end.slice(8, 10)) - Number(start.slice(8, 10)) + 1);
  return Math.min(1, eligibleDays / dim);
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
  const rows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${leaveRequest.days}), 0)`,
    })
    .from(leaveRequest)
    .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(
      and(
        eq(leaveRequest.status, 'approved'),
        eq(leaveType.paid, false),
        gte(leaveRequest.startDate, periodStart),
        lte(leaveRequest.startDate, periodEnd),
      ),
    )
    .groupBy(leaveRequest.employmentId);
  return new Map(rows.map((r) => [r.employmentId, Number(r.days)]));
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

export async function createBatch(ctx: SessionContext, p: { companyId: string; payPeriod: string; scope?: BatchScope }) {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): this is the REGULAR run for a (company, month). Reject a second one exactly
    // as before — with MULTI_CYCLE_PAYROLL_ENABLED off there is still one run per month. Additional
    // same-month runs are a separate, gated path (2C-4); this function always creates run_seq=1/regular.
    const [existing] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.payPeriod)))
      .limit(1);
    if (existing) throw new Error('A payroll batch already exists for this period');

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

    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: periodId,
        runSeq: 1,
        runType: 'regular',
        payPeriod: p.payPeriod,
        batchDate: `${p.payPeriod}-28`,
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
      payload: { companyId: p.companyId, payPeriod: p.payPeriod, payPeriodId: periodId, runSeq: 1, runType: 'regular', scope: normalizeScope(p.scope) },
    });
    return { batchId: row.id };
  });
}

/**
 * Wave 2C (ADR-0024) — create an ADDITIONAL same-month run (bonus / off-cycle / adjustment) under the
 * existing pay_period. GATED behind MULTI_CYCLE_PAYROLL_ENABLED, and the regular run must already exist.
 * The run is computed as additional remuneration (the increment method) at generatePayslips.
 */
export async function createAdditionalRun(
  ctx: SessionContext,
  p: { companyId: string; payPeriod: string; runType: 'off_cycle' | 'bonus' | 'adjustment' },
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
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: period.id,
        runSeq: nextSeq,
        runType: p.runType,
        payPeriod: p.payPeriod,
        batchDate: `${p.payPeriod}-28`,
        status: 'draft',
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.run-added',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, payPeriod: p.payPeriod, payPeriodId: period.id, runSeq: nextSeq, runType: p.runType },
    });
    return { batchId: row.id };
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
          // ADR-0050 §0.4: an admin write resets TP1 provenance to manual (null) → sticky, so a later
          // TP1 self-relief prefill leaves this override untouched.
          tp1Source: null,
          zakat: zakat.toFixed(2),
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
      payload: { employmentId: p.employmentId, payrollInputId, fieldsChanged: ['overtimeAmount', 'bonusAmount', 'tp1Deduction', 'zakat'] },
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
          .set({ overtimeAmount: result.total.toFixed(2), updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          overtimeAmount: result.total.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
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

export async function generatePayslips(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, p.batchId)).limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

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
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const overtimeByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1ByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.zakat)]));
    // Approved taxable claims prefilled into this batch (ADR-0021): ride the taxable allowance base.
    const claimAllowanceByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.claimAllowance)]));
    const unpaidByEmp = await unpaidDaysByEmployment(tx, periodStart, periodEnd);

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
      rule: PayRule | null; // Payroll Setup — configurable pay-rule; null ⇒ stored amount (legacy behaviour).
    };
    const recurringByEmp = new Map<string, CompRow[]>();
    const batchCompByEmp = new Map<string, CompRow[]>();
    if (typedComponents && empIds.length) {
      const cols = {
        employmentId: employmentPayComponent.employmentId,
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
      const push = (map: Map<string, CompRow[]>, r: { employmentId: string; amount: string } & Omit<CompRow, 'amount'>) => {
        const list = map.get(r.employmentId) ?? [];
        list.push({ ...r, amount: Number(r.amount) });
        map.set(r.employmentId, list);
      };
      const rec = await tx
        .select(cols)
        .from(employmentPayComponent)
        .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
        .where(
          and(
            inArray(employmentPayComponent.employmentId, empIds),
            isNull(employmentPayComponent.validTo),
            isNull(employmentPayComponent.supersededAt),
          ),
        );
      for (const r of rec) push(recurringByEmp, r);
      const bat = await tx
        .select({ ...cols, employmentId: payrollBatchComponent.employmentId, amount: payrollBatchComponent.amount })
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
        const applied = roundAmount(c.prorates ? resolved * factor : resolved, c.rounding);
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

    for (const e of emps) {
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      // Allowance prorates with basic — EA-1955 incomplete-month treats fixed monthly wages as a whole.
      const factor = prorationFactor(payPeriod, e.hiredOn, e.terminatedOn);
      const daysWorked = Math.round(factor * dim); // proration basis surfaced on the payslip
      // Earnings come from the typed components (flag on) or compensation + payroll_input (flag off).
      // Either way these reproduce the same variables, so the agency-base math below is unchanged.
      const en = earningsOf(e, factor);
      const basic = en.basicGross;
      // Allowance line: wage-bucket non-basic components (incl. the taxable claim) + any all-false
      // "reimbursement" earning (paid but untaxed). Claim/reimbursement do not prorate (ADR-0021/0025).
      const allowance = round2(en.allowanceApplied + en.reimburse);
      const overtime = en.overtime;
      const bonus = en.bonus;
      // Unpaid leave deducts at the EA-1955 ordinary rate of pay (monthly basic / days in month).
      const unpaidDeduction = round2((en.basicRaw / dim) * (unpaidByEmp.get(e.employmentId) ?? 0));
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
      const computeMonth = (additional: number, ot: number) =>
        pack.payroll.statutory(
          wagesExOt,
          taxProfile,
          additional,
          ot,
          { month: pMonth, acc: accByEmp.get(e.employmentId), lpCurrent: lp, zakatCurrent: zakat },
          stOpts,
          rules,
        );
      const earlierRun = earlierRunByEmp.get(e.employmentId) ?? { additional: 0, overtime: 0 };
      const stCore = isAdditionalRun
        ? deltaStat(
            computeMonth(earlierRun.additional + bonus, earlierRun.overtime),
            computeMonth(earlierRun.additional, earlierRun.overtime),
          )
        : computeMonth(bonus, overtime);
      const st = {
        ...stCore,
        // Stamped so future months' replay can accumulate Z and ∑LP (spec §E.5 / §D.1).
        lp,
        zakat,
        // HRD Corp levy rides the normal wage (regular run only); a bonus/off-cycle run adds none.
        hrdf: isAdditionalRun ? 0 : hrdf,
        // EPF contribution mode applied (Wave 2B audit) — 'auto' unless an i-Topup/exempt election.
        epfMode: e.epfMode ?? 'auto',
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
      const slipExtraDeduct = isAdditionalRun ? 0 : en.deduct;
      const statDeductions = round2(st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb);
      const totalDeductions = round2(statDeductions + slipUnpaid + slipExtraDeduct);
      const grossPay = isAdditionalRun ? round2(bonus) : round2(normalWage + bonus);
      const net = round2(grossPay - totalDeductions);
      const employerCost = isAdditionalRun
        ? round2(bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer)
        : round2(wagesExOt + overtime + bonus + en.reimburse + st.epfEmployer + st.socsoEmployer + st.eisEmployer + hrdf);

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: slipBasic.toFixed(2),
        allowance: slipAllowance.toFixed(2),
        overtimePay: slipOvertime.toFixed(2),
        bonus: bonus.toFixed(2),
        daysWorked: isAdditionalRun ? null : String(daysWorked),
        grossPay: grossPay.toFixed(2),
        statutory: { ...st, ...statutoryProvenance }, // `version` + (when source=pack) packVersion/signedKeyId snapshot
        otherDeductions: round2(slipUnpaid + slipExtraDeduct).toFixed(2),
        totalDeductions: totalDeductions.toFixed(2),
        netPay: net.toFixed(2),
        employerCost: employerCost.toFixed(2),
      });

      totals.gross += grossPay;
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

    await tx
      .update(payrollBatch)
      .set({ status: 'processed', employeeCount: emps.length, totals })
      .where(eq(payrollBatch.id, p.batchId));

    // Taxable claims prefilled into this batch are now on a payslip → mark them paid (ADR-0021).
    const paidClaims = await tx
      .update(claimRequest)
      .set({ status: 'paid', paidAt: new Date(), payoutRef: `payroll:${batch.payPeriod}` })
      .where(and(eq(claimRequest.payrollBatchId, p.batchId), eq(claimRequest.status, 'approved')))
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
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
      .select({ status: payrollBatch.status, payPeriodId: payrollBatch.payPeriodId })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'processed') throw new Error('Only a processed batch can be closed');
    await tx.update(payrollBatch).set({ status: 'closed' }).where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.closed',
      actor: actorOf(ctx),
      payload: {},
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

export function listBatches(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        employeeCount: payrollBatch.employeeCount,
        totals: payrollBatch.totals,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined)
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq),
  );
}

export type LeaverAdvisoryRow = {
  employmentId: string;
  name: string;
  terminatedOn: string;
  basic: number;
  annualBalance: number;
  /** Suggested pay-in-lieu for unused annual leave at ORP (basic / 26 per day, EA 1955). */
  suggested: number;
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
      const basic = Number(l.basic);
      out.push({
        employmentId: l.employmentId,
        name: l.name,
        terminatedOn: l.terminatedOn!,
        basic,
        annualBalance: balance,
        suggested: balance > 0 ? round2((basic / 26) * balance) : 0,
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
        name: person.fullName,
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
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.id, payslipId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Rows for the draft-batch input editor: each active-in-period employee with their current manual
 * overtime and the auto-derived unpaid-leave days (read-only preview of what generation will apply).
 */
export function batchInputRows(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;
    const emps = await tx
      .select({ employmentId: employment.id, name: person.fullName, basic: compensation.basicSalary })
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
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, batchId));
    const otMap = new Map(inputs.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusMap = new Map(inputs.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1Map = new Map(inputs.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatMap = new Map(inputs.map((r) => [r.employmentId, Number(r.zakat)]));
    const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd);
    return emps.map((e) => ({
      employmentId: e.employmentId,
      name: e.name,
      basic: Number(e.basic),
      overtimeAmount: otMap.get(e.employmentId) ?? 0,
      bonusAmount: bonusMap.get(e.employmentId) ?? 0,
      tp1Deduction: tp1Map.get(e.employmentId) ?? 0,
      zakat: zakatMap.get(e.employmentId) ?? 0,
      unpaidDays: unpaid.get(e.employmentId) ?? 0,
    }));
  });
}
