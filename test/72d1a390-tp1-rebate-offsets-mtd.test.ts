/**
 * 72d1a390 (r352) — ZAKAT PAID OTHERWISE THAN THROUGH SALARY, AND THE RELIGIOUS-TRAVEL DEPARTURE LEVY,
 * NOW REDUCE THE MONTH'S TAX. THEY WERE CAPTURED AND OFFSET AGAINST NOTHING.
 *
 * ═══ THE SPECIFICATION, NOW HELD LOCALLY ═══
 *
 * docs/forms/pcb-spec-2026-computerised-calculation.pdf, with the decisive rules transcribed verbatim
 * into docs/forms/pcb-spec-2026-extracts.txt. Three of them govern this file:
 *
 *   rule 5  (printed p.19) "Zakat and departure levy shall be treated as follows", and its table's
 *           column (b) is "Zakat and departure levy for current month (RM)". Net MTD = (a − b), floored
 *           at zero. So BOTH belong in the offset `zakatOffsetWorking` already performs for salary zakat.
 *   rule 5  column (d), headed "carried forward to the following month (value of Z)", is NOT an
 *           unused-balance carry-forward — it equals column (b) in every printed row (MTD 15.00 /
 *           zakat 8.00 / net 7.00 / (d) 8.00). It is the Z accumulator taking the FULL amount.
 *           ⚠️ 72d1a390's own text claimed an unused part carries forward. It does not. Nothing here
 *           builds a residual ledger, and the last case pins that the residual is DROPPED.
 *   rule 15 (printed p.35) splits the two zakats: the payroll-deducted one "should appear in the payslip
 *           and EA Form"; the TP1-claimed one "should not appear in the payslip and EA Form due to
 *           employee himself paid directly to Pusat Zakat" and "is treated as zakat for current month in
 *           the month claimed by the employee".
 *
 * That last rule is why the rebate is a SECOND term rather than part of `effectiveZakat`: the payslip's
 * zakat line and the EA report an employer deduction, and this is not one. The two must move the same
 * tax and appear differently, which is precisely the kind of pair CLAUDE.md §8 says to pin across both
 * files rather than on one side.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { approveTp1ForPerson, submitTp1ForPerson, tp1RebateInForce, TP1_ITEMS, TP1_REBATES } from '../core/tax-relief';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const YEAR = 2026;
/** High enough that PCB is a real four-figure-ish number, so a RM300 rebate cannot be lost in rounding. */
const BASIC = 12000;

/** The shape the real form produces — an item's amount is recomputed from its sub-lines, never sent. */
function payload(
  items: Record<string, number | Record<string, number>> = {},
  rebates: Record<string, Record<string, number>> = {},
) {
  const defs = Object.fromEntries([...TP1_ITEMS, ...TP1_REBATES].map((d) => [d.code, d]));
  const shape = (src: Record<string, number | Record<string, number>>) =>
    Object.fromEntries(
      Object.entries(src).map(([code, v]) => {
        const def = defs[code];
        if (typeof v !== 'number') return [code, { subItems: v }];
        if (!def || def.subItems.length === 0) return [code, { amount: v }];
        return [code, { subItems: { [def.subItems[0].code]: v } }];
      }),
    );
  return { form: 'tp1-2026', items: shape(items), rebates: shape(rebates) } as const;
}

type SlipSt = {
  pcb: number;
  zakat?: number;
  zakatRebateTp1?: number;
  pcbMeta?: { trace?: { Z?: number; zakatCurrent?: number; zakatLeftover?: number } };
};

describe('72d1a390 · the TP1 zakat and departure levy reduce the month’s MTD', () => {
  let base: Base;
  let a: SessionContext;
  let ic = 950101010000;

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
      person: { fullName: name, primaryEmail: `zk_${randomUUID().slice(0, 8)}@t.local` },
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

  /** Declare a Section D rebate on behalf and approve it, through the real services. */
  async function declareRebate(personId: string, month: number, rebates: Record<string, Record<string, number>>) {
    const { id } = await submitTp1ForPerson(a, {
      personId,
      assessmentYear: YEAR,
      deductionMonth: month,
      declarationAccepted: true,
      categories: payload({}, rebates),
    });
    await approveTp1ForPerson(a, { personId, id, approvedMonth: month, approvedYear: YEAR });
    return id;
  }

  async function slipSt(batchId: string, employmentId: string): Promise<SlipSt> {
    const [row] = await owner.db
      .select({ statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    if (!row) throw new Error('no payslip');
    return row.statutory as unknown as SlipSt;
  }

  async function runRegular(period: string) {
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId });
    return batchId;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 1 · THE READ — which rows count, and for which month
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  describe('tp1RebateInForce — the running total of what is in force by a month', () => {
    const row = (
      id: string,
      deductionMonth: number | null,
      rebates: Record<string, Record<string, number>>,
      approvedMonth: number | null = deductionMonth,
      createdAt = new Date('2026-01-01T00:00:00Z'),
    ) => ({ id, deductionMonth, approvedMonth, createdAt, tp1Amount: '0', categories: payload({}, rebates) }) as never;

    it('sums D1(a) zakat and D1(b) departure levy — rule 5 puts both in one column', () => {
      const rows = [row('r1', 3, { d1: { a: 200, b: 100 } })];
      expect(tp1RebateInForce(rows, 3)).toBe(300);
    });

    it('ACCUMULATES across months, because the caller nets off what it has already offset', () => {
      const rows = [row('r1', 3, { d1: { a: 200, b: 0 } }), row('r2', 4, { d1: { a: 500, b: 0 } })];
      expect(tp1RebateInForce(rows, 3), 'only March is in force yet').toBe(200);
      expect(tp1RebateInForce(rows, 4), 'March and April together').toBe(700);
      expect(tp1RebateInForce(rows, 2), 'nothing in force in February').toBe(0);
    });

    it('takes the newest row for a month, not the sum of its corrections', () => {
      const rows = [
        row('r1', 3, { d1: { a: 200, b: 0 } }, 3, new Date('2026-03-01T00:00:00Z')),
        row('r2', 3, { d1: { a: 350, b: 0 } }, 3, new Date('2026-03-09T00:00:00Z')),
      ];
      expect(tp1RebateInForce(rows, 3), 'a correction replaces, it does not add').toBe(350);
    });

    it('withholds a claim until the month it takes effect, then never loses it', () => {
      // THE CASE A PER-MONTH READ DROPPED ENTIRELY: claimed for March, approved only from August.
      const rows = [row('r1', 3, { d1: { a: 200, b: 0 } }, 8)];
      expect(tp1RebateInForce(rows, 3), 'approved from August cannot reduce March').toBe(0);
      expect(tp1RebateInForce(rows, 7), 'nor July').toBe(0);
      expect(tp1RebateInForce(rows, 8), 'and August must pick it up — otherwise it is lost').toBe(200);
    });

    it('narrows to what was in force BEFORE collapsing, so a late correction does not erase the original', () => {
      // tp1CountForYear's ordering, and the money it protects: an August correction must not reach back
      // and delete the March figure from the months between.
      const rows = [
        row('r1', 3, { d1: { a: 200, b: 0 } }, 3, new Date('2026-03-01T00:00:00Z')),
        row('r2', 3, { d1: { a: 350, b: 0 } }, 8, new Date('2026-08-01T00:00:00Z')),
      ];
      expect(tp1RebateInForce(rows, 5), 'May still sees the original 200, not 0').toBe(200);
      expect(tp1RebateInForce(rows, 8), 'August sees the correction').toBe(350);
    });

    it('is never negative and survives a legacy row carrying no categories', () => {
      const legacy = { id: 'r0', deductionMonth: 3, approvedMonth: 3, createdAt: new Date(), tp1Amount: '900', categories: null } as never;
      expect(tp1RebateInForce([legacy], 3)).toBe(0);
      expect(tp1RebateInForce([], 3)).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · THE MONEY — the reported defect
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it('reduces the month’s MTD by the zakat and the levy together, against an identical colleague', async () => {
    const claimant = await employee('Rebate Claimant');
    const control = await employee('No Rebate Control');
    await declareRebate(claimant.personId, 1, { d1: { a: 200, b: 100 } });

    const batch = await runRegular(`${YEAR}-01`);
    const withRebate = await slipSt(batch, claimant.employmentId);
    const without = await slipSt(batch, control.employmentId);

    // The control proves the pair is non-vacuous: two identical salaries, one claim, one difference.
    expect(without.pcb, 'the control must actually owe tax, or this case proves nothing').toBeGreaterThan(300);
    expect(round2(without.pcb - withRebate.pcb), 'rule 5: net MTD = MTD − (zakat + levy)').toBe(300);
  });

  it('does NOT put the claim on the payslip’s zakat line — rule 15 keeps it off the payslip and the EA', async () => {
    const e = await employee('Off The Payslip');
    await declareRebate(e.personId, 1, { d1: { a: 200, b: 100 } });

    const st = await slipSt(await runRegular(`${YEAR}-01`), e.employmentId);
    expect(st.zakat ?? 0, 'the employee paid Pusat Zakat directly; this is not an employer deduction').toBe(0);
    expect(st.zakatRebateTp1, 'it is stamped beside zakat so the Z replay can find it').toBe(300);
    expect(st.pcbMeta?.trace?.zakatCurrent, 'and it IS the month’s offset').toBe(300);
  });

  it('accrues to Z for the following month, in full — spec rule 5 column (d)', async () => {
    const e = await employee('Accrues To Z');
    await declareRebate(e.personId, 1, { d1: { a: 200, b: 100 } });

    await runRegular(`${YEAR}-01`);
    const feb = await slipSt(await runRegular(`${YEAR}-02`), e.employmentId);
    expect(feb.pcbMeta?.trace?.Z, 'column (d) carries the FULL amount forward as Z').toBe(300);
  });

  it('a claim larger than the month’s tax zeroes it and the remainder is DROPPED, not carried', async () => {
    const e = await employee('Over The Tax');
    // Deliberately far above one month's MTD at this salary.
    await declareRebate(e.personId, 1, { d1: { a: 99000, b: 0 } });

    const jan = await slipSt(await runRegular(`${YEAR}-01`), e.employmentId);
    expect(jan.pcb, 'net MTD floors at zero (rule 5 rows a and b)').toBe(0);

    // Z takes the full 99,000 — and there is NO residual ledger anywhere. If a later round invents one,
    // this case is where it will show up.
    const feb = await slipSt(await runRegular(`${YEAR}-02`), e.employmentId);
    expect(feb.pcbMeta?.trace?.Z).toBe(99000);
    expect(feb.pcbMeta?.trace?.zakatCurrent ?? 0, 'February claimed nothing, so February offsets nothing').toBe(0);
  });

  it('leaves an employee with no Section D claim untouched', async () => {
    const e = await employee('No Claim At All');
    const st = await slipSt(await runRegular(`${YEAR}-01`), e.employmentId);
    expect(st.zakatRebateTp1, 'absent, not zero — no existing payload shape changes').toBeUndefined();
    expect(st.pcb).toBeGreaterThan(0);
  });
});

const round2 = (n: number) => Math.round(n * 100) / 100;
