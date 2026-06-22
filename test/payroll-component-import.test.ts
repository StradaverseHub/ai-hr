/**
 * ADR-0035 1D (#12) — CSV import of one-off pay-component lines onto a draft batch. Reconciles employee
 * email → employment and component code → catalog; dry-run flags every bad row (unknown employee /
 * component / non-numeric amount) and writes nothing; commit upserts only the valid rows. Imports into a
 * non-draft batch are refused.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createBatch } from '../core/payroll';
import { importBatchComponents, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const hire = (a: ReturnType<typeof adminCtx>, email: string) =>
  hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const countBatchComponents = (batchId: string) =>
  owner.db.select().from(schema.payrollBatchComponent).where(eq(schema.payrollBatchComponent.batchId, batchId));

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

describe('ADR-0035 1D — pay-component CSV import', () => {
  it('dry-run flags bad rows + writes nothing; commit imports only the valid ones', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@imp.test');
    await hire(a, 'e2@imp.test');
    await seedPayComponentCatalog(a);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });

    const csv = [
      'employee,component,amount,notes',
      'e1@imp.test,HOUSING,800,Fixed housing',
      'e2@imp.test,OVERTIME,450,',
      'nobody@imp.test,HOUSING,100,', // unknown employee
      'e1@imp.test,NOPE,50,', // unknown component
      'e1@imp.test,HOUSING,abc,', // bad amount
    ].join('\n');

    const dry = await importBatchComponents(a, { batchId, csvText: csv, dryRun: true });
    expect(dry.rows).toHaveLength(5);
    expect(dry.valid).toBe(2);
    expect(dry.imported).toBe(0);
    expect(dry.rows.filter((r) => !r.ok).map((r) => r.error)).toEqual([
      expect.stringContaining('Unknown employee'),
      expect.stringContaining('Unknown component'),
      expect.stringContaining('Invalid amount'),
    ]);
    expect(await countBatchComponents(batchId)).toHaveLength(0); // dry-run wrote nothing

    const done = await importBatchComponents(a, { batchId, csvText: csv, dryRun: false });
    expect(done.imported).toBe(2);
    expect(await countBatchComponents(batchId)).toHaveLength(2);
  });

  it('refuses to import into a non-draft batch', async () => {
    const a = adminCtx(b);
    await hire(a, 'e3@imp.test');
    await seedPayComponentCatalog(a);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });
    await owner.db.update(schema.payrollBatch).set({ status: 'processed' }).where(eq(schema.payrollBatch.id, batchId));

    await expect(
      importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne3@imp.test,HOUSING,100', dryRun: true }),
    ).rejects.toThrow(/draft/);
  });
});
