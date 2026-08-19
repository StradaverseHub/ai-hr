/**
 * 7ad37961 — the LHDN TP1 (1/2026) e-form: C1–C17, Section D rebate, Section E declaration, Section F
 * employer consent, and the approval gate on the payroll feed. ADR-0081.
 *
 * WHAT IS WORTH TESTING HERE, AND WHY EACH CASE EXISTS.
 *
 * 1. THE CATALOGUE FIGURES ARE THE PRODUCT. Seventeen items with annual limits is a table of statutory
 *    numbers on a live payroll; a transcription slip is a wrong-figure defect that no other check can
 *    see, because every wrong number type-checks. Section A below pins every limit against the agency's
 *    own form, including the two the approved plan did not carry — C11's RM7,000 GROUP limit (the plan
 *    recorded only its RM4,000/RM3,000 sub-limits) and C15's RM2,500 (the plan expected it unsourced).
 *
 * 2. THE PCB ARITHMETIC MUST NOT MOVE. The whole item promised the monthly deduction is untouched. The
 *    byte-stability case is therefore re-pointed at the C1–C17 shape rather than deleted: a catalogue
 *    breakdown summing to X must feed the identical figure a scalar X does, to the cent.
 *
 * 3. THE OVER-CLAIM REFUSAL IS THE REPORTER'S OWN REQUEST — "the system stops an over-claim before
 *    payroll ever sees it" — and it is only interesting ACROSS declarations, which is where a per-request
 *    check would pass and the year would still be over.
 *
 * 4. REBATES ARE NOT DEDUCTIONS. Section D reduces tax, not chargeable income. If a rebate ever reached
 *    `tp1_amount`, every affected employee's MTD would move silently. That is one assertion and it is
 *    worth more than most of this file.
 *
 * 5. RULE 17 AND SECTION E. A hidden input is always submitted, so a tick read by presence is always
 *    true. The reader is exercised through real FormData, both ways.
 *
 * NOT RE-LITIGATED HERE: the ?employmentId= scope guard (test/tp1-scope-guard.test.ts), the screen's
 * shape (test/tp1-relief-redesign.test.ts), and the admin-on-behalf gate (test/tp1-admin-on-behalf.test.ts).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, prefillTp1FromSelfRelief, setPayrollInput } from '../core/payroll';
import {
  approveTp1ForPerson,
  cancelTp1ForPerson,
  getTp1ByIdForPerson,
  getTp1ForPerson,
  getTp1AccumulatedForPerson,
  getLatestApprovedTp1,
  listTp1DeclarationsForPersonYear,
  rejectTp1ForPerson,
  submitTp1ForPerson,
  TaxReliefError,
  TP1_ITEMS,
  TP1_REBATES,
} from '../core/tax-relief';
import { readTp1FormInput } from '../lib/tp1-form-input';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const YEAR = 2026;
const ROOT = path.resolve(__dirname, '..');

/**
 * Build a catalogue payload the way the form does.
 *
 * `{ c9: 400 }` — a single-box item, so the figure is the item's own amount.
 * `{ c5: 400 }` — an item the form gives LETTERED boxes to, so a bare number is placed in its FIRST
 *                 sub-line. Writing `{ amount: 400 }` there would be a lie about how the form works:
 *                 the server recomputes an item's amount from its sub-lines and IGNORES a client-sent
 *                 item total, exactly as it ignores a client-sent grand total. A helper that hid that
 *                 would let a test pass against a shape the real form can never produce.
 * `{ c1: { c: 250 } }` — explicit sub-lines, when which one matters.
 */
function payload(items: Record<string, number | Record<string, number>>, rebates: Record<string, Record<string, number>> = {}) {
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
  return { form: 'tp1-2026', items: shape(items), rebates: shape(rebates) };
}

describe('LHDN TP1 (1/2026) — the full e-form', () => {
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

  const hire = (name: string, email: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  async function employeeCtx(personId: string): Promise<SessionContext> {
    const uid = await createAppUser(base.tenantId, personId, 'employee');
    return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
  }

  async function inputRow(batchId: string, employmentId: string) {
    const [row] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
    return row;
  }

  /** Submit a catalogue declaration on behalf, with Section E ticked. */
  const submit = (
    admin: SessionContext,
    personId: string,
    p: { deductionMonth?: number; items?: Parameters<typeof payload>[0]; rebates?: Parameters<typeof payload>[1] },
  ) =>
    submitTp1ForPerson(admin, {
      personId,
      assessmentYear: YEAR,
      deductionMonth: p.deductionMonth,
      declarationAccepted: true,
      categories: payload(p.items ?? {}, p.rebates ?? {}),
    });

  // ═══════════════════ A. The catalogue: the agency's own figures ═══════════════════

  describe('the catalogue transcribes the agency form, and lives in the pack', () => {
    const byCode = () => Object.fromEntries(TP1_ITEMS.map((i) => [i.code, i]));

    it('carries C1–C17 in the form’s own order', () => {
      expect(TP1_ITEMS.map((i) => i.code)).toEqual(
        Array.from({ length: 17 }, (_, i) => `c${i + 1}`),
      );
      expect(TP1_REBATES.map((i) => i.code)).toEqual(['d1']);
    });

    // Every ANNUAL LIMIT (RM) the form prints, item by item. A wrong number here is a wrong deduction on
    // somebody's payslip, and it is the only check that can catch a transcription slip.
    it('carries the annual limit the form prints against each item', () => {
      expect(Object.fromEntries(TP1_ITEMS.map((i) => [i.code, i.limit]))).toEqual({
        c1: 8000,
        c2: 6000,
        c3: 7000,
        c4: 10000,
        c5: 2500,
        c6: 1000,
        c7: 1000,
        c8: 3000,
        c9: 8000,
        c10: 4000,
        // ⚠️ 7,000, and NOT 4,000/3,000 alone. The approved plan recorded only C11's two sub-limits; the
        // agency's form prints a GROUP limit of 7,000 against the brace joining them. Without this, an
        // employee could claim 4,000 + 3,000 = 7,000 with no group check — which happens to be right —
        // but also 4,000 + 3,000 against a limit nobody had encoded.
        c11: 7000,
        c12: 3000,
        c13: 4000,
        c14: 350,
        // ⚠️ 2,500. The plan expected this one to be unsourced and to ship as null; the form prints it.
        c15: 2500,
        // C16 has NO group limit: each house-price band carries its own, with its own Current/Accumulated
        // row on the form. That is `perSubLimit`, not a null we failed to source.
        c16: null,
        c17: 1000,
      });
      expect(byCode().c16.perSubLimit).toBe(true);
    });

    it('carries the printed "(Limited RM…)" sub-limits, and NOTHING it cannot cite', () => {
      const subs = Object.fromEntries(
        TP1_ITEMS.filter((i) => i.subItems.length).map((i) => [
          i.code,
          Object.fromEntries(i.subItems.map((sub) => [sub.code, sub.limit])),
        ]),
      );
      expect(subs).toEqual({
        c1: { a: null, b: null, c: 1000 },
        c3: { a: null, b: null, c: 2000 },
        c4: { a: null, b: null, c: 1000, d: 1000, e: 1000, f: 10000 },
        c5: { a: null, b: null, c: null, d: null },
        c6: { a: null, b: null, c: null, d: null },
        c11: { a: 4000, b: 3000 },
        c16: { a: 7000, b: 5000 },
      });
      // Section D prints no annual limit against either line — a rebate is not capped on this form.
      expect(TP1_REBATES[0].subItems.map((s) => s.limit)).toEqual([null, null]);
    });

    // ADR-0008 applies to what we PRINT as much as to what we CHECK. A frequency rule the form states in
    // words is captured and shown; it is deliberately not enforced (we do not hold the claim history
    // that would take), and the catalogue is where that decision is visible.
    it('captures the frequency rules the form states in words', () => {
      const c = byCode();
      expect(c.c7.frequency).toBe('onceEveryTwoYears');
      expect(c.c15.frequency).toBe('compostingThreeYearsShredderCctvTwoYears');
      expect(TP1_REBATES[0].subItems.find((s) => s.code === 'b')!.frequency).toBe('twoClaimsLifetime');
    });

    // THE FIGURES MOVE IN ONE PLACE. The legacy eight-key help text embedded "RM 9,000" in six message
    // catalogues; the C1–C17 strings must not repeat that, or a Budget change means seven edits and six
    // chances to miss one.
    it('states no ringgit limit in any message catalogue', () => {
      for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
        const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
        const text = JSON.stringify([m.taxRelief.items, m.taxRelief.rebates]);
        // House PRICE bands (C16 a/b) are eligibility criteria, not the relief limit, and the form states
        // them in the description itself — they are the one legitimate RM figure in these strings.
        const offenders = text.match(/RM\s?[\d,]+/g)?.filter((v) => !/RM\s?(500,000|750,000)/.test(v)) ?? [];
        expect(offenders, `${loc} restates a statutory limit in prose`).toEqual([]);
      }
    });
  });

  // ═══════════════════ B. Limits, accumulation and the refusal ═══════════════════

  it('refuses a claim over an item’s annual limit, naming the shortfall', async () => {
    const admin = adminCtx(base);
    const e = await hire('Over', 'over@acme.test');
    await expect(submit(admin, e.personId, { deductionMonth: 1, items: { c5: 2600 } })).rejects.toThrow(
      TaxReliefError,
    );
  });

  it('refuses the SECOND declaration when the two together pass the limit', async () => {
    const admin = adminCtx(base);
    const e = await hire('Acc', 'acc@acme.test');

    // January: 1,800 of C5's 2,500 — fine on its own, and APPROVED so it counts as accumulated.
    const { id } = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 1800 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id, approvedMonth: 1, approvedYear: YEAR });
    // Asked FOR February — "already claimed" is the other months, so January's 1,800 counts here.
    expect(
      (await getTp1AccumulatedForPerson(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 2 }))
        .items.c5,
    ).toBe(1800);

    // February: another 900 would make 2,700 — RM200 past the limit, and the message says so, because
    // "invalid" tells the reader nothing they can act on.
    await expect(
      submit(admin, e.personId, { deductionMonth: 2, items: { c5: 900 } }),
    ).rejects.toThrow(/200\.00/);
    // …and 700 exactly fills it.
    await expect(submit(admin, e.personId, { deductionMonth: 2, items: { c5: 700 } })).resolves.toBeTruthy();
  });

  /**
   * A CORRECTION TO AN ALREADY-APPROVED MONTH MUST NOT BE REFUSED BY ITS OWN PRIOR FIGURE.
   *
   * Approval is an UPDATE and a correction is a NEW row, so the superseded row keeps `status='approved'`.
   * Accumulating over every approved row therefore made January refuse itself — "RM 2,500.00 has already
   * been approved … so at most RM 0.00 can be claimed now" — and no correction to any approved catalogue
   * declaration was possible. The screen and the server disagreed on top of that: the screen took the
   * edited ROW out of the accumulation, the server took nothing out.
   *
   * The rule is now one function and one argument on both sides: exclude the MONTH being declared, not a
   * row id — a month can hold several superseded approved rows and excluding only the newest leaves the
   * older ones counted.
   */
  it('accepts a correction to an already-approved month, and the strip agrees with the server', async () => {
    const admin = adminCtx(base);
    const e = await hire('Correct', 'correct@acme.test');
    await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: '900707075001' });

    // January fills C5 to its 2,500 ceiling, and is approved.
    const first = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 2500 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id: first.id, approvedMonth: 1, approvedYear: YEAR });

    // The strip the HR month page draws for JANUARY: its own month is not "already claimed", so the full
    // 2,500 is still available — which is exactly what the server must accept next.
    const strip = await getTp1AccumulatedForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
    });
    expect(strip.items.c5, 'January is not accumulated against itself').toBeUndefined();

    // …and it does. Before this fix the row refused itself with "at most RM 0.00 can be claimed now".
    const fixed = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 2400 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id: fixed.id, approvedMonth: 1, approvedYear: YEAR });

    // ONE January record, and it is the correction — for the list, for the next month's allowance, and
    // for payroll. The superseded 2,500 is still `approved` in the table and must count nowhere.
    const rows = await listTp1DeclarationsForPersonYear(admin, { personId: e.personId, assessmentYear: YEAR });
    expect(rows.map((r) => r.deductionMonth)).toEqual([1]);
    expect(rows[0].tp1Amount).toBe(2400);
    const feb = await getTp1AccumulatedForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 2,
    });
    expect(feb.items.c5, 'the correction supersedes, it does not add to, January').toBe(2400);
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    await prefillTp1FromSelfRelief(admin, { batchId });
    expect(Number((await inputRow(batchId, e.employmentId)).tp1Deduction), 'not 4,900').toBe(2400);
  });

  it('counts only APPROVED declarations toward the accumulation', async () => {
    const admin = adminCtx(base);
    const e = await hire('OnlyApproved', 'onlyapproved@acme.test');
    // Submitted but never approved: a claim, not yet a deduction. It must not consume the allowance and
    // block the employee out of their own relief while HR is still deciding.
    await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 2000 } });
    expect(
      (await getTp1AccumulatedForPerson(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 2 }))
        .items.c5,
    ).toBe(undefined);
    await expect(submit(admin, e.personId, { deductionMonth: 2, items: { c5: 2000 } })).resolves.toBeTruthy();
  });

  it('checks a lettered sub-line against its own printed sub-limit, inside the group', async () => {
    const admin = adminCtx(base);
    const e = await hire('Sub', 'sub@acme.test');
    // C1 group limit 8,000; sub-line (c) is limited to 1,000 on the form. 1,200 under a 8,000 group is
    // within the group and still refused, which is the whole reason sub-limits are modelled separately.
    await expect(
      submit(admin, e.personId, { deductionMonth: 1, items: { c1: { a: 0, b: 0, c: 1200 } } }),
    ).rejects.toThrow(TaxReliefError);
    await expect(
      submit(admin, e.personId, { deductionMonth: 1, items: { c1: { a: 5000, b: 2000, c: 1000 } } }),
    ).resolves.toBeTruthy();
    // …and the GROUP still bites: 5,000 + 2,000 + 1,000 = 8,000 was the ceiling; one ringgit more is not.
    await expect(
      submit(admin, e.personId, { deductionMonth: 2, items: { c1: { a: 5001, b: 2000, c: 1000 } } }),
    ).rejects.toThrow(TaxReliefError);
  });

  it('does not block an item the form prints no limit against (ADR-0008)', async () => {
    const admin = adminCtx(base);
    const e = await hire('NoLimit', 'nolimit@acme.test');
    // C16 has no GROUP limit; its bands have their own. A large figure under band (a)'s 7,000 is fine.
    await expect(
      submit(admin, e.personId, { deductionMonth: 1, items: { c16: { a: 7000, b: 5000 } } }),
    ).resolves.toBeTruthy();
    await expect(
      submit(admin, e.personId, { deductionMonth: 2, items: { c16: { a: 7001, b: 0 } } }),
    ).rejects.toThrow(TaxReliefError);
  });

  // ═══════════════════ C. The total, the rebate, and the PCB ═══════════════════

  it('computes tp1_amount from the DEDUCTION items only — a rebate never reaches it', async () => {
    const admin = adminCtx(base);
    const e = await hire('Reb', 'reb@acme.test');
    const { id } = await submit(admin, e.personId, {
      deductionMonth: 1,
      items: { c5: 500, c9: 1000 },
      // Section D. Zakat paid OUTSIDE the monthly salary deduction, plus the religious-travel levy.
      rebates: { d1: { a: 800, b: 300 } },
    });
    const row = (await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!;
    // 1,500 — the two deductions. NOT 2,600. A rebate reduces the tax, not the chargeable income the PCB
    // kernel projects from, so folding it in here would silently move this employee's monthly MTD.
    expect(row.tp1Amount).toBe(1500);
    const cats = row.categories as schema.Tp1Categories2026;
    expect(cats.rebates!.d1.subItems).toEqual({ a: 800, b: 300 });
  });

  // The byte-stability gate (ADR-0073 point 2, test C.7), re-pointed at the C1–C17 shape rather than
  // deleted. Two identical employees in ONE January batch: A declares a catalogue breakdown summing to
  // 3,000, B keys 3,000 by hand. The fed figure must be identical to the cent.
  it('a C1–C17 breakdown summing to X feeds the identical figure a scalar X does', async () => {
    const admin = adminCtx(base);
    const A = await hire('CatA', 'cata@acme.test');
    const B = await hire('CatB', 'catb@acme.test');
    let ic = 15001;
    for (const e of [A, B]) {
      await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: `9004040${ic++}` });
    }
    const { id } = await submit(admin, A.personId, {
      deductionMonth: 1,
      items: { c5: 2500, c6: 500 }, // 3,000 exactly, both within their own limits
    });
    const row = (await getTp1ByIdForPerson(admin, { personId: A.personId, id }))!;
    expect(row.tp1Amount).toBe(3000);
    await approveTp1ForPerson(admin, { personId: A.personId, id, approvedMonth: 1, approvedYear: YEAR });

    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    const r = await prefillTp1FromSelfRelief(admin, { batchId });
    expect(r.applied).toBe(1);
    expect(Number((await inputRow(batchId, A.employmentId)).tp1Deduction)).toBe(3000);

    await setPayrollInput(admin, { batchId, employmentId: B.employmentId, overtimeAmount: 0, tp1Deduction: 3000 });
    expect(Number((await inputRow(batchId, B.employmentId)).tp1Deduction)).toBe(
      Number((await inputRow(batchId, A.employmentId)).tp1Deduction),
    );
  });

  /**
   * THE ROUND'S TWO HALVES HAVE TO MEET HERE, AND THIS IS THE CASE THAT MAKES THEM.
   *
   * The limit check is ADDITIVE across months and the screen's strip says so in words — "RM X has already
   * been approved for this assessment year, so at most RM Y can be claimed now" — which teaches HR to key
   * each month's INCREMENT. A feed that took ONE annual figure per person (the newest row) therefore made
   * a second declaration REDUCE the relief: January 3,000 then June 2,000 fed 2,000, the year-to-date
   * stayed at 3,000, and the newly approved 2,000 never reached payroll at all — with no error anywhere.
   *
   * So the fed figure is the SUM of the winning approved declaration per deduction month, over the months
   * already effective. The March assertion is the other half of the same sentence: a June approval must
   * not reach back into March.
   */
  it('feeds the SUM of the approved months, not the newest declaration', async () => {
    const admin = adminCtx(base);
    const e = await hire('Additive', 'additive@acme.test');
    await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: '900606065001' });

    const jan = await submit(admin, e.personId, { deductionMonth: 1, items: { c4: 3000 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id: jan.id, approvedMonth: 1, approvedYear: YEAR });
    // June: another 3,000 + 2,000 = 5,000 against C4's 10,000 group limit — accepted by the same check
    // whose message told HR to enter the increment.
    const jun = await submit(admin, e.personId, { deductionMonth: 6, items: { c4: 2000 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id: jun.id, approvedMonth: 6, approvedYear: YEAR });

    // MARCH — only January is effective. 3,000, and the June approval is invisible to this run.
    const march = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-03` });
    await prefillTp1FromSelfRelief(admin, { batchId: march.batchId });
    expect(Number((await inputRow(march.batchId, e.employmentId)).tp1Deduction)).toBe(3000);

    // JUNE — both are effective. 5,000, NOT 2,000: the year-to-date relief grows by the increment
    // instead of collapsing onto the newest row.
    const june = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-06` });
    await prefillTp1FromSelfRelief(admin, { batchId: june.batchId });
    expect(Number((await inputRow(june.batchId, e.employmentId)).tp1Deduction), 'not 2,000').toBe(5000);
  });

  // ═══════════════════ D. Sections E and F ═══════════════════

  it('refuses a catalogue submission without the Section E declaration', async () => {
    const admin = adminCtx(base);
    const e = await hire('NoTick', 'notick@acme.test');
    await expect(
      submitTp1ForPerson(admin, {
        personId: e.personId,
        assessmentYear: YEAR,
        deductionMonth: 1,
        declarationAccepted: false,
        categories: payload({ c5: 100 }),
      }),
    ).rejects.toThrow(TaxReliefError);
  });

  // RULE 17 — the tick is read by VALUE. A hidden input is ALWAYS submitted, so `formData.get(...) != null`
  // is true for an unticked box, which is the exact bug the rule exists to stop. The form renders a
  // hidden 'no' first and the checkbox contributes 'yes'.
  it('reads the declaration tick by value, never by presence', () => {
    const off = new FormData();
    off.set('assessmentYear', String(YEAR));
    off.append('declarationAccepted', 'no'); // the hidden default, always submitted
    expect(readTp1FormInput(off).declarationAccepted).toBe(false);

    const on = new FormData();
    on.set('assessmentYear', String(YEAR));
    on.append('declarationAccepted', 'no');
    on.append('declarationAccepted', 'yes'); // the ticked checkbox
    expect(readTp1FormInput(on).declarationAccepted).toBe(true);
  });

  it('reads every C1–C17 box the shared form emits, and never a client-sent total', () => {
    const fd = new FormData();
    fd.set('assessmentYear', String(YEAR));
    fd.set('tp1Form', 'tp1-2026');
    fd.set('deductionMonth', '3');
    fd.set('tp1_items_c9_amount', '250.50');
    fd.set('tp1_items_c1_sub_c', '400');
    fd.set('tp1_rebates_d1_sub_a', '75');
    // A hostile total on the wire. It must not appear anywhere in what the reader returns.
    fd.set('tp1Amount', '999999');
    const input = readTp1FormInput(fd);
    expect(input.deductionMonth).toBe(3);
    expect(input.tp1Amount).toBeUndefined();
    const cats = input.categories as ReturnType<typeof payload>;
    expect(cats.items.c9, 'C9 is a single-box item on the form').toEqual({ amount: 250.5 });
    expect(cats.items.c1).toEqual({ subItems: { a: 0, b: 0, c: 400 } });
    expect(cats.rebates!.d1).toEqual({ subItems: { a: 75, b: 0 } });
  });

  it('approve stamps Section F and only a submitted row can be approved', async () => {
    const admin = adminCtx(base);
    const e = await hire('Consent', 'consent@acme.test');
    const { id } = await submit(admin, e.personId, { deductionMonth: 4, items: { c5: 100 } });
    await approveTp1ForPerson(admin, {
      personId: e.personId,
      id,
      approvedMonth: 6,
      approvedYear: YEAR,
      approverPosition: 'HR Manager',
    });
    const row = (await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!;
    expect(row.status).toBe('approved');
    expect(row.approvedMonth).toBe(6);
    expect(row.approvedYear).toBe(YEAR);
    expect(row.approverPosition).toBe('HR Manager');
    expect(row.approvedAt).toBeTruthy();
    expect(row.declaredAt, 'Section E is stamped by the server at submit').toBeTruthy();
    // Approving twice is not a second approval.
    await expect(approveTp1ForPerson(admin, { personId: e.personId, id })).rejects.toThrow(TaxReliefError);
  });

  /**
   * SECTION F'S "NAME" BOX. Besides the month, the approver's identity is the one fact the section exists
   * to record — and it was captured (`approved_by`) and rendered nowhere: both surfaces passed a
   * hardcoded null with a comment acknowledging the gap. The name is RESOLVED through `approved_by`
   * rather than copied onto the row, so a renamed user is never two names on two screens.
   */
  it('Section F resolves the approver’s NAME through approved_by, on the screen and on the form', async () => {
    const admin = adminCtx(base);
    const e = await hire('Named', 'named@acme.test');
    const hr = await hire('Halim Approver', 'halim@acme.test');
    const hrCtx: SessionContext = {
      ...admin,
      userId: await createAppUser(base.tenantId, hr.personId, 'hr_admin'),
    };
    const { id } = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 100 } });
    // Undecided: the box is blank, and blank is the honest answer — it is what the paper form's own
    // blank rule means.
    expect((await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!.approvedByName).toBeNull();

    await approveTp1ForPerson(hrCtx, {
      personId: e.personId,
      id,
      approvedMonth: 1,
      approvedYear: YEAR,
      approverPosition: 'HR Manager',
    });
    const row = (await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!;
    expect(row.approvedBy).toBe(hrCtx.userId);
    expect(row.approvedByName).toBe('Halim Approver');

    // …and BOTH surfaces render it from the row rather than from a placeholder. This is the assertion
    // that stops the hardcoded null coming back the next time either file is touched.
    const PAGE = fs.readFileSync(path.join(ROOT, 'app/payroll/transactions/tp1/[year]/[month]/page.tsx'), 'utf8');
    const PDF = fs.readFileSync(path.join(ROOT, 'app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts'), 'utf8');
    expect(PAGE).toContain('approvedByName: full.approvedByName');
    expect(PDF).toContain('name: row.approvedByName');
  });

  /**
   * THE FORM PRINTS IN A LANGUAGE THE EMBEDDED FONT CAN SET. `lib/tp1-pdf.ts` embeds Helvetica, which is
   * WinAnsi, and folds every codepoint outside Latin-1 to '?'. Every word of the form body — seventeen
   * item labels, their sub-lines, the frequency notes, the declaration and the provenance band — comes
   * from the `taxRelief` namespace, and messages/{ta,zh,th,vi}.json translate all of it. Resolving that
   * namespace against the VIEWER's UI locale therefore handed four of our six locales a statutory form
   * whose whole of Section C read as rows of '?'. Same allowlist app/me/ea/[employmentId]/pdf carries.
   */
  it('prints the statutory form only in a language the embedded font can set', () => {
    const ROUTE = fs.readFileSync(
      path.join(ROOT, 'app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts'),
      'utf8',
    );
    expect(ROUTE).toContain("TP1_LANGS = ['en', 'ms']");
    expect(ROUTE).toContain("getTranslations({ locale, namespace: 'taxRelief' })");
    expect(ROUTE, 'the bare-string form resolves the viewer’s locale — the bug this replaced').not.toContain(
      "getTranslations('taxRelief')",
    );
    // …and the fold that makes the guard necessary is still there, so this case cannot go stale quietly.
    const PDF_LIB = fs.readFileSync(path.join(ROOT, 'lib/tp1-pdf.ts'), 'utf8');
    expect(PDF_LIB).toContain('StandardFonts.Helvetica');
    expect(PDF_LIB).toMatch(/replace\(\/\[\^\\x20-\\x7E/);
  });

  it('an employee cannot approve, reject or cancel their own declaration', async () => {
    const admin = adminCtx(base);
    const e = await hire('Self', 'self@acme.test');
    const { id } = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 100 } });
    const ctx = await employeeCtx(e.personId);
    for (const fn of [approveTp1ForPerson, rejectTp1ForPerson, cancelTp1ForPerson]) {
      await expect(fn(ctx, { personId: e.personId, id })).rejects.toThrow(TaxReliefError);
    }
  });

  it('a rejected or cancelled declaration stops feeding, and cancel may follow approval', async () => {
    const admin = adminCtx(base);
    const e = await hire('Stop', 'stop@acme.test');
    const { id } = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 100 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id, approvedMonth: 1, approvedYear: YEAR });
    expect(await getLatestApprovedTp1(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 1 })).toBeTruthy();
    // A relief approved in error is stopped from feeding the next run — cancel is allowed after approval.
    await cancelTp1ForPerson(admin, { personId: e.personId, id });
    expect(await getLatestApprovedTp1(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 1 })).toBeNull();
    // The approval stamps SURVIVE the cancel: "who approved this, and when, before it was cancelled" is
    // the audit question, and erasing it would answer it wrongly.
    const row = (await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!;
    expect(row.status).toBe('cancelled');
    expect(row.approvedAt).toBeTruthy();
  });

  it('the approved deduction month gates WHICH runs see the relief', async () => {
    const admin = adminCtx(base);
    const e = await hire('FromJune', 'fromjune@acme.test');
    const { id } = await submit(admin, e.personId, { deductionMonth: 6, items: { c5: 100 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id, approvedMonth: 6, approvedYear: YEAR });
    // A relief approved from June must not reduce March's tax.
    expect(await getLatestApprovedTp1(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 3 })).toBeNull();
    expect(await getLatestApprovedTp1(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 6 })).toBeTruthy();
    expect(await getLatestApprovedTp1(admin, { personId: e.personId, assessmentYear: YEAR, deductionMonth: 12 })).toBeTruthy();
  });

  // PDPA Layer-0 (ADR-0030): the event log is subject-readable, so the amounts must live only on the
  // RLS-protected row. This holds for the three decision events as well as for submit.
  it('the decision events carry field names and never an amount', async () => {
    const admin = adminCtx(base);
    const e = await hire('Ev', 'ev@acme.test');
    const { id } = await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 1234.56 } });
    await approveTp1ForPerson(admin, { personId: e.personId, id, approvedMonth: 1, approvedYear: YEAR });
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const types = events.map((v) => v.eventType);
    expect(types).toContain('tp1.submitted');
    expect(types).toContain('tp1.approved');
    const dump = JSON.stringify(events.map((v) => v.payload));
    expect(dump).not.toContain('1234.56');
    expect(dump).not.toContain('1234');
    const approved = events.find((v) => v.eventType === 'tp1.approved')!.payload as { fields: string[] };
    expect(approved.fields).toContain('status');
    expect(approved.fields).toContain('approvedMonth');
  });

  // ═══════════════════ E. The legacy shape keeps working ═══════════════════

  it('a legacy eight-key declaration still reads, still totals, and still feeds payroll', async () => {
    const admin = adminCtx(base);
    const e = await hire('Old', 'old@acme.test');
    await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(admin, { personId: e.personId, icNumber: '900505015001' });

    // The eight-key payload, submitted exactly as it was before this round — no month, no tick.
    const { id } = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      categories: { individual: 9000, lifestyle: 500 },
    });
    const row = (await getTp1ByIdForPerson(admin, { personId: e.personId, id }))!;
    expect(row.tp1Amount).toBe(9500);
    expect(schema.isTp1Categories2026(row.categories), 'a legacy row is NOT the 2026 shape').toBe(false);
    expect((row.categories as schema.Tp1LegacyCategories).individual).toBe(9000);
    expect(row.deductionMonth, 'a month is never invented for a whole-year declaration').toBeNull();

    // It contributes NOTHING to the C1–C17 accumulation — there is no honest mapping from
    // "medicalInsurance" onto C4 / C11 / C13, and an invented one would refuse a claim citing a number
    // nobody entered.
    await approveTp1ForPerson(admin, { personId: e.personId, id, approvedMonth: 1, approvedYear: YEAR });
    const acc = await getTp1AccumulatedForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
    });
    expect(acc.items).toEqual({});

    // …and it still reaches payroll, which is the promise that matters.
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: `${YEAR}-01` });
    await prefillTp1FromSelfRelief(admin, { batchId });
    expect(Number((await inputRow(batchId, e.employmentId)).tp1Deduction)).toBe(9500);
  });

  it('lists one row per deduction month, and a month-less legacy row sorts last', async () => {
    const admin = adminCtx(base);
    const e = await hire('Months', 'months@acme.test');
    await submit(admin, e.personId, { deductionMonth: 2, items: { c5: 200 } });
    await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 100 } });
    // A correction for January — the same month, so it must NOT become a second January line.
    await submit(admin, e.personId, { deductionMonth: 1, items: { c5: 150 } });
    await submitTp1ForPerson(admin, { personId: e.personId, assessmentYear: YEAR, tp1Amount: 50 });

    const rows = await listTp1DeclarationsForPersonYear(admin, { personId: e.personId, assessmentYear: YEAR });
    expect(rows.map((r) => r.deductionMonth)).toEqual([1, 2, null]);
    expect(rows[0].tp1Amount, 'the correction wins within its month').toBe(150);
    expect(rows[0].versions).toBe(2);
    expect(rows[1].versions).toBe(1);
  });

  it('a draft is per (year, month), so keying February does not overwrite January', async () => {
    const admin = adminCtx(base);
    const e = await hire('Drafts', 'drafts@acme.test');
    const { saveTp1DraftForPerson } = await import('../core/tax-relief');
    await saveTp1DraftForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      categories: payload({ c5: 100 }),
    });
    await saveTp1DraftForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 2,
      categories: payload({ c5: 200 }),
    });
    const drafts = await owner.db
      .select()
      .from(schema.tp1Relief)
      .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'draft')));
    expect(drafts, 'two months, two open drafts').toHaveLength(2);
    // …and re-saving January still edits in place rather than appending a third.
    await saveTp1DraftForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      categories: payload({ c5: 120 }),
    });
    const after = await owner.db
      .select()
      .from(schema.tp1Relief)
      .where(and(eq(schema.tp1Relief.personId, e.personId), eq(schema.tp1Relief.status, 'draft')));
    expect(after).toHaveLength(2);
    expect(Number(after.find((r) => r.deductionMonth === 1)!.tp1Amount)).toBe(120);
  });

  it('the admin read of a declaration is confined to the person it belongs to', async () => {
    const admin = adminCtx(base);
    const a = await hire('OwnerA', 'ownera@acme.test');
    const b = await hire('OwnerB', 'ownerb@acme.test');
    const { id } = await submit(admin, a.personId, { deductionMonth: 1, items: { c5: 100 } });
    // The id is real, but it is not B's — so B's read finds nothing rather than A's tax figures.
    expect(await getTp1ByIdForPerson(admin, { personId: b.personId, id })).toBeNull();
    expect(await getTp1ForPerson(admin, { personId: a.personId, assessmentYear: YEAR })).toBeTruthy();
  });
});
