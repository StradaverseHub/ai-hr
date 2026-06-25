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
import {
  UnsupportedBatchComponentError,
  importBatchComponents,
  listPayComponents,
  seedPayComponentCatalog,
  setPayrollBatchComponent,
  upsertPayComponent,
} from '../core/pay-components';
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

  it('re-import upserts by (batch, employment, component) — no duplicate lines, amount overwrites', async () => {
    const a = adminCtx(b);
    await hire(a, 'e4@imp.test');
    await seedPayComponentCatalog(a);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });

    const first = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne4@imp.test,HOUSING,800', dryRun: false });
    expect(first.imported).toBe(1);
    let rows = await countBatchComponents(batchId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(800, 2);

    // Same employee+component, different amount: upserts (1 row, new amount), does NOT stack.
    const second = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne4@imp.test,HOUSING,950', dryRun: false });
    expect(second.imported).toBe(1);
    rows = await countBatchComponents(batchId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(950, 2);

    // A subsequent manual setPayrollBatchComponent of the same component also overwrites rather than stacks.
    const compId = (await listPayComponents(a)).find((c) => c.code === 'HOUSING')!.id;
    const emp = rows[0].employmentId;
    await setPayrollBatchComponent(a, { batchId, employmentId: emp, componentId: compId, amount: 1000 });
    rows = await countBatchComponents(batchId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(1000, 2);
  });

  it('write-time guard: a PCB-taxable non-payable (BIK) is flagged in dry-run and rejected on write', async () => {
    const a = adminCtx(b);
    await hire(a, 'e5@imp.test');
    await seedPayComponentCatalog(a);
    // A BIK: PCB-taxable but non-payable — the v1 kernel cannot tax it (ADR-0025 §5).
    await upsertPayComponent(a, {
      code: 'BIK_CAR',
      name: 'Company car (BIK)',
      kind: 'non_payable',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: true,
      prorates: false,
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });

    // Dry-run flags the row (told at import time, not after a green import) and writes nothing.
    const dry = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne5@imp.test,BIK_CAR,250', dryRun: true });
    expect(dry.valid).toBe(0);
    expect(dry.rows[0].ok).toBe(false);
    expect(dry.rows[0].error).toMatch(/Unsupported component/);
    expect(await countBatchComponents(batchId)).toHaveLength(0);

    // Commit imports nothing (the row is invalid).
    const done = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne5@imp.test,BIK_CAR,250', dryRun: false });
    expect(done.imported).toBe(0);
    expect(await countBatchComponents(batchId)).toHaveLength(0);

    // And a direct manual write throws at entry time, not at generate time.
    const bikId = (await listPayComponents(a)).find((c) => c.code === 'BIK_CAR')!.id;
    const [emp] = await owner.db.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.companyId, b.companyId));
    await expect(
      setPayrollBatchComponent(a, { batchId, employmentId: emp.id, componentId: bikId, amount: 250 }),
    ).rejects.toBeInstanceOf(UnsupportedBatchComponentError);
  });

  it('write-time guard does NOT block a record-only (non-taxable) non-payable component', async () => {
    const a = adminCtx(b);
    await hire(a, 'e6@imp.test');
    await seedPayComponentCatalog(a);
    // A record-only BIK: non-payable but NOT PCB-taxable — allowed (carried as a payslip record line).
    await upsertPayComponent(a, {
      code: 'BIK_NOTE',
      name: 'Parking (record only)',
      kind: 'non_payable',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: false,
      includedInHrdfBase: false,
      isNonPayable: true,
      prorates: false,
    });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-09' });

    const dry = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne6@imp.test,BIK_NOTE,80', dryRun: true });
    expect(dry.valid).toBe(1);
    expect(dry.rows[0].ok).toBe(true);

    const done = await importBatchComponents(a, { batchId, csvText: 'employee,component,amount\ne6@imp.test,BIK_NOTE,80', dryRun: false });
    expect(done.imported).toBe(1);
    expect(await countBatchComponents(batchId)).toHaveLength(1);
  });
});
