/**
 * Item 1859cce0 — the pure pieces of employee import error reporting: the single contract-period rule, the report
 * built from Import History, company scoping, CSV formula safety, wording parity and the upload error classifier.
 * No database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contractPeriodIssues, CONTRACT_PERIOD_MESSAGES } from '../lib/contract-period';
import { employeeImportReport, scopeEmployeeImportReport, scopeEmployeeImportIssues, ownerRefusalColumn, cancelledRowMessage } from '../lib/employee-import-report';
import { employeeUploadErrorMessage, employeeProgressErrorMessage } from '../lib/employee-import-upload-errors';
import { toCsv } from '../lib/csv';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const messages = (l: string) => JSON.parse(readFileSync(`messages/${l}.json`, 'utf8'));
const leafKeys = (node: unknown, prefix = ''): string[] => typeof node === 'object' && node
  ? Object.entries(node).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k)) : [prefix];

describe('contract period rule (one owner for the import and setEmploymentInfo)', () => {
  const issues = (p: Parameters<typeof contractPeriodIssues>[0]) => contractPeriodIssues(p).map((i) => `${i.column}:${i.code}`);
  it('covers the matrix', () => {
    const hire = '2026-06-01';
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire })).toEqual(['contract_start_date:required', 'contract_end_date:required']);
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire, start: '2026-06-01' })).toEqual(['contract_end_date:required']);
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire, end: '2027-01-01' })).toEqual(['contract_start_date:required']);
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire, start: '2026-05-31', end: '2027-01-01' })).toEqual(['contract_start_date:before_hire']);
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire, start: '2026-06-01', end: '2026-06-01' })).toEqual(['contract_end_date:end_not_after_start']);
    expect(issues({ contract: true, requireBoth: true, hiredOn: hire, start: '2026-06-01', end: '2027-05-31' })).toEqual([]);
    expect(issues({ contract: false, requireBoth: true, hiredOn: hire })).toEqual([]);
    // The Personnel save requires both only when its submit carries the contract block.
    expect(issues({ contract: true, requireBoth: false, hiredOn: hire })).toEqual([]);
  });
  it('keeps the refusal text setEmploymentInfo has always thrown', () => {
    const org = readFileSync('core/org.ts', 'utf8');
    expect(org).toContain("import { contractPeriodIssues } from '../lib/contract-period'");
    for (const message of Object.values(CONTRACT_PERIOD_MESSAGES)) expect(org).not.toContain(`'${message}'`);
    expect(CONTRACT_PERIOD_MESSAGES.required).toBe('Contract start date and contract end date are required for a contract employee.');
    expect(ownerRefusalColumn(CONTRACT_PERIOD_MESSAGES.before_hire)).toBe('contract_start_date');
  });
});

const plan = {
  rows: [
    { rowNum: 1, fullName: 'Fictional One', employeeCode: 'F001', companyId: 'co-a', ok: true, errors: [] },
    { rowNum: 2, fullName: 'Fictional Two', employeeCode: 'F002', companyId: 'co-b', ok: false, errors: ['Contract Start Date is required when Employment Type is Contract.', 'x'],
      issues: [{ column: 'contract_start_date', code: 'contract.required', message: 'Contract Start Date is required when Employment Type is Contract.' }, { message: 'x' }] },
    { rowNum: 3, fullName: '=HYPERLINK("http://example.invalid")', employeeCode: '+F003', companyId: 'co-a', ok: true, errors: [] },
    { rowNum: 4, fullName: 'Fictional Four', employeeCode: 'F004', companyId: 'co-b', ok: true, errors: [] },
  ],
};
const failedEvents = [{ kind: 'previewed', detail: {} }, { kind: 'failed', detail: { message: 'x', rows: [{ rowNum: 4, employeeCode: 'F004', fullName: 'Fictional Four', companyId: 'co-b', outcome: 'stopped', message: 'refused', column: 'email' }] } }];

describe('error report from Import History', () => {
  it('lists every problem with its stage and every other row with its result', () => {
    const report = employeeImportReport(plan, failedEvents);
    expect(report.lines.map((l) => [l.rowNum, l.column, l.stage, l.outcome])).toEqual([
      [1, null, null, 'cancelled'], [2, 'contract_start_date', 'check', 'refused'], [2, null, 'check', 'refused'], [3, null, null, 'cancelled'], [4, 'email', 'save', 'stopped'],
    ]);
    expect(report.lines[0].stoppedBy).toEqual([4]);
    expect(report.counts).toEqual({ saved: 0, toFix: 2, cancelled: 2, total: 4 });
    expect(report.cancelledWhileSaving).toBe(true);
  });
  it('a confirmed import marks rows saved and an unfinished one pending; an older plan without issues still reads', () => {
    expect(employeeImportReport(plan, [{ kind: 'confirmed', detail: { succeeded: 3, failed: 1 } }]).lines.filter((l) => l.outcome === 'saved').map((l) => l.rowNum)).toEqual([1, 3, 4]);
    expect(employeeImportReport(plan, []).lines.filter((l) => l.outcome === 'pending').map((l) => l.rowNum)).toEqual([1, 3, 4]);
    expect(employeeImportReport({ rows: [{ rowNum: 1, ok: false, errors: ['Missing email'] }] }, []).lines[0]).toMatchObject({ message: 'Missing email', column: null, stage: 'check' });
    expect(employeeImportReport(null, []).lines).toEqual([]);
    expect(employeeImportReport({ rows: 'not an array' }, [{ kind: 'failed', detail: { rows: 'nope' } }]).lines).toEqual([]);
  });
  it('a viewer of one company of two sees only that company’s rows; the full attempt only with every company', () => {
    const report = employeeImportReport(plan, failedEvents);
    const scoped = scopeEmployeeImportReport(report, new Set(['co-a']), false);
    expect([...new Set(scoped.lines.map((l) => l.rowNum))]).toEqual([1, 3]);
    expect(scoped.lines.some((l) => l.fullName === 'Fictional Two' || l.fullName === 'Fictional Four')).toBe(false);
    expect(scoped.counts).toEqual({ saved: 0, toFix: 0, cancelled: 2, total: 2 });
    expect(scopeEmployeeImportReport(report, new Set(), true)).toBe(report);
    const issues = [{ rowNum: 0, reason: 'file' }, { rowNum: 2, reason: 'Row 2 (Fictional Two): bad' }, { rowNum: 1, reason: 'Row 1' }];
    expect(scopeEmployeeImportIssues(issues, plan, new Set(['co-a']), false)).toEqual([{ rowNum: 1, reason: 'Row 1' }]);
    expect(scopeEmployeeImportIssues(issues, plan, new Set(), true)).toEqual(issues);
  });
  it('the CSV neutralises formula cells from the uploaded file', () => {
    const report = employeeImportReport(plan, failedEvents);
    const csv = toCsv(report.lines.map((l) => [l.rowNum, l.employeeCode, l.fullName]));
    expect(csv).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(csv).toContain("'+F003");
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });
  it('the cancelled wording never says "rolled back"', () => {
    expect(cancelledRowMessage([2, 4])).toMatch(/row 2, 4 .*no problem/);
    expect(readFileSync('core/import.ts', 'utf8')).not.toContain('Not written because the import was rolled back');
    expect(readFileSync('core/employee-import-worker.ts', 'utf8')).not.toContain('Not written because the import was rolled back');
  });
});

describe('wording in all six catalogues', () => {
  it('has the same error report and upload keys in every locale', () => {
    const en = messages('en');
    const keys = [...leafKeys(en.people.importHistory.errorReport), ...leafKeys(en.people.import.uploadErrors)];
    expect(keys.length).toBeGreaterThan(40);
    for (const l of LOCALES) {
      const m = messages(l);
      expect([...leafKeys(m.people.importHistory.errorReport), ...leafKeys(m.people.import.uploadErrors)], l).toEqual(keys);
      for (const key of leafKeys(m.people.importHistory.errorReport)) expect(key.split('.').reduce((n: Record<string, unknown>, k) => n[k] as Record<string, unknown>, m.people.importHistory.errorReport), `${l} ${key}`).toBeTruthy();
    }
  });
});

describe('upload and progress errors', () => {
  const t = (key: string) => key;
  it('tells apart unreachable, unavailable, slow and refused', () => {
    expect(employeeUploadErrorMessage({ thrown: new TypeError('Failed to fetch') }, t)).toBe('uploadErrors.unreachable');
    expect(employeeUploadErrorMessage({ thrown: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, t)).toBe('uploadErrors.timeout');
    expect(employeeUploadErrorMessage({ status: 504 }, t)).toBe('uploadErrors.timeout');
    expect(employeeUploadErrorMessage({ status: 503 }, t)).toBe('uploadErrors.unavailable');
    expect(employeeUploadErrorMessage({ status: 502, error: null }, t)).toBe('uploadErrors.unavailable');
    expect(employeeUploadErrorMessage({ status: 500 }, t)).toBe('uploadErrors.unknown');
    expect(employeeUploadErrorMessage({ status: 413 }, t)).toBe('fileTooLarge');
    expect(employeeUploadErrorMessage({ status: 400, error: 'Choose a company before importing.' }, t)).toBe('Choose a company before importing.');
    expect(employeeUploadErrorMessage({ status: 403, error: null }, t)).toBe('employeeUploadFailed');
    expect(employeeProgressErrorMessage({ thrown: new TypeError('x') }, t)).toBe('uploadErrors.progressUnreachable');
    expect(employeeProgressErrorMessage({ status: 504 }, t)).toBe('uploadErrors.progressUnreachable');
  });
  it('only a refusal before anything started keeps "nothing was changed"', () => {
    const en = messages('en').people.import;
    expect(en.employeeUploadFailed).toMatch(/Nothing was changed/);
    for (const key of ['unreachable', 'unavailable', 'timeout', 'unknown']) expect(en.uploadErrors[key]).not.toMatch(/Nothing was changed/i);
    const screen = readFileSync('app/admin/personnel/import/employee-import.tsx', 'utf8');
    expect(screen).toContain("uploadOperation.current??=crypto.randomUUID()");
    expect(screen).not.toContain("'x-upload-operation':crypto.randomUUID()");
  });
});
