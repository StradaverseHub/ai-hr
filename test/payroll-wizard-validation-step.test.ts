/**
 * R37 70764928 — Payroll Process wizard Validation step (pre-batch pre-processing checks).
 *
 * The wizard now runs a Validation step BEFORE the batch exists, over the live selection (companies +
 * period + touched employee scope). `preProcessAdvisoryForSelection` powers it and REUSES the exact same
 * `preProcessChecksTx` core as the batch-scoped `preProcessAdvisory`, so what the operator sees on the
 * Validation step is what the terminal Process action will enforce.
 *
 * These tests pin the three UI states the step renders:
 *   • RED (blocks advance) — a selected employee with no current compensation row.
 *   • AMBER (warns, still allowed) — a selected employee missing statutory / bank details only.
 *   • GREEN (clean) — every selected employee complete.
 * Plus: the touched-selection scope narrows the check the same way the batch scope does (a comp-less
 * employee outside the selection neither appears nor blocks).
 *
 * ADR-0077 slice 3: the stale-BASIC-component check inside `preProcessChecksTx` is gated on the
 * per-tenant `typed_pay_components` module entitlement, not on a deployment env flag. The first four
 * tests run with the gate OFF and that is now the SEEDED baseline (seedBase writes no tenant_module row
 * for that code under the suite's env, and a missing row IS disabled — C7), so they need no gate
 * handling at all. The fifth test needs it ON, so it grants the row with setModule() and then re-resolves
 * the session with entitledCtx: `adminCtx`'s snapshot is derived from process.env and would report the
 * module off no matter what rows exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { preProcessAdvisoryForSelection } from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;

async function hire(a: ReturnType<typeof adminCtx>, name: string) {
  return hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@wizval.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
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

const PERIOD = '2026-05';

describe('R37 70764928 — wizard Validation step (preProcessAdvisoryForSelection)', () => {
  it('RED: a comp-less employee is a blocker that would stop the Process button', async () => {
    const a = adminCtx(b);
    const paid = await hire(a, 'Paid Val');
    await setCompensation(a, { employmentId: paid.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: paid.personId, icNumber: '900101010101', bankName: 'Maybank', bankAccountNo: '1234500001' });
    const noComp = await hire(a, 'NoComp Val'); // no compensation ⇒ BLOCKER

    const checks = await preProcessAdvisoryForSelection(a, { companyIds: [b.companyId], payPeriod: PERIOD });
    const blockers = checks.missingCompensation.length + (checks.zeroBasic?.length ?? 0);

    expect(blockers).toBeGreaterThan(0);
    expect(checks.missingCompensation.map((r) => r.employmentId)).toContain(noComp.employmentId);
    expect(checks.missingCompensation.map((r) => r.employmentId)).not.toContain(paid.employmentId);
  });

  it('AMBER: missing statutory / bank are warnings, not blockers (Process still allowed)', async () => {
    const a = adminCtx(b);
    const noStat = await hire(a, 'Warn NoStat Val');
    await setCompensation(a, { employmentId: noStat.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const noBank = await hire(a, 'Warn NoBank Val');
    await setCompensation(a, { employmentId: noBank.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: noBank.personId, icNumber: '900101010102' });

    const checks = await preProcessAdvisoryForSelection(a, { companyIds: [b.companyId], payPeriod: PERIOD });
    const blockers = checks.missingCompensation.length + (checks.zeroBasic?.length ?? 0);
    const warnings =
      checks.missingStatutory.length + checks.missingBank.length + (checks.staleBasicComponent?.length ?? 0);

    expect(blockers).toBe(0); // amber, not red — advance is NOT blocked
    expect(warnings).toBeGreaterThan(0);
    expect(checks.missingStatutory.map((r) => r.employmentId)).toContain(noStat.employmentId);
    expect(checks.missingBank.map((r) => r.employmentId)).toContain(noBank.employmentId);
    // the statutory-less employee is not double-counted under bank
    expect(checks.missingBank.map((r) => r.employmentId)).not.toContain(noStat.employmentId);
  });

  it('GREEN: every selected employee complete ⇒ no blockers, no warnings', async () => {
    const a = adminCtx(b);
    const one = await hire(a, 'Clean One Val');
    await setCompensation(a, { employmentId: one.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: one.personId, icNumber: '900101010103', bankName: 'CIMB', bankAccountNo: '1234500002' });

    const checks = await preProcessAdvisoryForSelection(a, { companyIds: [b.companyId], payPeriod: PERIOD });

    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    expect(checks.staleBasicComponent ?? []).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(0);
    expect(checks.missingBank).toHaveLength(0);
  });

  it('touched-selection scope narrows the check: a comp-less employee OUTSIDE the selection neither appears nor blocks', async () => {
    const a = adminCtx(b);
    const paid = await hire(a, 'Scoped Paid Val');
    await setCompensation(a, { employmentId: paid.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: paid.personId, icNumber: '900101010104', bankName: 'RHB', bankAccountNo: '1234500003' });
    await hire(a, 'Excluded NoComp Val'); // comp-less, but excluded by the touched selection below

    const checks = await preProcessAdvisoryForSelection(a, {
      companyIds: [b.companyId],
      payPeriod: PERIOD,
      employmentIds: [paid.employmentId],
    });

    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(0);
    expect(checks.missingBank).toHaveLength(0);
  });

  it('AMBER (feedback 64fb5e48): a stale BASIC pay item is a WARNING tier — Process stays allowed', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Stale Wiz Val');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 6500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: emp.personId, icNumber: '900101010105', bankName: 'Maybank', bankAccountNo: '1234500004' });
    // Mirror 6500 into a BASIC component, then revise Personnel to 7000 — the component is now stale.
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7000, effectiveFrom: '2026-02-01' });

    // ADR-0077 slice 3: the stale-BASIC check rides the per-tenant `typed_pay_components` module
    // entitlement (preProcessAdvisoryForSelection passes isModuleEnabled(ctx, …) into
    // preProcessChecksTx), not an env flag. GRANT the row, then RE-RESOLVE the session — an
    // entitlement snapshot is point-in-time, so `a` (built above, before the grant) would still report
    // the module off and the advisory would return no staleBasicComponent rows at all.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const gated = await entitledCtx(b);

    const checks = await preProcessAdvisoryForSelection(gated, { companyIds: [b.companyId], payPeriod: PERIOD });
    // Exactly the step's amber computation: zero blockers, the stale row counted among warnings.
    const blockers = checks.missingCompensation.length + (checks.zeroBasic?.length ?? 0);
    const warnings =
      checks.missingStatutory.length + checks.missingBank.length + (checks.staleBasicComponent?.length ?? 0);
    expect(blockers).toBe(0); // amber, not red — Process is NOT blocked
    expect(warnings).toBeGreaterThan(0);
    expect((checks.staleBasicComponent ?? []).map((r) => r.employmentId)).toEqual([emp.employmentId]);
    // No cleanup: the grant is a row on THIS test's tenant, and resetDb truncates tenant_module in
    // beforeEach, so it cannot leak into the next test the way the process-wide env flag could.
  });
});
