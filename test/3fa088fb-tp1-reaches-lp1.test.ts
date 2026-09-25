/**
 * 3fa088fb — AN APPROVED TP1 RELIEF REACHES LP₁ WITHOUT ANYBODY PRESSING A BUTTON.
 *
 * ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════════
 *
 * The PCB/MTD formula consumes `∑LP + LP₁` — accumulated allowable deductions plus this month's — and
 * both are SUBTRACTED inside P. `core/payroll.ts` built LP₁ out of `payroll_input.tp1_deduction`, and
 * that column had exactly one writer: `prefillTp1FromSelfRelief`, reachable only through a Prefill
 * button on the draft batch screen. Nothing called it at batch creation and nothing called it at generate
 * time. So an employee's approved relief reached their tax only if an operator remembered to press a
 * button first — and measured on the reporter's production system on 2026-09-25, nobody ever had:
 *
 *     tp1_relief     8 rows APPROVED for assessment year 2026, two for July at RM500.00
 *     payroll_input  4 rows, ZERO with tp1_deduction > 0
 *     payslip        88 issued, NOT ONE carrying a TP1 deduction
 *
 * P too high ⇒ tax too high ⇒ every employee who declared a relief was over-deducted, every month, with
 * no error on any screen. The contrast was sitting three lines from the bug: the kernel already
 * auto-applies the fixed zakat election at generate time and lets `payroll_input` merely OVERRIDE it.
 *
 * ══ HOW THE FIGURES ARE PINNED — NOT ONE HAND-TYPED RINGGIT OF LHDN ARITHMETIC (CLAUDE.md §8) ═══════
 *
 *   1. **P moves by exactly the relief.** The payslip's own PCB trace carries P1. Two employees identical
 *      in every respect except the declaration must differ in P1 by the declared amount and by nothing
 *      else. That is the DEFINITION of the variable, checked against the run's own recorded working.
 *   2. **The direction is measured, not asserted.** The same employee with no declaration is the control,
 *      and the deduction must come out strictly LOWER with one.
 *   3. **Money is conserved across the year and across the runs.** ∑ of every `st.lp` this employer ever
 *      stamps equals the declared annual — once, never twice — which is the property a double-count
 *      breaks and a single-month assertion cannot see.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════════════════════════════
 *
 * Nothing backfills the 88 issued payslips. `core/payslip-recompute.ts` exists and revising month N
 * legitimately moves N+1, but re-cutting an issued payslip changes money already paid and already
 * reported to LHDN. That is the reporter's decision, was excluded from the approved plan, and is not a
 * build step — so the arms below all run forward from a fresh batch.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { saveTp3 } from '../core/tp3';
import {
  createAdditionalRun,
  createBatch,
  generatePayslips,
  prefillTp1FromSelfRelief,
  setPayrollInput,
} from '../core/payroll';
import { approveTp1ForPerson, submitTp1 } from '../core/tax-relief';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

const ROOT = join(__dirname, '..');
const YEAR = 2026;
const BASIC = 8000;

describe('3fa088fb — approved TP1 reaches LP₁ automatically', () => {
  let base: Base;
  let a: SessionContext;
  let ic = 940101010000;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // `createAdditionalRun` is gated on this module; the regular-run arms do not care either way.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = adminCtx(base);
  });

  /** A payable employee: compensation + a MY statutory profile, so PCB is a real non-zero figure. */
  async function employee(name: string, basic = BASIC) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `lp1_${randomUUID().slice(0, 8)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: `${YEAR}-01-01`,
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: basic,
      monthlyAllowance: 0,
      effectiveFrom: `${YEAR}-01-01`,
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: String(++ic), taxCategory: 1 });
    return e;
  }

  /** An employee session, exactly as `test/tp1-self-relief.test.ts` builds one (r294: snapshot, not exempt). */
  async function employeeCtx(personId: string): Promise<SessionContext> {
    const uid = await createAppUser(base.tenantId, personId, 'employee');
    return {
      tenantId: base.tenantId,
      userId: uid,
      personId,
      roles: ['employee'],
      entitlements: harnessSnapshot(base.tenantId),
    };
  }

  /**
   * The employee declares and the employer approves — THROUGH THE REAL SERVICES, never a raw UPDATE.
   * Section F's approved-for month is the declaration's EFFECTIVE-FROM month (`tp1EffectiveFromMonth`),
   * so it is a parameter here: an arm that pins "a relief approved from August does not reduce July"
   * needs to set it, and one that does not care passes 1.
   */
  async function declareAndApprove(
    personId: string,
    p: { amount: number; approvedMonth: number; deductionMonth?: number },
  ) {
    const ctx = await employeeCtx(personId);
    const { id } = await submitTp1(ctx, {
      assessmentYear: YEAR,
      tp1Amount: p.amount,
      ...(p.deductionMonth == null ? {} : { deductionMonth: p.deductionMonth }),
    });
    await approveTp1ForPerson(a, {
      personId,
      id,
      approvedMonth: p.approvedMonth,
      approvedYear: YEAR,
    });
    return id;
  }

  type LpDetail = {
    tp1: number;
    tp1Source: 'tp1_self' | 'manual';
    tp1Annual?: number;
    tp1AlreadyFed?: number;
    declaredComponents?: number;
  };
  type SlipSt = {
    pcb: number;
    lp?: number;
    lpDetail?: LpDetail;
    pcbMeta?: { P1: number; trace?: { lpAccumulated: number; lpCurrent: number } };
  };

  /** Read one employment's stamped statutory block for a batch, via the owner (RLS bypass). */
  async function slipSt(batchId: string, employmentId: string): Promise<SlipSt> {
    const [row] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    if (!row) throw new Error('no payslip');
    return row.statutory as unknown as SlipSt;
  }

  /** Every `st.lp` this employer has ever stamped for one employment — the year's whole LP₁ story. */
  async function lpEverStamped(employmentId: string): Promise<number> {
    const rows = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    return rows.reduce((sum, r) => sum + Number((r.statutory as { lp?: number }).lp ?? 0), 0);
  }

  /** A plain regular run. NO PREFILL ANYWHERE IN THIS FILE except the one arm that names it. */
  async function runRegular(period: string) {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId });
    return batchId;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 1 · THE DEFECT ITSELF — the relief reaches LP₁ with no button pressed
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('feeds an approved TP1 into LP₁ with no prefill pressed, lowering P by exactly the relief', async () => {
    const subject = await employee('LP1 Subject');
    const control = await employee('LP1 Control');
    await declareAndApprove(subject.personId, { amount: 3000, approvedMonth: 1 });

    // July, the reporter's own example month. NOTHING calls prefillTp1FromSelfRelief.
    const batchId = await runRegular(`${YEAR}-07`);
    const sub = await slipSt(batchId, subject.employmentId);
    const ctl = await slipSt(batchId, control.employmentId);

    // ── The figure lands where the formula reads it.
    expect(sub.lp, 'the approved relief is this month’s LP₁').toBe(3000);
    expect(sub.pcbMeta!.trace!.lpCurrent, 'LP1 on the PCB worksheet').toBe(3000);
    expect(sub.pcbMeta!.trace!.lpAccumulated, 'nothing accumulated yet — July is this employer’s first run').toBe(0);

    // ── The control is the proof that the arm above is not passing for an unrelated reason.
    expect(ctl.lp, 'no declaration ⇒ LP₁ is RM0.00').toBe(0);
    expect(ctl.pcbMeta!.trace!.lpCurrent).toBe(0);
    expect(ctl.lpDetail, 'nothing to explain ⇒ no provenance key, byte-identical to a pre-3fa088fb slip').toBeUndefined();

    // ── P MOVES BY EXACTLY THE RELIEF, against the run's own recorded working rather than a typed figure.
    expect(sub.pcbMeta!.P1).toBe(Math.round((ctl.pcbMeta!.P1 - 3000) * 100) / 100);
    // ── …and the deduction comes out strictly LOWER. Direction measured, not asserted.
    expect(sub.pcb).toBeLessThan(ctl.pcb);
  });

  it('shows where the figure came from: the employee’s own approved TP1, and the delta’s two inputs', async () => {
    const e = await employee('LP1 Provenance');
    await declareAndApprove(e.personId, { amount: 2500, approvedMonth: 1 });
    const batchId = await runRegular(`${YEAR}-07`);
    const st = await slipSt(batchId, e.employmentId);
    expect(st.lpDetail).toEqual({ tp1: 2500, tp1Source: 'tp1_self', tp1Annual: 2500, tp1AlreadyFed: 0 });
  });

  it('ignores a declaration that has not been approved — consent is what instructs payroll', async () => {
    const e = await employee('LP1 Unapproved');
    const ctx = await employeeCtx(e.personId);
    await submitTp1(ctx, { assessmentYear: YEAR, tp1Amount: 3000 }); // submitted, never approved
    const st = await slipSt(await runRegular(`${YEAR}-07`), e.employmentId);
    expect(st.lp).toBe(0);
    expect(st.lpDetail).toBeUndefined();
  });

  it('does not reach a month the declaration is not yet effective for', async () => {
    const e = await employee('LP1 August');
    // Section F: approved for the deduction of AUGUST. It must not reduce July's tax.
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 8 });
    expect((await slipSt(await runRegular(`${YEAR}-07`), e.employmentId)).lp).toBe(0);
    expect((await slipSt(await runRegular(`${YEAR}-08`), e.employmentId)).lp).toBe(3000);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · PRECEDENCE — a keyed figure still wins, and pressing Prefill changes nothing
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('lets a hand-keyed override win over the derived relief, and says so on the payslip', async () => {
    const e = await employee('LP1 Override');
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 1 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-07` });
    // `setPayrollInput` stamps tp1_source null ⇒ an operator's figure, not the prefill's.
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 0, tp1Deduction: 1234 });
    await generatePayslips(a, { batchId });
    const st = await slipSt(batchId, e.employmentId);
    expect(st.lp, 'the keyed figure, not the declared 3000').toBe(1234);
    expect(st.lpDetail!.tp1Source).toBe('manual');
    // No annual/already-fed on an override: it was struck from neither, and printing them would mislead.
    expect(st.lpDetail).toEqual({ tp1: 1234, tp1Source: 'manual' });
  });

  it('produces the identical figure whether or not Prefill was pressed', async () => {
    const e = await employee('LP1 Prefilled');
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 1 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-07` });
    const r = await prefillTp1FromSelfRelief(a, { batchId });
    expect(r.applied).toBe(1);
    const [input] = await owner.db
      .select({ amount: schema.payrollInput.tp1Deduction, source: schema.payrollInput.tp1Source })
      .from(schema.payrollInput)
      .where(
        and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, e.employmentId)),
      );
    await generatePayslips(a, { batchId });
    const st = await slipSt(batchId, e.employmentId);
    // The button and the kernel read the SAME `resolveTp1Feed`, so the draft figure and the payslip agree
    // — which is the property that makes leaving the button in place safe.
    expect(Number(input.amount)).toBe(st.lp);
    expect(input.source).toBe('tp1_self');
    expect(st.lpDetail!.tp1Source, 'a prefilled row is a copy of the derivation, not an override').toBe('tp1_self');
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 3 · ROUTING (§0.5) — person-keyed relief, per-employment LP₁, claimed ONCE
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** A second concurrent employment for the same person, in the same company ⇒ both land in one batch. */
  async function secondEmployment(personId: string) {
    const [row] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, personId, companyId: base.companyId, hiredOn: `${YEAR}-01-01` })
      .returning({ id: schema.employment.id });
    await setCompensation(a, { employmentId: row.id, basicSalary: BASIC, effectiveFrom: `${YEAR}-01-01` });
    return row.id;
  }

  it('relieves the designated paymaster only — one person, two jobs, one relief', async () => {
    const e = await employee('LP1 Paymaster');
    const other = await secondEmployment(e.personId);
    await owner.db
      .update(schema.person)
      .set({ designatedPaymasterEmploymentId: e.employmentId })
      .where(eq(schema.person.id, e.personId));
    await declareAndApprove(e.personId, { amount: 2400, approvedMonth: 1 });

    const batchId = await runRegular(`${YEAR}-07`);
    expect((await slipSt(batchId, e.employmentId)).lp, 'the nominated paying job carries it').toBe(2400);
    expect((await slipSt(batchId, other)).lp, 'the other job carries none').toBe(0);
    // The conservation arm: the month relieved 2400 in total, not 4800.
    const total =
      Number((await slipSt(batchId, e.employmentId)).lp) + Number((await slipSt(batchId, other)).lp);
    expect(total).toBe(2400);
  });

  it('relieves NOBODY when two jobs share a batch and no paymaster is nominated', async () => {
    const e = await employee('LP1 Ambiguous');
    const other = await secondEmployment(e.personId);
    await declareAndApprove(e.personId, { amount: 2400, approvedMonth: 1 });
    const batchId = await runRegular(`${YEAR}-07`);
    // Nothing here can know which job should relieve, and guessing either spreads the money or doubles
    // it. Relieving nothing is recoverable by nominating a paymaster; relieving twice is not.
    expect((await slipSt(batchId, e.employmentId)).lp).toBe(0);
    expect((await slipSt(batchId, other)).lp).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 4 · ONE MONTH, TWO RUNS — the likeliest place to double-count, in both orders
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('applies the relief ONCE across a regular + bonus pair in the same month', async () => {
    const e = await employee('LP1 Pair');
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 7 });

    const regular = await runRegular(`${YEAR}-07`);
    const bonus = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: `${YEAR}-07`,
      runType: 'bonus',
    });
    await setPayrollInput(a, { batchId: bonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 2000 });
    await generatePayslips(a, { batchId: bonus.batchId });

    expect((await slipSt(regular, e.employmentId)).lp, 'the regular run charges the month’s relief').toBe(3000);
    expect((await slipSt(bonus.batchId, e.employmentId)).lp, 'the bonus run re-charges nothing').toBe(0);
    expect(await lpEverStamped(e.employmentId), 'the month relieved 3000 in total, not 6000').toBe(3000);
  });

  it('applies it ONCE when the bonus run lands FIRST and the regular run restates the month', async () => {
    const e = await employee('LP1 Late Regular');
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 7 });

    // Bonus at run_seq 1, regular at run_seq 2 — ADR-0085 step 5's restating regular run.
    const bonus = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: `${YEAR}-07`,
      runType: 'bonus',
    });
    await setPayrollInput(a, { batchId: bonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 2000 });
    await generatePayslips(a, { batchId: bonus.batchId });
    const regular = await runRegular(`${YEAR}-07`);

    expect((await slipSt(bonus.batchId, e.employmentId)).lp).toBe(0);
    expect((await slipSt(regular, e.employmentId)).lp, 'a late regular run still carries it').toBe(3000);
    expect(await lpEverStamped(e.employmentId)).toBe(3000);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 5 · THE DELTA (§0.1/0.2) — ∑LP + LP₁ converges on the declared annual, claimed exactly once
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('claims the declared annual exactly once across the year, not once a month', async () => {
    const e = await employee('LP1 Annual');
    await declareAndApprove(e.personId, { amount: 1800, approvedMonth: 1 });

    const jan = await runRegular(`${YEAR}-01`);
    const feb = await runRegular(`${YEAR}-02`);
    const mar = await runRegular(`${YEAR}-03`);

    expect((await slipSt(jan, e.employmentId)).lp, 'the whole annual is available in January').toBe(1800);
    expect((await slipSt(feb, e.employmentId)).lp, 'already fed ⇒ nothing further').toBe(0);
    expect((await slipSt(mar, e.employmentId)).lp).toBe(0);
    // ∑LP + LP₁ over the year IS the declared annual — the property a per-month feed would break by 3×.
    expect(await lpEverStamped(e.employmentId)).toBe(1800);
    expect((await slipSt(mar, e.employmentId)).pcbMeta!.trace!.lpAccumulated).toBe(1800);
  });

  it('feeds the REMAINDER when earlier months already carried part of it', async () => {
    const e = await employee('LP1 MidYear');
    // January + February carry an operator-keyed RM500 each ⇒ ∑LP = 1000 before the declaration exists.
    for (const m of ['01', '02']) {
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: `${YEAR}-${m}` });
      await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 0, tp1Deduction: 500 });
      await generatePayslips(a, { batchId });
    }
    await declareAndApprove(e.personId, { amount: 1800, approvedMonth: 1 });
    const mar = await runRegular(`${YEAR}-03`);
    expect((await slipSt(mar, e.employmentId)).lp, '1800 declared − 1000 already fed').toBe(800);
    expect((await slipSt(mar, e.employmentId)).lpDetail).toEqual({
      tp1: 800,
      tp1Source: 'tp1_self',
      tp1Annual: 1800,
      tp1AlreadyFed: 1000,
    });
    expect(await lpEverStamped(e.employmentId), '500 + 500 + 800').toBe(1800);
  });

  it('never feeds a NEGATIVE LP₁ when a correction reduces the annual below what was already fed', async () => {
    const e = await employee('LP1 Reduced');
    await declareAndApprove(e.personId, { amount: 3000, approvedMonth: 1 });
    expect((await slipSt(await runRegular(`${YEAR}-01`), e.employmentId)).lp).toBe(3000);
    // A correction to the same (month-less) bucket: newest wins ⇒ the annual is now 1000, below the 3000
    // February's ∑LP already carries. A negative LP₁ would INCREASE P and over-deduct — the very
    // direction this item exists to stop — so the feed clamps at zero instead of clawing back.
    await declareAndApprove(e.personId, { amount: 1000, approvedMonth: 1 });
    const feb = await slipSt(await runRegular(`${YEAR}-02`), e.employmentId);
    expect(feb.lp).toBe(0);
    expect(feb.lpDetail).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 6 · THE TP3 BOUNDARY (item 20837372) — a previous employer's ∑LP does NOT shrink our TP1
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('does not net a previous employer’s ∑LP off the relief declared to US', async () => {
    const e = await employee('LP1 With TP3');
    // Form TP3 Section D: RM5,500 of allowable deductions accumulated at the PREVIOUS employer.
    await saveTp3(a, {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: { c1: { amount: 40000 }, c3: { amount: 4400 } },
      sectionD: { c8: { amount: 3000 }, c12: { amount: 2500 } },
    });
    await declareAndApprove(e.personId, { amount: 1000, approvedMonth: 1 });

    const st = await slipSt(await runRegular(`${YEAR}-07`), e.employmentId);
    // ∑LP carries the previous employer's figure — the kernel's job (spec printed page 11).
    expect(st.pcbMeta!.trace!.lpAccumulated).toBe(5500);
    // LP₁ carries the WHOLE declaration made to us. `max(0, 1000 − 5500)` would be 0, and would silently
    // delete a relief this employee declared to this employer. `lpAlreadyFed` is the replay of OUR
    // payslips only, and this is the arm that says so.
    expect(st.lp).toBe(1000);
    expect(st.lpDetail).toEqual({ tp1: 1000, tp1Source: 'tp1_self', tp1Annual: 1000, tp1AlreadyFed: 0 });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 7 · ONE SPELLING (r209's standing rule) — the button and the kernel share the delta
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it('reaches the delta, the routing and the declarations through ONE function each', () => {
    const src = readFileSync(join(ROOT, 'core/payroll.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    // ONE declaration and exactly TWO call sites each — the prefill and the kernel. r201's defect was two
    // implementations of one question, and the standing rule since r209 is that there is never a second.
    for (const fn of ['resolveTp1Feed(', 'tp1TargetEmploymentByPerson(', 'tp1ApprovedRowsByPerson(']) {
      const hits = src.split(fn).length - 1;
      expect(hits, `${fn} must be declared once and called exactly twice`).toBe(3);
    }
    // The delta must still reach core/tax-relief for "which declarations count" rather than re-deciding it
    // — the property test/tp1-counted-contract.test.ts also guards from the other side.
    expect(src).toMatch(/const counted = tp1CountForYear\(p\.approvedRows, \{ throughMonth: p\.throughMonth \}\)/);
    // And the kernel must not have gone back to trusting the stored column on its own.
    expect(src).toMatch(/tp1FeedByEmp\.get\(e\.employmentId\)/);
  });
});
