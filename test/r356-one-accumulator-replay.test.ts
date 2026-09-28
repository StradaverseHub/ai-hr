/**
 * r356 — THE KERNEL AND THE WORKSHEET REPLAY THE YEAR THE SAME WAY, BECAUSE IT IS ONE FUNCTION.
 *
 * `core/payroll.ts` accumulates Y, Σ(Y−K), K, X, Z and ∑LP from the year's earlier payslips to feed the
 * month it is paying. `localization/my/multicycle-worksheet.ts` accumulates the same six to MODEL an
 * already-paid month and compare the model with what was paid. They were two implementations of one
 * arithmetic, and the copy fell behind twice inside two rounds:
 *
 *   · r352 (72d1a390) stamped `zakatRebateTp1` beside `zakat` and added it to Z. The copy kept summing
 *     `zakat` alone.
 *   · r354 (4011903e) moved Σ(Y−K) off `payslip.gross_pay` onto the stamped `bases.pcb`, because PCB is
 *     charged on that and the gap is real money — tax-exempt allowances, unpaid leave, any pay item
 *     deducted before tax. The copy kept folding `gross_pay`.
 *
 * And a third that predates both: the copy seeded ∑LP from a hard `0` where the kernel seeds it from
 * `tp3_lp` (item 20837372) — it never even SELECTED the column.
 *
 * WHY THAT IS WORSE THAN A COSMETIC DIVERGENCE. The worksheet's verdict is a comparison. A Σ(Y−K) that
 * is too high moves the modelled PCB, both readings then fail to match what was paid, and a correctly
 * computed month is printed `unexplained` — "paid matches neither reading" — on the document ADR-0024
 * asks an accountant to sign. The figures were right; the second opinion about them was wrong.
 *
 * The fix is one seed and one fold, owned by the pack beside `PcbAccumulators` and reached by the kernel
 * through the pack seam. These cases pin the behaviour AND the singleness: the last case fails if either
 * call site grows its own copy again.
 *
 * ⚠️ HOW TO CHECK THE TWO DATABASE CASES ARE NOT VACUOUS, because the obvious way is wrong. Reverting the
 * shared fold does NOT make them fail: the kernel writes May's payslips through the SAME function the
 * worksheet replays them with, so both sides move together and still agree. The defect was that they were
 * DIFFERENT. To see it, restore the worksheet's own copy (fold `Number(slip.gross)`, sum `zakat` alone,
 * seed `lpAccumulated: 0`) and leave the kernel on the pack's — both cases then fail with
 * "expected 'unexplained' not to be 'unexplained'", which is a correctly-computed month being reported as
 * inexplicable. Verified that way on 2026-09-29.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import {
  foldPriorSlipIntoAccumulators,
  openingAccumulatorsFromTp3,
  type PcbAccumulators,
} from '../localization/my/payroll';
import { multiCycleWorksheetMY } from '../localization/my/multicycle-worksheet';
import { myPack } from '../localization/my';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const EPF_CAP = 4000;

describe('r356 · the fold, as a function', () => {
  const zero = (): PcbAccumulators => openingAccumulatorsFromTp3(null, EPF_CAP);

  it('Σ(Y−K) follows the STAMPED PCB BASE, not what the payslip paid', () => {
    // The r354 money fix, now pinned where both callers get it. RM1,000 of the gross was tax-exempt, so
    // the base is RM1,000 lower — and the base is what PCB was charged on.
    const acc = zero();
    foldPriorSlipIntoAccumulators(acc, { gross: 6000, statutory: { epfEmployee: 550, bases: { pcb: 5000 } } }, EPF_CAP);
    expect(acc.grossRemuneration, 'Y is the base, not the gross').toBe(5000);
    expect(acc.netRemuneration, 'Σ(Y−K) is that base less the EPF claimed').toBe(4450);
    expect(acc.legacyBaseSlips, 'a stamped slip is not a fallback').toBe(0);
  });

  it('a slip with NO stamped base falls back to gross and is COUNTED', () => {
    // Slips predating the r187 stamp. The fallback is a DIFFERENT figure, not a rounding difference, so
    // it is disclosed rather than absorbed — the count is what the snapshot carries.
    const acc = zero();
    foldPriorSlipIntoAccumulators(acc, { gross: 6000, statutory: { epfEmployee: 550 } }, EPF_CAP);
    expect(acc.grossRemuneration).toBe(6000);
    expect(acc.legacyBaseSlips).toBe(1);
  });

  it('Z carries the TP1 zakat rebate as well as the salary-deducted zakat', () => {
    // Spec rule 5, printed p.19: the column is "Zakat AND DEPARTURE LEVY for current month", and the
    // full amount accrues to Z whether or not it was spent. The rebate is stamped separately only
    // because rule 15 keeps it off the payslip's zakat line.
    const acc = zero();
    foldPriorSlipIntoAccumulators(acc, { gross: 5000, statutory: { zakat: 100, zakatRebateTp1: 300, bases: { pcb: 5000 } } }, EPF_CAP);
    expect(acc.zakatPaid, '100 deducted + 300 claimed back through TP1').toBe(400);
  });

  it('K stops at the annual EPF relief cap, and Σ(Y−K) stops with it', () => {
    const acc = zero();
    for (let i = 0; i < 12; i++) {
      foldPriorSlipIntoAccumulators(acc, { gross: 10000, statutory: { epfEmployee: 1100, bases: { pcb: 10000 } } }, EPF_CAP);
    }
    expect(acc.epfClaimed).toBe(EPF_CAP);
    expect(acc.netRemuneration).toBe(120000 - EPF_CAP);
    expect(acc.grossRemuneration, 'Y − K = Σ(Y−K), by construction').toBe(acc.netRemuneration + acc.epfClaimed);
  });

  it('the TP3 seed opens ∑LP from the declaration, and caps the EPF before Y is reconstructed', () => {
    // ∑LP is the FOURTH variable a TP3 feeds (spec printed p.22) and is SUBTRACTED inside P, so a zero
    // over-deducts a new joiner. The EPF column holds what was CLAIMED; core/tp3.ts subtracted the
    // capped figure when it computed the net, so Y must be reconstructed from the capped one or the
    // identity Y − K = Σ(Y−K) breaks silently for anyone over the cap.
    const acc = openingAccumulatorsFromTp3(
      { netRemuneration: 50000, epfClaimed: 6000, pcbPaid: 900, zakatPaid: 120, lpAccumulated: 2500 },
      EPF_CAP,
    );
    expect(acc.lpAccumulated).toBe(2500);
    expect(acc.epfClaimed).toBe(EPF_CAP);
    expect(acc.grossRemuneration).toBe(54000);
    expect(acc.grossRemuneration - acc.epfClaimed).toBe(acc.netRemuneration);
  });
});

describe('r356 · the worksheet reads the year the way the kernel charged it', () => {
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

  /**
   * April, then May with two runs. April's slip is rewritten — by a function of what the kernel actually
   * stamped — BEFORE May is generated, so May's payslips are what the live kernel produces from that
   * April. The worksheet then has to arrive at the same April from the same rows.
   */
  async function aprilThenMay(patch: (st: Record<string, unknown>) => Record<string, unknown>) {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Replay Subject', primaryEmail: 'replay@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 6000,
      monthlyAllowance: 0,
      effectiveFrom: '2025-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234', subjectToSkbbk: true });

    const april = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: april.batchId });
    const [ap] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, april.batchId));
    const aprilStatutory = ap.statutory as Record<string, unknown>;
    await owner.db
      .update(schema.payslip)
      .set({ statutory: { ...aprilStatutory, ...patch(aprilStatutory) } })
      .where(eq(schema.payslip.id, ap.id));

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await setPayrollInput(a, {
      batchId: extra.batchId,
      employmentId: e.employmentId,
      overtimeAmount: 0,
      bonusAmount: 1001,
    });
    await generatePayslips(a, { batchId: extra.batchId });
    return { a, aprilStatutory };
  }

  it("a prior month whose PCB BASE is below its gross does not make May inexplicable", async () => {
    // April keeps its RM6,000 gross and is charged on RM1,000 less — the shape a tax-exempt allowance
    // leaves behind. The kernel charged May on that base; a replay that folds gross_pay instead carries
    // RM1,000 too much into May's Σ(Y−K), models a PCB nobody paid, and prints the month `unexplained`.
    const { a } = await aprilThenMay((st) => ({
      bases: { ...(st.bases as Record<string, unknown>), pcb: Number((st.bases as Record<string, unknown>).pcb) - 1000 },
    }));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    expect(w.employeeMonthsCompared, 'May has two runs and nothing excludes it').toBe(1);
    const [row] = w.rows;
    expect(row.period).toBe('2026-05');
    expect(row.verdict, 'the month is explained by one of the two readings').not.toBe('unexplained');
    expect(row.monthAsOne.pcb, 'and the month-as-one reading is the one that was paid').toBe(row.paid.pcb);
  });

  it('a prior month carrying a TP1 zakat rebate does not make May inexplicable either', async () => {
    // The rebate offsets the month's MTD exactly as salary-deducted zakat does, and the FULL amount
    // accrues to Z. A replay that sums `zakat` alone carries a short Z into May.
    const { a } = await aprilThenMay(() => ({ zakat: 0, zakatRebateTp1: 300 }));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    const [row] = w.rows;
    expect(row.verdict).not.toBe('unexplained');
    expect(row.monthAsOne.pcb).toBe(row.paid.pcb);
  });

  it('a month whose ONLY zakat is a TP1 rebate is refused, not compared', async () => {
    // The refusal list read `zakat !== 0 || lp !== 0`, so a rebate-only month walked straight past it —
    // reachable since r352 stamped the rebate separately. Here MAY carries the rebate, so May itself is
    // the month that cannot be reproduced from run inputs alone.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Rebate Subject', primaryEmail: 'rebate@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234', subjectToSkbbk: true });
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await setPayrollInput(a, { batchId: extra.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 1001 });
    await generatePayslips(a, { batchId: extra.batchId });
    const [rs] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, reg.batchId));
    await owner.db
      .update(schema.payslip)
      .set({ statutory: { ...(rs.statutory as Record<string, unknown>), zakat: 0, zakatRebateTp1: 250 } })
      .where(eq(schema.payslip.id, rs.id));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    expect(w.employeeMonthsCompared).toBe(0);
    expect(w.skips.map((s) => s.reason)).toContain('zakat_or_lp_present');
  });
});

describe('r356 · one replay, and only one', () => {
  it('neither call site re-implements the fold', () => {
    const kernel = read('../core/payroll.ts');
    const worksheet = read('../localization/my/multicycle-worksheet.ts');

    // Both reach the pack's fold…
    expect(kernel).toContain('pack.payroll.foldPriorSlipIntoAccumulators(');
    expect(kernel).toContain('pack.payroll.openingAccumulatorsFromTp3(');
    expect(worksheet).toContain('foldPriorSlipIntoAccumulators(acc,');
    expect(worksheet).toContain('openingAccumulatorsFromTp3(');

    // …and neither keeps a hand-rolled one. These are the exact spellings the two copies used, quoted
    // from the code they replaced, so a re-introduction fails here rather than in a customer's
    // worksheet two rounds later.
    for (const [name, src] of [
      ['core/payroll.ts', kernel],
      ['multicycle-worksheet.ts', worksheet],
    ] as const) {
      expect(src, `${name} must not accumulate Σ(Y−K) itself`).not.toMatch(/acc\.netRemuneration = round2\(/);
      expect(src, `${name} must not accumulate Z itself`).not.toMatch(/acc\.zakatPaid = round2\(/);
      expect(src, `${name} must not accumulate K itself`).not.toMatch(/acc\.epfClaimed = round2\(/);
    }
    // The worksheet's old seed, verbatim: a hard zero for ∑LP. It is item 20837372's defect and it must
    // not come back.
    expect(worksheet).not.toContain('lpAccumulated: 0,');
  });

  it('the fold and its seed are on the pack seam, so the kernel names no jurisdiction', () => {
    expect(typeof myPack.payroll.foldPriorSlipIntoAccumulators).toBe('function');
    expect(typeof myPack.payroll.openingAccumulatorsFromTp3).toBe('function');
    expect(read('../core/payroll.ts')).not.toContain("from '../localization/my/payroll'");
  });
});
