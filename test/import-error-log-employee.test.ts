/**
 * Board d3ba1e9f part 1 — the Error Log adapters of "Everything — new employees" and the section imports (Profile,
 * Family, Qualifications, Emergency Contacts): Excel rows (blank rows counted), the field caption, the entered value
 * (hidden for sensitive columns), the translated problem and common correction, the result after an all-or-nothing
 * refusal, company scoping of Import History lines, and the downloaded workbook carrying exactly the adapter's lines.
 * No database; fictional data only.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import { HIDDEN_VALUE, importProblemColumns, importProblemCells, sortProblemLines } from '../lib/import-problem-lines';
import { importProblemSheetRows, importProblemWorkbook } from '../lib/import-problem-workbook';
import { csvDataExcelRows, excelRowOf, isHiddenImportColumn, sanitizeImportSourceRows, type ImportProblemTranslate } from '../lib/import-problem-common';
import { employeeHistoryProblemLines, employeePreviewProblemLines, employeeResultProblemLines } from '../lib/employee-import-problems';
import { sectionPreviewProblemLines, sectionResultProblemLines, sectionRunProblemLines } from '../lib/section-import-problems';
import { cancelledRowMessage, employeeImportReport, isCancelledRowMessage, scopeEmployeeImportIssues, scopeEmployeeImportReport } from '../lib/employee-import-report';
import { workbookDataRowNumbers } from '../lib/spreadsheet';
import { IMPORT_ERROR_LOG_KINDS, hasImportErrorLog } from '../lib/import-error-log-kinds';
import type { ImportPreview, ImportResult } from '../lib/import-schema';
import { personnelColumnLabel } from '../lib/personnel-import-contract';
import type { SectionImportPreview, SectionImportResult } from '../lib/import-sections';

const CATALOGUES = { en, ms, zh, ta, th, vi } as Record<string, typeof en>;
const tr = (locale: string): ImportProblemTranslate => {
  const root = createTranslator({ locale, messages: CATALOGUES[locale] });
  const shared = createTranslator({ locale, messages: CATALOGUES[locale], namespace: 'importProblems' });
  return { problems: (key, values) => root(key as never, values as never), shared: (key) => shared(key as never) };
};
const t = tr('en');
const sharedT = (key: string) => t.shared(key);

const preview: ImportPreview = {
  companyId: 'co-a', total: 3, validCount: 1, missingColumns: [],
  fileErrors: ['The Family sheet names Employee ID "F9999", which is not on the employee sheet. Nothing was imported — add the employee, or correct the ID, and upload again.'],
  rows: [
    { rowNum: 1, excelRow: 2, employeeCode: 'E001', fullName: 'Fictional Aina', email: 'aina@fixture.test', ok: false, warnings: [], company: 'Acme',
      errors: ['Unknown department "Finanse"', 'Invalid IC "910505051234" (expected 12 digits)'],
      issues: [{ column: 'department', code: 'unknown_reference', value: 'Finanse', message: 'Unknown department "Finanse"' }, { column: 'ic_number', message: 'Invalid IC "910505051234" (expected 12 digits)' }] },
    { rowNum: 2, excelRow: 5, employeeCode: 'E002', fullName: 'Fictional Bala', email: 'bala@fixture.test', ok: true, errors: [], warnings: [], company: 'Acme' },
    // An older preview shape: no Excel row, no issue list — data row + 1 and the plain message.
    { rowNum: 3, fullName: 'Fictional Chen', email: '', ok: false, errors: ['Missing email'], warnings: [], company: 'Acme' },
  ],
  dependents: { total: 1, validCount: 0, missingColumns: [], rows: [
    { rowNum: 1, excelRow: 4, employeeCode: 'F9999', fullName: 'Ghost Child', relationship: 'child', ok: false, errors: ['Employee ID "F9999" is not on the employee sheet'],
      issues: [{ column: 'employee_code', code: 'not_on_employee_sheet', value: 'F9999', message: 'Employee ID "F9999" is not on the employee sheet' }] },
  ] },
};

describe('Excel rows', () => {
  it('a workbook with blank rows numbers each record as Excel does (header, frame and blank rows counted)', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['full_name', 'email'], ['A', 'a@x.test'], [], ['B', 'b@x.test'], [null, '  '], ['C', 'c@x.test']]), 'Employee Import');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['AI-HR Personnel CSV', '1', 'family'], ['employee_code', 'full_name'], [], ['E1', 'Kid']]), 'Family');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const rows = await workbookDataRowNumbers(bytes, ['Family', 'Qualifications']);
    expect(rows.first).toEqual([2, 4, 6]);
    expect(rows.extra).toEqual({ Family: [4] });
    expect(excelRowOf(rows.first, 2)).toBe(4);
    expect(excelRowOf(rows.first, 3)).toBe(6);
    // Without captured rows (a paste): data row + 1.
    expect(excelRowOf(undefined, 3)).toBe(4);
  });
  it('a CSV keeps its blank lines; a Personnel frame row is counted', () => {
    expect(csvDataExcelRows('full_name,email\nA,a@x.test\n\nB,b@x.test\n')).toEqual([2, 4]);
    expect(csvDataExcelRows('AI-HR Personnel CSV,1,employee\nfull_name\nA\n')).toEqual([3]);
  });
  it('client rows are bounded, increasing and must match the parsed record count', () => {
    expect(sanitizeImportSourceRows({ employee: [2, 4, 6], family: [3, 3], qualification: 'x', emergency: [1] }, { employee: 3 })).toEqual({ employee: [2, 4, 6] });
    expect(sanitizeImportSourceRows({ employee: [2, 4] }, { employee: 3 })).toEqual({});
    expect(sanitizeImportSourceRows(null)).toEqual({});
  });
});

describe('Everything — check screen lines', () => {
  const lines = employeePreviewProblemLines(preview, t);
  it('whole-file problems come first with no row; every row problem has its Excel row, field, value and fix', () => {
    const sorted = sortProblemLines(lines);
    expect(sorted[0]).toMatchObject({ row: null, stage: 'file', result: 'refused' });
    expect(sorted[0].problem).toMatch(/names Employee ID "F9999"/);
    const dept = lines.find((l) => l.field === 'Department')!;
    expect(dept).toMatchObject({ sheet: 'Employee Import', row: 2, reference: 'E001', employeeName: 'Fictional Aina', value: 'Finanse', stage: 'check', result: 'refused',
      problem: 'Unknown department "Finanse"', correction: 'Choose a Department from the Reference sheet.' });
    const family = lines.find((l) => l.sheet === 'Family')!;
    expect(family).toMatchObject({ row: 4, reference: 'F9999', value: 'F9999', correction: en.importErrorLogEmployee.correction.notOnEmployeeSheet });
    expect(lines.find((l) => l.reference === undefined && l.row === 4 && l.sheet === 'Employee Import')?.problem).toBe('Missing email');
  });
  it('never repeats an identity number: the value is hidden and the quoted value in the sentence is masked', () => {
    const ic = lines.find((l) => /Invalid IC/.test(l.problem))!;
    expect(ic.value === undefined || ic.value === HIDDEN_VALUE).toBe(true);
    expect(ic.problem).toBe('Invalid IC "(hidden)" (expected 12 digits)');
    const rows = importProblemSheetRows({ lines, t: sharedT });
    expect(JSON.stringify(rows)).not.toContain('910505051234');
    expect(isHiddenImportColumn('ic_number')).toBe(true);
    expect(isHiddenImportColumn('bank_account_no')).toBe(true);
    expect(isHiddenImportColumn('basic_salary')).toBe(true);
    expect(isHiddenImportColumn('epf_number')).toBe(true);
    expect(isHiddenImportColumn('passport_number')).toBe(true);
    expect(isHiddenImportColumn('full_name')).toBe(false);
    expect(isHiddenImportColumn('employee_code')).toBe(false);
    expect(isHiddenImportColumn('department')).toBe(false);
  });
  it('the downloaded workbook holds exactly the adapter lines, Excel rows as numbers', () => {
    const bytes = importProblemWorkbook({ lines, t: sharedT, summary: [[sharedT('summary.file'), 'staff.xlsx'], [sharedT('summary.problems'), lines.length]] });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors, { header: 1, raw: false, defval: '' });
    expect(sheet).toEqual(importProblemSheetRows({ lines, t: sharedT }));
    const cols = importProblemColumns(sortProblemLines(lines));
    const deptRow = sortProblemLines(lines).findIndex((l) => l.field === 'Department') + 1;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Errors, { header: 1, raw: true });
    expect(raw[deptRow][cols.indexOf('row')]).toBe(2);
    expect(wb.SheetNames).toEqual(['Errors', 'Summary']);
  });
  it('the common corrections read in every locale', () => {
    for (const [locale, messages] of Object.entries(CATALOGUES)) {
      const line = employeePreviewProblemLines(preview, tr(locale)).find((l) => l.reference === 'E001' && l.value === 'Finanse')!;
      expect(line.field, locale).toBeTruthy();
      expect(line.correction, locale).toBe(messages.importErrorLogEmployee.correction.reference.replace('{field}', line.field!));
      expect(line.correction, locale).not.toContain('{');
    }
  });
});

describe('Everything — result after an all-or-nothing refusal', () => {
  const result: ImportResult = {
    companyId: 'co-a', imported: 0, skipped: 1, dependentsImported: 0, superiorFailed: [], runId: null, attemptId: 'a1',
    fileErrors: ['No employee was saved. Row 5 could not be saved, so the whole file was cancelled. Fix the rows listed and upload the whole file again.'],
    failed: [
      { rowNum: 2, email: 'bala@fixture.test', message: 'This change was refused by a safeguard that protects existing records, such as a closed payroll. Reference DB-R-7F3A2C.' },
      { rowNum: 6, email: 'dina@fixture.test', message: cancelledRowMessage([5]) },
    ],
  };
  const lines = employeeResultProblemLines(result, preview, t);
  it('names the refused row as stopped and every other valid row as cancelled; no row reads as imported', () => {
    const stopped = lines.filter((l) => l.result === 'stopped');
    expect(stopped.map((l) => l.row)).toEqual([5]);
    expect(stopped[0]).toMatchObject({ errorReference: 'DB-R-7F3A2C', stage: 'save', reference: 'E002', employeeName: 'Fictional Bala' });
    expect(stopped[0].problem).toBe(en.common.databaseError.rule.replace('{ref}', 'DB-R-7F3A2C'));
    const cancelled = lines.filter((l) => l.result === 'cancelled');
    expect(cancelled.map((l) => l.row)).toEqual([7]);
    expect(cancelled[0].problem).toBe(en.people.importHistory.errorReport.cancelledRow.replace('{rows}', '5'));
    expect(lines.filter((l) => l.result === 'refused').length).toBeGreaterThan(0);
    const results = importProblemSheetRows({ lines, t: sharedT }).slice(1).map((r) => r.at(-2) ?? '');
    expect(results.join(' ')).not.toMatch(/Saved|Imported/);
    expect(isCancelledRowMessage(cancelledRowMessage([]))).toBe(true);
    expect(isCancelledRowMessage('Missing email')).toBe(false);
  });
});

describe('Everything — Import History lines', () => {
  const plan = { rows: [
    { rowNum: 1, excelRow: 2, fullName: 'Fictional One', employeeCode: 'F001', companyId: 'co-a', ok: true, errors: [] },
    { rowNum: 2, excelRow: 4, fullName: 'Fictional Two', employeeCode: 'F002', companyId: 'co-b', ok: false, errors: ['Missing department'],
      issues: [{ column: 'department', code: 'required', message: 'Missing department' }] },
    { rowNum: 3, excelRow: 5, fullName: 'Fictional Three', employeeCode: 'F003', companyId: 'co-b', ok: true, errors: [] },
  ] };
  const events = [{ kind: 'failed', detail: { message: 'x', rows: [{ rowNum: 3, excelRow: 5, employeeCode: 'F003', fullName: 'Fictional Three', companyId: 'co-b', outcome: 'stopped', message: 'refused', column: 'email' }] } }];
  const fileIssues = [{ rowNum: 0, reason: 'Some Family values were refused by the Personnel owner. Correct those rows before importing; nothing will be written.' }, { rowNum: 2, reason: 'Row 4 (Fictional Two): Missing department' }];
  it('builds the lines from what the attempt recorded, Excel rows included', () => {
    const report = employeeImportReport(plan, events);
    expect(report.stoppedByRows).toEqual([5]);
    const lines = employeeHistoryProblemLines({ report, fileIssues }, t);
    expect(lines.map((l) => [l.row, l.result])).toEqual([[null, 'refused'], [2, 'cancelled'], [4, 'refused'], [5, 'stopped']]);
    expect(lines[1].problem).toBe(en.people.importHistory.errorReport.cancelledRow.replace('{rows}', '5'));
    expect(lines[2]).toMatchObject({ field: 'Department', correction: 'Fill in Department - it is required.' });
  });
  it('an older attempt without Excel rows numbers its rows data row + 1', () => {
    const old = employeeImportReport({ rows: plan.rows.map(({ excelRow: _x, ...r }) => r) }, [{ kind: 'failed', detail: { message: 'x', rows: [{ ...events[0].detail.rows[0], excelRow: undefined }] } }]);
    expect(employeeHistoryProblemLines({ report: old, fileIssues: [] }, t).map((l) => l.row)).toEqual([2, 3, 4]);
  });
  it('a viewer without a company sees none of its lines, nor the whole-file sentences', () => {
    const report = scopeEmployeeImportReport(employeeImportReport(plan, events), new Set(['co-a']), false);
    const lines = employeeHistoryProblemLines({ report, fileIssues: scopeEmployeeImportIssues(fileIssues, plan, new Set(['co-a']), false) }, t);
    expect(lines.map((l) => l.reference)).toEqual(['F001']);
    expect(JSON.stringify(lines)).not.toMatch(/Fictional Two|Fictional Three|F002|F003|Family values/);
  });
});

describe('Section imports — check, result and run log', () => {
  const sectionPreview = {
    section: 'profile', total: 2, updateCount: 0, skipCount: 0, createCount: 1, missingColumns: [], fileErrors: [],
    rows: [
      { rowNum: 1, excelRow: 3, employeeCode: 'P404', employeeName: '', verdict: 'create', ok: false, warnings: [], changes: [],
        errors: ['No employee has Employee ID "P404".'], issues: [{ column: 'employee_code', code: 'employee_not_found', value: 'P404', message: 'No employee has Employee ID "P404".' }] },
      { rowNum: 2, excelRow: 6, employeeCode: 'P001', employeeName: 'Fictional Dewi', verdict: 'update', ok: false, warnings: [], changes: [],
        errors: ['Duplicate email in this file — row 3 already assigns "x@fixture.test"'], issues: [{ column: 'email', code: 'duplicate_in_file', value: 'x@fixture.test', message: 'Duplicate email in this file — row 3 already assigns "x@fixture.test"' }] },
    ],
  } as unknown as SectionImportPreview;
  it('every refused row carries its Excel row, field, value and correction', () => {
    const lines = sectionPreviewProblemLines(sectionPreview, t);
    const resolve = (key: string, fallback: string) => { const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en); return typeof v === 'string' ? v : fallback; };
    expect(lines.map((l) => [l.row, l.field, l.value, l.result])).toEqual([
      [3, personnelColumnLabel('employee_code', 'employee', resolve), 'P404', 'refused'], [6, personnelColumnLabel('email', 'employee', resolve), 'x@fixture.test', 'refused']]);
    expect(lines[0].correction).toBe(en.importErrorLogEmployee.correction.employeeNotFound);
    expect(lines[1].correction).toBe(en.importErrorLogEmployee.correction.duplicateInFile);
  });
  it('the result lists the rows the check refused and the rows whose save failed (other rows saved)', () => {
    const result: SectionImportResult = { section: 'profile', updated: 3, skipped: 2, failed: [{ rowNum: 2, employeeCode: 'P001', message: 'Could not save the profile of this employee.' }], fileErrors: [], runId: null };
    const lines = sectionResultProblemLines(result, sectionPreview, t);
    expect(lines.map((l) => [l.row, l.stage, l.result])).toEqual([[3, 'check', 'refused'], [6, 'check', 'refused'], [6, 'save', 'not_saved']]);
  });
  it('a run log line is built from what the run recorded; an older run numbers data row + 1', () => {
    const lines = sectionRunProblemLines({ kind: 'family', errors: [
      { rowNum: 4, excelRow: 9, fullName: 'Fictional Dewi', employeeCode: 'P001', email: '', errors: ['Missing relationship'], issues: [{ column: 'relationship', code: 'required', message: 'Missing relationship' }], stage: 'check', outcome: 'refused' },
      { rowNum: 7, fullName: 'P002', email: '', errors: ['Could not save.'] },
    ] }, t);
    expect(lines.map((l) => [l.row, l.reference ?? null, l.result])).toEqual([[9, 'P001', 'refused'], [8, null, 'refused']]);
    expect(lines[0].correction).toMatch(/^Fill in /);
  });
});

describe('Error Log on Import History entries', () => {
  it('lists this build’s kinds; a run recorded before its type was still offers the log', () => {
    expect([...IMPORT_ERROR_LOG_KINDS]).toEqual(['employee_full', 'profile', 'family', 'qualification', 'emergency']);
    expect(hasImportErrorLog('employee_full')).toBe(true);
    expect(hasImportErrorLog('movement')).toBe(false);
    expect(hasImportErrorLog(null, 'run')).toBe(true);
    expect(hasImportErrorLog(null, 'attempt')).toBe(false);
  });
  it('table cells and workbook rows are the same strings', () => {
    const lines = employeePreviewProblemLines(preview, t);
    const sorted = sortProblemLines(lines), cols = importProblemColumns(sorted);
    expect(importProblemSheetRows({ lines, t: sharedT }).slice(1)).toEqual(sorted.map((l) => importProblemCells(l, cols, sharedT)));
  });
});
