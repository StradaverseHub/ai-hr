/**
 * Board d3ba1e9f — the Cost Center Allocations import's ONE Error Log adapter: the checked plan (file problems and
 * each employee/date set's errors) and the save results -> ImportProblemLine[]. The check screen, the result screen,
 * their "Download Error Log" and Import History all call this, so the screen and the file say the same thing.
 *
 * Client-safe (no database, no React). Row numbers are the Excel rows the check already names ("Row 3", "Rows 2,
 * 3"). A set's error that names several rows becomes one line per row, so each line points at one row to fix.
 * Allocation values are not sensitive; the entered Company Code, Effective Date and Cost Center Code are repeated.
 */
import { ALLOCATION_CAPTIONS, type AllocationColumn } from './employment-cost-allocation';
import type { ImportProblemLine } from './import-problem-lines';
import { correctionText, matchProblem, systemProblem, type ImportProblemRule, type ImportProblemText } from './import-problem-rules';

/** A checked set, as the plan stores it (lib/cost-allocation-import.ts AllocationImportGroup). */
export type AllocationProblemGroup = { key: string; companyCode: string; employeeCode: string; effectiveDate: string; rowNums: number[]; errors: string[] };
/** A set the save refused (the confirm result or a failed Import History item), with its error. */
export type AllocationSaveFailure = { key: string; employeeCode: string; rowNums: number[]; errors: string[] };

const SCOPE = 'allocation';
/** Server-side CostAllocationError sentences (lib/employment-cost-allocation.ts), verbatim. */
const ALLOCATION_ERRORS: Record<string, { key: string; field?: AllocationColumn; correction?: Parameters<typeof correctionText>[0] }> = {
  'Enter a percentage greater than zero and at most 100, with up to two decimal places.': { key: 'errors.invalid', field: 'percentage', correction: 'percentage' },
  'Select each cost center once.': { key: 'errors.duplicate', field: 'cost_center_code', correction: 'duplicateInFile' },
  'The total allocation cannot exceed 100%.': { key: 'errors.total', field: 'percentage' },
  'Employee record or permission is unavailable.': { key: 'errors.scope', correction: 'permission' },
  'A cost center is inactive or unavailable for this company.': { key: 'errors.label', field: 'cost_center_code', correction: 'chooseCostCenter' },
  'Allocations changed. Reload and preview again.': { key: 'errors.changed', correction: 'revalidate' },
  'Choose an effective date with proven employment company history.': { key: 'errors.date', field: 'effective_date' },
  'Clearing allocations requires an explicit clear operation.': { key: 'errors.clear', field: 'operation' },
  'The input or reference data changed. Preview again.': { key: 'errors.preview', correction: 'revalidate' },
  'Match each allocation to one company and Employee ID.': { key: 'errors.binding' },
  'Save an explicit clear set at the transfer date and clear any later scheduled sets before transferring. Then save a new destination-company allocation.': { key: 'errors.transfer' },
};

/** The sentence after a "Row N:" / "Rows N, M:" / "Row N (code):" prefix. */
const RULES: readonly ImportProblemRule[] = [
  { re: /^Operation must be Replace or Clear, and the same on every row for one employee and date\.$/, key: 'operation', field: 'operation' },
  { re: /^Clear needs exactly one row with a blank Cost Center Code and Percentage\.$/, key: 'clearRow', field: 'operation' },
  { re: /^this Cost Center Code is not available for (.+)\.$/, key: 'costCenterUnavailable', values: m => ({ company: m[1] }), field: 'cost_center_code', correction: 'chooseCostCenter' },
  { re: /^Company Code is required\.$/, key: 'companyRequired', field: 'company_code', correction: 'chooseCompany' },
  { re: /^Company Code "(.*)" matches more than one company\. Use the Company Code listed on the Reference sheet\.$/, key: 'companyAmbiguous', values: m => ({ code: m[1] }), field: 'company_code', value: m => m[1], correction: 'chooseCompany' },
  { re: /^Company Code "(.*)" does not match a company you can import for\.$/, key: 'companyUnknown', values: m => ({ code: m[1] }), field: 'company_code', value: m => m[1], correction: 'chooseCompany' },
  { re: /^Effective Date must be a date in YYYY-MM-DD form\.$/, key: 'effectiveDate', field: 'effective_date', correction: 'date' },
  { re: /^Employee ID is missing or invalid\.$/, key: 'employeeInvalid', field: 'employee_code', correction: 'required' },
  { re: /^Employee ID (.+) matches more than one employee of (.+)\.$/, key: 'employeeAmbiguous', values: m => ({ code: m[1], company: m[2] }), field: 'employee_code' },
  { re: /^Employee ID (.+) is not an employee of (.+) on (\d{4}-\d{2}-\d{2})\.$/, key: 'employeeNotInCompany', values: m => ({ code: m[1], company: m[2], date: m[3] }), field: 'employee_code', correction: 'existingEmployee' },
  { re: /^Another allocation for Employee ID (.+) in this file has errors, so this employee is not imported\. Correct that row first\.$/, key: 'heldBack', values: m => ({ code: m[1] }) },
  { re: /^The allocation company, employee or effective date is unavailable\.$/, key: 'unavailable' },
  { re: /^This employee could not be saved; nothing was changed for them\.$/, key: 'saveFailed', correction: 'systemError' },
];

/** File problems (AllocationFileError and the upload's own sentences), verbatim. */
const FILE_RULES: readonly ImportProblemRule[] = [
  { re: /^This file uses the old layout with an internal company identifier \(company_id\)\. Download the new template and fill in the Company Code column instead\.$/, key: 'file.legacyLayout', correction: 'template' },
  { re: /^Duplicate allocation column headers are not allowed\.$/, key: 'file.duplicateHeaders', correction: 'template' },
  { re: /^Missing allocation columns: (.*)$/, key: 'file.missingColumns', values: m => ({ columns: m[1] }), correction: 'template' },
  { re: /^Unexpected allocation columns: (.*)$/, key: 'file.unexpectedColumns', values: m => ({ columns: m[1] }), correction: 'template' },
  { re: /^Use at most 5000 allocation rows per file\.$/, key: 'file.tooManyRows' },
  { re: /^Allocation file exceeds the supported size\.$/, key: 'file.tooLarge' },
  { re: /^Choose a file no larger than 10 MB\.$/, key: 'file.tooLarge10' },
  { re: /^The workbook could not be read\. Download the template and try again\.$/, key: 'file.unreadableWorkbook', correction: 'template' },
  { re: /^Save the CSV file as UTF-8\.$/, key: 'file.utf8' },
  { re: /^Choose the \.xlsx template or a \.csv file with the same columns\.$/, key: 'file.fileType', correction: 'template' },
  { re: /^This file could not be read\.$/, key: 'file.unreadable', correction: 'template' },
  { re: /^The file has no allocation rows\.$/, key: 'file.noRows', correction: 'template' },
];

const caption = (column: AllocationColumn) => ALLOCATION_CAPTIONS[column];

/** Split "Row 3 (CC-1): ...", "Rows 2, 3: ..." into the rows, the quoted code and the sentence. */
function splitRows(message: string): { rows: number[]; code?: string; rest: string } | null {
  const m = /^Rows? ((?:\d+)(?:, \d+)*)(?: \(([^)]*)\))?: ([\s\S]*)$/.exec(message);
  return m ? { rows: m[1].split(', ').map(Number), code: m[2], rest: m[3] } : null;
}

type LineText = { problem: string; field?: AllocationColumn; correction?: string; value?: string; errorReference?: string; system: boolean };
function lineFor(message: string, group: { companyCode: string; employeeCode: string; effectiveDate: string }, code: string | undefined, t: ImportProblemText): LineText {
  const system = systemProblem(message, t);
  if (system) return { problem: system.problem, correction: system.correction, errorReference: system.errorReference, system: true };
  const known = ALLOCATION_ERRORS[message];
  if (known) return { problem: t(`importErrorLogDataBankCostInfo.${SCOPE}.${known.key}`), field: known.field, correction: known.correction ? correctionText(known.correction, t) : undefined, value: known.field === 'cost_center_code' ? code : undefined, system: false };
  const matched = matchProblem(message, RULES, SCOPE, t);
  const field = matched.field as AllocationColumn | undefined;
  const value = matched.value ?? (field === 'company_code' ? group.companyCode : field === 'effective_date' ? group.effectiveDate : field === 'cost_center_code' ? code : undefined);
  return { problem: matched.problem, field, correction: matched.correction, value, system: false };
}

/**
 * Lines for a checked file and, after saving, the sets the save refused. `saveFailures` are only the sets that passed
 * the check (a set refused at the check keeps its check lines, whatever the result list says).
 */
export function costAllocationProblemLines(input: { issues?: readonly { reason: string }[]; groups?: readonly AllocationProblemGroup[]; saveFailures?: readonly AllocationSaveFailure[] }, t: ImportProblemText): ImportProblemLine[] {
  const lines: ImportProblemLine[] = [];
  for (const issue of input.issues ?? []) {
    const system = systemProblem(issue.reason, t);
    if (system) { lines.push({ row: null, ...system, result: 'not_saved' }); continue; }
    const matched = matchProblem(issue.reason, FILE_RULES, SCOPE, t);
    lines.push({ row: null, problem: matched.problem, ...(matched.correction ? { correction: matched.correction } : {}), stage: 'file', result: 'not_saved' });
  }
  const checked = new Set<string>();
  for (const group of input.groups ?? []) {
    if (group.errors.length) checked.add(group.key);
    for (const error of group.errors) {
      const split = splitRows(error);
      const rows = split?.rows ?? group.rowNums;
      const line = lineFor(split?.rest ?? error, group, split?.code, t);
      for (const row of rows) lines.push(clean({
        row, reference: group.employeeCode || undefined, field: line.field ? caption(line.field) : undefined, value: line.value || undefined,
        problem: line.problem, correction: line.correction, stage: line.system ? 'system' : 'check', result: 'refused', errorReference: line.errorReference,
      }));
    }
  }
  for (const failure of input.saveFailures ?? []) {
    if (checked.has(failure.key)) continue;
    const group = input.groups?.find(g => g.key === failure.key) ?? { companyCode: '', employeeCode: failure.employeeCode, effectiveDate: '' };
    for (const error of failure.errors) {
      const line = lineFor(error, group, undefined, t);
      for (const row of failure.rowNums) lines.push(clean({
        row, reference: failure.employeeCode || undefined, field: line.field ? caption(line.field) : undefined, value: line.value || undefined,
        problem: line.problem, correction: line.correction, stage: line.system ? 'system' : 'save', result: 'not_saved', errorReference: line.errorReference,
      }));
    }
  }
  return lines;
}

/** Drop undefined keys so a line compares and serialises like a hand-written one. */
function clean(line: ImportProblemLine): ImportProblemLine {
  return Object.fromEntries(Object.entries(line).filter(([, v]) => v !== undefined)) as ImportProblemLine;
}
