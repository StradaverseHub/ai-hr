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
// a96d320c guard 12 — a real policy OT cap, so the "the cap clipped the figure" disqualifier is exercised
// through the kernel path that actually clips rather than through a hand-written mismatch.
import { assignPolicy, createPolicy } from '../core/payroll-policy';
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

  /**
   * ── a96d320c guards 10-13 — THE TWO EQUALITY GATES, PINNED ───────────────────────────────────────
   *
   * Guards 6-9 above prove the derivation is WRITTEN and reaches the payslip. That is not the same as
   * proving the gates REFUSE, and the difference is the whole safety property: with either equality
   * defeated, a payslip prints "2 hours × MYR 18.75" beside an overtime amount that is not 2 × 18.75 —
   * a complete, correct working offered as the explanation of a number nobody was paid. CLAUDE.md §8:
   * never print a figure you cannot stand behind. These four construct the mismatch and assert that NO
   * derivation reaches the payslip — not merely that the money is right.
   *
   * Each names the gate it holds down, because a guard nobody can attribute is a guard nobody maintains.
   */

  it('10. legs that do not add up to the engine total are not stamped AT ALL', async () => {
    // THE WRITE GATE (prefillOvertimeFromAttendance: `legTotal === round2(result.total)`).
    //
    // 100 OT minutes is 1.6666… hours. The stamped quantity is rounded to two places because that is what
    // a reader multiplies — 1.67 — and 1.67 × 18.75 is 31.31, while the engine paid
    // round2(1.6666… × 18.75) = 31.25. Six sen, on a caption that claims to explain the figure beside it.
    // The kernel refuses to stamp the decomposition at all.
    //
    // NOT A CONTRIVED INPUT: `qty` only survives rounding when the minute count is a multiple of three, so
    // an OT figure derived from raw clock times hits this regularly. Whole and quarter hours (15/30/45/60/
    // 90/120) are all multiples of three and keep their detail, which is the ordinary case.
    const { a, employmentId, batchId } = await hireWithBatch(2600);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 100,
    });
    await prefillOvertimeFromAttendance(a, { batchId });

    const row = await rowOf(batchId);
    // THE MONEY IS UNTOUCHED — the refusal costs a caption, never a payment.
    expect(Number(row.overtimeAmount)).toBe(31.25);
    expect(row.otDerivation, 'a decomposition that does not add up is not written').toBeNull();

    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect((ps.statutory as Record<string, unknown>).otDetail).toBeUndefined();
    expect(Number(ps.overtimePay)).toBe(31.25);
  });

  it('10b. whatever reaches a payslip, its legs sum to the overtime that payslip pays', async () => {
    // THE SAME DEFECT, PINNED AT THE POINT OF HARM RATHER THAN THE POINT OF PREVENTION.
    //
    // The two gates are independent, not redundant, and this fixture is where that matters: the stamp
    // records `round2(result.total)`, which for 100 minutes IS the figure the payslip pays. So if the
    // write gate were removed, the COPY gate would wave the decomposition through — 31.25 === 31.25 —
    // and the employee would receive a payslip whose one overtime leg reads 31.31 beside a payment of
    // 31.25. Guard 10 stops it being written; this states the property that must hold of the document
    // however it got there, and it is deliberately written as an invariant over whatever is present
    // rather than as an expectation of absence.
    const { a, employmentId, batchId } = await hireWithBatch(2600, 'otsum@acme.test');
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 100,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    await generatePayslips(await entitledCtx(base), { batchId });

    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const detail = (ps.statutory as { otDetail?: { lines: { amount: number }[] } }).otDetail;
    if (detail) {
      const sum = Math.round(detail.lines.reduce((t, l) => t + l.amount, 0) * 100) / 100;
      expect(sum, 'a decomposition on a payslip explains the figure that payslip pays').toBe(
        Number(ps.overtimePay),
      );
    }
    // …and on THIS payslip the honest answer is that there is nothing to show, because the rounded
    // quantity cannot reproduce the payment. Asserted separately so the branch above cannot pass by
    // being skipped for the wrong reason.
    expect(detail).toBeUndefined();
  });

  it('11. an OT figure that MOVED after the stamp reaches no payslip — the gate alone, with nothing cleared', async () => {
    // THE COPY GATE (generatePayslips: `round2(detail.total) === round2(slipOvertime)`), ISOLATED.
    //
    // Guard 8 changes the figure through `setPayrollInput`, which also NULLS the derivation — so it passes
    // whether or not the equality is there, and it pins the CLEAR, not the GATE. Here the amount is moved
    // by a direct write that leaves the stamp in place, which is the state any future writer of
    // `overtime_amount` can produce (core/claims.ts and core/loans.ts both write this row today without
    // going near the OT columns). The equality is then the only thing standing between the employee and a
    // caption explaining a figure that was never paid.
    const { a, employmentId, batchId } = await hireWithBatch(2600);
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    const stamped = await rowOf(batchId);
    expect(stamped.otDerivation, 'precondition: a derivation exists to be disqualified').toBeTruthy();
    expect(Number(stamped.overtimeAmount)).toBe(37.5);

    await owner.db
      .update(schema.payrollInput)
      .set({ overtimeAmount: '90.00' })
      .where(eq(schema.payrollInput.id, stamped.id));
    // The stamp SURVIVES the write — that is the point of the fixture, not an oversight.
    expect((await rowOf(batchId)).otDerivation, 'the stamp is still on the row').toBeTruthy();

    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.overtimePay)).toBe(90);
    expect(
      (ps.statutory as Record<string, unknown>).otDetail,
      'a derivation for 37.50 may not caption a payment of 90.00',
    ).toBeUndefined();
  });

  it('12. an OT CAP that clipped the figure disqualifies the derivation, end to end', async () => {
    // THE COPY GATE, through a real kernel path rather than a hand-made mismatch. A payroll policy with
    // `overtime.maxAmount` clips the prefilled total inside generatePayslips (applyOvertimeCapsForEmp), so
    // the payslip pays 20.00 against a decomposition that explains 37.50. Nothing in the fixture touches
    // payroll_input — the run itself creates the divergence, which is how it happens in production.
    //
    // THE CONVERTED-EXCESS CASE IS THIS SAME CASE. `otConvertAmount` is `otCap.excess`, so an OT excess
    // rerouted to a pay item can only exist once the cap has already bitten and already broken the
    // equality. A separate fixture for it would assert the same disqualifier twice.
    const { a, employmentId, batchId } = await hireWithBatch(2600, 'otcap@acme.test');
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect(Number((await rowOf(batchId)).overtimeAmount)).toBe(37.5);

    const { id: policyId } = await createPolicy(a, {
      companyId: base.companyId,
      name: 'OT capped at 20',
      policyType: 'monthly',
      config: { overtime: { maxAmount: 20 } },
    });
    await assignPolicy(a, { employmentId, policyId });

    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.overtimePay), 'precondition: the cap really clipped').toBe(20);
    expect(
      (ps.statutory as Record<string, unknown>).otDetail,
      'hours that produced 37.50 may not caption a capped payment of 20.00',
    ).toBeUndefined();
  });

  it('13. a slip that pays NO overtime carries no derivation, whatever the input row holds', async () => {
    // THE `slipOvertime > 0` CLAUSE, which is the one an ADDITIONAL run is refused by: such a run forces
    // slipOvertime to 0, so it can never reach the equality at all. Rather than build a multi-cycle
    // fixture to assert a clause that `0 > 0` already settles, the clause is pinned directly — a stamped
    // input row whose OT figure is zero. Hours beside no money is worse than silence.
    const { a, employmentId, batchId } = await hireWithBatch(2600, 'otzero@acme.test');
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-05-05',
      dayType: 'workday',
      otMinutes: 120,
    });
    await prefillOvertimeFromAttendance(a, { batchId });
    const stamped = await rowOf(batchId);
    await owner.db
      .update(schema.payrollInput)
      .set({ overtimeAmount: '0.00' })
      .where(eq(schema.payrollInput.id, stamped.id));
    expect((await rowOf(batchId)).otDerivation, 'the stamp is still on the row').toBeTruthy();

    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.overtimePay)).toBe(0);
    expect((ps.statutory as Record<string, unknown>).otDetail).toBeUndefined();
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
