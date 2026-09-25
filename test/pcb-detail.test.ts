/**
 * Feedback 45df860a — the detailed PCB / MTD calculation view.
 *
 * WHAT THIS ITEM ACTUALLY CHANGED, AND THEREFORE WHAT IS WORTH ASSERTING:
 *
 *   1. THE ENGINE NOW KEEPS WHAT IT WAS THROWING AWAY. `annualTaxFor` returned only the tax and
 *      discarded the (M, R, B) band it had just selected; `pcbMonth` held Y₁/K₁/K₂/Yₜ/Kₜ, Z, the LP
 *      split and the two §D.2 year totals as locals and let them fall off the end of the function. They
 *      are now stamped into the `pcbMeta` snapshot that was already being written. **No amount moves** —
 *      the golden PCB tests elsewhere in the suite are the proof of that, and the reconciliation case
 *      below is the proof that the recorded figures are the SAME ones the deduction came out of.
 *
 *   2. THE SCREEN IS ONE SCREEN. Transaction Detail and the Individual Payslip both link to
 *      /payroll/pcb-detail. The reporter's stated reason is the assertion: "This avoids having two
 *      different PCB calculation engines or two different calculation displays."
 *
 *   3. AN OLD PAYSLIP SAYS SO. Runs processed before this carry no trace, and the read model returns
 *      NULL rather than a table of zeroes or a back-derived bracket. That failure — a missing figure
 *      rendered as 0.00 on a screen about someone's tax — is the one this file spends the most cases on,
 *      because it is the one that would be invisible in production.
 *
 * RULE 17 (the contract between two files). The engine WRITES the trace and the screen READS it; a unit
 * test of either half alone passes while the two disagree. The reconciliation case therefore closes the
 * loop: it takes what was STORED, re-applies the LHDN steps to it, and requires the result to be the MTD
 * the engine deducted, to the sen.
 *
 * WHAT THE FIRST PASS PROVED, AND WHAT IT DID NOT. The reconciliation above was written against the
 * NORMAL leg of a month with no bonus and no zakat, and it passed while three printed expressions on the
 * screen did not evaluate to the number beside them: P₁'s line grew a bonus leg it does not have, the net
 * line skipped the RM10 rule and the zakat cascade entirely, and a hand-set PCB was explained by a
 * working that described the figure it replaced. None of the three is visible to an assertion about
 * numbers, because the screen computes nothing — so this file now reconciles P₂ and the deduction on
 * their own terms, and reads the assembled expressions as strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pcbMonth, statutory, coordinatedPcbForPerson } from '../localization/my/payroll';
import { explainPcb, pcbBasisLabels, type PcbBasis, type PcbReliefBreakdown } from '../core/pcb-explain';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { currentPcbReliefs, listProcessedPayslipsAcross, payslipForReview } from '../core/payroll-view';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — this round's files EXPLAIN what they no longer do, and a guard that
 *  matched the explanation would pass on prose alone. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The spec's own rounding rules, restated here so the reconciliation is against the SPEC rather than
 *  against a helper imported from the file under test (which would prove only that it agrees with
 *  itself). §E.1 truncate to 2dp; §E.2 round UP to the next 5 sen. */
const trunc2 = (n: number) => Math.trunc(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100;
const ceil5sen = (n: number) => Math.ceil(n * 20 - 1e-7) / 20;
/** §E.3 — an MTD below RM10 is not deducted. Restated here for the same reason as the two above. */
const rm10Floor = (n: number) => (n < 10 ? 0 : n);
const r2 = (n: number) => Math.round(n * 100) / 100;

type Trace = NonNullable<ReturnType<typeof pcbMonth>['snapshot']['trace']>;

// ───────────────────────────── The engine keeps the whole working ─────────────────────────────

describe('45df860a — pcbMonth records the steps it used to discard', () => {
  it('stamps the bracket, the EPF legs and the accumulators alongside the figures it already stored', () => {
    const r = pcbMonth({
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 3,
      profile: { category: 2, children: 2 },
      acc: { netRemuneration: 21000, epfClaimed: 2640, pcbPaid: 900, zakatPaid: 50, lpAccumulated: 120 },
      lpCurrent: 30,
    });
    const t = r.snapshot.trace;
    expect(t, 'a fresh run must record the trace').toBeTruthy();
    const tr = t as Trace;

    // The KEYS THAT WERE ALREADY THERE are untouched — this is an additive stamp, and every existing
    // assertion in the suite over `snapshot` reads the same values it always did.
    expect(r.snapshot.month).toBe(3);
    expect(r.snapshot.n).toBe(9);
    expect(r.snapshot.pcbPaid).toBe(900);
    expect(r.snapshot.reliefs.total).toBeGreaterThan(0);

    // The bracket: a real row of LHDN Table 1, not a placeholder.
    expect(tr.R).toBeGreaterThan(0);
    expect(tr.M).toBeGreaterThanOrEqual(0);
    expect(tr.taxOnP1).toBeCloseTo(Math.max(0, (r.snapshot.P1 - tr.M) * tr.R + tr.B), 2);

    // The legs. Y₂ IS Y₁ — the projection repeats the current month — and the trace says so out loud
    // rather than leaving a reader to infer it from an expression they cannot see.
    expect(tr.Y1).toBe(12000);
    expect(tr.Y2).toBe(tr.Y1);
    expect(tr.K1).toBeGreaterThan(0);
    expect(tr.category).toBe(2);
    expect(tr.childCount).toBe(2);

    // The LP split, which the payslip only ever carried as a single combined figure.
    expect(tr.lpAccumulated).toBe(120);
    expect(tr.lpCurrent).toBe(30);
    expect(r.snapshot.reliefs.lp).toBeCloseTo(150, 2);
    expect(tr.Z).toBe(50);
  });

  it('RECONCILES: the stored figures, put back through the LHDN steps, give the MTD that was deducted', () => {
    // Rule 17 — the defect would live in the CONTRACT between the engine and the screen, and a unit test
    // of either half alone cannot see it. Several shapes, because one row proves nothing about a formula.
    const cases = [
      { monthlyWage: 12000, epfMonthly: 1320, month: 3, profile: { category: 2 as const, children: 2 } },
      { monthlyWage: 4000, epfMonthly: 440, month: 1, profile: { category: 1 as const } },
      { monthlyWage: 30000, epfMonthly: 3300, month: 11, profile: { category: 3 as const, children: 1 } },
      {
        monthlyWage: 18065,
        epfMonthly: 1987.15,
        month: 12,
        profile: { category: 1 as const },
        acc: { netRemuneration: 138575.94, epfClaimed: 4000, pcbPaid: 18187.05, zakatPaid: 100 },
      },
    ];
    for (const c of cases) {
      const r = pcbMonth(c);
      const tr = r.snapshot.trace as Trace;
      const P = r.snapshot.P1;
      const X = r.snapshot.pcbPaid;
      const substituted = ceil5sen(trunc2(Math.max(0, ((P - tr.M) * tr.R + tr.B - (tr.Z + X)) / (r.snapshot.n + 1))));
      expect(substituted, `the substituted formula must land on the engine's own MTD for ${JSON.stringify(c)}`)
        .toBeCloseTo(tr.mtdNormalCalc, 2);
      // …and that IS the figure the payslip carries once §E.3/§E.5 have run, which for a month with no
      // zakat and an MTD above the RM10 floor is the same number.
      if (tr.mtdNormalCalc >= 10 && tr.zakatCurrent === 0 && tr.mtdAdditionalCalc === 0) {
        expect(r.total).toBeCloseTo(tr.mtdNormalCalc, 2);
      }
    }
  });

  it('RECONCILES P₁ AND P₂ SEPARATELY — the bonus leg belongs to P₂ only, and P₂ re-estimates K₂', () => {
    // THE BLOCKER THIS FILE MISSED FIRST TIME. §D.1 projects the year on normal remuneration alone;
    // §D.2 repeats the projection with the bonus AND with a re-estimated EPF leg (K₂ₜ), because the EPF
    // on the bonus has already eaten into the same annual cap. They are two expressions landing on two
    // different stored numbers, so a screen that appends "+ (Yₜ − Kₜ)" to the P₁ line and prints P₁
    // beside it is stating an expression that belongs to neither. This is the reported case, to the sen.
    const r = pcbMonth({
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 6,
      additional: 20000,
      epfOnAdditional: 2200,
      profile: { category: 1 },
    });
    const tr = r.snapshot.trace as Trace;
    const s = r.snapshot;
    const reliefs = s.reliefs.total;
    const lp = s.reliefs.lp;
    const n = s.n;

    // P₁ — NO Yₜ leg, and the plain K₂.
    expect(trunc2(s.ytdNet + (tr.Y1 - tr.K1) + (tr.Y2 - tr.K2) * n - reliefs - lp)).toBeCloseTo(s.P1, 2);
    // P₂ — the Yₜ leg, and K₂ₜ in place of K₂.
    expect(s.P2, 'a bonus month records P₂').toBeTypeOf('number');
    expect(
      trunc2(s.ytdNet + (tr.Y1 - tr.K1) + (tr.Y2 - tr.K2t) * n + (tr.Yt - tr.Kt) - reliefs - lp),
    ).toBeCloseTo(s.P2 as number, 2);

    // …and the hybrid the screen used to print — P₁'s K₂ with P₂'s bonus leg — is neither of them, by
    // the whole bonus. Pinned so nobody reintroduces it as a "simplification".
    const hybrid = trunc2(s.ytdNet + (tr.Y1 - tr.K1) + (tr.Y2 - tr.K2) * n + (tr.Yt - tr.Kt) - reliefs - lp);
    expect(hybrid).not.toBeCloseTo(s.P1, 2);
    expect(hybrid).not.toBeCloseTo(s.P2 as number, 2);
    expect(hybrid - s.P1, 'it overshoots P by the net bonus').toBeGreaterThan(17000);
  });

  it('RECONCILES THE DEDUCTION: §E.3 then §E.5 over the stored legs give the PCB on the payslip', () => {
    // The last line of the working is NOT "normal + additional − zakat". The RM10 rule runs on each leg
    // first, then the zakat takes the normal leg down (never below zero) and only its remainder reaches
    // the additional leg. Each case below is one where the naive subtraction gives a different answer.
    // A normal leg that is positive but UNDER RM10 — §E.3 zeroes it, and nothing else on the screen
    // says so. Built by probing the year's tax and then paying all but RM5 of it in prior months, since
    // the figure that has to land in that window is the engine's, not one this test can guess.
    const probe = pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 12, profile: { category: 1 } });
    const underTen = {
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 12,
      profile: { category: 1 as const },
      acc: { netRemuneration: 0, epfClaimed: 0, pcbPaid: r2((probe.snapshot.trace as Trace).taxOnP1 - 5) },
    };

    const cases = [
      // Plain month, nothing to offset — the naive line happens to agree here, which is why the defect
      // survived the first pass.
      { monthlyWage: 12000, epfMonthly: 1320, month: 3, profile: { category: 1 as const } },
      // Zakat larger than the normal leg: the naive line goes NEGATIVE, the engine clamps at 0.
      { monthlyWage: 12000, epfMonthly: 1320, month: 3, zakatCurrent: 100000, profile: { category: 1 as const } },
      underTen,
      // Bonus month with zakat: the leftover has to reach the additional leg.
      { monthlyWage: 12000, epfMonthly: 1320, month: 6, additional: 20000, epfOnAdditional: 2200,
        zakatCurrent: 800, profile: { category: 1 as const } },
    ];
    // The §E.3 case really is in the window it claims to be in — otherwise it silently degrades into a
    // fourth copy of the plain month.
    const small = pcbMonth(underTen).snapshot.trace as Trace;
    expect(small.mtdNormalCalc, 'the RM10 case must have a positive leg').toBeGreaterThan(0);
    expect(small.mtdNormalCalc).toBeLessThan(10);
    expect(small.mtdNormalFloored, 'which §E.3 then zeroes').toBe(0);

    for (const c of cases) {
      const r = pcbMonth(c);
      const tr = r.snapshot.trace as Trace;
      const label = JSON.stringify(c);
      // The two floored legs are RECORDED, not re-derived by the screen — assert the recorded values ARE
      // §E.3 applied to the recorded calculated legs, which is the contract the screen relies on.
      expect(tr.mtdNormalFloored, `A for ${label}`).toBeCloseTo(rm10Floor(tr.mtdNormalCalc), 2);
      expect(tr.mtdAdditionalFloored, `E for ${label}`).toBeCloseTo(rm10Floor(tr.mtdAdditionalCalc), 2);
      expect(tr.zakatLeftover, `leftover for ${label}`).toBeCloseTo(
        Math.max(0, r2(Math.max(0, tr.zakatCurrent) - tr.mtdNormalFloored)),
        2,
      );
      // …and the expression the screen prints, evaluated, IS the deduction.
      const substituted = r2(
        Math.max(0, r2(tr.mtdNormalFloored - tr.zakatCurrent)) +
          Math.max(0, r2(tr.mtdAdditionalFloored - Math.max(0, r2(tr.zakatCurrent - tr.mtdNormalFloored)))),
      );
      expect(substituted, `the substituted net line must land on the deduction for ${label}`).toBeCloseTo(
        r.total,
        2,
      );
    }
  });

  it('reproduces the reporter’s own example: P 75,956.07 in the 19% band ⇒ RM 402.65', () => {
    // The plan carries a production figure (A0001, 2026-01): P₁ = 75,956.07, n = 11, X = 0, Z = 0, and
    // the bracket that was previously invisible is M = 70,000, R = 19%, B = 3,700. This case pins that
    // the trace exposes exactly those three and that they close the formula on the stated answer.
    const M = 70000;
    const R = 0.19;
    const B = 3700;
    const P = 75956.07;
    expect(ceil5sen(trunc2(((P - M) * R + B - 0) / 12))).toBeCloseTo(402.65, 2);

    // …and that the engine really does select that row for that P, through a run that lands on it.
    const r = pcbMonth({ monthlyWage: 6600, epfMonthly: 0, month: 1, profile: { category: 1 } });
    const tr = r.snapshot.trace as Trace;
    expect(r.snapshot.P1).toBeCloseTo(6600 * 12 - 9000, 2); // 70,200 — just inside the 19% band
    expect(tr.M).toBe(M);
    expect(tr.R).toBe(R);
    expect(tr.B).toBe(B);
  });

  it('records the additional-remuneration legs and the §D.2 year totals — and OMITS them when the step never ran', () => {
    const withBonus = pcbMonth({
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 6,
      additional: 20000,
      epfOnAdditional: 2200,
      profile: { category: 1 },
    });
    const bt = withBonus.snapshot.trace as Trace;
    expect(bt.Yt).toBe(20000);
    expect(bt.Kt).toBeGreaterThanOrEqual(0);
    expect(bt.totalTaxYear, '§D.2 Step 3 ran, so its total is recorded').toBeTypeOf('number');
    expect(bt.totalMtdYear, '§D.2 Step 1[E] ran too').toBeTypeOf('number');
    expect(bt.mtdAdditionalCalc).toBeCloseTo(withBonus.additional, 2);

    const plain = pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 6, profile: { category: 1 } });
    const pt = plain.snapshot.trace as Trace;
    expect(pt.Yt).toBe(0);
    expect(pt.Kt).toBe(0);
    expect(pt.K2t).toBe(0);
    // ABSENT, not zero. "The year-total step did not run" and "the year total was RM 0.00" are different
    // statements, and the screen prints a different sentence for each.
    expect(pt.totalTaxYear, 'a step that never ran must not be recorded as zero').toBeUndefined();
    expect(pt.totalMtdYear).toBeUndefined();
  });

  it('records this month’s zakat, which the MTD is already net of', () => {
    const r = pcbMonth({
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 4,
      zakatCurrent: 60,
      profile: { category: 1 },
    });
    const tr = r.snapshot.trace as Trace;
    expect(tr.zakatCurrent).toBe(60);
    // The pre-offset leg is recorded, so the screen can show the offset happening rather than presenting
    // the net figure as though the formula produced it directly.
    expect(tr.mtdNormalCalc).toBe(r.normalPreZakat);
    expect(r.normal).toBeLessThan(tr.mtdNormalCalc);
  });

  it('a flat-rate payee records the remuneration the percentage was applied to', () => {
    const flat = statutory(9000, undefined, 1000, 0, undefined, { resident: false });
    const meta = flat.pcbMeta as { rate: number; flatRate: number; trace?: { remuneration: number; additional: number; rate: number } };
    expect(meta.rate, 'the three keys that were already here are untouched').toBe(0.3);
    expect(meta.trace?.remuneration).toBe(9000);
    expect(meta.trace?.additional).toBe(1000);
    expect(meta.trace?.rate).toBe(0.3);
  });

  it('group coordination returns the PRE-SPLIT person-level snapshot, not one per slice', () => {
    // ADR-0029 taxes the person ONCE on the combined remuneration and then allocates. A trace per
    // employment would restate a calculation that never ran, so the coordinator hands back the single
    // snapshot the combined `pcbMonth` produced.
    const c = coordinatedPcbForPerson(
      [
        { employmentId: 'a', monthlyWage: 6000, epfMonthly: 660 },
        { employmentId: 'b', monthlyWage: 4000, epfMonthly: 440 },
      ],
      { month: 1, profile: { category: 1 } },
    );
    expect(c.snapshot.trace, 'the person-level working is returned').toBeTruthy();
    expect((c.snapshot.trace as Trace).Y1, 'on the COMBINED remuneration').toBe(10000);
    expect(c.byEmployment.size).toBe(2);
  });
});

// ───────────────────────────── The read model refuses to invent ─────────────────────────────

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 4000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 13000,
};

const STORED_TRACE = {
  M: 70000, R: 0.19, B: 3700, taxOnP1: 4831.65,
  category: 1, childCount: 0,
  Y1: 6600, K1: 0, Y2: 6600, K2: 0,
  Yt: 0, Kt: 0, K2t: 0,
  Z: 0, lpAccumulated: 0, lpCurrent: 0, zakatCurrent: 0,
  mtdNormalCalc: 402.65, mtdAdditionalCalc: 0,
  mtdNormalFloored: 402.65, mtdAdditionalFloored: 0, zakatLeftover: 0,
};

describe('45df860a — explainPcb reports a missing working as MISSING', () => {
  const mtdBlob = (trace?: unknown) => ({
    pcb: 402.65,
    epfEmployee: 0,
    pcbMeta: {
      month: 1, n: 11, ytdNet: 0, epfClaimed: 0, pcbPaid: 0, P1: 75956.07,
      reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
      ...(trace !== undefined ? { trace } : {}),
    },
  });

  it('reads a stored trace whole', () => {
    const r = explainPcb(mtdBlob(STORED_TRACE), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.trace).not.toBeNull();
    expect(r.trace!.M).toBe(70000);
    expect(r.trace!.R).toBe(0.19);
    expect(r.trace!.B).toBe(3700);
    expect(r.trace!.mtdNormalCalc).toBe(402.65);
    // Absent year totals read as NULL, which the screen renders as "this month had no additional
    // remuneration" — not as RM 0.00.
    expect(r.trace!.totalTaxYear).toBeNull();
    expect(r.trace!.totalMtdYear).toBeNull();
  });

  it('a payslip processed BEFORE this change has no trace, and is not given one', () => {
    // THE FAILURE THIS EXISTS TO STOP: `Number(undefined)` is 0, so a careless reader would hand the
    // screen a complete-looking bracket of RM 0.00 at a 0.00% rate for every payslip in the archive.
    const r = explainPcb(mtdBlob(), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.trace, 'not recorded, and NOT zero-filled').toBeNull();
    // Everything that WAS recorded still reads normally — the absence is scoped to what is absent.
    expect(r.chargeableIncome).toBe(75956.07);
    expect(r.pcb).toBe(402.65);
    expect(r.reliefs.total).toBe(9000);
  });

  it('a half-written trace is treated as no trace at all', () => {
    for (const partial of [{}, { M: 70000 }, { M: 70000, R: 0.19 }, [] as unknown, 'nope' as unknown, null as unknown]) {
      const r = explainPcb(mtdBlob(partial), CURRENT);
      if (r.kind !== 'mtd') throw new Error('unreachable');
      expect(r.trace, `${JSON.stringify(partial)} is not a trace`).toBeNull();
    }
  });

  it('a trace WITHOUT the post-RM10 legs is no trace either — the last line cannot be written from it', () => {
    // `Number(undefined)` is 0, so a trace stamped before the §E.3/§E.5 legs were recorded would print
    // `max( 0, 0.00 − 0.00 ) + …` beside a PCB of RM 402.65: a working that contradicts its own answer,
    // which is the one failure worse than "not recorded". The gate refuses it outright.
    const { mtdNormalFloored: _a, mtdAdditionalFloored: _b, zakatLeftover: _c, ...preFloor } = STORED_TRACE;
    const r = explainPcb(mtdBlob(preFloor), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.trace).toBeNull();
    expect(r.pcb, 'and everything genuinely recorded still reads').toBe(402.65);
  });

  it('reads the post-RM10 legs and the zakat remainder whole', () => {
    const r = explainPcb(
      mtdBlob({ ...STORED_TRACE, zakatCurrent: 500, mtdNormalFloored: 402.65, mtdAdditionalFloored: 0, zakatLeftover: 97.35 }),
      CURRENT,
    );
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.trace!.mtdNormalFloored).toBe(402.65);
    expect(r.trace!.mtdAdditionalFloored).toBe(0);
    expect(r.trace!.zakatLeftover).toBe(97.35);
  });

  it('a flat-rate payslip predating the change reports its missing remuneration too', () => {
    const old = explainPcb({ pcb: 1500, pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3 } }, CURRENT);
    if (old.kind !== 'flat') throw new Error('unreachable');
    expect(old.trace).toBeNull();

    const fresh = explainPcb(
      { pcb: 1500, pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3, trace: { remuneration: 5000, additional: 0, rate: 0.3 } } },
      CURRENT,
    );
    if (fresh.kind !== 'flat') throw new Error('unreachable');
    expect(fresh.trace!.remuneration).toBe(5000);
  });
});

// ───────────────────────── A PCB set by hand explains nothing on this screen ─────────────────────────

describe('45df860a — a manually adjusted PCB is declared, not quietly explained', () => {
  const overridden = (adjustment: unknown) => ({
    pcb: 120,
    pcbBonus: 0,
    epfEmployee: 0,
    pcbMeta: {
      month: 1, n: 11, ytdNet: 0, epfClaimed: 0, pcbPaid: 0, P1: 75956.07,
      reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
      trace: STORED_TRACE,
    },
    ...(adjustment !== undefined ? { adjustment } : {}),
  });

  it('separates what was DEDUCTED from what the recorded working explains', () => {
    // 2961a7ae overwrites statutory.pcb and leaves pcbMeta exactly as the engine wrote it — no second
    // calculation ran, so there is none to record. Every figure in the trace therefore describes 402.65
    // while 120.00 is what left the employee's pay. A screen that read only `pcb` would present a
    // complete, correct LHDN working as the derivation of an amount nobody computed.
    const r = explainPcb(
      overridden({ reason: 'LHDN instalment letter', lines: { pcb: { system: 402.65, applied: 120 } } }),
      CURRENT,
    );
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.pcb, 'what was deducted').toBe(120);
    expect(r.pcbSystem, 'what the working below explains').toBe(402.65);
    expect(r.basis).toEqual({
      kind: 'manual',
      system: 402.65,
      applied: 120,
      prior: null,
      engineRun: null,
      reason: 'LHDN instalment letter',
    });
    // The normal/additional split belongs to the CALCULATION, so it sums to the system figure. Splitting
    // a hand-set amount along the engine's proportions would invent a breakdown nobody produced.
    expect(r.pcbNormal + r.pcbAdditional).toBeCloseTo(r.pcbSystem, 2);
  });

  it('an override on a DIFFERENT statutory line leaves the tax working intact', () => {
    // applyStatutoryAdjustment deliberately does not cascade: overriding EPF does not re-derive PCB, so
    // statutory.pcb is still the engine's own figure and there is nothing to warn about. Warning anyway
    // would train readers to ignore the banner on the payslips where it matters.
    const r = explainPcb(
      { ...overridden({ reason: 'EPF correction', lines: { epfEmployee: { system: 550, applied: 500 } } }), pcb: 402.65 },
      CURRENT,
    );
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.basis).toBeNull();
    expect(r.pcbSystem).toBe(402.65);
  });

  it('no adjustment at all ⇒ the two figures are the same number and no banner exists', () => {
    for (const stamp of [undefined, null as unknown, {}, { reason: 'x' }, { reason: 'x', lines: {} }, [] as unknown]) {
      const r = explainPcb({ ...overridden(stamp), pcb: 402.65 }, CURRENT);
      if (r.kind !== 'mtd') throw new Error('unreachable');
      expect(r.basis, `${JSON.stringify(stamp)} is not an override`).toBeNull();
      expect(r.pcbSystem).toBe(r.pcb);
    }
  });

  it('a flat-rate payslip carries the same two figures', () => {
    const r = explainPcb(
      {
        pcb: 900,
        pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3, trace: { remuneration: 5000, additional: 0, rate: 0.3 } },
        adjustment: { reason: 'agreed with LHDN', lines: { pcb: { system: 1500, applied: 900 } } },
      },
      CURRENT,
    );
    if (r.kind !== 'flat') throw new Error('unreachable');
    expect(r.pcbSystem).toBe(1500);
    expect(r.pcb).toBe(900);
    expect(r.basis!.reason).toBe('agreed with LHDN');
  });
});

// ─────────────── An ADDITIONAL run deducts the increase, and the working is the month's ───────────────

describe('45df860a — an additional run’s working is the WHOLE MONTH, and the screen is told so', () => {
  /**
   * ADR-0024: a bonus / off-cycle run's statutory figures are the INCREMENT of the cumulative month —
   * `deltaStat` re-runs the month with and without this run's additional remuneration and keeps the
   * difference. It rewrites the DELTA_KEYS and nothing else, so `pcbMeta` rides through as the CUMULATIVE
   * month's working while `pcb` is the increase.
   *
   * THAT IS THE SAME DEFECT SHAPE AS A HAND-SET PCB, and it was live on every bonus payslip: a complete
   * LHDN working, correct in every line, printed as the derivation of a figure nobody deducted. The
   * numbers below are the concrete run from the report — wage 12,000, month 6, prior PCB 2,000, a 20,000
   * bonus on an off-cycle run — where the substituted formula evaluated to 7,071.30 beside `= RM 4,999.85`
   * and the additional leg swallowed the whole system figure, leaving a normal leg of RM 0.00 beside a
   * trace that plainly showed 2,071.45.
   */
  const DELTA_TRACE = {
    ...STORED_TRACE,
    Yt: 20000, Kt: 0, K2t: 0,
    totalTaxYear: 20000, totalMtdYear: 12000,
    mtdNormalCalc: 2071.45, mtdAdditionalCalc: 4999.85,
    mtdNormalFloored: 2071.45, mtdAdditionalFloored: 4999.85, zakatLeftover: 0,
  };
  const deltaBlob = (over?: Record<string, unknown>, blob?: Record<string, unknown>) => ({
    // What the payslip carries: the INCREASE.
    pcb: 4999.85,
    pcbBonus: 4999.85,
    epfEmployee: 0,
    pcbMeta: {
      month: 6, n: 6, ytdNet: 60000, epfClaimed: 6600, pcbPaid: 2000, P1: 120000, P2: 140000,
      reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
      trace: DELTA_TRACE,
      // What the working actually explains: the whole month.
      delta: { cumulative: 7071.3, prior: 2071.45, cumulativeBonus: 4999.85 },
      ...over,
    },
    ...blob,
  });

  it('reads the month’s figure as what the working explains, and the increase as what was deducted', () => {
    const r = explainPcb(deltaBlob(), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.pcb, 'what this payslip deducted').toBe(4999.85);
    expect(r.pcbSystem, 'what every figure below it describes').toBe(7071.3);
    expect(r.basis).toEqual({
      kind: 'additionalRun',
      system: 7071.3,
      applied: 4999.85,
      prior: 2071.45,
      engineRun: 4999.85,
      reason: '',
    });
    // The increment identity, stated rather than assumed: the month, less what the month's earlier runs
    // already covered, IS the deduction on this slip.
    expect(r.basis!.system - r.basis!.prior!).toBeCloseTo(r.pcb, 2);
  });

  it('RECONCILES: the working lands on the month’s PCB — which is now the figure printed beside it', () => {
    // Rule 17, on the path the whole suite could not see. Every other reconciliation here calls pcbMonth
    // directly, where `total = normal + additional` by construction; the delta only exists once the
    // kernel differences two of those calls, so this is the one case that catches the mismatch.
    const r = explainPcb(deltaBlob(), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    const tr = r.trace!;
    const net =
      Math.max(0, tr.mtdNormalFloored - tr.zakatCurrent) +
      Math.max(0, tr.mtdAdditionalFloored - Math.max(0, tr.zakatCurrent - tr.mtdNormalFloored));
    expect(net, 'the §E.3 / §E.5 line evaluates to the MONTH, not to the increase').toBeCloseTo(r.pcbSystem, 2);
    expect(net, 'and it is NOT the deducted figure — the screen must label the two apart').not.toBeCloseTo(r.pcb, 2);
  });

  it('splits normal / additional along the SAME month the working describes', () => {
    // `statutory.pcbBonus` is a DELTA_KEY too, so pairing the blob's copy with a cumulative system figure
    // produced pcbNormal = 0.00 sitting beside a trace that showed 2,071.45 — the screen contradicting
    // itself about the same slip. The cumulative leg comes out of the same stamp the total does.
    const r = explainPcb(deltaBlob(), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.pcbAdditional).toBe(4999.85);
    expect(r.pcbNormal, 'the normal leg the trace shows, not zero').toBeCloseTo(2071.45, 2);
    expect(r.pcbNormal + r.pcbAdditional).toBeCloseTo(r.pcbSystem, 2);
    expect(r.pcbNormal).toBeCloseTo(r.trace!.mtdNormalCalc, 2);
  });

  it('a half-written delta stamp is no stamp at all — it must never claim the month was RM 0.00', () => {
    // Same gate, same reason as `readTrace`: `Number(undefined)` is 0, and a banner asserting "PCB for
    // the whole month RM 0.00" is a false statement about someone's tax rather than a missing figure.
    for (const bad of [{}, { cumulative: 7071.3 }, { prior: 2071.45 }, [] as unknown, 'nope' as unknown, null as unknown]) {
      const r = explainPcb(deltaBlob({ delta: bad }), CURRENT);
      if (r.kind !== 'mtd') throw new Error('unreachable');
      expect(r.basis, `${JSON.stringify(bad)} is not a delta stamp`).toBeNull();
      expect(r.pcbSystem, 'and the slip reads as an ordinary one').toBe(r.pcb);
    }
  });

  it('a delta whose baseline is ZERO raises no banner — the increment IS the month', () => {
    // `prior` is the month WITHOUT this run. When it is zero the earlier runs carried no PCB, so the
    // increment and the month are the same number and the working DOES explain the deduction. An amber
    // card over a payslip with nothing wrong is how readers learn to scroll past the one that matters —
    // the same reason an adjustment to a non-PCB line raises none.
    const r = explainPcb(
      deltaBlob({ delta: { cumulative: 4999.85, prior: 0, cumulativeBonus: 4999.85 } }),
      CURRENT,
    );
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.basis).toBeNull();
    expect(r.pcbSystem).toBe(r.pcb);
    // …and the split still comes off the stamp, because that side is about WHICH MONTH the legs belong
    // to rather than about a gap between two figures.
    expect(r.pcbAdditional).toBe(4999.85);
  });

  it('a payslip with no delta stamp at all is untouched — a regular run has nothing to declare', () => {
    const r = explainPcb(deltaBlob({ delta: undefined }), CURRENT);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.basis).toBeNull();
    expect(r.pcbSystem).toBe(r.pcb);
    expect(r.pcbAdditional, 'and the split falls back to the blob’s own leg').toBe(4999.85);
  });

  it('an increment run whose PCB was ALSO set by hand keeps all three figures apart', () => {
    // Both mechanisms at once. The working still describes the month, so the month keeps the `system`
    // seat; the engine's own increment for this run is not lost — it becomes `engineRun`, printed on its
    // own row — and `applied` is what left the employee's pay.
    const r = explainPcb(
      deltaBlob(undefined, {
        pcb: 3000,
        adjustment: { reason: 'LHDN instalment letter', lines: { pcb: { system: 4999.85, applied: 3000 } } },
      }),
      CURRENT,
    );
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.basis).toEqual({
      kind: 'additionalRunManual',
      system: 7071.3,
      applied: 3000,
      prior: 2071.45,
      engineRun: 4999.85,
      reason: 'LHDN instalment letter',
    });
    expect(r.pcbSystem, 'the working explains the month, not the operator’s figure').toBe(7071.3);
    expect(r.pcb).toBe(3000);
  });

  it('a FLAT-rate additional run has the identical shape, and is declared the same way', () => {
    // `pcbMeta.trace.remuneration / additional` are the cumulative month's too, so ( remuneration +
    // additional ) × rate overshoots the deduction by exactly the same amount. Same stamp, same banner.
    const r = explainPcb(
      {
        pcb: 4500,
        pcbMeta: {
          nonResident: true, flatRate: 0.3, rate: 0.3,
          trace: { remuneration: 5000, additional: 20000, rate: 0.3 },
          delta: { cumulative: 7500, prior: 3000, cumulativeBonus: 6000 },
        },
      },
      CURRENT,
    );
    if (r.kind !== 'flat') throw new Error('unreachable');
    expect(r.pcbSystem, 'what ( 5,000 + 20,000 ) × 30% actually produces').toBe(7500);
    expect(r.pcb, 'what this payslip deducted').toBe(4500);
    expect(r.basis!.kind).toBe('additionalRun');
    expect(r.trace!.remuneration + r.trace!.additional).toBeCloseTo(r.pcbSystem / 0.3, 2);
  });
});

// ───────────────────────────── One screen, two doors ─────────────────────────────

describe('45df860a — the shared screen, and the two entry points that reach it', () => {
  const PAGE = 'app/payroll/pcb-detail/page.tsx';
  const VIEW = 'app/payroll/pcb-detail/pcb-detail-view.tsx';
  const PAYSLIP = 'app/payroll/individual-payslip/page.tsx';
  const HISTORY = 'app/payroll/transaction-view/history-table.tsx';

  it('the new route is registered in the function-access matrix', () => {
    // RULE 20. A guarded page with no matrix column is a screen nobody can grant or revoke, and
    // test/function-access.test.ts fails the whole suite over it — but only the FULL gate sees that,
    // so it is asserted here too, beside the change that creates the risk.
    expect(REGISTERED_ROUTES.has('/payroll/pcb-detail')).toBe(true);
    expect(read(PAGE), 'and the page is actually guarded').toContain('scopedAdmin');
  });

  it('the screen is fenced by the SAME admin read the payslip screen uses, and never the ESS gate', () => {
    const page = code(PAGE);
    expect(page).toContain('payslipForReview');
    expect(page, 'the ESS release gate must not be borrowed, widened or bypassed').not.toContain('payslipDetail');
    // The fence is the read's own companyIds argument, which fails closed on an empty scope.
    expect(page).toMatch(/payslipForReview\(s,\s*\{\s*companyIds:\s*scopeIds/);
  });

  it('the screen CANNOT recompute the tax — it has no engine to do it with', () => {
    // The whole promise of this item is "Displayed PCB Detail = Actual Payroll PCB Calculation". The only
    // durable way to keep that promise is for the screen to be incapable of a second calculation, so
    // neither the page nor the view may reach for the payroll engine or the statutory tables.
    for (const f of [PAGE, VIEW]) {
      const imports = read(f).split('\n').filter((l) => l.trimStart().startsWith('import '));
      for (const forbidden of ['pcbMonth', 'localization/my/payroll', 'statutory-tables', 'packFor']) {
        expect(imports.join('\n'), `${f} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(read(VIEW), 'the working is read from the payslip’s own stamp').toContain('PcbExplanation');
  });

  it('BOTH entry points link to the one screen, in a new tab, with the payslip id', () => {
    for (const f of [PAYSLIP, HISTORY]) {
      const src = code(f);
      expect(src, `${f} must link to the shared screen`).toContain('/payroll/pcb-detail?payslipId=');
      expect(src, `${f} must name the run, not re-select one`).toMatch(/payslipId=\$\{encodeURIComponent\(/);
      expect(src, `${f}: the reporter asked for a new tab`).toMatch(/target="_blank"/);
      expect(src, `${f}: target=_blank without this hands the new tab a live window.opener handle`).toMatch(
        /rel="noopener noreferrer"/,
      );
    }
  });

  it('the payslip screen no longer carries a SECOND display of the same calculation', () => {
    // "This avoids having two different PCB calculation engines or two different calculation displays."
    // Growing the old in-page disclosure into the full working would have produced exactly the second
    // display the request rules out, so it was replaced by the link rather than joined by one.
    const src = code(PAYSLIP);
    expect(src, 'the in-page PCB disclosure is gone').not.toContain('explainPcb');
    expect(src, 'and so is the relief fallback it needed').not.toContain('currentPcbReliefs');
    expect(src, 'the amount itself is the link').toContain('pcbViewCalculation');
  });

  it('the retired drill-down captions are STILL in all six catalogs', () => {
    // The keys the disclosure used are deliberately NOT deleted. Re-adding a deleted key later is the
    // MISSING_MESSAGE trap this repo has hit before, and a stranded key costs nothing.
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { individualPayslip: Record<string, string> };
      }).payroll.individualPayslip;
      for (const k of ['pcbHeading', 'pcbUnavailable', 'pcbFlatNote', 'pcbReliefFromSnapshot', 'pcbReliefFromCurrent']) {
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc}`).toBeTruthy();
      }
      // …and the two NEW captions this screen's entry point needs.
      for (const k of ['pcbViewCalculation', 'pcbDetailHint']) {
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc}`).toBeTruthy();
      }
    }
  });

  it('every caption the screen resolves exists in all six catalogs, computed keys included', () => {
    // The cycle, category and step labels are resolved through a lookup map, so the repo's i18n coverage
    // scan (literal keys only) cannot see them. They are pinned here or they ship as MISSING_MESSAGE.
    const computed = [
      'cycleRegular', 'cycleOffCycle', 'cycleBonus', 'cycleAdjustment',
      'category1', 'category2', 'category3',
      // THIRTEEN, not eleven. The chain used to stop at the normal leg and then print the deducted PCB
      // underneath it, silently skipping the bonus leg, the RM10 rule and the zakat offset.
      ...Array.from({ length: 13 }, (_, i) => `step${i + 1}`),
      // The banner, the two summary lines and the two final lines are chosen by `basis.kind` through a
      // lookup, for the same reason and with the same blind spot.
      'overrideHeading', 'overrideBanner', 'deltaHeading', 'deltaBanner', 'deltaOverrideHeading', 'deltaOverrideBanner',
      'overrideSystem', 'deltaMonthTotal', 'overrideApplied', 'deltaApplied', 'deltaPrior', 'deltaEngineRun',
      'netMtdSystem', 'netMtdMonth', 'netMtdDeducted', 'netMtdRun',
      'finalPcbSystem', 'finalPcbMonth', 'finalPcbDeducted', 'finalPcbRun',
      'overrideNote', 'deltaNote', 'deltaOverrideNote', 'additionalMtdDeducted', 'additionalMtdMonth',
      // 7f251381 adds ~59 more computed keys — the LHDN worksheet's symbols, captions, section headings
      // and absence markers. They are NOT repeated here: `test/7f251381-pcb-lhdn-worksheet.test.ts`
      // derives that list back out of `pcbWorksheet`'s own source and asserts it is EXHAUSTIVE, which a
      // hand-maintained copy in a second file could only drift from. The set-equality check below still
      // covers every one of them across all six catalogs.
    ];
    const keysOf = (loc: string) =>
      Object.keys(
        (JSON.parse(read(`messages/${loc}.json`)) as { payroll: { pcbDetail: Record<string, string> } })
          .payroll.pcbDetail,
      ).sort();
    const en = keysOf('en');
    expect(en.length, 'the namespace exists and is not a stub').toBeGreaterThan(50);
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { pcbDetail: Record<string, string> };
      }).payroll.pcbDetail;
      expect(keysOf(loc), `${loc} must carry the same key set — no half-translated screen`).toEqual(en);
      for (const k of computed) expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
      // ONE key takes an ICU argument. Every other caption is resolved with a bare t(), which THROWS at
      // render on a stray brace and paints the key path onto the screen.
      for (const [k, v] of Object.entries(blk)) {
        if (k === 'currencyNote') expect(v, `${loc}.currencyNote must interpolate`).toContain('{currency}');
        else expect(v, `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
    // The Transaction Detail caption lives in ITS screen's namespace, not this one.
    for (const loc of LOCALES) {
      const h = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { transactions: { view: { history: Record<string, string> } } };
      }).payroll.transactions.view.history;
      expect(h.viewPcbCalculation, `payroll.transactions.view.history.viewPcbCalculation in ${loc}`).toBeTruthy();
    }
  });

  it('the formula is shown BOTH symbolically and substituted — never the symbols alone', () => {
    // Requirement 14, and the reason the screen has a `Formula` primitive at all: a bare
    // [((P-M)R+B-(Z+X))/(n+1)] tells a payroll checker nothing they did not already know.
    const view = code(VIEW);
    expect(view).toContain('formulaLabel');
    expect(view).toContain('substitutedLabel');
    expect(view).toContain('resultLabel');
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    for (const sym of ['P', 'M', 'R', 'B', 'Z', 'X', 'n']) {
      expect(en.formulaMtd, `the symbolic formula must name ${sym}`).toContain(sym);
    }
    expect(en.pFormula).toContain('Σ(Y − K)');
    expect(en.pFormula).toContain('LP₁');
  });

  it('each substituted expression is built from the terms the engine actually used', () => {
    // NOTHING ON THIS SCREEN EVALUATES — every "= RM x" is a stored engine figure — so a term that does
    // not belong in an expression cannot be caught by any assertion about numbers. It can only be caught
    // by reading the string that gets assembled. These three slices are the three places the screen got
    // it wrong: a bonus leg glued onto P₁, a net line that skipped §E.3/§E.5, and a zero floor dropped
    // from a bracket line whose B is negative for every employee claiming the RM400 rebate.
    const view = code(VIEW);
    const between = (from: string, to: string) => {
      const a = view.indexOf(from);
      const b = view.indexOf(to, a);
      expect(a, `marker not found: ${from}`).toBeGreaterThan(-1);
      expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
      return view.slice(a, b);
    };

    // P₁ — §D.1 projects normal remuneration ONLY. No Yₜ, no Kₜ, and the plain K₂.
    const p1 = between("formula={t('pFormula')}", "resultLabel={t('pResult')}");
    expect(p1, 'the bonus leg belongs to P₂, not to P₁').not.toContain('trace.Yt');
    expect(p1).not.toContain('trace.Kt');
    expect(p1).not.toContain('trace.K2t');
    expect(p1).toContain('trace.K2');

    // P₂ — §D.2, with the bonus leg AND the re-estimated EPF leg. K₂ₜ was stored and never rendered.
    const p2 = between("formula={t('p2Formula')}", "resultLabel={t('p2Result')}");
    expect(p2).toContain('trace.Yt');
    expect(p2).toContain('trace.Kt');
    expect(p2, 'P₂ re-estimates the projected EPF because the bonus ate into the same cap').toContain('trace.K2t');
    expect(view, 'and it lands on the stored P₂, never on P₁').toMatch(
      /resultLabel=\{t\('p2Result'\)\}\s*\n\s*result=\{rm\(explanation\.chargeableIncomeWithAdditional\)\}/,
    );

    // The bracket line — both zero floors, because B carries the rebate as a negative number.
    const mtd = between("formula={t('formulaMtd')}", "resultLabel={t('resultLabel')}");
    expect((mtd.match(/max\( 0,/g) ?? []).length, 'annualTaxFor floors, and pcbMonth floors again').toBe(2);

    // The last line — §E.3 legs, not the calculated ones, and the zakat cascade with its clamps.
    const net = between("formula={t('formulaNet')}", "resultLabel={t('resultLabel')}");
    expect(net, 'A is the leg AFTER the RM10 rule').toContain('mtdNormalFloored');
    expect(net, 'and so is E').toContain('mtdAdditionalFloored');
    expect((net.match(/max\( 0,/g) ?? []).length, 'zero-clamped twice, plus the leftover').toBe(3);
  });

  it('a hand-set PCB is announced, and the working lands on the figure it actually explains', () => {
    // The screen reads `pcbSystem` wherever a working ends, and `pcb` only where the DEDUCTION is meant.
    // Both must be present, and the banner must exist, or a manual override turns the whole screen into
    // a derivation of a number nobody deducted.
    const view = code(VIEW);
    expect(view).toContain('explanation.basis');
    expect(view).toContain('explanation.pcbSystem');
    // ⚠️ THE CAPTION DECISION MOVED TO core/ IN ad7bc503, so this guard moved WITH it rather than being
    // satisfied by a leftover literal. It used to grep this component for each key; the eight-branch
    // ternary that chose them is now `pcbBasisLabels`, read by BOTH the screen and the downloaded document
    // (which carried no banner at all before). So the keys are pinned to the STATE that must produce them,
    // which is strictly more than the substring search asserted, and the component is still required to
    // render the banner through that label set.
    expect(view, 'the screen reads the caption set rather than choosing its own').toContain('pcbBasisLabels(basis)');
    for (const k of ['L.bannerHeading', 'L.banner', 'L.bannerSystem', 'L.bannerApplied', 'deltaPrior', 'overrideReason']) {
      expect(view, `the banner must render ${k}`).toContain(k);
    }
    const manual = pcbBasisLabels({ kind: 'manual', system: 900, applied: 500, prior: null, engineRun: null, reason: 'x' });
    expect(manual.bannerHeading, 'a hand-set PCB is announced as one').toBe('overrideHeading');
    expect(manual.banner).toBe('overrideBanner');
    expect(manual.bannerSystem, "the working explains the engine's own figure").toBe('overrideSystem');
    expect(manual.bannerApplied).toBe('overrideApplied');
    expect(manual.finalDeducted).toBe('finalPcbDeducted');
    expect(manual.note).toBe('overrideNote');
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    expect(en.overrideBanner.toLowerCase(), 'and it must say the working does not explain the deduction')
      .toContain('not an explanation');
  });

  it('an ADDITIONAL run is announced on the same banner, with its own words', () => {
    // The delta run has the identical shape — a complete working about a figure the payslip does not
    // carry — so it rides the identical mechanism. What it must NOT do is borrow the hand-set wording:
    // "set by hand" is a false statement about a bonus run, and a reader who is told the wrong reason
    // stops trusting the banner on the payslips where the reason matters.
    const view = code(VIEW);
    // Same update as above: the wording decision lives in `pcbBasisLabels` now, so each key is pinned to
    // the basis kind that must produce it instead of to its presence somewhere in this component.
    for (const k of ['deltaPrior', 'deltaEngineRun', 'additionalMtdMonth']) {
      expect(view, `the screen must render ${k}`).toContain(k);
    }
    const b = (over: Partial<PcbBasis>): PcbBasis => ({
      kind: 'additionalRun', system: 900, applied: 300, prior: 600, engineRun: null, reason: '', ...over,
    });
    const delta = pcbBasisLabels(b({}));
    expect(delta.bannerHeading, 'an increment run must NOT borrow the hand-set heading').toBe('deltaHeading');
    expect(delta.banner).toBe('deltaBanner');
    expect(delta.bannerSystem, 'the working is the WHOLE month').toBe('deltaMonthTotal');
    expect(delta.bannerApplied).toBe('deltaApplied');
    expect(delta.netSystem).toBe('netMtdMonth');
    expect(delta.netDeducted).toBe('netMtdRun');
    expect(delta.finalSystem).toBe('finalPcbMonth');
    expect(delta.finalDeducted).toBe('finalPcbRun');
    expect(delta.note).toBe('deltaNote');
    const both = pcbBasisLabels(b({ kind: 'additionalRunManual', engineRun: 320 }));
    expect(both.bannerHeading, 'and a hand-set increment run gets its own third wording').toBe('deltaOverrideHeading');
    expect(both.banner).toBe('deltaOverrideBanner');
    expect(both.note).toBe('deltaOverrideNote');
    // A hand-set run that is NOT an increment keeps the month-less captions, which is the distinction the
    // two figures turn on: `prior == null` means the working explains the engine's figure, not the month.
    expect(pcbBasisLabels(b({ kind: 'additionalRunManual', prior: null })).bannerSystem).toBe('overrideSystem');
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    expect(en.deltaBanner.toLowerCase(), 'it must say what was deducted was the increase').toContain('increase');
    expect(en.deltaBanner.toLowerCase(), 'and that the working is the whole month').toContain('whole month');
    expect(en.deltaHeading.toLowerCase(), 'the delta heading must not claim a manual adjustment')
      .not.toContain('by hand');
  });

  it('the flat-rate rounding note does not promise 5 sen and then name the RM10 floor', () => {
    // The note used to say the product "lands within 5 sen of the figure beside it" in the same breath
    // as the RM10 rule. With the floor in play the gap is up to RM 9.99 — remuneration of RM30 at 30%
    // prints 9.00 beside `= RM 0.00` — so the sentence contradicted its own screen. The two rules are
    // now stated as two, and the nil case is named.
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { pcbDetail: Record<string, string> };
      }).payroll.pcbDetail;
      const note = blk.flatRoundingNote;
      expect(note, `${loc}: the RM10 rule is still named`).toContain('RM10');
      const fiveSen = note.indexOf('5');
      const floor = note.indexOf('RM10');
      expect(floor, `${loc}: the RM10 case must be stated AFTER the 5-sen claim, not inside it`)
        .toBeGreaterThan(fiveSen);
    }
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    expect(en.flatRoundingNote.toLowerCase(), 'and the floored case must say what is shown instead')
      .toContain('nil');
  });

  it('the missing-working sentence is on the screen, and it does not say zero', () => {
    const view = code(VIEW);
    expect(view, 'the banner').toContain('traceNotRecorded');
    expect(view, 'and the inline marker used in place of each missing figure').toContain('notRecordedShort');
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } })
      .payroll.pcbDetail;
    expect(en.traceNotRecorded.toLowerCase()).toContain('not recorded');
    expect(en.traceNotRecorded.toLowerCase(), 'and it must say the figures are NOT recalculated').toContain(
      'not recalculated',
    );
  });
});

// ───────────────────────────── Behavioural: a real run explains itself ─────────────────────────────

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

describe('45df860a — a payroll run processed today closes its own formula', () => {
  it('stamps the trace onto the payslip, and the stored figures reproduce the deducted PCB to the sen', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Pcb Detail', primaryEmail: 'pcb.detail@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 15000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011601', taxCategory: 1 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId });

    const rows = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
    });
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId: rows[0].id });
    const fallback = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      asOf: '2026-03-28',
    });
    const x = explainPcb(row!.statutory, fallback);
    expect(x.kind).toBe('mtd');
    if (x.kind !== 'mtd') throw new Error('unreachable');

    expect(x.reliefSource).toBe('snapshot');
    expect(x.trace, 'a run processed today records the whole working').not.toBeNull();
    const tr = x.trace!;
    expect(tr.R).toBeGreaterThan(0);
    expect(tr.Y1).toBeGreaterThan(0);
    expect(tr.Y2).toBe(tr.Y1);

    // THE CLOSING OF THE LOOP: what the SCREEN will read, put back through the LHDN steps, is the PCB the
    // employee actually had deducted. If these ever diverge, the detail screen is lying about the payslip.
    const substituted = ceil5sen(
      trunc2(
        Math.max(0, ((x.chargeableIncome - tr.M) * tr.R + tr.B - (tr.Z + x.pcbPaidYtd)) / (x.remainingMonths + 1)),
      ),
    );
    expect(substituted).toBeCloseTo(tr.mtdNormalCalc, 2);
    expect(tr.mtdNormalCalc, 'and this month is above the RM10 floor with no zakat, so it IS the deduction')
      .toBeGreaterThanOrEqual(10);
    expect(x.pcb).toBeCloseTo(tr.mtdNormalCalc, 2);
  });

  it('an ADDITIONAL run records the month it explains, and the working closes on THAT figure', async () => {
    // THE CASE THE WHOLE SUITE COULD NOT SEE. Every other reconciliation here calls `pcbMonth` directly,
    // where `total = normal + additional` by construction. The delta only comes into existence when the
    // KERNEL differences two of those calls (ADR-0024), so the mismatch between the carried-through
    // `pcbMeta` and the incremental `pcb` is invisible until a real bonus run is generated end to end.
    // `entitledCtx`, not `adminCtx`: `createAdditionalRun` reads the multi_cycle_payroll ENTITLEMENT off
    // the session snapshot, and adminCtx's snapshot is derived from the env (which test/env.ts clears).
    // The grant must be written BEFORE the context is built — a snapshot is a point-in-time read.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);

    const e = await hireEmployee(a, {
      person: { fullName: 'Pcb Bonus', primaryEmail: 'pcb.bonus@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 12000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011602', taxCategory: 1 });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: reg.batchId });
    const extra = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-06', runType: 'bonus' });
    await setPayrollInput(a, {
      batchId: extra.batchId,
      employmentId: e.employmentId,
      overtimeAmount: 0,
      bonusAmount: 20000,
    });
    await generatePayslips(a, { batchId: extra.batchId });

    const rows = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
    });
    const bonusRow = rows.find((r) => r.runType === 'bonus')!;
    expect(bonusRow, 'the bonus run produced a payslip').toBeTruthy();
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId: bonusRow.id });
    const fallback = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      asOf: '2026-06-28',
    });
    const x = explainPcb(row!.statutory, fallback);
    if (x.kind !== 'mtd') throw new Error('unreachable');

    // The deduction is the INCREASE; the working is the month's, and they are different numbers.
    expect(x.basis, 'the screen is told which figure it is looking at').not.toBeNull();
    expect(x.basis!.kind).toBe('additionalRun');
    expect(x.pcb, 'what the payslip deducted').toBeCloseTo(Number((row!.statutory as { pcb: number }).pcb), 2);
    expect(x.pcbSystem, 'the whole month, which is larger').toBeGreaterThan(x.pcb);
    expect(x.basis!.prior! + x.pcb, 'the increment identity holds on a real run').toBeCloseTo(x.pcbSystem, 2);

    // RULE 17 ACROSS THE DELTA. What the SCREEN reads, put back through §E.3 and §E.5, is the month's
    // PCB — the figure the screen now prints beside the expression. Before this it printed the increase
    // there, so the working overshot its own answer by everything the earlier run had already covered.
    const tr = x.trace!;
    expect(tr, 'a run processed today records the whole working').toBeTruthy();
    const net =
      Math.max(0, tr.mtdNormalFloored - tr.zakatCurrent) +
      Math.max(0, tr.mtdAdditionalFloored - Math.max(0, tr.zakatCurrent - tr.mtdNormalFloored));
    expect(net).toBeCloseTo(x.pcbSystem, 2);

    // …and the P₁ bracket line still closes on the normal leg it is printed above.
    const substituted = ceil5sen(
      trunc2(
        Math.max(0, ((x.chargeableIncome - tr.M) * tr.R + tr.B - (tr.Z + x.pcbPaidYtd)) / (x.remainingMonths + 1)),
      ),
    );
    expect(substituted).toBeCloseTo(tr.mtdNormalCalc, 2);

    // The split describes the SAME month as the working: a normal leg that is actually there, and the
    // two summing to the figure the working lands on rather than to the increment.
    expect(x.pcbNormal).toBeGreaterThan(0);
    expect(x.pcbAdditional).toBeGreaterThan(0);
    expect(x.pcbNormal + x.pcbAdditional).toBeCloseTo(x.pcbSystem, 2);
    expect(rm10Floor(r2(x.pcbNormal)), 'the normal leg is the one the trace shows').toBeCloseTo(
      tr.mtdNormalCalc,
      2,
    );
  });
});

/**
 * 45df860a — A MANGLED ID IN THE ADDRESS BAR IS A "NOT FOUND", NOT A 500.
 *
 * `payslip.id` is a uuid column, so `?payslipId=abc` reaches Postgres as `invalid input syntax for type
 * uuid` (SQLSTATE 22P02). This server component has no try/catch and the tree has no app/error.tsx or
 * global-error.tsx, so an unguarded read is an HTTP 500 — on a screen whose own header promises the
 * not-found card. Reachable by an authenticated admin from any truncated or re-typed shared link.
 *
 * Source-shape because the defect lives between the query string and the query: a unit test of the read
 * passes a real uuid and never sees it, and rendering the page needs a running server.
 */
describe('45df860a — an unparseable payslip id degrades', () => {
  it('shape-checks the id before it reaches the uuid column', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'app/payroll/pcb-detail/page.tsx'),
      'utf8',
    );
    expect(src, 'the page must test the id shape').toMatch(/UUID_RE\s*=\s*\/\^\[0-9a-f\]\{8\}/);
    expect(src, 'and gate the read on it, not merely on length').toMatch(
      /UUID_RE\.test\(sp\.payslipId\)\s*\?\s*sp\.payslipId\s*:\s*undefined/,
    );
    expect(src, 'a bare length check would let "abc" through').not.toMatch(
      /sp\.payslipId\.length\s*>\s*0\s*\?\s*sp\.payslipId/,
    );
  });
});
