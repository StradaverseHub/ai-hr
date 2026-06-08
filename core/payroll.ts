/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { packFor } from '../localization/registry';
import {
  company,
  compensation,
  employeeStatutoryMy,
  employment,
  leaveRequest,
  leaveType,
  payrollBatch,
  payrollInput,
  payslip,
  person,
} from '../db/schema';

export class BatchNotDraftError extends Error {
  constructor() {
    super('Payslips can only be generated for a draft batch');
    this.name = 'BatchNotDraftError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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

export async function createBatch(ctx: SessionContext, p: { companyId: string; payPeriod: string }) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.payPeriod)))
      .limit(1);
    if (existing) throw new Error('A payroll batch already exists for this period');
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        batchDate: `${p.payPeriod}-28`,
        status: 'draft',
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, payPeriod: p.payPeriod },
    });
    return { batchId: row.id };
  });
}

/** Upsert a draft batch's manual overtime input for one employee. Draft-only; appends an event. */
export async function setPayrollInput(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string; overtimeAmount: number; bonusAmount?: number },
) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const overtimeAmount = Math.max(0, Number(p.overtimeAmount) || 0);
    const bonusAmount = Math.max(0, Number(p.bonusAmount) || 0);
    const [existing] = await tx
      .select({ id: payrollInput.id })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    if (existing) {
      await tx
        .update(payrollInput)
        .set({
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          updatedAt: sql`now()`,
        })
        .where(eq(payrollInput.id, existing.id));
    } else {
      await tx.insert(payrollInput).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: p.employmentId,
        overtimeAmount: overtimeAmount.toFixed(2),
        bonusAmount: bonusAmount.toFixed(2),
      });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.input-set',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, overtimeAmount, bonusAmount },
    });
    return { ok: true };
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

    // Active employees with current compensation.
    const { payPeriod } = batch;
    const [pYear, pMonth] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

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
      })
      .from(employment)
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
        ),
      );

    // Per-employee inputs: manual overtime (entered on the draft batch) + auto-derived unpaid days.
    const dim = daysInMonth(pYear, pMonth);
    const inputRows = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const overtimeByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.bonus)]));
    const unpaidByEmp = await unpaidDaysByEmployment(tx, periodStart, periodEnd);

    const totals = {
      gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0,
      socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, deductions: 0, employerCost: 0,
    };

    for (const e of emps) {
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      // Allowance prorates with basic — EA-1955 incomplete-month treats fixed monthly wages as a whole.
      const factor = prorationFactor(payPeriod, e.hiredOn, e.terminatedOn);
      const daysWorked = Math.round(factor * dim); // proration basis surfaced on the payslip
      const basic = round2(Number(e.basic) * factor);
      const allowance = round2(Number(e.allowance ?? 0) * factor);
      const overtime = round2(overtimeByEmp.get(e.employmentId) ?? 0);
      const bonus = round2(bonusByEmp.get(e.employmentId) ?? 0);
      // Unpaid leave deducts at the EA-1955 ordinary rate of pay (monthly basic / days in month).
      const unpaidDeduction = round2((Number(e.basic) / dim) * (unpaidByEmp.get(e.employmentId) ?? 0));
      const normalWage = round2(basic + allowance + overtime); // regular monthly remuneration
      const statBase = Math.max(0, round2(normalWage - unpaidDeduction)); // wages payable, ex-bonus
      // Bonus is additional remuneration: EPF + PCB (difference method), excluded from SOCSO/EIS.
      const st = pack.payroll.statutory(
        statBase,
        { category: (e.taxCategory ?? 1) as 1 | 2 | 3, children: e.numChildren ?? 0 },
        bonus,
      );
      const statDeductions = round2(st.epfEmployee + st.socsoEmployee + st.eisEmployee + st.pcb);
      const totalDeductions = round2(statDeductions + unpaidDeduction);
      const grossPay = round2(normalWage + bonus); // total earnings before deductions
      const net = round2(grossPay - totalDeductions);
      const employerCost = round2(statBase + bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer);

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: basic.toFixed(2),
        allowance: allowance.toFixed(2),
        overtimePay: overtime.toFixed(2),
        bonus: bonus.toFixed(2),
        daysWorked: String(daysWorked),
        grossPay: grossPay.toFixed(2),
        statutory: st,
        otherDeductions: unpaidDeduction.toFixed(2),
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
      .select({ status: payrollBatch.status })
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
  });
}

export function listBatches(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        employeeCount: payrollBatch.employeeCount,
        totals: payrollBatch.totals,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined)
      .orderBy(desc(payrollBatch.payPeriod)),
  );
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
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, batchId));
    const otMap = new Map(inputs.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusMap = new Map(inputs.map((r) => [r.employmentId, Number(r.bonus)]));
    const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd);
    return emps.map((e) => ({
      employmentId: e.employmentId,
      name: e.name,
      basic: Number(e.basic),
      overtimeAmount: otMap.get(e.employmentId) ?? 0,
      bonusAmount: bonusMap.get(e.employmentId) ?? 0,
      unpaidDays: unpaid.get(e.employmentId) ?? 0,
    }));
  });
}
