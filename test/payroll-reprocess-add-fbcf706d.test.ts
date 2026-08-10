/**
 * fbcf706d — PREMISE CHECK, then the standing test of it.
 *
 * The approved plan for "pay someone who was added to the company after the run was processed" rests on
 * one unproven claim: that the selective-reprocess path already computes a CORRECT payslip for an
 * employment that has no payslip on the batch at all. That was read off the source, never demonstrated,
 * and no production row has ever exercised it (0 of 123 result-history rows carry a null version_before).
 *
 * The mechanism, re-derived in this worktree:
 *   - core/payroll.ts 2409-2436 — the employee set is employment INNER JOIN compensation (validTo IS NULL,
 *     supersededAt IS NULL), filtered by company + hiredOn <= period end + not terminated before period
 *     start + the batch scope filter + inArray(employment.id, subset.employmentIds). It is NOT payslip-driven.
 *   - core/payroll.ts 3477-3505 — existing payslips are read only AFTERWARDS, to snapshot, row-lock, tally
 *     oldTotals and delete. An employment with no payslip simply contributes nothing there.
 *   - core/payroll.ts 4111 — version is (versionByEmp.get(id) ?? 0) + 1, so a payslip-less employment
 *     inserts at version 1.
 *   - core/payroll.ts 4134-4140 — the batch totals delta is stored + new - old, so with old = 0 it is a
 *     pure addition.
 *
 * So the two facts this file pins are the two the plan bets on, and the one it predicts will fail:
 *   1. Reprocessing a payslip-less, period-eligible employment INSERTS a correct payslip at version 1,
 *      adds its figures to the batch totals, and leaves every other payslip physically untouched.
 *   2. The same employment WITHOUT an open compensation row is dropped by the inner join and the run
 *      refuses with the misleading "None of the selected employees are active in this period." — the
 *      failure shape the plan commits to replacing with a truthful, per-person message.
 *
 * What this file deliberately does NOT assert is the side-effect work the plan is actually about:
 * employee_count, loan ledgers, claim mark-paid, one-off attachment. Those are known-missing on the
 * subset branch; asserting them here would pin today's wrong behaviour as correct.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, reprocessSelectedEmployees } from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

describe('fbcf706d — the selective-reprocess path against an employment with NO payslip on the run', () => {
  let base: Base;
  let a: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hire(name: string, email: string, ic: string, hiredOn: string) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  const slipsOf = (batchId: string) =>
    owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

  const slipOf = async (batchId: string, employmentId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return row ?? null;
  };

  const batchOf = async (batchId: string) => {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  };

  it('INSERTS a correct payslip for it, at version 1, without disturbing anyone already paid', async () => {
    // Someone on the run from the start.
    const paid = await hire('Already Paid', 'alreadypaid@acme.test', '900101011234', '2026-01-01');
    await setCompensation(a, {
      employmentId: paid.employmentId,
      basicSalary: 3000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });

    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });
    expect(await slipsOf(b.batchId)).toHaveLength(1);
    const paidBefore = await slipOf(b.batchId, paid.employmentId);
    const totalsBefore = ((await batchOf(b.batchId)).totals ?? {}) as Record<string, number>;

    // …and someone whose record reaches the company only AFTER the run was processed. Period-eligible
    // (hired inside the period window, never terminated) and carrying an open compensation row, but with
    // no payslip anywhere on this batch.
    const added = await hire('Added Late', 'addedlate@acme.test', '900101012222', '2026-02-01');
    await setCompensation(a, {
      employmentId: added.employmentId,
      basicSalary: 4000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-02-01',
    });
    expect(await slipOf(b.batchId, added.employmentId), 'fixture is wrong — the added hire already has a payslip').toBeNull();

    const job = await reprocessSelectedEmployees(a, {
      batchId: b.batchId,
      employmentIds: [added.employmentId],
      reason: 'added after processing',
    });
    expect(job.status).toBe('completed');

    // 1. The payslip now exists, and its figures are the real calculation — not a zero row, not a clone.
    const addedSlip = await slipOf(b.batchId, added.employmentId);
    expect(addedSlip, 'no payslip was inserted for the payslip-less employment').not.toBeNull();
    expect(Number(addedSlip!.grossPay)).toBeCloseTo(4000, 2);
    expect(Number(addedSlip!.netPay)).toBeGreaterThan(0);
    expect(Number(addedSlip!.netPay)).toBeLessThan(Number(addedSlip!.grossPay));
    // Statutory actually ran for them (EPF on RM4,000 is not zero), so this is the full compute path.
    const st = (addedSlip!.statutory ?? {}) as Record<string, number>;
    expect(Number(st.epfEmployee ?? 0)).toBeGreaterThan(0);
    expect(Number(st.epfEmployer ?? 0)).toBeGreaterThan(0);
    // core/payroll.ts:4111 — (undefined ?? 0) + 1.
    expect(addedSlip!.version, 'a first-ever payslip must be version 1').toBe(1);

    // 2. Nobody already paid moved. Same row, same version, same money.
    const paidAfter = await slipOf(b.batchId, paid.employmentId);
    expect(paidAfter!.version).toBe(paidBefore!.version);
    expect(paidAfter!.netPay).toBe(paidBefore!.netPay);
    expect(paidAfter!.grossPay).toBe(paidBefore!.grossPay);

    // 3. The run gained exactly one payslip and stayed processed, and the totals moved by the addition
    //    alone (core/payroll.ts:4134-4140 with oldTotals = 0 is a pure addition).
    const after = await batchOf(b.batchId);
    expect(await slipsOf(b.batchId)).toHaveLength(2);
    expect(after.status).toBe('processed');
    const totalsAfter = (after.totals ?? {}) as Record<string, number>;
    expect(Number(totalsAfter.gross) - Number(totalsBefore.gross ?? 0)).toBeCloseTo(Number(addedSlip!.grossPay), 2);
    expect(Number(totalsAfter.net) - Number(totalsBefore.net ?? 0)).toBeCloseTo(Number(addedSlip!.netPay), 2);
  });

  it('but WITHOUT an open compensation row it is dropped by the inner join, and the refusal is untruthful', async () => {
    const paid = await hire('Paid Two', 'paidtwo@acme.test', '900101011234', '2026-01-01');
    await setCompensation(a, {
      employmentId: paid.employmentId,
      basicSalary: 3000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    // Period-eligible in every respect the operator can see — hired, not terminated, on this company —
    // but with no salary on record, so the earnings inner join at core/payroll.ts:2412-2419 drops them.
    const noPay = await hire('No Salary', 'nosalary@acme.test', '900101013333', '2026-02-01');

    await expect(
      reprocessSelectedEmployees(a, { batchId: b.batchId, employmentIds: [noPay.employmentId] }),
    ).rejects.toThrow(/None of the selected employees are active in this period/);

    // It fails CLOSED: no payslip was written for them and the run is unchanged.
    expect(await slipOf(b.batchId, noPay.employmentId)).toBeNull();
    expect(await slipsOf(b.batchId)).toHaveLength(1);
    expect((await batchOf(b.batchId)).status).toBe('processed');
  });
});
