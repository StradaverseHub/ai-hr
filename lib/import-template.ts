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
import {buildPersonnelCsv} from './personnel-csv';
import { personnelColumnLabel, type PersonnelLabelResolver } from './personnel-import-contract';
import { EMPLOYEE_TEMPLATE_COLUMNS as IMPORT_COLUMNS } from './import-schema';
import { PAYROLL_HISTORY_COLUMNS, PAYROLL_HISTORY_SAMPLE_ROWS } from './payroll-history-import-schema';
import { LEAVE_IMPORT_COLUMNS } from './leave-import-schema';
import { LEAVE_HISTORY_COLUMNS } from './leave-history-import-schema';
import { LEAVE_BF_COLUMNS } from './leave-bf-import-schema';

export type TemplateSpec = {
  id: string;
  filename: string;
  columns: { key: string; required: boolean }[];
  sampleRows: string[][];
};

/** Header row (the spec's column keys, in order) + the sample rows, serialised to RFC-4180 CSV. */
export function buildTemplateCsv(spec: TemplateSpec, resolve?: PersonnelLabelResolver): string {
  if(spec.id==='employee')return buildPersonnelCsv('employee',[spec.columns.map(c=>personnelColumnLabel(c.key,'employee',resolve)),...spec.sampleRows.map(row=>spec.columns.map((_,i)=>row[i]??''))]);
  return toCsv([spec.columns.map(c=>c.key),...spec.sampleRows]);
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
const EMPLOYEE_TEMPLATE_SAMPLES:Record<string,string>[] = [
  {
    "full_name": "Aisyah Binti Rahman",
    "email": "aisyah.template@example.com",
    "department": "Finance",
    "hired_on": "2026-01-06",
    "ic_number": "770214086521",
    "basic_salary": "5000",
    "company": "",
    "employee_code": "TMPL0001",
    "phone": "+60 12-345 6789",
    "position": "Executive",
    "cost_center": "CC1",
    "employment_type": "full_time",
    "monthly_allowance": "300",
    "bank_name": "Maybank",
    "bank_account_no": "514012345678",
    "epf_number": "",
    "socso_number": "",
    "tax_number": "",
    "tax_category": "2",
    "num_children": "0",
    "eis_eligible": "true",
    "is_resident": "true",
    "epf_citizenship": "MALAYSIAN",
    "pay_mode": "monthly",
    "payment_term": "monthly",
    "rate_amount": "",
    "salary_remarks": "",
    "passport_number": "",
    "passport_issue_date": "",
    "passport_expiry_date": "",
    "passport_issuing_country": "",
    "address_line_1": "12 Jalan Ampang",
    "address_line_2": "Taman Melawati",
    "address_line_3": "",
    "postcode": "53100",
    "city": "Kuala Lumpur",
    "state": "",
    "country": "",
    "emergency_contact_name": "Rahman Bin Hassan",
    "emergency_contact_relationship": "",
    "emergency_contact_phone": "+60 12-222 3344",
    "emergency_contact_home_phone": "",
    "emergency_contact_address": "",
    "probation_end_date": "2026-04-06",
    "probation_value": "3",
    "probation_unit": "month",
    "confirmation_date": "2026-04-06",
    "notice_before_confirmation_value": "1",
    "notice_before_confirmation_unit": "month",
    "direct_superior": "TMPL0002"
  },
  {
    "full_name": "Daniel Tan Wei Ming",
    "email": "daniel.template@example.com",
    "department": "Operations",
    "hired_on": "2026-02-03",
    "ic_number": "880901105533",
    "basic_salary": "4200",
    "company": "",
    "employee_code": "TMPL0002",
    "phone": "",
    "position": "",
    "cost_center": "",
    "employment_type": "contract",
    "monthly_allowance": "0",
    "bank_name": "",
    "bank_account_no": "",
    "epf_number": "",
    "socso_number": "",
    "tax_number": "",
    "tax_category": "1",
    "num_children": "0",
    "eis_eligible": "true",
    "is_resident": "true",
    "epf_citizenship": "MALAYSIAN",
    "pay_mode": "daily",
    "payment_term": "monthly",
    "rate_amount": "180",
    "salary_remarks": "",
    "passport_number": "A12345678",
    "passport_issue_date": "2023-05-10",
    "passport_expiry_date": "2033-05-09",
    "passport_issuing_country": "",
    "address_line_1": "",
    "address_line_2": "",
    "address_line_3": "",
    "postcode": "",
    "city": "",
    "state": "",
    "country": "",
    "emergency_contact_name": "",
    "emergency_contact_relationship": "",
    "emergency_contact_phone": "",
    "emergency_contact_home_phone": "",
    "emergency_contact_address": "",
    "probation_end_date": "",
    "probation_months": "",
    "probation_days": "",
    "confirmation_date": "",
    "resignation_notice_months": "1",
    "resignation_notice_days": "",
    "direct_superior": ""
  }
];

export const employeeTemplate: TemplateSpec = {
  id: 'employee',
  filename: 'employee-import-template.csv',
  columns: [
    ...IMPORT_COLUMNS.required.map((key) => ({ key, required: true })),
    ...IMPORT_COLUMNS.optional.map((key) => ({ key, required: false })),
  ],
  // Order matches columns above (required ∪ optional). Departments are Finance / Operations only.
  sampleRows: EMPLOYEE_TEMPLATE_SAMPLES.map(row => [...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional].map(key=>row[key]??'')),
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

/**
 * 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT: the twelve columns of the reporter's own table, in the
 * reporter's own order, DERIVED from `LEAVE_HISTORY_COLUMNS` so the template and the validator cannot
 * drift — the employee / payroll-history desync lock, applied to the third contract that has one.
 *
 * ⚠️ THE CSV FORM CARRIES THE snake_case KEYS, NOT THE HUMAN HEADERS, and that is not an oversight.
 * `buildTemplateCsv` writes `columns[].key` and test/import-template.test.ts asserts the file round-trips
 * back through `parseCsvRecords` to exactly those keys — which the human spellings cannot do, because
 * "Employee No." normalises to `employee_no.` (the period survives). The .xlsx template is where HR gets
 * the human headings; the importer accepts BOTH, because `canonicalColumnKey` maps either form onto the
 * same contract key. That is the whole reason that function exists.
 *
 * SAMPLE ROWS are worked examples of the two shapes the ticket names, on the demo seed's E1001 / ANNUAL
 * so an unmodified download → upload round-trips clean: a multi-day full-day record with the Session
 * column deliberately BLANK (the ticket: "do not force AM/PM where it is not applicable"), and a
 * single-day half-day AM record. Their Leave References are obviously synthetic so a template uploaded
 * by mistake is caught as sample data rather than mistaken for a real transaction.
 */
export const leaveHistoryImportTemplate: TemplateSpec = {
  id: 'leave-history-import',
  filename: 'leave-history-import-template.csv',
  columns: LEAVE_HISTORY_COLUMNS.map((c) => ({ key: c.key, required: c.required })),
  sampleRows: [
    // employee_no, leave_reference, leave_code, entitlement_year, start, end, days, session,
    // entry_date, submit_date, approved_date, remark
    ['E1001', 'SAMPLE/2025/0001', 'ANNUAL', '2025', '2025-03-10', '2025-03-12', '3', '', '2025-03-05', '2025-03-05', '2025-03-06', 'Data Migration'],
    ['E1001', 'SAMPLE/2025/0002', 'ANNUAL', '2025', '2025-06-02', '2025-06-02', '0.5', 'AM', '2025-05-30', '2025-05-30', '2025-06-01', 'Data Migration'],
  ],
};

/** The .xlsx template's header row: the reporter's own spellings, in the same order as the contract.
 *  Derived, so a column added to the contract appears in the workbook without a second edit. */
export const LEAVE_HISTORY_XLSX_HEADERS: string[] = LEAVE_HISTORY_COLUMNS.map((c) => c.header);

/**
 * db55d08a (r369) — LEAVE B/F DATA IMPORT: the five columns of the reporter's own table, in the reporter's
 * own order, DERIVED from `LEAVE_BF_COLUMNS` so the template and the validator cannot drift — the fourth
 * contract to take the desync lock.
 *
 * ⚠️ THE CSV FORM CARRIES THE snake_case KEYS, NOT THE HUMAN HEADERS, for the reason the leave-history spec
 * above gives at length: `buildTemplateCsv` writes `columns[].key` and test/import-template.test.ts asserts
 * the file round-trips back through `parseCsvRecords` to exactly those keys. The human spellings cannot do
 * that — "B/F Days" normalises to `b/f_days`, slash and all. The .xlsx template is where HR gets the human
 * headings; the importer accepts BOTH, because `canonicalBfColumnKey` maps either form onto the same
 * contract key, which is the whole reason that function exists.
 *
 * SAMPLE ROWS are on the demo seed's E1001 / ANNUAL so an unmodified download → upload round-trips clean,
 * and they are the worked example of the one thing users get wrong: Entitlement Year is the year the days
 * go INTO, so `2026` means days carried from 2025 into 2026. The Remark says "Data Migration", which is the
 * reporter's own word for it and is what will appear against the ledger row.
 */
export const leaveBfImportTemplate: TemplateSpec = {
  id: 'leave-bf-import',
  filename: 'leave-bf-import-template.csv',
  columns: LEAVE_BF_COLUMNS.map((c) => ({ key: c.key, required: c.required })),
  sampleRows: [
    // employee_id, leave_code, entitlement_year, bf_days, remark
    ['E1001', 'ANNUAL', '2026', '3.5', 'Data Migration'],
  ],
};

/** The .xlsx template's header row: the reporter's own spellings, in contract order. Derived, so a column
 *  added to the contract appears in the workbook without a second edit. */
export const LEAVE_BF_XLSX_HEADERS: string[] = LEAVE_BF_COLUMNS.map((c) => c.header);

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
