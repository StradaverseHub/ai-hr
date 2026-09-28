/**
 * 1bb09a73 — the amounts saved on Form TP3 reach the figures the payroll run reads, and a year that
 * does not line up is refused instead of silently seeded as zero.
 *
 * ══ THE TWO DEFECTS ═════════════════════════════════════════════════════════════════════════════════
 *
 * 1. `core/tp3.ts` wrote `employee_tp3` and nothing else. `core/payroll.ts` reads only
 *    `employee_statutory_my.tp3_year / tp3_net_remuneration / tp3_epf_claimed / tp3_pcb_paid /
 *    tp3_zakat_paid`. Nothing joined them, so a completed TP3 contributed NOTHING to PCB. On
 *    2026-09-24 production held one row in each store — FOR DIFFERENT PEOPLE.
 *
 * 2. `tp3Applies = e.tp3Year === pYear`, else the four accumulators are set to ZERO. A year that does
 *    not match produces a wrong statutory deduction that nothing on a payslip can reveal.
 *
 * ══ WHAT IS PINNED, AND WHAT IS DELIBERATELY NOT ════════════════════════════════════════════════════
 *
 * The PCB AMOUNT is pinned two ways and neither is a number invented here. It is compared against the
 * SAME EMPLOYEE RUN WITHOUT THE FORM (so "the amount moves" is measured, not asserted), and against
 * `pcbMonth` — the jurisdiction's own primitive — called directly with the accumulators the form
 * derives. Two assemblies of the same statute agreeing is evidence; a hand-computed LHDN figure written
 * into a test file by whoever wrote the code would be neither (CLAUDE.md §8, statutory documents).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { deriveAccumulatorSeed, deleteTp3, saveTp3, Tp3Error } from '../core/tp3';
import {
  batchDetail,
  createBatch,
  generatePayslips,
  preProcessAdvisory,
  PreProcessBlockedError,
} from '../core/payroll';
import { setStatutoryProfileMY, setTp3ProfileMY, setBankProfileMY } from '../localization/my/statutory';
import { pcbMonth } from '../localization/my/payroll';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, `messages/${l}.json`), 'utf8'))]),
) as Record<(typeof LOCALES)[number], Record<string, never>>;

let b: Base;
let a: SessionContext;
const YEAR = 2026;

/**
 * THE REPORTER'S OWN ROW, as production held it on 2026-09-24: person b57268ae, assessment year 2026,
 * deduction month 6, one previous employer, Section C c1 60000 / c2 3600 / c3 8979 / c5 3000.
 */
const PRODUCTION_SECTION_C = {
  c1: { amount: 60000 },
  c2: { subItems: { i: 3600 } },
  c3: { amount: 8979 },
  c5: { amount: 3000 },
} as const;
/**
 * (C1 − ΣC2) − K = 60000 − 3600 − min(8979, 4000).
 *
 * ⚠️ UPDATED TWICE BY 20837372, AND THIS ONE ROW IS THE WHOLE ITEM'S HISTORY.
 *
 * r342: it read 47421 — the whole 8,979 subtracted — while `core/payroll.ts` capped K at 4,000 for the
 * same box. The two disagreed, this employee's accumulated pay was RM4,979 too low and their PCB came
 * out light. Capping K took it to 52400.
 *
 * r350: it becomes 56000. C2(i) is 3,600 and INSIDE its RM6,000 limit, so there is no taxable excess —
 * and the exempt 3,600 is no longer subtracted at all, because C1 carries only the items that are
 * subject to tax ("…YANG DIKENAKAN CUKAI" on the agency's own form) and the exempt allowance was never
 * in it. 60,000 + 0 − 4,000. Their accumulated pay was a further RM3,600 too low until now.
 */
const PRODUCTION_NET = 56000;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

async function hire(name: string, hiredOn = '2026-01-01') {
  return hireEmployee(a, {
    person: { fullName: name, primaryEmail: `tp3sync_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
}

/** An employee who can actually be paid: a salary record and a Malaysian statutory profile. */
async function payableEmployee(name: string, opts: { hiredOn?: string; basic?: number } = {}) {
  const e = await hire(name, opts.hiredOn ?? '2026-01-01');
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: opts.basic ?? 5500,
    monthlyAllowance: 0,
    effectiveFrom: opts.hiredOn ?? '2026-01-01',
  });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: `9001${String(Math.floor(Math.random() * 90000000 + 10000000))}`,
    taxCategory: 3,
    numChildren: 3,
  });
  return e;
}

const statRow = (personId: string) =>
  owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId))
    .then((r) => r[0]);

type Slip = { pcb: number; pcbMeta: { ytdNet: number; epfClaimed: number; pcbPaid: number } };
async function runAndRead(payPeriod: string, name: string) {
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod });
  await generatePayslips(a, { batchId: batch.batchId });
  const slip = (await batchDetail(a, batch.batchId))!.slips.find((s) => s.name === name)!;
  return { batchId: batch.batchId, st: slip.statutory as unknown as Slip };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE MAPPING — read off the form's own definition, in ONE place
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 · the Section-C → payroll-column mapping', () => {
  it('is (C1 − ΣC2) − C3 · C3 · C5 · C4(i), and nothing else', () => {
    const seed = deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: {
        c1: { amount: 60000 },
        // ΣC2 is the SERVER's sum of the five roman-numeral boxes, so the payload carries it summed.
        c2: { amount: 3600, subItems: { i: 3600 } },
        c3: { amount: 8979 },
        // C4(ii) is the Umrah / religious-travel departure levy — a RELIEF, not zakat. It must not
        // reach Z, and a mapping that summed C4 would put 750 into the zakat accumulator.
        c4: { amount: 1250, subItems: { i: 500, ii: 750 } },
        c5: { amount: 3000 },
      },
      sectionD: {},
    });
    expect(seed).toEqual({
      gross: 60000,
      // ΣC2 AS IT COUNTS. C2(i) is 3,600 against a RM6,000 limit, so nothing is trimmed here and this
      // equals `exemptEntered` — the pair is asserted together on purpose, so a future change that
      // starts trimming an in-limit box has to disagree with one of them.
      exemptTotal: 3600,
      exemptEntered: 3600,
      // r350 — nothing is over its limit, so nothing is taxable and nothing is added. The pair above
      // says what is exempt; this says what reaches the calculation, and here it is nil.
      excessTotal: 0,
      netRemuneration: PRODUCTION_NET,
      // THE RAW BOX, because the form prints it — and the ALLOWABLE figure beside it, which is what
      // (Y−K) is struck against. Before r342 only the first existed and the arithmetic used it.
      epfClaimed: 8979,
      epfAllowable: 4000,
      pcbPaid: 3000,
      zakatPaid: 500,
      // Item 20837372 — Section D joins the seed as ∑LP. An EXACT-SET assertion, UPDATED not loosened:
      // an empty Section D must still produce 0 here, because a form with no reliefs declared may not
      // start relieving anything. The dedicated non-vacuity for a NON-empty Section D is in
      // test/20837372-tp3-section-d-lp.test.ts.
      lpDeclared: 0,
    });
  });

  it('lives in ONE function that the form screen, the save and the payroll gate all read', () => {
    const strip = (p: string) =>
      readFileSync(join(ROOT, p), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    // A guard that can be satisfied by a comment is not a guard, so all three are read comment-stripped.
    expect(strip('app/payroll/transactions/tp3/page.tsx')).toMatch(/deriveAccumulatorSeed\(/);
    expect(strip('core/payroll.ts')).toMatch(/deriveAccumulatorSeed\(/);
    expect(strip('core/tp3.ts')).toMatch(/deriveAccumulatorSeed\(payload\)/);
    // And no second transcription of the arithmetic anywhere else.
    expect(strip('core/payroll.ts')).not.toMatch(/tp3Net[A-Za-z]*\s*=\s*.*c1/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · (a) SAVING THE FORM MOVES THE PCB AMOUNT
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 (a) · a saved Form TP3 reaches the payroll run', () => {
  it('writes all four figures and the year, and the PCB the run computes MOVES', async () => {
    const control = await payableEmployee('Sync Control');
    const subject = await payableEmployee('Sync Subject');

    await saveTp3(adminCtx(b), {
      personId: subject.personId,
      assessmentYear: YEAR,
      sectionC: PRODUCTION_SECTION_C,
    });

    // ── the four columns ──
    const row = await statRow(subject.personId);
    expect(row.tp3Year).toBe(YEAR);
    expect(Number(row.tp3NetRemuneration)).toBe(PRODUCTION_NET);
    expect(Number(row.tp3EpfClaimed)).toBe(8979);
    expect(Number(row.tp3PcbPaid)).toBe(3000);
    expect(Number(row.tp3ZakatPaid)).toBe(0);

    // ── the run ──
    const june = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    await generatePayslips(a, { batchId: june.batchId });
    const slips = (await batchDetail(a, june.batchId))!.slips;
    const withForm = slips.find((s) => s.name === 'Sync Subject')!.statutory as unknown as Slip;
    const without = slips.find((s) => s.name === 'Sync Control')!.statutory as unknown as Slip;

    // The accumulators the calculation actually used are the form's own figures. K is capped at the
    // annual EPF relief by the kernel (pack-owned), which is why it is read from the run rather than
    // asserted at 8,979 — the cap is the calculator's rule and this test must not restate it.
    expect(withForm.pcbMeta.ytdNet).toBe(PRODUCTION_NET);
    expect(withForm.pcbMeta.pcbPaid).toBe(3000);
    expect(withForm.pcbMeta.epfClaimed).toBeGreaterThan(0);
    expect(without.pcbMeta).toMatchObject({ ytdNet: 0, epfClaimed: 0, pcbPaid: 0 });

    // ⚠️ THE AMOUNT, not the column. Two employees, identical salary and tax profile, one difference.
    expect(withForm.pcb).not.toBe(without.pcb);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · (b) THE REPORTER'S CASE, END TO END
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 (b) · the 1 July joiner with the production payload', () => {
  it('reconciles the run’s PCB against pcbMonth called with the form’s own accumulators', async () => {
    const e = await payableEmployee('July Joiner', { hiredOn: '2026-07-01', basic: 6000 });
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 6,
      previousEmployers: [{ name: 'Engineer Kuala Lumpur' }],
      sectionC: PRODUCTION_SECTION_C,
    });

    const { st } = await runAndRead(`${YEAR}-07`, 'July Joiner');
    const row = await statRow(e.personId);

    // The ACCUMULATORS the run used, straight off the stored columns the form wrote.
    expect(st.pcbMeta.ytdNet).toBe(PRODUCTION_NET);
    expect(st.pcbMeta.pcbPaid).toBe(3000);

    // INDEPENDENT ASSEMBLY: the jurisdiction primitive, handed exactly what the form derives, with the
    // K cap applied the way the kernel applies it (read back from the run, not restated here).
    const expected = pcbMonth({
      monthlyWage: 6000,
      epfMonthly: Number((st as unknown as { epfEmployee?: number }).epfEmployee ?? 0),
      month: 7,
      profile: { category: 3, children: 3 },
      acc: {
        netRemuneration: Number(row.tp3NetRemuneration),
        epfClaimed: st.pcbMeta.epfClaimed,
        pcbPaid: Number(row.tp3PcbPaid),
        zakatPaid: Number(row.tp3ZakatPaid),
        lpAccumulated: 0,
      },
    });
    expect(st.pcb).toBe(expected.normal);
    // And it is not the degenerate answer: a July joiner whose previous employment is ignored computes
    // a different figure, so this case cannot pass by both sides being zero.
    const ignored = pcbMonth({
      monthlyWage: 6000,
      epfMonthly: Number((st as unknown as { epfEmployee?: number }).epfEmployee ?? 0),
      month: 7,
      profile: { category: 3, children: 3 },
    });
    expect(expected.normal).not.toBe(ignored.normal);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · (c) A YEAR MISMATCH IS REFUSED, NEVER A SILENT ZERO
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 (c) · the year mismatch', () => {
  async function mismatched(name: string) {
    const e = await payableEmployee(name);
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C });
    // A hand edit on the Payroll tab moves the year off the form's. This is the production shape too:
    // a form for 2026 and columns that do not carry 2026.
    await setTp3ProfileMY(a, {
      personId: e.personId,
      tp3Year: YEAR - 1,
      tp3NetRemuneration: 1,
      tp3EpfClaimed: 1,
      tp3PcbPaid: 1,
    });
    return e;
  }

  it('names the employee on the pre-processing checks as a BLOCKER', async () => {
    const e = await mismatched('Mismatch Named');
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    const advisory = await preProcessAdvisory(a, batch.batchId);
    expect(advisory.tp3YearMismatch?.map((r) => r.employmentId)).toEqual([e.employmentId]);
  });

  it('REFUSES the payroll run rather than seeding zero', async () => {
    await mismatched('Mismatch Blocked');
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    await expect(generatePayslips(a, { batchId: batch.batchId })).rejects.toBeInstanceOf(
      PreProcessBlockedError,
    );
  });

  it('does NOT fire for a form in a different year, nor for a form that declares no money', async () => {
    // Last year's form correctly does not seed this year, and saying so is not a fault.
    const past = await payableEmployee('Past Year Form');
    await saveTp3(adminCtx(b), { personId: past.personId, assessmentYear: YEAR - 1, sectionC: PRODUCTION_SECTION_C });
    // A form with an all-blank Section C loses nothing by not being read.
    const blank = await payableEmployee('Blank Form');
    await saveTp3(adminCtx(b), { personId: blank.personId, assessmentYear: YEAR, sectionC: {} });
    await setTp3ProfileMY(a, { personId: blank.personId, tp3Year: YEAR - 1, tp3NetRemuneration: 1 });

    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    const advisory = await preProcessAdvisory(a, batch.batchId);
    expect(advisory.tp3YearMismatch).toEqual([]);
    await expect(generatePayslips(a, { batchId: batch.batchId })).resolves.toBeTruthy();
  });

  it('does NOT fire when only the AMOUNTS were edited by hand — that stays allowed', async () => {
    const e = await payableEmployee('Hand Amounts');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C });
    await setTp3ProfileMY(a, {
      personId: e.personId,
      tp3Year: YEAR,
      tp3NetRemuneration: 12345,
      tp3EpfClaimed: 100,
      tp3PcbPaid: 200,
    });
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    expect((await preProcessAdvisory(a, batch.batchId)).tp3YearMismatch).toEqual([]);
    await generatePayslips(a, { batchId: batch.batchId });
    const slip = (await batchDetail(a, batch.batchId))!.slips.find((s) => s.name === 'Hand Amounts')!;
    expect((slip.statutory as unknown as Slip).pcbMeta.ytdNet).toBe(12345);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · (d) AN EMPLOYEE WITH NO FORM IS UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 (d) · no Form TP3 ⇒ byte-identical to before this item', () => {
  it('reproduces the LHDN Exhibit-5 February figures from hand-keyed opening balances alone', async () => {
    // The scenario and the expected numbers are the ones `test/slice0.test.ts` has pinned since the
    // opening balances existed: ∑(Y−K)=4,895, K=605, X=110 ⇒ February MTD 110. Nothing about this
    // employee involves `employee_tp3`, so if the projection leaked into the no-form path at all, this
    // is the number that moves.
    const e = await hire('Tp3 Joiner');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101016666',
      taxCategory: 3,
      numChildren: 3,
      tp3Year: 2026,
      tp3NetRemuneration: 4895,
      tp3EpfClaimed: 605,
      tp3PcbPaid: 110,
    });
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-02' });
    expect((await preProcessAdvisory(a, batch.batchId)).tp3YearMismatch).toEqual([]);
    await generatePayslips(a, { batchId: batch.batchId });
    const slip = (await batchDetail(a, batch.batchId))!.slips.find((s) => s.name === 'Tp3 Joiner')!;
    const st = slip.statutory as unknown as Slip;
    expect(st.pcbMeta.ytdNet).toBe(4895);
    expect(st.pcb).toBe(110);
  });

  it('an employee with neither a form nor opening balances still runs, with zero accumulators', async () => {
    await payableEmployee('Plain Employee');
    const { st } = await runAndRead('2026-02', 'Plain Employee');
    expect(st.pcbMeta).toMatchObject({ ytdNet: 0, epfClaimed: 0, pcbPaid: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · (e) A HAND EDIT STILL WORKS AND SURVIVES AN UNRELATED SAVE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 (e) · the Payroll tab still owns the figures by hand', () => {
  it('a hand edit after a form save wins, and an unrelated save does not clobber it', async () => {
    const e = await payableEmployee('Hand Editor');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C });
    expect(Number((await statRow(e.personId)).tp3NetRemuneration)).toBe(PRODUCTION_NET);

    await setTp3ProfileMY(a, {
      personId: e.personId,
      tp3Year: YEAR,
      tp3NetRemuneration: 41000,
      tp3EpfClaimed: 4000,
      tp3PcbPaid: 2500,
    });
    // An UNRELATED partial save on the same row — the Bank Information card.
    await setBankProfileMY(a, { personId: e.personId, bankName: 'Maybank', bankAccountNo: '1234567890' });

    const row = await statRow(e.personId);
    expect(Number(row.tp3NetRemuneration)).toBe(41000);
    expect(Number(row.tp3EpfClaimed)).toBe(4000);
    expect(Number(row.tp3PcbPaid)).toBe(2500);
    expect(row.tp3Year).toBe(YEAR);
    expect(row.bankName).toBe('Maybank');
    // The form row itself is untouched by either — it is still the record of what was handed in.
    const [form] = await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId));
    expect(deriveAccumulatorSeed(form.payload)!.netRemuneration).toBe(PRODUCTION_NET);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · THE REFUSALS AND THE CONDITIONAL PROJECTION
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 · when the projection does not apply, it SAYS so', () => {
  it('a LATER year holds the columns: the form saves, the columns do not move, and the year is not demoted', async () => {
    const e = await payableEmployee('Later Year');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C });
    const before = await statRow(e.personId);

    const out = await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR - 1,
      sectionC: { c1: { amount: 999 } },
    });
    expect(out.seed).toEqual({ applied: false, reason: 'laterYearHoldsColumns', heldBy: YEAR });

    const after = await statRow(e.personId);
    expect(after.tp3Year, 'the year the PCB kernel matches on is not demoted').toBe(YEAR);
    expect(after.tp3NetRemuneration).toBe(before.tp3NetRemuneration);
    expect(after.tp3EpfClaimed).toBe(before.tp3EpfClaimed);
    expect(after.tp3PcbPaid).toBe(before.tp3PcbPaid);
    expect(after.tp3ZakatPaid).toBe(before.tp3ZakatPaid);
    // and the older form IS on file
    const rows = await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId))
      .orderBy(schema.employeeTp3.assessmentYear);
    expect(rows.map((r) => r.assessmentYear)).toEqual([YEAR - 1, YEAR]);
  });

  it('refuses a form that carries money when there is nowhere for it to land', async () => {
    const e = await hire('No Statutory Row');
    await expect(
      saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C }),
    ).rejects.toThrow(/no Malaysian statutory profile/i);
    // AND THE FORM IS NOT ON FILE — one transaction, so the refusal takes the row with it. A saved form
    // whose money reached nothing is the exact state this item was raised about.
    const rows = await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId));
    expect(rows).toEqual([]);
  });

  it('lets a MONEYLESS form save with no statutory row, and says the projection did not apply', async () => {
    const e = await hire('Blank No Statutory');
    const out = await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR });
    expect(out.seed).toEqual({ applied: false, reason: 'noStatutoryProfile' });
  });

  it('refuses a Section C that does not add up rather than writing a negative accumulator', async () => {
    // ⚠️ THE GUARD IS UNCHANGED; ITS FIXTURE HAD TO MOVE (r350). C1 1,000 / C2(i) 900 / C3 500 used to
    // reach −400 because ΣC2 was subtracted. It no longer is — C1 carries only taxable pay, so an
    // exempt allowance cannot push the accumulator negative and that combination is now a valid +500.
    // A negative now needs C3 to exceed C1 plus any taxable excess, which is still exactly the shape of
    // a mis-keyed form and must still be refused rather than stored.
    const e = await payableEmployee('Negative Net');
    await expect(
      saveTp3(adminCtx(b), {
        personId: e.personId,
        assessmentYear: YEAR,
        sectionC: { c1: { amount: 1000 }, c2: { subItems: { i: 900 } }, c3: { amount: 4000 } },
      }),
    ).rejects.toBeInstanceOf(Tp3Error);
    const row = await statRow(e.personId);
    expect(row.tp3Year).toBeNull();
  });

  it('and the SAME boxes that used to be refused are now a valid form — the rule moved, not the guard', async () => {
    // Non-vacuity for the case above: if the refusal were still firing on the old shape, this fails.
    const e = await payableEmployee('Formerly Negative');
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: { c1: { amount: 1000 }, c2: { subItems: { i: 900 } }, c3: { amount: 500 } },
    });
    expect(Number((await statRow(e.personId)).tp3NetRemuneration), '1,000 + 0 − 500').toBe(500);
  });

  it('deleting the form withdraws the projection it put there, and only for its own year', async () => {
    const e = await payableEmployee('Deleter');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: PRODUCTION_SECTION_C });
    await deleteTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR });
    const cleared = await statRow(e.personId);
    expect(cleared.tp3Year).toBeNull();
    expect(cleared.tp3NetRemuneration).toBeNull();
    expect(cleared.tp3PcbPaid).toBeNull();

    // A hand-keyed balance for a DIFFERENT year is not withdrawn by deleting some other year's form.
    await setTp3ProfileMY(a, { personId: e.personId, tp3Year: YEAR, tp3NetRemuneration: 777, tp3EpfClaimed: 1, tp3PcbPaid: 2 });
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR - 1, sectionC: { c1: { amount: 5 } } });
    await deleteTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR - 1 });
    const kept = await statRow(e.personId);
    expect(kept.tp3Year).toBe(YEAR);
    expect(Number(kept.tp3NetRemuneration)).toBe(777);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · WHAT THE SCREENS SAY
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('1bb09a73 · the screens say what is now true, in all six locales', () => {
  it('carries every new and rewritten string in all six locales', () => {
    for (const l of LOCALES) {
      const m = messages[l] as unknown as {
        taxRelief: { tp3: { stageNote: string; reconcileNote: string; savedFormOnly: string } };
        payroll: {
          batch: {
            preChecks: { tp3YearMismatch: string };
            preChecksTp3BlockerHint: string;
            preChecksBlockedTp3Error: string;
          };
          process: { validationCheck: { tp3YearMismatch: string } };
        };
      };
      expect(m.taxRelief.tp3.savedFormOnly, `${l} savedFormOnly`).toContain('{year}');
      expect(m.taxRelief.tp3.stageNote, `${l} stageNote`).toBeTruthy();
      expect(m.taxRelief.tp3.reconcileNote, `${l} reconcileNote`).toBeTruthy();
      expect(m.payroll.batch.preChecks.tp3YearMismatch, `${l} preChecks`).toBeTruthy();
      expect(m.payroll.process.validationCheck.tp3YearMismatch, `${l} validationCheck`).toBeTruthy();
      expect(m.payroll.batch.preChecksTp3BlockerHint, `${l} hint`).toContain('{n}');
      expect(m.payroll.batch.preChecksBlockedTp3Error, `${l} blocked`).toContain('{n}');
    }
  });

  it('no longer claims on the TP3 screen that nothing there changes the deduction', () => {
    // The stage-1 banner said "Nothing on this screen changes the monthly tax deduction." That is now
    // FALSE for Section C, and a statutory screen may not print an assurance it cannot stand behind.
    expect((messages.en as unknown as { taxRelief: { tp3: { stageNote: string } } }).taxRelief.tp3.stageNote)
      .not.toMatch(/Nothing on this screen changes/i);
  });

  it('the blocker is rendered as a blocker on both surfaces, and counted where it is enforced', () => {
    const strip = (p: string) =>
      readFileSync(join(ROOT, p), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const p of ['app/payroll/[batchId]/page.tsx', 'app/payroll/process/steps/step-validation.tsx']) {
      expect(strip(p), p).toMatch(/\['tp3YearMismatch',[\s\S]{0,60}?, true\]/);
    }
    // The wizard merges every optional list; a group declared and not merged cannot reach the screen.
    expect(strip('core/payroll.ts')).toMatch(/merged\.tp3YearMismatch!\.push/);
    // And the server-side refusal counts it — a card the server does not enforce is decoration.
    expect(strip('core/payroll.ts')).toMatch(/checks\.tp3YearMismatch\?\.length \?\? 0\)/);
  });
});
