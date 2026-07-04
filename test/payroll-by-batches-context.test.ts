/**
 * Build #10 — By-Batches screen pay-period filter. `listBatches` gains an OPTIONAL third positional
 * `payPeriod` arg that is AND-ed onto the existing tenant + companyIds guard, so it can only NARROW
 * the result. These tests pin:
 *   1. passing a period returns ONLY that period's runs;
 *   2. backward-compat (load-bearing for the three existing callers): omitting the arg, and passing
 *      '', are byte-identical to today's output — same rows, same `desc(payPeriod), runSeq` ordering,
 *      exercised across a multi-run month.
 * No schema, payroll-calc, or kernel-logic change.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createBatch, listBatches } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** Add a second run (run_seq=2, bonus) under an EXISTING regular run's pay_period, so a single month
 *  carries multiple batches and the `runSeq` tiebreak in the orderBy is exercised. Mirrors the
 *  direct-insert style used elsewhere in the payroll tests; avoids the multi-cycle env gate. */
async function addBonusRun(regularBatchId: string) {
  const [reg] = await owner.db
    .select({ payPeriodId: schema.payrollBatch.payPeriodId, companyId: schema.payrollBatch.companyId, payPeriod: schema.payrollBatch.payPeriod })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, regularBatchId));
  const [row] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: reg.companyId,
      payPeriodId: reg.payPeriodId,
      runSeq: 2,
      runType: 'bonus',
      payPeriod: reg.payPeriod,
      batchDate: `${reg.payPeriod}-28`,
      status: 'draft',
    })
    .returning({ id: schema.payrollBatch.id });
  return row.id;
}

/** Add an off-cycle run carrying a free-text `remarks` under an EXISTING regular run's pay_period.
 *  Mirrors how the payroll wizard persists 'Advance Salary' / 'Mid-Month' cycles: runType='off_cycle'
 *  with the real selection stored in remarks. Used to pin that listBatches surfaces remarks so the
 *  listing's Payroll Cycle column can distinguish them from a generic off-cycle run. */
async function addOffCycleRun(regularBatchId: string, remarks: string, runSeq: number) {
  const [reg] = await owner.db
    .select({ payPeriodId: schema.payrollBatch.payPeriodId, companyId: schema.payrollBatch.companyId, payPeriod: schema.payrollBatch.payPeriod })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, regularBatchId));
  const [row] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: reg.companyId,
      payPeriodId: reg.payPeriodId,
      runSeq,
      runType: 'off_cycle',
      payPeriod: reg.payPeriod,
      batchDate: `${reg.payPeriod}-28`,
      status: 'draft',
      remarks,
    })
    .returning({ id: schema.payrollBatch.id });
  return row.id;
}

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

describe('Build #10 — listBatches optional pay-period filter', () => {
  it('returns only the requested period when a payPeriod is passed', async () => {
    const a = adminCtx(b);
    const may = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await addBonusRun(may.batchId); // a second run within May
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });

    const filtered = await listBatches(a, [b.companyId], '2026-05');
    expect(filtered).toHaveLength(2); // both May runs
    expect(filtered.every((r) => r.payPeriod === '2026-05')).toBe(true);
  });

  it('no-filter (omitted) and empty-string filter are identical to today — same rows + ordering', async () => {
    const a = adminCtx(b);
    const may = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await addBonusRun(may.batchId);
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });

    const omitted = await listBatches(a, [b.companyId]);
    const emptyStr = await listBatches(a, [b.companyId], '');

    // Backward-compat: '' must behave exactly like omitting the arg.
    expect(emptyStr).toEqual(omitted);

    // Three batches total across two periods (May ×2 + June ×1).
    expect(omitted).toHaveLength(3);

    // Ordering preserved: desc(payPeriod) then asc(runSeq). June(seq1), May(seq1), May(seq2).
    expect(omitted.map((r) => [r.payPeriod, r.runSeq])).toEqual([
      ['2026-06', 1],
      ['2026-05', 1],
      ['2026-05', 2],
    ]);
  });

  it('filter only narrows — never widens past the companyIds + tenant guard', async () => {
    const a = adminCtx(b);
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });

    // A period that has no runs returns nothing (additive, can only narrow).
    expect(await listBatches(a, [b.companyId], '2030-01')).toHaveLength(0);
    // The filtered set is a strict subset of the unfiltered set.
    const all = await listBatches(a, [b.companyId]);
    const justMay = await listBatches(a, [b.companyId], '2026-05');
    expect(justMay.length).toBeLessThan(all.length);
    expect(justMay.every((r) => all.some((x) => x.id === r.id))).toBe(true);
  });
});

// "Separate Period and Payroll Cycle columns" — the listing renders payPeriod and the cycle label
// (runType + remarks) in two distinct columns, matching the batch detail page. This pins that
// listBatches returns payPeriod, runType, AND remarks as distinct fields, so wizard-created
// Advance Salary / Mid-Month runs (stored as runType='off_cycle' with the real name in remarks)
// display distinctly from a generic off-cycle run rather than collapsing to identical "Off-cycle".
describe('listBatches — Period / Payroll Cycle column data', () => {
  it('returns payPeriod, runType, and remarks as distinct fields', async () => {
    const a = adminCtx(b);
    const may = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await addOffCycleRun(may.batchId, 'Advance Salary', 2);
    await addOffCycleRun(may.batchId, 'Mid-Month', 3);

    const rows = await listBatches(a, [b.companyId], '2026-05');
    // regular (remarks null), off-cycle Advance Salary, off-cycle Mid-Month — ordered by runSeq.
    expect(rows.map((r) => [r.runType, r.remarks])).toEqual([
      ['regular', null],
      ['off_cycle', 'Advance Salary'],
      ['off_cycle', 'Mid-Month'],
    ]);
    // Period is carried separately (unchanged) so it renders in its own column.
    expect(rows.every((r) => r.payPeriod === '2026-05')).toBe(true);
    // The two off-cycle runs are distinguishable ONLY via remarks — the fidelity fix.
    const offCycle = rows.filter((r) => r.runType === 'off_cycle');
    expect(new Set(offCycle.map((r) => r.remarks)).size).toBe(2);
  });

  it('leaves remarks null for a plain run so the column falls back to the runType label alone', async () => {
    const a = adminCtx(b);
    await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });
    const [row] = await listBatches(a, [b.companyId], '2026-06');
    expect(row.runType).toBe('regular');
    expect(row.remarks).toBeNull();
  });
});
