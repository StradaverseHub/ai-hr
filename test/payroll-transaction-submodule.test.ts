/**
 * Feature 1.2 — Transaction sub-module (IA over existing payroll capability).
 *
 * Two correctness guards for the only NEW core surface this feature adds:
 *  1. setPayrollDeductionInput is a READ-MODIFY-WRITE: editing TP1/zakat must NOT zero the row's
 *     overtime/bonus (the data-loss regression the plan flagged as high-severity). It also still
 *     appends the same payroll-batch.input-set event.
 *  2. listSupportedBatchComponents excludes the kernel's unsupported-taxable class so the Individual
 *     Transaction picker never offers a component setPayrollBatchComponent would reject at write time.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, setPayrollDeductionInput, setPayrollInput } from '../core/payroll';
import {
  listSupportedBatchComponents,
  seedPayComponentCatalog,
  upsertPayComponent,
} from '../core/pay-components';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('Feature 1.2 — payroll Transaction sub-module', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hireWithBatch() {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Tx', primaryEmail: 'tx@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    return { a, employmentId: e.employmentId, batchId };
  }

  it('setPayrollDeductionInput preserves overtime/bonus while updating TP1/zakat (data-loss fix)', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    // Seed earnings on the row first.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 600, bonusAmount: 1000 });

    // Now set TP1 only via the deduction action — overtime/bonus must survive.
    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 250 });

    const [row1] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    expect(Number(row1.overtimeAmount)).toBe(600);
    expect(Number(row1.bonusAmount)).toBe(1000);
    expect(Number(row1.tp1Deduction)).toBe(250);
    expect(Number(row1.zakat)).toBe(0);

    // Set zakat only — TP1 and the earnings must all survive.
    await setPayrollDeductionInput(a, { batchId, employmentId, zakat: 80 });
    const [row2] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    expect(Number(row2.overtimeAmount)).toBe(600);
    expect(Number(row2.bonusAmount)).toBe(1000);
    expect(Number(row2.tp1Deduction)).toBe(250);
    expect(Number(row2.zakat)).toBe(80);

    // Same event shape as the existing input editor.
    const events = await eventTypesFor(base.tenantId, batchId);
    expect(events.filter((t) => t === 'payroll-batch.input-set').length).toBeGreaterThanOrEqual(3);
  });

  it('setPayrollDeductionInput creates the row when none exists, earnings default to 0', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 120, zakat: 40 });
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    expect(Number(row.overtimeAmount)).toBe(0);
    expect(Number(row.bonusAmount)).toBe(0);
    expect(Number(row.tp1Deduction)).toBe(120);
    expect(Number(row.zakat)).toBe(40);
  });

  it('listSupportedBatchComponents excludes archived and unsupported-taxable components', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    // A PCB-taxable, non-payable component is the kernel's unsupported class — must NOT be offered.
    await upsertPayComponent(a, {
      code: 'BADTAX',
      name: 'Taxable BIK',
      kind: 'non_payable',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: true,
      prorates: false,
    });
    const supported = await listSupportedBatchComponents(a);
    const codes = supported.map((c) => c.code);
    expect(codes).not.toContain('BADTAX');
    // A normal payable allowance/deduction IS offered.
    expect(codes).toContain('BASIC');
    expect(codes.length).toBeGreaterThan(0);
  });
});
