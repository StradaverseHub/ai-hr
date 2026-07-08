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
};

/** Columns the importer recognises. Required ones must be present and non-empty per row.
 *  employee_code is OPTIONAL (38668d9b gives HR the ABILITY to key in an Employee ID, not an
 *  obligation): when the column is absent or a cell is blank, hireEmployee auto-generates the
 *  next code; when supplied it is validated (format + file/tenant uniqueness). */
export const IMPORT_COLUMNS = {
  required: ['full_name', 'email', 'department', 'hired_on', 'ic_number', 'basic_salary'],
  optional: [
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
  ],
} as const;
