/**
 * Item 1859cce0 — employee import error reporting on a real database: the Contract rule in the file check (one
 * problem per column), every save-time refusal reported together with nothing left behind, and the Import History
 * save report. Fictional fixtures only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { commitEmployeeImport, validateEmployeeImport } from '../core/import';
import { getImportAttempt } from '../core/import-history';
import { employeeImportErrorReportFor } from '../core/employee-import-history';
import { parseCsvRecords } from '../lib/csv';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let a: ReturnType<typeof adminCtx>;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); a = adminCtx(b); });
afterAll(closeAll);

const HEADER = 'full_name,email,department,hired_on,employment_type,contract_start_date,contract_end_date,basic_salary,employee_code';
const line = (i: number, over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = { full_name: `Fictional Person ${i}`, email: `fictional-${i}@fixture.test`, department: 'Finance', hired_on: '2026-06-01',
    employment_type: 'full_time', contract_start_date: '', contract_end_date: '', basic_salary: '3000', employee_code: `ERR${String(i).padStart(3, '0')}` };
  const merged = { ...base, ...over } as Record<string, string>;
  return HEADER.split(',').map((c) => merged[c]).join(',');
};
const recs = (rows: string[]) => parseCsvRecords(`${HEADER}\n${rows.join('\n')}`).records;
const issuesFor = async (over: Partial<Record<string, string>>) => {
  const preview = await validateEmployeeImport(a, { companyId: b.companyId, records: recs([line(1, over)]) });
  return preview.rows[0].issues!.filter((i) => i.column?.startsWith('contract_')).map((i) => [i.column, i.code]);
};
const counts = async () => {
  const [r] = await owner.db.execute<{ p: number; e: number; a: number }>(sql`select (select count(*)::int from person) p,(select count(*)::int from employment) e,(select count(*)::int from assignment) a`);
  return r;
};

describe('1859cce0 · Contract dates in the file check', () => {
  it('requires both dates for a Contract row, one problem per column', async () => {
    expect(await issuesFor({ employment_type: 'contract' })).toEqual([
      ['contract_start_date', 'contract.required'], ['contract_end_date', 'contract.required'],
    ]);
    expect(await issuesFor({ employment_type: 'contract', contract_start_date: '2026-06-01' })).toEqual([['contract_end_date', 'contract.required']]);
    expect(await issuesFor({ employment_type: 'contract', contract_end_date: '2027-05-31' })).toEqual([['contract_start_date', 'contract.required']]);
  });

  it('refuses a start before the hire date and an end on or before the start', async () => {
    expect(await issuesFor({ employment_type: 'contract', contract_start_date: '2026-05-31', contract_end_date: '2027-05-31' }))
      .toEqual([['contract_start_date', 'contract.before_hire']]);
    expect(await issuesFor({ employment_type: 'contract', contract_start_date: '2026-06-01', contract_end_date: '2026-06-01' }))
      .toEqual([['contract_end_date', 'contract.end_not_after_start']]);
    expect(await issuesFor({ employment_type: 'contract', contract_start_date: '2026-07-01', contract_end_date: '2026-06-30' }))
      .toEqual([['contract_end_date', 'contract.end_not_after_start']]);
  });

  it('accepts a valid Contract row and saves its dates; other employment types need no contract dates', async () => {
    expect(await issuesFor({ employment_type: 'contract', contract_start_date: '2026-06-01', contract_end_date: '2027-05-31' })).toEqual([]);
    expect(await issuesFor({ employment_type: 'full_time' })).toEqual([]);
    expect(await issuesFor({ employment_type: 'intern' })).toEqual([]);
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs([line(1, { employment_type: 'contract', contract_start_date: '2026-06-01', contract_end_date: '2027-05-31' })]) });
    expect(result.imported).toBe(1);
    const [row] = await owner.db.select({ start: schema.employment.contractStartDate, end: schema.employment.contractEndDate })
      .from(schema.employment).where(and(eq(schema.employment.tenantId, b.tenantId), eq(schema.employment.employeeCode, 'ERR001')));
    expect(row).toEqual({ start: '2026-06-01', end: '2027-05-31' });
  });

  it('names the column of the other check problems too', async () => {
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records: recs([line(1, { department: 'No Such Department', hired_on: '31/11/2026' })]) });
    expect(preview.rows[0].issues!.map((i) => i.column)).toEqual(expect.arrayContaining(['department', 'hired_on']));
    expect(preview.rows[0].issues!.map((i) => i.message)).toEqual(preview.rows[0].errors);
  });
});

describe('1859cce0 · problems found while saving', () => {
  it('reports every refused row together, keeps nothing, and records the save report in Import History', async () => {
    const before = await counts();
    await owner.db.execute(sql`ALTER TABLE person ADD CONSTRAINT test_refuse_two_ck CHECK (full_name NOT IN ('Fictional Person 2','Fictional Person 4'))`);
    try {
      const records = recs([line(1), line(2), line(3), line(4), line(5, { department: 'No Such Department' })]);
      const result = await commitEmployeeImport(a, { companyId: b.companyId, records, fileName: 'fictional.csv', source: { name: 'fictional.csv', content: Buffer.from('fictional') } });
      expect(result.imported).toBe(0);
      expect(result.failed.map((f) => [f.rowNum, f.outcome])).toEqual([[1, 'cancelled'], [2, 'stopped'], [3, 'cancelled'], [4, 'stopped']]);
      expect(result.failed.find((f) => f.rowNum === 2)).toMatchObject({ employeeCode: 'ERR002', fullName: 'Fictional Person 2', companyId: b.companyId });
      expect(result.failed.find((f) => f.rowNum === 3)?.stoppedBy).toEqual([2, 4]);
      expect(result.fileErrors[0]).toMatch(/Row 2, 4 could not be saved/);
      expect(await counts()).toEqual(before);

      const item = await getImportAttempt(a, result.attemptId!);
      const { report, full } = await employeeImportErrorReportFor(a, item!);
      expect(full).toBe(true);
      expect(report.counts).toEqual({ saved: 0, toFix: 3, cancelled: 2, total: 5 });
      expect(report.cancelledWhileSaving).toBe(true);
      expect(report.stoppedBy).toEqual([2, 4]);
      expect(report.lines.map((l) => [l.rowNum, l.stage, l.outcome])).toEqual([
        [1, null, 'cancelled'], [2, 'save', 'stopped'], [3, null, 'cancelled'], [4, 'save', 'stopped'], [5, 'check', 'refused'],
      ]);
      expect(report.lines.find((l) => l.rowNum === 5)?.column).toBe('department');
    } finally {
      await owner.db.execute(sql`ALTER TABLE person DROP CONSTRAINT test_refuse_two_ck`);
    }
  });

  it('a superior on a refused row is named against its subordinate and the file is cancelled', async () => {
    const header = `${HEADER},direct_superior`;
    const records = parseCsvRecords(`${header}\n${line(1)},ERR002\n${line(2)},\n${line(3)},`).records;
    await owner.db.execute(sql`ALTER TABLE person ADD CONSTRAINT test_refuse_mgr_ck CHECK (full_name <> 'Fictional Person 2')`);
    try {
      const before = await counts();
      const result = await commitEmployeeImport(a, { companyId: b.companyId, records });
      expect(result.failed.map((f) => [f.rowNum, f.outcome, f.column ?? null])).toEqual([[1, 'stopped', 'direct_superior'], [2, 'stopped', null], [3, 'cancelled', null]]);
      expect(result.failed[0].message).toMatch(/direct superior on row 2 could not be saved/);
      expect(await counts()).toEqual(before);
    } finally {
      await owner.db.execute(sql`ALTER TABLE person DROP CONSTRAINT test_refuse_mgr_ck`);
    }
  });

  it('a file with a rejected row and valid rows still saves the valid rows', async () => {
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records: recs([line(1), line(2, { employment_type: 'contract' })]) });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.fileErrors).toEqual([]);
  });
});
