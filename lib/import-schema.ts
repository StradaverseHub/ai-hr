/** Client-safe shape of the employee importer — the column list and result types, with no
 *  server (DB) imports, so both the server service (core/import) and the client UI can use them. */

export type ImportRecord = Record<string, string>;

export type RowResult = {
  rowNum: number; // 1-based data row (header excluded)
  fullName: string;
  email: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Resolved company for THIS row (d8471481) — the `company` cell when supplied, otherwise the
   *  screen's target company. Shown in the preview so a multi-company file is auditable before
   *  anything is written. Empty when the cell named a company that could not be resolved. */
  company: string;
};

export type ImportPreview = {
  companyId: string;
  total: number;
  validCount: number;
  rows: RowResult[];
  missingColumns: string[];
};

export type ImportResult = {
  companyId: string;
  imported: number;
  failed: { rowNum: number; email: string; message: string }[];
  skipped: number;
  /** cf43c909 — the history row this run wrote, so the screen can link straight to it. Null when the
   *  history write itself failed: recording a run must never fail an import that already happened. */
  runId?: string | null;
};

/** cf43c909 — one rejected row, as stored on an import run and as re-exported to the error report.
 *  IDENTITY + REASON only: never the row's IC, bank account, statutory numbers or salary. */
export type ImportRunError = {
  rowNum: number;
  fullName: string;
  email: string;
  errors: string[];
};

/** cf43c909 — one past import, for the Import History list. `outcome` is DERIVED from the counts
 *  (see `importRunOutcome`), never stored, so no status can disagree with the numbers beside it. */
export type ImportRunRow = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  /** Display name of whoever ran it; null when the actor had no person row (operator / support login). */
  actorName: string | null;
  /** '' when the CSV was pasted rather than uploaded. */
  fileName: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  errors: ImportRunError[];
  /** More rows failed than `errors` holds — the list is a sample, not the whole story. */
  errorsTruncated: boolean;
  /** ISO timestamp; formatted in the browser's locale by the client island. */
  createdAt: string;
};

/**
 * "Did it succeed?" — derived, in ONE place, so the list, the badge and any future report agree.
 *   succeeded — every row in the file became an employee.
 *   partial   — some did, some did not.
 *   failed    — none did (an all-rejected file, or an empty one).
 */
export function importRunOutcome(r: {
  importedRows: number;
  failedRows: number;
}): 'succeeded' | 'partial' | 'failed' {
  if (r.importedRows === 0) return 'failed';
  return r.failedRows === 0 ? 'succeeded' : 'partial';
}

/** Columns the importer recognises. Required ones must be present and non-empty per row.
 *  employee_code is OPTIONAL (38668d9b gives HR the ABILITY to key in an Employee ID, not an
 *  obligation): when the column is absent or a cell is blank, hireEmployee auto-generates the
 *  next code; when supplied it is validated (format + file/tenant uniqueness). */
export const IMPORT_COLUMNS = {
  required: ['full_name', 'email', 'department', 'hired_on', 'ic_number', 'basic_salary'],
  optional: [
    // d8471481 — ONE FILE, MANY COMPANIES. Blank (or the column absent) keeps the old behaviour
    // exactly: the row lands in the company selected on screen. When supplied it is matched against
    // the tenant's companies by legal name, company label or registration number, and every catalog
    // lookup for that row (department / position / cost centre) is done against THAT company — which
    // is what makes "Department does not belong to this company" a real check rather than a hope.
    'company',
    'employee_code',
    'phone',
    'position',
    'cost_center',
    'employment_type',
    'monthly_allowance',
    'bank_name',
    'bank_account_no',
    'epf_number',
    'socso_number',
    'tax_number',
    'tax_category',
    'num_children',
    'eis_eligible',
    'is_resident',
    'epf_citizenship',
    // ADR-0078 (642ecc55) — employee-specific salary structure. All optional: blank = monthly / monthly /
    // no rate (the setCompensation defaults). pay_mode daily|hourly REQUIRES a positive rate_amount.
    'pay_mode',
    'payment_term',
    'rate_amount',
  ],
} as const;
