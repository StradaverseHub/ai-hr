/**
 * Import Payroll History (4157a498) — client-safe column contract, code vocabulary and result shapes.
 *
 * Sibling to lib/import-schema.ts: NO DB imports, so the server service (core/payroll-history-import.ts),
 * the screen and the .xlsx template builder all share one definition.
 *
 * THE CONTRACT IS NOW LONG, NOT WIDE. Until r185 this importer took one very wide row per employee per
 * month (24 columns: basic_salary, gross_pay, epf_employee, …). The reporter's own template is seven
 * columns with ONE LINE PER FIGURE — Employee No, Payroll Period, Payroll Cycle, DOE Code, Company Code,
 * Amount, Override? — and an employee-month is however many lines it takes. The wide contract is retired:
 * production has never run this importer (22 payroll batches, all run_type=regular/status=processed, zero
 * adjustment batches, verified 2026-08-11), so nothing in the field depends on it.
 *
 * HEADINGS ARE THE REPORTER'S, VERBATIM AND IN THEIR ORDER — "Do not change the Excel column names or
 * column sequence." They round-trip: parseCsvRecords lowercases a header and underscores its spaces, so
 * "Employee No" becomes exactly the contract key `employee_no` and "Override?" becomes `override?`
 * (question mark and all — that is not a typo, it is what their heading normalises to). The round-trip is
 * asserted in test/payroll-history-import-template.test.ts rather than trusted.
 *
 * FIGURES ARE NEVER RECOMPUTED. The importer adds the file's own lines to reach the month's gross and net
 * and stores those. It does not apply Malaysian statutory tables to a loaded month — a migration's numbers
 * are whatever the prior system actually paid. See the service header for the rest of the design.
 */

export type PayrollHistoryRecord = Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The seven-column contract
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Contract keys, in the reporter's column order. These ARE the normalised forms of their headings. */
export const PAYROLL_HISTORY_COLUMNS = {
  required: ['employee_no', 'payroll_period', 'payroll_cycle', 'doe_code', 'company_code', 'amount'],
  /** Override? is optional in the FILE (it defaults to 1) but must be 1 or 0 when present. */
  optional: ['override?'],
} as const;

/** The reporter's headings, verbatim and in their order. Never reorder or rename these. */
export const PAYROLL_HISTORY_HEADERS: readonly string[] = [
  'Employee No',
  'Payroll Period',
  'Payroll Cycle',
  'DOE Code',
  'Company Code',
  'Amount',
  'Override?',
];

/**
 * Accepted spellings for each contract key, as they arrive from parseCsvRecords (lowercased, spaces
 * underscored). The canonical key is listed first and is what the template emits; the rest exist because
 * a customer's own export will not have read the spec. An unrecognised extra column is ignored, not an
 * error — but a MISSING required column is reported before any row is looked at.
 */
export const PAYROLL_HISTORY_HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  employee_no: ['employee_no', 'employee_code', 'employee_number', 'employee', 'emp_no', 'staff_id', 'staff_no'],
  payroll_period: ['payroll_period', 'period', 'pay_period', 'payroll_month'],
  payroll_cycle: ['payroll_cycle', 'cycle', 'pay_cycle'],
  doe_code: ['doe_code', 'doe', 'code', 'pay_code', 'component_code'],
  company_code: ['company_code', 'company', 'company_label', 'co_code'],
  amount: ['amount', 'value'],
  'override?': ['override?', 'override', 'overwrite?', 'overwrite'],
};

/**
 * The reporter's own worked example — A1001 / 202501 / ME / BASIC / ABCDE / 5000.00 / 1 — COMPLETED into
 * a month that would actually pass validation.
 *
 * Their sample shows BASIC and EEEPF only. A month with earnings but no contribution or tax lines at all
 * is stopped rather than guessed at, so the sample carries every figure: the employee's EPF, SOCSO, EIS
 * and tax, and the employer's EPF, SOCSO, EIS and training levy. The zero-value lines are the point —
 * "this really was zero" is a statement the file has to make, and 0.00 is accepted.
 *
 * Shared by the CSV template (lib/import-template.ts) and the .xlsx Sample sheet so the two cannot drift.
 * Figures are illustrative; the amounts are the reporter's 5,000 basic with plausible MY statutory rates.
 */
export const PAYROLL_HISTORY_SAMPLE_ROWS: readonly (readonly string[])[] = [
  ['A1001', '202501', 'ME', 'BASIC', 'ABCDE', '5000.00', '1'],
  ['A1001', '202501', 'ME', 'ALLOWANCE', 'ABCDE', '300.00', '1'],
  ['A1001', '202501', 'ME', 'EEEPF', 'ABCDE', '583.00', '1'],
  ['A1001', '202501', 'ME', 'EESOCSO', 'ABCDE', '24.75', '1'],
  ['A1001', '202501', 'ME', 'EEEIS', 'ABCDE', '9.90', '1'],
  ['A1001', '202501', 'ME', 'PCB', 'ABCDE', '150.00', '1'],
  ['A1001', '202501', 'ME', 'EREPF', 'ABCDE', '689.00', '1'],
  ['A1001', '202501', 'ME', 'ERSOCSO', 'ABCDE', '86.65', '1'],
  ['A1001', '202501', 'ME', 'EREIS', 'ABCDE', '9.90', '1'],
  ['A1001', '202501', 'ME', 'HRDF', 'ABCDE', '53.00', '1'],
];

/** Pull one contract field out of a parsed record, honouring the alias list. Trimmed; '' when absent. */
export function readHistoryField(rec: PayrollHistoryRecord, key: string): string {
  for (const alias of PAYROLL_HISTORY_HEADER_ALIASES[key] ?? [key]) {
    const v = rec[alias];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Which required columns are absent from the uploaded header row (checked once, before the rows). */
export function missingHistoryColumns(headerKeys: readonly string[]): string[] {
  const present = new Set(headerKeys);
  return PAYROLL_HISTORY_COLUMNS.required.filter(
    (key) => !(PAYROLL_HISTORY_HEADER_ALIASES[key] ?? [key]).some((a) => present.has(a)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The code vocabulary — where each DOE code's money lands
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every place a line's amount can land on the folded employee-month.
 *
 * The first five are payslip SCALARS — the columns the EA form's Part B itemisation reads (basic,
 * allowance, overtime, bonus) plus the catch-all deduction. The rest are keys of the statutory blob the
 * monthly EPF/SOCSO/EIS/CP39 returns read. `gross` and `net` are not destinations at all: they are
 * cross-check lines, compared against the sum of the others and rejected on disagreement.
 *
 * Kept in lockstep with payroll_import_code_destination_ck (migration 0427).
 */
export const PAYROLL_IMPORT_DESTINATIONS = [
  'basic',
  'allowance',
  'overtime',
  'bonus',
  'other_deduction',
  'epf_employee',
  'epf_employer',
  'socso_employee',
  'socso_employer',
  'socso_skbbk',
  'eis_employee',
  'eis_employer',
  'pcb',
  'cp38',
  'zakat',
  'lp',
  'hrdf',
  'gross',
  'net',
] as const;
export type PayrollImportDestination = (typeof PAYROLL_IMPORT_DESTINATIONS)[number];

/** Which way the money moves. `check` lines are compared, never added. */
export const PAYROLL_IMPORT_DIRECTIONS = ['earning', 'deduction', 'employer', 'check'] as const;
export type PayrollImportDirection = (typeof PAYROLL_IMPORT_DIRECTIONS)[number];

/**
 * The destinations that make a month STATUTORILY COMPLETE. An employee-month carrying earning lines but
 * not one of these is an error ("Incomplete month"), because a month missing one of its deductions would
 * quietly understate that person's year-end statement and their monthly return. An explicit 0.00 line
 * satisfies it — the point is that somebody stated the figure, not that it is non-zero.
 */
export const STATUTORY_DESTINATIONS: ReadonlySet<string> = new Set<PayrollImportDestination>([
  'epf_employee',
  'epf_employer',
  'socso_employee',
  'socso_employer',
  'socso_skbbk',
  'eis_employee',
  'eis_employer',
  'pcb',
  'cp38',
  'zakat',
  'lp',
  'hrdf',
]);

export type ImportCodeEntry = {
  code: string;
  label: string;
  destination: PayrollImportDestination;
  direction: PayrollImportDirection;
  /** Where the resolver found it — surfaced on the template's Codes sheet so HR can see the provenance. */
  source: 'statutory' | 'component' | 'catalog' | 'alias';
};

/**
 * The statutory vocabulary, built in rather than seeded, so EVERY tenant can import — including one
 * provisioned after migration 0427, which has no payroll_import_code rows at all. 0427 seeds the same set
 * for existing tenants so an admin can see and rename them; the catalog is an override layer on top of
 * this floor, never a prerequisite.
 *
 * The names follow the reporter's own EEEPF example (EE = employee side, ER = employer side).
 */
export const STATUTORY_IMPORT_CODES: readonly ImportCodeEntry[] = [
  { code: 'EEEPF', label: 'Employee EPF', destination: 'epf_employee', direction: 'deduction', source: 'statutory' },
  { code: 'EESOCSO', label: 'Employee SOCSO', destination: 'socso_employee', direction: 'deduction', source: 'statutory' },
  { code: 'EEEIS', label: 'Employee EIS', destination: 'eis_employee', direction: 'deduction', source: 'statutory' },
  { code: 'PCB', label: 'Monthly tax deduction (MTD)', destination: 'pcb', direction: 'deduction', source: 'statutory' },
  { code: 'CP38', label: 'CP38 instalment', destination: 'cp38', direction: 'deduction', source: 'statutory' },
  { code: 'ZAKAT', label: 'Zakat via salary', destination: 'zakat', direction: 'deduction', source: 'statutory' },
  { code: 'EREPF', label: 'Employer EPF', destination: 'epf_employer', direction: 'employer', source: 'statutory' },
  { code: 'ERSOCSO', label: 'Employer SOCSO', destination: 'socso_employer', direction: 'employer', source: 'statutory' },
  { code: 'EREIS', label: 'Employer EIS', destination: 'eis_employer', direction: 'employer', source: 'statutory' },
  { code: 'HRDF', label: 'HRD levy', destination: 'hrdf', direction: 'employer', source: 'statutory' },
  // Beyond the ten the plan names, but already stored on every payslip and read by the EA form — so a
  // migration that has them would otherwise have nowhere to put them.
  { code: 'EESOCSOSKBBK', label: 'Employee SOCSO (SKBBK)', destination: 'socso_skbbk', direction: 'deduction', source: 'statutory' },
  { code: 'LP', label: 'Approved deduction / TP1 (LP)', destination: 'lp', direction: 'deduction', source: 'statutory' },
  // Cross-check lines: if the file states the month's gross or net, it must agree with its own lines.
  { code: 'GROSS', label: 'Gross pay (cross-check only)', destination: 'gross', direction: 'check', source: 'statutory' },
  { code: 'NETPAY', label: 'Net pay (cross-check only)', destination: 'net', direction: 'check', source: 'statutory' },
];

/**
 * Map a pay_component row onto an import destination, so the codes an admin already maintains need no
 * second entry anywhere.
 *
 * KIND DECIDES DIRECTION, display_category only refines WHICH BOX an earning prints in. That ordering is
 * not cosmetic: production carries D0030 (MONTHLY PARKING) as kind=deduction with display_category
 * 'claim'. Reading the category first would turn a parking deduction into an allowance and inflate the
 * employee's gross. `is_non_payable` components (a BIK/perquisite — taxable but never paid in cash) are
 * refused outright by the caller rather than guessed at.
 */
export function payComponentDestination(c: {
  code: string;
  kind: string;
  displayCategory?: string | null;
}): { destination: PayrollImportDestination; direction: PayrollImportDirection } {
  if (c.kind === 'deduction') return { destination: 'other_deduction', direction: 'deduction' };
  switch (c.displayCategory) {
    case 'basic':
      return { destination: 'basic', direction: 'earning' };
    case 'overtime':
      return { destination: 'overtime', direction: 'earning' };
    case 'bonus':
      return { destination: 'bonus', direction: 'earning' };
    case 'allowance':
    case 'claim':
      return { destination: 'allowance', direction: 'earning' };
    default:
      break;
  }
  // Unclassified (production has six such rows). Fall back to the code itself for the three boxes whose
  // names are conventional, then to allowance — which is what an unclassified earning has always been.
  const code = c.code.toUpperCase();
  if (code === 'BASIC') return { destination: 'basic', direction: 'earning' };
  if (code.startsWith('OT') || code === 'OVERTIME') return { destination: 'overtime', direction: 'earning' };
  if (code === 'BONUS') return { destination: 'bonus', direction: 'earning' };
  return { destination: 'allowance', direction: 'earning' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Results — the reporter's error report and summary, verbatim
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Error Type column's vocabulary. The first eleven are the reporter's list, verbatim. Three more
 * exist and each earns its place:
 *
 *   • `Inconsistent totals` — the file supplies a GROSS or NETPAY line that disagrees with the sum of its
 *     own lines. Not any of their eleven, and silently preferring one figure over the other would be
 *     exactly the invented arithmetic this importer refuses to do.
 *   • `EA breakdown` (WARNING ONLY) — the month's gross exceeds its basic with no allowance / overtime /
 *     bonus lines, so the EA Part B itemisation will land entirely in "basic".
 *   • `CP39 readiness` (WARNING ONLY) — tax was deducted but the employee has no tax number on file, so
 *     that month's CP39 e-Data file cannot be produced until it is filled in.
 *
 * The last two are never `Failed`: 21 of the 33 live statutory records have no tax number, and blocking
 * on either would stop most of a migration for something that is correctable afterwards.
 */
export const HISTORY_ERROR_TYPES = [
  'Invalid Employee No',
  'Invalid Payroll Period',
  'Invalid Payroll Cycle',
  'Invalid DOE Code',
  'Invalid Company Code',
  'Invalid Amount',
  'Invalid Override',
  'Missing mandatory field',
  'Duplicate record',
  'Incomplete month',
  'Existing record',
  'Inconsistent totals',
  'EA breakdown',
  'CP39 readiness',
] as const;
export type HistoryErrorType = (typeof HISTORY_ERROR_TYPES)[number];

/** One line of the validation result, in the reporter's specified column order. */
export type HistoryIssue = {
  /** Excel Row No. — the header occupies row 1, so the first data line is row 2. */
  rowNum: number;
  employeeNo: string;
  /** Payroll Period exactly as supplied (YYYYMM), so the row is findable in their file. */
  period: string;
  doeCode: string;
  type: HistoryErrorType;
  description: string;
  status: 'Failed' | 'Warning' | 'Needs action';
};

/** One folded employee-month: the unit that is imported or held back, never half of one. */
export type HistoryMonth = {
  /** employeeNo|period|cycle|companyCode, upper-cased — the identity the whole flow keys on. */
  key: string;
  employeeNo: string;
  /** YYYY-MM once converted; the raw YYYYMM if it could not be. */
  period: string;
  cycle: string;
  companyCode: string;
  /** Every Excel row that contributed, so an error reports at row level as specified. */
  rowNums: number[];
  lineCount: number;
  /** Importable: every line valid, the month complete, and the period empty. */
  ok: boolean;
  /** The period already has payroll — held back, never overwritten. */
  existing: boolean;
  gross: number;
  net: number;
  errorCount: number;
  warningCount: number;
};

/** Dry-run preview. Writes nothing; the confirm step re-derives all of this server-side. */
export type HistoryImportPreview = {
  companyId: string;
  /** Total records uploaded (data lines). */
  total: number;
  /** Valid records — lines belonging to an importable month. */
  valid: number;
  /** Invalid records — lines that failed, or belong to a month that failed. */
  invalid: number;
  /** Duplicate records — repeats of the five-part key within the file. */
  duplicates: number;
  /** Employee-months held back because the period already has payroll. */
  existingMonths: number;
  months: HistoryMonth[];
  issues: HistoryIssue[];
  missingColumns: string[];
};

/**
 * The import summary, in the reporter's own terms.
 *
 * `updated` IS ALWAYS 0, and that is a decision rather than an oversight. Loading a month that already
 * has payroll ADDS to what is there rather than replacing it — the monthly and year-end readers sum every
 * batch for a (company, period) with no run-type or status filter — so someone paid 5,000 in January
 * would be submitted as 10,000. There is also no undo: an imported batch is closed, and migration 0011
 * blocks UPDATE and DELETE on a closed batch at trigger level. Override? is therefore parsed and
 * validated but never permitted to overwrite; an occupied month comes back as "Existing record".
 */
export type HistoryImportResult = {
  companyId: string;
  total: number;
  valid: number;
  invalid: number;
  /** Lines actually written. */
  imported: number;
  /** Employee-months actually written. */
  importedMonths: number;
  /** Always 0 — see the type comment. */
  updated: number;
  duplicates: number;
  /** Employee-months held back because the period already had payroll. */
  existing: number;
  /** Lines that were not written. */
  failed: number;
  issues: HistoryIssue[];
};
