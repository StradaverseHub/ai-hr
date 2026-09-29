/**
 * Feedback 6b4ca488 part 2 — the Statutory Explanation.
 *
 * WHAT THIS FILE GUARDS, in the order the failures would hurt:
 *
 *   1. THE EXPLANATION NEVER RECOMPUTES. Every figure comes off the payslip's OWN `statutory` blob. The
 *      structural guarantee is the signature — `explainStatutory(statutory, runType)` takes no
 *      SessionContext and imports nothing that could reach a database, a statutory pack or today's
 *      configuration — so that is asserted at SOURCE as well as behaviourally. A screen that recomputes
 *      passes every arithmetic test on the day it ships and starts contradicting the payslip beside it
 *      the first time a rate changes, which is precisely the outcome the approved plan calls the worst
 *      possible one.
 *
 *   2. A PRE-r187 PAYSLIP IS FLAGGED, NOT FILLED IN. `statutory.bases` is stamped only from r187 and is
 *      present on a MINORITY of rows. Those must report `base: null` / `workingNotRecorded: true` and
 *      must NEVER be substituted from gross pay. The test hands the explainer a blob carrying a gross
 *      figure and asserts the gross does not appear anywhere in the result — the only formulation that
 *      catches "it quietly fell back".
 *
 *   3. THE FILED SHARE IS NOT REDUCED BY AN EMPLOYER-BEARS ELECTION. KWSP / PERKESO / LHDN submissions
 *      carry the full employee share; only take-home is reduced. Both figures are reported, and the
 *      test pins which is which.
 *
 *   4. ONE DISPLAY, TWO DOORS. /payroll/statutory-detail and Transaction View's ?tab=statutory must both
 *      mount the SAME component. Two displays of one calculation are free to drift, which is the reason
 *      45df860a gave for consolidating the PCB working, and it applies identically here.
 *
 *   5. A HAND-SET FIGURE IS NEVER CREDITED TO A RULE (208beb8b). `applyStatutoryAdjustment` can set any of
 *      NINE statutory lines by hand; this module never read the stamp, so RM500 typed onto a RM3,000 EPF
 *      base was reported as the KWSP Third Schedule at an effective 16.67%. Every case below comes in a
 *      PAIR — the stamped blob and the SAME blob without the stamp — because an assertion that a rate is
 *      null passes on any broken read, including one that lost the figures altogether. The partner proves
 *      the rate is exactly what the code would otherwise have printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATUTORY_EXPLAIN_KEYS,
  explainStatutory,
  isSetByHand,
  statutoryProvenance,
  type StatutoryExplainKey,
} from '../core/statutory-explain';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** A post-r187 blob: the shape core/payroll.ts stamps, with `bases` present. */
const STAMPED = {
  version: '2026.5',
  epfEmployee: 561, // 11% of 5100
  epfEmployer: 663, // 13% of 5100
  socsoEmployee: 24.75,
  socsoEmployer: 86.65,
  socsoSkbbk: 2.5,
  eisEmployee: 9.9,
  eisEmployer: 9.9,
  hrdf: 51,
  pcb: 320,
  bases: { epf: 5000, epfAdditional: 100, socsoEis: 5000, pcb: 5100, hrdf: 5100 },
};

/** The same amounts on a run that predates the `bases` stamp. `grossPay` is deliberately present and
 *  large: it is the figure a careless fallback would reach for. */
const UNSTAMPED = {
  version: '2026.1',
  epfEmployee: 561,
  epfEmployer: 663,
  socsoEmployee: 24.75,
  socsoEmployer: 86.65,
  socsoSkbbk: 2.5,
  eisEmployee: 9.9,
  eisEmployer: 9.9,
  hrdf: 51,
  pcb: 320,
  grossPay: 9999.99,
};

const byKey = (statutory: unknown, runType = 'regular') => {
  const e = explainStatutory(statutory, runType);
  return Object.fromEntries(e.items.map((i) => [i.key, i])) as Record<
    StatutoryExplainKey,
    (typeof e.items)[number]
  >;
};

describe('6b4ca488 — the six statutory items, read from the payslip’s own stamp', () => {
  it('covers exactly EPF, SOCSO, SKBBK, EIS, HRDF and PCB, in that order', () => {
    // The request names six. A seventh appearing, or one silently dropping out, is a change to what the
    // screen claims to explain — so the set is exact, not a superset match.
    expect([...STATUTORY_EXPLAIN_KEYS]).toEqual(['epf', 'socso', 'skbbk', 'eis', 'hrdf', 'pcb']);
    expect(explainStatutory(STAMPED, 'regular').items.map((i) => i.key)).toEqual([
      'epf',
      'socso',
      'skbbk',
      'eis',
      'hrdf',
      'pcb',
    ]);
  });

  it('takes each item’s wage base from the run’s own `bases`, not from any earnings figure', () => {
    const i = byKey(STAMPED);
    expect(i.epf.base, 'EPF is charged on the normal stream').toBe(5000);
    expect(i.epf.additionalBase, 'and the bonus stream separately').toBe(100);
    // SOCSO, EIS and SKBBK share ONE recorded base — they are three legs of one PERKESO wage.
    expect(i.socso.base).toBe(5000);
    expect(i.eis.base).toBe(5000);
    expect(i.skbbk.base).toBe(5000);
    expect(i.hrdf.base).toBe(5100);
    expect(i.pcb.base).toBe(5100);
    expect(explainStatutory(STAMPED, 'regular').basesNotRecorded).toBe(false);
  });

  it('gives every surface ONE "statutory wage" figure — EPF’s two streams included', () => {
    // FOUND BY RENDERING THIS SCREEN, not by reading it. EPF is the only item with two streams, and the
    // first cut had the summary column print `base` (5,000) while the working line beside it read
    // "5,100 × 11.00% = 561.00" and the Excel column exported 5,100. A table that disagrees with the
    // formula under it is precisely the confusion this screen was built to end, so the sum is derived
    // ONCE, here, and the three surfaces read it rather than each adding up for themselves.
    const i = byKey(STAMPED);
    expect(i.epf.totalBase, 'normal + additional, the wage the 11% was actually charged on').toBe(5100);
    // Every other item has one stream, so its total IS its base — no silent divergence to hide behind.
    for (const k of ['socso', 'skbbk', 'eis', 'hrdf', 'pcb'] as const) {
      expect(i[k].totalBase, `${k} has one stream`).toBe(i[k].base);
    }
    // …and the effective rate is derived over the SAME figure, which is what keeps the check percentage
    // beside the working consistent with the wage the summary column prints.
    expect(i.epf.employeeReported / i.epf.totalBase!).toBeCloseTo(i.epf.effectiveEmployeeRate!, 9);
    // An unrecorded base stays unrecorded — the sum must not turn a null into a 0.
    expect(explainStatutory(UNSTAMPED, 'regular').items.every((x) => x.totalBase === null)).toBe(true);
  });

  it('reports the KIND of rule, so a schedule lookup is never dressed up as a percentage', () => {
    const i = byKey(STAMPED);
    // The HRD Corp levy really is a percentage of a wage. It is the ONLY one of the six that is.
    expect(i.hrdf.ruleKind).toBe('rate');
    // PERKESO pays from a contribution SCHEDULE (a wage band), which disagrees with any flat percentage
    // by cents for almost every wage. Calling these 'rate' would put a false working on screen.
    expect(i.socso.ruleKind).toBe('schedule');
    expect(i.eis.ruleKind).toBe('schedule');
    expect(i.skbbk.ruleKind).toBe('schedule');
    // …and so does EPF, off the KWSP Third Schedule — see the dedicated case below for why.
    expect(i.epf.ruleKind).toBe('schedule');
    // Income tax is not expressible as a rate at all — reliefs, accumulators and a table.
    expect(i.pcb.ruleKind).toBe('mtd');
  });

  it('classifies EPF as a KWSP THIRD SCHEDULE lookup, not "percentage of wage"', () => {
    // THE DEFECT THIS PINS. EPF shipped as ruleKind 'rate', so the screen's summary said "Percentage of
    // wage" for the largest deduction on a Malaysian payslip and printed a multiplication beside it. The
    // kernel does no such thing: for every monthly wage up to RM20,000 it looks the wage up in the EPF
    // Act 1991 Third Schedule Part A BAND table (localization/my/payroll.ts `bandFor(partA, wage)` over
    // localization/my/statutory-tables.ts's `buildEpfThirdSchedulePartA`), exactly as SOCSO/EIS/SKBBK
    // use PERKESO's — which is why that file's own comment says in caps that the contribution is NOT a
    // flat percentage of the exact wage.
    //
    // THE REPRODUCTION, and the reason it is this wage: 2,990 falls in the 3,000 band, so the employee
    // pays ceil(11% × 3,000) = 330 and the employer ceil(13% × 3,000) = 390. A percentage of the EXACT
    // wage would be 328.90 / 388.70. The screen therefore printed "2,990.00 × 11.04% = 330.00", a
    // product that does not evaluate, under the caption "the rate this run actually applied".
    const banded = {
      ...STAMPED,
      epfEmployee: 330,
      epfEmployer: 390,
      bases: { ...STAMPED.bases, epf: 2990, epfAdditional: 0 },
    };
    const i = byKey(banded);
    expect(i.epf.ruleKind, 'EPF is a band lookup, so it must be captioned as one').toBe('schedule');
    expect(i.epf.totalBase).toBe(2990);
    expect(i.epf.employeeReported).toBe(330);
    // The derived percentage is NOT the statutory 11% — 330 / 2,990 = 11.0368…% — which is precisely
    // why it may only ever be presented as an effective check figure.
    expect(i.epf.effectiveEmployeeRate!, 'a band amount over the exact wage is not the statutory rate')
      .not.toBeCloseTo(0.11, 4);
    expect(i.epf.effectiveEmployeeRate!).toBeCloseTo(330 / 2990, 9);
  });

  it('derives the effective rate from the two numbers the run wrote down, and nothing else', () => {
    const i = byKey(STAMPED);
    // 561 / (5000 + 100) = 11%. The rate was never persisted; this is arithmetic ON the recorded
    // figures, which is why it cannot disagree with the amount printed beside it.
    expect(i.epf.effectiveEmployeeRate!).toBeCloseTo(0.11, 6);
    expect(i.epf.effectiveEmployerRate!).toBeCloseTo(663 / 5100, 6);
    expect(i.hrdf.effectiveEmployerRate!).toBeCloseTo(51 / 5100, 6);
    // Employee-only and employer-only items: the missing side is 0, and 0 over a real base is a real 0%.
    expect(i.hrdf.employeeReported).toBe(0);
    expect(i.skbbk.employer).toBe(0);
    expect(i.pcb.employer).toBe(0);
  });

  it('marks the employee-only and employer-only items as such rather than leaving them blank', () => {
    const i = byKey(STAMPED);
    expect(i.skbbk.employeeReported, 'SKBBK is an employee-side leg of the PERKESO schedule').toBe(2.5);
    expect(i.hrdf.employer, 'the levy is the employer’s alone').toBe(51);
    expect(i.pcb.employeeReported).toBe(320);
  });
});

describe('6b4ca488 — a payslip written before the wage bases were stamped', () => {
  it('says the working was not recorded and does NOT fall back to gross', () => {
    // THE ASSERTION THAT MATTERS. `grossPay: 9999.99` sits in the blob precisely so a fallback would be
    // visible. Every base must be null and the flag set; the amounts are still reported, because those
    // WERE recorded and are what was actually deducted.
    const e = explainStatutory(UNSTAMPED, 'regular');
    expect(e.basesNotRecorded, 'one honest banner instead of six repeated caveats').toBe(true);
    for (const item of e.items) {
      expect(item.base, `${item.key}: an unrecorded wage is null, never a number`).toBeNull();
      expect(item.additionalBase, `${item.key}: and so is the additional stream`).toBeNull();
      expect(item.workingNotRecorded, `${item.key} must be flagged`).toBe(true);
      // A rate over an unknown wage is not a number. 0 would read as "exempt", a different statement.
      expect(item.effectiveEmployeeRate, `${item.key}: no wage, no rate`).toBeNull();
      expect(item.effectiveEmployerRate).toBeNull();
    }
    // Belt and braces against a fallback introduced anywhere in the shape: the gross must not appear.
    expect(JSON.stringify(e)).not.toContain('9999.99');
    // The amounts survive — the payslip's own figures are not what is missing.
    expect(e.items.find((i) => i.key === 'epf')!.employeeReported).toBe(561);
    expect(e.totals.employeeReported).toBeCloseTo(561 + 24.75 + 2.5 + 9.9 + 0 + 320, 2);
  });

  it('a blob with a garbage `bases` degrades to "not recorded" rather than throwing', () => {
    // `statutory` is plain jsonb with no validator, and this renders on a payslip screen.
    for (const bad of [null, undefined, 0, 'x', [] as unknown]) {
      const e = explainStatutory({ ...UNSTAMPED, bases: bad }, 'regular');
      expect(e.items.every((i) => i.base == null || typeof i.base === 'number')).toBe(true);
    }
    expect(() => explainStatutory(null, 'regular')).not.toThrow();
    expect(explainStatutory(null, 'regular').basesNotRecorded).toBe(true);
  });
});

describe('6b4ca488 — an employer-bears election reduces take-home, never the filed share', () => {
  it('reports both figures and keeps them distinct', () => {
    const borne = { ...STAMPED, employerBorne: { epf: 561, socso: 24.75, skbbk: 0, eis: 0, tax: 0 } };
    const i = byKey(borne);
    // KWSP still receives the full employee share; that is what the statutory forms file.
    expect(i.epf.employeeReported, 'the FILED share is untouched').toBe(561);
    expect(i.epf.employerBorne).toBe(561);
    expect(i.epf.employeeTakeHome, 'nothing came off take-home').toBe(0);
    expect(i.socso.employeeReported).toBe(24.75);
    expect(i.socso.employeeTakeHome).toBe(0);
    // Untouched items are unchanged — an election on two components must not restate the other four.
    expect(i.pcb.employerBorne).toBe(0);
    expect(i.pcb.employeeTakeHome).toBe(320);

    const e = explainStatutory(borne, 'regular');
    expect(e.employerBorne.any).toBe(true);
    expect(e.totals.employerBorne).toBeCloseTo(561 + 24.75, 2);
    expect(e.totals.employeeTakeHome).toBeCloseTo(e.totals.employeeReported - e.totals.employerBorne, 2);
  });

  it('a payslip with no election takes the identity path — take-home IS the filed share', () => {
    const e = explainStatutory(STAMPED, 'regular');
    expect(e.employerBorne.any).toBe(false);
    expect(e.totals.employerBorne).toBe(0);
    expect(e.totals.employeeTakeHome).toBeCloseTo(e.totals.employeeReported, 2);
  });
});

describe('6b4ca488 — an additional run’s bases describe the whole month', () => {
  it('flags a bonus / off-cycle / adjustment run, and does NOT flag a regular one', () => {
    // A0006's 2026-01 bonus payslip is all zeros yet stamps an EPF base of 5,100. Unflagged, the screen
    // would appear to charge a wage the slip beside it does not show.
    expect(explainStatutory(STAMPED, 'regular').basesCoverWholeMonth).toBe(false);
    for (const rt of ['bonus', 'off_cycle', 'adjustment']) {
      expect(explainStatutory(STAMPED, rt).basesCoverWholeMonth, `${rt} is an additional run`).toBe(true);
    }
  });

  it('derives NO effective rate on one — the amount is a delta over a cumulative wage', () => {
    // THE DEFECT THIS PINS. An additional run stamps THIS RUN'S INCREMENT as the amount (`deltaStat`,
    // core/payroll.ts:412, `max(0, now − before)`) against the CUMULATIVE MONTH as the base
    // (core/payroll.ts:4890). Dividing one by the other produced a percentage that is not any statutory
    // rate, captioned "the rate this run actually applied".
    //
    // THE REPRODUCTION: RM5,000 basic already run, then a RM10,000 bonus run. That slip stamps
    // epf 5,000 + epfAdditional 10,000 (15,000 together) and epfEmployee 1,100 — the delta, being
    // ceil(11% × 10,000) — so the screen printed "15,000.00 × 7.33% = 1,100.00". No EPF employee rate
    // is 7.33%.
    const bonusRun = {
      ...STAMPED,
      epfEmployee: 1100,
      epfEmployer: 1200,
      bases: { epf: 5000, epfAdditional: 10000, socsoEis: 5000, pcb: 15000, hrdf: 0 },
    };
    const i = byKey(bonusRun, 'bonus');
    // The two figures are still REPORTED — they are what the run wrote down, and the screen shows both.
    expect(i.epf.totalBase, 'the cumulative month, as stamped').toBe(15000);
    expect(i.epf.employeeReported, 'this run’s increment, as stamped').toBe(1100);
    // What must NOT exist is a rate between them.
    expect(i.epf.effectiveEmployeeRate, 'an increment over a cumulative wage is not a rate').toBeNull();
    expect(i.epf.effectiveEmployerRate).toBeNull();
    // Every item, on every additional cycle — EPF is merely the loudest case.
    for (const rt of ['bonus', 'off_cycle', 'adjustment']) {
      for (const item of explainStatutory(bonusRun, rt).items) {
        expect(item.effectiveEmployeeRate, `${rt}/${item.key}`).toBeNull();
        expect(item.effectiveEmployerRate, `${rt}/${item.key}`).toBeNull();
      }
    }
    // …and the SAME blob on a REGULAR run still derives one, so this is the run type suppressing a rate
    // that is meaningless, not the derivation quietly ceasing to work.
    expect(byKey(bonusRun, 'regular').epf.effectiveEmployeeRate!).toBeCloseTo(1100 / 15000, 9);
  });

  it('carries the statutory ruleset version the run stamped, and null when it predates it', () => {
    expect(explainStatutory(STAMPED, 'regular').rulesetVersion).toBe('2026.5');
    expect(explainStatutory({ ...STAMPED, version: undefined }, 'regular').rulesetVersion).toBeNull();
  });
});

describe('6b4ca488 — the explanation STRUCTURALLY cannot recompute', () => {
  it('the derivation reaches no database, no pack and no live configuration', () => {
    // THE GUARANTEE IS THE IMPORT LIST, not a promise in a comment. A module that could reach a session,
    // the statutory packs or the payroll kernel could recompute, and a recomputed explanation that
    // disagrees with the payslip beside it is what the approved plan calls the worst possible outcome.
    // Comments are stripped first: this file's own header NAMES the things it must not import.
    const src = code('core/statutory-explain.ts');
    for (const forbidden of [
      "from '../db/",
      "from './payroll'",
      "from './payroll-view'",
      "from './pay-components'",
      "from '../localization/",
      "from '../packs/",
      'SessionContext',
      'withTenant',
    ]) {
      expect(src, `core/statutory-explain.ts must not reach ${forbidden}`).not.toContain(forbidden);
    }
    // …and positively: it reads the payslip's own stamp through the kernel's own accessors.
    expect(src).toContain('payslipStatutoryBases');
    expect(src).toContain('payslipEmployerBorne');
    // The signature takes the BLOB, not a row and not a context — the type-level half of the same fence.
    expect(src).toMatch(/export function explainStatutory\(statutory: unknown, runType: string\)/);
  });

  it('every surface builds the explanation from the payslip it is showing, through this one function', () => {
    // Three consumers, one derivation. A fourth that assembled the six items itself would be free to
    // drift from the screen it claims to reproduce — the failure the export route's header forbids.
    for (const rel of [
      'app/payroll/statutory-detail/page.tsx',
      'app/payroll/statutory-detail/export/route.ts',
      'app/payroll/transaction-view/page.tsx',
    ]) {
      expect(code(rel), `${rel} must derive through explainStatutory`).toContain('explainStatutory(');
    }
  });

  it('ONE display: both doors mount the same component, and the export reuses the shared serializer', () => {
    // 45df860a's rule, applied to the other five bodies: two displays of one calculation drift.
    expect(code('app/payroll/statutory-detail/page.tsx')).toContain('StatutoryDetailView');
    expect(code('app/payroll/transaction-view/page.tsx'), 'the tab must not render its own version').toContain(
      "import { StatutoryDetailView } from '../statutory-detail/statutory-detail-view'",
    );
    // The plan says reuse the existing grid-export route pattern rather than writing a new exporter.
    const exp = code('app/payroll/statutory-detail/export/route.ts');
    expect(exp, 'reuse the shared xlsx serializer').toContain('toXlsxReport');
    expect(exp, 'and the same scope fence the page uses').toContain('scopedAdmin');
    expect(exp, 'the payslip id is re-guarded through the SAME read, not trusted').toContain('payslipForReview');
    // An unrecorded wage base must export as an EMPTY cell. In a spreadsheet a wrong zero sums, charts
    // and gets filed, and nothing on the sheet says it was a guess.
    expect(exp).toMatch(/i\.totalBase == null \? '' :/);
    // And the file's wage column is the SAME derived figure the screen's summary column shows, not a sum
    // the route does for itself — see the `totalBase` case above for the drift that caused.
    expect(exp, 'the export must not re-add EPF’s two streams on its own').not.toContain('additionalBase');
  });

  it('the PCB working is linked, never rebuilt — one MTD display in the product', () => {
    const view = code('app/payroll/statutory-detail/statutory-detail-view.tsx');
    expect(view, 'PCB drills through to the existing screen').toContain('/payroll/pcb-detail?payslipId=');
    for (const forbidden of ['explainPcb', 'pcbMeta', 'currentPcbReliefs']) {
      expect(view, `the Statutory Explanation must not reimplement the MTD working (${forbidden})`).not.toContain(
        forbidden,
      );
    }
  });

  it('the new guarded page has a function-access column, attached to the Transaction View screen key', () => {
    // A guarded page.tsx with no column becomes a screen nobody can grant or revoke, and
    // test/function-access.test.ts's reverse-completeness case fails the whole suite for it.
    const perms = read('lib/permissions.ts');
    expect(perms).toContain("'/payroll/statutory-detail'");
    // On the SAME screen key as the two doors that reach it — not a new one.
    //
    // ⚠️ THE BLOCK IS FOUND BY ITS OWN BOUNDARY, NOT BY A CHARACTER COUNT. This read a fixed 12,000
    // characters from the start of the payroll entry until r210, when the Reset Payroll screen
    // (9f8cd608) added a column and pushed '/payroll/transaction-view' to 12,767 characters in — out of
    // the window, so the case failed with every entry present and correctly attached. A guard that
    // breaks when an unrelated screen is added to the same key is measuring the wrong thing: the
    // question is "is it under THIS screenKey", so the slice ends where the next screenKey begins.
    const blockStart = perms.indexOf("screenKey: 'payroll'");
    const nextKey = perms.indexOf('screenKey:', blockStart + 'screenKey:'.length);
    const payrollBlock = perms.slice(blockStart, nextKey === -1 ? undefined : nextKey);
    expect(payrollBlock).toContain("'/payroll/statutory-detail'");
    expect(payrollBlock).toContain("'/payroll/transaction-view'");
    // The route handler is NOT listed — the reverse-completeness check walks page.tsx files only.
    expect(perms).not.toContain("'/payroll/statutory-detail/export'");
  });
});

describe('208beb8b — a figure a payroll officer typed is not the schedule’s', () => {
  /**
   * THE REPRODUCTION FROM THE ITEM, to the ringgit: EPF employee set by hand to RM500 on a recorded base
   * of RM3,000, where the KWSP Third Schedule had produced RM330. `adjustment` is the shape
   * `applyStatutoryAdjustment` (core/payroll.ts) stamps: one reason for the whole adjustment, and
   * `{system, applied}` for each line that was set.
   */
  const REASON = 'KWSP letter 2026/118 — arrears agreed with the member';
  const MANUAL_BASES = { ...STAMPED.bases, epf: 3000, epfAdditional: 0 };
  const stamped = (lines: Record<string, { system: number; applied: number }>, reason = REASON) => ({
    ...STAMPED,
    epfEmployee: 500,
    bases: MANUAL_BASES,
    adjustment: { reason, lines },
  });
  /** The SAME payslip with the stamp removed. Every case below is asserted against this partner. */
  const UNSTAMPED_TWIN = { ...STAMPED, epfEmployee: 500, bases: MANUAL_BASES };

  it('reports ruleKind "manual" and NO effective rate — and the twin proves what it replaced', () => {
    const hand = byKey(stamped({ epfEmployee: { system: 330, applied: 500 } }));
    // ── THE NON-VACUITY PARTNER FIRST. Without it, "the rate is null" also passes on a read that lost
    // the amount, lost the base, or lost the whole item. This is the sentence the screen used to print.
    const twin = byKey(UNSTAMPED_TWIN);
    expect(twin.epf.ruleKind, 'unstamped, EPF is still the KWSP Third Schedule').toBe('schedule');
    expect(twin.epf.effectiveEmployeeRate!, 'and 500 ÷ 3,000 is the 16.67% the screen printed').toBeCloseTo(
      500 / 3000,
      9,
    );
    // ── AND NOW THE STAMPED ONE. Same amount, same base, same run type — only the stamp differs.
    expect(hand.epf.ruleKind, 'no rule produced this amount, so none may be named').toBe('manual');
    expect(hand.epf.effectiveEmployeeRate, 'a typed amount over a wage is not a rate').toBeNull();
    expect(hand.epf.effectiveEmployerRate, 'and the untouched leg’s goes too — see the header').toBeNull();
    // The figures themselves all survive: the amount deducted, the wage it was charged against, and the
    // figure the RULE had produced, which is the one a reader is checking the typed amount against.
    expect(hand.epf.employeeReported, 'what the payslip charged').toBe(500);
    expect(hand.epf.totalBase, 'the wage the rule would have used, still reported').toBe(3000);
    expect(hand.epf.provenance.source).toBe('statutoryAdjustment');
    expect(hand.epf.provenance.employee).toEqual({ system: 330, applied: 500 });
    expect(hand.epf.provenance.employer, 'the employer leg was NOT typed and must not claim to be').toBeNull();
    expect(hand.epf.provenance.reason).toBe(REASON);
    expect(isSetByHand(hand.epf.provenance)).toBe(true);
    expect(isSetByHand(twin.epf.provenance), 'the twin’s provenance is "computed"').toBe(false);
  });

  it('THE HRD CORP LEVY loses its multiplication, which is the one working that stops evaluating', () => {
    // hrdf is the ONLY 'rate' item, so it is the only one whose working is printed as `base × rate =
    // amount`. Type the amount and that equation is a product that does not come out — the plan calls this
    // the worse case than EPF, because the false statement is arithmetic rather than a caption.
    const twin = byKey({ ...STAMPED, hrdf: 90 });
    expect(twin.hrdf.ruleKind, 'unstamped, the levy really is a percentage of the wage').toBe('rate');
    expect(twin.hrdf.effectiveEmployerRate!, '90 ÷ 5,100 = 1.76%, which the screen multiplied by').toBeCloseTo(
      90 / 5100,
      9,
    );
    const hand = byKey({ ...STAMPED, hrdf: 90, adjustment: { reason: REASON, lines: { hrdf: { system: 51, applied: 90 } } } });
    expect(hand.hrdf.ruleKind).toBe('manual');
    expect(hand.hrdf.effectiveEmployerRate, 'no rate means the view cannot print a product').toBeNull();
    expect(hand.hrdf.provenance.employer).toEqual({ system: 51, applied: 90 });
    expect(hand.hrdf.provenance.employee, 'the levy has no employee leg to type').toBeNull();
  });

  it('PCB keeps "mtd" and its own screen, and is still flagged as set by hand', () => {
    // Deliberate (plan §4): PCB has no rate to suppress here, its own screen already discloses the
    // override in full, and one MTD display is what 45df860a settled. What it gains is the flag.
    const hand = byKey({ ...STAMPED, pcb: 999, adjustment: { reason: REASON, lines: { pcb: { system: 320, applied: 999 } } } });
    expect(hand.pcb.ruleKind, 'the tax working is on its own screen and is still a true account').toBe('mtd');
    expect(hand.pcb.provenance.employee).toEqual({ system: 320, applied: 999 });
    expect(explainStatutory({ ...STAMPED, pcb: 999, adjustment: { reason: REASON, lines: { pcb: { system: 320, applied: 999 } } } }, 'regular').setByHand?.keys).toEqual(['pcb']);
  });

  it('NO CASCADE, and the screen must not imply one: only the typed item changes', () => {
    // `applyStatutoryAdjustment` deliberately does not re-derive PCB from a new EPF figure
    // (core/payroll.ts). So every OTHER item must go on naming the rule that really produced it — a
    // banner on all six would train a reader to ignore it on the payslip where it matters.
    const e = explainStatutory(stamped({ epfEmployee: { system: 330, applied: 500 } }), 'regular');
    const i = Object.fromEntries(e.items.map((x) => [x.key, x])) as Record<StatutoryExplainKey, (typeof e.items)[number]>;
    for (const k of ['socso', 'skbbk', 'eis'] as const) {
      expect(i[k].ruleKind, `${k} was not touched`).toBe('schedule');
      expect(i[k].effectiveEmployeeRate, `${k} keeps its genuinely derived rate`).not.toBeNull();
      expect(isSetByHand(i[k].provenance)).toBe(false);
    }
    expect(i.hrdf.ruleKind).toBe('rate');
    expect(i.pcb.employeeReported, 'the tax figure did not move').toBe(320);
    expect(e.setByHand?.keys, 'and the banner names only what was typed').toEqual(['epf']);
    // 70b14723 — `reason` became `notes`, one entry per SOURCE, because two sources can sit on one payslip
    // and a single string silently attaches one decision's justification to the other.
    expect(e.setByHand?.notes).toEqual([{ source: 'statutoryAdjustment', reason: REASON }]);
  });

  it('every one of the NINE overridable lines lands on exactly one item', () => {
    // The nine line names are core/payroll.ts's. core/statutory-explain.ts may not IMPORT them (the
    // no-recompute fence below forbids reaching the kernel), so they are spelled out there — which means
    // the two lists could drift. This reads the kernel's own declaration out of SOURCE and pins the map
    // behaviourally: stamp one line, exactly one item goes manual, and it is the right one.
    const decl = /export const STATUTORY_ADJUSTMENT_LINES = \[([^\]]*)\] as const;/.exec(read('core/payroll.ts'));
    const nine = [...decl![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(nine, 'nine lines, employee side first — core/payroll.ts’s own order').toHaveLength(9);
    const ITEM_OF_LINE: Record<string, StatutoryExplainKey> = {
      pcb: 'pcb',
      epfEmployee: 'epf',
      socsoEmployee: 'socso',
      socsoSkbbk: 'skbbk',
      eisEmployee: 'eis',
      hrdf: 'hrdf',
      epfEmployer: 'epf',
      socsoEmployer: 'socso',
      eisEmployer: 'eis',
    };
    expect(Object.keys(ITEM_OF_LINE).sort(), 'every kernel line is mapped, and nothing else is').toEqual(
      [...nine].sort(),
    );
    for (const [line, key] of Object.entries(ITEM_OF_LINE)) {
      const e = explainStatutory({ ...STAMPED, adjustment: { reason: 'r', lines: { [line]: { system: 1, applied: 2 } } } }, 'regular');
      expect(e.setByHand?.keys, `${line} must flag ${key} and nothing else`).toEqual([key]);
      const it2 = e.items.find((x) => x.key === key)!;
      const leg = line.endsWith('Employer') || line === 'hrdf' ? 'employer' : 'employee';
      expect(it2.provenance[leg], `${line} is the ${leg} leg of ${key}`).toEqual({ system: 1, applied: 2 });
    }
  });

  it('a HALF-WRITTEN stamp is not a stamp — it must never assert that the system calculated 0.00', () => {
    // `n()` turns `undefined` into 0, so a stamp missing `system` would otherwise hand the banner
    // "the system calculated RM 0.00" as a fact. The same gate readOverride / readDelta already use.
    for (const half of [{ applied: 500 }, { system: 330 }, {}, null, 0, 'x', [] as unknown]) {
      const e = explainStatutory({ ...UNSTAMPED_TWIN, adjustment: { reason: REASON, lines: { epfEmployee: half } } }, 'regular');
      const epf = e.items.find((i) => i.key === 'epf')!;
      expect(epf.ruleKind, `half stamp ${JSON.stringify(half)} is not a stamp`).toBe('schedule');
      expect(epf.provenance.source).toBe('computed');
      expect(epf.provenance.employee).toBeNull();
      expect(e.setByHand, 'and no banner is raised on it').toBeNull();
      expect(JSON.stringify(e), 'no invented system figure anywhere').not.toContain('"system"');
    }
  });

  it('a garbage `adjustment` degrades to "computed" rather than throwing on a payslip screen', () => {
    for (const bad of [null, undefined, 0, 'x', [] as unknown, { reason: 1 }, { lines: 'x' }, { lines: [] }]) {
      expect(() => explainStatutory({ ...STAMPED, adjustment: bad }, 'regular')).not.toThrow();
      const e = explainStatutory({ ...STAMPED, adjustment: bad }, 'regular');
      expect(e.setByHand, `adjustment=${JSON.stringify(bad)}`).toBeNull();
      expect(e.items.every((i) => i.provenance.source === 'computed')).toBe(true);
    }
    // A stamp with a real line but a non-string reason keeps the flag and drops the reason to ''. The
    // screen names it as unrecorded; it must not print `1` or `undefined` as somebody's justification.
    const e = explainStatutory({ ...STAMPED, adjustment: { reason: 1, lines: { epfEmployee: { system: 1, applied: 2 } } } }, 'regular');
    expect(e.setByHand?.notes).toEqual([{ source: 'statutoryAdjustment', reason: '' }]);
  });

  it('an UNSTAMPED payslip is item-for-item what it was before 208beb8b', () => {
    // THE REGRESSION HALF. Every payslip in the product carries no adjustment, so the whole change must be
    // invisible on them: the same rule kinds, the same rates, and a provenance that says "computed".
    const e = explainStatutory(STAMPED, 'regular');
    expect(e.setByHand).toBeNull();
    expect(e.items.map((i) => i.ruleKind)).toEqual(['schedule', 'schedule', 'schedule', 'schedule', 'rate', 'mtd']);
    for (const i of e.items) {
      expect(i.provenance, `${i.key}`).toEqual({ source: 'computed', employee: null, employer: null, reason: '' });
      expect(i.effectiveEmployeeRate, `${i.key} keeps its derived employee rate`).not.toBeNull();
    }
    expect(e.items.find((i) => i.key === 'epf')!.effectiveEmployeeRate!).toBeCloseTo(0.11, 6);
  });

  it('both banners can be true at once, and each says only its own half', () => {
    // A hand-set line ON an additional run. `basesCoverWholeMonth` already nulls the rates, so the stamp
    // must not be the only thing keeping them null, and neither disclosure may swallow the other.
    const e = explainStatutory(stamped({ epfEmployee: { system: 330, applied: 500 } }), 'bonus');
    expect(e.basesCoverWholeMonth, 'the wages are still the cumulative month’s').toBe(true);
    expect(e.setByHand?.keys, 'and a person still decided the EPF figure').toEqual(['epf']);
    expect(e.items.find((i) => i.key === 'epf')!.ruleKind).toBe('manual');
    // The untouched items on the same run keep the additional-run story and gain no manual one.
    const socso = e.items.find((i) => i.key === 'socso')!;
    expect(socso.ruleKind).toBe('schedule');
    expect(socso.effectiveEmployeeRate, 'nulled by the run, not by a stamp').toBeNull();
    expect(isSetByHand(socso.provenance)).toBe(false);
  });

  it('the seam is ONE exported function, and it is the only reader of the stamp', () => {
    // 70b14723 (Manual EPF categories) adds a SECOND source of a hand-set EPF figure. It must extend this
    // function, not add a second banner — so the surfaces are pinned as NON-readers of the stamp.
    const src = code('core/statutory-explain.ts');
    expect(src).toMatch(/export function statutoryProvenance\(statutory: unknown, key: StatutoryExplainKey\)/);
    expect(src, 'and the predicate every surface asks instead of re-spelling the union').toContain(
      'export const isSetByHand',
    );
    for (const rel of [
      'app/payroll/statutory-detail/statutory-detail-view.tsx',
      'app/payroll/statutory-detail/export/route.ts',
    ]) {
      const src = code(rel);
      // Not a bare 'adjustment' — both files legitimately carry `adjustment: 'cycleAdjustment'`, the
      // payroll CYCLE of that name, which has nothing to do with the stamp. What is forbidden is a READ.
      for (const forbidden of ['.adjustment', "['adjustment']", '"adjustment"']) {
        expect(src, `${rel} must not read the stamp for itself (${forbidden})`).not.toContain(forbidden);
      }
      // …and positively: each surface consumes the seam's answer through the explanation.
      expect(src, `${rel} must read the provenance the derivation returned`).toMatch(/provenance|setByHand/);
    }
    // Direct call, outside explainStatutory: the seam is usable on its own, which is what 70b14723 needs.
    expect(statutoryProvenance(null, 'epf')).toEqual({ source: 'computed', employee: null, employer: null, reason: '' });
    expect(
      statutoryProvenance({ adjustment: { reason: 'r', lines: { epfEmployer: { system: 390, applied: 400 } } } }, 'epf'),
    ).toEqual({ source: 'statutoryAdjustment', employee: null, employer: { system: 390, applied: 400 }, reason: 'r' });
    // 70b14723 — AND THE SECOND SOURCE CAME IN THROUGH THE SAME DOOR. Its stamp is `statutory.epfManual`, and
    // the two surfaces are pinned as non-readers of it too, exactly as they are of `statutory.adjustment`.
    expect(statutoryProvenance({ epfManual: { reason: 'grandfathered', employee: { system: 330, applied: 500 } } }, 'epf')).toEqual({
      source: 'epfManualAmount',
      employee: { system: 330, applied: 500 },
      employer: null,
      reason: 'grandfathered',
    });
    for (const rel of [
      'app/payroll/statutory-detail/statutory-detail-view.tsx',
      'app/payroll/statutory-detail/export/route.ts',
    ]) {
      const src = code(rel);
      for (const forbidden of ['.epfManual', "['epfManual']", '"epfManual"'])
        expect(src, `${rel} must not read 70b14723's stamp for itself (${forbidden})`).not.toContain(forbidden);
    }
  });

  it('the SCREEN and the DOWNLOADED COPY word each source identically, and cover the whole union', () => {
    // 70b14723 — the rule labels already had this problem and solved it by being exhaustive by TYPE in both
    // files; the two per-SOURCE maps need the same treatment for a sharper reason. A file that credits
    // Payroll › Statutory Adjustment for a figure that came from the employee's EPF Category sends an
    // auditor to the wrong screen to check it, and "the file disagrees with the screen it was taken from"
    // is the one failure the export route's own header calls unacceptable on a statutory reconciliation.
    // So: same keys, same values, and every member of the union mapped — read out of SOURCE, because tsc
    // proves exhaustiveness but cannot prove the two files AGREE.
    const maps = (rel: string) => {
      const src = code(rel);
      const out: Record<string, Record<string, string>> = {};
      for (const name of ['SOURCE_BODY', 'SOURCE_REASON_LABEL']) {
        const m = new RegExp(`const ${name}: Record<StatutoryProvenanceSource, string> = \\{([^}]*)\\}`).exec(src);
        expect(m, `${rel} must declare ${name} exhaustively over StatutoryProvenanceSource`).not.toBeNull();
        out[name] = Object.fromEntries([...m![1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
      }
      return out;
    };
    const view = maps('app/payroll/statutory-detail/statutory-detail-view.tsx');
    const file = maps('app/payroll/statutory-detail/export/route.ts');
    // Every member of the union, named in the type's own declaration, is mapped in BOTH files.
    const union = [
      ...code('core/statutory-explain.ts')
        .slice(code('core/statutory-explain.ts').indexOf('export type StatutoryProvenanceSource'))
        .split(';')[0]
        .matchAll(/'([a-zA-Z]+)'/g),
    ].map((m) => m[1]);
    expect(union, 'the union must still be a readable literal list').toContain('epfManualAmount');
    for (const name of ['SOURCE_BODY', 'SOURCE_REASON_LABEL']) {
      expect(Object.keys(view[name]).sort(), `${name}: the view covers the whole union`).toEqual([...union].sort());
      expect(file[name], `${name}: the download says the same thing the screen says`).toEqual(view[name]);
    }
    // …and the two sources really are worded DIFFERENTLY, or the maps exist without doing their job.
    expect(view.SOURCE_BODY.epfManualAmount).not.toBe(view.SOURCE_BODY.statutoryAdjustment);
    expect(view.SOURCE_REASON_LABEL.epfManualAmount).not.toBe(view.SOURCE_REASON_LABEL.statutoryAdjustment);
  });

  describe('70b14723 — the standing manual EPF amount joins the seam without a second implementation', () => {
    const REASON = 'Pre-1998 member — contribution agreed at the grandfathered rate';
    const MANUAL_BASES = { ...STAMPED.bases, epf: 3000, epfAdditional: 0 };
    /** A payslip whose EPF EMPLOYEE leg came from the employee's own category, not the Third Schedule. */
    const elected = (extra: Record<string, unknown> = {}) => ({
      ...STAMPED,
      epfEmployee: 500,
      bases: MANUAL_BASES,
      epfMode: 'manual_amount',
      epfManual: { reason: REASON, employee: { system: 330, applied: 500 } },
      ...extra,
    });
    /** The SAME payslip with the stamp removed — the non-vacuity partner for every assertion below. */
    const TWIN = { ...STAMPED, epfEmployee: 500, bases: MANUAL_BASES };

    it('reports ruleKind manual, NO rate, and names the source — with the twin proving what it replaced', () => {
      const twin = byKey(TWIN);
      expect(twin.epf.ruleKind, 'unstamped, EPF is still the KWSP Third Schedule').toBe('schedule');
      expect(twin.epf.effectiveEmployeeRate, 'and prints a rate of 500/3000 that no schedule ever produced').toBeCloseTo(
        0.16667,
        4,
      );
      const hand = byKey(elected());
      expect(hand.epf.ruleKind).toBe('manual');
      expect(hand.epf.effectiveEmployeeRate).toBeNull();
      expect(hand.epf.effectiveEmployerRate).toBeNull();
      expect(hand.epf.provenance.source).toBe('epfManualAmount');
      expect(hand.epf.provenance.employee).toEqual({ system: 330, applied: 500 });
      expect(hand.epf.provenance.employer, 'the employer side was NOT typed, so it has no leg').toBeNull();
      expect(isSetByHand(hand.epf.provenance)).toBe(true);
      const e = explainStatutory(elected(), 'regular');
      expect(e.setByHand?.keys).toEqual(['epf']);
      expect(e.setByHand?.notes).toEqual([{ source: 'epfManualAmount', reason: REASON }]);
    });

    it('says nothing about the other five items — an election exists for EPF and for nothing else', () => {
      const i = byKey(elected());
      for (const k of ['socso', 'skbbk', 'eis'] as const) {
        expect(i[k].ruleKind, `${k} was not elected`).toBe('schedule');
        expect(i[k].effectiveEmployeeRate, `${k} keeps its genuinely derived rate`).not.toBeNull();
        expect(isSetByHand(i[k].provenance)).toBe(false);
      }
      expect(i.hrdf.ruleKind).toBe('rate');
      expect(i.pcb.ruleKind).toBe('mtd');
      // …and a stamp under a non-EPF key is not read at all, however well-formed it looks.
      expect(statutoryProvenance({ epfManual: { reason: 'x', employee: { system: 1, applied: 2 } } }, 'socso').source).toBe('computed');
    });

    it('BOTH sources on one payslip: the adjustment wins EPF, and each source keeps its own reason', () => {
      // A standing manual amount AND a per-run adjustment on the same slip. `applyStatutoryAdjustment` runs
      // after the kernel composed `stComputed`, so the adjustment IS the figure the payslip carries — and its
      // own `system` leg records the 500 it replaced, which is the honest account of that payslip.
      const ADJ = 'Correction agreed with the member for this run only';
      const both = elected({
        epfEmployee: 700,
        socsoEmployee: 60,
        adjustment: { reason: ADJ, lines: { epfEmployee: { system: 500, applied: 700 }, socsoEmployee: { system: 18.75, applied: 60 } } },
      });
      const i = byKey(both);
      expect(i.epf.provenance.source, 'the figure on the slip came from the adjustment').toBe('statutoryAdjustment');
      expect(i.epf.provenance.employee, 'and its system leg is the standing amount it replaced').toEqual({ system: 500, applied: 700 });
      expect(i.socso.provenance.source).toBe('statutoryAdjustment');
      const e = explainStatutory(both, 'regular');
      expect(e.setByHand?.keys).toEqual(['epf', 'socso']);
      expect(e.setByHand?.notes, 'ONE note per source, so neither reason is attached to the other decision').toEqual([
        { source: 'statutoryAdjustment', reason: ADJ },
      ]);
      // …and with the adjustment naming SOCSO alone, the EPF item falls through to the election and the
      // banner carries BOTH sentences with BOTH reasons.
      const split = elected({ socsoEmployee: 60, adjustment: { reason: ADJ, lines: { socsoEmployee: { system: 18.75, applied: 60 } } } });
      const es = explainStatutory(split, 'regular');
      expect(es.setByHand?.keys).toEqual(['epf', 'socso']);
      expect(es.setByHand?.notes).toEqual([
        { source: 'epfManualAmount', reason: REASON },
        { source: 'statutoryAdjustment', reason: ADJ },
      ]);
    });

    it('a garbage or half-written `epfManual` degrades to "computed" rather than inventing a zero', () => {
      for (const bad of [null, 0, 'x', [], {}, { reason: 'r' }, { employee: {} }, { employee: { system: 1 } }, { employee: { applied: 2 } }]) {
        expect(() => explainStatutory({ ...STAMPED, epfManual: bad }, 'regular')).not.toThrow();
        const e = explainStatutory({ ...STAMPED, epfManual: bad }, 'regular');
        expect(e.setByHand, `epfManual=${JSON.stringify(bad)}`).toBeNull();
        expect(JSON.stringify(e), 'no invented system figure anywhere').not.toContain('"system"');
      }
    });
  });
});

describe('6b4ca488 — the screen’s captions exist, and are translated', () => {
  type Msgs = {
    payroll: {
      statutoryDetail: Record<string, string>;
      transactions: { view: { tabs: Record<string, string> } };
    };
  };
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

  it('every key the view, the page, the tab and the export look up resolves in all six catalogues', () => {
    // Transaction View reads two namespaces, so i18n-coverage's file-level check skips it entirely: a key
    // that exists nowhere would pass tsc, the suite and `next build`, and paint MISSING_MESSAGE on the
    // tab. These are looked up on every visit.
    const NEEDED = [
      'title',
      'subtitle',
      'payslipHint',
      'viewExplanation',
      'backToPayslip',
      'backToTransactionView',
      'notFound',
      'noSelection',
      'noEmployee',
      'noPayslip',
      'exportExcel',
      'otherRuns',
      'otherRunsHint',
      'identificationHeading',
      'basesNotRecordedHeading',
      'basesNotRecordedBody',
      'wholeMonthNote',
      'summaryHeading',
      'notRecordedShort',
      'workingLabel',
      'workingNotRecorded',
      'workingMtd',
      'effectiveRateNote',
      'effectiveRateScheduleNote',
      // EPF is a schedule item off a DIFFERENT schedule (KWSP's, not PERKESO's), and an additional run
      // gets a third caption again because no rate exists to caption. Three keys, three real cases.
      'effectiveRateEpfNote',
      'incrementalNote',
      'ruleRate',
      'ruleSchedule',
      'ruleScheduleEpf',
      'ruleMtd',
      'pcbViewCalculation',
      // 208beb8b — the hand-set disclosure: the rule name that names no rule, the third banner, the
      // working note that replaces every rate caption, and the two rows/columns holding the system figure.
      'ruleManual',
      'manualBannerHeading',
      'manualBannerBody',
      'manualBannerItems',
      'manualReason',
      'manualNote',
      // 70b14723 — the second source's own two captions. Both are looked up through the exhaustive STATIC
      // per-source maps in the view AND the export route, so a missing one is a MISSING_MESSAGE on the amber
      // banner of the one payslip whose EPF a person decided.
      'manualBannerBodyElection',
      'manualReasonElection',
      'fieldSystemEmployeeShare',
      'fieldSystemEmployerShare',
      // The export's two extra columns — the file splits what the screen shows as a disclosure.
      'colEmployerBorne',
      'colTakeHome',
      // Every item and its agency line, both looked up through an exhaustive STATIC map.
      ...STATUTORY_EXPLAIN_KEYS.map((k) => `item${k[0].toUpperCase()}${k.slice(1)}`),
      'agencyEpf',
      'agencySocso',
      'agencyHrdf',
      'agencyPcb',
      // The four cycles, static-keyed for the same reason.
      'cycleRegular',
      'cycleOffCycle',
      'cycleBonus',
      'cycleAdjustment',
    ];
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Msgs;
      for (const k of NEEDED) {
        expect(m.payroll.statutoryDetail?.[k], `payroll.statutoryDetail.${k} missing from ${loc}.json`).toBeTruthy();
      }
      expect(
        m.payroll.transactions.view.tabs.statutory,
        `the tab caption is missing from ${loc}.json`,
      ).toBeTruthy();
    }
  });

  it('the five other locales are TRANSLATED, not the English string copied across', () => {
    // Parity is enforced by scripts/i18n-check.mjs; a stale VALUE is not. These are long explanatory
    // sentences — exactly the ones a rushed round leaves in English.
    const en = (JSON.parse(read('messages/en.json')) as Msgs).payroll.statutoryDetail;
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Msgs;
      const LONG_SENTENCES = [
        'title',
        'basesNotRecordedBody',
        'workingMtd',
        'effectiveRateScheduleNote',
        'effectiveRateEpfNote',
        'incrementalNote',
        'wholeMonthNote',
        'employerBorneNote',
        'manualBannerBody',
        'manualNote',
        // 70b14723 — the longest new sentence in the catalogue, and exactly the kind a rushed round leaves
        // in English on a screen whose whole job is to be trusted about where a number came from.
        'manualBannerBodyElection',
      ];
      for (const k of LONG_SENTENCES) {
        expect(m.payroll.statutoryDetail[k], `${loc}: payroll.statutoryDetail.${k} is still English`).not.toBe(en[k]);
      }
    }
  });
});
