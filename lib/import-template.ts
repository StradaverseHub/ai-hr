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
 *  - The EMPLOYEE template also has a real .xlsx form now (d8471481, lib/import-template-xlsx.ts) whose
 *    identity columns are text-typed, which is the fix for Excel mangling long numeric strings
 *    (ic_number, bank_account_no, EPF/SOCSO numbers) on save. The CSV form below is unchanged and is
 *    still what the other four importers offer; it carries that hazard.
 */
import { toCsv } from './csv';
import { IMPORT_COLUMNS } from './import-schema';
import { PAYROLL_HISTORY_COLUMNS, PAYROLL_HISTORY_SAMPLE_ROWS } from './payroll-history-import-schema';
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
      '', // company (d8471481) — blank = the company selected on the import screen
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
      '', // company — blank = the company selected on the import screen
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
 * Payroll history (4157a498) — columns DERIVED from the enforced contract (required first, then
 * optional), the same desync lock as the employee template.
 *
 * THE CONTRACT IS LONG, NOT WIDE: seven columns, one line per figure, and an employee-month is however
 * many lines it takes. The sample below is the reporter's own worked example (A1001 / 202501 / ME /
 * BASIC / ABCDE / 5000.00 / 1) completed into a month that would actually pass validation — basic pay
 * plus every statutory figure, because a month with earnings and no contribution or tax lines is stopped
 * rather than guessed at. A figure that genuinely was zero is written as 0.00, which is accepted.
 *
 * The .xlsx form of this template (the one the screen hands out) is built from the SAME contract in
 * lib/import-template-xlsx.ts, with the reporter's human headings; this CSV form is the fallback.
 */
export const payrollHistoryTemplate: TemplateSpec = {
  id: 'payroll-history',
  filename: 'payroll-history-import-template.csv',
  columns: [
    ...PAYROLL_HISTORY_COLUMNS.required.map((key) => ({ key, required: true })),
    ...PAYROLL_HISTORY_COLUMNS.optional.map((key) => ({ key, required: false })),
  ],
  // Order matches columns above: Employee No, Payroll Period, Payroll Cycle, DOE Code, Company Code,
  // Amount, Override?. The reporter's worked example, completed into a month that passes validation.
  sampleRows: PAYROLL_HISTORY_SAMPLE_ROWS.map((r) => [...r]),
};
