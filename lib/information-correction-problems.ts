/**
 * Board d3ba1e9f — the Information-Only Correction import's ONE Error Log adapter: the checked plan's rows (and,
 * after confirming, the rows the save refused) -> ImportProblemLine[]. The check screen, the result screen, their
 * "Download Error Log" and Import History all call this, so the screen and the file say the same thing.
 *
 * Client-safe (no database, no React). Rows are the Corrections sheet's Excel rows, as the check already numbers
 * them. A sentence that starts with a template heading ("Join Date: use YYYY-MM-DD ...") names its field.
 * The template carries no identity, bank, statutory or salary value, so entered values are repeated.
 */
import { INFORMATION_HEADERS_V2, type InformationHeader } from './information-correction';
import type { ImportProblemLine } from './import-problem-lines';
import { matchProblem, systemProblem, type ImportProblemRule, type ImportProblemText } from './import-problem-rules';

/** A checked row, as the plan stores it (lib/information-correction.ts InformationImportRow). */
export type InformationProblemRow = {
  row: number;
  employeeCode: string;
  values: Partial<Record<InformationHeader, string>>;
  errors: string[];
  preview?: { name?: string } | null;
};
/** A row's save outcome (InformationImportResult.rows / the confirmed event's rows). */
export type InformationSaveRow = { row: number; status: 'applied' | 'failed' | 'unchanged'; errors: string[] };

export const INFORMATION_SHEET = 'Corrections';
const SCOPE = 'correction';

/** After a "Heading: " prefix. */
const FIELD_RULES: readonly ImportProblemRule[] = [
  { re: /^formulas and error cells are not accepted\.$/, key: 'noFormula', correction: 'noFormula' },
  { re: /^enter a text code to preserve leading zeros\.$/, key: 'textCode', correction: 'textCode' },
  { re: /^use YYYY-MM-DD or an Excel date\.$/, key: 'date', correction: 'date' },
  { re: /^maximum 1,000 characters\.$/, key: 'tooLong' },
  { re: /^enter the period and its unit together \((.+)\)\.$/, key: 'periodUnit', values: m => ({ unit: m[1] }), correction: 'periodUnit' },
  { re: /^"(.*)" is not an option for this company\. Check the (.+) reference sheet\.$/, key: 'notOption', values: m => ({ value: m[1], sheet: m[2] }), value: m => m[1], correction: 'chooseReference' },
  { re: /^the Employee ID is unknown in this company or not visible to you\.$/, key: 'superiorUnknown' },
];
/** Whole sentences. */
const RULES: readonly ImportProblemRule[] = [
  { re: /^Organisation columns cannot contain formulas or error cells\.$/, key: 'organisationFormula', correction: 'noFormula' },
  { re: /^Organisation value: maximum 1,000 characters\.$/, key: 'organisationTooLong' },
  { re: /^Company Code is required\.$/, key: 'companyRequired', field: 'Company Code', correction: 'chooseCompany' },
  { re: /^Employee ID is required\.$/, key: 'employeeRequired', field: 'Employee ID', correction: 'required' },
  { re: /^Correction Reason must contain at least three characters\.$/, key: 'reasonShort', field: 'Correction Reason', correction: 'reason' },
  { re: /^This employee appears more than once\. Keep one correction row per employee\.$/, key: 'duplicateEmployee', field: 'Employee ID', correction: 'duplicateEmployeeInFile' },
  { re: /^Company Code is unknown, ambiguous or outside your permission\.$/, key: 'companyUnknown', field: 'Company Code', correction: 'chooseCompany' },
  { re: /^Employee ID is unknown or ambiguous within the existing company\.$/, key: 'employeeUnknown', field: 'Employee ID', correction: 'existingEmployee' },
  { re: /^New Company Code is unknown, ambiguous or outside your permission\.$/, key: 'newCompanyUnknown', field: 'New Company Code', correction: 'chooseCompany' },
  { re: /^Job Grade is not an active system code\.$/, key: 'gradeInactive', field: 'Job Grade', correction: 'chooseReference' },
  { re: /^Multiple rows resolve to the same employee\.$/, key: 'sameEmployee', correction: 'duplicateEmployeeInFile' },
];

const HEADERS_LONGEST_FIRST = [...INFORMATION_HEADERS_V2].sort((a, b) => b.length - a.length);

function describe(message: string, row: InformationProblemRow, t: ImportProblemText): Omit<ImportProblemLine, 'row' | 'stage' | 'result'> & { system?: boolean } {
  const system = systemProblem(message, t);
  if (system) return { problem: system.problem, correction: system.correction, errorReference: system.errorReference, system: true };
  const header = HEADERS_LONGEST_FIRST.find(h => message.startsWith(h + ': '));
  if (header) {
    const rest = message.slice(header.length + 2), matched = matchProblem(rest, FIELD_RULES, SCOPE, t);
    const value = matched.value ?? row.values[header];
    return { field: header, ...(value ? { value } : {}), problem: matched.problem, ...(matched.correction ? { correction: matched.correction } : {}) };
  }
  const matched = matchProblem(message, RULES, SCOPE, t), field = matched.field as InformationHeader | undefined;
  const value = field ? row.values[field] : undefined;
  return { ...(field ? { field } : {}), ...(value ? { value } : {}), problem: matched.problem, ...(matched.correction ? { correction: matched.correction } : {}) };
}

/**
 * Lines for the checked rows (refused at the check) and, given `saved`, the rows that passed the check but were not
 * saved. `rows` must already be limited to what the viewer may see (Import History scopes them first).
 */
export function informationCorrectionProblemLines(input: { rows: readonly InformationProblemRow[]; saved?: readonly InformationSaveRow[]; fileError?: string | null }, t: ImportProblemText): ImportProblemLine[] {
  const lines: ImportProblemLine[] = [];
  if (input.fileError) {
    const system = systemProblem(input.fileError, t);
    lines.push(system ? { row: null, ...system, result: 'not_saved' } : { row: null, problem: input.fileError, stage: 'file', result: 'not_saved' });
  }
  const byRow = new Map(input.rows.map(row => [row.row, row]));
  for (const row of input.rows) for (const error of row.errors) lines.push(line(row, error, 'check', t));
  for (const outcome of input.saved ?? []) {
    const row = byRow.get(outcome.row);
    if (!row || row.errors.length || outcome.status !== 'failed') continue;
    for (const error of outcome.errors) lines.push(line(row, error, 'save', t));
  }
  return lines;
}

function line(row: InformationProblemRow, error: string, stage: 'check' | 'save', t: ImportProblemText): ImportProblemLine {
  const { system, ...text } = describe(error, row, t);
  const name = row.preview?.name || row.values['Employee Name'];
  return {
    sheet: INFORMATION_SHEET, row: row.row, ...(row.employeeCode ? { reference: row.employeeCode } : {}), ...(name ? { employeeName: name } : {}),
    ...text, stage: system ? 'system' : stage, result: stage === 'check' ? 'refused' : 'not_saved',
  };
}
