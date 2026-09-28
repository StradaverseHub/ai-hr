/**
 * 1785b766 — THE ANNUAL PCB EXEMPTION IS PER EMPLOYEE PER CODE, AND THE TP3 SPENDS IT FIRST.
 *
 * ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `core/payroll.ts` computes each pay item's exemption headroom as
 *
 *     roomFor(code, cap) = cap − priorUsed[code] − exemptionUsed[code]
 *
 * and `priorUsed` was built by replaying THIS employer's issued payslips only. The caps are annual per
 * EMPLOYEE (`MY_PCB_EXEMPTION_CODES`'s own header says so), so a person who joined in July having
 * already spent the whole RM6,000 travel exemption at their old job arrived here with a fresh RM6,000:
 * one annual exemption granted twice, and too little MTD taken every month for the rest of the year.
 *
 * Form TP3 Section C2 is exactly that figure and we had been storing it since item df35d60d. Migration
 * 0489 gives it a column, `deriveAccumulatorSeed` maps each box onto the exemption code it draws on, and
 * the ledger now OPENS with it.
 *
 * ══ WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ══════════════════════════════════════════
 *
 * Every ringgit below is either the reporter's own worked example or is derived from the catalogue at
 * runtime. NO LIMIT IS WRITTEN AS A LITERAL IN AN ASSERTION: §1 reads the cap out of
 * `MY_PCB_EXEMPTION_CODES` and the arithmetic arms compute against that, so this file cannot be the
 * place a wrong statutory figure gets pinned. CLAUDE.md §8.
 *
 * ⚠️ THE HEADROOM ARM'S NON-VACUITY IS A DIFFERENTIAL, NOT AN EQUALITY. The subject (a TP3 that spent
 * the whole cap) is measured against a CONTROL employee who is identical in every way except that they
 * handed in no form. Delete the seeding block in `core/payroll.ts` and the two arms become byte-identical
 * — which is what `not.toBe` in §3.1 fails on. An assertion that only said "the subject got 0" would
 * also pass if the pay item had simply never been resolved.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY, setTp3ProfileMY } from '../localization/my/statutory';
import { deriveAccumulatorSeed, deleteTp3, saveTp3, TP3_SECTION_C } from '../core/tp3';
import { createBatch, generatePayslips, preProcessAdvisory, PreProcessBlockedError } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { MY_PCB_EXEMPTION_CODES } from '../localization/my/statutory-tables';
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

const ROOT = join(__dirname, '..');
const YEAR = 2026;

/** The three mapped C2 sub-lines, named ONCE. The caps themselves are never written here. */
const MAPPING = [
  { sub: 'i', code: 'PCB_TRA_BUSINESS', what: 'travel / petrol card / petrol / toll for official duties' },
  { sub: 'ii', code: 'PCB_CHILD_CARE', what: 'child-care allowance' },
  { sub: 'iv', code: 'PCB_PERQUISITE', what: 'past-service / excellent-service / long-service awards' },
] as const;
/** The two that map to NOTHING, and the reason each one does. */
const UNMAPPED = [
  { sub: 'iii', why: 'no entry in the specification’s printed-page-21 table' },
  { sub: 'v', why: 'a remainder over entries with different limit SHAPES' },
] as const;

const c2Sub = (code: string) => TP3_SECTION_C.find((l) => l.code === 'c2')!.subItems.find((s) => s.code === code)!;
/** The travel cap, READ from the table the mapping points at — never a literal in this file. */
const TRAVEL_CAP = MY_PCB_EXEMPTION_CODES.PCB_TRA_BUSINESS;

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE DE-DUPLICATION GUARD — one owner of one statutory fact (CLAUDE.md §1)
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Until this item the TP3 catalogue carried LITERAL limits — 6,000 / 3,000 / 2,000 — beside the
 * identical three entries in `MY_PCB_EXEMPTION_CODES` in the same file. Two owners of one fact, and once
 * the TP3 and the payroll ledger started spending ONE cap between them, a drift between the copies would
 * have meant the two halves of a year disagreeing about the same ringgit. These arms fail if a literal
 * comes back, if a mapping points at a code the table does not have, or if either side moves alone.
 */
describe('1785b766 §1 · the TP3’s C2 limits ARE the mapped exemption codes’ caps', () => {
  for (const m of MAPPING) {
    it(`C2(${m.sub}) — ${m.what} — maps to ${m.code} and takes its cap from it`, () => {
      const sub = c2Sub(m.sub);
      expect(sub.exemptionCode).toBe(m.code);
      // The code must EXIST in the table. A typo (the ticket itself wrote `PCB_CHILS_CARE`) would make
      // the limit undefined, which silently turns a capped box into an uncapped one.
      expect(Object.keys(MY_PCB_EXEMPTION_CODES)).toContain(m.code);
      const cap = MY_PCB_EXEMPTION_CODES[m.code];
      expect(typeof cap, `${m.code} must resolve to a number, not undefined`).toBe('number');
      expect(sub.exemptionLimit, 'the form line and the payroll cap are ONE figure').toBe(cap);
    });
  }

  for (const u of UNMAPPED) {
    it(`C2(${u.sub}) maps to NOTHING and asserts no limit — ${u.why}`, () => {
      const sub = c2Sub(u.sub);
      expect(sub.exemptionCode ?? null, 'UNKNOWN is written down as UNKNOWN, never guessed').toBeNull();
      expect(sub.exemptionLimit ?? null, 'an absent box asserts nothing (CLAUDE.md §8)').toBeNull();
    });
  }

  it('PCB_COMPANY_PROD is wired to NO sub-line — its RM1,000 is verified against no source we hold', () => {
    // It exists in the code table and looks like C2(iii)'s subject from another document. Wiring it would
    // net RM1,000 of a real annual exemption off a real employee on an unverified figure.
    expect(Object.keys(MY_PCB_EXEMPTION_CODES)).toContain('PCB_COMPANY_PROD');
    const mapped = TP3_SECTION_C.flatMap((l) => l.subItems).map((s) => s.exemptionCode ?? null);
    expect(mapped, 'RATE-ONLY: do not wire an unverified cap to a form line').not.toContain('PCB_COMPANY_PROD');
  });

  it('carries no numeric exemptionLimit literal anywhere in the catalogue source', () => {
    // A guard that can be satisfied by a comment is not a guard, so the file is read comment-stripped —
    // the same technique test/1bb09a73-tp3-pcb-sync.test.ts uses on the mapping's single owner.
    const src = readFileSync(join(ROOT, 'localization/my/statutory-tables.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    // `exemptionLimit: <number>` is the shape that was duplicated. `exemptionLimit: null` and the
    // derivation inside `tp3C2Sub` (`exemptionLimit: limit`) are both fine.
    expect(src, 'a re-introduced literal is a second owner of a statutory fact').not.toMatch(
      /exemptionLimit:\s*\d/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE SEED — which code each box spends, and how much of it
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const seedOfWith = (c1: number, c2: Record<string, number>) =>
  deriveAccumulatorSeed({
    form: 'tp3-2026',
    sectionC: {
      c1: { amount: c1 },
      c2: { amount: Object.values(c2).reduce((a, x) => a + x, 0), subItems: c2 },
    },
    sectionD: {},
  })!;
/** The ordinary shape: taxable pay in C1 alongside the C2 boxes. */
const seedOf = (c2: Record<string, number>) => seedOfWith(60_000, c2);

describe('1785b766 §2 · deriveAccumulatorSeed splits ΣC2 by exemption code', () => {
  it('attributes each mapped box to its own code, and leaves the unmapped ones out entirely', () => {
    const s = seedOf({ i: 1_000, ii: 500, iii: 5_000, iv: 250, v: 9_000 });
    expect(s.exemptionUsed).toEqual({ PCB_TRA_BUSINESS: 1_000, PCB_CHILD_CARE: 500, PCB_PERQUISITE: 250 });
  });

  it('records the EXEMPT part, not the keyed amount — the over-limit excess is taxed instead (r350)', () => {
    const over = TRAVEL_CAP + 1_000;
    const s = seedOf({ i: over });
    // Capped at the cap: the part above it was never exempt, so it cannot have spent exemption headroom…
    expect(s.exemptionUsed).toEqual({ PCB_TRA_BUSINESS: TRAVEL_CAP });
    // …and r350 already adds it to ∑(Y−K) as taxable pay. Charging it BOTH ways — taxing it here and
    // denying this employer's own allowance for it — would tax the same ringgit twice.
    expect(s.excessTotal, 'the same ringgit, taxed exactly once').toBe(1_000);
  });

  it('an all-zero or absent C2 spends nothing', () => {
    expect(seedOf({}).exemptionUsed).toEqual({});
    expect(seedOf({ i: 0 }).exemptionUsed, 'zero is not a measurement — the key is absent').toEqual({});
  });

  it('a legacy payload with an amount but no sub-lines attributes nothing, rather than guessing', () => {
    // `readGroup` cannot produce this shape, but a hand-built or pre-sub-line payload can. It says
    // nothing about WHICH exemption the money used, and attributing it by guess would net a real cap off.
    const s = deriveAccumulatorSeed({
      form: 'tp3-2026',
      sectionC: { c1: { amount: 1_000 }, c2: { amount: 900 } },
      sectionD: {},
    })!;
    expect(s.exemptionUsed).toEqual({});
    expect(s.exemptTotal, 'the stored amount still stands for the TOTAL (20837372)').toBe(900);
  });

  it('AMENDING REPLACES, IT NEVER ACCUMULATES — 2,000 amended to 2,500 is 2,500, not 4,500', () => {
    // The reporter's Expected Function point 5. There is no mechanism behind it: the seed is DERIVED from
    // the one TP3 row per person per year and the column is rewritten whole, so there is nothing to add to.
    expect(seedOf({ i: 2_000 }).exemptionUsed).toEqual({ PCB_TRA_BUSINESS: 2_000 });
    expect(seedOf({ i: 2_500 }).exemptionUsed).toEqual({ PCB_TRA_BUSINESS: 2_500 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE LEDGER — the figure reaches a payroll run and takes the headroom with it
// ════════════════════════════════════════════════════════════════════════════════════════════════════

let b: Base;
let a: SessionContext;

const TRAVEL = 'TRAVELALLOW';
const componentInput = (code: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code,
  name: `${code} component`,
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  // NOT prorated, so every figure below is the exact keyed amount and a mid-year joiner's month is not
  // also a proration test. The exemption ledger is what is under test.
  prorates: false,
  ...over,
});

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

/** An employee who can be paid, with the travel allowance attached at `travel` ringgit a month. */
async function payable(name: string, opts: { hiredOn?: string; travel?: number; basic?: number } = {}) {
  const hiredOn = opts.hiredOn ?? `${YEAR}-01-01`;
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `exempt_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: `9001${String(Math.floor(Math.random() * 90_000_000 + 10_000_000))}`,
    taxCategory: 1,
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: opts.basic ?? 5_000,
    monthlyAllowance: 0,
    effectiveFrom: hiredOn,
  });
  await setEmploymentPayComponent(a, {
    employmentId: e.employmentId,
    componentId: await idByCode('BASIC'),
    amount: opts.basic ?? 5_000,
    effectiveFrom: hiredOn,
  });
  if (opts.travel != null) {
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await idByCode(TRAVEL),
      amount: opts.travel,
      effectiveFrom: hiredOn,
    });
  }
  return e;
}

/** How much of `code` this month's slip actually exempted. Absent ⇒ 0: no headroom was taken. */
async function exemptedOn(batchId: string, employmentId: string, code = 'PCB_TRA_BUSINESS') {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  const slip = rows.find((r) => r.employmentId === employmentId)!;
  const st = slip.statutory as { exemptionUsed?: Record<string, number>; epfEmployee?: number };
  return { used: Number(st.exemptionUsed?.[code] ?? 0), epfEmployee: Number(st.epfEmployee ?? 0) };
}

/** The stored opening balance, as the kernel reads it. */
async function statOf(personId: string) {
  const row = await owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId))
    .then((r) => r[0]);
  return row.tp3ExemptionUsed;
}

async function run(payPeriod: string) {
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod });
  await generatePayslips(a, { batchId: batch.batchId });
  return batch.batchId;
}

/** The TP3 as HR keys it: one C2 sub-line, the previous employer's exempt travel money. */
const travelForm = (personId: string, amount: number, assessmentYear = YEAR) => ({
  personId,
  assessmentYear,
  sectionC: { c1: { amount: 30_000 }, c2: { subItems: { i: amount } } },
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = adminCtx(b);
  await seedPayComponentCatalog(a);
  await upsertPayComponent(a, componentInput(TRAVEL, { pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TRA_BUSINESS' }));
});

/** The typed pay-component entitlement, re-resolved: the exemption ledger only exists on that path. */
const enableTypedComponents = async () => {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(b);
};

describe('1785b766 §3 · the previous employer’s usage opens this employer’s ledger', () => {
  it('3.1 a mid-year joiner who spent the WHOLE travel cap elsewhere gets ZERO headroom here', async () => {
    const subject = await payable('Joined July With Form', { hiredOn: `${YEAR}-07-01`, travel: 1_000 });
    const control = await payable('Joined July No Form', { hiredOn: `${YEAR}-07-01`, travel: 1_000 });
    // The whole RM6,000 already used at the previous employer, read from the catalogue.
    await saveTp3(a, travelForm(subject.personId, TRAVEL_CAP));

    await enableTypedComponents();
    const batchId = await run(`${YEAR}-07`);
    const s = await exemptedOn(batchId, subject.employmentId);
    const c = await exemptedOn(batchId, control.employmentId);

    expect(s.used, 'the annual cap is spent — there is nothing left to exempt').toBe(0);
    // NON-VACUITY. The control proves the pay item really was resolved and really can be exempted, so a
    // zero on the subject is the TP3 doing work rather than the arm doing nothing. Remove the seeding
    // block from core/payroll.ts and these two become equal, and this line fails.
    expect(c.used, 'the same pay item, with no form behind it, is exempt in full').toBe(1_000);
    expect(s.used).not.toBe(c.used);
    // …and the money is therefore IN the statutory bases for the subject and OUT of them for the control,
    // which is the tax the defect was losing. Derived, not a written-down LHDN figure.
    expect(s.epfEmployee).toBeGreaterThan(c.epfEmployee);
  });

  it('3.2 the reporter’s own example: TP3 2,000 + a 1,500 pay item = 3,500 of 6,000, leaving 2,500', async () => {
    const e = await payable('Reporter Example', { hiredOn: `${YEAR}-07-01`, travel: 1_500 });
    await saveTp3(a, travelForm(e.personId, 2_000));
    await enableTypedComponents();

    // July: 6,000 − 2,000 already spent = 4,000 of headroom, so the whole 1,500 is exempt.
    const july = await run(`${YEAR}-07`);
    expect((await exemptedOn(july, e.employmentId)).used).toBe(1_500);

    // The reporter's "leaving 2,500" is not a stored number anywhere — it is what the NEXT month can
    // still exempt. Ask the ledger for it by offering it more than that: a 3,000 claim in August must be
    // exempted to exactly 6,000 − 2,000 − 1,500.
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await idByCode(TRAVEL),
      amount: 3_000,
      effectiveFrom: `${YEAR}-08-01`,
    });
    const august = await run(`${YEAR}-08`);
    expect((await exemptedOn(august, e.employmentId)).used, 'the remaining headroom, to the ringgit').toBe(
      TRAVEL_CAP - 2_000 - 1_500,
    );
  });

  it('3.3 amending the form from 2,000 to 2,500 totals 4,000 of the cap, NOT 4,500', async () => {
    const e = await payable('Amended Form', { hiredOn: `${YEAR}-07-01`, travel: 1_500 });
    await saveTp3(a, travelForm(e.personId, 2_000));
    await enableTypedComponents();
    const july = await run(`${YEAR}-07`);
    expect((await exemptedOn(july, e.employmentId)).used).toBe(1_500);

    // HR corrects the paper form. The same person, the same year, so the SAME row is replaced.
    await saveTp3(a, travelForm(e.personId, 2_500));
    expect(await statOf(e.personId), 'replaced whole, never appended to').toEqual({ PCB_TRA_BUSINESS: 2_500 });

    // 2,500 (form) + 1,500 (July, already issued) = 4,000 spent, so 2,000 remains — not 1,500, which is
    // what a form that had ACCUMULATED to 4,500 would leave.
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: await idByCode(TRAVEL),
      amount: 3_000,
      effectiveFrom: `${YEAR}-08-01`,
    });
    const august = await run(`${YEAR}-08`);
    expect((await exemptedOn(august, e.employmentId)).used).toBe(TRAVEL_CAP - 2_500 - 1_500);
  });

  it('3.4 reprocessing the same month consumes the previous employer’s exemption exactly once', async () => {
    // Expected Function point 9. The column is read and never written back by a run, so this is a property
    // of the design rather than of a guard — which is exactly why it is worth pinning.
    const e = await payable('Reprocessed', { hiredOn: `${YEAR}-07-01`, travel: 1_000 });
    await saveTp3(a, travelForm(e.personId, 2_000));
    await enableTypedComponents();
    const columnBefore = await statOf(e.personId);
    const first = await run(`${YEAR}-07`);
    const before = await exemptedOn(first, e.employmentId);
    // ⚠️ REPROCESS, NOT RE-GENERATE. A second bare `generatePayslips` on the same batch throws
    // BatchNotDraftError (core/payroll.ts:3372) — the batch is `processed` by then, and the first cut of
    // this test died there. `reprocessSubset` is the path the product actually uses to re-run one
    // employee on a processed batch, so it is the path this property has to hold on.
    await generatePayslips(a, { batchId: first, reprocessSubset: { employmentIds: [e.employmentId] } });
    const after = await exemptedOn(first, e.employmentId);
    expect(after).toEqual(before);
    expect(after.used).toBe(1_000);
    // The mechanism itself, stated directly: two runs and the opening balance has not moved, because
    // nothing in the kernel writes it. That is why there is no double-count to de-duplicate.
    expect(await statOf(e.personId)).toEqual(columnBefore);
    expect(columnBefore, 'and it was not empty, so this is not a vacuous equality').toEqual({
      PCB_TRA_BUSINESS: 2_000,
    });
  });

  it('3.5 deleting the form releases the headroom it was holding', async () => {
    // Expected Function point 10, by the same single path — no separate mechanism.
    const e = await payable('Deleted Form', { hiredOn: `${YEAR}-07-01`, travel: TRAVEL_CAP });
    await saveTp3(a, travelForm(e.personId, TRAVEL_CAP));
    await enableTypedComponents();
    expect((await exemptedOn(await run(`${YEAR}-07`), e.employmentId)).used).toBe(0);

    await deleteTp3(a, { personId: e.personId, assessmentYear: YEAR });
    expect(await statOf(e.personId), 'cleared with the other five, not left behind').toBeNull();
    expect((await exemptedOn(await run(`${YEAR}-08`), e.employmentId)).used).toBe(TRAVEL_CAP);
  });

  it('3.6 a form for a DIFFERENT assessment year takes no headroom — the tp3Applies gate', async () => {
    // The caps are annual, so each tax year starts clean. Nothing resets anything: the gate is
    // `tp3Year === pYear`, the same test the five money columns ride, and a form for another year fails it.
    const e = await payable('Prior Year Form', { hiredOn: `${YEAR}-01-01`, travel: 1_000 });
    await saveTp3(a, travelForm(e.personId, TRAVEL_CAP, YEAR - 1));
    await enableTypedComponents();
    const batchId = await run(`${YEAR}-01`);
    expect((await exemptedOn(batchId, e.employmentId)).used, 'last year’s spending is last year’s').toBe(1_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE YEAR-MISMATCH BLOCKER MUST SEE THIS MONEY TOO
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The `tp3YearMismatch` blocker (item 1bb09a73) refuses a run when a Form TP3 for the pay year declares
 * money while the columns the kernel reads carry a DIFFERENT year — the one divergence whose consequence
 * is a silent zero on a statutory figure. Its money test was net / epf / pcb / zakat / ∑LP.
 *
 * ⚠️ A FORM WHOSE ONLY MONEY IS AN EXEMPT C2 ALLOWANCE SCORES ZERO ON ALL FIVE. C1 carries only taxable
 * pay, so an in-limit C2 adds no excess (r350) and ∑(Y−K) is 0; there is no EPF, MTD, zakat or Section D.
 * Yet that form now spends the employee's annual exemption headroom, so a year mismatch on it hands them
 * a second full set of exemptions with nothing reported. The gate has to be as wide as the kernel.
 */
describe('1785b766 §4 · a C2-only form is money, so the year-mismatch gate must fire on it', () => {
  /** C2(i) only: no C1, no C3, no C5, no Section D — every pre-1785b766 money test scores zero. */
  const c2Only = (personId: string) => ({
    personId,
    assessmentYear: YEAR,
    sectionC: { c2: { subItems: { i: 2_000 } } },
  });

  it('the seed really does score zero on all five older figures (so this arm is not vacuous)', () => {
    // ⚠️ C1 = 0 IS LOAD-BEARING AND THE FIRST CUT OF THIS TEST MISSED IT. `seedOf` defaults C1 to 60,000,
    // which made the arm fail with [60000, 0, 0, 0, 0, 0] — and that failure is worth recording, because
    // it narrows the claim above it. A C2-only form scores zero on the five older figures only when C1 is
    // ALSO zero; with any taxable pay, `netRemuneration` is non-zero and the old gate already fired. The
    // form this widening exists for is the one whose previous employer paid nothing but exempt
    // allowances, which is exactly the `c2Only` fixture used by the two cases below.
    const s = seedOfWith(0, { i: 2_000 });
    expect([s.netRemuneration, s.epfClaimed, s.pcbPaid, s.zakatPaid, s.lpDeclared, s.excessTotal]).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(s.exemptionUsed, 'and yet it spends RM2,000 of an annual cap').toEqual({ PCB_TRA_BUSINESS: 2_000 });
  });

  it('names the employee as a BLOCKER and refuses the run', async () => {
    const e = await payable('C2 Only Mismatch', { travel: 1_000 });
    await saveTp3(a, c2Only(e.personId));
    // A hand edit on the Payroll tab moves the columns off the form's year — the production shape.
    await setTp3ProfileMY(a, { personId: e.personId, tp3Year: YEAR - 1, tp3NetRemuneration: 1 });
    await enableTypedComponents();
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    const advisory = await preProcessAdvisory(a, batch.batchId);
    expect(advisory.tp3YearMismatch?.map((r) => r.employmentId)).toEqual([e.employmentId]);
    await expect(generatePayslips(a, { batchId: batch.batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
  });

  it('does NOT fire for a C2 line that maps to no exemption code — the gate is not wider than the kernel', async () => {
    // C2(iii) has no exemption code, so it reaches no calculation and a year mismatch drops nothing.
    // Blocking a payroll run over it would be a false refusal, which is its own kind of wrong.
    const e = await payable('C2 Unmapped Mismatch', { travel: 1_000 });
    await saveTp3(a, { personId: e.personId, assessmentYear: YEAR, sectionC: { c2: { subItems: { iii: 9_000 } } } });
    await setTp3ProfileMY(a, { personId: e.personId, tp3Year: YEAR - 1, tp3NetRemuneration: 1 });
    await enableTypedComponents();
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-06` });
    expect((await preProcessAdvisory(a, batch.batchId)).tp3YearMismatch).toEqual([]);
  });
});
