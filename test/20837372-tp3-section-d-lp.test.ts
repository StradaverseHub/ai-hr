/**
 * 20837372 — FORM TP3 SECTION D REACHES ∑LP, AND THE C2 EXEMPTION LIMITS ARE SHOWN WITHOUT MOVING MONEY.
 *
 * ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf`, printed page 22, item 10: "The information
 * amount from the TP3 Form shall be treated in the formula as variable (Y–K*), X, Z and ∑LP." Item
 * 1bb09a73 wired three. ∑LP had no column, `deriveAccumulatorSeed` read `payload.sectionC` only, and
 * `core/payroll.ts` opened every accumulator with a hard `lpAccumulated: 0`. Seventeen relief lines were
 * captured, validated, stored and printed — and reached nothing.
 *
 * ∑LP is SUBTRACTED inside P, so the omission ran against the employee: P too high ⇒ tax too high ⇒ the
 * monthly deduction too high, every month, for anybody who handed in a correctly filled Section D.
 *
 * ══ HOW THE FIGURE IS PINNED, AND WHY NOT BY A HAND-TYPED RINGGIT AMOUNT ════════════════════════════
 *
 * Three ways, none of them a number invented by whoever wrote the code (CLAUDE.md §8):
 *
 *   1. **P moves by exactly ∑LP.** The payslip's own trace carries P1. Two employees identical in every
 *      respect except the Section D must differ in P1 by the Section D total and by nothing else. That
 *      is the DEFINITION of the variable, checked against the run's own recorded working, and it is the
 *      arm that would catch a seed that landed in the wrong accumulator.
 *   2. **The jurisdiction primitive, independently assembled.** `pcbMonth` is called directly with the
 *      accumulators the form derives, and must return the run's figure.
 *   3. **The direction is measured, not asserted.** The same employee run WITHOUT the form is the
 *      control, and the deduction must come out strictly LOWER with it.
 *
 * ══ ⚠️ WHAT THIS ROUND DELIBERATELY DID NOT DO, PINNED HERE SO IT CANNOT DRIFT ══════════════════════
 *
 * The ticket asked for each C2 sub-item's exemption limit to be applied and "the taxable remainder"
 * computed. THE LIMITS ARE SHOWN AND WARNED ABOUT; NOTHING IS CAPPED. Two sourced reasons:
 *
 *   · TP3 Section C prints NO limit column — one money column, `AMAUN TERKUMPUL (RM)`, on both the
 *     specification's Exhibit 2 (printed page 39) and the standalone `bm-borang-tp3-2026.pdf`. Section D
 *     on the next page prints two. ADR-0008: an item with no printed cap is captured and never blocked.
 *   · Specification printed page 20, item 9: "Any amount exceed the restricted amount shall be taxable."
 *     That instruction is addressed to the employer running the payroll — for a TP3, the PREVIOUS one —
 *     so the over-limit part is already inside C1 as taxable pay before this form is filled in. Capping
 *     C2 here would tax the same ringgit twice.
 *
 * So the arms below assert the WARNING at the limit and one ringgit over, and assert that the stored
 * figure and the derived exempt total are untouched. A future round that decides to cap must change
 * these assertions deliberately, which is the point of writing them down.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  deleteTp3,
  deriveAccumulatorSeed,
  saveTp3,
  TP3_SECTION_C,
  tp3ExemptionOverLimits,
  Tp3Error,
} from '../core/tp3';
import {
  batchDetail,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  PeriodAlreadyFiledError,
} from '../core/payroll';
import { markReportFiled } from '../core/reporting';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { pcbMonth } from '../localization/my/payroll';
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
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const YEAR = 2026;

/**
 * A Section D a real employee could hand in: lifestyle at its RM2,500 limit, a registered child-care
 * centre, and a private retirement scheme. Every figure is inside its own printed annual limit, so
 * `readGroup` stores it whole and the total below is what the form asserts.
 */
const SECTION_D = {
  c5: { subItems: { a: 1500, b: 1000 } }, //  2,500 — lifestyle (limit 2,500)
  c8: { amount: 3000 }, //                   3,000 — child-care centre (limit 3,000)
  c12: { amount: 3000 }, //                  3,000 — private retirement scheme (limit 3,000)
} as const;
const D_TOTAL = 8500;

/** Section C figures, kept identical across every arm so ∑LP is the only thing that ever varies. */
const SECTION_C = {
  c1: { amount: 60000 },
  c2: { subItems: { i: 3600 } },
  c3: { amount: 8979 },
  c5: { amount: 3000 },
} as const;

/**
 * The SAME two sections as a STORED payload rather than as form input.
 *
 * `saveTp3` takes the operator's raw boxes and `readGroup` computes every item's `amount` as the server's
 * own sum of its sub-lines — the client never sends a total, at any level. `deriveAccumulatorSeed` reads
 * what was STORED, so the arms that call it directly are handed the totalled shape, spelled out here
 * rather than produced by a helper: a test that computed the totals with the same reduction the code
 * uses would be checking that reduction against itself.
 */
const STORED_C = {
  c1: { amount: 60000 },
  c2: { amount: 3600, subItems: { i: 3600 } },
  c3: { amount: 8979 },
  c5: { amount: 3000 },
};
const STORED_D = {
  c5: { amount: 2500, subItems: { a: 1500, b: 1000 } },
  c8: { amount: 3000 },
  c12: { amount: 3000 },
};

let b: Base;
let a: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(b);
});

async function payableEmployee(name: string, basic = 6000) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `lp_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: `${YEAR}-01-01`,
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: `${YEAR}-01-01`,
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

type SlipStatutory = {
  pcb: number;
  epfEmployee?: number;
  pcbMeta?: { P1: number; epfClaimed: number; trace?: { lpAccumulated: number; lpCurrent: number } };
};

/** One month's run, returning each named employee's statutory block. */
async function runMonth(period: string, names: string[]) {
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: batch.batchId });
  const detail = (await batchDetail(a, batch.batchId))!;
  const out = new Map<string, SlipStatutory>();
  for (const n of names) {
    const slip = detail.slips.find((s) => s.name === n);
    if (!slip) throw new Error(`no payslip for ${n}`);
    out.set(n, slip.statutory as unknown as SlipStatutory);
  }
  return { batchId: batch.batchId, st: out };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE MAPPING — Section D becomes ∑LP, in the SAME one function the other four come from
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 · the Section-D → ∑LP mapping', () => {
  it('sums every Section D item into lpDeclared, and touches nothing else in the seed', () => {
    const withD = deriveAccumulatorSeed({ form: 'tp3-2026', sectionC: STORED_C, sectionD: STORED_D })!;
    const withoutD = deriveAccumulatorSeed({ form: 'tp3-2026', sectionC: STORED_C, sectionD: {} })!;
    expect(withD.lpDeclared).toBe(D_TOTAL);
    expect(withoutD.lpDeclared, 'an absent Section D declares nothing and may relieve nothing').toBe(0);
    // EVERY OTHER MEMBER IDENTICAL. A Section D that moved ∑(Y−K) or Z would be a statutory error that
    // no single-figure assertion above would catch.
    expect({ ...withD, lpDeclared: 0 }).toEqual(withoutD);
  });

  it('sums over the CATALOGUE, so a payload key that is not a Section D line contributes nothing', () => {
    const seed = deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: STORED_C,
      // `c99` is not in the shared relief schedule. A `Object.values(sectionD)` sum would relieve 99,999
      // of a statutory deduction off the back of a key nobody validated.
      sectionD: { ...STORED_D, c99: { amount: 99999 } },
    })!;
    expect(seed.lpDeclared).toBe(D_TOTAL);
  });

  it('is read by the save, the screen and the payroll pre-processing gate — one function, three readers', () => {
    const strip = (p: string) =>
      readFileSync(join(ROOT, p), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    // The kernel must seed from the COLUMN, not re-derive the payload in a second place.
    expect(strip('core/payroll.ts')).toMatch(/lpAccumulated:\s*tp3Applies\s*\?\s*Number\(e\.tp3Lp/);
    // And the gate must count a Section-D-only form as money, or it guards less than the kernel seeds.
    expect(strip('core/payroll.ts')).toMatch(/seed\.lpDeclared !== 0/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · (a) A SECTION D LOWERS THE PCB, BY EXACTLY THE DECLARED AMOUNT
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (a) · a Form TP3 with a Section D lowers the monthly deduction', () => {
  it('writes tp3_lp, drops P by exactly ∑LP, and the deduction comes out LOWER', async () => {
    const control = await payableEmployee('LP Control');
    const subject = await payableEmployee('LP Subject');

    // IDENTICAL Section C on both, so the ONLY difference between the two employees is Section D.
    for (const e of [control, subject]) {
      await saveTp3(adminCtx(b), {
        personId: e.personId,
        assessmentYear: YEAR,
        sectionC: SECTION_C,
        ...(e === subject ? { sectionD: SECTION_D } : {}),
      });
    }

    const subjectRow = await statRow(subject.personId);
    const controlRow = await statRow(control.personId);
    expect(Number(subjectRow.tp3Lp)).toBe(D_TOTAL);
    expect(Number(controlRow.tp3Lp), 'no Section D ⇒ nothing to relieve').toBe(0);
    // The other four must be identical on both — a ∑LP that also moved ∑(Y−K) would be a second defect.
    for (const k of ['tp3Year', 'tp3NetRemuneration', 'tp3EpfClaimed', 'tp3PcbPaid', 'tp3ZakatPaid'] as const) {
      expect(String(subjectRow[k]), `${k} must not move with Section D`).toBe(String(controlRow[k]));
    }

    const { st } = await runMonth(`${YEAR}-07`, ['LP Control', 'LP Subject']);
    const ctl = st.get('LP Control')!;
    const sub = st.get('LP Subject')!;

    // ── 1. THE TRACE: ΣLP is the declared figure, and the current month adds nothing of its own.
    expect(sub.pcbMeta!.trace!.lpAccumulated).toBe(D_TOTAL);
    expect(sub.pcbMeta!.trace!.lpCurrent, 'no TP1 declared with THIS employer').toBe(0);
    expect(ctl.pcbMeta!.trace!.lpAccumulated).toBe(0);

    // ── 2. P MOVES BY EXACTLY ∑LP. This is the definition of the variable, checked against the run's
    //       own recorded working rather than against a figure typed into this file.
    expect(sub.pcbMeta!.P1).toBe(Math.round((ctl.pcbMeta!.P1 - D_TOTAL) * 100) / 100);

    // ── 3. THE DEDUCTION IS STRICTLY LOWER. Direction measured, not asserted.
    expect(sub.pcb).toBeLessThan(ctl.pcb);

    // ── 4. INDEPENDENT ASSEMBLY: the jurisdiction's own primitive, handed what the form derives.
    const expected = pcbMonth({
      monthlyWage: 6000,
      epfMonthly: Number(sub.epfEmployee ?? 0),
      month: 7,
      profile: { category: 3, children: 3 },
      acc: {
        netRemuneration: Number(subjectRow.tp3NetRemuneration),
        epfClaimed: sub.pcbMeta!.epfClaimed,
        pcbPaid: Number(subjectRow.tp3PcbPaid),
        zakatPaid: Number(subjectRow.tp3ZakatPaid),
        lpAccumulated: D_TOTAL,
      },
    });
    expect(sub.pcb).toBe(expected.normal);
    // …and it is not the degenerate answer: the same assembly with ∑LP zeroed gives the control's figure.
    const withoutLp = pcbMonth({
      monthlyWage: 6000,
      epfMonthly: Number(sub.epfEmployee ?? 0),
      month: 7,
      profile: { category: 3, children: 3 },
      acc: {
        netRemuneration: Number(subjectRow.tp3NetRemuneration),
        epfClaimed: sub.pcbMeta!.epfClaimed,
        pcbPaid: Number(subjectRow.tp3PcbPaid),
        zakatPaid: Number(subjectRow.tp3ZakatPaid),
        lpAccumulated: 0,
      },
    });
    expect(withoutLp.normal).toBe(ctl.pcb);
    expect(expected.normal).not.toBe(withoutLp.normal);
  });

  it('withdraws ∑LP when the form is deleted — a relief with no form behind it relieves nothing', async () => {
    const e = await payableEmployee('LP Withdrawn');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });
    expect(Number((await statRow(e.personId)).tp3Lp)).toBe(D_TOTAL);
    await deleteTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR });
    expect((await statRow(e.personId)).tp3Lp, 'cleared with the other four, not left behind').toBeNull();
  });

  it('refuses a Section-D-only form for a person with no statutory profile, instead of losing the money', async () => {
    const e = await hireEmployee(a, {
      person: { fullName: 'LP No Profile', primaryEmail: `lpnp_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: `${YEAR}-01-01`,
    });
    // Section D ALONE. Before this round it saved quietly, because Section D reached nothing and so had
    // nothing to lose; now it is money with nowhere to land.
    await expect(
      saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionD: SECTION_D }),
    ).rejects.toBeInstanceOf(Tp3Error);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · (b) NO SECTION D, AND (e) NO TP3 AT ALL — BOTH BYTE-IDENTICAL TO BEFORE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (b)/(e) · nothing declared changes nothing', () => {
  it('(b) a TP3 with an EMPTY Section D pays exactly what the same form without one pays', async () => {
    const absent = await payableEmployee('D Absent');
    const empty = await payableEmployee('D Empty');
    await saveTp3(adminCtx(b), { personId: absent.personId, assessmentYear: YEAR, sectionC: SECTION_C });
    await saveTp3(adminCtx(b), {
      personId: empty.personId,
      assessmentYear: YEAR,
      sectionC: SECTION_C,
      // Every line PRESENT and zero — the shape a screen submits when an operator fills none of them in.
      sectionD: { c5: { subItems: { a: 0, b: 0 } }, c8: { amount: 0 }, c12: { amount: 0 } },
    });
    const { st } = await runMonth(`${YEAR}-07`, ['D Absent', 'D Empty']);
    // THE WHOLE STATUTORY BLOCK, not just the PCB: a change anywhere in it is a change to the payslip.
    expect(st.get('D Empty')).toEqual(st.get('D Absent'));
    expect(st.get('D Empty')!.pcbMeta!.trace!.lpAccumulated).toBe(0);
  });

  it('(e) an employee with NO Form TP3 has a null tp3_lp and a ∑LP of zero', async () => {
    const none1 = await payableEmployee('No Form One');
    const none2 = await payableEmployee('No Form Two');
    expect((await statRow(none1.personId)).tp3Lp, 'the column is nullable and nothing wrote it').toBeNull();
    const { st } = await runMonth(`${YEAR}-07`, ['No Form One', 'No Form Two']);
    expect(st.get('No Form One')).toEqual(st.get('No Form Two'));
    expect(st.get('No Form One')!.pcbMeta!.trace!.lpAccumulated).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · (c) THE C2 EXEMPTION LIMITS — SHOWN AND WARNED, NEVER CAPPED, NEVER REFUSED
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (c) · each C2 sub-item carries its own sourced exemption limit', () => {
  /** The sourced limits, read back off the pack rather than restated here. */
  const c2 = () => TP3_SECTION_C.find((l) => l.code === 'c2')!;
  const limitOf = (sub: string) => c2().subItems.find((s) => s.code === sub)!.exemptionLimit ?? null;

  it('carries a limit for exactly the three lines the specification prints one for', () => {
    // SPECIFICATION PRINTED PAGE 21, "List of tax exempt allowances / perquisites / gifts / benefits
    // which are required to declare". The specification's roman numerals are its own and do NOT line up
    // with this form's, so each mapping is named.
    expect(limitOf('i'), "spec item i — petrol card / travelling allowance / toll, official duties").toBe(6000);
    expect(limitOf('ii'), 'spec item ii — child care allowance, children up to 12').toBe(3000);
    expect(limitOf('iv'), 'spec item v — past achievement / service excellence / long service > 10 years').toBe(2000);
    // ⚠️ NOT SOURCED, AND DELIBERATELY NOT INVENTED. The employer's-own-products line has no entry in
    // the specification's table at all, and "other" is a remainder covering entries whose limits are a
    // unit count, the actual amount expended, and a loan-interest formula. One number cannot stand in.
    expect(limitOf('iii'), 'no entry in the specification table — captured, never capped').toBeNull();
    expect(limitOf('v'), 'a remainder box — no single limit exists').toBeNull();
  });

  it('warns at ONE RINGGIT over and stays silent AT the limit, for every line that has one', async () => {
    for (const [sub, limit] of [
      ['i', 6000],
      ['ii', 3000],
      ['iv', 2000],
    ] as const) {
      const atLimit = {
        form: 'tp3-2026' as const,
        sectionC: { c2: { amount: limit, subItems: { [sub]: limit } } },
        sectionD: {},
      };
      expect(tp3ExemptionOverLimits(atLimit), `C2(${sub}) exactly AT RM${limit} is within its limit`).toEqual([]);

      const overBy1 = {
        form: 'tp3-2026' as const,
        sectionC: { c2: { amount: limit + 1, subItems: { [sub]: limit + 1 } } },
        sectionD: {},
      };
      expect(tp3ExemptionOverLimits(overBy1)).toEqual([
        { code: 'c2', subCode: sub, amount: limit + 1, limit, excess: 1 },
      ]);
    }
  });

  it('never warns on a line with no sourced limit, however large the figure', () => {
    const huge = {
      form: 'tp3-2026' as const,
      sectionC: { c2: { amount: 2_000_000, subItems: { iii: 1_000_000, v: 1_000_000 } } },
      sectionD: {},
    };
    expect(tp3ExemptionOverLimits(huge), 'ADR-0008 — no printed cap means nothing to check against').toEqual([]);
  });

  it('⚠️ DOES NOT CAP: an over-limit C2 is SAVED WHOLE and reaches the calculation whole', async () => {
    const e = await payableEmployee('C2 Over');
    // C2(ii) child-care at RM5,000 — RM2,000 over its RM3,000 limit.
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: { c1: { amount: 60000 }, c2: { subItems: { ii: 5000 } }, c3: { amount: 8979 } },
    });
    const row = await statRow(e.personId);
    // 60000 − 5000 − 8979. A capped ΣC2 would have produced 60000 − 3000 − 8979 = 48021 and taxed the
    // RM2,000 a second time: the previous employer already moved the over-limit part into C1 as taxable
    // pay (specification printed page 20, item 9). THIS ASSERTION IS THE DECISION, written down.
    expect(Number(row.tp3NetRemuneration)).toBe(46021);
    // …and the warning is raised, so the operator is told the form looks wrong even though nothing moved.
    const form = (await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId))
      .then((r) => r[0]))!;
    expect(tp3ExemptionOverLimits(form.payload)).toEqual([
      { code: 'c2', subCode: 'ii', amount: 5000, limit: 3000, excess: 2000 },
    ]);
  });

  it('the screen prints the limit and the note that says where it comes from', () => {
    const src = readFileSync(join(ROOT, 'app/payroll/transactions/tp3/page.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(src, 'the limit column reads the pack, never a literal on the screen').toMatch(
      /sub\.exemptionLimit == null \? t\('noLimit'\) : money\(sub\.exemptionLimit\)/,
    );
    expect(src).toMatch(/t\('tp3\.exemptLimitNote'\)/);
    expect(src).toMatch(/t\('tp3\.exemptOverLimit'/);
    for (const l of LOCALES) {
      const m = JSON.parse(readFileSync(join(ROOT, `messages/${l}.json`), 'utf8')) as {
        taxRelief: { tp3: Record<string, string> };
      };
      // The note must say the limits are NOT the form's, in every locale — that is the whole content of
      // the sentence, and a locale that lost it would tell an operator the form prints these figures.
      expect(m.taxRelief.tp3.exemptLimitNote, `${l} exemptLimitNote`).toBeTruthy();
      expect(m.taxRelief.tp3.exemptLimitNote).toContain('TP3');
      expect(m.taxRelief.tp3.exemptOverLimit).toContain('{limit}');
      expect(m.taxRelief.tp3.exemptOverLimit).toContain('{excess}');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · (d) C4(ii) IS STILL NOT ZAKAT
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (d) · the C4 split is unchanged', () => {
  it('Z is C4(i) alone; the Umrah / religious-travel levy in C4(ii) never reaches it', async () => {
    const e = await payableEmployee('C4 Split');
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: { ...SECTION_C, c4: { subItems: { i: 500, ii: 750 } } },
      sectionD: SECTION_D,
    });
    const row = await statRow(e.personId);
    // 500, not 1250. r335 decided this deliberately and item 20837372 does not revisit it — but a round
    // that added a FIFTH column beside these four is exactly when a copy-paste could have widened it.
    expect(Number(row.tp3ZakatPaid)).toBe(500);
    expect(Number(row.tp3Lp), 'and the levy did not leak into ∑LP either').toBe(D_TOTAL);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · (f) A FILED MONTH IS STILL REFUSED
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (f) · seeding ∑LP may not restate a month that has been filed', () => {
  it('records the form but REFUSES the run that would restate the filed month, and the payslip stands', async () => {
    const e = await payableEmployee('Filed LP');
    const period = `${YEAR}-05`;
    const first = await runMonth(period, ['Filed LP']);
    const before = first.st.get('Filed LP')!;
    expect(before.pcbMeta!.trace!.lpAccumulated, 'no form yet').toBe(0);

    // The month is filed with the agency.
    const [rep] = await owner.db
      .insert(schema.statutoryReport)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        jurisdiction: 'MY',
        reportType: 'my.cp39',
        periodKind: 'month',
        periodKey: period,
        status: 'draft',
        statutoryVersion: 'MY-2026.1',
        rowCount: 1,
        generatedBy: b.adminUserId,
      })
      .returning({ id: schema.statutoryReport.id });
    await markReportFiled(a, { reportId: rep.id, ackRef: 'LHDN-ACK-20837372', filedOn: `${YEAR}-06-10` });

    // THE FORM STILL SAVES. It is a record of fact the employee handed in, and refusing it would lose
    // the paper. What it may not do is reach back into a lodged return.
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: SECTION_C,
      sectionD: SECTION_D,
    });
    expect(Number((await statRow(e.personId)).tp3Lp)).toBe(D_TOTAL);

    // …and the run that WOULD restate the filed month is refused, by name.
    const err = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: period, runType: 'adjustment' }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(PeriodAlreadyFiledError);
    expect((err as PeriodAlreadyFiledError).message).toContain('LHDN-ACK-20837372');

    // THE ALREADY-FILED PAYSLIP HAS NOT MOVED. Read back from the database rather than from the object
    // returned before the save, so a silent rewrite would be visible.
    const after = (await batchDetail(a, first.batchId))!.slips.find((s) => s.name === 'Filed LP')!
      .statutory as unknown as SlipStatutory;
    expect(after.pcb, 'a filed month keeps the figure that was filed').toBe(before.pcb);
    expect(after.pcbMeta!.trace!.lpAccumulated).toBe(0);
  });

  /**
   * ⚠️ THERE ARE TWO GUARDS, NOT ONE, AND THE ARM ABOVE ONLY REACHES THE FIRST.
   *
   * `createAdditionalRun` refuses at creation; `generatePayslips` refuses again at `runSeq > 1`, and
   * that second one is the load-bearing half — a run CREATED before the filing and GENERATED after it
   * walks straight past the first check. Mutation-testing this file found the gap: deleting the
   * `generatePayslips` refusal left the arm above green, because it never reaches that line. So the
   * batch here is opened BEFORE the filing and generated AFTER it, which is the only order that puts a
   * newly seeded ∑LP in front of the second guard.
   */
  it('refuses at GENERATION too, for a run opened before the filing and generated after it', async () => {
    const e = await payableEmployee('Filed At Generate');
    const period = `${YEAR}-05`;
    await runMonth(period, ['Filed At Generate']);

    // Opened while the month was still unfiled — so the creation-time guard lets it through.
    const extra = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: period, runType: 'adjustment' });

    const [rep] = await owner.db
      .insert(schema.statutoryReport)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        jurisdiction: 'MY',
        reportType: 'my.cp39',
        periodKind: 'month',
        periodKey: period,
        status: 'draft',
        statutoryVersion: 'MY-2026.1',
        rowCount: 1,
        generatedBy: b.adminUserId,
      })
      .returning({ id: schema.statutoryReport.id });
    await markReportFiled(a, { reportId: rep.id, ackRef: 'LHDN-ACK-GEN-20837372', filedOn: `${YEAR}-06-10` });

    // The TP3 lands afterwards — exactly the sequence this round makes reachable for the first time.
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });

    const err = await generatePayslips(a, { batchId: extra.batchId }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err, 'the run that would restate a filed month must not generate').toBeInstanceOf(PeriodAlreadyFiledError);
    expect((err as PeriodAlreadyFiledError).message).toContain('LHDN-ACK-GEN-20837372');
  });

  it('a LATER unfiled month does pick the ∑LP up — which is the point of the fix', async () => {
    const e = await payableEmployee('Filed Then Later');
    const filedPeriod = `${YEAR}-05`;
    await runMonth(filedPeriod, ['Filed Then Later']);
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });
    const later = await runMonth(`${YEAR}-06`, ['Filed Then Later']);
    expect(later.st.get('Filed Then Later')!.pcbMeta!.trace!.lpAccumulated).toBe(D_TOTAL);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · (g) THE MONTH DROPDOWN STORES THE INTEGER THE TP1 SCREEN MATCHES ON
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 (g) · Deduction Month is a named dropdown over the same integer', () => {
  it('stores the integer, and the TP1 month page still matches on it', async () => {
    const e = await payableEmployee('Month Pick');
    // What the `<select>` submits is a STRING of the option value, which is what a FormData round-trip
    // gives the service. Six must come back as the number 6.
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: '6' as unknown as number,
      sectionC: SECTION_C,
    });
    const form = (await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId))
      .then((r) => r[0]))!;
    expect(form.deductionMonth).toBe(6);
    expect(typeof form.deductionMonth).toBe('number');

    // THE CONTRACT ACROSS BOTH FILES (§8). The TP1 month page compares a stored deductionMonth against
    // the URL's integer month; a dropdown whose value became a NAME would match nothing there, and the
    // declaration would silently stop opening on its own month.
    const tp1Src = readFileSync(join(ROOT, 'app/payroll/transactions/tp1/[year]/[month]/page.tsx'), 'utf8');
    expect(tp1Src).toMatch(/r\.deductionMonth === month/);
    const tp3Src = readFileSync(join(ROOT, 'app/payroll/transactions/tp3/page.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(tp3Src, 'a <select>, not a number box').toMatch(/<select\s[\s\S]*?name="deductionMonth"/);
    expect(tp3Src, 'the VALUE is the number; only the label is the month name').toMatch(
      /value=\{String\(m\.value\)\}/,
    );
    expect(tp3Src, 'names come from Intl in the request locale, not from the catalogue').toMatch(
      /new Intl\.DateTimeFormat\(await getLocale\(\), \{ month: 'long' \}\)/,
    );
  });

  it('keeps BLANK a distinct fact from January', async () => {
    const e = await payableEmployee('Month Blank');
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: '' as unknown as number,
      sectionC: SECTION_C,
    });
    const form = (await owner.db
      .select()
      .from(schema.employeeTp3)
      .where(eq(schema.employeeTp3.personId, e.personId))
      .then((r) => r[0]))!;
    expect(form.deductionMonth, 'left blank is null, never 1').toBeNull();
    const tp3Src = readFileSync(join(ROOT, 'app/payroll/transactions/tp3/page.tsx'), 'utf8');
    expect(tp3Src).toMatch(/<option value="">\{t\('tp3\.deductionMonthBlank'\)\}<\/option>/);
  });

  it('refuses a month outside 1–12 exactly as the number box did', async () => {
    const e = await payableEmployee('Month Bad');
    await expect(
      saveTp3(adminCtx(b), {
        personId: e.personId,
        assessmentYear: YEAR,
        deductionMonth: 13,
        sectionC: SECTION_C,
      }),
    ).rejects.toBeInstanceOf(Tp3Error);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 7b · EVERY OTHER WRITER OF THE ROW MUST LEAVE ∑LP ALONE
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `setStatutoryProfileMY` is a FULL OVERWRITE of `employee_statutory_my`, and two screens call it with
 * a whole object rebuilt from a form — the Personnel Bank & Statutory card and the Zakat election. Both
 * already carry explicit pass-throughs for the four TP3 columns, added after each of them silently
 * wiped something (the comments in `app/admin/personnel/[employmentId]/actions.ts` record it).
 *
 * ⚠️ A FIFTH COLUMN IS A FIFTH CHANCE TO BE WIPED, so `tp3_lp` is deliberately NOT in that setter's
 * write set at all — the same posture as the four custom-payment-holder columns, which that file's own
 * comment notes are "NOT in setStatutoryProfileMY's write set, so they are untouched here regardless".
 * That is stronger than a pass-through: a pass-through has to be remembered by every future caller.
 * This arm is what keeps it true, because the wipe it prevents is silent and only shows up as a PCB
 * figure that quietly went back up a month later.
 */
describe('20837372 · a full-row statutory save does not wipe ∑LP', () => {
  it('leaves tp3_lp standing when the whole statutory row is rewritten', async () => {
    const e = await payableEmployee('No Wipe');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });
    const before = await statRow(e.personId);
    expect(Number(before.tp3Lp)).toBe(D_TOTAL);

    // Exactly what the Personnel / Zakat screens do: rebuild the row and pass the four TP3 figures back
    // through. Nothing hands `tp3Lp` over, because the setter has no such field.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: before.icNumber,
      taxCategory: 3,
      numChildren: 3,
      tp3Year: before.tp3Year,
      tp3NetRemuneration: Number(before.tp3NetRemuneration),
      tp3EpfClaimed: Number(before.tp3EpfClaimed),
      tp3PcbPaid: Number(before.tp3PcbPaid),
      tp3ZakatPaid: Number(before.tp3ZakatPaid),
    });

    const after = await statRow(e.personId);
    expect(Number(after.tp3Lp), 'a statutory save must not quietly put the PCB back up').toBe(D_TOTAL);
    // …and the setter genuinely has no field for it, so no future caller can be asked to remember one.
    const setter = readFileSync(join(ROOT, 'localization/my/statutory.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(setter, 'core/tp3.ts is the ONLY writer of tp3_lp').not.toMatch(/tp3Lp/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · THE MIGRATION'S OWN BACKFILL — the shipped SQL, run against rows it is meant to find
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe('20837372 · migration 0488 backfill', () => {
  /** The UPDATE exactly as it ships. Read out of the file so the test cannot drift from the migration. */
  const backfillSql = () => {
    const file = readFileSync(join(ROOT, 'db/migrations/0488_tp3_section_d_lp.sql'), 'utf8');
    const stmts = file
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);
    const update = stmts.find((x) => x.toUpperCase().startsWith('UPDATE'));
    if (!update) throw new Error('migration 0488 no longer contains an UPDATE — the backfill is the point');
    return update;
  };

  it('restores tp3_lp from the stored Section D for a form whose year holds the columns', async () => {
    const e = await payableEmployee('Backfill Me');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });
    // The pre-migration state: the form is stored, the column is empty.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ tp3Lp: null })
      .where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect((await statRow(e.personId)).tp3Lp).toBeNull();

    await owner.db.execute(sql.raw(backfillSql()));
    expect(Number((await statRow(e.personId)).tp3Lp), 'the same total deriveAccumulatorSeed computes').toBe(D_TOTAL);
  });

  it('leaves a row alone when tp3_year is NOT the form’s year — those columns came from elsewhere', async () => {
    const e = await payableEmployee('Backfill Skip');
    await saveTp3(adminCtx(b), { personId: e.personId, assessmentYear: YEAR, sectionC: SECTION_C, sectionD: SECTION_D });
    // A hand-keyed opening balance for a DIFFERENT year now holds the columns.
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ tp3Lp: null, tp3Year: YEAR - 1 })
      .where(eq(schema.employeeStatutoryMy.personId, e.personId));

    await owner.db.execute(sql.raw(backfillSql()));
    expect(
      (await statRow(e.personId)).tp3Lp,
      'seeding ∑LP from a payload that did not produce the other four would assemble one accumulator from two sources',
    ).toBeNull();
  });
});
