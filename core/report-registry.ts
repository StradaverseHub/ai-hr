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
import { overtimeReport } from './reporting';
import { listProcessedPayslipsAcross } from './payroll-view';
import { listClaimTypes } from './claims';

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
      eligible: r.eligible ? 'Eligible' : 'Not eligible',
      otApprovalStatus: r.otApprovalStatus,
    }));
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
const PAYROLL_HISTORY: ReportDataset = {
  id: 'payroll_history',
  category: 'payroll',
  label: 'Processed payroll history',
  fields: [
    { id: 'employeeName', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'employeeCode', label: 'Employee ID', type: 'text', group: 'Identity' },
    { id: 'company', label: 'Company', type: 'text', group: 'Organisation' },
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
      payPeriod: r.payPeriod,
      runType: r.runType,
      basic: numStr(r.basic),
      allowance: numStr(r.allowance),
      overtime: numStr(r.overtime),
      bonus: numStr(r.bonus),
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

/** The closed dataset registry, keyed by id. */
export const REPORT_DATASETS: Record<string, ReportDataset> = {
  [MASTER.id]: MASTER,
  [ATTENDANCE_OT.id]: ATTENDANCE_OT,
  [LEAVE_BALANCES.id]: LEAVE_BALANCES,
  [PAYROLL_HISTORY.id]: PAYROLL_HISTORY,
  [CLAIM_TYPES.id]: CLAIM_TYPES,
};

/** The six report categories the reporter asked for, in nav order. Performance has no dataset yet
 *  (no tabular performance read exists) — it renders an honest empty state rather than a fake dataset. */
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
  if (s.layout?.summary) {
    for (const f of s.layout.summary) if (!fieldIds.has(f)) return { ok: false, reason: `bad-summary:${f}` };
  }
  return { ok: true };
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

  // Group ordering: stable-sort by the group field so grouped rows sit together (no sub-headers in the
  // flat export; the ordering is the grouping the tabular formats can honour).
  if (spec.groupBy && byId.has(spec.groupBy)) {
    const g = spec.groupBy;
    rows = [...rows].sort((a, b) => String(a[g] ?? '').localeCompare(String(b[g] ?? '')));
  }

  const columns = spec.columns.map((c) => byId.get(c)?.label ?? c);
  const body = rows.map((r) => spec.columns.map((c) => r[c] ?? null));

  // Optional summary row: total the requested numeric/currency columns; blank elsewhere; a "Total" label
  // in the first non-summarised text column when possible.
  const summarySet = new Set(spec.layout?.summary ?? []);
  if (summarySet.size > 0) {
    const summaryRow: (string | number | null)[] = spec.columns.map((c) => {
      const f = byId.get(c);
      if (summarySet.has(c) && f && (f.type === 'number' || f.type === 'currency')) {
        const total = rows.reduce((acc, r) => acc + (Number(r[c]) || 0), 0);
        return Math.round((total + Number.EPSILON) * 100) / 100;
      }
      return null;
    });
    const labelIdx = spec.columns.findIndex((c) => !summarySet.has(c));
    if (labelIdx >= 0) summaryRow[labelIdx] = 'Total';
    body.push(summaryRow);
  }

  const title = spec.layout?.title || ds.label;
  return {
    title,
    filename: `${ds.id}_${new Date().toISOString().slice(0, 10)}`,
    columns,
    rows: body,
  };
}
