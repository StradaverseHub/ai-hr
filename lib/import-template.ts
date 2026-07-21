/**
 * Downloadable upload templates for the three paste-CSV importers (employee, attendance punch,
 * payroll components). Client-safe — no DB imports, sibling to lib/import-schema.ts — so the
 * import UIs can build a template Blob in the browser.
 *
 * Substrate note: generating or downloading a template writes nothing to the DB, so NO DomainEvent
 * is appended here (explicit per substrate discipline — this is a pure read-only client artifact).
 *
 * Single-source-of-truth scope:
 *  - employee        — columns are DERIVED from IMPORT_COLUMNS (the contract core/import enforces), so
 *                      the template can never silently drift from the validator. The real desync lock.
 *  - payroll-history — columns DERIVED from PAYROLL_HISTORY_COLUMNS (the contract
 *                      core/payroll-history-import enforces) — same desync lock as employee.
 *  - attendance / payroll-components — the parsers accept several header spellings (+ positional /
 *                      aliases) and have NO canonical contract, so these specs are a *suggested* format
 *                      hand-authored from each importer's existing SAMPLE. No second list to drift.
 *
 * Honest limits (see PR notes):
 *  - Only the paste-CSV importers get a template. `dependents` and `leave bulk` named
 *    in the feedback have no importer, so they get no template here.
 *  - The surfaces ingest pasted text, not uploaded files; "download → fill → upload" is completed by
 *    pasting the saved CSV's contents. A true file <input> is a separate follow-up.
 *  - The downloaded artifact is plain CSV text; Excel may mangle long numeric strings (ic_number,
 *    bank_account_no, EPF/SOCSO numbers) on save. A text-typed .xlsx template is the real fix later.
 */
import { toCsv } from './csv';
import { IMPORT_COLUMNS } from './import-schema';
import { PAYROLL_HISTORY_COLUMNS } from './payroll-history-import-schema';
import { LEAVE_IMPORT_COLUMNS } from './leave-import-schema';

export type TemplateSpec = {
  id: string;
  filename: string;
  columns: { key: string; required: boolean }[];
  sampleRows: string[][];
};

/** Header row (the spec's column keys, in order) + the sample rows, serialised to RFC-4180 CSV. */
export function buildTemplateCsv(spec: TemplateSpec): string {
  return toCsv([spec.columns.map((c) => c.key), ...spec.sampleRows]);
}

/** Pull the data row(s) out of an existing `header\n<rows>` SAMPLE constant (drops the header line). */
function sampleDataRows(sample: string): string[][] {
  return sample
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','));
}

/**
 * Employee — columns derived from the enforced contract (required first, then optional). One
 * header-complete sample row that validates against BOTH the demo seed and the test harness
 * `seedBase` (departments Finance / Operations only; a valid 12-digit MyKad not present in the demo
 * seed so an unmodified download→upload doesn't hit a dup-IC error).
 */
export const employeeTemplate: TemplateSpec = {
  id: 'employee',
  filename: 'employee-import-template.csv',
  columns: [
    ...IMPORT_COLUMNS.required.map((key) => ({ key, required: true })),
    ...IMPORT_COLUMNS.optional.map((key) => ({ key, required: false })),
  ],
  // Order matches columns above (required ∪ optional). Departments are Finance / Operations only.
  sampleRows: [
    [
      'Aisyah Binti Rahman', // full_name
      'aisyah.template@example.com', // email
      'Finance', // department
      '2026-01-06', // hired_on
      '770214086521', // ic_number (valid 12-digit MyKad; not in the demo seed)
      '5000', // basic_salary
      'TMPL0001', // employee_code (optional, HR-suppliable; not in the demo seed so a raw download→upload round-trips)
      '+60 12-345 6789', // phone
      'Executive', // position
      'CC1', // cost_center
      'full_time', // employment_type
      '300', // monthly_allowance
      'Maybank', // bank_name
      '514012345678', // bank_account_no
      '', // epf_number
      '', // socso_number
      '', // tax_number
      '2', // tax_category
      '0', // num_children
      'true', // eis_eligible
      'true', // is_resident
      'MALAYSIAN', // epf_citizenship
      'monthly', // pay_mode (ADR-0078; blank = monthly)
      'monthly', // payment_term (blank = monthly)
      '', // rate_amount (only for daily/hourly pay modes)
    ],
    [
      'Daniel Tan Wei Ming', // full_name
      'daniel.template@example.com', // email
      'Operations', // department
      '2026-02-03', // hired_on
      '880901105533', // ic_number
      '4200', // basic_salary
      'TMPL0002', // employee_code (optional)
      '', // phone
      '', // position
      '', // cost_center
      'contract', // employment_type
      '0', // monthly_allowance
      '', // bank_name
      '', // bank_account_no
      '', // epf_number
      '', // socso_number
      '', // tax_number
      '1', // tax_category
      '0', // num_children
      'true', // eis_eligible
      'true', // is_resident
      'MALAYSIAN', // epf_citizenship
      'daily', // pay_mode (ADR-0078) — a daily-rated worker; basic_salary above stays the monthly-equivalent
      'monthly', // payment_term
      '180', // rate_amount — RM per day (required for daily/hourly)
    ],
  ],
};

/**
 * Leave data import — columns DERIVED from the enforced contract (LEAVE_IMPORT_COLUMNS, all required),
 * the same desync lock as the employee template. Two header-complete sample rows using a known demo-seed
 * employee code (E1001) and the ANNUAL leave type so an unmodified download→upload round-trips clean:
 * one opening-balance carry (adjustment) and one historical debit (negative days), matching the ticket's
 * opening-balance + historical-leave-taken examples.
 */
export const leaveImportTemplate: TemplateSpec = {
  id: 'leave-import',
  filename: 'leave-import-template.csv',
  columns: LEAVE_IMPORT_COLUMNS.required.map((key) => ({ key, required: true })),
  sampleRows: [
    // Opening / carry-forward balance as an adjustment (either sign allowed).
    ['E1001', 'ANNUAL', 'adjustment', '5', '2026-01-01'],
    // Historical leave taken as a debit (negative days).
    ['E1001', 'ANNUAL', 'debit', '-2', '2026-03-14'],
  ],
};

const ATTENDANCE_SAMPLE = `staff_id,timestamp
E1001,2026-07-01 08:02:00
E1001,2026-07-01 17:31:00
E1002,2026-07-01 22:00:00
E1002,2026-07-02 06:05:00`;

/**
 * Attendance punch — *suggested* format only. The parser (lib/attendance-csv.ts) fuzzy-matches ~7
 * header spellings and falls back to positional, so there is no contract to lock against. Sample
 * rows are derived from the importer's existing SAMPLE so there is one source.
 */
export const attendancePunchTemplate: TemplateSpec = {
  id: 'attendance-punch',
  filename: 'attendance-punch-template.csv',
  columns: [
    { key: 'staff_id', required: true },
    { key: 'timestamp', required: true },
  ],
  sampleRows: sampleDataRows(ATTENDANCE_SAMPLE),
};

const COMPONENT_SAMPLE = `employee,component,amount,notes
aisyah@demo.test,HOUSING,800,Fixed housing
meiling@demo.test,OVERTIME,450,
arjun@demo.test,DEDUCTION,120,Staff loan`;

/**
 * Payroll components — *suggested* format only. The validator (core/pay-components.ts) accepts
 * `email`/`employee_email` and `component_code`/`code` aliases and uppercases the code, so there is
 * no canonical contract. Sample rows are derived from the importer's existing SAMPLE.
 */
export const payrollComponentTemplate: TemplateSpec = {
  id: 'payroll-components',
  filename: 'payroll-components-template.csv',
  columns: [
    { key: 'employee', required: true },
    { key: 'component', required: true },
    { key: 'amount', required: true },
    { key: 'notes', required: false },
  ],
  sampleRows: sampleDataRows(COMPONENT_SAMPLE),
};

/**
 * Payroll history (1.2.5) — columns DERIVED from the enforced contract (required first, then optional),
 * the same desync lock as the employee template. Two sample rows for a *prior* year (so a copy-down
 * download lands in an empty month) with internally-consistent figures:
 *   net  = gross − (epf_employee + socso_employee + socso_skbbk + eis_employee + pcb + other_deductions)
 *   cost = gross + epf_employer + socso_employer + eis_employer
 * Resolution is by email; employee_code is an optional secondary disambiguator.
 */
export const payrollHistoryTemplate: TemplateSpec = {
  id: 'payroll-history',
  filename: 'payroll-history-import-template.csv',
  columns: [
    ...PAYROLL_HISTORY_COLUMNS.required.map((key) => ({ key, required: true })),
    ...PAYROLL_HISTORY_COLUMNS.optional.map((key) => ({ key, required: false })),
  ],
  // Order matches columns above (required ∪ optional).
  sampleRows: [
    [
      'aisyah@demo.test', // email
      '2024-06', // period (prior year — an empty month for a fresh install)
      '5000', // basic_salary
      '5300', // gross_pay (basic + allowance)
      '583.00', // epf_employee (11%)
      '689.00', // epf_employer (13%)
      '24.75', // socso_employee
      '86.65', // socso_employer
      '9.90', // eis_employee
      '9.90', // eis_employer
      '150.00', // pcb
      '4532.35', // net_pay = 5300 − (583 + 24.75 + 9.90 + 150)
      'E1001', // employee_code (secondary)
      '300', // allowance
      '0', // overtime_pay
      '0', // bonus
      '0', // socso_skbbk
      '0', // lp
      '0', // zakat
      '0', // cp38 (LHDN/court instalment, distinct from MTD)
      '', // cp38_ref (LHDN reference for the CP38 instalment)
      '0', // other_deductions
      '6085.55', // employer_cost = 5300 + 689 + 86.65 + 9.90
      '767.65', // total_deductions
    ],
    [
      'meiling@demo.test', // email
      '2024-06', // period
      '4200', // basic_salary
      '4200', // gross_pay
      '462.00', // epf_employee (11%)
      '546.00', // epf_employer (13%)
      '19.75', // socso_employee
      '69.15', // socso_employer
      '8.40', // eis_employee
      '8.40', // eis_employer
      '60.00', // pcb
      '3649.85', // net_pay = 4200 − (462 + 19.75 + 8.40 + 60)
      'E1002', // employee_code
      '0', // allowance
      '0', // overtime_pay
      '0', // bonus
      '0', // socso_skbbk
      '0', // lp
      '0', // zakat
      '0', // cp38 (LHDN/court instalment, distinct from MTD)
      '', // cp38_ref (LHDN reference for the CP38 instalment)
      '0', // other_deductions
      '4823.55', // employer_cost = 4200 + 546 + 69.15 + 8.40
      '550.15', // total_deductions
    ],
  ],
};
