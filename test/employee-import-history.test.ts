/**
 * Item cf43c909 — "Replace CSV Import with Excel Import and Add Import History".
 *
 * REPRODUCED FIRST, and most of this item was already built:
 *   · the .xlsx reader shipped in r86 as d8471481 (lib/import-file.ts + lib/spreadsheet.ts) — covered by
 *     test/employee-import-file.test.ts and test/employee-import-xlsx.test.ts;
 *   · the pre-import validation preview is `validateEmployeeImport` and predates both items;
 *   · the downloadable error report for the PREVIEW shipped with d8471481.
 * What was genuinely absent is the RECORD of a finished run. This file covers that and nothing else.
 *
 * What "import history" has to be true for, all of it exercised below:
 *   1. one row per COMMITTED run, carrying who / when / file name / counts;
 *   2. "failed" means EVERY row that did not become an employee — rejected by validation and failed at
 *      write are one list to HR, because both mean "this person is not in the system and here is why";
 *   3. the per-row REASONS are stored, so a rejected row can be corrected and re-uploaded, while the
 *      uploaded FILE is never stored (it carries IC / bank / salary for the whole workforce);
 *   4. the error detail is bounded — a 5,000-row disaster must not write a 5,000-entry jsonb document;
 *   5. recording the run can NEVER fail an import that already created employees;
 *   6. a dry run writes no history (validating is not importing);
 *   7. the history is tenant-scoped and admin-only (RLS 0341).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  commitEmployeeImport,
  listEmployeeImportRuns,
  validateEmployeeImport,
  IMPORT_RUN_ERROR_CAP,
} from '../core/import';
import { importRunOutcome } from '../lib/import-schema';
import { parseCsvRecords } from '../lib/csv';
import { listEmployees } from '../core/read';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const HEADER =
  'full_name,email,department,hired_on,ic_number,basic_salary,monthly_allowance,bank_name,bank_account_no,tax_category';
const csvFor = (rows: string[]) => parseCsvRecords(`${HEADER}\n${rows.join('\n')}`).records;

/** A row that will pass validation. `n` varies the IC + email so rows never collide. */
const goodRow = (n: number) => {
  const ic = `9${String(n).padStart(2, '0')}0101${String(n).padStart(2, '0')}1234`.slice(0, 12);
  return `Person ${n},person${n}@acme.test,Finance,2026-06-01,${ic},5000,0,,,1`;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('cf43c909 · employee import history', () => {
  it('records ONE run per commit with who, when, file name and the counts — and the counts match what happened', async () => {
    const a = adminCtx(b);
    const result = await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: csvFor([goodRow(1), goodRow(2), 'Bad Email,not-an-email,Finance,2026-06-01,930101014567,5000,0,,,1']),
      fileName: 'june-joiners.xlsx',
    });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.runId).toBeTruthy();

    const runs = await listEmployeeImportRuns(a);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.id).toBe(result.runId);
    expect(run.fileName).toBe('june-joiners.xlsx');
    expect(run.companyId).toBe(b.companyId);
    expect(run.companyName).toBe('Acme Sdn Bhd');
    expect(run.totalRows).toBe(3);
    expect(run.importedRows).toBe(2);
    expect(run.failedRows).toBe(1);
    expect(new Date(run.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // The event log keeps its own record, unchanged — the history table is a read model beside it, not
    // a replacement for the audit spine.
    expect(await eventTypesFor(b.tenantId, b.companyId)).toContain('employee-import.completed');
  });

  it('stores the REASON each row was rejected — identity + message only, never the row’s IC / bank / salary', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: csvFor([
        goodRow(1),
        // Rejected for a reason HR can act on, carrying an IC and a bank account in the source row.
        'Unknown Dept,dept@acme.test,Marketing,2026-06-01,920101013456,5000,0,Maybank,5566778899,1',
      ]),
      fileName: 'x.csv',
    });

    const [run] = await listEmployeeImportRuns(a);
    expect(run.errors).toHaveLength(1);
    const e = run.errors[0];
    expect(e.rowNum).toBe(2);
    expect(e.fullName).toBe('Unknown Dept');
    expect(e.email).toBe('dept@acme.test');
    expect(e.errors.join('; ')).toMatch(/unknown department/i);

    // The stored detail is what a CORRECTION needs and nothing more. Asserted against the RAW jsonb, so
    // this fails if any future field quietly widens what an import run retains.
    const [row] = await owner.db
      .select({ errors: schema.employeeImportRun.errors, fileName: schema.employeeImportRun.fileName })
      .from(schema.employeeImportRun);
    const raw = JSON.stringify(row.errors);
    expect(Object.keys((row.errors as Record<string, unknown>[])[0]).sort()).toEqual([
      'email',
      'errors',
      'fullName',
      'rowNum',
    ]);
    expect(raw).not.toContain('920101013456'); // IC
    expect(raw).not.toContain('5566778899'); // bank account
    expect(raw).not.toContain('Maybank');
    // The uploaded file is never stored — only its NAME, so HR recognises the run.
    expect(row.fileName).toBe('x.csv');
  });

  it('counts a row that FAILED AT WRITE as failed, in the same list as one rejected by validation', async () => {
    const a = adminCtx(b);
    // A row that passes validation and then cannot be WRITTEN. Reaching that leg needs a failure the dry
    // run cannot foresee, because commitEmployeeImport RE-VALIDATES server-side (it never trusts a client
    // preview) — so anything analyze() checks is re-checked and comes back as a REJECTION, not a write
    // failure. A DB constraint the importer knows nothing about is exactly such a failure, and it stands in
    // for the real ones (a concurrent hire taking the IC, a service throwing) without stubbing a service.
    const records = csvFor([goodRow(1), `Doomed,doomed@acme.test,Operations,2026-06-01,940101015678,5000,0,,,1`]);
    const preview = await validateEmployeeImport(a, { companyId: b.companyId, records });
    expect(preview.validCount).toBe(2); // both rows are fine on paper

    await owner.db.execute(sql`ALTER TABLE person ADD CONSTRAINT test_doomed_ck CHECK (full_name <> 'Doomed')`);
    try {
      const result = await commitEmployeeImport(a, { companyId: b.companyId, records, fileName: 'f.xlsx' });
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0); // nothing was REJECTED — the second row failed at WRITE
      expect(result.failed).toHaveLength(1);

      const [run] = await listEmployeeImportRuns(a);
      expect(run.importedRows).toBe(1);
      // failedRows spans BOTH kinds; here the only failure is a write failure.
      expect(run.failedRows).toBe(1);
      expect(run.errors.map((e) => e.rowNum)).toEqual([2]);
      expect(run.errors[0].email).toBe('doomed@acme.test');
      expect(run.errors[0].errors[0]).toBeTruthy();
      expect(importRunOutcome(run)).toBe('partial');
    } finally {
      await owner.db.execute(sql`ALTER TABLE person DROP CONSTRAINT test_doomed_ck`);
    }
  });

  it('bounds the stored error detail and says so — a file of rejects cannot write an unbounded document', async () => {
    const a = adminCtx(b);
    const n = IMPORT_RUN_ERROR_CAP + 5;
    // Every row names a department that does not exist ⇒ every row is rejected.
    const records = csvFor(
      Array.from(
        { length: n },
        (_, i) => `Reject ${i},r${i}@acme.test,Nowhere,2026-06-01,900101${String(i).padStart(6, '0')},5000,0,,,1`,
      ),
    );
    const result = await commitEmployeeImport(a, { companyId: b.companyId, records, fileName: 'bad.xlsx' });
    expect(result.imported).toBe(0);

    const [run] = await listEmployeeImportRuns(a);
    expect(run.totalRows).toBe(n);
    expect(run.failedRows).toBe(n); // the COUNT is honest…
    expect(run.errors).toHaveLength(IMPORT_RUN_ERROR_CAP); // …while the detail is capped…
    expect(run.errorsTruncated).toBe(true); // …and the screen is told the list is a sample.
    expect(importRunOutcome(run)).toBe('failed');
  });

  it('a DRY RUN writes no history — validating is not importing', async () => {
    const a = adminCtx(b);
    await validateEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(1)]) });
    expect(await listEmployeeImportRuns(a)).toHaveLength(0);
  });

  it('a fully successful run reads as succeeded, with no error detail', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, {
      companyId: b.companyId,
      records: csvFor([goodRow(1), goodRow(2)]),
      fileName: 'clean.xlsx',
    });
    const [run] = await listEmployeeImportRuns(a);
    expect(run.importedRows).toBe(2);
    expect(run.failedRows).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.errorsTruncated).toBe(false);
    expect(importRunOutcome(run)).toBe('succeeded');
  });

  it('lists most-recent first', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(1)]), fileName: 'first.xlsx' });
    await commitEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(2)]), fileName: 'second.xlsx' });
    const runs = await listEmployeeImportRuns(a);
    expect(runs.map((r) => r.fileName)).toEqual(['second.xlsx', 'first.xlsx']);
  });

  it('a pasted CSV records an empty file name rather than inventing one', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(1)]) });
    const [run] = await listEmployeeImportRuns(a);
    expect(run.fileName).toBe('');
  });

  it('NEVER fails an import that already created employees, even when the history row cannot be written', async () => {
    const a = adminCtx(b);
    // Break the history write only: a NOT-NULL, defaultless column the inserter does not populate makes
    // every insert into employee_import_run fail, while nothing else in the commit path is touched.
    await owner.db.execute(
      sql`ALTER TABLE employee_import_run ADD COLUMN forced_failure text NOT NULL`,
    );
    try {
      const before = (await listEmployees(a)).length;
      const result = await commitEmployeeImport(a, {
        companyId: b.companyId,
        records: csvFor([goodRow(1), goodRow(2)]),
        fileName: 'x.xlsx',
      });
      // The import is reported as what it WAS. Telling an admin their import failed when two employees now
      // exist is a worse fault than losing a history row.
      expect(result.imported).toBe(2);
      expect(result.runId).toBeNull();
      expect((await listEmployees(a)).length).toBe(before + 2);
    } finally {
      await owner.db.execute(sql`ALTER TABLE employee_import_run DROP COLUMN forced_failure`);
    }
  });

  it('is tenant-scoped — another tenant’s admin never sees this tenant’s runs', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(1)]), fileName: 'mine.xlsx' });
    expect(await listEmployeeImportRuns(a)).toHaveLength(1);

    const other = await seedBase();
    expect(await listEmployeeImportRuns(adminCtx(other))).toHaveLength(0);
  });

  it('is admin-only — a plain employee session reads nothing back (RLS 0341)', async () => {
    const a = adminCtx(b);
    await commitEmployeeImport(a, { companyId: b.companyId, records: csvFor([goodRow(1)]), fileName: 'mine.xlsx' });

    const [p] = await owner.db
      .insert(schema.person)
      .values({
        tenantId: b.tenantId,
        fullName: `Staff ${randomUUID().slice(0, 6)}`,
        primaryEmail: `staff_${randomUUID().slice(0, 6)}@acme.test`,
      })
      .returning({ id: schema.person.id });
    // Same tenant and the same entitlement snapshot as the admin — the ONLY difference is the role, so
    // what this proves is the RLS policy and nothing else.
    const employeeCtx = { ...adminCtx(b), userId: `user_${randomUUID()}`, personId: p.id, roles: ['employee'] };
    expect(await listEmployeeImportRuns(employeeCtx)).toHaveLength(0);
  });
});
