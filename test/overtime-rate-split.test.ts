/**
 * "Different rate of overtime" — the single manual overtime input is split into four rate-labelled
 * RM-amount buckets (1.0× flat / 1.5× normal working day / 2.0× rest day / 3.0× public holiday). The
 * UI/action sums the four into `overtime_amount` (the single scalar every downstream reader uses) and
 * persists the decomposition in `payroll_input.ot_breakdown` so the four inputs can be re-prefilled.
 *
 * Guards:
 *  1. Sum + persist: setPayrollInput with overtimeAmount = sum + otBreakdown writes both, and emits
 *     exactly one input-set event whose fieldsChanged carries 'otBreakdown' — and NO RM amounts
 *     (ADR-0030 Layer-0).
 *  2. TP1 wrapper preserves the breakdown and the OT total (and claimAllowance).
 *  3. Bonus-enact (core/performance.enactCompAction) preserves the breakdown + OT total.
 *  4. Prefill reconciliation: after a manual split, prefillOvertimeFromAttendance resets ot_breakdown
 *     to NULL and overwrites overtime_amount.
 *  5. Legacy gate-off: a row with only overtimeAmount flows through generatePayslips with a golden
 *     payslip.overtimePay.
 *  6. Gate-on parity: with the `typed_pay_components` module entitled, the bucket-sum produces the same
 *     golden payslip.overtimePay.
 *  7. All-zero: four zeros zero overtime_amount (a manual save can always zero OT — unchanged UX).
 *
 * ADR-0077 slice 3 — guards 5 and 6 are a GATE-OFF/GATE-ON pair, and the gate is now the per-tenant
 * `typed_pay_components` entitlement (`isModuleEnabled`), not TYPED_PAY_COMPONENTS_ENABLED. That makes
 * the CONTEXT the thing that decides: `adminCtx` is `entitlementsExempt: 'harness'` and therefore
 * answers TRUE for every catalogued module, so under it BOTH halves would take the typed path and the
 * parity comparison would compare the typed kernel against itself. Both halves therefore call
 * `generatePayslips` through `entitledCtx`, a REAL snapshot resolved from this tenant's rows —
 * point-in-time, so the ON half resolves it AFTER the setModule grant. Fixture building (hire, comp,
 * batch, inputs, backfills) keeps the exempt `adminCtx`: none of it is gated, and that is what the
 * marker is for.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createBatch,
  generatePayslips,
  prefillOvertimeFromAttendance,
  setPayrollDeductionInput,
  setPayrollInput,
} from '../core/payroll';
import { enactCompAction } from '../core/performance';
import {
  backfillBatchComponentsFromInput,
  backfillEmploymentComponentsFromCompensation,
  seedPayComponentCatalog,
} from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

describe('Overtime rate split — four rate-labelled RM buckets summed into overtime_amount', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // No gate reset needed any more: seedBase seeds NO tenant_module row for `typed_pay_components`
    // under this suite's env, and a missing row IS disabled (C7). The gate-off test asserts that state
    // explicitly rather than relying on it.
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hireWithBatch(email = 'ot@acme.test') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'OT Split', primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    return { a, personId: e.personId, employmentId: e.employmentId, batchId };
  }

  const rowOf = async (batchId: string) => {
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    return row;
  };

  it('sums the four buckets into overtime_amount, persists ot_breakdown, and the event is Layer-0', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const breakdown = { flat: 100, normal: 150, rest: 200, holiday: 300 }; // sum = 750
    const sum = breakdown.flat + breakdown.normal + breakdown.rest + breakdown.holiday;

    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: sum, otBreakdown: breakdown });

    const row = await rowOf(batchId);
    expect(Number(row.overtimeAmount)).toBe(750);
    expect(row.otBreakdown).toEqual(breakdown);

    // Exactly one input-set event for this batch, fieldsChanged includes 'otBreakdown'.
    const events = await eventTypesFor(base.tenantId, batchId);
    expect(events.filter((t) => t === 'payroll-batch.input-set').length).toBe(1);
    const payload = (await latestEventPayload(base.tenantId, batchId, 'payroll-batch.input-set'))!;
    expect(payload.fieldsChanged).toContain('otBreakdown');
    // Layer-0: the payload references the row by id and lists FIELD NAMES only — no RM amounts and no
    // per-bucket figures. Assert the payload shape is exactly {employmentId, payrollInputId, fieldsChanged}
    // and fieldsChanged is a list of string names (never numbers, never the breakdown object).
    expect(Object.keys(payload).sort()).toEqual(['employmentId', 'fieldsChanged', 'payrollInputId']);
    const fc = payload.fieldsChanged as unknown[];
    expect(fc.every((f) => typeof f === 'string')).toBe(true);
    expect(payload).not.toHaveProperty('otBreakdownValue');
    expect(payload).not.toHaveProperty('flat');
    expect(payload).not.toHaveProperty('amounts');
  });

  it('setPayrollDeductionInput (TP1-only) preserves ot_breakdown, overtime_amount and claimAllowance', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const breakdown = { flat: 0, normal: 150, rest: 200, holiday: 0 }; // sum = 350
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 350, otBreakdown: breakdown });
    // Seed a claimAllowance that must survive by omission (it is not enumerated in setPayrollInput.set()).
    await owner.db
      .update(schema.payrollInput)
      .set({ claimAllowance: '120.00' })
      .where(eq(schema.payrollInput.batchId, batchId));

    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 250 });

    const row = await rowOf(batchId);
    expect(Number(row.overtimeAmount)).toBe(350);
    expect(row.otBreakdown).toEqual(breakdown);
    expect(Number(row.tp1Deduction)).toBe(250);
    expect(Number(row.claimAllowance)).toBe(120);
  });

  it('enacting a bonus preserves ot_breakdown and overtime_amount (regression)', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const breakdown = { flat: 50, normal: 100, rest: 0, holiday: 150 }; // sum = 300
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 300, otBreakdown: breakdown });

    // A minimal finalized + recommended review, inserted as owner (bypasses RLS for the fixture).
    const [cycle] = await owner.db
      .insert(schema.reviewCycle)
      .values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        name: '2026 Annual',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        status: 'open',
        ratingScale: [{ value: 1, label: 'Low' }, { value: 5, label: 'High' }],
      })
      .returning({ id: schema.reviewCycle.id });
    const [review] = await owner.db
      .insert(schema.performanceReview)
      .values({
        tenantId: base.tenantId,
        cycleId: cycle.id,
        employmentId,
        status: 'submitted',
        submittedAt: new Date(),
        recommendedBonus: '2000.00',
        compActionStatus: 'recommended',
      })
      .returning({ id: schema.performanceReview.id });

    await enactCompAction(a, { reviewId: review.id, bonusBatchId: batchId });

    const row = await rowOf(batchId);
    expect(Number(row.bonusAmount)).toBe(2000);
    // Both the OT total and its decomposition survive the bonus enact.
    expect(Number(row.overtimeAmount)).toBe(300);
    expect(row.otBreakdown).toEqual(breakdown);
  });

  it('prefillOvertimeFromAttendance overwrites overtime_amount and resets ot_breakdown to NULL', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 750,
      otBreakdown: { flat: 100, normal: 150, rest: 200, holiday: 300 },
    });

    // Drop wages under the RM4,000 First-Schedule OT eligibility gate so the prefill actually applies
    // (basic 5000 would be marked ineligible and leave the manual figure alone). One workday OT record
    // gives the monetizer something to compute.
    await setCompensation(a, { employmentId, basicSalary: 2000, monthlyAllowance: 0, effectiveFrom: '2026-05-01' });
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });

    const res = await prefillOvertimeFromAttendance(a, { batchId });
    expect(res.applied).toBe(1);

    const row = await rowOf(batchId);
    // overtime_amount is now the statutory total (non-zero, overwriting the manual 750), and the stale
    // manual decomposition is cleared to NULL (the reconciliation the plan requires).
    expect(Number(row.overtimeAmount)).toBeGreaterThan(0);
    expect(row.otBreakdown).toBeNull();
  });

  it('legacy gate-off: overtimeAmount-only flows to payslip.overtimePay (golden)', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    // No breakdown supplied — the legacy single-scalar path.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 750 });
    const row = await rowOf(batchId);
    expect(row.otBreakdown).toBeNull();

    // GATE OFF = no `typed_pay_components` row for this tenant. seedBase seeds none, so this DELETE is
    // already a no-op; it is written out because what the test asserts is the missing-row (= disabled,
    // C7) path, not an incidental default that could quietly change. The kernel must be driven through
    // entitledCtx — adminCtx is entitlementsExempt and would answer TRUE, i.e. run the typed path here.
    await setModule(base.tenantId, 'typed_pay_components', null);
    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.overtimePay)).toBe(750);
  });

  it('gate-on parity: the bucket sum produces the same payslip.overtimePay as gate-off', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 750,
      otBreakdown: { flat: 100, normal: 150, rest: 200, holiday: 300 },
    });

    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    await backfillBatchComponentsFromInput(a, batchId);
    // GATE ON — an active tenant_module row, then a snapshot resolved AFTER it (point-in-time).
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const gated = await entitledCtx(base);
    await generatePayslips(gated, { batchId });

    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    // The bucket sum (750) lands in overtime_amount, which is exactly the scalar the gate-on path reads.
    expect(Number(ps.overtimePay)).toBe(750);
  });

  it('all-zero buckets zero overtime_amount (a manual save can zero OT, unchanged UX)', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    // First set a non-zero split, then post four zeros.
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 500,
      otBreakdown: { flat: 500, normal: 0, rest: 0, holiday: 0 },
    });
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 0,
      otBreakdown: { flat: 0, normal: 0, rest: 0, holiday: 0 },
    });

    const row = await rowOf(batchId);
    expect(Number(row.overtimeAmount)).toBe(0);
    expect(row.otBreakdown).toEqual({ flat: 0, normal: 0, rest: 0, holiday: 0 });
  });
});
