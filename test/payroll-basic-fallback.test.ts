/**
 * R37 62e370b0 → feedback 64fb5e48 — "Basic salary source for payroll processing".
 *
 * ADR-0077 slice 3: the typed earnings path is gated by the per-tenant `typed_pay_components`
 * ENTITLEMENT ROW (`isModuleEnabled(ctx, 'typed_pay_components')`), not by the
 * TYPED_PAY_COMPONENTS_ENABLED env var. Both directions are rows here: the legacy baseline runs with NO
 * row (seedBase seeds none — a missing row is disabled, C7) and the typed leg grants one with
 * `setModule`. Every call whose outcome depends on the gate is driven through `entitledCtx`, because
 * `adminCtx`'s snapshot is a point-in-time copy of the env-parity set and would never see the grant.
 *
 * History: with TYPED_PAY_COMPONENTS_ENABLED on, the typed earnings path used to read basic from the
 * employee's BASIC employment_pay_component, and pre-processing BLOCKED any employee who had a
 * compensation row but no BASIC component (missingBasicComponent). Feedback 64fb5e48 corrects the design:
 * the Personnel Basic Salary record (compensation) is the SINGLE authoritative source of basic pay — a
 * BASIC pay item is never a processing prerequisite, and its amount never overrides the Personnel record.
 *
 * This suite pins the new semantics:
 *   1. SOURCE — the typed earnings path always pays basic from the compensation record; a missing BASIC
 *      component changes nothing (exercised through a subset reprocess AND a full run).
 *   2. NO BLOCKER — a compensation-present / no-BASIC-component employee passes pre-processing and a FULL
 *      run generates their payslip from the Personnel basic (the exact Fiamma scenario in the feedback).
 *
 * The legacy path (no `typed_pay_components` row) and the statutory math are untouched.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;

const payslipOf = async (batchId: string, employmentId: string) => {
  const rows = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  return rows.find((ps) => ps.employmentId === employmentId);
};

const batchStatus = async (batchId: string) => {
  const [row] = await owner.db
    .select({ status: schema.payrollBatch.status })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, batchId));
  return row?.status;
};

async function hire(a: ReturnType<typeof adminCtx>, name: string, ic: string) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@basicfb.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, bankName: 'Maybank', bankAccountNo: '1234567890' });
  return e;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  // ADR-0077 slice 3 — no explicit "turn typed components off" step is needed (and none is possible via
  // env any more): `seedBase` seeds NO `tenant_module` row for typed_pay_components, because test/env.ts
  // deletes TYPED_PAY_COMPONENTS_ENABLED and so the module is outside this process's parity set. A
  // MISSING row IS disabled (C7), so the legacy path is the fixture default. The typed leg of each test
  // grants the row itself and re-resolves the snapshot; the former afterEach cleanup is unnecessary
  // because resetDb truncates tenant_module between tests.
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('feedback 64fb5e48 — Personnel Basic Salary is the authoritative pay source (no BASIC pay item required)', () => {
  it('SOURCE: typed path with compensation present but no BASIC component pays basic from compensation, not zero', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Arjun Kumar', '900101010001');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    // Process the batch on the LEGACY path so we have a processed run to reprocess. "Legacy" is now the
    // ABSENCE of a `typed_pay_components` row on this tenant — resolved from the database through
    // entitledCtx, so the missing row (not a process-wide env var) is what selects the path. Legacy
    // reads basic straight from compensation, so this baseline is correctly 7200.
    const off = await entitledCtx(b);
    expect(off.entitlements?.enabledModules).not.toContain('typed_pay_components');
    const { batchId } = await createBatch(off, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(off, { batchId });
    const legacy = await payslipOf(batchId, emp.employmentId);
    expect(legacy?.basicSalary).toBe('7200.00');

    // Now the typed path goes live for THIS tenant but this employee still has NO BASIC
    // employment_pay_component. A subset reprocess exercises the typed earnings source directly.
    // Re-resolve after the grant: a snapshot is point-in-time, so `off` would still read the module off.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(b);
    // Pin that the grant actually landed in the resolved snapshot. Both legs assert the same 7200 (that
    // agreement IS the point of the test), so a setModule that silently failed would simply re-run the
    // legacy path and leave this green for the wrong reason.
    expect(on.entitlements?.enabledModules).toContain('typed_pay_components');
    await generatePayslips(on, { batchId, reprocessSubset: { employmentIds: [emp.employmentId] } });

    const reprocessed = await payslipOf(batchId, emp.employmentId);
    expect(reprocessed?.basicSalary).toBe('7200.00');
    expect(Number(reprocessed?.grossPay)).toBeGreaterThan(0);
    expect(await batchStatus(batchId)).toBe('processed');
  });

  it('NO BLOCKER: a compensation-present / no-BASIC-component employee passes pre-processing and a FULL run pays them (feedback 64fb5e48)', async () => {
    const a = adminCtx(b);
    // Employee WITH a BASIC component (via backfill).
    const withBasic = await hire(a, 'Has Basic', '900101010002');
    await setCompensation(a, { employmentId: withBasic.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    // Employee with compensation but NO BASIC component (added AFTER the backfill, so it stays un-backfilled) —
    // the exact reported Fiamma case: an active Basic Salary in Personnel, no internal BASIC pay item.
    const noBasic = await hire(a, 'Eee Lee Yong', '900101010003');
    await setCompensation(a, { employmentId: noBasic.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    // createBatch consults no entitlement, so it stays on the setup context exactly where it was.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });

    // Module ON for this tenant: nobody is blocked — the old missingBasicComponent gate is gone, and the
    // strengthened checks find nothing wrong (both employees have an active, period-covering, positive
    // Personnel basic). The grant must be resolved into a fresh snapshot, and it must be that snapshot the
    // advisory runs under: the typed path is the only one that reads the BASIC component rows at all, so
    // under the off context these assertions would prove nothing about the removed blocker.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(b);
    expect(on.entitlements?.enabledModules).toContain('typed_pay_components');
    const checks = await preProcessAdvisory(on, batchId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    // Neither employee's BASIC state is stale: one mirrors compensation, the other has no component at all.
    expect(checks.staleBasicComponent ?? []).toHaveLength(0);

    // The FULL run processes and pays BOTH employees from their Personnel basic.
    await generatePayslips(on, { batchId });
    expect((await payslipOf(batchId, noBasic.employmentId))?.basicSalary).toBe('7200.00');
    expect((await payslipOf(batchId, withBasic.employmentId))?.basicSalary).toBe('5000.00');
    expect(await batchStatus(batchId)).toBe('processed');
  });
});
