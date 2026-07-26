/**
 * 1.2.4 Zakat Deduction (ADR-0058) — a per-employee zakat-via-salary ELECTION on the MY statutory row.
 * Covers: the setter (persist + validation + off-method nulling + event payload), FIXED auto-apply in the
 * kernel (with the zakat-only setPayrollDeductionInput data-loss guard), PERCENT_OF_PCB derived live in the
 * kernel (no-bonus + bonus month), the staleness regression (recompute on regenerate), non-resident /
 * zero-PCB → 0, the inactive+prior-manual preservation, scope (no orphan rows / no stamp outside scope),
 * the multi-cycle no-double-apply invariant, and RLS (cross-person cannot read/write another's zakat).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  getStatutoryProfileMY,
  setStatutoryProfileMY,
  InvalidZakatSetupError,
} from '../localization/my/statutory';
import {
  createBatch,
  createAdditionalRun,
  generatePayslips,
  setPayrollInput,
  setPayrollDeductionInput,
  prefillFixedZakat,
} from '../core/payroll';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, departmentId?: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

/** The payslip's statutory blob for an employment in a given period (latest matching batch). */
async function statutoryFor(
  ctx: SessionContext,
  employmentId: string,
  period: string,
): Promise<Record<string, number>> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payslip.employmentId, employmentId), eq(schema.payrollBatch.payPeriod, period)))
      .limit(1);
    return (row?.statutory ?? {}) as Record<string, number>;
  });
}

/** The persisted payroll_input.zakat for an employment in a batch (null = no row). */
async function inputZakat(ctx: SessionContext, batchId: string, employmentId: string): Promise<number | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ zakat: schema.payrollInput.zakat })
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)))
      .limit(1);
    return row ? Number(row.zakat) : null;
  });
}

describe('1.2.4 Zakat Deduction', () => {
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

  // ── 1. Setter ──────────────────────────────────────────────────────────────
  it('setter persists the zakat election, nulls the off-method field, and validates', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Setter');

    // Percent election: stores zakatPercent, nulls zakatFixed.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010001',
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.025,
      zakatFixed: 999, // must be nulled by the off-method rule
      zakatEffectiveFrom: '2026-01-01',
      zakatEffectiveTo: '2026-12-31',
    });
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.zakatActive).toBe(true);
    expect(row?.zakatState).toBe('Selangor');
    expect(row?.zakatMethod).toBe('percent_of_pcb');
    expect(Number(row?.zakatPercent)).toBeCloseTo(0.025, 6);
    expect(row?.zakatFixed).toBeNull();
    expect(row?.zakatEffectiveFrom).toBe('2026-01-01');

    // Switch to fixed: stores zakatFixed, nulls zakatPercent.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010001',
      zakatActive: true,
      zakatState: 'Kuala Lumpur',
      zakatMethod: 'fixed',
      zakatFixed: 80,
    });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.zakatMethod).toBe('fixed');
    expect(Number(row?.zakatFixed)).toBe(80);
    expect(row?.zakatPercent).toBeNull();

    // Inactive: drops method + amounts.
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010001', zakatActive: false });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.zakatActive).toBe(false);
    expect(row?.zakatMethod).toBeNull();
    expect(row?.zakatFixed).toBeNull();
  });

  it('setter rejects an unknown state, a missing method, and a missing required amount', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Invalid');
    await expect(
      setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010002', zakatState: 'Atlantis' }),
    ).rejects.toBeInstanceOf(InvalidZakatSetupError);
    await expect(
      setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010002', zakatActive: true }),
    ).rejects.toBeInstanceOf(InvalidZakatSetupError);
    await expect(
      setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: '900101010002',
        zakatActive: true,
        zakatMethod: 'percent_of_pcb',
      }),
    ).rejects.toBeInstanceOf(InvalidZakatSetupError);
  });

  it('the statutory.my.updated event payload carries the zakat fields', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Event');
    // create
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010003' });
    const row = await getStatutoryProfileMY(a, e.personId);
    // update with a zakat election
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010003',
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: 50,
    });
    const payload = await latestEventPayload(base.tenantId, row!.id, 'statutory.my.updated');
    expect(payload).toMatchObject({
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: '50.00',
    });
  });

  // ── 2. Fixed (kernel) ────────────────────────────────────────────────────────
  it('fixed election: kernel stamps statutory.zakat and reduces PCB by the offset', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Fixed');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010010' });

    // Baseline PCB with no zakat.
    const b0 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: b0.batchId });
    const pcbNoZakat = Number((await statutoryFor(a, e.employmentId, '2026-01')).pcb);
    expect(pcbNoZakat).toBeGreaterThan(80);

    // Now an active fixed election of 80.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010010',
      zakatActive: true,
      zakatMethod: 'fixed',
      zakatFixed: 80,
    });
    const b1 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: b1.batchId });
    const st = await statutoryFor(a, e.employmentId, '2026-02');
    expect(Number(st.zakat)).toBe(80);
    // §E.5: zakat offsets PCB → reduced by ~80 vs the no-zakat baseline.
    expect(Number(st.pcb)).toBeCloseTo(pcbNoZakat - 80, 2);
  });

  it('setPayrollDeductionInput: a zakat-only write preserves overtime/bonus (data-loss guard)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Guard');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010011' });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    // Seed OT + bonus on the row.
    await setPayrollInput(a, { batchId: batch.batchId, employmentId: e.employmentId, overtimeAmount: 300, bonusAmount: 200 });
    // A zakat-only deduction write must NOT zero OT/bonus.
    await setPayrollDeductionInput(a, { batchId: batch.batchId, employmentId: e.employmentId, zakat: 90 });
    const [row] = await withTenant(a, (tx) =>
      tx
        .select({ ot: schema.payrollInput.overtimeAmount, bonus: schema.payrollInput.bonusAmount, zakat: schema.payrollInput.zakat })
        .from(schema.payrollInput)
        .where(and(eq(schema.payrollInput.batchId, batch.batchId), eq(schema.payrollInput.employmentId, e.employmentId))),
    );
    expect(Number(row.ot)).toBe(300);
    expect(Number(row.bonus)).toBe(200);
    expect(Number(row.zakat)).toBe(90);
  });

  // ── 3. Percent (no bonus) ─────────────────────────────────────────────────────
  it('percent_of_pcb (no bonus): zakat = percent × pre-offset normal MTD, PCB reduced by the offset', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Pct');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010012' });

    // Baseline PCB (no election) to recover the pre-zakat normal MTD.
    const b0 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: b0.batchId });
    const pcb0 = Number((await statutoryFor(a, e.employmentId, '2026-01')).pcb);
    expect(pcb0).toBeGreaterThan(0);

    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010012',
      zakatActive: true,
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.02,
    });
    const b1 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: b1.batchId });
    const st = await statutoryFor(a, e.employmentId, '2026-02');
    // No bonus this month ⇒ normal pre-zakat MTD ≈ the baseline PCB. zakat ≈ 0.02 × that.
    const expectedZakat = Math.round(0.02 * pcb0 * 100) / 100;
    expect(Number(st.zakat)).toBeCloseTo(expectedZakat, 2);
    expect(Number(st.zakat)).toBeGreaterThan(0);
    // PCB is reduced by the offset.
    expect(Number(st.pcb)).toBeCloseTo(pcb0 - Number(st.zakat), 2);
  });

  // ── 4. Percent (BONUS month) ──────────────────────────────────────────────────
  it('percent_of_pcb in a BONUS month: zakat tracks NORMAL MTD only (independent of the bonus)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat PctBonus');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010013',
      zakatActive: true,
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.02,
    });

    // No-bonus month to capture the normal-MTD-derived zakat.
    const bNoBonus = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: bNoBonus.batchId });
    const zakatNoBonus = Number((await statutoryFor(a, e.employmentId, '2026-01')).zakat);
    expect(zakatNoBonus).toBeGreaterThan(0);

    // A different month WITH a bonus — zakat must stay tied to the normal MTD (bonus excluded).
    const bBonus = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await setPayrollInput(a, { batchId: bBonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 4000 });
    await generatePayslips(a, { batchId: bBonus.batchId });
    const stBonus = await statutoryFor(a, e.employmentId, '2026-02');
    // The bonus adds additional MTD (so total PCB > the no-bonus month), but zakat is on NORMAL MTD only.
    expect(Number(stBonus.zakat)).toBeCloseTo(zakatNoBonus, 2);
    expect(Number(stBonus.pcbBonus ?? 0)).toBeGreaterThan(0);
  });

  // ── 5. Staleness regression ───────────────────────────────────────────────────
  // The in-kernel percent design derives zakat from the LIVE PCB at generate time — never a frozen figure.
  // Two consecutive draft batches with different OT prove it recomputes against the changed PCB (a frozen
  // prefill would carry the same RM amount across both). (generatePayslips flips a batch to processed, so a
  // genuine re-derivation is observed across batches, which is the property under test.)
  it('staleness: a higher-OT month recomputes percent zakat against the new PCB (no frozen figure)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Stale');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010014',
      zakatActive: true,
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.02,
    });

    const b1 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId: b1.batchId });
    const zakat1 = Number((await statutoryFor(a, e.employmentId, '2026-03')).zakat);

    // A later month with a large OT (raises taxable wage ⇒ higher normal MTD).
    const b2 = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await setPayrollInput(a, { batchId: b2.batchId, employmentId: e.employmentId, overtimeAmount: 3000 });
    await generatePayslips(a, { batchId: b2.batchId });
    const zakat2 = Number((await statutoryFor(a, e.employmentId, '2026-04')).zakat);

    expect(zakat2).toBeGreaterThan(zakat1); // derived live against the higher PCB, not frozen
  });

  // ── 6. Non-resident / zero-PCB → 0 ────────────────────────────────────────────
  it('percent_of_pcb yields 0 (no crash) for a non-resident and for a below-threshold earner', async () => {
    const a = adminCtx(base);
    // Non-resident.
    const nr = await hire(a, base, 'Zakat NonRes');
    await setCompensation(a, { employmentId: nr.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: nr.personId,
      icNumber: '900101010015',
      isResident: false,
      zakatActive: true,
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.02,
    });
    // Below-threshold earner (no normal PCB).
    const low = await hire(a, base, 'Zakat Low', base.deptB);
    await setCompensation(a, { employmentId: low.employmentId, basicSalary: 1500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: low.personId,
      icNumber: '900101010016',
      zakatActive: true,
      zakatMethod: 'percent_of_pcb',
      zakatPercent: 0.02,
    });

    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: batch.batchId });
    expect(Number((await statutoryFor(a, nr.employmentId, '2026-01')).zakat)).toBe(0);
    expect(Number((await statutoryFor(a, low.employmentId, '2026-01')).zakat)).toBe(0);
  });

  // ── 7. Inactive + prior manual ────────────────────────────────────────────────
  it('inactive election but a prior manual payroll_input.zakat: the manual value survives', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Zakat Manual');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010017', zakatActive: false });

    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await setPayrollDeductionInput(a, { batchId: batch.batchId, employmentId: e.employmentId, zakat: 55 });
    await generatePayslips(a, { batchId: batch.batchId });
    // Manual override wins (no active election to overwrite it).
    expect(Number((await statutoryFor(a, e.employmentId, '2026-04')).zakat)).toBe(55);
  });

  // ── 8. Scope ──────────────────────────────────────────────────────────────────
  it('scope: an active employee outside batch.scope gets no zakat and no orphan prefill row', async () => {
    const a = adminCtx(base);
    const inEmp = await hire(a, base, 'Zakat InScope', base.deptA);
    const outEmp = await hire(a, base, 'Zakat OutScope', base.deptB);
    for (const emp of [inEmp, outEmp]) {
      await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    }
    await setStatutoryProfileMY(a, { personId: inEmp.personId, icNumber: '900101010018', zakatActive: true, zakatMethod: 'fixed', zakatFixed: 70 });
    await setStatutoryProfileMY(a, { personId: outEmp.personId, icNumber: '900101010019', zakatActive: true, zakatMethod: 'fixed', zakatFixed: 70 });

    // Batch scoped to deptA only (excludes outEmp in deptB).
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05', scope: { departmentIds: [base.deptA] } });
    const { applied } = await prefillFixedZakat(a, { batchId: batch.batchId });
    expect(applied).toBe(1); // only the in-scope employee
    expect(await inputZakat(a, batch.batchId, inEmp.employmentId)).toBe(70);
    expect(await inputZakat(a, batch.batchId, outEmp.employmentId)).toBeNull(); // no orphan row

    await generatePayslips(a, { batchId: batch.batchId });
    expect(Number((await statutoryFor(a, inEmp.employmentId, '2026-05')).zakat)).toBe(70);
    // outEmp has no payslip in this scoped batch.
    expect(await statutoryFor(a, outEmp.employmentId, '2026-05')).toEqual({});
  });

  // ── 9. Multi-cycle (ADR-0024) — no double-apply ───────────────────────────────
  it('multi-cycle: an additional bonus run does not double-apply zakat', async () => {
    // ADR-0077 slice 3: the gate is the `multi_cycle_payroll` MODULE ENTITLEMENT, not
    // MULTI_CYCLE_PAYROLL_ENABLED. seedBase seeds NO row for it (it narrows the parity set by the live
    // env and test/env.ts deletes the flag), and a missing row is DISABLED (C7) — so this test states
    // its own grant, and there is nothing to tear down afterwards because resetDb truncates the row.
    //
    // Driven through `entitledCtx`, NOT `adminCtx`: adminCtx carries `entitlementsExempt: 'harness'`,
    // which answers TRUE for every catalogued module, so the grant below would be ignored and the gate
    // would not be what lets createAdditionalRun through. It also matters for the FIGURES — under an
    // exempt context `typed_pay_components` reads ON too, moving generatePayslips off the legacy
    // earnings path this file's zakat/PCB expectations were written against. The grant must be written
    // BEFORE the context is built, because the snapshot is point-in-time.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'Zakat Multi');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101010020',
      zakatActive: true,
      zakatMethod: 'fixed',
      zakatFixed: 90,
    });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-06', runType: 'bonus' });
    await generatePayslips(a, { batchId: bonus.batchId });

    const slips = await withTenant(a, (tx) =>
      tx
        .select({ runType: schema.payrollBatch.runType, statutory: schema.payslip.statutory })
        .from(schema.payslip)
        .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
        .where(and(eq(schema.payslip.employmentId, e.employmentId), eq(schema.payrollBatch.payPeriod, '2026-06'))),
    );
    const regSt = slips.find((s) => s.runType === 'regular')!.statutory as Record<string, number>;
    const bonusSt = slips.find((s) => s.runType === 'bonus')!.statutory as Record<string, number>;
    // Zakat rides the regular run; the additional run carries the manual-input zakat (0 here) — not 90 again.
    expect(Number(regSt.zakat)).toBe(90);
    expect(Number(bonusSt.zakat ?? 0)).toBe(0);
  });

  // ── 10. RLS ───────────────────────────────────────────────────────────────────
  it('RLS: a non-admin cannot read or write another person’s zakat election', async () => {
    const a = adminCtx(base);
    const me = await hire(a, base, 'Zakat Self');
    const other = await hire(a, base, 'Zakat Other');
    await setStatutoryProfileMY(a, { personId: other.personId, icNumber: '900101010021', zakatActive: true, zakatMethod: 'fixed', zakatFixed: 40 });

    const uSelf = await createAppUser(base.tenantId, me.personId, 'employee');
    const selfCtx: SessionContext = { tenantId: base.tenantId, userId: uSelf, roles: ['employee'] };

    // A bare employee cannot read another person's statutory row (RLS filters it out).
    expect(await getStatutoryProfileMY(selfCtx, other.personId)).toBeNull();

    // A non-admin write is rejected by the row's WITH CHECK (is_admin) policy.
    await expect(
      setStatutoryProfileMY(selfCtx, {
        personId: other.personId,
        icNumber: '900101010021',
        zakatActive: true,
        zakatMethod: 'fixed',
        zakatFixed: 1,
      }),
    ).rejects.toThrow();
  });
});
