/**
 * The EMPLOYEE Excel (.xlsx) import template — d8471481.
 *
 * The CSV template (lib/import-template.ts) has one hazard its own header comment already named:
 * "Excel may mangle long numeric strings (ic_number, bank_account_no, EPF/SOCSO numbers) on save."
 * It is worse than mangling. Open a CSV in Excel, and `0123456789` in a General cell becomes the
 * NUMBER 123456789 — the leading zero is destroyed IN THE FILE before anything reads it, and a
 * 16-digit account can be re-saved as `1.23457E+15`. No importer can undo either.
 *
 * The fix has to be in the template, and this is it: a real workbook whose identity columns are
 * pre-formatted as TEXT (`z: '@'`, 500 rows deep), so Excel keeps exactly what HR typed.
 *
 * Three sheets, as the reporter specified:
 *   1. Employee Import   — human column labels + two worked sample rows.
 *   2. Reference         — the live dropdown values (companies, departments, positions, cost
 *                          centres, and the fixed enumerations) so a typo cannot become a record.
 *   3. Instructions      — how to fill it in, including the leading-zero rule.
 *
 * NO DomainEvent: downloading a template writes nothing.
 *
 * Client-safe (no DB imports). The reference values are passed IN by the screen, which reads them
 * from the same catalogs `analyze()` validates against — there is no second list to drift.
 *
 * HONEST LIMIT, stated rather than hidden: these are reference LISTS, not in-cell dropdowns. Excel
 * data validation lives in a part of the file format the SheetJS community build does not write, so
 * promising a clickable dropdown would mean shipping a second xlsx writer. The Reference sheet gives
 * HR the exact accepted spellings, and `analyze()` rejects anything else by name with the reason.
 */
import { IMPORT_COLUMNS } from './import-schema';
import { employeeTemplate } from './import-template';

/** Words that must not be title-cased letter-by-letter. Everything else is Capitalised. */
const ACRONYMS: Record<string, string> = { ic: 'IC', epf: 'EPF', socso: 'SOCSO', eis: 'EIS' };

/**
 * `ic_number` → `IC Number`.
 *
 * The label must LOWERCASE-AND-UNDERSCORE back to its own key, because that is precisely what
 * `parseCsvRecords` does to a header on re-upload (`h.trim().toLowerCase().replace(/\s+/g, '_')`).
 * A prettier label that does not round-trip would silently drop the whole column, so
 * test/employee-import-xlsx.test.ts asserts the round-trip for every key rather than trusting it.
 */
export function employeeColumnLabel(key: string): string {
  return key
    .split('_')
    .map((w) => ACRONYMS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Every column, required first — the same order (and therefore the same sample rows) as the CSV
 *  template, derived from the SAME contract so the two can never disagree. */
export const EMPLOYEE_XLSX_COLUMNS: readonly string[] = employeeTemplate.columns.map((c) => c.key);

export const EMPLOYEE_XLSX_HEADERS: readonly string[] = EMPLOYEE_XLSX_COLUMNS.map(employeeColumnLabel);

/**
 * The columns that are IDENTIFIERS, not quantities: digits that must survive verbatim, leading
 * zeros and all. These get `z: '@'`. Deliberately excludes basic_salary / monthly_allowance /
 * rate_amount / tax_category / num_children — those ARE numbers, and forcing them to text would
 * make Excel refuse to sum them, which HR would rightly report as a bug.
 */
export const EMPLOYEE_TEXT_COLUMN_KEYS: readonly string[] = [
  'employee_code',
  'ic_number',
  'phone',
  'bank_account_no',
  'epf_number',
  'socso_number',
  'tax_number',
];

/** 0-based positions of the text columns within the header row. */
export function employeeTextColumnIndexes(): number[] {
  return EMPLOYEE_TEXT_COLUMN_KEYS.map((k) => EMPLOYEE_XLSX_COLUMNS.indexOf(k)).filter((i) => i >= 0);
}

/** One block of accepted values on the Reference sheet. */
export type ReferenceList = { label: string; values: string[] };

/**
 * The Reference sheet as an array-of-arrays: a title row per list, then one value per row, then a
 * blank separator. Vertical rather than side-by-side columns because the lists have wildly
 * different lengths and a ragged grid is unreadable.
 */
export function buildReferenceRows(heading: string, lists: ReferenceList[]): string[][] {
  const rows: string[][] = [[heading], []];
  for (const list of lists) {
    rows.push([list.label]);
    if (list.values.length === 0) rows.push(['—']);
    else for (const v of list.values) rows.push([v]);
    rows.push([]);
  }
  return rows;
}

/** The fixed enumerations `analyze()` accepts. Hardcoded here ONLY because they are hardcoded there
 *  too (core/import.ts) — these are code-level enums, not configuration, so there is no catalog to
 *  read them from and the drift risk is a source change in one file, caught by the test below. */
export const EMPLOYEE_ENUM_VALUES = {
  employment_type: ['full_time', 'part_time', 'contract', 'intern'],
  pay_mode: ['monthly', 'daily', 'hourly', 'custom_period'],
  payment_term: ['monthly', 'weekly', 'biweekly'],
  epf_citizenship: ['citizen', 'pr', 'non_citizen'],
  tax_category: ['1', '2', '3'],
  eis_eligible: ['yes', 'no'],
  is_resident: ['yes', 'no'],
} as const;

/** The Instructions sheet. Every line is supplied by the caller (translated); this only lays it out. */
export function buildInstructionRows(title: string, lines: string[]): string[][] {
  return [[title], [], ...lines.map((l) => [l])];
}

/** Sheet names. Short and stable: `workbookToCsvText` reads the FIRST sheet, so the data sheet must
 *  stay first, and a renamed sheet would silently change which one is read. */
export const EMPLOYEE_XLSX_SHEETS = {
  data: 'Employee Import',
  reference: 'Reference',
  instructions: 'Instructions',
} as const;

export const EMPLOYEE_XLSX_FILENAME = 'employee-import-template.xlsx';
