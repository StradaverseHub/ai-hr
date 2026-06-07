/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { packFor } from '../localization/registry';
import {
  company,
  compensation,
  employeeStatutoryMy,
  employment,
  payrollBatch,
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

    const totals = {
      gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0,
      socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, deductions: 0, employerCost: 0,
    };

    for (const e of emps) {
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      const factor = prorationFactor(payPeriod, e.hiredOn, e.terminatedOn);
      const basic = round2(Number(e.basic) * factor);
      const allowance = round2(Number(e.allowance ?? 0) * factor);
      const gross = round2(basic + allowance);
      const st = pack.payroll.statutory(gross, {
        category: (e.taxCategory ?? 1) as 1 | 2 | 3,
        children: e.numChildren ?? 0,
      });
      const totalDeductions = round2(st.epfEmployee + st.socsoEmployee + st.eisEmployee + st.pcb);
      const net = round2(gross - totalDeductions);
      const employerCost = round2(gross + st.epfEmployer + st.socsoEmployer + st.eisEmployer);

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: basic.toFixed(2),
        allowance: allowance.toFixed(2),
        overtimePay: '0.00',
        grossPay: gross.toFixed(2),
        statutory: st,
        otherDeductions: '0.00',
        totalDeductions: totalDeductions.toFixed(2),
        netPay: net.toFixed(2),
        employerCost: employerCost.toFixed(2),
      });

      totals.gross += gross;
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
