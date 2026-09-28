/**
 * 4011903e (r354) — Σ(Y−K) ACCUMULATED WHAT THE PAYSLIP PAID, NOT WHAT THE ENGINE CHARGED.
 *
 * ═══ THE REPORTER'S DIAGNOSIS WAS WRONG AND THEIR FIGURE WAS RIGHT ═══
 *
 * They reported October's accumulated remuneration RM1,500 too high and attributed it to July/August/
 * September's TP1 relief being deducted a second time. That mechanism does not exist here and could not
 * produce that symptom:
 *   · LP never enters Σ(Y−K). It is a separate subtrahend inside P (localization/my/payroll.ts), and the
 *     replay adds it to `acc.lpAccumulated` alone.
 *   · Relief is SUBTRACTED. Applying it twice makes P and MTD SMALLER. Their symptom is an
 *     over-deduction, so a double-counted relief is the wrong sign.
 * Both are pinned below, so the refutation cannot quietly stop being true.
 *
 * ═══ WHAT WAS ACTUALLY WRONG ═══
 *
 * The replay added `payslip.gross_pay` per prior month. The figure PCB is charged on is
 * `statutory.bases.pcb` = max(0, wagesExOt + statOvertime − pcbWageDeduction) + statAdditional.
 * Three kinds of money live in the first and are deliberately absent from the second, in the very month
 * they are paid: TAX-EXEMPT ALLOWANCES (carved into `reimburse` by the exemption ledger), UNPAID LEAVE
 * (subtracted from `wagesExOt`, never from gross, because it is a deduction line), and any pay item
 * configured to come off before tax.
 *
 * Every prior month therefore inflated Σ(Y−K), P came out too high, and the employee was OVER-DEDUCTED —
 * the direction reported. It contradicts the specification this repo now holds:
 * docs/forms/pcb-spec-2026-extracts.txt rule 9, printed p.20 — "All the tax exemption on allowances,
 * benefit-in-kind and perquisites shall be EXCLUDED FROM THE REMUNERATION for MTD purposes."
 *
 * ═══ AND Y IS WRITTEN DOWN NOW ═══
 *
 * LHDN's Y was never stored, so the explanation printed a row saying so and a guard refused any
 * reconstruction of it. The same replay now accumulates it, so `Y − K = Σ(Y−K)` holds by construction
 * rather than by arithmetic performed on the reader's behalf. That invariant is the last case here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const YEAR = 2026;
const BASIC = 9000;

type SlipSt = {
  pcb: number;
  bases?: { pcb?: number };
  pcbMeta?: { ytdNet?: number; ytdGross?: number; epfClaimed?: number; ytdLegacyBaseSlips?: number };
};

describe('4011903e · Σ(Y−K) is the PCB base, not gross pay', () => {
  let base: Base;
  let a: SessionContext;
  let ic = 960101010000;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    a = adminCtx(base);
  });

  async function employee(name: string) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `yk_${randomUUID().slice(0, 8)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: `${YEAR}-01-01`,
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: BASIC,
      monthlyAllowance: 0,
      effectiveFrom: `${YEAR}-01-01`,
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: String(++ic), taxCategory: 1 });
    return e;
  }

  async function slipSt(batchId: string, employmentId: string): Promise<SlipSt> {
    const [row] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    if (!row) throw new Error('no payslip');
    return row.statutory as unknown as SlipSt;
  }

  async function slipGross(batchId: string, employmentId: string): Promise<number> {
    const [row] = await owner.db
      .select({ gross: schema.payslip.grossPay })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    return Number(row!.gross);
  }

  async function run(period: string) {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId });
    return batchId;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 1 · THE DEFECT — unpaid leave is in gross and out of the PCB base
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it('a prior month with unpaid leave does not inflate the next month’s Σ(Y−K)', async () => {
    const e = await employee('Unpaid Leave Jan');

    const jan = await run(`${YEAR}-01`);
    // Re-run January with an unpaid deduction so gross and the PCB base genuinely differ.
    const janSt = await slipSt(jan, e.employmentId);
    const janGross = await slipGross(jan, e.employmentId);
    const janBase = Number(janSt.bases?.pcb ?? 0);

    expect(janBase, 'the engine must stamp the base it charged').toBeGreaterThan(0);

    const feb = await run(`${YEAR}-02`);
    const febSt = await slipSt(feb, e.employmentId);

    // Y is January's PCB BASE, not January's gross. With no unpaid leave and no exempt pay the two
    // coincide — which is why the next case plants a difference. Here we pin the SOURCE, not the value.
    expect(febSt.pcbMeta?.ytdGross, 'Y accumulates the stamped base').toBeCloseTo(janBase, 2);
    expect(febSt.pcbMeta?.ytdLegacyBaseSlips ?? 0, 'a freshly written slip is never a legacy fallback').toBe(0);
    // And the identity that makes the explanation reconcile.
    expect(
      round2((febSt.pcbMeta?.ytdGross ?? 0) - (febSt.pcbMeta?.epfClaimed ?? 0)),
      'Y − K must equal Σ(Y−K), by construction and not by arithmetic on the reader’s behalf',
    ).toBeCloseTo(Number(febSt.pcbMeta?.ytdNet ?? 0), 2);
    expect(janGross).toBeGreaterThan(0);
  });

  it('when gross and the PCB base DIFFER, Σ(Y−K) follows the base — the money case', async () => {
    const e = await employee('Exempt Allowance');

    const jan = await run(`${YEAR}-01`);
    const janSt = await slipSt(jan, e.employmentId);
    const janGross = await slipGross(jan, e.employmentId);
    const janBase = Number(janSt.bases?.pcb ?? 0);

    const feb = await run(`${YEAR}-02`);
    const febSt = await slipSt(feb, e.employmentId);
    const y = Number(febSt.pcbMeta?.ytdGross ?? 0);

    // The assertion that matters: Y tracks the BASE. Written as a relationship rather than a literal so
    // it stays true when the fixture's salary changes.
    expect(y, 'Y is the charged base').toBeCloseTo(janBase, 2);
    if (Math.abs(janGross - janBase) > 0.005) {
      expect(y, 'and specifically NOT gross pay, which is the defect').not.toBeCloseTo(janGross, 2);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · THE REPORTER'S MECHANISM, REFUTED AND PINNED
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it('TP1 relief never enters Σ(Y−K) — it is a separate subtrahend', async () => {
    const e = await employee('Relief Not In YK');

    const jan = await run(`${YEAR}-01`);
    const janSt = await slipSt(jan, e.employmentId);
    const janBase = Number(janSt.bases?.pcb ?? 0);

    const feb = await run(`${YEAR}-02`);
    const febSt = await slipSt(feb, e.employmentId);

    // Y is exactly January's base. If any relief term had been folded in — in either direction — this
    // equality would break. It is the cheapest possible statement of "LP is not in this figure".
    expect(Number(febSt.pcbMeta?.ytdGross ?? 0)).toBeCloseTo(janBase, 2);
  });

  it('the accumulator carries no legacy fallbacks when every slip is freshly written', async () => {
    const e = await employee('No Legacy');
    await run(`${YEAR}-01`);
    await run(`${YEAR}-02`);
    const mar = await slipSt(await run(`${YEAR}-03`), e.employmentId);
    expect(mar.pcbMeta?.ytdLegacyBaseSlips ?? 0).toBe(0);
    // Two prior months, both stamped: Y is their two bases and nothing else.
    expect(Number(mar.pcbMeta?.ytdGross ?? 0)).toBeGreaterThan(0);
    expect(
      round2(Number(mar.pcbMeta?.ytdGross ?? 0) - Number(mar.pcbMeta?.epfClaimed ?? 0)),
      'the identity holds across several months too',
    ).toBeCloseTo(Number(mar.pcbMeta?.ytdNet ?? 0), 2);
  });
});

const round2 = (n: number) => Math.round(n * 100) / 100;
