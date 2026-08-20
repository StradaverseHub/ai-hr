/**
 * ADR-0024 §7 — the multi-cycle statutory WORKSHEET (bdf7d248, r209).
 *
 * WHAT THESE TESTS ARE FOR. The ADR's own §7 scenario (RM5,000 salary + RM10,000 bonus) yields RM1,650
 * of employee EPF under BOTH readings of the statute, so it has stayed green throughout and can prove
 * nothing about which reading is in force. Every case below is built on RM5,001 + RM1,001 instead —
 * the smallest pair that separates them:
 *
 *   each run alone   epf(5,001) = 561  +  epf(1,001) = 113   →  674
 *   month as one     epf(5,001 normal, 1,001 additional)     →  671
 *
 * so a guard that cannot tell 674 from 671 is not guarding anything.
 *
 * THE MONTH-AS-ONE FIGURE MOVED FROM 672 TO 671 IN r210 (item bdf7d248), and the reason is worth
 * keeping: 672 was never a single lookup. It was band(5,001) = 561 plus ceil(1,001 × 11%) = 111 — the
 * schedule read for the salary and a straight percentage added for the bonus. The genuine single
 * lookup is on RM6,002, which is the RM6,100 row: ceil(11% × 6,100) = 671. So this file used to
 * separate "each run alone" from a THIRD reading that was neither, and now separates it from the one
 * the statute describes. The worksheet's own numbers are self-computing (`illustrationOf` calls `epf`),
 * so the screen followed the change without being edited.
 *
 * The suite pins four separate things:
 *   1. the arithmetic that distinguishes the readings, and that `computeMonthlyRuns` PASSES ITS OPTIONS
 *      THROUGH (the r209 widening — a hand-copied five-member subset used to drop `epfAge`,
 *      `epfCitizenship`, `subjectToSocso`/`subjectToSkbbk`, so a 60-year-old was computed as if they
 *      were not);
 *   2. that the worksheet, run over a month the LIVE kernel produced, reports it as already computed
 *      the month-as-one way — the answer the customer actually asked for, measured rather than assumed;
 *   3. that a month whose payslips carry the per-run-independent figures is reported as `would_change`
 *      with the exact ringgit movement per statutory item;
 *   4. that reversals and unreconstructable months are EXCLUDED/FLAGGED with a reason rather than
 *      clamped, and that the whole worksheet writes nothing.
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
import { epf, socso, eis, statutory, PCB_ZERO_ACC, type TaxProfile } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { computeMonthlyRuns } from '../localization/my/multicycle';
import {
  multiCycleWorksheetMY,
  WORKSHEET_ITEMS,
  WORKSHEET_SKIP_REASONS,
  WORKSHEET_VERDICTS,
  type Figures,
} from '../localization/my/multicycle-worksheet';
import { myPack } from '../localization/my';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const CFG = DEFAULT_MY_STATUTORY;
const profile: TaxProfile = { category: 1, children: 0 };
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('ADR-0024 §7 worksheet — the arithmetic that separates the two readings', () => {
  it('RM5,001 + RM1,001 distinguishes them; the ADR §7 pair RM5,000 + RM10,000 does not', () => {
    // The distinguishing pair.
    expect(epf(5001, 0, CFG.epf).employee).toBe(561);
    expect(epf(1001, 0, CFG.epf).employee).toBe(113);
    const perRun = round2(561 + 113);
    const monthAsOne = computeMonthlyRuns({
      month: 5,
      profile,
      priorAcc: PCB_ZERO_ACC,
      runs: [
        { runType: 'regular', payment: 5001 },
        { runType: 'bonus', payment: 1001 },
      ],
    }).monthly;
    expect(perRun).toBe(674);
    expect(monthAsOne.epfEmployee).toBe(671); // one lookup on RM6,002 → the RM6,100 row
    expect(perRun).not.toBe(monthAsOne.epfEmployee);

    // SOCSO/EIS are the bigger effect: charged TWICE by the per-run reading, ONCE by the month.
    expect(round2(socso(5001, 1, CFG.socso).employee + socso(1001, 1, CFG.socso).employee)).toBe(30.5);
    expect(monthAsOne.socsoEmployee).toBe(socso(5001, 1, CFG.socso).employee);
    expect(round2(eis(5001, CFG.eis).employee + eis(1001, CFG.eis).employee)).toBe(12.2);
    expect(monthAsOne.eisEmployee).toBe(eis(5001, CFG.eis).employee);

    // …and the degenerate ADR pair, stated so nobody re-adopts it as a guard: both readings give 1,650.
    const degenerate = computeMonthlyRuns({
      month: 5,
      profile,
      priorAcc: PCB_ZERO_ACC,
      runs: [
        { runType: 'regular', payment: 5000 },
        { runType: 'bonus', payment: 10000 },
      ],
    }).monthly;
    expect(round2(epf(5000, 0, CFG.epf).employee + epf(10000, 0, CFG.epf).employee)).toBe(1650);
    expect(degenerate.epfEmployee).toBe(1650);
  });

  /**
   * THE r209 WIDENING. `computeMonthlyRuns` declared its own five-member copy of the statutory option
   * bag — written when `statutory` had five options — so `epfAge`, `epfCitizenship`, `subjectToSocso`
   * and `subjectToSkbbk` could not be expressed at all and a 60-plus employee was computed on Part A
   * citizen rates with a full Category-1 SOCSO band. The fix is a pass-through of the pack's OWN option
   * type. This case fails the moment the options stop reaching `statutory`.
   */
  it('passes the full statutory option bag through — a 62-year-old is Part E, SOCSO second category', () => {
    const opts = { epfAge: 62, epfCitizenship: 'citizen' as const, socsoCategory: 2 as const, eisEligible: false };
    const viaRuns = computeMonthlyRuns({
      month: 5,
      profile,
      priorAcc: PCB_ZERO_ACC,
      opts,
      runs: [{ runType: 'regular', payment: 5001 }],
    }).monthly;
    const direct = statutory(5001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC }, opts);

    expect(viaRuns.epfEmployee).toBe(direct.epfEmployee);
    expect(viaRuns.epfEmployer).toBe(direct.epfEmployer);
    expect(viaRuns.socsoEmployer).toBe(direct.socsoEmployer);
    expect(viaRuns.eisEmployee).toBe(direct.eisEmployee);
    // The options must actually BITE: a 62-year-old is not on the under-60 citizen figures.
    const under60 = statutory(5001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC });
    expect(viaRuns.epfEmployee).not.toBe(under60.epfEmployee);
    expect(viaRuns.eisEmployee).toBe(0);
    expect(under60.eisEmployee).toBeGreaterThan(0);
  });

  /**
   * SKBBK (Lindung 24 Jam) is an EMPLOYEE deduction riding the SOCSO bands, and the kernel treats it as
   * a multi-cycle delta key like any other contribution (core/payroll.ts DELTA_KEYS). It was missing
   * from both `computeMonthlyRuns` and WORKSHEET_ITEMS, so the sign-off document silently omitted the
   * LARGER half of the employee-side SOCSO family. This case fails the moment it drops out again.
   */
  it('carries the SKBBK leg — charged ONCE for the month, and larger than the SOCSO employee share', () => {
    const band = socso(5001, 1, CFG.socso);
    const bonusBand = socso(1001, 1, CFG.socso);
    expect(WORKSHEET_ITEMS).toContain('socsoSkbbk');
    // It is not a rounding crumb: RM37.85 against the RM25.25 SOCSO employee share beside it.
    expect(band.skbbk).toBe(37.85);
    expect(band.skbbk).toBeGreaterThan(band.employee);

    const m = computeMonthlyRuns({
      month: 5,
      profile,
      priorAcc: PCB_ZERO_ACC,
      runs: [
        { runType: 'regular', payment: 5001 },
        { runType: 'bonus', payment: 1001 },
      ],
    });
    // Act 4 s.6(7) — one monthly contribution on the same bands: the bonus run adds RM0.
    expect(m.monthly.socsoSkbbk).toBe(band.skbbk);
    expect(m.runs[0].socsoSkbbk).toBe(band.skbbk);
    expect(m.runs[1].socsoSkbbk).toBe(0);
    // …while the per-run reading enters the bands twice. THAT gap is what the worksheet has to price.
    expect(round2(band.skbbk + bonusBand.skbbk)).toBe(45.7);
    expect(bonusBand.skbbk).toBe(7.85);
  });

  /**
   * WHY THE AGE REFERENCE DATE IS NOT COSMETIC. The kernel ages an employee at the PERIOD END; a replay
   * anchored earlier in the month reads a 29th/30th/31st birthday one year young. These two lines are
   * the whole consequence: Part A employee EPF versus Part E's zero, on the same wage in the same month.
   */
  it('one year of age is the difference between RM561 of employee EPF and none at all', () => {
    const at59 = statutory(5001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC }, { epfAge: 59 });
    const at60 = statutory(5001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC }, { epfAge: 60 });
    expect(at59.epfEmployee).toBe(561);
    expect(at60.epfEmployee).toBe(0); // EPF Part E — senior citizens contribute no employee share
    expect(at59.eisEmployee).toBeGreaterThan(0);
  });

  it('the MY pack exposes the worksheet, so a screen never imports the pack implementation', () => {
    expect(typeof myPack.payroll.multiCycleWorksheet).toBe('function');
  });
});

/**
 * THE CONTRACT BETWEEN THE PAGE AND THE CATALOGS, pinned from BOTH ends.
 *
 * The screen builds four of its label keys dynamically — `item.${…}`, `verdict.${…}`, `reason.${…}`,
 * `runType.${…}` — and test/i18n-coverage.test.ts says in its own header that dynamic keys are the one
 * class it cannot check. So a new skip reason with no message would ship as the literal string
 * "reason.inconsistent_run_bases" on a document an accountant is being asked to sign, and every unit test
 * of either half would stay green. These cases read the page SOURCE and the six catalogs together.
 */
describe('ADR-0024 §7 worksheet — the screen and the message catalogs agree', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pageSrc = readFileSync(`${root}app/payroll/multi-cycle-worksheet/page.tsx`, 'utf8');
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalogs = LOCALES.map((loc) => ({
    loc,
    ns: JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8')).payroll.multiCycleWorksheet as Record<
      string,
      Record<string, string>
    >,
  }));

  it('every dynamically-built label key exists in all six catalogs', () => {
    const families: Array<[string, readonly string[]]> = [
      ['item', WORKSHEET_ITEMS],
      ['verdict', WORKSHEET_VERDICTS],
      ['reason', WORKSHEET_SKIP_REASONS],
      ['runType', ['regular', 'off_cycle', 'bonus', 'adjustment']],
      ['col', ['paid', 'perRun', 'monthAsOne']], // the three readings, keyed off the reading name
    ];
    const missing: string[] = [];
    for (const [prefix, members] of families) {
      for (const m of members) {
        for (const { loc, ns } of catalogs) {
          if (typeof ns?.[prefix]?.[m] !== 'string') missing.push(`${loc}: payroll.multiCycleWorksheet.${prefix}.${m}`);
        }
      }
    }
    expect(missing, `dynamic label keys with no translation:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the page builds its keys from exactly these families — a renamed prefix fails here', () => {
    // `t(`item.${…}`)` and friends, as the page actually writes them.
    const prefixes = [...pageSrc.matchAll(/t\(`([a-zA-Z]+)\.\$\{/g)].map((m) => m[1]).sort();
    expect([...new Set(prefixes)]).toEqual(['col', 'item', 'reason', 'runType', 'verdict']);
  });

  it('the page renders every statutory item the worksheet computes, in one fixed order', () => {
    // The page keeps its own literal ITEMS array (it must not import the MY pack — ADR-0080 D7), so the
    // two lists are pinned against each other here rather than trusted to stay in step.
    const declared = /const ITEMS: WorksheetItem\[\] = \[([\s\S]*?)\];/.exec(pageSrc)?.[1] ?? '';
    const names = [...declared.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...WORKSHEET_ITEMS]);
  });
});

describe('ADR-0024 §7 worksheet — replayed over real payroll history', () => {
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

  /** A May 2026 month with a regular RM5,001 run and a RM1,001 bonus run, produced by the real kernel.
   *  `dob` stamps the person's date of birth — the input the age-dependent statutory rules key off. */
  async function seedMonth(p: { bonus?: number; dob?: string } = {}) {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Worksheet Subject', primaryEmail: 'ws@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    if (p.dob) {
      await owner.db.update(schema.person).set({ dateOfBirth: p.dob }).where(eq(schema.person.id, e.personId));
    }
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5001,
      monthlyAllowance: 0,
      effectiveFrom: '2025-01-01',
    });
    // SKBBK ON, because that is what the customer's data looks like: `subject_to_skbbk` defaults FALSE
    // for a brand-new row, but migration 0198 backfilled every EXISTING employee to true so their live
    // SKBBK was preserved. A fixture on the new-row default would leave `socsoSkbbk` at zero in all
    // three readings and quietly stop testing that leg at all.
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234', subjectToSkbbk: true });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
    });
    await setPayrollInput(a, {
      batchId: extra.batchId,
      employmentId: e.employmentId,
      overtimeAmount: 0,
      bonusAmount: p.bonus ?? 1001,
    });
    await generatePayslips(a, { batchId: extra.batchId });
    return { a, e, regBatchId: reg.batchId, extraBatchId: extra.batchId };
  }

  const slipOf = async (batchId: string) => {
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return ps;
  };
  const patchStatutory = async (batchId: string, patch: Record<string, unknown>) => {
    const ps = await slipOf(batchId);
    await owner.db
      .update(schema.payslip)
      .set({ statutory: { ...(ps.statutory as Record<string, unknown>), ...patch } })
      .where(eq(schema.payslip.id, ps.id));
  };

  it('a month the live kernel produced is reported as ALREADY computed the month-as-one way', async () => {
    const { a } = await seedMonth();
    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });

    expect(w.periodsWithMultipleRuns).toBe(1);
    expect(w.employeeMonthsExamined).toBe(1);
    expect(w.employeeMonthsCompared).toBe(1);
    expect(w.employeeMonthsExcluded).toBe(0);
    expect(w.employeeMonthsFlagged).toBe(0);

    const [row] = w.rows;
    // The kernel already computes an additional run as the INCREMENT of the cumulative month
    // (core/payroll.ts `deltaStat`), so what was paid is the month-as-one figure, not the per-run one.
    // THIS is the customer's answer, and the worksheet reaches it by measurement, not assertion.
    expect(row.verdict).toBe('already_aggregated');
    expect(row.paid.epfEmployee).toBe(671);
    expect(row.monthAsOne.epfEmployee).toBe(671);
    expect(row.perRun.epfEmployee).toBe(674);
    expect(row.difference.epfEmployee).toBe(0);
    // One SOCSO/EIS contribution for the month (Act 4 s.6(7)/6(9)) — the per-run reading charges two.
    expect(row.paid.socsoEmployee).toBe(socso(5001, 1, CFG.socso).employee);
    expect(row.perRun.socsoEmployee).toBe(30.5);
    expect(w.verdicts.would_change).toBe(0);
    for (const k of WORKSHEET_ITEMS) expect(w.movement[k]).toBe(0);

    // The worked example on screen is computed from the tables in force, not written down.
    expect(w.illustration.perRunTotal.employee).toBe(674);
    expect(w.illustration.monthAsOneTotal.employee).toBe(671);
    expect(w.illustration.version).toBe(w.replayVersion);
  });

  it('a month carrying the per-run figures is WOULD_CHANGE, with the exact movement per item', async () => {
    const { a, regBatchId, extraBatchId } = await seedMonth();
    // Rewrite the two payslips to what the "each run alone" reading would have produced — the situation
    // the customer feared. Nothing else about the month changes, so the ONLY thing under test is whether
    // the worksheet recognises the reading and prices the difference.
    const alone1 = statutory(5001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC });
    const alone2 = statutory(1001, profile, 0, 0, { month: 5, acc: PCB_ZERO_ACC });
    const pick = (s: Record<string, unknown>) =>
      Object.fromEntries(WORKSHEET_ITEMS.map((k) => [k, s[k]])) as unknown as Record<string, unknown>;
    await patchStatutory(regBatchId, pick(alone1 as unknown as Record<string, unknown>));
    await patchStatutory(extraBatchId, pick(alone2 as unknown as Record<string, unknown>));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    const [row] = w.rows;
    expect(row.verdict).toBe('would_change');
    expect(row.paid.epfEmployee).toBe(674);
    expect(row.monthAsOne.epfEmployee).toBe(671);

    // The headline the customer asked for: how much would move, item by item.
    const expected: Partial<Figures> = {
      // -3 since bdf7d248 (r210): the month as one is 671, not the 672 the old split reading gave.
      epfEmployee: -3,
      epfEmployer: round2(epf(5001, 1001, CFG.epf).employer - (epf(5001, 0, CFG.epf).employer + epf(1001, 0, CFG.epf).employer)),
      socsoEmployee: round2(socso(5001, 1, CFG.socso).employee - (socso(5001, 1, CFG.socso).employee + socso(1001, 1, CFG.socso).employee)),
      eisEmployee: round2(eis(5001, CFG.eis).employee - (eis(5001, CFG.eis).employee + eis(1001, CFG.eis).employee)),
    };
    expect(row.difference.epfEmployee).toBe(expected.epfEmployee);
    expect(row.difference.epfEmployer).toBe(expected.epfEmployer);
    expect(row.difference.socsoEmployee).toBe(expected.socsoEmployee);
    expect(row.difference.eisEmployee).toBe(expected.eisEmployee);
    expect(row.difference.socsoEmployee).toBe(-5.25);
    expect(row.difference.eisEmployee).toBe(-2.1);
    // SKBBK is part of that answer, not an afterthought. It is deducted from the EMPLOYEE, it is banded
    // monthly exactly as SOCSO is, and at this wage it is BIGGER than the SOCSO employee share: a
    // worksheet that priced -5.25 of SOCSO employee movement and stayed silent about -7.85 of SKBBK
    // understated the employee-side SOCSO family by ~60% on the document being signed.
    expect(row.paid.socsoSkbbk).toBe(round2(socso(5001, 1, CFG.socso).skbbk + socso(1001, 1, CFG.socso).skbbk));
    expect(row.monthAsOne.socsoSkbbk).toBe(socso(5001, 1, CFG.socso).skbbk);
    expect(row.difference.socsoSkbbk).toBe(-7.85);
    expect(Math.abs(row.difference.socsoSkbbk)).toBeGreaterThan(Math.abs(row.difference.socsoEmployee));
    // The month-level totals are the per-employee movement, because there is exactly one such month.
    expect(w.verdicts.would_change).toBe(1);
    expect(w.movement.epfEmployee).toBe(-3);
    expect(w.movement.socsoEmployee).toBe(-5.25);
    expect(w.movement.socsoSkbbk).toBe(-7.85);
  });

  /**
   * THE AGE REFERENCE DATE. The kernel ages an employee at the PERIOD END (core/payroll.ts `periodEnd`
   * = the last day of the pay month). This subject turns 60 on 2026-05-30 — inside the month, after any
   * mid-month anchor — so the kernel wrote May's payslips on EPF Part E (employee share 0), SOCSO
   * Category 2 and EIS zero. A replay that aged them at, say, the 28th would model a 59-year-old on
   * Part A / Category 1 / EIS-eligible figures, match neither reading, and print a fabricated ringgit
   * difference NEAR THE TOP of the sign-off document (`unexplained` sorts second).
   */
  it('an employee who turns 60 mid-month is aged at the PERIOD END, exactly as the kernel ages them', async () => {
    const { a } = await seedMonth({ dob: '1966-05-30' });
    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });

    expect(w.employeeMonthsCompared).toBe(1);
    const [row] = w.rows;
    expect(row.verdict).toBe('already_aggregated');
    expect(w.verdicts.unexplained).toBe(0);

    // The age really bit — this is a 60-year-old's month under every reading, not a 59-year-old's.
    expect(row.paid.epfEmployee).toBe(0); // Part E: no employee share at all (a 59-year-old pays 561)
    expect(row.monthAsOne.epfEmployee).toBe(0);
    expect(row.perRun.epfEmployee).toBe(0);
    expect(row.paid.eisEmployee).toBe(0); // Act 800 is 18–60 only
    expect(row.paid.socsoEmployer).toBe(socso(5001, 2, CFG.socso).employer); // Category 2, injury-only
    expect(row.paid.socsoEmployer).not.toBe(socso(5001, 1, CFG.socso).employer);
    // …and the replay explains the month exactly, item by item.
    for (const k of WORKSHEET_ITEMS) expect(row.difference[k]).toBe(0);
    for (const k of WORKSHEET_ITEMS) expect(w.movement[k]).toBe(0);
  });

  it('a month containing a negative amount is EXCLUDED with a reason, never clamped to zero', async () => {
    const { a, extraBatchId } = await seedMonth();
    // A reversal: ADR-0024 §6 puts these out of scope, and `computeMonthlyRuns` clamps a negative delta
    // at zero — so counting the month would understate the difference and the worksheet would be quietly
    // wrong. It must drop out with a stated reason instead.
    const ps = await slipOf(extraBatchId);
    await owner.db.update(schema.payslip).set({ bonus: '-500.00' }).where(eq(schema.payslip.id, ps.id));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    expect(w.employeeMonthsExamined).toBe(1);
    expect(w.employeeMonthsCompared).toBe(0);
    expect(w.employeeMonthsExcluded).toBe(1);
    expect(w.skips).toHaveLength(1);
    expect(w.skips[0].reason).toBe('negative_amount');
    expect(w.skips[0].excluded).toBe(true);
    expect(w.skipCounts.negative_amount).toBe(1);
    for (const k of WORKSHEET_ITEMS) expect(w.movement[k]).toBe(0);
  });

  it('a month whose charged bases were never recorded is FLAGGED, not assumed', async () => {
    const { a, extraBatchId } = await seedMonth();
    const ps = await slipOf(extraBatchId);
    const withoutBases = { ...(ps.statutory as Record<string, unknown>) };
    delete withoutBases.bases;
    await owner.db.update(schema.payslip).set({ statutory: withoutBases }).where(eq(schema.payslip.id, ps.id));

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    expect(w.employeeMonthsCompared).toBe(0);
    expect(w.employeeMonthsFlagged).toBe(1);
    expect(w.employeeMonthsExcluded).toBe(0);
    expect(w.skips[0].reason).toBe('bases_not_recorded');
    expect(w.skips[0].excluded).toBe(false);
  });

  it('writes nothing — every payslip row is byte-identical after the worksheet runs', async () => {
    const { a } = await seedMonth();
    const before = await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id);
    const beforeBatches = await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);
    await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    const after = await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id);
    const afterBatches = await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);
    expect(after).toEqual(before);
    expect(afterBatches).toEqual(beforeBatches);
    // Belt and braces on the one column a recompute would always move.
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
  });

  it('a company-month with only ONE run is not an employee-month of this worksheet', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Single Run', primaryEmail: 'single@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5001, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });

    const w = await multiCycleWorksheetMY(a, { companyIds: [base.companyId] });
    expect(w.periodsWithMultipleRuns).toBe(0);
    expect(w.employeeMonthsExamined).toBe(0);
    expect(w.rows).toEqual([]);
    // The illustration is still produced — the screen must be able to show the working with no data.
    expect(w.illustration.perRunTotal.employee).toBe(674);
  });
});
