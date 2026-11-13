/**
 * Board d3ba1e9f (part 2) — the Error Log adapters of Bank and Statutory, Cost Center Allocations and
 * Information-Only Correction: exact Excel rows, field captions, masked values, translated problems and corrections
 * (every locale for at least one sentence), and screen/file parity (the table's cells are the workbook's rows).
 * Pure functions over fictional data; no database.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createTranslator } from 'next-intl';
import { HIDDEN_VALUE, importProblemCells, importProblemColumns, sortProblemLines, type ImportProblemLine } from '../lib/import-problem-lines';
import { importProblemSheetRows, importProblemWorkbook } from '../lib/import-problem-workbook';
import { importProblemText } from '../lib/import-problem-rules';
import { bankColumnHidden, bankImportProblemLines, bankJobProblemLine, redactBankRecord } from '../lib/bank-import-problems';
import { costAllocationProblemLines } from '../lib/cost-allocation-import-problems';
import { informationCorrectionProblemLines } from '../lib/information-correction-problems';
import { unexpectedErrorReference, publicUnexpectedErrorMessage, DATABASE_ERROR_TEXT_EN } from '../lib/public-error';
import { parseDatabaseErrorRef } from '../lib/database-error-token';
import { personnelColumnLabel } from '../lib/personnel-import-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import { vi as vitest } from 'vitest';

const LOCALES = { en, ms, zh, ta, th, vi } as Record<string, typeof en>;
const root = (locale: string) => importProblemText(createTranslator({ locale, messages: LOCALES[locale] }) as never);
const shared = (locale: string) => createTranslator({ locale, messages: LOCALES[locale], namespace: 'importProblems' }) as unknown as (key: string) => string;
const ns = (locale: string) => (LOCALES[locale] as unknown as { importErrorLogDataBankCostInfo: Record<string, Record<string, unknown>> }).importErrorLogDataBankCostInfo;

/** Screen cells (what ImportProblemTable renders) and file rows (what the workbook holds) for the same lines. */
function parity(lines: readonly ImportProblemLine[], locale: string) {
  const t = shared(locale), sorted = sortProblemLines(lines), columns = importProblemColumns(sorted);
  const screen = sorted.map(line => importProblemCells(line, columns, t));
  const book = XLSX.read(importProblemWorkbook({ lines, t }), { type: 'array' });
  const file = (XLSX.utils.sheet_to_json<(string | number)[]>(book.Sheets.Errors, { header: 1, raw: false, defval: '' }) as string[][])
    .slice(1).map(r => r.map(String).map(c => c.replace(/^'(?=[\s]*[=+\-@\t\r])/, '')));
  expect(screen.length).toBeGreaterThan(0);
  expect(file).toEqual(screen);
  expect(importProblemSheetRows({ lines, t }).slice(1)).toEqual(screen);
  return { screen, columns };
}

describe('Bank and Statutory adapter', () => {
  const rows = [
    { ordinal: 1, state: 'invalid', error: null, record: redactBankRecord({ employee_code: 'EMP-0001', bank_name: 'Bank Fiktif', bank_account_no: '1234567890' }),
      preview: { employeeCode: 'EMP-0001', employeeName: 'Fictional Aina', errors: ['bank_name and bank_account_no must be provided together', '"Bank Fiktif" is not an active bank option — column bank_name'] } },
    { ordinal: 4, state: 'invalid', error: 'Duplicate Employee ID in this file; first used at row 1.', record: { employee_code: 'EMP-0001' }, preview: { employeeCode: 'EMP-0001', employeeName: 'Fictional Aina', errors: [] } },
    { ordinal: 7, state: 'invalid', error: null, record: { employee_code: 'NOPE-7' },
      preview: { employeeCode: 'NOPE-7', employeeName: '', errors: ['No employee has Employee ID "NOPE-7". A section file can only UPDATE people who are already in the system — it cannot add anyone. To add this person, choose "Everything — new employees" at the top of this page and use the full employee template, then run this file again.'] } },
    { ordinal: 9, state: 'failed', error: 'This row was not saved. Its data or permissions changed after validation; review and import it again.', record: {}, preview: { employeeCode: 'EMP-0009', employeeName: 'Fictional Wei', errors: [] } },
  ];

  it('numbers rows as Excel does, names fields, masks bank values and gives the common corrections', () => {
    const t = root('en'), lines = bankImportProblemLines(rows, t);
    expect(lines.map(l => [l.row, l.reference, l.stage, l.result])).toEqual([
      [2, 'EMP-0001', 'check', 'refused'], [2, 'EMP-0001', 'check', 'refused'], [5, 'EMP-0001', 'check', 'refused'], [8, 'NOPE-7', 'check', 'refused'], [10, 'EMP-0009', 'save', 'not_saved'],
    ]);
    expect(lines[0].field).toBe(personnelColumnLabel('bank_account_no', 'employee', (key, fallback) => (t.has!(key) ? t(key) : fallback)));
    expect(lines[0].field).toMatch(/bank/i);
    expect(lines[0]).toMatchObject({ value: HIDDEN_VALUE, problem: 'bank_name and bank_account_no must be provided together', correction: 'Enter the bank name and the bank account number together.' });
    // A quoted sensitive value is hidden in the sentence too.
    expect(lines[1].value).toBe(HIDDEN_VALUE);
    expect(lines[1].problem).toBe('"(hidden)" is not an active bank option — column bank_name');
    expect(JSON.stringify(lines)).not.toContain('Bank Fiktif');
    expect(JSON.stringify(lines)).not.toContain('1234567890');
    expect(lines[2]).toMatchObject({ field: en.people.detail.employeeIdLabel, value: 'EMP-0001', problem: 'Duplicate Employee ID in this file; first used at Excel row 2.', correction: 'This Employee ID appears more than once in the file - keep one row.' });
    expect(lines[3]).toMatchObject({ field: en.people.detail.employeeIdLabel, value: 'NOPE-7', correction: 'Check the Employee ID. A new employee must be added with "Everything - new employees" first.' });
    expect(lines[3].problem).toBe(rows[2].preview.errors[0]);
    expect(lines[4]).toMatchObject({ problem: rows[3].error, correction: 'Upload the corrected file again so the row is checked again.' });
    expect(bankColumnHidden('bank_account_no')).toBe(true);
    expect(bankColumnHidden('epf_number')).toBe(true);
    expect(bankColumnHidden('employee_code')).toBe(false);
    expect(redactBankRecord({ bank_account_no: '99', employee_code: 'E1', bank_name: '' })).toEqual({ bank_account_no: '*', employee_code: 'E1', bank_name: '' });
  });

  it.each(Object.keys(LOCALES))('translates the problem and the correction (%s) and the screen equals the file', locale => {
    const lines = bankImportProblemLines(rows, root(locale));
    const bank = ns(locale).bank as Record<string, string>, corrections = ns(locale).corrections as Record<string, string>;
    expect(lines[2].problem).toBe(bank.duplicateEmployeeId.replace('{row}', '2'));
    expect(lines[2].correction).toBe(corrections.duplicateEmployeeInFile);
    expect(lines[4].problem).toBe(bank.changedAfterValidation);
    parity(lines, locale);
  });

  it('puts a stopped job first with its support reference', () => {
    const t = root('ms');
    const line = bankJobProblemLine('Import stopped. Rows already saved are retained. Review the result and your access before trying again. Reference DB-S-0A1B2C.', t)!;
    expect(line).toMatchObject({ row: null, stage: 'system', result: 'not_saved', errorReference: 'DB-S-0A1B2C' });
    expect(line.problem).toBe((ns('ms').bank as Record<string, string>).jobStopped.replace('{ref}', 'DB-S-0A1B2C'));
    expect(bankJobProblemLine(null, t)).toBeNull();
    expect(bankJobProblemLine('The file could not be read. Use the Bank & Statutory template and its reference sheets.', root('en'))).toMatchObject({ row: null, stage: 'file', problem: 'The file could not be read. Use the Bank & Statutory template and its reference sheets.' });
    const { screen } = parity([line, ...bankImportProblemLines(rows, t)], 'ms');
    expect(screen[0][0]).toBe(ms.importProblems.wholeFile);
  });
});

describe('Cost Center Allocations adapter', () => {
  const groups = [
    { key: 'ZZ|E1|2026-01-01', companyCode: 'ZZ', employeeCode: 'E1', effectiveDate: '2026-01-01', rowNums: [2, 3], errors: ['Rows 2, 3: Company Code "ZZ" does not match a company you can import for.'] },
    { key: 'ACME|E2|2026-01-01', companyCode: 'ACME', employeeCode: 'E2', effectiveDate: '2026-01-01', rowNums: [4, 5], errors: ['Row 4 (CC-X): this Cost Center Code is not available for ACME (Fictional Acme Sdn Bhd).', 'Row 5 (CC-Y): Enter a percentage greater than zero and at most 100, with up to two decimal places.'] },
    { key: 'ACME|E3|2026-02-01', companyCode: 'ACME', employeeCode: 'E3', effectiveDate: '2026-02-01', rowNums: [6], errors: [] },
  ];

  it('gives one line per named Excel row with the field, the entered value and the fix', () => {
    const lines = costAllocationProblemLines({ issues: [], groups, saveFailures: [{ key: 'ACME|E3|2026-02-01', employeeCode: 'E3', rowNums: [6], errors: ['This employee could not be saved; nothing was changed for them.'] }, { key: 'ZZ|E1|2026-01-01', employeeCode: 'E1', rowNums: [2, 3], errors: ['ignored: refused at the check'] }] }, root('en'));
    expect(lines.map(l => [l.row, l.reference, l.field, l.value, l.stage, l.result])).toEqual([
      [2, 'E1', 'Company Code', 'ZZ', 'check', 'refused'], [3, 'E1', 'Company Code', 'ZZ', 'check', 'refused'],
      [4, 'E2', 'Cost Center Code', 'CC-X', 'check', 'refused'], [5, 'E2', 'Percentage', undefined, 'check', 'refused'],
      [6, 'E3', undefined, undefined, 'save', 'not_saved'],
    ]);
    expect(lines[0]).toMatchObject({ problem: 'Company Code "ZZ" does not match a company you can import for.', correction: 'Choose a Company Code from the Reference sheet.' });
    expect(lines[2]).toMatchObject({ problem: 'This Cost Center Code is not available for ACME (Fictional Acme Sdn Bhd).', correction: 'Choose a Cost Center Code listed for this company on the Allocation Reference sheet.' });
    expect(lines[3].correction).toBe('Enter a percentage greater than 0 and at most 100, with up to two decimal places.');
  });

  it('puts a whole-file problem first, with no row', () => {
    const lines = costAllocationProblemLines({ issues: [{ reason: 'Missing allocation columns: percentage, operation' }], groups: [] }, root('zh'));
    expect(lines).toEqual([{ row: null, problem: '缺少分配列：percentage, operation', correction: zh.importErrorLogDataBankCostInfo.corrections.template, stage: 'file', result: 'not_saved' }]);
    parity(lines, 'zh');
  });

  it.each(Object.keys(LOCALES))('translates every recognised sentence (%s) and the screen equals the file', locale => {
    const lines = costAllocationProblemLines({ groups }, root(locale)), allocation = ns(locale).allocation as Record<string, string>;
    expect(lines[0].problem).toBe(allocation.companyUnknown.replace('{code}', 'ZZ'));
    expect(lines[0].correction).toBe((ns(locale).corrections as Record<string, string>).chooseCompany);
    parity(lines, locale);
  });
});

describe('Information-Only Correction adapter', () => {
  const rows = [
    { row: 2, employeeCode: 'EMP-001', values: { 'Employee Name': 'Fictional Farah', 'Join Date': '2026-13-40' }, errors: [] as string[], preview: { name: 'Fictional Farah' } },
    { row: 3, employeeCode: 'MISSING', values: { 'Company Code': 'DEMO', 'Job Grade': 'G9' }, errors: ['Job Grade is not an active system code.', 'Employee ID is unavailable.'] },
    { row: 5, employeeCode: 'EMP-005', values: {}, errors: ['Join Date: use YYYY-MM-DD or an Excel date.', 'Business Unit: "BU-X" is not an option for this company. Check the Business Units reference sheet.'] },
  ];

  it('names the Corrections sheet, the Excel row, the heading and the value, and marks save failures', () => {
    const lines = informationCorrectionProblemLines({ rows, saved: [{ row: 2, status: 'failed', errors: ['This change could not be completed because of a system error. If it keeps happening, report reference DB-S-ABCDEF.'] }, { row: 3, status: 'failed', errors: ['x'] }] }, root('en'));
    expect(lines.map(l => [l.sheet, l.row, l.reference, l.field, l.value, l.stage, l.result])).toEqual([
      ['Corrections', 3, 'MISSING', 'Job Grade', 'G9', 'check', 'refused'],
      ['Corrections', 3, 'MISSING', undefined, undefined, 'check', 'refused'],
      ['Corrections', 5, 'EMP-005', 'Join Date', undefined, 'check', 'refused'],
      ['Corrections', 5, 'EMP-005', 'Business Unit', 'BU-X', 'check', 'refused'],
      ['Corrections', 2, 'EMP-001', undefined, undefined, 'system', 'not_saved'],
    ]);
    expect(lines[1].problem).toBe('Employee ID is unavailable.');
    expect(lines[2]).toMatchObject({ problem: 'Use YYYY-MM-DD or an Excel date.', correction: 'Enter the date as YYYY-MM-DD or as an Excel date.' });
    expect(lines[3].problem).toBe('"BU-X" is not an option for this company. Check the Business Units reference sheet.');
    expect(lines[4]).toMatchObject({ employeeName: 'Fictional Farah', errorReference: 'DB-S-ABCDEF', problem: en.common.databaseError.system.replace('{ref}', 'DB-S-ABCDEF') });
    expect(sortProblemLines(lines).map(l => l.row)).toEqual([2, 3, 3, 5, 5]);
  });

  it('turns a refused file into one whole-file line', () => {
    expect(informationCorrectionProblemLines({ rows: [], fileError: 'Use the Corrections sheet from the Information-Only Correction template.' }, root('en')))
      .toEqual([{ row: null, problem: 'Use the Corrections sheet from the Information-Only Correction template.', stage: 'file', result: 'not_saved' }]);
  });

  it.each(Object.keys(LOCALES))('translates the problem and the correction (%s) and the screen equals the file', locale => {
    const lines = informationCorrectionProblemLines({ rows }, root(locale)), correction = ns(locale).correction as Record<string, string>;
    expect(lines[0].problem).toBe(correction.gradeInactive);
    expect(lines[2].problem).toBe(correction.date);
    parity(lines, locale);
  });
});

describe('unexpected errors carry a reference (lib/public-error.ts)', () => {
  it('logs the original under a short reference and shows only the plain sentence', () => {
    const log = vitest.spyOn(console, 'error').mockImplementation(() => {});
    const secret = new TypeError('Cannot read properties of undefined (reading "fictional internal detail")');
    const ref = unexpectedErrorReference(secret, 'test');
    expect(parseDatabaseErrorRef(ref)).toEqual({ kind: 'system', ref });
    const text = publicUnexpectedErrorMessage(secret, 'test');
    expect(text).not.toContain('fictional internal detail');
    const parsed = parseDatabaseErrorRef(text)!;
    expect(text).toBe(DATABASE_ERROR_TEXT_EN.system.replace('{ref}', parsed.ref));
    expect(String(log.mock.calls.at(-1)![0])).toContain(parsed.ref);
    expect(log.mock.calls.at(-1)![1]).toBe(secret);
    log.mockRestore();
  });
});
