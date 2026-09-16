/**
 * Custom-report field registry (ADR-0074, feedback c440b365) — the CLOSED catalogue the custom-report
 * builder, the run/export route, AND the AI designer all draw from. There is NO free-form SQL and NO
 * arbitrary cross-module join: a report may only name a dataset id + field ids this file exposes, and
 * every dataset's underlying read already enforces tenant RLS + company scope, so a saved report can
 * only ever project columns of rows the runner could already export.
 *
 * This mirrors the pay-rule posture (core/pay-rule.ts): a closed enum + a single pure validator
 * (`validateReportSpec`) shared by the UI, the runner and the model output, so an AI-drafted spec is
 * held to exactly the same contract as a hand-built one.
 *
 * Pure module: no DB access at import time. Each dataset carries a `run` that performs the (already
 * scoped) read on demand.
 */
import type { SessionContext } from '../db/client';
import type { CustomReportSpec } from '../db/schema';
import type { ReportData } from '../lib/report-export';
import { masterDataExport, leaveBalancesSummary, type ReportFilter } from './analytics';
import { overtimeReport, attendanceDailyReport, performanceGoalReport, performanceReviewReport } from './reporting';
import { listProcessedPayslipsAcross, listPayrollRegisterAcross } from './payroll-view';
import { payslipDisplayEarnings } from './pay-display-category';
import { listClaimTypes } from './claims';
import { assertModuleGate } from './module-gate';

import { todayInKualaLumpur } from '../lib/hr-date';
// ADR-0077 slice 6 (D-9) — the mixed-currency REFUSAL, not a formatter. See `runReportSpec`'s summary row.
import { isMixedCurrency } from '../lib/money';

/** Alignment/type of a field. Drives the AI designer's default alignment + numeric summary eligibility. */
export type ReportFieldType = 'text' | 'date' | 'number' | 'currency' | 'status';

export type ReportField = {
  id: string;
  /** English label — used verbatim as the export column header (ADR-0047 §9: stable for external consumers). */
  label: string;
  type: ReportFieldType;
  /** Logical grouping for the field list (localised group heading in the UI; field labels stay English). */
  group: string;
};

/** A typed, allow-listed filter/parameter a dataset accepts. `text` filters match by contains on the
 *  projected field; `month`/`year` are read parameters folded into the underlying read. */
export type ReportFilterDef = {
  id: string;
  label: string;
  kind: 'text' | 'month' | 'year';
};

export type ReportCategory = 'master' | 'attendance' | 'leave' | 'payroll' | 'claim' | 'performance';

export type ReportRow = Record<string, string | number | null>;

export type ReportDataset = {
  id: string;
  category: ReportCategory;
  /** English display name (localised at the UI via a datasets namespace keyed by id). */
  label: string;
  fields: ReportField[];
  filters: ReportFilterDef[];
  /** Default column order suggested to a fresh report (all fields, sensible order). */
  defaultColumns: string[];
  /** Perform the (already tenant + company scoped) read and normalise to flat rows keyed by field id. */
  run: (ctx: SessionContext, scopeIds: string[], params: Record<string, string | number | null>) => Promise<ReportRow[]>;
};

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const numStr = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Current YYYY-MM (UTC) — the default month for month-parameterised datasets. */
const currentMonth = (): string => new Date().toISOString().slice(0, 7);

// ─────────────────────────────── Master (HR) ───────────────────────────────
const MASTER: ReportDataset = {
  id: 'master',
  category: 'master',
  label: 'Employee master data',
  fields: [
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'email', label: 'Email', type: 'text', group: 'Identity' },
    { id: 'company', label: 'Company', type: 'text', group: 'Organisation' },
    { id: 'department', label: 'Department', type: 'text', group: 'Organisation' },
    { id: 'position', label: 'Position', type: 'text', group: 'Organisation' },
    { id: 'status', label: 'Status', type: 'status', group: 'Employment' },
    { id: 'employmentType', label: 'Employment Type', type: 'text', group: 'Employment' },
    { id: 'hiredOn', label: 'Hired On', type: 'date', group: 'Employment' },
    { id: 'terminatedOn', label: 'Terminated On', type: 'date', group: 'Employment' },
    { id: 'basicSalary', label: 'Basic Salary', type: 'currency', group: 'Compensation' },
    { id: 'monthlyAllowance', label: 'Monthly Allowance', type: 'currency', group: 'Compensation' },
    { id: 'currency', label: 'Currency', type: 'text', group: 'Compensation' },
  ],
  filters: [
    { id: 'name', label: 'Employee Name contains', kind: 'text' },
    { id: 'department', label: 'Department contains', kind: 'text' },
  ],
  defaultColumns: ['employeeCode', 'name', 'department', 'position', 'status', 'hiredOn'],
  run: async (ctx, scopeIds, params) => {
    const filter: ReportFilter = { q: (str(params.name) ?? undefined) as string | undefined };
    const rows = await masterDataExport(ctx, scopeIds, { includeComp: true, includeTerminated: true, filter });
    return rows.map((r) => ({
      employeeCode: r.employeeCode,
      name: r.name,
      email: r.email,
      company: r.company,
      department: r.department,
      position: r.position,
      status: r.status,
      employmentType: r.employmentType,
      hiredOn: r.hiredOn,
      terminatedOn: r.terminatedOn,
      basicSalary: numStr(r.basicSalary),
      monthlyAllowance: numStr(r.monthlyAllowance),
      currency: r.currency ?? null,
    }));
  },
};

// ─────────────────────────────── Attendance (OT) ───────────────────────────────
const ATTENDANCE_OT: ReportDataset = {
  id: 'attendance_ot',
  category: 'attendance',
  label: 'Overtime & hours',
  fields: [
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'normalWorkingHours', label: 'Working Hours', type: 'number', group: 'Hours' },
    { id: 'totalWorkedHours', label: 'Total Worked Hours', type: 'number', group: 'Hours' },
    { id: 'totalOtHours', label: 'OT Hours', type: 'number', group: 'Overtime' },
    { id: 'normalDayOtHours', label: 'Normal-day OT Hours', type: 'number', group: 'Overtime' },
    { id: 'restDayOtHours', label: 'Rest-day OT Hours', type: 'number', group: 'Overtime' },
    { id: 'publicHolidayOtHours', label: 'Public-holiday OT Hours', type: 'number', group: 'Overtime' },
    { id: 'otAmount', label: 'OT Amount', type: 'currency', group: 'Overtime' },
    // ADR-0077 slice 6 — r115 gave `overtimeReport` a per-company currency EXACTLY so a cross-company OT
    // export is visibly mixed rather than silently addable, and this projection then dropped the column
    // on the floor: the field list offered `OT Amount` as a bare number with nothing saying what it is
    // in. This dataset is built with `companyIds: scopeIds`, so it spans every company the operator can
    // see — the one place the label is not decoration. Offered as a field, deliberately NOT added to
    // `defaultColumns`: every saved report keeps its exact column set, so this is additive by
    // construction. See MASTER above, which already carries its own `currency` for the same reason.
    { id: 'currency', label: 'Currency', type: 'text', group: 'Overtime' },
    { id: 'eligible', label: 'OT Eligible', type: 'status', group: 'Overtime' },
    { id: 'otApprovalStatus', label: 'Approval Status', type: 'status', group: 'Overtime' },
  ],
  filters: [
    { id: 'month', label: 'Month', kind: 'month' },
    { id: 'name', label: 'Employee Name contains', kind: 'text' },
  ],
  defaultColumns: ['name', 'employeeCode', 'totalOtHours', 'otAmount', 'eligible'],
  run: async (ctx, scopeIds, params) => {
    const month = str(params.month) ?? currentMonth();
    const report = await overtimeReport(ctx, { month, companyIds: scopeIds });
    return report.rows.map((r) => ({
      name: r.name,
      employeeCode: r.employeeCode,
      normalWorkingHours: r.normalWorkingHours,
      totalWorkedHours: r.totalWorkedHours,
      totalOtHours: r.totalOtHours,
      normalDayOtHours: r.normalDayOtHours,
      restDayOtHours: r.restDayOtHours,
      publicHolidayOtHours: r.publicHolidayOtHours,
      otAmount: r.otAmount,
      currency: r.currency,
      eligible: r.eligible ? 'Eligible' : 'Not eligible',
      otApprovalStatus: r.otApprovalStatus,
    }));
  },
};

// ─────────────────────────────── Attendance (daily punch grid) ───────────────────────────────
// The reporter's full attendance field list (Branch, Position, Shift, Clock In/Out, Late Minutes, Early
// Out, Attendance Status, Clocking Location, Geofencing Status, Remarks, …) — the per-day grid the OT
// summary omits. Month-parameterised, company-scoped.
const ATTENDANCE_DAILY: ReportDataset = {
  id: 'attendance_daily',
  category: 'attendance',
  label: 'Daily attendance',
  fields: [
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'department', label: 'Department', type: 'text', group: 'Organisation' },
    { id: 'branch', label: 'Branch', type: 'text', group: 'Organisation' },
    { id: 'position', label: 'Position', type: 'text', group: 'Organisation' },
    { id: 'attendanceDate', label: 'Date', type: 'date', group: 'Attendance' },
    { id: 'shift', label: 'Shift', type: 'text', group: 'Attendance' },
    { id: 'clockIn', label: 'Clock In', type: 'text', group: 'Attendance' },
    { id: 'clockOut', label: 'Clock Out', type: 'text', group: 'Attendance' },
    { id: 'workingHours', label: 'Working Hours', type: 'number', group: 'Hours' },
    { id: 'otHours', label: 'OT Hours', type: 'number', group: 'Hours' },
    { id: 'lateMinutes', label: 'Late Minutes', type: 'number', group: 'Hours' },
    { id: 'earlyOutMinutes', label: 'Early Out (min)', type: 'number', group: 'Hours' },
    { id: 'attendanceStatus', label: 'Attendance Status', type: 'status', group: 'Attendance' },
    // Attendance Allowance (ADR-0072) is a MONTHLY qualification, never per-day: the value is the month's
    // qualified allowance total repeated on each of the employee's day rows (amount / "0.00" when in scope
    // but disqualified / blank when no active policy covers the employee). See attendanceDailyReport.
    { id: 'attendanceAllowance', label: 'Attendance Allowance', type: 'currency', group: 'Entitlements' },
    // Replacement Leave = TOIL / leave-in-lieu (ADR-0033): days credited for THIS worked date (at most one
    // accrual per employee+date). Blank = no replacement leave banked for the day.
    { id: 'replacementLeave', label: 'Replacement Leave', type: 'number', group: 'Entitlements' },
    { id: 'clockingLocation', label: 'Clocking Location', type: 'text', group: 'Location' },
    { id: 'geofencingStatus', label: 'Geofencing Status', type: 'status', group: 'Location' },
    { id: 'remarks', label: 'Remarks', type: 'text', group: 'Attendance' },
  ],
  filters: [
    { id: 'month', label: 'Month', kind: 'month' },
    { id: 'name', label: 'Employee Name contains', kind: 'text' },
    { id: 'department', label: 'Department contains', kind: 'text' },
  ],
  defaultColumns: ['employeeCode', 'name', 'department', 'attendanceDate', 'clockIn', 'clockOut', 'workingHours', 'attendanceStatus'],
  run: async (ctx, scopeIds, params) => {
    const month = str(params.month) ?? currentMonth();
    return attendanceDailyReport(ctx, { month, companyIds: scopeIds });
  },
};

// ─────────────────────────────── Leave ───────────────────────────────
const LEAVE_BALANCES: ReportDataset = {
  id: 'leave_balances',
  category: 'leave',
  label: 'Leave balances',
  fields: [
    { id: 'name', label: 'Leave Type', type: 'text', group: 'Leave' },
    { id: 'balance', label: 'Balance (days)', type: 'number', group: 'Leave' },
  ],
  filters: [{ id: 'name', label: 'Leave Type contains', kind: 'text' }],
  defaultColumns: ['name', 'balance'],
  run: async (ctx, scopeIds) => {
    const rows = await leaveBalancesSummary(ctx, scopeIds);
    return rows.map((r) => ({ name: r.name, balance: r.balance }));
  },
};

// ─────────────────────────────── Payroll ───────────────────────────────
/**
 * Payroll Register (feedback 622e12eb) — the reporter's register template as a custom-report dataset: the
 * six field groups they listed (Employee & Organisation Info / Earnings / Total Earnings / Deductions /
 * Total Deductions & Nett Wage / Employer Contributions), one row per processed payslip.
 *
 * Listed AFTER payroll_history, deliberately. The Reports page's "New report" button links `datasets[0]`,
 * so registration order silently decides what the builder opens pre-seeded with. 622e12eb asked for a
 * register to EXIST, not for that button to start doing something else — anyone who clicks it out of habit
 * would land on a different data source than yesterday. The register is one pick away in the builder's
 * data-source list. Move this entry above payroll_history only if the reporter asks for the default itself
 * to change.
 */
const PAYROLL_REGISTER: ReportDataset = {
  id: 'payroll_register',
  category: 'payroll',
  label: 'Payroll register',
  fields: [
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'employeeName', label: 'Employee Name', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'company', label: 'Company', type: 'text', group: 'Employee & Organisation Info' },
    // ADR-0077 slice 6 (D-9) — twenty-one currency columns follow, and this dataset is read across every
    // company in scope. Offered as a field, deliberately NOT in `defaultColumns`, so every saved report
    // keeps its exact column set; `runReportSpec` reads the currency off the ROW either way, so the
    // summary row is protected whether or not the operator ever adds the column.
    { id: 'currency', label: 'Currency', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'department', label: 'Department', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'position', label: 'Position', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'jobGrade', label: 'Job Grade', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'employmentStatus', label: 'Employment Status', type: 'status', group: 'Employee & Organisation Info' },
    { id: 'employmentType', label: 'Employment Type', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'payPeriod', label: 'Payroll Period', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'payrollCycle', label: 'Payroll Cycle', type: 'text', group: 'Employee & Organisation Info' },
    { id: 'runSeq', label: 'Run No.', type: 'number', group: 'Employee & Organisation Info' },
    { id: 'daysWorked', label: 'Days Worked', type: 'number', group: 'Employee & Organisation Info' },

    { id: 'basic', label: 'Basic Salary', type: 'currency', group: 'Earnings' },
    { id: 'allowance', label: 'Allowances', type: 'currency', group: 'Earnings' },
    { id: 'overtime', label: 'Overtime', type: 'currency', group: 'Earnings' },
    { id: 'bonus', label: 'Bonus', type: 'currency', group: 'Earnings' },

    { id: 'gross', label: 'Total Earnings (Gross)', type: 'currency', group: 'Total Earnings' },

    { id: 'epfEmployee', label: 'EPF (Employee)', type: 'currency', group: 'Deductions' },
    { id: 'socsoEmployee', label: 'SOCSO (Employee)', type: 'currency', group: 'Deductions' },
    // SKBBK is the employee's share of the PERKESO housing/foreign-worker scheme — an employee deduction,
    // reported separately from the ordinary SOCSO share because PERKESO remits it as its own line.
    { id: 'socsoSkbbk', label: 'SOCSO SKBBK (Employee)', type: 'currency', group: 'Deductions' },
    { id: 'eisEmployee', label: 'EIS (Employee)', type: 'currency', group: 'Deductions' },
    { id: 'pcb', label: 'PCB (Tax)', type: 'currency', group: 'Deductions' },
    { id: 'cp38', label: 'CP38', type: 'currency', group: 'Deductions' },
    { id: 'zakat', label: 'Zakat', type: 'currency', group: 'Deductions' },
    { id: 'otherDeductions', label: 'Other Deductions', type: 'currency', group: 'Deductions' },

    { id: 'totalDeductions', label: 'Total Deductions', type: 'currency', group: 'Total Deductions & Nett Wage' },
    { id: 'net', label: 'Nett Wage', type: 'currency', group: 'Total Deductions & Nett Wage' },

    { id: 'epfEmployer', label: 'EPF (Employer)', type: 'currency', group: 'Employer Contributions' },
    { id: 'socsoEmployer', label: 'SOCSO (Employer)', type: 'currency', group: 'Employer Contributions' },
    { id: 'eisEmployer', label: 'EIS (Employer)', type: 'currency', group: 'Employer Contributions' },
    { id: 'hrdf', label: 'HRD Corp Levy', type: 'currency', group: 'Employer Contributions' },
    { id: 'employerCost', label: 'Total Employer Cost', type: 'currency', group: 'Employer Contributions' },
  ],
  filters: [
    { id: 'payPeriod', label: 'Payroll Period', kind: 'month' },
    { id: 'payrollCycle', label: 'Payroll Cycle contains', kind: 'text' },
    { id: 'company', label: 'Company contains', kind: 'text' },
    { id: 'department', label: 'Department contains', kind: 'text' },
    { id: 'employmentStatus', label: 'Employment Status contains', kind: 'text' },
    { id: 'jobGrade', label: 'Job Grade contains', kind: 'text' },
    { id: 'employeeName', label: 'Employee Name contains', kind: 'text' },
  ],
  defaultColumns: [
    'employeeCode', 'employeeName', 'department', 'payPeriod',
    'basic', 'allowance', 'overtime', 'gross',
    'epfEmployee', 'socsoEmployee', 'eisEmployee', 'pcb', 'totalDeductions', 'net',
    'epfEmployer', 'socsoEmployer', 'eisEmployer',
  ],
  run: async (ctx, scopeIds, params) => {
    // 'YYYY-MM' from the month filter narrows the read at the DB; anything malformed falls through to
    // "every period" rather than throwing — the same posture cleanRunType takes on the cycle.
    const period = str(params.payPeriod);
    const m = period && /^\d{4}-\d{2}$/.test(period) ? period : null;
    const rows = await listPayrollRegisterAcross(ctx, {
      companyIds: scopeIds,
      year: m ? Number(m.slice(0, 4)) : undefined,
      month: m ? Number(m.slice(5, 7)) : undefined,
      cycle: str(params.payrollCycle) ?? undefined,
    });
    return rows.map((r) => ({
      employeeCode: r.employeeCode,
      employeeName: r.employeeName,
      company: r.company,
      currency: r.currency,
      department: r.department,
      position: r.position,
      jobGrade: r.jobGrade,
      employmentStatus: r.employmentStatus,
      employmentType: r.employmentType,
      payPeriod: r.payPeriod,
      payrollCycle: r.payrollCycle,
      runSeq: r.runSeq,
      daysWorked: numStr(r.daysWorked),
      // 3c473773 — listPayrollRegisterAcross already resolves these four through the payslip's own box
      // stamp, so this mapping stays a straight pass-through.
      basic: numStr(r.basic),
      allowance: numStr(r.allowance),
      overtime: numStr(r.overtime),
      bonus: numStr(r.bonus),
      gross: numStr(r.gross),
      epfEmployee: r.epfEmployee,
      socsoEmployee: r.socsoEmployee,
      socsoSkbbk: r.socsoSkbbk,
      eisEmployee: r.eisEmployee,
      pcb: r.pcb,
      cp38: r.cp38,
      zakat: r.zakat,
      otherDeductions: numStr(r.otherDeductions),
      totalDeductions: numStr(r.totalDeductions),
      net: numStr(r.net),
      epfEmployer: r.epfEmployer,
      socsoEmployer: r.socsoEmployer,
      eisEmployer: r.eisEmployer,
      hrdf: r.hrdf,
      employerCost: numStr(r.employerCost),
    }));
  },
};

const PAYROLL_HISTORY: ReportDataset = {
  id: 'payroll_history',
  category: 'payroll',
  label: 'Processed payroll history',
  fields: [
    { id: 'employeeName', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'company', label: 'Company', type: 'text', group: 'Organisation' },
    // ADR-0077 slice 6 (D-9) — same reason as `payroll_register`: seven money columns, read across every
    // company in scope. Offered as a field, NOT in `defaultColumns`, so saved reports are unchanged.
    { id: 'currency', label: 'Currency', type: 'text', group: 'Organisation' },
    { id: 'payPeriod', label: 'Pay Period', type: 'text', group: 'Period' },
    { id: 'runType', label: 'Run Type', type: 'text', group: 'Period' },
    { id: 'basic', label: 'Basic', type: 'currency', group: 'Earnings' },
    { id: 'allowance', label: 'Allowance', type: 'currency', group: 'Earnings' },
    { id: 'overtime', label: 'Overtime', type: 'currency', group: 'Earnings' },
    { id: 'bonus', label: 'Bonus', type: 'currency', group: 'Earnings' },
    { id: 'gross', label: 'Gross Pay', type: 'currency', group: 'Totals' },
    { id: 'totalDeductions', label: 'Total Deductions', type: 'currency', group: 'Totals' },
    { id: 'net', label: 'Net Pay', type: 'currency', group: 'Totals' },
  ],
  filters: [
    { id: 'year', label: 'Year', kind: 'year' },
    { id: 'employeeName', label: 'Employee Name contains', kind: 'text' },
  ],
  defaultColumns: ['employeeName', 'employeeCode', 'payPeriod', 'gross', 'net'],
  run: async (ctx, scopeIds, params) => {
    const yearRaw = params.year;
    const year = yearRaw == null || yearRaw === '' ? undefined : Number(yearRaw);
    const rows = await listProcessedPayslipsAcross(ctx, {
      companyIds: scopeIds,
      year: Number.isFinite(year) ? year : undefined,
    });
    return rows.map((r) => ({
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
      company: r.company,
      // `?? null` because ProcessedPayslipViewRow.currency is optional (see its note): a ReportRow value
      // may be null but never undefined, and null is the "unknown currency" the runner buckets separately.
      currency: r.currency ?? null,
      payPeriod: r.payPeriod,
      runType: r.runType,
      // 3c473773 — same box stamp as the register above, for the same reason.
      ...(() => {
        const d = payslipDisplayEarnings(r);
        return { basic: numStr(d.basic), allowance: numStr(d.allowance), overtime: numStr(d.overtime), bonus: numStr(d.bonus) };
      })(),
      gross: numStr(r.gross),
      totalDeductions: numStr(r.totalDeductions),
      net: numStr(r.net),
    }));
  },
};

// ─────────────────────────────── Claim ───────────────────────────────
const CLAIM_TYPES: ReportDataset = {
  id: 'claim_types',
  category: 'claim',
  label: 'Claim types & policy',
  fields: [
    { id: 'code', label: 'Code', type: 'text', group: 'Claim type' },
    { id: 'name', label: 'Name', type: 'text', group: 'Claim type' },
    { id: 'description', label: 'Description', type: 'text', group: 'Claim type' },
    { id: 'defaultTaxable', label: 'Taxable', type: 'status', group: 'Policy' },
    { id: 'requiresReceipt', label: 'Requires Receipt', type: 'status', group: 'Policy' },
    { id: 'maxReceiptAgeDays', label: 'Max Receipt Age (days)', type: 'number', group: 'Policy' },
  ],
  filters: [{ id: 'name', label: 'Name contains', kind: 'text' }],
  defaultColumns: ['code', 'name', 'defaultTaxable', 'requiresReceipt'],
  run: async (ctx) => {
    const rows = await listClaimTypes(ctx);
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      description: r.description ?? null,
      defaultTaxable: r.defaultTaxable ? 'Yes' : 'No',
      requiresReceipt: r.requiresReceipt ? 'Yes' : 'No',
      maxReceiptAgeDays: r.maxReceiptAgeDays,
    }));
  },
};

// ─────────────────────────────── Performance ───────────────────────────────
const PERFORMANCE_REVIEWS: ReportDataset = {
  id: 'performance_reviews',
  category: 'performance',
  label: 'Performance reviews',
  fields: [
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'company', label: 'Company', type: 'text', group: 'Organisation' },
    { id: 'department', label: 'Department', type: 'text', group: 'Organisation' },
    { id: 'position', label: 'Position', type: 'text', group: 'Organisation' },
    { id: 'cycleName', label: 'Review Cycle', type: 'text', group: 'Cycle' },
    { id: 'cycleStatus', label: 'Cycle Status', type: 'status', group: 'Cycle' },
    { id: 'periodStart', label: 'Period Start', type: 'date', group: 'Cycle' },
    { id: 'periodEnd', label: 'Period End', type: 'date', group: 'Cycle' },
    { id: 'reviewStatus', label: 'Review Status', type: 'status', group: 'Review' },
    { id: 'reviewer', label: 'Reviewer', type: 'text', group: 'Review' },
    { id: 'selfRating', label: 'Self Rating', type: 'number', group: 'Ratings' },
    { id: 'managerRating', label: 'Manager Rating', type: 'number', group: 'Ratings' },
    { id: 'overallRating', label: 'Overall Rating', type: 'number', group: 'Ratings' },
    { id: 'finalScore', label: 'Final Score', type: 'number', group: 'Ratings' },
    { id: 'abcClass', label: 'ABC Class', type: 'status', group: 'Ratings' },
    { id: 'submittedAt', label: 'Submitted On', type: 'date', group: 'Dates' },
    { id: 'acknowledgedAt', label: 'Acknowledged On', type: 'date', group: 'Dates' },
  ],
  filters: [
    { id: 'name', label: 'Employee Name contains', kind: 'text' },
    { id: 'cycleName', label: 'Review Cycle contains', kind: 'text' },
    { id: 'department', label: 'Department contains', kind: 'text' },
  ],
  defaultColumns: ['employeeCode', 'name', 'cycleName', 'reviewStatus', 'selfRating', 'managerRating', 'overallRating', 'reviewer'],
  run: async (ctx, scopeIds) => performanceReviewReport(ctx, { companyIds: scopeIds }),
};

const PERFORMANCE_GOALS: ReportDataset = {
  id: 'performance_goals',
  category: 'performance',
  label: 'Goals & OKRs',
  fields: [
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'company', label: 'Company', type: 'text', group: 'Organisation' },
    { id: 'department', label: 'Department', type: 'text', group: 'Organisation' },
    { id: 'goalTitle', label: 'Goal Title', type: 'text', group: 'Goal' },
    { id: 'metric', label: 'Metric', type: 'text', group: 'Goal' },
    { id: 'target', label: 'Target', type: 'text', group: 'Goal' },
    { id: 'weight', label: 'Weight', type: 'number', group: 'Goal' },
    { id: 'progress', label: 'Progress (%)', type: 'number', group: 'Progress' },
    { id: 'goalStatus', label: 'Goal Status', type: 'status', group: 'Progress' },
    { id: 'approvalStatus', label: 'Approval Status', type: 'status', group: 'Progress' },
    { id: 'cycleName', label: 'Review Cycle', type: 'text', group: 'Cycle' },
    { id: 'dueOn', label: 'Due On', type: 'date', group: 'Dates' },
    { id: 'updatedAt', label: 'Last Updated', type: 'date', group: 'Dates' },
  ],
  filters: [
    { id: 'name', label: 'Employee Name contains', kind: 'text' },
    { id: 'goalTitle', label: 'Goal Title contains', kind: 'text' },
    { id: 'department', label: 'Department contains', kind: 'text' },
  ],
  defaultColumns: ['employeeCode', 'name', 'goalTitle', 'goalStatus', 'progress', 'dueOn'],
  run: async (ctx, scopeIds) => performanceGoalReport(ctx, { companyIds: scopeIds }),
};

/** The closed dataset registry, keyed by id. */
export const REPORT_DATASETS: Record<string, ReportDataset> = {
  [MASTER.id]: MASTER,
  [ATTENDANCE_OT.id]: ATTENDANCE_OT,
  [ATTENDANCE_DAILY.id]: ATTENDANCE_DAILY,
  [LEAVE_BALANCES.id]: LEAVE_BALANCES,
  [PAYROLL_HISTORY.id]: PAYROLL_HISTORY,
  [PAYROLL_REGISTER.id]: PAYROLL_REGISTER,
  [CLAIM_TYPES.id]: CLAIM_TYPES,
  [PERFORMANCE_REVIEWS.id]: PERFORMANCE_REVIEWS,
  [PERFORMANCE_GOALS.id]: PERFORMANCE_GOALS,
};

/** The six report categories the reporter asked for, in nav order — every category now carries at least
 *  one dataset, so each renders a "New custom report" entry (no more empty states). */
export const REPORT_CATEGORIES: ReportCategory[] = [
  'master',
  'attendance',
  'leave',
  'payroll',
  'claim',
  'performance',
];

export const datasetsForCategory = (c: ReportCategory): ReportDataset[] =>
  Object.values(REPORT_DATASETS).filter((d) => d.category === c);

export const getDataset = (id: string): ReportDataset | undefined => REPORT_DATASETS[id];

/** Default alignment implied by a field type (the AI designer + preview honour this unless overridden). */
export const defaultAlign = (type: ReportFieldType): 'left' | 'center' | 'right' =>
  type === 'number' || type === 'currency' ? 'right' : type === 'date' || type === 'status' ? 'center' : 'left';

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * The single shared validator. Rejects any spec that names an unknown dataset, an unknown/duplicate
 * column, an unknown filter, a sort/group field outside the dataset, or an empty column set. Used by the
 * UI (before save), the runner (before read) AND the AI designer (on the model's output) — identical
 * contract for a hand-built and an AI-drafted spec.
 */
export function validateReportSpec(spec: unknown): ValidateResult {
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'not-an-object' };
  const s = spec as Partial<CustomReportSpec>;
  const ds = s.datasetId ? REPORT_DATASETS[s.datasetId] : undefined;
  if (!ds) return { ok: false, reason: 'unknown-dataset' };
  const fieldIds = new Set(ds.fields.map((f) => f.id));
  if (!Array.isArray(s.columns) || s.columns.length === 0) return { ok: false, reason: 'no-columns' };
  const seen = new Set<string>();
  for (const c of s.columns) {
    if (typeof c !== 'string' || !fieldIds.has(c)) return { ok: false, reason: `unknown-column:${c}` };
    if (seen.has(c)) return { ok: false, reason: `duplicate-column:${c}` };
    seen.add(c);
  }
  const filterIds = new Set(ds.filters.map((f) => f.id));
  if (s.filters) {
    if (typeof s.filters !== 'object') return { ok: false, reason: 'bad-filters' };
    for (const k of Object.keys(s.filters)) {
      if (!filterIds.has(k)) return { ok: false, reason: `unknown-filter:${k}` };
    }
  }
  if (s.sort) {
    if (typeof s.sort !== 'object' || !fieldIds.has(s.sort.field)) return { ok: false, reason: 'bad-sort' };
    if (s.sort.dir !== 'asc' && s.sort.dir !== 'desc') return { ok: false, reason: 'bad-sort-dir' };
  }
  if (s.groupBy != null && !fieldIds.has(s.groupBy)) return { ok: false, reason: 'bad-group' };
  const L = s.layout;
  if (L) {
    if (L.summary) for (const f of L.summary) if (!fieldIds.has(f)) return { ok: false, reason: `bad-summary:${f}` };
    if (L.averages) for (const f of L.averages) if (!fieldIds.has(f)) return { ok: false, reason: `bad-average:${f}` };
    if (L.freeze) for (const f of L.freeze) if (!fieldIds.has(f)) return { ok: false, reason: `bad-freeze:${f}` };
    if (L.align) for (const k of Object.keys(L.align)) if (!fieldIds.has(k)) return { ok: false, reason: `bad-align:${k}` };
    if (L.widths) for (const k of Object.keys(L.widths)) if (!fieldIds.has(k)) return { ok: false, reason: `bad-width:${k}` };
    if (L.pageBreakOn != null && !fieldIds.has(L.pageBreakOn)) return { ok: false, reason: 'bad-page-break' };
  }
  return { ok: true };
}

/**
 * Pure check for the per-report role→verb grid (the reporter's 7-verb permission model:
 * View / Create / Edit / Delete / Export / Share / Manage Templates).
 *   • Empty/absent grid ⇒ allowed (the coarse admin route-guard is the only gate — today's default).
 *   • super_admin is the always-allowed superrole.
 *   • Otherwise the acting session must hold ≥1 role granted ≥1 of the requested verbs.
 * Shared by every service mutation/read in core/custom-reports.ts — kept here (pure module) so it is
 * unit-testable without a DB.
 */
export function reportVerbAllowed(
  permissions: Record<string, string[]> | null | undefined,
  roles: readonly string[],
  verbs: readonly string[],
): boolean {
  if (!permissions || Object.keys(permissions).length === 0) return true;
  const held = new Set(roles);
  if (held.has('super_admin')) return true;
  return Object.entries(permissions).some(
    ([role, granted]) => held.has(role) && verbs.some((v) => granted.includes(v)),
  );
}

/**
 * Which MODULE each report category belongs to — `null` for the categories that are core (`master` is the
 * employee master data, `leave` is a core module in packs/catalog.ts and can never be switched off).
 *
 * Deliberately a literal map rather than a string cast of the category: `claim` (the category) and
 * `claims` (the module code) are not the same word, and a silent mismatch would make the gate vacuous.
 * `test/module-gate.test.ts` pins every value against MODULE_CATALOG.
 */
export const REPORT_CATEGORY_MODULE: Record<ReportCategory, string | null> = {
  master: null,
  leave: null,
  attendance: 'attendance',
  payroll: 'payroll',
  claim: 'claims',
  performance: 'performance',
};

/** Refuse a report run for a module this tenant does not have. No-op for a core category. */
export function assertReportCategoryEnabled(ctx: SessionContext, category: ReportCategory): void {
  const code = REPORT_CATEGORY_MODULE[category];
  if (code != null) assertModuleGate(ctx, code);
}

const contains = (v: string | number | null, needle: string): boolean =>
  v != null && String(v).toLowerCase().includes(needle.toLowerCase());

/**
 * Run a validated spec end-to-end: perform the dataset read (already scoped), apply field-level text
 * filters, sort, optional group ordering, project the chosen columns (English headers), and append an
 * optional numeric summary row. Returns the neutral ReportData for lib/report-export. PURE READ.
 */
export async function runReportSpec(
  ctx: SessionContext,
  scopeIds: string[],
  spec: CustomReportSpec,
): Promise<ReportData> {
  const ds = REPORT_DATASETS[spec.datasetId];
  if (!ds) throw new Error('unknown-dataset');
  // r292 — THE REPORT AXIS IS ITS OWN DOOR INTO A PACK'S DATA, and it does not pass through the pack's
  // screens: a saved spec is run from /reports, /reports/export and the AI designer. `ds.category` already
  // names which module the dataset belongs to, so ONE gate here covers every present and future dataset in
  // the four optional packs. Most dataset `run` bodies read schema tables directly rather than through the
  // pack's service file, so the service binding alone would NOT have covered them — this is the second
  // chokepoint, not a duplicate of the first.
  assertReportCategoryEnabled(ctx, ds.category);
  const byId = new Map(ds.fields.map((f) => [f.id, f]));
  let rows = await ds.run(ctx, scopeIds, spec.filters ?? {});

  // Field-level text filters (a filter id that is ALSO a field id ⇒ contains match on projected value).
  const fieldIds = new Set(ds.fields.map((f) => f.id));
  for (const [k, val] of Object.entries(spec.filters ?? {})) {
    if (val == null || val === '') continue;
    if (fieldIds.has(k)) rows = rows.filter((r) => contains(r[k] ?? null, String(val)));
  }

  // Sort (numeric-aware).
  if (spec.sort) {
    const { field, dir } = spec.sort;
    const mul = dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * mul;
      return String(av).localeCompare(String(bv)) * mul;
    });
  }

  // Group ordering: stable-sort by the group field (or the page-break field) so grouped rows sit together
  // — the ordering the tabular/print formats honour (PDF pages break on contiguous groups).
  const orderField = spec.groupBy ?? spec.layout?.pageBreakOn ?? null;
  if (orderField && byId.has(orderField)) {
    rows = [...rows].sort((a, b) => String(a[orderField] ?? '').localeCompare(String(b[orderField] ?? '')));
  }

  const L = spec.layout ?? undefined;
  // Apply per-type value formatting (date / number formats) BEFORE projecting, so headers stay stable and
  // the alignment metadata (built below) still matches the numeric/text nature of each column.
  const fmt = (fieldType: ReportFieldType, v: string | number | null): string | number | null => {
    if (v == null || v === '') return v;
    if (fieldType === 'date') return formatDate(String(v), L?.dateFormat ?? 'iso');
    if ((fieldType === 'number' || fieldType === 'currency') && (L?.numberFormat ?? 'plain') === 'grouped') {
      const n = Number(v);
      if (!Number.isNaN(n)) return groupNumber(n);
    }
    return v;
  };

  const columns = spec.columns.map((c) => byId.get(c)?.label ?? c);
  const body = rows.map((r) =>
    spec.columns.map((c) => {
      const f = byId.get(c);
      return f ? fmt(f.type, r[c] ?? null) : (r[c] ?? null);
    }),
  );

  // Summary (totals) + averages rows over the requested numeric/currency columns. Grouped-number format is
  // applied to the aggregate too so the summary line matches the body cells.
  const summarySet = new Set(L?.summary ?? []);
  const avgSet = new Set(L?.averages ?? []);
  const aggOver = (setIds: Set<string>, label: string, avg: boolean, over: ReportRow[]) => {
    const row: (string | number | null)[] = spec.columns.map((c) => {
      const f = byId.get(c);
      if (setIds.has(c) && f && (f.type === 'number' || f.type === 'currency')) {
        const nums = over.map((r) => Number(r[c])).filter((n) => !Number.isNaN(n));
        const total = nums.reduce((a, b) => a + b, 0);
        const val = avg && nums.length ? total / nums.length : total;
        const rounded = Math.round((val + Number.EPSILON) * 100) / 100;
        return (L?.numberFormat ?? 'plain') === 'grouped' ? groupNumber(rounded) : rounded;
      }
      return null;
    });
    const labelIdx = spec.columns.findIndex((c) => !setIds.has(c));
    if (labelIdx >= 0) row[labelIdx] = label;
    return row;
  };

  /**
   * ADR-0077 slice 6 (D-9) — THE SUMMARY ROW IS THE ONE PLACE THIS RUNNER DOES ARITHMETIC, and every
   * dataset here is read with `companyIds: scopeIds`, i.e. across every company the operator can see.
   * A `Total` over a currency column therefore ADDED ringgit to whatever else was in scope and printed
   * one number — the exact fault lib/money.ts exists to make unrepresentable, arriving through the
   * report builder rather than a hand-written screen.
   *
   * The precedent is `app/payroll/transaction-view/outstanding-table.tsx`: take the single-total path
   * ONLY when there is one currency, and emit per-currency subtotals otherwise. No grand total is
   * invented across the buckets, because there is no number to give.
   *
   * The currency is read off the ROW, not off the chosen columns: `ds.run()` returns every projected
   * field, so a dataset that carries `currency` is protected whether or not the operator picked that
   * column. A dataset that carries none puts every row in one bucket and takes the single-total path —
   * byte-identical to before, which is what keeps this additive for the eight datasets without one.
   *
   * THE MIX IS JUDGED OVER CONTRIBUTING ROWS ONLY, and that detail is load-bearing. `master` is the one
   * dataset whose `currency` is NOT the company's — it is `compensation.currency`, which is NULLABLE, so
   * an employee with no compensation row carries no currency. Judging the mix over EVERY row put those
   * employees in their own unlabelled bucket and split the Average on the present all-Malaysian tenant:
   * a figure moving today, on the box, for a change whose whole promise is that nothing moves until a
   * second country arrives. A row that contributes no value to any summed money column cannot make the
   * money mixed, so it is excluded from the question.
   *
   * LATENT TODAY: production is nine Malaysian companies in one tenant, so every bucket is MYR and this
   * changes nothing on the box. It is the second country that makes the old row wrong.
   */
  const currencyOf = (r: ReportRow): string | null => {
    const v = r['currency'];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const hasValue = (r: ReportRow, colId: string): boolean => {
    const v = r[colId];
    return v !== null && v !== undefined && v !== '';
  };
  const aggFor = (setIds: Set<string>, label: string) => {
    const avg = label === 'Average';
    const moneyCols = [...setIds].filter((c) => byId.get(c)?.type === 'currency');
    const touchesMoney = moneyCols.length > 0;
    // Only rows that actually put a figure into one of THESE money columns get a say in whether the
    // money is mixed — see the note above on `master`'s nullable compensation currency.
    const contributing = touchesMoney ? rows.filter((r) => moneyCols.some((c) => hasValue(r, c))) : [];
    const currencyKeys = contributing.map((r) => ({ currency: currencyOf(r) }));
    if (!touchesMoney || !isMixedCurrency(currencyKeys)) {
      body.push(aggOver(setIds, label, avg, rows));
      return;
    }
    const byCurrency = new Map<string, ReportRow[]>();
    for (const r of rows) {
      const k = currencyOf(r) ?? '';
      const bucket = byCurrency.get(k);
      if (bucket) bucket.push(r);
      else byCurrency.set(k, [r]);
    }
    // Stable currency order, matching lib/money.totalsByCurrency. The unlabelled bucket is its own row
    // and says so — folding it into a neighbour is precisely how a foreign figure disappears into a
    // ringgit total.
    for (const [k, sub] of [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      body.push(aggOver(setIds, `${label} (${k || 'unlabelled'})`, avg, sub));
    }
  };
  if (summarySet.size > 0) aggFor(summarySet, 'Total');
  if (avgSet.size > 0) aggFor(avgSet, 'Average');

  // Presentation layout for the serializers: per-column alignment (explicit override ⇒ field-type default),
  // relative widths, frozen leading-column count, plus the header/footer/branding properties.
  const align = spec.columns.map((c) => L?.align?.[c] ?? defaultAlign(byId.get(c)?.type ?? 'text'));
  const hasWidths = L?.widths && spec.columns.some((c) => L.widths?.[c] != null);
  const widths = hasWidths ? spec.columns.map((c) => L?.widths?.[c] ?? 1) : undefined;
  const freezeSet = new Set(L?.freeze ?? []);
  let freeze = 0;
  for (const c of spec.columns) {
    if (freezeSet.has(c)) freeze++;
    else break;
  }

  const title = L?.title || ds.label;
  return {
    title,
    filename: `${ds.id}_${todayInKualaLumpur()}`,
    columns,
    rows: body,
    layout: {
      subtitle: L?.subtitle ?? null,
      description: L?.description ?? null,
      header: L?.header ?? null,
      footer: L?.footer ?? null,
      watermark: L?.watermark ?? null,
      companyLogo: L?.companyLogo ?? null,
      orientation: L?.orientation ?? 'landscape',
      paperSize: L?.paperSize ?? 'A4',
      margins: L?.margins ?? 'normal',
      align,
      widths,
      freeze: freeze > 0 ? freeze : undefined,
    },
  };
}

/** Format an ISO-ish date string per the report's chosen display format. Non-date input passes through. */
function formatDate(v: string, f: NonNullable<CustomReportSpec['layout']>['dateFormat']): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  const [, y, mo, d] = m;
  if (f === 'dmy') return `${d}/${mo}/${y}`;
  if (f === 'mdy') return `${mo}/${d}/${y}`;
  if (f === 'long') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(d)} ${months[Number(mo) - 1] ?? mo} ${y}`;
  }
  return `${y}-${mo}-${d}`; // iso
}

/** Thousands-separated fixed-2 formatting for grouped number format (e.g. 12345.6 → "12,345.60"). */
function groupNumber(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
}
