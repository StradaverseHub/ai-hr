/**
 * r351 / ad7bc503 — THE SUBSTITUTED EXPRESSIONS, ASSEMBLED ONCE, FOR THE SCREEN **AND** THE DOCUMENT.
 *
 * WHY THIS FILE EXISTS AT ALL. Until r351 every one of these strings was built inline in
 * `pcb-detail-view.tsx`, which meant the DOWNLOADED PDF carried none of them: `shared.ts` pushed the
 * identification rows, the basis banner, the worksheet and the slip, and stopped. The reporter's
 * requirement 11 is "the same calculation details displayed on screen", so the formulas had to reach the
 * document — and the one way to keep that promise durably is for both surfaces to paint ONE assembly.
 * A second copy of an expression in shared.ts would be exactly the drift `shared.ts`'s own header spends
 * forty lines refusing for the read path.
 *
 * ⚠️ IT STILL DOES NO ARITHMETIC, AND THAT IS THE LOAD-BEARING PROPERTY (pcb-detail-view.tsx:10-17).
 * Every number below arrives already computed by `pcbMonth` and already read by `explainPcb`. This file
 * only chooses WHICH stored figures go where in a string; the `= RM x` each expression ends on is a
 * separate stored figure, never this file's evaluation of the expression it just printed. There is no
 * `+`, `*`, `Math.` or rounding anywhere in it — the formatters are injected, so even the 2-dp rendering
 * belongs to the caller.
 *
 * ⚠️ AND THE EXPRESSION BEING THE RIGHT ONE IS THE WHOLE BURDEN. Since nothing evaluates, a term that
 * does not belong is invisible to every assertion about numbers; it can only be caught by reading the
 * string against the engine. `test/pcb-detail.test.ts` reads these strings out of THIS file for that
 * reason, and the three mistakes it pins were all made here (in the view, before the move):
 *
 *   · THE (Yₜ − Kₜ) LIMB OF THE P₁ LINE IS ZERO — AND IT IS PRINTED, NOT HIDDEN. The agency publishes ONE
 *     P formula and prints "Where (Yt – Kt ) = 0" beneath it in every worked example for a month with no
 *     additional pay. Our engine's §D.1 likewise excludes additional remuneration ENTIRELY, in a bonus
 *     month too (`localization/my/payroll.ts`: `P1` has no Yₜ term at all). So the limb is printed as a
 *     literal zero pair — the agency's own annotation, in figures — and NOT as `trace.Yt`. Substituting
 *     the bonus there would overshoot the P beside it by the whole bonus, which is the defect the guard
 *     `expect(p1).not.toContain('trace.Yt')` exists to stop and which still holds.
 *
 *   · P₂ IS A SECOND CALCULATION, NOT THE SAME ONE WITH A LIMB SWITCHED ON. §D.2 re-estimates the
 *     projected EPF leg as K₂ₜ rather than K₂, because the EPF on the bonus has already eaten into the
 *     same annual relief cap. Two expressions, two stored results.
 *
 *   · THE AGENCY'S HEADLINE FORMULAS CARRY NO FLOORS; THE ARITHMETIC THAT RAN DOES. The symbolic row is
 *     the specification's own shape. The substituted row is what the engine actually evaluated, clamps
 *     included — because B carries the RM400 / RM800 rebate as a NEGATIVE number, so for a small P the
 *     bracket line is below zero, and a month whose accumulated Z + X already exceeds the year's tax is
 *     below zero again. Printing the bare bracket shows a negative expression beside a RM 0.00 answer.
 *     The gap between the two rows is not left to be noticed: §E's clamps and the RM10 rule are a
 *     VISIBLE step of their own on both surfaces (`floorHeading`).
 *
 * THE FOUR ROWS OF A STEP, AND WHY THE THIRD IS SOMETIMES ABSENT. The reporter asked for formula →
 * actual values → calculation → result. `calculation` is one step further along than `substituted`, and
 * it may contain NOTHING that is not itself a stored figure. Where the engine kept an intermediate it is
 * used (the bracket tax `taxOnP1`; the relief totals; the zakat remainder `zakatLeftover`); where it did
 * not — `(P − M) × R` is never persisted — the row is simply ABSENT, because computing it here is the one
 * thing this screen may not do. Each omission says so on the line where it is decided.
 */
import type { PcbExplanation, PcbTrace } from '@/core/pcb-explain';

/** The formatters the caller owns. Injected so that not even a 2-dp rendering happens in this file. */
export type PcbFormulaFormat = {
  /** A bare 2-decimal figure for use INSIDE an expression — the unit is stated once, above it. */
  b2: (v: number) => string;
  /** A percentage, for R. */
  pct: (r: number) => string;
  /** An integer count, for n. */
  int: (v: number) => string;
};

/**
 * One lettered step of the agency's monthly calculation, as four rows.
 *
 * `key` is stable and language-neutral: the screen places each block where it belongs on the page and the
 * document iterates the same list in the same order, so neither can carry a step the other does not.
 */
export type PcbFormulaBlock = {
  key: 'p1' | 'p2' | 'mtd' | 'net' | 'year' | 'flat';
  /** The specification's own step letter, '' for a step it letters differently or not at all. */
  step: string;
  /** Block heading caption key. */
  heading: string;
  /** Caption key of the symbolic formula — the agency's shape, with no clamp it does not print. */
  formula: string;
  /** Which leg of the calculation this substitution is, when one published formula serves two. */
  legend?: string;
  /** The substitution over stored figures. NULL ⇒ this run recorded no working to substitute. */
  substituted: string | null;
  /** One step further along, still only stored figures. UNDEFINED ⇒ the engine stored no intermediate
   *  for this step, and deriving one here would be the screen computing tax. */
  calculation?: string;
  /** Caption key for the figure the step landed on, and that stored figure. NULL ⇒ not recorded. */
  resultLabel: string;
  result: number | null;
  /** Sentences under the block. Every one of them is a caption key. */
  notes: string[];
};

/**
 * Assemble every formula block this payslip has, in the specification's own order.
 *
 * @param x  what `explainPcb` read off the payslip — the ONLY source of a figure here.
 * @param f  the caller's formatters.
 */
export function pcbFormulaBlocks(x: PcbExplanation, f: PcbFormulaFormat): PcbFormulaBlock[] {
  if (x.kind === 'unavailable') return [];

  if (x.kind === 'flat') {
    const tr = x.trace;
    return [
      {
        key: 'flat',
        step: '',
        heading: 'flatHeading',
        formula: 'flatFormula',
        substituted: tr ? `( ${f.b2(tr.remuneration)} + ${f.b2(tr.additional)} ) × ${f.pct(x.rate)}` : null,
        // NO `calculation` ROW. The only intermediate here is (remuneration + additional), and the engine
        // never stores the sum — it multiplies the two legs' total in one expression. Adding the row would
        // mean this file performing the addition, which is precisely what it may not do.
        resultLabel: 'resultLabel',
        result: x.pcbSystem,
        notes: ['flatRoundingNote', 'flatNote'],
      },
    ];
  }

  const t = x.trace;
  const n = f.int(x.remainingMonths);

  /**
   * The seven terms of the agency's second bracket, in its order: D + S + DU + SU + QC + (∑LP + LP1).
   *
   * ⚠️ QC IS ONE TERM AND IT IS THE PRODUCT. The specification's glossary defines Q ("deduction for
   * qualifying children") and C ("number of qualifying children") separately, while the FORMULA prints
   * QC — the product of the two. `reliefs.children` already holds that product (`pcbMonth` multiplies the
   * count by the per-child amount before it reaches the snapshot), so the product is what goes here, and
   * the worksheet above keeps its separate Q and C rows for the two factors. r340's note in
   * docs/HANDOFF-HISTORY.md — "LHDN prints Q and C separately too" — is true of the GLOSSARY and not of
   * the formula, which is why the formula said Q until now.
   */
  const reliefTerms = (trace: PcbTrace) =>
    `${f.b2(x.reliefs.individual)} + ${f.b2(x.reliefs.spouse)} + ${f.b2(x.reliefs.disabledIndividual)} + ${f.b2(x.reliefs.disabledSpouse)} + ${f.b2(x.reliefs.children)} + ( ${f.b2(trace.lpAccumulated)} + ${f.b2(trace.lpCurrent)} )`;

  const blocks: PcbFormulaBlock[] = [];

  // ── Step 1[B] — P, on net NORMAL remuneration. The (Yₜ − Kₜ) limb is the agency's own zero. ────────
  blocks.push({
    key: 'p1',
    step: 'B',
    heading: 'pHeading',
    formula: 'pFormula',
    legend: 'pLegNormal',
    substituted: t
      ? `[ ${f.b2(x.ytdNetRemuneration)} + ( ${f.b2(t.Y1)} − ${f.b2(t.K1)} ) + [ ( ${f.b2(t.Y2)} − ${f.b2(t.K2)} ) ${n} ] + ( ${f.b2(0)} − ${f.b2(0)} ) ] − [ ${reliefTerms(t)} ]`
      : null,
    // The relief bracket resolved to the two figures the engine actually stored and subtracted
    // (`reliefs.total` = D + S + DU + SU + QC, `reliefs.lp` = ∑LP + LP1). Both are read, not summed here.
    calculation: t
      ? `[ ${f.b2(x.ytdNetRemuneration)} + ( ${f.b2(t.Y1)} − ${f.b2(t.K1)} ) + [ ( ${f.b2(t.Y2)} − ${f.b2(t.K2)} ) ${n} ] + ( ${f.b2(0)} − ${f.b2(0)} ) ] − [ ${f.b2(x.reliefs.total)} + ${f.b2(x.reliefs.lp)} ]`
      : undefined,
    resultLabel: 'pResult',
    result: x.chargeableIncome,
    notes: ['pFormulaNote', 'grossYNote'],
  });

  // ── Step 1[B] again, for ADDITIONAL remuneration — the SECOND calculation, with K₂ₜ. ───────────────
  // Rendered only when §D.2 ran. A P₂ line in a month that paid no bonus would assert a second
  // calculation that never happened; the worksheet's own P2 row already says `didNotRun` instead.
  if (t && x.chargeableIncomeWithAdditional !== null) {
    blocks.push({
      key: 'p2',
      step: 'B',
      heading: 'pHeading',
      formula: 'p2Formula',
      legend: 'pLegAdditional',
      substituted: `[ ${f.b2(x.ytdNetRemuneration)} + ( ${f.b2(t.Y1)} − ${f.b2(t.K1)} ) + [ ( ${f.b2(t.Y2)} − ${f.b2(t.K2t)} ) ${n} ] + ( ${f.b2(t.Yt)} − ${f.b2(t.Kt)} ) ] − [ ${reliefTerms(t)} ]`,
      calculation: `[ ${f.b2(x.ytdNetRemuneration)} + ( ${f.b2(t.Y1)} − ${f.b2(t.K1)} ) + [ ( ${f.b2(t.Y2)} − ${f.b2(t.K2t)} ) ${n} ] + ( ${f.b2(t.Yt)} − ${f.b2(t.Kt)} ) ] − [ ${f.b2(x.reliefs.total)} + ${f.b2(x.reliefs.lp)} ]`,
      resultLabel: 'p2Result',
      result: x.chargeableIncomeWithAdditional,
      notes: ['p2Note'],
    });
  }

  // ── Step 1[C] — MTD on net normal remuneration for the current month. ─────────────────────────────
  blocks.push({
    key: 'mtd',
    step: 'C',
    heading: 'formulaHeading',
    formula: 'formulaMtd',
    substituted: t
      ? `max( 0, max( 0, ( ${f.b2(x.chargeableIncome)} − ${f.b2(t.M)} ) × ${f.pct(t.R)} + ${f.b2(t.B)} ) − ( ${f.b2(t.Z)} + ${f.b2(x.pcbPaidYtd)} ) ) ÷ ( ${n} + 1 )`
      : null,
    // `taxOnP1` IS the inner bracket as the engine stored it — already floored at zero by `annualTaxFor`.
    // So the calculation row resolves the bracket and keeps the outer clamp, which is one fewer term and
    // not one gramme of new arithmetic. `(P − M) × R` on its own is never persisted and is never shown.
    calculation: t
      ? `max( 0, ${f.b2(t.taxOnP1)} − ( ${f.b2(t.Z)} + ${f.b2(x.pcbPaidYtd)} ) ) ÷ ( ${n} + 1 )`
      : undefined,
    resultLabel: 'resultLabel',
    result: t ? t.mtdNormalCalc : null,
    notes: ['roundingNote'],
  });

  // ── Step 1[D] — the NET monthly tax deduction: §E.3's RM10 rule, then §E.5's zakat cascade. ───────
  blocks.push({
    key: 'net',
    step: 'D',
    heading: 'netHeading',
    formula: 'formulaNet',
    substituted: t
      ? `max( 0, ${f.b2(t.mtdNormalFloored)} − ${f.b2(t.zakatCurrent)} ) + max( 0, ${f.b2(t.mtdAdditionalFloored)} − max( 0, ${f.b2(t.zakatCurrent)} − ${f.b2(t.mtdNormalFloored)} ) )`
      : null,
    // `zakatLeftover` is stored, so the inner clamp resolves to a figure the engine wrote down rather
    // than to a subtraction performed here.
    calculation: t
      ? `max( 0, ${f.b2(t.mtdNormalFloored)} − ${f.b2(t.zakatCurrent)} ) + max( 0, ${f.b2(t.mtdAdditionalFloored)} − ${f.b2(t.zakatLeftover)} )`
      : undefined,
    resultLabel: 'resultLabel',
    result: x.pcbSystem,
    notes: ['netFormulaNote'],
  });

  // ── Step 1[E] — total monthly tax deduction for the year. ─────────────────────────────────────────
  // ⚠️ NO SUBSTITUTION IN A MONTH WITH NO ADDITIONAL PAY, AND NO DERIVATION EITHER. `pcbMonth` stamps
  // `totalMtdYear` only inside its `Yt > 0` branch, because Step 1[E] exists to feed §D.2 Step 4 and
  // nothing else consumes it. Every term of `X + [ Step [C] × ( n + 1 ) ]` is on this page, so it would
  // be easy to multiply them here — and that is exactly the line this screen does not cross: a figure it
  // computed could disagree with the payslip. So the symbolic formula is always shown, and the
  // substitution is shown only when the engine recorded the answer.
  blocks.push({
    key: 'year',
    step: 'E',
    heading: 'yearHeading',
    formula: 'yearFormula',
    substituted:
      t && t.totalMtdYear !== null
        ? `${f.b2(x.pcbPaidYtd)} + ( ${f.b2(t.mtdNormalCalc)} × ( ${n} + 1 ) )`
        : null,
    resultLabel: 'yearTotalMtd',
    result: t ? t.totalMtdYear : null,
    // `yearNoAdditional` is the sentence this screen has carried since 45df860a for exactly this case —
    // "the yearly-total step of the calculation did not run" — so it is reused rather than a second
    // wording of one fact being minted. See the catalogue sweep in test/r351-pcb-detail-pdf.test.ts.
    notes: t && t.totalMtdYear !== null ? ['yearNote'] : ['yearNoAdditional'],
  });

  return blocks;
}

/** The blocks by key, for a surface that places each one itself rather than iterating. */
export function pcbFormulaByKey(blocks: readonly PcbFormulaBlock[]): Partial<Record<PcbFormulaBlock['key'], PcbFormulaBlock>> {
  const out: Partial<Record<PcbFormulaBlock['key'], PcbFormulaBlock>> = {};
  for (const b of blocks) out[b.key] = b;
  return out;
}

/** Closing Step 1 shares [C], but its net result is the normal leg alone, not combined PCB. */
export function pcbNormalMtdStep1Blocks(x: PcbExplanation, f: PcbFormulaFormat): PcbFormulaBlock[] {
  if (x.kind !== 'mtd') return [];
  const monthly = pcbFormulaBlocks(x, f).find(block => block.key === 'mtd');
  if (!monthly) return [];
  const t = x.trace;
  return [monthly, {
    key: 'net', step: 'D', heading: 'slipStep1NetMtd', formula: 'formulaNormalMtdNet',
    substituted: t ? `max( 0, ${f.b2(t.mtdNormalFloored)} − ${f.b2(t.zakatCurrent)} )` : null,
    resultLabel: 'slipStep1NetMtd', result: t ? x.pcbNormal : null,
    notes: ['slipStep1NormalRules'],
  }];
}
