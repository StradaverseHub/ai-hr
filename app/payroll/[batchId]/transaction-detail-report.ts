/**
 * The Transaction Detail Report for ONE payroll run (e440991b point 6) — the pure half.
 *
 * The reporter asked to "take the whole run into Excel to reconcile it": one row per employee carrying
 * the employee, company, department, period and every earning, deduction, employer contribution and
 * total. That is, line for line, the PAYROLL REGISTER (feedback 622e12eb) — which already exists as a
 * custom-report dataset over `listPayrollRegisterAcross`. So this is not a second report: it is the
 * register, pre-filtered to the run you are looking at and put behind a button on that run's screen,
 * with the same column set and the same English headers (ADR-0047 §9) so the two can never disagree.
 *
 * EVERY FIGURE IS THE PAYSLIP'S OWN STORED SNAPSHOT, never a recomputation. `listPayrollRegisterAcross`
 * reads the payslip columns and the immutable `statutory` jsonb the run wrote; nothing here recalculates
 * anything. That is not an optimisation — a report that disagrees with the payslip it summarises is
 * worse than no report, and it is exactly what would happen on a run that was reprocessed under a newer
 * statutory ruleset, or on a closed period whose rules have since moved on.
 *
 * Kept separate from route.ts and free of db/session imports so the column set and the row projection
 * are unit-testable against real payslips without an HTTP round trip.
 */
import type { PayrollRegisterRow } from '@/core/payroll-view';
import type { ReportData } from '@/lib/report-export';

/**
 * Column headers stay ENGLISH, resolved from this constant rather than from getTranslations.
 *
 * Same rule the OT-report export states: an export payload is consumed by spreadsheets, accountants and
 * external systems, so a header that changes with the reader's UI language silently breaks whatever is
 * parsing it — and a half-translated header set is worse again. Labels are copied from the Payroll
 * Register dataset (core/report-registry.ts) so a column means the same thing in both places.
 */
export const TRANSACTION_DETAIL_COLUMNS: { key: keyof PayrollRegisterRow; label: string }[] = [
  { key: 'employeeCode', label: 'Employee ID' },
  { key: 'employeeName', label: 'Employee Name' },
  { key: 'company', label: 'Company' },
  { key: 'department', label: 'Department' },
  { key: 'position', label: 'Position' },
  { key: 'jobGrade', label: 'Job Grade' },
  { key: 'employmentStatus', label: 'Employment Status' },
  { key: 'employmentType', label: 'Employment Type' },
  { key: 'payPeriod', label: 'Payroll Period' },
  { key: 'payrollCycle', label: 'Payroll Cycle' },
  { key: 'runSeq', label: 'Run No.' },
  { key: 'daysWorked', label: 'Days Worked' },
  // Earnings
  { key: 'basic', label: 'Basic Salary' },
  { key: 'allowance', label: 'Allowances' },
  { key: 'overtime', label: 'Overtime' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'gross', label: 'Total Earnings (Gross)' },
  // Deductions (employee share)
  { key: 'epfEmployee', label: 'EPF (Employee)' },
  { key: 'socsoEmployee', label: 'SOCSO (Employee)' },
  // SKBBK is the employee's share of the PERKESO housing/foreign-worker scheme — reported on its own
  // line because PERKESO remits it separately from the ordinary SOCSO share.
  { key: 'socsoSkbbk', label: 'SOCSO SKBBK (Employee)' },
  { key: 'eisEmployee', label: 'EIS (Employee)' },
  { key: 'pcb', label: 'PCB (Tax)' },
  // 970e4143 — these two are ONE answer, and this report is where the double count was worst: unlike the
  // payslip screens its columns are ALWAYS emitted, so every reconciliation sheet for every run carried an
  // instalment twice. `listPayrollRegisterAcross` now reports the APPLIED CP38 and an Other Deductions with
  // that amount taken out (see PayrollRegisterRow). This projection stays what it was — a pass-through —
  // because a report that recomputes what the register already decided is how the two start to disagree.
  { key: 'cp38', label: 'CP38' },
  { key: 'zakat', label: 'Zakat' },
  { key: 'otherDeductions', label: 'Other Deductions' },
  { key: 'totalDeductions', label: 'Total Deductions' },
  { key: 'net', label: 'Nett Wage' },
  // Employer contributions
  { key: 'epfEmployer', label: 'EPF (Employer)' },
  { key: 'socsoEmployer', label: 'SOCSO (Employer)' },
  { key: 'eisEmployer', label: 'EIS (Employer)' },
  { key: 'hrdf', label: 'HRD Corp Levy' },
  { key: 'employerCost', label: 'Total Employer Cost' },
];

/** ASCII-safe filename stem — the serializers put the extension on. */
const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'payroll';

/**
 * Which register rows belong to THIS run.
 *
 * `listPayrollRegisterAcross` is keyed by company + period + cycle, not by batch id, and a company can
 * hold several runs of the same cycle in one period (an adjustment run, a re-run after an unlock). The
 * batch's own `runSeq` is what separates them, and it is carried on every register row for exactly this
 * reason. Filtering here rather than widening the core read keeps the register's query — shared with the
 * custom-report runner — untouched.
 */
export function rowsForRun(
  rows: readonly PayrollRegisterRow[],
  run: { payPeriod: string; runType: string; runSeq: number },
): PayrollRegisterRow[] {
  return rows.filter(
    (r) => r.payPeriod === run.payPeriod && r.payrollCycle === run.runType && r.runSeq === run.runSeq,
  );
}

/** Project the run's register rows into the neutral report shape lib/report-export serializes. */
export function transactionDetailReport(
  run: { company: string; payPeriod: string; runType: string; runSeq: number },
  rows: readonly PayrollRegisterRow[],
): ReportData {
  return {
    filename: slug(`payroll-transaction-detail-${run.company}-${run.payPeriod}-${run.runType}-${run.runSeq}`),
    title: `Payroll Transaction Detail — ${run.company} — ${run.payPeriod}`,
    columns: TRANSACTION_DETAIL_COLUMNS.map((c) => c.label),
    rows: rows.map((r) =>
      TRANSACTION_DETAIL_COLUMNS.map((c) => {
        const v = r[c.key];
        // null stays null (an empty cell, not the string "null"); everything else is passed through as
        // the register produced it — the numeric strings keep their stored precision, and the
        // serializers' own numeric heuristic right-aligns them.
        return v == null ? null : typeof v === 'number' ? v : String(v);
      }),
    ),
    layout: {
      // Employee ID + name repeat as the frozen block: a register is read across ~33 columns and the
      // person the row is about must stay on screen.
      freeze: 2,
    },
  };
}
