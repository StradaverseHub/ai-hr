/**
 * Feedback 6b134681 — A BONUS RUN MUST RECORD WHAT IT PAID, BY NAME.
 *
 * THE DEFECT, MEASURED ON PRODUCTION 2026-08-18. `statutory.componentLines` — the per-item stamp every
 * result screen reads — was written on the REGULAR run only:
 *
 *     REGULAR runs: 62 payslips, 24 carry a componentLines stamp.
 *     BONUS   runs: 19 payslips, ZERO carry one.
 *
 * So A0002's January bonus payslip held RM500.00 (the money was, and is, correct) with nothing on it
 * that said BOOO1 · ANGPOW — the reporter's pay code, spelled with the letter O three times, not zeros.
 * Every screen fell back to the only label it had, the name of the BOX, which reads "Bonus". That is
 * also why the read-side work shipped in r196 could not reach the reporter and why their three attempts
 * (reprocess, delete + re-key, re-enter through Individual Transaction) could never have worked: none of
 * them causes a bonus run to record anything.
 *
 * WHY THE STAMP IS A SUBSET AND NOT THE WHOLE LIST. `earningsOf` folds the SAME recurring components on
 * an additional run as on a regular one, so its `componentLines` describes a whole month of pay — while
 * the payslip itself pays only the bonus (`slipBasic`/`slipAllowance`/`slipOvertime` are forced to 0 and
 * `grossPay` is `round2(bonus)`). Stamping the full list would list a month's allowances a second time,
 * under figures of 0.00. The kernel therefore keeps the BONUS-BUCKET contributions and only those, which
 * is exactly the money the run pays:
 *
 *     Σ (stamped bucket amounts) = payslip.bonus = payslip.gross
 *
 * THAT IDENTITY IS THE POINT OF THIS FILE. r196 built `payItemLinesReconcile` so a money screen can never
 * print rows that fail to add up to the total above them; a bonus stamp that did not reconcile would
 * re-create the reporter's defect one screen further along, as a bare total with the rows suppressed.
 *
 * THE `amount` IS RE-SUMMED, NOT COPIED — the split case below is why. A stored line's `amount` is the
 * whole resolved figure BEFORE the bucket split, and Transaction View's grid renders `l.amount` rather
 * than the bucket sum. Copying it through would print RM1,500 for an item on a run that paid RM500 of it.
 *
 * NOT ONE FIGURE MOVES. The last test asserts the whole money surface of both runs beside the stamp, in
 * one case, because the defect lives in the CONTRACT between the kernel and the renderers rather than in
 * either alone.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { payItemLabel, payItemLinesForBuckets, payItemLinesReconcile } from '../core/payslip-earning-lines';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;

/** An EARNING pay item. Defaults mirror an ordinary taxable allowance. */
const earning = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name,
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: false,
  ...over,
});

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function hire(email: string, ic: string, basic: number) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
  return e;
}

async function slipOf(batchId: string, employmentId: string) {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
}

type StoredLine = { code: string; name: string; amount: number; buckets: { bucket: string; amount: number }[] };
type Stat = {
  epfEmployee: number; epfEmployer: number;
  socsoEmployee: number; socsoEmployer: number; socsoSkbbk: number;
  eisEmployee: number; eisEmployer: number;
  pcb: number; hrdf: number;
  componentLines?: StoredLine[];
  recordLines?: { code: string; name: string; amount: number }[];
  exemptionUsed?: Record<string, number>;
};
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

/**
 * The reporter's own catalogue, reproduced:
 *   BOOO1 ANGPOW      — an allowance DECLARED as additional remuneration, so it lands in the bonus bucket.
 *   A0027 HANDPHONE   — an ordinary recurring allowance: it folds on BOTH runs but is paid by the regular
 *                       one, and is the line the additional-run stamp has to drop.
 *   B0500 PROD BONUS  — a SPLIT item: RM1,500 declared additional against a RM1,000-capped exemption code,
 *                       so RM1,000 is paid untaxed (reimburse) and RM500 is the taxable bonus leg.
 */
async function seedCatalogue() {
  await seedPayComponentCatalog(a);
  await upsertPayComponent(a, earning('BOOO1', 'ANGPOW', {
    includedInSocsoEis: false,
    pcbRemunerationType: 'additional',
    pcbExemptionCode: 'PCB_TAXABLE',
  }));
  await upsertPayComponent(a, earning('A0027', 'HANDPHONE'));
  await upsertPayComponent(a, earning('B0500', 'PRODUCTIVITY BONUS', {
    includedInSocsoEis: false,
    pcbRemunerationType: 'additional',
    pcbExemptionCode: 'PCB_COMPANY_PROD', // annual cap RM1,000
  }));
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
}

/** The reporter's shape: a regular run that pays basic + a recurring allowance, then a BONUS run that
 *  pays ANGPOW 500 and the taxable leg of a split productivity bonus. */
async function twoRuns(employmentId: string) {
  await setEmploymentPayComponent(a, {
    employmentId, componentId: await idByCode('A0027'), amount: 100, effectiveFrom: '2026-01-01',
  });
  const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
  await generatePayslips(a, { batchId: reg.batchId });
  const bonusRun = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-01', runType: 'bonus' });
  await setPayrollBatchComponent(a, {
    batchId: bonusRun.batchId, employmentId, componentId: await idByCode('BOOO1'), amount: 500,
  });
  await setPayrollBatchComponent(a, {
    batchId: bonusRun.batchId, employmentId, componentId: await idByCode('B0500'), amount: 1500,
  });
  await generatePayslips(a, { batchId: bonusRun.batchId });
  return { reg, bonusRun };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('6b134681 — the additional run stamps the items it pays', () => {
  it('a bonus payslip carries componentLines, and every stamped line is a bonus-bucket line', async () => {
    await seedCatalogue();
    const e = await hire('angpow@acme.test', '900101015401', 5000);
    const { bonusRun } = await twoRuns(e.employmentId);

    const slip = await slipOf(bonusRun.batchId, e.employmentId);
    const lines = statOf(slip).componentLines ?? [];

    // THE DEFECT ITSELF: this was `[]` on all 19 production bonus payslips.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => l.code).sort()).toEqual(['B0500', 'BOOO1']);

    // The recurring allowance the regular run paid is NOT re-listed here — that is the objection the
    // regular-run-only gate existed to answer, and it is answered by the subset rather than by silence.
    expect(lines.map((l) => l.code)).not.toContain('A0027');

    // Every retained bucket contribution is a bonus one; nothing else survived the filter.
    for (const l of lines) {
      expect(l.buckets.length).toBeGreaterThan(0);
      for (const b of l.buckets) expect(b.bucket).toBe('bonus');
    }

    // The reporter's line, by name, on the payslip that pays it.
    const angpow = lines.find((l) => l.code === 'BOOO1')!;
    expect(angpow.name).toBe('ANGPOW');
    expect(angpow.amount).toBeCloseTo(500, 2);
    expect(payItemLabel(angpow)).toBe('BOOO1 · ANGPOW');
  });

  it('a SPLIT item is stamped at its bonus leg, not at its whole resolved amount', async () => {
    await seedCatalogue();
    const e = await hire('split@acme.test', '900101015401', 5000);
    const { bonusRun } = await twoRuns(e.employmentId);

    const lines = statOf(await slipOf(bonusRun.batchId, e.employmentId)).componentLines ?? [];
    const split = lines.find((l) => l.code === 'B0500')!;

    // RM1,500 keyed; RM1,000 exempt under PCB_COMPANY_PROD (paid untaxed, and NOT paid by this run at
    // all, since an additional run's gross is its bonus); RM500 taxable bonus.
    expect(split.buckets).toEqual([{ bucket: 'bonus', amount: 500 }]);
    // `amount` is re-summed from what was RETAINED. Copying the stored 1,500 through would put a figure
    // larger than the payslip's own gross onto Transaction View's grid, which renders `l.amount`.
    expect(split.amount).toBeCloseTo(500, 2);
  });

  it('the stamped lines RECONCILE to the bonus figure and to gross — the property r196 requires', async () => {
    await seedCatalogue();
    const e = await hire('reconcile@acme.test', '900101015401', 5000);
    const { bonusRun } = await twoRuns(e.employmentId);

    const slip = await slipOf(bonusRun.batchId, e.employmentId);
    const lines = statOf(slip).componentLines ?? [];
    const named = payItemLinesForBuckets(lines, ['bonus']);

    expect(named.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(Number(slip.bonus), 2);
    // On an additional run gross IS the bonus, so the same rows explain both figures.
    expect(Number(slip.grossPay)).toBeCloseTo(Number(slip.bonus), 2);
    expect(payItemLinesReconcile(named, slip.bonus)).toBe(true);
    expect(payItemLinesReconcile(named, slip.grossPay)).toBe(true);
  });

  it('recordLines and exemptionUsed stay regular-run only — deliberately out of scope', async () => {
    await seedCatalogue();
    const e = await hire('scope@acme.test', '900101015401', 5000);
    const { reg, bonusRun } = await twoRuns(e.employmentId);

    const bonusSt = statOf(await slipOf(bonusRun.batchId, e.employmentId));
    // recordLines would re-list record-only recurring items, and its txn-provenance half would double up
    // against the new component line inside History's ITEM population (history-pivot pushes both).
    expect(bonusSt.recordLines).toBeUndefined();
    // exemptionUsed is replayed by later months' YTD accumulator; stamping it twice would double-count.
    expect(bonusSt.exemptionUsed).toBeUndefined();

    // And the regular run is untouched: it still stamps every line it folded, wage bucket included.
    const regLines = statOf(await slipOf(reg.batchId, e.employmentId)).componentLines ?? [];
    expect(regLines.map((l) => l.code)).toEqual(['A0027']);
    expect(regLines[0].buckets).toEqual([{ bucket: 'wage', amount: 100 }]);
  });

  it('NOT ONE FIGURE MOVES: the money on both runs, asserted beside the stamp', async () => {
    await seedCatalogue();
    const e = await hire('money@acme.test', '900101015401', 5000);
    const { reg, bonusRun } = await twoRuns(e.employmentId);

    // ── The regular run: basic 5,000 + HANDPHONE 100. Unchanged by this item in every respect. ──
    const r = await slipOf(reg.batchId, e.employmentId);
    expect(Number(r.basicSalary)).toBeCloseTo(5000, 2);
    expect(Number(r.allowance)).toBeCloseTo(100, 2);
    expect(Number(r.bonus)).toBeCloseTo(0, 2);
    expect(Number(r.grossPay)).toBeCloseTo(5100, 2);
    const rst = statOf(r);
    expect(rst.epfEmployee).toBeCloseTo(561, 2);
    expect(rst.epfEmployer).toBeCloseTo(612, 2);
    expect(Number(r.netPay)).toBeCloseTo(
      5100 - (rst.epfEmployee + rst.socsoEmployee + rst.socsoSkbbk + rst.eisEmployee + rst.pcb),
      2,
    );

    // ── The bonus run: it pays ONLY its additional remuneration. ──
    const b = await slipOf(bonusRun.batchId, e.employmentId);
    expect(Number(b.basicSalary)).toBeCloseTo(0, 2);
    expect(Number(b.allowance)).toBeCloseTo(0, 2);
    expect(Number(b.overtimePay)).toBeCloseTo(0, 2);
    // ANGPOW 500 + the taxable leg of the split productivity bonus 500.
    expect(Number(b.bonus)).toBeCloseTo(1000, 2);
    expect(Number(b.grossPay)).toBeCloseTo(1000, 2);
    const bst = statOf(b);
    // A bonus is outside SOCSO/EIS by law (SOCSO Act 1969 s.2), so the additional run adds neither.
    expect(Number(bst.socsoEmployee)).toBeCloseTo(0, 2);
    expect(Number(bst.eisEmployee)).toBeCloseTo(0, 2);
    // HRD Corp levy rides the normal wage only.
    expect(Number(bst.hrdf)).toBeCloseTo(0, 2);
    expect(Number(b.netPay)).toBeCloseTo(
      1000 - (bst.epfEmployee + bst.socsoEmployee + bst.socsoSkbbk + bst.eisEmployee + bst.pcb),
      2,
    );

    // THE CONTRACT, in the same case as the figures: the rows the screens will print add up to the
    // figure they sit under, and to gross, on the very payslip whose money is asserted above.
    const named = payItemLinesForBuckets(statOf(b).componentLines ?? [], ['bonus']);
    expect(named.map((l) => payItemLabel(l)).sort()).toEqual(['B0500 · PRODUCTIVITY BONUS', 'BOOO1 · ANGPOW']);
    expect(payItemLinesReconcile(named, b.grossPay)).toBe(true);
  });
});
