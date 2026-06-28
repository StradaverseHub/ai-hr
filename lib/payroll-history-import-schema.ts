/**
 * 1.2.5 Import Payroll History — client-safe column contract + row/result shapes.
 *
 * Sibling to lib/import-schema.ts: NO DB imports, so both the server service
 * (core/payroll-history-import.ts) and the client UI can share these.
 *
 * The importer ingests PRE-COMPUTED historical payroll — one row per employee per past period
 * (gross, EPF/SOCSO/EIS/PCB, net) — for data migration. Figures are taken verbatim from the file
 * (the prior system's computed amounts); the MY calculators are NOT re-run. See the service-file
 * header for the full design (empty-month rule, run_type='adjustment', draft→insert→count→close).
 */

export type PayrollHistoryRecord = Record<string, string>;

/** Per-row validation result. Identity = (email, period) — distinct from the employee importer. */
export type HistoryRowResult = {
  rowNum: number; // 1-based data row (header excluded)
  email: string;
  period: string; // 'YYYY-MM' (as supplied; may be invalid)
  ok: boolean;
  /** A period-level skip (the period already has a batch) — not an error, not imported. */
  skipped: boolean;
  errors: string[];
  warnings: string[];
};

/** Dry-run preview. Reuses the employee importer's envelope shape, parameterised on the row type. */
export type HistoryImportPreview = {
  companyId: string;
  total: number;
  validCount: number;
  skippedCount: number;
  rows: HistoryRowResult[];
  missingColumns: string[];
};

/** Commit outcome — success / failed / skipped counts for the file (per the feedback's contract). */
export type HistoryImportResult = {
  companyId: string;
  imported: number;
  failed: { rowNum: number; email: string; period: string; message: string }[];
  skipped: number;
};

/**
 * Columns the payroll-history importer recognises.
 *
 * Required = everything year-end actually reads as a scalar (EA breaks gross into basic vs
 * allowance/overtime/bonus, and the monthly returns read the statutory amounts), so a migration
 * can't silently land a wrong EA line-item breakdown even when the gross matches.
 *
 * Optional money columns default to 0 when omitted (the keys are still always written to the
 * payslip / statutory blob so the readers find them).
 */
export const PAYROLL_HISTORY_COLUMNS = {
  required: [
    'email',
    'period', // YYYY-MM
    'basic_salary',
    'gross_pay',
    'epf_employee',
    'epf_employer',
    'socso_employee',
    'socso_employer',
    'eis_employee',
    'eis_employer',
    'pcb',
    'net_pay',
  ],
  optional: [
    'employee_code', // secondary disambiguator only — resolution is by email
    'allowance',
    'overtime_pay',
    'bonus',
    'socso_skbbk',
    'lp', // TP1 / approved-deductions relief that accrues to the EA relief lines
    'zakat', // zakat-via-salary that accrues to the EA Part D
    'cp38', // 1.2.3 CP38 — the LHDN/court instalment, DISTINCT from MTD; summed into the CP39 e-Data file
    'cp38_ref', // LHDN reference for the CP38 instalment (free-text; not a money column)
    'other_deductions',
    'employer_cost',
    'total_deductions',
  ],
} as const;
