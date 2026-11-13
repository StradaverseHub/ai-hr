/**
 * Board d3ba1e9f — the Bank and Statutory import's ONE Error Log adapter: persisted bank_import_row problem rows
 * (refused at the check, or not saved) -> ImportProblemLine[]. The progress screen (first 200 lines), the streamed
 * Error Log download (every line, lib/import-problem-workbook-stream.ts) and Import History all call this, so the
 * screen and the file say the same thing.
 *
 * Client-safe (no database, no React). Rows are numbered as Excel numbers them: the template's header is row 1, so
 * data row N (bank_import_row.ordinal) is Excel row N+1.
 *
 * Values: bank account, statutory, identity, payroll and restricted fields are never repeated (HIDDEN_VALUE), per
 * the personnel field registry's sensitivity; Employee ID and the employee's name are not masked.
 */
import { HIDDEN_VALUE, type ImportProblemColumn, type ImportProblemLine } from './import-problem-lines';
import { personnelColumnLabel, personnelImportField } from './personnel-import-contract';
import { sectionParseColumns } from './import-sections';
import { correctionText, matchProblem, systemProblem, type ImportProblemRule, type ImportProblemText } from './import-problem-rules';

/** A persisted problem row, as the problems endpoint, the stream and Import History read it. */
export type BankProblemRow = {
  ordinal: number;
  state: string;
  error: string | null;
  preview: { employeeCode?: string; employeeName?: string; errors?: string[] } | null;
  /** The row's cells by column key. Sensitive cells may be redacted to any non-empty marker. */
  record?: Record<string, string> | null;
};

const HIDDEN_SENSITIVITY = new Set(['identity', 'bank', 'payroll', 'statutory', 'restricted']);
const SENSITIVE_NAME = /(^|_)(nric|ic|passport|account|epf|socso|eis|tax|salary|pcb|zakat|lhdn|kwsp|perkeso|hrdf)(_|$)/;

/** Whether a Bank and Statutory column's value must not be repeated in the Error Log or on screen. */
export function bankColumnHidden(column: string): boolean {
  if (column === 'employee_code' || column === 'full_name') return false;
  const field = personnelImportField(column, 'employee');
  return (field ? HIDDEN_SENSITIVITY.has(field.sensitivity) : false) || SENSITIVE_NAME.test(column);
}

/** The record as it may leave the server for the screen: sensitive cells become a marker, never their value. */
export function redactBankRecord(record: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, raw] of Object.entries(record ?? {})) {
    const value = raw == null ? '' : String(raw);
    out[column] = bankColumnHidden(column) ? (value.trim() ? '*' : '') : value;
  }
  return out;
}

/** The fixed Error Log columns (the stream must know them before the first row). */
export function bankProblemColumns(withReference: boolean): ImportProblemColumn[] {
  return ['row', 'reference', 'employeeName', 'field', 'value', 'problem', 'correction', 'stage', 'result', ...(withReference ? ['errorReference' as const] : [])];
}

/** Sentences the Bank and Statutory check and save write today (lib/bank-import-source.server.ts, core/bank-import-worker.ts,
 *  and the shared section analyzer). English text of every key is the sentence itself. */
const RULES: readonly ImportProblemRule[] = [
  { re: /^Duplicate Employee ID in this file; first used at row (\d+)\.$/, key: 'duplicateEmployeeId', values: m => ({ row: Number(m[1]) + 1 }), field: 'employee_code', correction: 'duplicateEmployeeInFile' },
  { re: /^Duplicate Card ID in this file\.$/, key: 'duplicateCardId', field: 'card_id', correction: 'duplicateInFile' },
  { re: /^Duplicate card_id in this file\.$/, key: 'duplicateCardId', field: 'card_id', correction: 'duplicateInFile' },
  { re: /^card_id already identifies another employee; choose an unused card ID\.$/, key: 'cardIdTaken', field: 'card_id' },
  { re: /^You do not have permission to update this employee\.$/, key: 'noPermission', correction: 'permission' },
  { re: /^This row was not saved\. Its data or permissions changed after validation; review and import it again\.$/, key: 'changedAfterValidation', correction: 'revalidate' },
  { re: /^Missing employee_code — it is the link to the employee being updated$/, key: 'missingEmployeeId', field: 'employee_code', correction: 'required' },
  { re: /^No employee has Employee ID "(.*)"\. A section file can only UPDATE people who are already in the system/, key: 'unknownEmployee', values: m => ({ code: m[1] }), field: 'employee_code', value: m => m[1], correction: 'existingEmployee' },
  { re: /^Duplicate employee_code in this file$/, key: 'duplicateEmployeeCode', field: 'employee_code', correction: 'duplicateEmployeeInFile' },
  { re: /^Bank Transfer requires a bank name and account number\.$/, key: 'bankTransferNeedsBank', field: 'payment_method', correction: 'bankPair' },
  { re: /^bank_name and bank_account_no must be provided together$/, key: 'bankPair', field: 'bank_account_no', correction: 'bankPair' },
  { re: /^This employee has no statutory record yet — save their identity number on their Personnel record first, then re-run this file$/, key: 'noStatutoryRecordYet', correction: 'statutoryRecord' },
  { re: /^This employee has no statutory record; complete the Personnel statutory setup first\.$/, key: 'noStatutoryRecord', correction: 'statutoryRecord' },
  { re: /^"(.*)" is not an active (.+) option — column (\S+)$/, key: 'notActiveOption', values: m => ({ value: m[1], category: m[2], column: m[3] }), field: m => m[3], value: m => m[1], correction: 'chooseReference' },
  { re: /^(\S+) must be yes or no$/, key: 'yesNo', values: m => ({ column: m[1] }), field: m => m[1], correction: 'yesNo' },
  // Kept verbatim (shared analyzer wording); only the field and the common correction are added.
  { re: /^(\w+): invalid (date|year and month) value$/, field: m => m[1], correction: 'date' },
  { re: /^(\w+): invalid choice value$/, field: m => m[1], correction: 'chooseReference' },
  { re: /^(\w+): invalid (.+) value$/, field: m => m[1] },
  { re: /must be YYYY-MM-DD/, correction: 'date' },
];

type ColumnMatcher = { column: string; caption: string; re: RegExp };
let matchersCache: ColumnMatcher[] | undefined;
/** Built once: the template's columns with their English captions and a whole-word matcher (no per-line RegExp). */
const columnMatchers = () => (matchersCache ??= sectionParseColumns('bank_statutory').map(column => ({
  column, caption: personnelColumnLabel(column, 'employee'), re: new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`),
})));

/** The field a sentence names: a rule's field, else the template caption it starts with ("EPF Category: ..."),
 *  else the first template column key it mentions. */
function mentionedColumn(message: string): string | undefined {
  const matchers = columnMatchers();
  const prefix = /^([^:]{1,80}):\s/.exec(message)?.[1];
  if (prefix) {
    const byCaption = matchers.find(m => m.column === prefix || m.caption === prefix);
    if (byCaption) return byCaption.column;
  }
  let best: { column: string; at: number } | undefined;
  for (const m of matchers) {
    const at = message.search(m.re);
    if (at >= 0 && (!best || at < best.at || (at === best.at && m.column.length > best.column.length))) best = { column: m.column, at };
  }
  return best?.column;
}

/** Field caption as the Bank and Statutory template heads it, in the viewer's language where translated. */
export function bankFieldCaption(column: string, t: ImportProblemText): string {
  const resolve = (key: string, fallback: string) => (t.has ? (t.has(key) ? t(key) : fallback) : fallback);
  return personnelColumnLabel(column, 'employee', resolve);
}

/** One line per problem sentence of each row, in row order (sortProblemLines order). */
export function bankImportProblemLines(rows: readonly BankProblemRow[], t: ImportProblemText): ImportProblemLine[] {
  const lines: ImportProblemLine[] = [];
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    const failed = row.state === 'failed';
    const messages = failed ? [row.error ?? ''] : [...(row.preview?.errors ?? []), ...(row.error && !(row.preview?.errors ?? []).includes(row.error) ? [row.error] : [])];
    const reference = row.preview?.employeeCode || row.record?.employee_code || undefined;
    const employeeName = row.preview?.employeeName || undefined;
    for (const message of messages.filter(Boolean)) {
      const base = { row: row.ordinal + 1, reference, employeeName, result: failed ? 'not_saved' as const : 'refused' as const };
      const system = systemProblem(message, t);
      if (system) { lines.push({ ...base, ...system }); continue; }
      let matched = matchProblem(message, RULES, 'bank', t);
      const column = matched.field ?? mentionedColumn(message);
      // A sensitive value the sentence quotes is replaced by the hidden marker in the sentence too.
      if (column && bankColumnHidden(column) && matched.value) matched = { ...matchProblem(message.replace(`"${matched.value}"`, `"${t('importProblems.hiddenValue')}"`), RULES, 'bank', t), value: matched.value };
      const cell = column ? row.record?.[column] : undefined;
      const value = column && bankColumnHidden(column) ? (cell?.trim() || matched.value ? HIDDEN_VALUE : undefined) : (matched.value ?? (cell?.trim() ? cell : undefined));
      lines.push({
        ...base,
        ...(column ? { field: bankFieldCaption(column, t) } : {}),
        ...(value !== undefined ? { value } : {}),
        problem: matched.problem,
        ...(matched.correction ? { correction: matched.correction } : {}),
        stage: failed ? 'save' : 'check',
      });
    }
  }
  return lines;
}

/** A job-level failure (the whole file stopped) as the first line of the log, with its support reference. */
export function bankJobProblemLine(error: string | null | undefined, t: ImportProblemText): ImportProblemLine | null {
  if (!error) return null;
  const ref = /\bReference (DB-[SPDLVRBN]-[0-9A-F]{6})\.$/.exec(error);
  if (ref) return { row: null, problem: t('importErrorLogDataBankCostInfo.bank.jobStopped', { ref: ref[1] }), correction: correctionText('systemError', t), stage: 'system', result: 'not_saved', errorReference: ref[1] };
  const system = systemProblem(error, t);
  if (system) return { row: null, ...system, result: 'not_saved' };
  const known: Record<string, string> = {
    'The file exceeds the import size or worksheet limits. Use up to 250,000 rows and 128 MiB.': 'fileTooLarge',
    'The file could not be read. Use the Bank & Statutory template and its reference sheets.': 'fileUnreadable',
    'Choose a file with 1 to 250,000 data rows.': 'fileRowCount',
    'The uploaded file is incomplete or its checksum differs. Upload it again.': 'fileIncomplete',
    'Import stopped. Rows already saved are retained. Review the result and your access before trying again.': 'jobStoppedEarlier',
  };
  const key = known[error];
  if (key === 'jobStoppedEarlier') return { row: null, problem: t(`importErrorLogDataBankCostInfo.bank.${key}`), correction: correctionText('systemError', t), stage: 'system', result: 'not_saved' };
  return { row: null, problem: key ? t(`importErrorLogDataBankCostInfo.bank.${key}`) : error, correction: correctionText('template', t), stage: 'file', result: 'not_saved' };
}
