/**
 * r374 (item 7dbaf677) — AN EMPLOYEE MAY BE ENTERED WITH NO BASIC SALARY, FROM THE TWO SCREENS WHERE A
 * SALARY IS ACTUALLY TYPED.
 *
 * THE HALF THIS FILE DOES *NOT* COVER, so nobody re-builds it. r369 (item eb949191) already relieved the
 * SERVICE and the importer: `core/comp.ts` accepts a salary record with no basic amount once Remarks says
 * why, `core/payroll.ts` leaves such a person out of a month with nothing payable instead of blocking the
 * company's run, a daily/hourly worker with no RATE still blocks it on purpose, and the spreadsheet import
 * learned the same rule. All of that is pinned by `test/r369-zero-basic-skip.test.ts` and
 * `test/r369-import-salary-remarks.test.ts` and is deliberately untouched here. THERE IS NO TICK BOX: the
 * reporter's Remarks field does that job, and one fact recorded once beats two that can disagree.
 *
 * WHAT WAS LEFT, AND IS WHAT THIS FILE IS ABOUT, is that neither entry FORM had caught up:
 *
 *   §1 THE DRAFT RULE. `missingByTab` demanded an amount above zero, so the Create New Employee Payroll
 *      tab held Activate switched off until somebody typed one — the screen the reporter named. Blank and
 *      zero are now legitimate and ask for REMARKS instead; a junk string and a NEGATIVE amount stay red.
 *   §2 THE THREE INPUTS AND THE TWO ACTIONS, read from source. The wizard's `min="0.01"` (the only such
 *      floor on a basic salary in the tree), and `required` on the Personnel Add form AND on the
 *      salary-history EDIT form. The two had to move together: they are the two halves of one screen.
 *   §3 THE SERVICE GAPS THIS ROUND'S PERMISSIVENESS OPENED. A negative basic stored silently with any
 *      remark at all, and a merit enact on a zero basic threw a salary-remark error at an appraiser who
 *      has no Remarks field to answer it with.
 *   §4 ACTIVATION, AGAINST A REAL DATABASE. A blank basic with a remark activates and stores `0.00`, not
 *      `NaN`. A blank basic with NO remark creates NOTHING — `completeEmployeeDraft` is not one
 *      transaction, so a refusal that arrived at `setCompensation` would leave an employment behind.
 *   §5 THE SENTENCES, in all six locales.
 *
 * ── WHY §4's "NOTHING WAS CREATED" CASE IS THE LOAD-BEARING ONE ─────────────────────────────────────
 * `completeEmployeeDraft` calls `hireEmployee` (commit), then four more writers, then `setCompensation`,
 * then deletes the draft. Its own header says it cannot be one transaction. So the relief in §1 and the
 * remark requirement are not two independent changes: if the form rule let a blank amount through while
 * the service still refused it, Activate would create a person and an employment and THEN fail, leaving
 * the half-activated state that whole file exists to prevent. That is why the pre-flight is asserted by
 * counting rows after a refusal, not merely by the error type.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  NegativeSalaryAmountError,
  SalaryRemarkRequiredError,
  currentCompensation,
  setCompensation,
  updateCompensation,
} from '../core/comp';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { createCycle, openCycle, submitManagerReview, enactCompAction } from '../core/performance';
import { withTenant } from '../db/client';
import {
  missingByTab,
  missingForCreation,
  noBasicSalaryAmount,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
const LOCALES = Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[];

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const WIZARD = 'app/admin/personnel/new/wizard.tsx';
const PERSONNEL_PAGE = 'app/admin/personnel/[employmentId]/page.tsx';
const SALARY_HISTORY = 'components/salary-history-table.tsx';
const PERSONNEL_ACTIONS = 'app/admin/personnel/[employmentId]/actions.ts';
const PAY_STRUCTURE = 'components/pay-structure-fields.tsx';
const MOVEMENT_FORM = 'app/admin/personnel/[employmentId]/movement-new-event.tsx';

const DIRECTOR_REMARK = "No monthly basic — paid by quarterly director's fees";

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

// ── §1 the draft rule ─────────────────────────────────────────────────────────────────────────────
describe('§1 the Create New Employee Payroll tab: blank or zero is legitimate, and asks for a reason', () => {
  it('a blank amount asks for REMARKS, not for an amount', () => {
    expect(missingByTab({ payroll: {} }).payroll).toEqual(['remarks']);
    expect(missingByTab({ payroll: { basicSalary: '' } }).payroll).toEqual(['remarks']);
    // Whitespace is blankness, not a parse: `Number('   ')` is 0, which is why the rule asks `blank()`
    // and never infers emptiness from the number.
    expect(missingByTab({ payroll: { basicSalary: '   ' } }).payroll).toEqual(['remarks']);
    expect(missingByTab({ payroll: { basicSalary: '', remarks: DIRECTOR_REMARK } }).payroll).toEqual([]);
  });

  it('an explicit zero does the same — in every spelling HR can type into a number box', () => {
    for (const z of ['0', '0.00', '00', '0.0', '-0']) {
      expect(missingByTab({ payroll: { basicSalary: z } }).payroll, z).toEqual(['remarks']);
      expect(
        missingByTab({ payroll: { basicSalary: z, remarks: DIRECTOR_REMARK } }).payroll,
        `${z} with a remark`,
      ).toEqual([]);
    }
  });

  it('a NEGATIVE amount is still refused, and a remark does not buy it in', () => {
    // Blank and zero are legitimate; negative never is. A remark is the answer to "why is there no
    // basic", not to "why is the basic below zero" — there is no answer to that second question.
    expect(missingByTab({ payroll: { basicSalary: '-100' } }).payroll).toEqual(['basicSalary']);
    expect(missingByTab({ payroll: { basicSalary: '-100', remarks: DIRECTOR_REMARK } }).payroll).toEqual([
      'basicSalary',
    ]);
    expect(missingByTab({ payroll: { basicSalary: '-0.01' } }).payroll).toEqual(['basicSalary']);
  });

  it('a JUNK amount is still refused — a non-numeric string is not a Director', () => {
    // `money(NaN)` is the STRING "NaN" and Postgres `numeric` ACCEPTS it, which would poison gross,
    // every statutory base, the payslip, the bank file and the agency returns with no error anywhere.
    for (const junk of ['abc', 'RM500', '-', '.', '5,0,0,0.0.0', '1e']) {
      expect(missingByTab({ payroll: { basicSalary: junk } }).payroll, junk).toEqual(['basicSalary']);
    }
    // And a remark cannot buy that in either.
    expect(missingByTab({ payroll: { basicSalary: 'abc', remarks: DIRECTOR_REMARK } }).payroll).toEqual([
      'basicSalary',
    ]);
  });

  it('a POSITIVE amount is judged exactly as it was before — nothing changes for a normal hire', () => {
    expect(missingByTab({ payroll: { basicSalary: '5200' } }).payroll).toEqual([]);
    // Thousands separators and underscores were always stripped; still are.
    expect(missingByTab({ payroll: { basicSalary: '5,200.50' } }).payroll).toEqual([]);
    // …and a positive amount needs NO remark. This is the half that must not have become stricter.
    expect(missingByTab({ payroll: { basicSalary: '5200', remarks: '' } }).payroll).toEqual([]);
    expect(missingByTab({ payroll: { basicSalary: '0.01' } }).payroll).toEqual([]);
  });

  it('the DAILY/HOURLY rate refusal is untouched, and composes with the new rule', () => {
    // r369 kept this blocker on purpose: pay IS rate × time, so there is nothing else that could ever
    // pay this person. A Director with no basic is a different case from a day-rate worker with no rate.
    expect(missingByTab({ payroll: { basicSalary: '', payMode: 'daily' } }).payroll).toEqual([
      'remarks',
      'rateAmount',
    ]);
    expect(
      missingByTab({ payroll: { basicSalary: '', remarks: DIRECTOR_REMARK, payMode: 'hourly' } }).payroll,
    ).toEqual(['rateAmount']);
    expect(
      missingByTab({
        payroll: { basicSalary: '', remarks: DIRECTOR_REMARK, payMode: 'hourly', rateAmount: '25' },
      }).payroll,
    ).toEqual([]);
  });

  it('`noBasicSalaryAmount` is ONE predicate, and the screen reads the same one the rule does', () => {
    // The wizard stars Remarks and shows its hint from this function (asserted from source in §2), and
    // `missingByTab` decides the requirement with it. A screen with its own reading of the box would
    // either ask for a reason the rule does not want, or hold Activate back over a field it never
    // starred.
    for (const yes of [undefined, '', '   ', '0', '0.00', '-0', '0,0']) {
      expect(noBasicSalaryAmount(yes), String(yes)).toBe(true);
    }
    // FALSE for a positive amount — and also false for the two REFUSED shapes, which are not this case
    // at all. A caller must never read a `false` here as "the amount is fine".
    for (const no of ['5200', '0.01', '-100', 'abc', '.']) {
      expect(noBasicSalaryAmount(no), String(no)).toBe(false);
    }
  });

  it('the Payroll tab is the ONLY tab this changed — the other four rules are byte-identical', () => {
    const m = missingByTab({});
    expect(m.profile).toEqual([]);
    expect(m.job).toEqual(['department', 'employmentType', 'hiredOn']);
    expect(m.bankStatutory).toEqual([]);
    expect(m.family).toEqual([]);
    // The tab keys and their ORDER map to `employee_draft.current_step` on rows already in production.
    expect(Object.keys(m)).toEqual(['profile', 'job', 'bankStatutory', 'payroll', 'family']);
  });

  it('the Activate gate sees it: a draft complete but for the reason is NOT activatable', () => {
    const d: EmployeeDraftData = {
      profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@demo.test' },
      employment: {
        companyId: 'c1',
        departmentId: 'd1',
        employmentType: 'full_time',
        hiredOn: '2026-06-01',
      },
      payroll: { basicSalary: '' },
    };
    expect(missingForCreation(d)).toEqual(['remarks']);
    expect(missingForCreation({ ...d, payroll: { basicSalary: '', remarks: DIRECTOR_REMARK } })).toEqual([]);
  });
});

// ── §2 the three inputs and the two actions ──────────────────────────────────────────────────────
describe('§2 the forms, read from source', () => {
  /**
   * THE WHOLE `<input>` TAG that carries the basic salary, cut from its own `<input` to its own `/>`.
   *
   * EVERY BOUND IS PROVEN BEFORE THE SLICE IS TAKEN (CLAUDE.md §8). `indexOf` returns −1 for a marker
   * that was renamed, −1 is truthy, and `String.prototype.slice` reads a negative start as
   * `length + start` — so an unguarded version of this helper would hand back the tail of the file, or
   * the empty string, and every `not.toContain` on it would report green over a reinstated `required`.
   * `test/r219-ea-cp8a-form.test.ts` asserted nothing at all for 27 rounds through exactly that.
   * `type="number"` is the positive control: it says the slice really is the amount box.
   */
  function basicSalaryInput(file: string, marker: string): string {
    const src = read(file);
    const at = src.indexOf(marker);
    expect(at, `${file}: the basic-salary marker "${marker}" was not found`).toBeGreaterThanOrEqual(0);
    const open = src.lastIndexOf('<input', at);
    expect(open, `${file}: no <input> opens before "${marker}"`).toBeGreaterThanOrEqual(0);
    const close = src.indexOf('/>', at);
    expect(close, `${file}: the input around "${marker}" is never closed`).toBeGreaterThan(at);
    const tag = src.slice(open, close + 2);
    expect(tag.length, `${file}: the matched input tag is implausibly short`).toBeGreaterThan(40);
    expect(tag, `${file}: the slice is not the amount box`).toContain('type="number"');
    return tag;
  }

  it('the wizard floor is ZERO, not one sen — it was the only min="0.01" on a basic anywhere', () => {
    const tag = basicSalaryInput(WIZARD, 'value={data.payroll?.basicSalary ?? \'\'}');
    expect(tag).toContain('min="0"');
    expect(tag, 'min="0.01" kept Activate switched off until somebody invented a figure').not.toContain(
      'min="0.01"',
    );
    // `min="0"` is kept rather than dropped: the browser refuses a negative amount first, and the
    // service refuses it behind that (§3).
    expect(tag).not.toContain('required');
  });

  it('the Personnel ADD form no longer requires an amount, and keeps its zero floor', () => {
    const tag = basicSalaryInput(PERSONNEL_PAGE, 'name="basicSalary"');
    expect(tag).toContain('min="0"');
    expect(tag, 'required meant HR could type a zero but not leave the box empty').not.toContain('required');
  });

  it('the salary-history EDIT form moved WITH it — one screen, two halves', () => {
    // THE GUARD THAT CATCHES THIS BEING FORGOTTEN. The add form and the in-place edit form are the two
    // halves of the Payroll tab's Basic Salary section; relieving one and not the other is how they
    // drift, and the edit form was not even named by the item's first plan.
    const tag = basicSalaryInput(SALARY_HISTORY, 'name="basicSalary"');
    expect(tag).toContain('min="0"');
    expect(tag).not.toContain('required');
    // It still posts its stored amount, which is what makes a blank from it a DELIBERATE clear.
    expect(tag).toContain('defaultValue={r.basic}');
  });

  it('the EDIT ACTION reads a posted blank as ZERO, not as "untouched" — pinned across both files', () => {
    // THE DIVERGENCE DROPPING `required` OPENED. `updateCompensation` treats `undefined` as UNTOUCHED, so
    // the old `rawBasicStr !== '' ? Number(rawBasicStr) : undefined` would have silently kept the old
    // amount when HR cleared the box — while the same gesture on the ADD form meant zero.
    //
    // And it is pinned ACROSS the two files because that is where the defect lives (CLAUDE.md §8): the
    // action may only read the KEY's presence, which is sound only because the form always posts it.
    const actions = read(PERSONNEL_ACTIONS);
    expect(actions).not.toContain("rawBasicStr !== '' ? Number(rawBasicStr) : undefined");
    expect(actions).toContain('basicSalary: rawBasic !== null ? Number(rawBasicStr) : undefined');
    expect(read(SALARY_HISTORY), 'the edit input must keep posting, or presence stops being readable')
      .toContain('name="basicSalary"');
  });

  it('the wizard marks Remarks, Pay Mode and Payment Term required ON SCREEN from the shared predicate', () => {
    const src = read(WIZARD);
    expect(src).toContain('noBasicSalaryAmount');
    expect(src).toContain('const noBasicSalary = noBasicSalaryAmount(data.payroll?.basicSalary)');
    expect(src).toContain('markRequired={noBasicSalary}');
    expect(src).toContain('required={noBasicSalary}');
    expect(src).toContain("t('hints.noBasicSalary')");
  });

  it('PAY MODE AND PAYMENT TERM ARE NOT REQUIRED BY PRESENCE, and the rule must not learn to be', () => {
    // The reporter listed both as mandatory when there is no basic amount. They CANNOT be read by
    // presence: this very screen displays "Monthly" for a draft that stores neither field (the display
    // fallback below, with no matching write), so a presence rule would refuse a draft that looks
    // complete — the a72610af defect the Employment tab already had to fix. CLAUDE.md §8.
    const src = read(WIZARD);
    expect(src).toContain("payMode={(data.payroll?.payMode ?? 'monthly') as PayModeOption}");
    const schema = read('lib/employee-draft-schema.ts');
    const start = schema.indexOf('export function missingByTab');
    const end = schema.indexOf('export function missingForCreation');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = schema.slice(start, end);
    expect(body.length, 'the rule body is implausibly short — the markers moved').toBeGreaterThan(2000);
    expect(body, 'a positive control: the rule really does push field names').toContain("'remarks'");
    expect(body, 'pay mode must never be required by presence').not.toContain("payroll.push('payMode')");
    expect(body, 'payment term must never be required by presence').not.toContain("payroll.push('paymentTerm')");
  });

  it('`markRequired` defaults OFF, so the two Personnel callers render exactly as before', () => {
    const shared = read(PAY_STRUCTURE);
    expect(shared).toContain('markRequired?: boolean');
    // Presentation only — nothing in the shared component validates on it.
    expect(shared).toContain('props.markRequired ?');
    expect(shared).not.toContain('required={props.markRequired');
    for (const f of [PERSONNEL_PAGE, SALARY_HISTORY]) {
      const call = read(f).match(/<PayStructureFields[\s\S]*?\/>/);
      expect(call, `${f} must render PayStructureFields`).not.toBeNull();
      expect(call![0], `${f} must not opt into the asterisk`).not.toContain('markRequired');
    }
  });

  it('THE FLOORS DELIBERATELY LEFT ALONE — three of them, each for a stated reason', () => {
    // 1. THE RATE BOX keeps min="0.01" AND required for daily/hourly. `missing_rate` is still a blocker
    //    and this is the input that answers it.
    const shared = read(PAY_STRUCTURE);
    expect(shared).toContain('min="0.01"');
    expect(shared).toContain("const rateRequired = payMode === 'daily' || payMode === 'hourly';");
    expect(shared).toContain('required={rateRequired}');
    // 2. THE MOVEMENT FORM was already permissive, and a blank there means "leave the salary alone" —
    //    a delta, not an amount. It must keep meaning that.
    const movement = read(MOVEMENT_FORM);
    expect(movement).toContain('min={0}');
    expect(read(PERSONNEL_ACTIONS)).toContain('parseMovementForm');
    // 3. Every OTHER min="0.01" in the tree is on something that is not a basic salary. Counted rather
    //    than listed, so a new one has to be looked at.
    const all = [
      'app/payroll/transactions/fixed/add-fixed-dialog.tsx',
      'app/payroll/transactions/fixed/[id]/page.tsx',
      'components/claim-form.tsx',
      'components/loan-new-form.tsx',
    ];
    for (const f of all) expect(read(f), f).toContain('min="0.01"');
  });

  it('the prose that asserted the OLD rule is retired, in both places that carried it', () => {
    // CLAUDE.md §8 — prose outlives the kernel. Two file headers stated that the initial basic salary is
    // REQUIRED; a later round reading either would reinstate the refusal the reporter rejected.
    expect(read('app/admin/personnel/actions.ts')).not.toContain(
      'the initial basic salary is still required',
    );
    expect(read('lib/employee-draft-schema.ts')).not.toContain(
      'work email and initial basic salary',
    );
    // And each now says what IS true, naming the item so the next reader can find the decision.
    expect(read('lib/employee-draft-schema.ts')).toContain('7dbaf677');
  });
});

// ── §3 the two service gaps this round's permissiveness opened ───────────────────────────────────
describe('§3 the service is the authority behind the lowered floors', () => {
  const hire = async (name: string) => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `r374_${randomUUID().slice(0, 8)}@nb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    return { a, employmentId: e.employmentId };
  };

  it('a NEGATIVE basic salary is refused by setCompensation — a remark does not buy it in', async () => {
    const { a, employmentId } = await hire('Negative Nasir');
    await expect(
      setCompensation(a, {
        employmentId,
        basicSalary: -100,
        remarks: DIRECTOR_REMARK,
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toThrow(NegativeSalaryAmountError);
    // Nothing was written. Before this guard `unpayableSalaryLeg` called −100 `no_monthly_basic`, so any
    // remark at all let it through — harmless only while every basic input carried a floor above zero,
    // which is exactly what this round lowered.
    expect(await currentCompensation(a, employmentId)).toBeNull();
  });

  it('…and by updateCompensation, on the open row, without re-refusing an untouched one', async () => {
    const { a, employmentId } = await hire('Edit Elena');
    const { compensationId } = await setCompensation(a, {
      employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    await expect(
      updateCompensation(a, { compensationId, employmentId, basicSalary: -1 }),
    ).rejects.toThrow(NegativeSalaryAmountError);
    expect(Number((await currentCompensation(a, employmentId))?.basicSalary)).toBe(4000);
    // An OMITTED amount is still untouched, not re-judged.
    await updateCompensation(a, { compensationId, employmentId, remarks: 'note only' });
    expect(Number((await currentCompensation(a, employmentId))?.basicSalary)).toBe(4000);
  });

  it('ZERO with a remark is accepted and stores 0.00 — the r369 rule, unchanged', async () => {
    const { a, employmentId } = await hire('Director Dalila');
    await setCompensation(a, {
      employmentId,
      basicSalary: 0,
      remarks: DIRECTOR_REMARK,
      effectiveFrom: '2026-01-01',
    });
    const cur = await currentCompensation(a, employmentId);
    expect(cur?.basicSalary).toBe('0.00');
    expect(cur?.remarks).toBe(DIRECTOR_REMARK);
    // …and without the remark it is still refused. That is the reporter's own condition and the only
    // thing left of the refusal they rejected.
    await expect(
      setCompensation(a, { employmentId, basicSalary: 0, effectiveFrom: '2026-02-01' }),
    ).rejects.toThrow(SalaryRemarkRequiredError);
  });

  it('a MERIT percentage on a zero basic is refused naming the employee, not with a salary-remark error', async () => {
    // THE GAP: `core/performance.ts` multiplies the current basic by the percentage and passes NO remarks
    // (deliberately — a merit must not rewrite the pay structure). On a zero basic the new basic is zero,
    // so since r369 the enact threw `SalaryRemarkRequiredError`: a sentence about director's fees, on the
    // performance screen, telling an appraiser to write a salary remark they have no field for. And the
    // arithmetic is meaningless anyway — 0 × 1.10 is 0, a raise that raises nothing.
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Merit Maya', primaryEmail: `r374_${randomUUID().slice(0, 8)}@nb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      employeeCode: 'DIR0001',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 0,
      remarks: DIRECTOR_REMARK,
      effectiveFrom: '2025-01-01',
    });

    const { cycleId } = await createCycle(a, {
      companyId: base.companyId,
      name: 'FY26',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    });
    await openCycle(a, { cycleId });
    const [rev] = await withTenant(a, (tx) =>
      tx
        .select({ id: schema.performanceReview.id })
        .from(schema.performanceReview)
        .where(eq(schema.performanceReview.employmentId, e.employmentId)),
    );
    expect(rev?.id).toBeTruthy();
    await submitManagerReview(a, {
      reviewId: rev.id,
      managerRating: 4,
      overallRating: 4,
      recommendedMeritPct: 10,
    });

    const err = await enactCompAction(a, { reviewId: rev.id, meritEffectiveFrom: '2026-08-01' }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err, 'the enact must refuse').not.toBeNull();
    // The REFUSAL IS THE PERFORMANCE SERVICE'S OWN, raised before the compensation writer is reached…
    expect(err!.name).toBe('PerfError');
    expect(err!.name).not.toBe('SalaryRemarkRequiredError');
    // …it names WHO, and it points at the screen that can actually record the change.
    expect(err!.message).toContain('DIR0001');
    expect(err!.message).toMatch(/basic salary/i);
    // And nothing was written: the zero-basic row is still the open one, untouched.
    const cur = await currentCompensation(a, e.employmentId);
    expect(cur?.basicSalary).toBe('0.00');
    expect(cur?.validFrom).toBe('2025-01-01');
  });

  it('a merit on a POSITIVE basic still enacts — the refusal above is narrow', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Raise Rina', primaryEmail: `r374_${randomUUID().slice(0, 8)}@nb.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2025-01-01' });
    const { cycleId } = await createCycle(a, {
      companyId: base.companyId,
      name: 'FY26b',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    });
    await openCycle(a, { cycleId });
    const [rev] = await withTenant(a, (tx) =>
      tx
        .select({ id: schema.performanceReview.id })
        .from(schema.performanceReview)
        .where(eq(schema.performanceReview.employmentId, e.employmentId)),
    );
    await submitManagerReview(a, {
      reviewId: rev.id,
      managerRating: 4,
      overallRating: 4,
      recommendedMeritPct: 10,
    });
    const out = await enactCompAction(a, { reviewId: rev.id, meritEffectiveFrom: '2026-08-01' });
    expect(out.enactedCompensationId).toBeTruthy();
    expect(Number((await currentCompensation(a, e.employmentId))?.basicSalary)).toBe(5500);
  });
});

// ── §4 activation against a real database ────────────────────────────────────────────────────────
describe('§4 Activate, against a real database', () => {
  const draft = (over: Partial<EmployeeDraftData['payroll']> = {}): EmployeeDraftData => ({
    profile: {
      fullName: 'Director Danial',
      primaryEmail: `r374_${randomUUID().slice(0, 8)}@nb.test`,
      employeeCode: `D${randomUUID().slice(0, 8).toUpperCase()}`,
    },
    employment: {
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    },
    payroll: { ...over },
  });

  /** Row counts read as the OWNER (RLS would answer 0 for a role with no tenant context — CLAUDE.md §5).
   *  Counted rather than compared by id, because what a refused activation must leave behind is
   *  *nothing*, and an id check would pass over a row created for somebody else. */
  const counts = async () => {
    const people = await owner.db.select({ id: schema.person.id }).from(schema.person);
    const employments = await owner.db.select({ id: schema.employment.id }).from(schema.employment);
    return { people: people.length, employments: employments.length };
  };

  it('a blank Initial Basic Salary with a remark ACTIVATES, and stores 0.00 — never NaN', async () => {
    const a = adminCtx(base);
    const saved = await saveEmployeeDraft(a, { data: draft({ remarks: DIRECTOR_REMARK }), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(a, saved.id);

    const [comp] = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    // READ BACK THE STORED VALUE, not the argument. `money(NaN)` is the string "NaN" and Postgres
    // `numeric` accepts it, so "it did not throw" is not the assertion that matters here.
    expect(comp.basicSalary).toBe('0.00');
    expect(comp.basicSalary).not.toBe('NaN');
    expect(Number.isNaN(Number(comp.basicSalary))).toBe(false);
    expect(comp.remarks).toBe(DIRECTOR_REMARK);
    // The pay structure a draft that named neither falls back to — monthly/monthly, which is what the
    // screen displayed all along and what `setCompensation` defaults a first record to.
    expect(comp.payMode).toBe('monthly');
    expect(comp.paymentTerm).toBe('monthly');
    // The draft is gone, so the activation really completed rather than stopping partway.
    const drafts = await owner.db.select({ id: schema.employeeDraft.id }).from(schema.employeeDraft);
    expect(drafts.map((d) => d.id)).not.toContain(saved.id);
  });

  it('an explicit 0 with a remark does the same thing', async () => {
    const a = adminCtx(base);
    const saved = await saveEmployeeDraft(a, {
      data: draft({ basicSalary: '0', remarks: DIRECTOR_REMARK }),
      currentStep: 4,
    });
    const { employmentId } = await completeEmployeeDraft(a, saved.id);
    const [comp] = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.basicSalary).toBe('0.00');
  });

  it('A BLANK AMOUNT WITH NO REMARK CREATES NOTHING — not a person, not an employment', async () => {
    // THE ORDERING TRAP, AND WHY THE FORM RULE IS LOAD-BEARING. `completeEmployeeDraft` is NOT one
    // transaction (its own header says it cannot be): `hireEmployee` commits, then four writers run,
    // then `setCompensation`. A `SalaryRemarkRequiredError` arriving THERE would leave an employment
    // created, the draft still sitting beside it and the wizard showing raw English — the
    // half-activated state that whole file exists to prevent. So the relief and the requirement had to
    // land together, and this case is what proves the pre-flight catches it first.
    const a = adminCtx(base);
    const before = await counts();
    const saved = await saveEmployeeDraft(a, { data: draft({ basicSalary: '' }), currentStep: 4 });

    const err = await completeEmployeeDraft(a, saved.id).then(
      () => null,
      (e: Error) => e,
    );
    expect(err, 'activation must be refused').not.toBeNull();
    // Refused by the PRE-FLIGHT, which names the outstanding field — not by the compensation writer.
    expect(err!.message).toContain('Cannot create the employee yet');
    expect(err!.message).toContain('remarks');
    expect(err!.name).not.toBe('SalaryRemarkRequiredError');

    const after = await counts();
    expect(after.employments, 'no employment may survive a refused activation').toBe(before.employments);
    expect(after.people, 'no person may survive a refused activation').toBe(before.people);
    // The draft is still there, with the work still in it, which is the whole point of refusing early.
    const drafts = await owner.db.select({ id: schema.employeeDraft.id }).from(schema.employeeDraft);
    expect(drafts.map((d) => d.id)).toContain(saved.id);
  });

  it('a NEGATIVE amount still cannot be activated, and creates nothing either', async () => {
    const a = adminCtx(base);
    const before = await counts();
    const saved = await saveEmployeeDraft(a, {
      data: draft({ basicSalary: '-100', remarks: DIRECTOR_REMARK }),
      currentStep: 4,
    });
    await expect(completeEmployeeDraft(a, saved.id)).rejects.toThrow(/basicSalary/);
    const after = await counts();
    expect(after.employments).toBe(before.employments);
    expect(after.people).toBe(before.people);
  });

  it('a POSITIVE amount still activates and stores exactly what was typed', async () => {
    const a = adminCtx(base);
    const saved = await saveEmployeeDraft(a, { data: draft({ basicSalary: '5,200.50' }), currentStep: 4 });
    const { employmentId } = await completeEmployeeDraft(a, saved.id);
    const [comp] = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.basicSalary).toBe('5200.50');
    expect(comp.remarks).toBeNull();
  });
});

// ── §5 the sentences ─────────────────────────────────────────────────────────────────────────────
describe('§5 every sentence this round added, in all six locales', () => {
  it('the wizard strings exist everywhere and are really translated', () => {
    for (const loc of LOCALES) {
      const w = CATALOGUES[loc].people.wizard as unknown as {
        fields: Record<string, string>;
        hints: Record<string, string>;
      };
      for (const k of ['basicSalaryBlankPlaceholder', 'remarksNoBasicPlaceholder']) {
        expect(String(w.fields[k] ?? '').trim(), `${loc} people.wizard.fields.${k}`).not.toBe('');
      }
      expect(String(w.hints.noBasicSalary ?? '').trim(), `${loc} hints.noBasicSalary`).not.toBe('');
      if (loc !== 'en') {
        const e = CATALOGUES.en.people.wizard as unknown as {
          fields: Record<string, string>;
          hints: Record<string, string>;
        };
        expect(w.hints.noBasicSalary, `${loc} hints.noBasicSalary is still English`).not.toBe(
          e.hints.noBasicSalary,
        );
        expect(w.fields.basicSalaryBlankPlaceholder).not.toBe(e.fields.basicSalaryBlankPlaceholder);
        expect(w.fields.remarksNoBasicPlaceholder).not.toBe(e.fields.remarksNoBasicPlaceholder);
      }
    }
  });

  it('the Personnel hint and the THREE refusals are legible everywhere, not raw English', () => {
    // `payModeErrorMessage` used to translate exactly ONE error and return `(e as Error).message` for
    // everything else — so `SalaryRemarkRequiredError`, live since r369, reached HR as a paragraph
    // written for a developer in all six locales. This round makes the amount optional on both salary
    // forms, which turns that from a theoretical refusal into the one HR will actually meet.
    const KEYS = [
      'salaryNoBasicHint',
      'salaryRemarkRequiredError',
      'salaryNegativeError',
      'salaryNotANumberError',
    ] as const;
    for (const loc of LOCALES) {
      const d = CATALOGUES[loc].people.detail as unknown as Record<string, string>;
      for (const k of KEYS) {
        expect(String(d[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
        if (loc !== 'en') {
          const e = CATALOGUES.en.people.detail as unknown as Record<string, string>;
          expect(d[k], `${loc} people.detail.${k} is still English`).not.toBe(e[k]);
        }
      }
    }
  });

  it('every one of those keys is actually RENDERED or RESOLVED by a screen — no orphans', () => {
    const page = read(PERSONNEL_PAGE);
    expect(page).toContain("t('salaryNoBasicHint')");
    const actions = read(PERSONNEL_ACTIONS);
    for (const k of ['salaryRemarkRequiredError', 'salaryNegativeError', 'salaryNotANumberError']) {
      expect(actions, `people.detail.${k} is resolved by no screen`).toContain(`t('${k}')`);
    }
    const wizard = read(WIZARD);
    expect(wizard).toContain("t('hints.noBasicSalary')");
    expect(wizard).toContain("t('fields.basicSalaryBlankPlaceholder')");
    expect(wizard).toContain("t('fields.remarksNoBasicPlaceholder')");
    // `fields.remarks` is reached by the OUTSTANDING LIST's computed key — `t(`fields.${f}`)` — now that
    // the rule can return 'remarks'. A grep for a literal would never see it.
    expect(wizard).toContain('t(`fields.${f}`)');
    for (const loc of LOCALES) {
      const w = CATALOGUES[loc].people.wizard as unknown as { fields: Record<string, string> };
      expect(String(w.fields.remarks ?? '').trim(), `${loc} people.wizard.fields.remarks`).not.toBe('');
    }
  });

  it('each refusal is matched by `instanceof` OR by `name`, for all three errors', () => {
    // The `name` arm is not belt-and-braces: these classes live in `core/comp.ts`, and an error crossing
    // a module boundary a bundler duplicated fails `instanceof` while keeping its name.
    const actions = read(PERSONNEL_ACTIONS);
    for (const n of ['SalaryRemarkRequiredError', 'NegativeSalaryAmountError', 'NonFiniteSalaryAmountError']) {
      expect(actions).toContain(`e instanceof ${n}`);
      expect(actions).toContain(`name === '${n}'`);
    }
  });
});
