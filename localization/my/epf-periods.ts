/**
 * Board 66175cd2 (plan r1) — THE PAYROLL MONTHS A KWSP FORM CAN ACTUALLY BE PRODUCED FOR, for one company.
 *
 * The Open Form step for Borang A and BBCD used to offer the last seven years and all twelve months,
 * whatever payroll the company had run, and open on last month. For a new company, or any month with no
 * processed payroll, Continue then answered "No processed payroll cycle for this company and month yet".
 * The reporter asked for the Year and Month lists to show only periods with processed payroll that carries
 * EPF. This is that list, and it is declared on the two report definitions as `availablePeriods`, so the
 * criteria step reaches it through `core/reporting` and never names this pack (ADR-0080 D1).
 *
 * ── WHAT IS LISTED ────────────────────────────────────────────────────────────────────────────────
 * The DISTINCT `payroll_batch.pay_period` of the company's runs that are:
 *   • `processed` or `closed` — exactly `listFilableRunsForPeriod` (core/payroll-view.ts), which is the
 *     list the Payroll Cycle box beside it shows; history-import runs are included exactly as it includes
 *     them, because they are payroll_batch rows with the same statuses;
 *   • AND carry at least one payslip whose recorded EPF employee or employer share is non-zero. That is the
 *     money Borang A totals, so a month whose runs charged nobody a sen of EPF (every person exempt, or a
 *     run that paid nothing) is not offered — Borang A would refuse it as "nothing to file".
 * ⚠️ One accepted edge (plan r1): a month whose signed corrections net to zero (ADR-0085 deltas) can be
 * listed and then refused by the form's own "nothing to file" gate. The refusal text already covers it.
 *
 * ── ONE SET-BASED STATEMENT, NO LOOP ──────────────────────────────────────────────────────────────
 * One SELECT DISTINCT with a correlated EXISTS per run (the payslip probe stops at the first EPF-bearing
 * payslip and is served by `payslip_batch_employment_uq`, whose leading column is batch_id). No per-month,
 * per-run or per-employee loop runs in the request (docs/SCALE-AND-RELEASE-RULES.md rule 2). Under the same
 * shared payroll-history barrier as the Borang A read itself, so a list and the form it leads to see one
 * history.
 *
 * NOTHING IS WRITTEN. The tenant and company are filtered explicitly as well as by row security; the
 * caller (`reportAvailablePeriods`) has already refused a company outside the admin's scope.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type SessionContext } from '../../db/client';
import { withPayrollHistoryTenant as withTenant } from '../../core/payroll-history-lock';
import { payrollBatch, payslip } from '../../db/schema';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Payroll months (`YYYY-MM`) with processed EPF payroll for `companyId`, NEWEST FIRST. */
export function epfFilablePeriods(ctx: SessionContext, p: { companyId: string }): Promise<string[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ period: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(
        and(
          eq(payrollBatch.tenantId, ctx.tenantId),
          eq(payrollBatch.companyId, p.companyId),
          inArray(payrollBatch.status, ['processed', 'closed']),
          // THE RUN CHARGED SOMEBODY EPF. Correlated EXISTS rather than a join + DISTINCT over payslips, for
          // the reason listFilableRunsForPeriod gives: a join multiplies the run by its headcount.
          sql`exists (select 1 from ${payslip} where ${payslip.batchId} = ${payrollBatch.id} and (coalesce((${payslip.statutory}->>'epfEmployee')::numeric, 0) <> 0 or coalesce((${payslip.statutory}->>'epfEmployer')::numeric, 0) <> 0))`,
        ),
      )
      // NEWEST FIRST — the order the Year and Month lists show, and the default is the first entry.
      .orderBy(desc(payrollBatch.payPeriod));
    return rows.map((r) => r.period).filter((v): v is string => typeof v === 'string' && PERIOD.test(v));
  });
}
