/**
 * Board 5084d02e — the Form TP3 import TEMPLATE and SAMPLE REFERENCE, built in the browser with the repository's one
 * workbook writer (lib/spreadsheet.ts `buildXlsx`), like lib/individual-txn-import-workbook.ts.
 *
 * The fill-in sheet is FIRST (the import reads the first sheet only). Its columns are `tp3ImportColumns` of the form's
 * catalogue, so the template, the reader and the form cannot disagree. Then an Instructions sheet (every column with
 * what to enter, whether it is required, its format and its limit) and an Employees sheet.
 *
 * The SAMPLE carries fictional rows and fictional employees only; it never lists a real employee.
 */
import { buildXlsx } from './spreadsheet';
import { tp3ImportColumns, tp3ImportHeading, type Tp3ImportCatalogue, type Tp3ImportColumn } from './tp3-import-columns';

/** The reader's own words for every part of the workbook, resolved by the caller from the message catalogue. */
export type Tp3WorkbookCopy = {
  sheetImport: string;
  sheetInstructions: string;
  sheetEmployees: string;
  /** What a column holds, in the reader's language: the form's own wording for a box. */
  wording(column: Tp3ImportColumn): string;
  format(column: Tp3ImportColumn): string;
  limit(column: Tp3ImportColumn): string;
  required: string;
  optional: string;
  title: string;
  intro: readonly string[];
  instructionsHeader: readonly [string, string, string, string, string];
  employeesHeader: readonly [string, string, string];
};
export type Tp3WorkbookEmployee = readonly [code: string, name: string, company: string];

/** Fictional example rows for the Sample Reference, by column token. Names, codes and amounts are invented. */
const SAMPLE_ROWS: readonly Readonly<Record<string, string>>[] = [
  { 'Employee ID': 'C0101', 'Assessment Year': '2026', 'Deduction Month': '4', 'Employer 1 Name': 'Example Trading Sdn Bhd',
    'Employer 1 Tax No.': 'C 1234567890', C1: '24000.00', 'C2(i)': '1200.00', C3: '2640.00', 'C4(i)': '0.00', C5: '310.00',
    'D1(c)': '400.00', D2: '1500.00', Remarks: 'Fictional example: one previous employer' },
  { 'Employee ID': 'C0102', 'Assessment Year': '2026', 'Deduction Month': '7', 'Employer 1 Name': 'Contoh Niaga Sdn Bhd',
    'Employer 1 Tax No.': 'C 2345678901', 'Employer 2 Name': 'Sample Logistics Sdn Bhd', 'Employer 2 Tax No.': 'C 3456789012',
    C1: '36000.00', 'C2(ii)': '600.00', C3: '3960.00', 'C4(i)': '120.00', C5: '1450.00', Remarks: 'Fictional example: two previous employers' },
  { 'Employee ID': 'C0103', 'Assessment Year': '2026', 'Employer 1 Name': 'Demo Services Sdn Bhd', C1: '12000.00', C3: '1320.00',
    C5: '0.00', Remarks: 'Fictional example: no deduction month stated' },
];
const SAMPLE_EMPLOYEES: readonly Tp3WorkbookEmployee[] = [
  ['C0101', 'Aina Example', 'Example Company Sdn Bhd'],
  ['C0102', 'Ben Sample', 'Example Company Sdn Bhd'],
  ['C0103', 'Chandra Demo', 'Example Company Sdn Bhd'],
];

export async function buildTp3ImportWorkbook(
  catalogue: Tp3ImportCatalogue,
  copy: Tp3WorkbookCopy,
  data: { kind: 'template'; employees: readonly Tp3WorkbookEmployee[] } | { kind: 'sample' },
): Promise<Uint8Array> {
  const columns = tp3ImportColumns(catalogue);
  const header = columns.map((column) => tp3ImportHeading(column, copy.wording(column)));
  const rows = data.kind === 'sample' ? SAMPLE_ROWS.map((sample) => columns.map((column) => sample[column.token] ?? '')) : [];
  const employees = data.kind === 'sample' ? SAMPLE_EMPLOYEES : data.employees;
  // Identity and text columns stay TEXT so an Employee ID with a leading zero survives Excel.
  const textColumns = columns.flatMap((column, index) => (column.kind === 'amount' ? [] : [index]));
  const instructions: (string | number)[][] = [
    [copy.title],
    ...copy.intro.map((line) => [line]),
    [],
    [...copy.instructionsHeader],
    ...columns.map((column) => [
      column.required ? `${column.token} *` : column.token,
      copy.wording(column),
      column.required ? copy.required : copy.optional,
      copy.format(column),
      copy.limit(column),
    ]),
  ];
  return buildXlsx(header, rows, {
    sheetName: copy.sheetImport,
    textColumns,
    columnWidths: columns.map((column) => (column.kind === 'amount' ? 18 : column.kind === 'remarks' ? 40 : 24)),
    wrapText: true,
    extraSheets: [
      { name: copy.sheetInstructions, rows: instructions, columnWidths: [14, 70, 12, 40, 44], wrapText: true },
      { name: copy.sheetEmployees, rows: [[...copy.employeesHeader], ...employees.map((e) => [...e])], textColumns: [0], columnWidths: [16, 36, 36] },
    ],
  });
}
