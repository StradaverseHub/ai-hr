/**
 * ADR-0035 1A — pay-component completion: per-component rounding (#15) shapes the payable amount in the
 * gated kernel (default 'none' = exact, keeping the byte-identical guarantee that typed-components-compat
 * already proves); the EA-form-line + rounding attributes persist and are validated (#14/#15); and a
 * hard-delete is GUARDED when the component is referenced, while archive stays always-safe (#21).
 *
 * ADR-0077 slice 3: the kernel gate is the per-tenant `typed_pay_components` module entitlement
 * (`isModuleEnabled(ctx, …)`), not a deployment env flag. So the rounding test GRANTS the row with
 * setModule() and then re-resolves the session through `entitledCtx` — the snapshot is point-in-time,
 * so a context built before the grant would still say the module is off and the kernel would take the
 * legacy earnings path (allowance 0, since compensation carries monthlyAllowance 0) instead of the
 * typed one this test is about.
 *
 * The setup steps deliberately keep running on `adminCtx`, whose snapshot is derived from the same two
 * helpers seedBase uses and therefore has `typed_pay_components` OFF under the suite's env. That
 * preserves the original ordering exactly: the batch was created with the gate off, and only
 * generatePayslips ever saw it on.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  deletePayComponent,
  listPayComponents,
  PayComponentInUseError,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let base: Base;
const idByCode = async (b: Base, code: string) => (await listPayComponents(adminCtx(b))).find((c) => c.code === code)!.id;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  // No explicit "turn the gate off" step, and no afterEach cleanup either: seedBase seeds NO
  // tenant_module row for `typed_pay_components` under the suite's env, and a missing row IS disabled
  // (C7). The row lives on the per-test tenant, which resetDb truncates, so a grant cannot leak.
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0035 1A — pay-component rounding + attributes + delete guard', () => {
  // #15 — a wage allowance of 500.75 rounds per the component's method (full month ⇒ factor 1).
  it.each([
    ['none', 500.75],
    ['down', 500],
    ['up', 501],
    ['nearest', 501],
  ])('rounding=%s applies in the gated kernel ⇒ allowance %s', async (method, expected) => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Round', primaryEmail: `round_${method}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    // Compensation puts the employee on the batch roster; the typed-component path overrides the math.
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    // BASIC (exact) + a custom wage allowance carrying the rounding under test.
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, 'BASIC'), amount: 5000, effectiveFrom: '2026-01-01' });
    await upsertPayComponent(a, {
      code: 'RND_ALLOW', name: 'Rounding allowance', kind: 'allowance',
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: true, roundingMethod: method,
    });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, 'RND_ALLOW'), amount: 500.75, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // Gate ON for the kernel run only — grant the row, then RE-RESOLVE, because `a`'s snapshot was
    // taken before the grant and would still route the batch down the legacy earnings path.
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const gated = await entitledCtx(base);
    await generatePayslips(gated, { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.allowance)).toBeCloseTo(expected, 2);
  });

  /**
   * Feedback 862ed0ad — the kernel STAMPS the per-item detail behind each summarised figure.
   *
   * Before this, earningsOf summed recurring pay items into wageAllow/ot/bonusAmt/reimburse/deduct and
   * kept nothing per item, so an "Allowance MYR 200.00" line on Transaction View had no stored detail to
   * disclose. The reporter accepted that it can only work forwards; this pins that it now works at all.
   *
   * The assertion that matters is the SUM: the lines under a figure must add up to the figure itself.
   * They can only disagree if something recomputes rather than reads, which is what the plan forbade.
   */
  it('stamps per-item component lines whose per-figure sums equal the stored figures', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Itemised', primaryEmail: 'itemised@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011299' });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, 'BASIC'), amount: 5000, effectiveFrom: '2026-01-01' });

    // Two separate allowances that both land in the wage figure — the reporter's exact complaint: a single
    // total with no way to see which allowances make it up.
    for (const [code, name, amount] of [['ALW_TRAVEL', 'Travel Allowance', 120], ['ALW_PHONE', 'Phone Allowance', 80]] as const) {
      await upsertPayComponent(a, {
        code, name, kind: 'allowance',
        includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
        isNonPayable: false, prorates: true, roundingMethod: 'none',
      });
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, code), amount, effectiveFrom: '2026-01-01' });
    }

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const gated = await entitledCtx(base);
    await generatePayslips(gated, { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

    const st = ps.statutory as { componentLines?: { code: string; name: string; amount: number; buckets: { bucket: string; amount: number }[] }[] };
    const lines = st.componentLines ?? [];
    // Stated absolutely, not derived from `lines` itself: an expectation computed FROM the value under
    // test passes when that value is empty, which is how a vacuous assertion reads as coverage.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const byCode = new Map(lines.map((l) => [l.code, l]));
    // Named, so the screen can show "Travel Allowance" rather than a code the reporter does not use.
    expect(byCode.get('ALW_TRAVEL')?.name).toBe('Travel Allowance');
    expect(byCode.get('ALW_TRAVEL')?.amount).toBeCloseTo(120, 2);
    expect(byCode.get('ALW_PHONE')?.name).toBe('Phone Allowance');
    expect(byCode.get('ALW_PHONE')?.amount).toBeCloseTo(80, 2);

    // THE INVARIANT: what is listed under the wage figure adds up to the wage figure.
    const wage = lines.flatMap((l) => l.buckets.filter((b) => b.bucket === 'wage').map((b) => b.amount));
    expect(wage.reduce((t, n) => t + n, 0)).toBeCloseTo(Number(ps.allowance), 2);
    // And a record-only component would NOT be here — those belong to recordLines, under a heading that
    // says they do not affect pay. Nothing in this run is record-only, so every line moved cash.
    expect(lines.every((l) => l.buckets.length > 0)).toBe(true);
  });

  // #14/#15 — the attributes persist; out-of-vocabulary values are cleaned (line→null, rounding→none).
  it('persists EA-form line + rounding, and rejects invalid values', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, {
      code: 'HOUSING', name: 'Housing', kind: 'allowance',
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: true, eaFormLine: 'bik', roundingMethod: 'nearest',
    });
    let housing = (await listPayComponents(a)).find((c) => c.code === 'HOUSING')!;
    expect(housing.eaFormLine).toBe('bik');
    expect(housing.roundingMethod).toBe('nearest');

    await upsertPayComponent(a, {
      code: 'HOUSING', name: 'Housing', kind: 'allowance',
      includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: true, eaFormLine: 'not-a-line', roundingMethod: 'sideways',
    });
    housing = (await listPayComponents(a)).find((c) => c.code === 'HOUSING')!;
    expect(housing.eaFormLine).toBeNull();
    expect(housing.roundingMethod).toBe('none');
  });

  // #21 — hard delete is blocked while referenced; archive (soft) is always allowed; once unreferenced,
  // delete succeeds.
  it('guards delete of an in-use component; allows an unused one', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Del', primaryEmail: 'del@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
    });
    await upsertPayComponent(a, {
      code: 'PHONE', name: 'Phone allowance', kind: 'allowance',
      includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: true,
    });
    const phoneId = await idByCode(base, 'PHONE');
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: phoneId, amount: 100, effectiveFrom: '2026-01-01' });

    // In use ⇒ refused.
    await expect(deletePayComponent(a, phoneId)).rejects.toBeInstanceOf(PayComponentInUseError);

    // An unreferenced component deletes cleanly.
    await upsertPayComponent(a, {
      code: 'UNUSED', name: 'Unused', kind: 'allowance',
      includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false,
      isNonPayable: false, prorates: true,
    });
    const unusedId = await idByCode(base, 'UNUSED');
    await deletePayComponent(a, unusedId);
    expect((await listPayComponents(a, { includeArchived: true })).some((c) => c.id === unusedId)).toBe(false);
  });
});
