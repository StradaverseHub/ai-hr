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
 * THE CONTEXT CHOICE, STATED ACCURATELY. This paragraph used to say `adminCtx` is
 * `entitlementsExempt: 'harness'` and therefore answers TRUE for every catalogued module. That WAS true
 * when this file was converted and it is no longer: `test/harness.ts` now gives `adminCtx` a snapshot
 * derived from `legacyEnabledModulesIn(process.env)` — the same helper `seedBase` uses to choose its
 * rows — precisely because the exemption was silently switching four modules ON for 247 files. So a
 * gate CAN close through `adminCtx` today, and the fixture and the database agree by construction.
 *
 * Guards 4 and 4b nevertheless keep `entitledCtx`, and that is still the right call rather than
 * leftover scaffolding: `beforeEach` mutates this tenant's entitlements (the explicit
 * `setModule(..., null)`) AFTER the point a synthetic snapshot would have been frozen, and only
 * `entitledCtx` reads the tenant's REAL rows. It is the context that makes the ABSENT
 * `typed_pay_components` row — not an env var, not an assumption baked into a fixture — decide the
 * earnings path. Everything else in the file touches no gate, so it keeps the synchronous `adminCtx`.
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

  /**
   * ── a96d320c — THE HOURS AND THE RATE, WRITTEN DOWN AT THE MOMENT THEY EXIST ──────────────────────
   *
   * The board item asked the payslip to show the overtime rate and the hours behind it. It could not,
   * because nothing recorded them: the statutory engine produced an ordinary rate of pay, an hourly rate
   * and five legs with their own quantities, and `prefillOvertimeFromAttendance` kept the RINGGIT TOTAL
   * and discarded the rest. `payroll_input.ot_derivation` (migration 0479) is where they go now, and
   * `statutory.otDetail` is the payslip's own copy.
   *
   * These four guards are the ones that make the figure trustworthy rather than merely present.
   */
  it('6. the prefill records the hours and the rate behind the OT figure, and they add up to it', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2600); // under the ceiling
    // 2h on an ordinary working day. ORP = 2600/26 = 100.00; hourly = 100/8 = 12.50; a workday overtime
    // hour is paid at 1.5 x hourly = 18.75, so 2 hours is 37.50 — EA s.60A(3)(a).
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });

    const row = await rowOf(batchId);
    const det = row.otDerivation!;
    expect(det, 'the derivation is stamped on the row whose figure it explains').toBeTruthy();
    expect(det.orp).toBe(100);
    expect(det.hourly).toBe(12.5);
    expect(det.lines).toEqual([{ kind: 'workday', qty: 2, unit: 'hours', rate: 18.75, amount: 37.5 }]);
    // THE PROPERTY THAT MAKES IT PRINTABLE, asserted rather than assumed: the reader's own arithmetic.
    for (const l of det.lines) expect(Math.round(l.qty * l.rate * 100) / 100).toBe(l.amount);
    // …and the legs are the whole of the figure, not a sample of it.
    expect(det.lines.reduce((s, l) => s + l.amount, 0)).toBe(Number(row.overtimeAmount));
    expect(det.total).toBe(Number(row.overtimeAmount));
  });

  it('7. generatePayslips copies the detail onto the payslip, and ONLY when it still explains the figure', async () => {
    const { a, employmentId, batchId } = await hireWithBatch(2600);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    await generatePayslips(await entitledCtx(base), { batchId });

    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const stat = ps.statutory as { otDetail?: { total: number; lines: { kind: string; qty: number; rate: number; amount: number }[] } };
    expect(stat.otDetail, 'the payslip carries its own copy of the derivation').toBeTruthy();
    // THE GATE. The copy is on the slip only because its total is still the overtime figure the slip
    // prints — this is the assertion that a decomposition can never caption a figure it does not explain.
    expect(stat.otDetail!.total).toBe(Number(ps.overtimePay));
    expect(stat.otDetail!.lines.map((l) => l.kind)).toEqual(['workday']);
  });

  it('8. a hand-keyed overtime figure carries NO detail — neither on the input row nor on the payslip', async () => {
    // A number an operator typed is not a number the statutory engine decomposed. Two independent
    // mechanisms say so, and the test asserts BOTH, because either alone would be a single point of
    // failure on a money document: `setPayrollInput` clears the stamp, and the copy at generate time is
    // gated on an equality the cleared stamp cannot satisfy.
    const { a, employmentId, batchId } = await hireWithBatch(2600);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect((await rowOf(batchId)).otDerivation, 'precondition: the prefill did stamp one').toBeTruthy();

    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 250 });
    expect((await rowOf(batchId)).otDerivation, 'a manual save clears it').toBeNull();

    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect((ps.statutory as Record<string, unknown>).otDetail).toBeUndefined();
    expect(Number(ps.overtimePay)).toBe(250);
  });

  it('9. a TP1-only write leaves the detail alone, exactly as it leaves the provenance alone', async () => {
    // The mirror of guard 3. A deduction-only round-trip does not touch the OT figure, so it must not
    // touch the explanation of it either — otherwise keying a TP1 relief would silently strip the hours
    // off somebody's payslip.
    const { a, employmentId, batchId } = await hireWithBatch(2600);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    await setPayrollDeductionInput(a, { batchId, employmentId, tp1Deduction: 250 });
    const row = await rowOf(batchId);
    expect(row.otSource).toBe('attendance');
    expect(row.otDerivation, 'the derivation survives a deduction-only write').toBeTruthy();
    expect(row.otDerivation!.lines).toHaveLength(1);
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
