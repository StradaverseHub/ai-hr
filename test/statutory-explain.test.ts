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
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATUTORY_EXPLAIN_KEYS,
  explainStatutory,
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
    const payrollBlock = perms.slice(perms.indexOf("screenKey: 'payroll'"), perms.indexOf("screenKey: 'payroll'") + 12000);
    expect(payrollBlock).toContain("'/payroll/statutory-detail'");
    expect(payrollBlock).toContain("'/payroll/transaction-view'");
    // The route handler is NOT listed — the reverse-completeness check walks page.tsx files only.
    expect(perms).not.toContain("'/payroll/statutory-detail/export'");
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
      ];
      for (const k of LONG_SENTENCES) {
        expect(m.payroll.statutoryDetail[k], `${loc}: payroll.statutoryDetail.${k} is still English`).not.toBe(en[k]);
      }
    }
  });
});
