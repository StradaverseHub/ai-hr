/**
 * Fix-5 — Overtime integrity (audit M#17 provenance, L#29 eligibility).
 *
 * The four manual OT buckets are RM amounts the admin keys; the separate "Prefill OT from attendance"
 * runs the statutory s.60/60A/60D engine. Before this fix there was NO provenance flag distinguishing
 * an attendance-derived OT total from a manually-keyed one, so a casual manual Save could silently
 * clobber a statutory prefill (and vice-versa) with no signal.
 *
 * Guards (M#17):
 *  1. prefillOvertimeFromAttendance stamps ot_source='attendance' and the engine total + provenance
 *     survive a re-read.
 *  2. A manual setPayrollInput stamps ot_source='manual' (overwriting any prior 'attendance').
 *  3. The TP1-only deduction wrapper does NOT touch ot_source (provenance is sticky to the last OT write).
 *  4. generatePayslips carries ot_source onto the payslip statutory snapshot (auditor traceability).
 *
 * Guard (L#29):
 *  5. batchInputRows surfaces the s.60I(1A) ORP (wages/26) + hourly (ORP/8) basis and an
 *     `otEligible=false` flag for a >RM4,000 earner so the editor can show the eligibility note.
 *
 * TYPED PAY COMPONENTS ARE OFF FOR THIS WHOLE FILE, and that is load-bearing rather than incidental.
 * The kernel's earnings source is gated (`isModuleEnabled(ctx, 'typed_pay_components')`,
 * core/payroll.ts): with it ON the payslip's OT figure comes from the COMPONENT tables, and this file
 * seeds no components — so the slip's overtime would be 0 and `statutory.otSource` (stamped only when
 * `slipOvertime > 0`) would never appear, silently gutting guards 4 and 4b. This used to be expressed
 * as `delete process.env.TYPED_PAY_COMPONENTS_ENABLED`; under ADR-0077 slice 3 it is the ABSENCE of a
 * `tenant_module` row (a missing row is disabled, C7), asserted explicitly in beforeEach.
 *
 * That also forces the CONTEXT choice: `adminCtx` is `entitlementsExempt: 'harness'` and answers TRUE
 * for every catalogued module, so it can build fixtures but structurally cannot express "this module is
 * off". Guards 4 and 4b therefore drive `generatePayslips` through `entitledCtx`, a real snapshot
 * resolved from this tenant's (row-less) entitlements. Everything else in the file touches no gate, so
 * it keeps the synchronous exempt fixture context.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  batchInputRows,
  createBatch,
  generatePayslips,
  prefillOvertimeFromAttendance,
  setPayrollDeductionInput,
  setPayrollInput,
} from '../core/payroll';
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

describe('Overtime provenance (ot_source) + eligibility surface', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // seedBase seeds NO tenant_module row for this code under the suite's env, so this DELETE is a
    // no-op today — kept explicit because what the file asserts is the disabled (missing-row) path,
    // and a future change to the seed set must not silently switch the legacy earnings path off.
    await setModule(base.tenantId, 'typed_pay_components', null);
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hireWithBatch(basicSalary: number, email = 'otp@acme.test') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'OT Prov', primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary,
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

  it('1. prefill stamps ot_source=attendance and the engine total + provenance survive a re-read', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2000); // under the RM4,000 ceiling
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
    expect(row.otSource).toBe('attendance');
    const engineTotal = Number(row.overtimeAmount);
    expect(engineTotal).toBeGreaterThan(0);

    // Re-read (a second select) returns the same provenance + total — nothing silently clears them.
    const reread = await rowOf(batchId);
    expect(reread.otSource).toBe('attendance');
    expect(Number(reread.overtimeAmount)).toBe(engineTotal);
  });

  it('2. a manual setPayrollInput stamps ot_source=manual, overwriting a prior attendance stamp', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2000);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect((await rowOf(batchId)).otSource).toBe('attendance');

    // The admin now keys a manual figure — provenance flips to 'manual'.
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 250,
      otBreakdown: { flat: 250, normal: 0, rest: 0, holiday: 0 },
    });
    const row = await rowOf(batchId);
    expect(row.otSource).toBe('manual');
    expect(Number(row.overtimeAmount)).toBe(250);
  });

  it('3. the TP1-only deduction wrapper leaves ot_source untouched (sticky to the last OT write)', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2000);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect((await rowOf(batchId)).otSource).toBe('attendance');

    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 250 });
    const row = await rowOf(batchId);
    // The deduction-only path must not be read as a manual OT write — provenance stays 'attendance'.
    expect(row.otSource).toBe('attendance');
    expect(Number(row.tp1Deduction)).toBe(250);
  });

  it('4. generatePayslips carries ot_source onto the payslip statutory snapshot', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2000);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });

    // Real snapshot (typed_pay_components has no row ⇒ disabled), so the kernel takes the legacy
    // comp+payroll_input earnings path and the OT figure — hence otSource — reaches the slip.
    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const stat = ps.statutory as Record<string, unknown>;
    expect(stat.otSource).toBe('attendance');
  });

  it('4b. a manual OT figure carries ot_source=manual onto the payslip snapshot', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(5000); // over the ceiling — manual/ex-gratia OT
    await setPayrollInput(a, {
      batchId,
      employmentId,
      overtimeAmount: 300,
      otBreakdown: { flat: 300, normal: 0, rest: 0, holiday: 0 },
    });
    // Same reason as guard 4 — see the file header on why this one call cannot use the exempt adminCtx.
    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const stat = ps.statutory as Record<string, unknown>;
    expect(stat.otSource).toBe('manual');
  });

  it('5. batchInputRows surfaces ORP/hourly basis and otEligible=false for a >RM4,000 earner', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(5000); // 5000 > RM4,000 ceiling
    const rows = await batchInputRows(a, batchId);
    const row = rows.find((r) => r.employmentId === employmentId)!;
    expect(row).toBeTruthy();
    // ORP = wages/26, hourly = ORP/8 (s.60I(1A)). Surfaced read-only beside the inputs.
    expect(row.orp).toBeCloseTo(5000 / 26, 2);
    expect(row.hourly).toBeCloseTo(5000 / 26 / 8, 2);
    // Above the s.60A RM4,000 ceiling — statutory OT not mandated.
    expect(row.otEligible).toBe(false);
  });

  it('5b. batchInputRows marks an under-ceiling earner otEligible=true', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(3000);
    const rows = await batchInputRows(a, batchId);
    const row = rows.find((r) => r.employmentId === employmentId)!;
    expect(row.otEligible).toBe(true);
    expect(row.orp).toBeCloseTo(3000 / 26, 2);
  });
});
