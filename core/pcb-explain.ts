/**
 * Feedback 169e3c24 — explain a payslip's PCB (MTD) figure from what the payslip itself recorded.
 * Feedback 45df860a — …and now the WHOLE working, so the LHDN formula can be closed on screen.
 *
 * WHY THIS EXISTS. Every input to the LHDN computerised calculation was ALREADY being persisted:
 * `localization/my/payroll.ts` stamps `pcbMeta` — pcbMonth's own snapshot — onto every payslip's
 * statutory blob. Grepping `pcbMeta` across `app/` returned nothing but a comment. It was stored, and
 * displayed nowhere, so "why is my PCB this amount" could only be answered on a separate worksheet.
 *
 * PURE, AND DELIBERATELY INCAPABLE OF RECOMPUTING. This module reads; it does not calculate tax. A panel
 * that re-derived the figure could disagree with the figure it claims to explain, which is worse than no
 * panel. Everything here is either read straight out of the blob or added up from figures that came out
 * of it. 45df860a did NOT relax that: it widened what pcbMonth records so that less has to be derived,
 * which is the opposite move.
 *
 * TWO STORED SHAPES, AND TWO KINDS OF ABSENCE — one of which HAS a fallback and one of which must not:
 *
 *   1. FLAT RATE. A non-resident (30%) or a REP / Knowledge-Worker employee (15%) is taxed at a flat rate
 *      with no reliefs at all, and the blob carries `{ nonResident, flatRate, rate }`. There is no relief
 *      working to show and that is CORRECT, not a gap — so this returns a distinct shape and the screen
 *      says which rate was applied instead of rendering an empty relief table.
 *
 *   2. THE MTD SNAPSHOT. `{ month, n, ytdNet, epfClaimed, pcbPaid, P1, P2? }`, plus — from 169e3c24
 *      onward — `reliefs`, the relief legs as pcbMonth actually applied them, plus — from 45df860a
 *      onward — `trace`, the bracket (M, R, B), the EPF legs, the additional-remuneration legs and the
 *      year totals.
 *
 *   3. PRE-SNAPSHOT RELIEF FALLBACK. A payslip calculated before the relief legs were recorded has the
 *      first six keys and no `reliefs`. Its reliefs are then taken from the employee's CURRENT position,
 *      and `reliefSource` says so, because an employee who has since married or had a child would
 *      otherwise have a closed payslip explained with a relief position that did not exist when it was
 *      computed. The screen MUST surface `reliefSource`; a silent fallback is the failure mode this names.
 *
 *   4. PRE-TRACE — AND THERE IS NO FALLBACK, ON PURPOSE. A payslip calculated before 45df860a has no
 *      `trace`, and `trace` comes back NULL. It is NOT reconstructed from the figures that are present:
 *      solving M, R and B back out of a stored P is a SECOND calculation of the very thing this module
 *      exists to avoid recalculating, and it would silently disagree with the run for any month whose
 *      band table has since been overridden. Nor is it zero-filled: a table of RM 0.00 reads as "the
 *      bracket was zero", which is a false statement about someone's tax. The caller renders "not
 *      recorded for this run" and shows the legs it genuinely has.
 *
 *   5. A WORKING THAT IS COMPLETE, CORRECT, AND ABOUT A DIFFERENT NUMBER. This happens for TWO unrelated
 *      reasons, and both are read out through the same three members — `pcbSystem` is what the recorded
 *      working explains, `pcb` is what was deducted, `basis` says why they differ:
 *
 *        a. A HAND-SET PCB. An operator overrides the PCB line (2961a7ae): `statutory.pcb` becomes their
 *           figure and `pcbMeta` is left exactly as the engine wrote it, because no second calculation
 *           ran.
 *
 *        b. AN ADDITIONAL RUN. A bonus / off-cycle run deducts the INCREMENT of the cumulative month
 *           (ADR-0024): `deltaStat` (core/payroll.ts) rewrites `pcb` to `now − before` but carries
 *           `pcbMeta` through untouched, so the stored working — P, the bracket, both MTD legs — is the
 *           WHOLE month's while the deduction is the increase. `deltaStat` stamps `pcbMeta.delta` with
 *           the two figures it took the difference between, and that stamp is what is read here.
 *
 *      Either way the screen must say the deduction was set by hand / is this run's increase, rather than
 *      presenting a tidy LHDN formula as the explanation of an amount nobody computed.
 */

export type PcbReliefBreakdown = {
  individual: number;
  spouse: number;
  children: number;
  disabledIndividual: number;
  disabledSpouse: number;
  /** Optional-deduction / TP1 total (Σ LP) netted off P beside the reliefs. */
  lp: number;
  total: number;
};

/**
 * 45df860a — the rest of the LHDN working, as `pcbMonth` recorded it. Every member is READ, never
 * derived. The names are the spec's own symbols, because the screen prints the formula in those symbols
 * and a rename between the two is how a reader ends up checking the wrong figure.
 */
export type PcbTrace = {
  /** Table 1 row P₁ fell into (M, R) and the category-selected B column, and the annual tax it yields. */
  M: number;
  R: number;
  B: number;
  taxOnP1: number;
  /** s.48 category the B column came from, and the child COUNT behind the child-relief amount. */
  category: number;
  childCount: number;
  /** The remuneration legs of P. Y₂ = Y₁ by construction (the projection repeats the current month). */
  Y1: number;
  K1: number;
  Y2: number;
  K2: number;
  /** Additional-remuneration legs. All zero in a month that paid none — §D.2 does not run at all then. */
  Yt: number;
  Kt: number;
  K2t: number;
  /** Z, and the Σ LP / LP₁ split of the combined `reliefs.lp`. */
  Z: number;
  lpAccumulated: number;
  lpCurrent: number;
  /** This month's zakat via salary — the §E.5 offset. PCB is already net of it. */
  zakatCurrent: number;
  /** §D.2 Step 3 / Step 1[E]. NULL means the month paid no additional remuneration, which is a
   *  different statement from zero — the screen must not print "RM 0.00" for a step that never ran. */
  totalTaxYear: number | null;
  totalMtdYear: number | null;
  /** The two legs post §E.1 truncation and §E.2 5-sen round-up, BEFORE the §E.3 RM10 floor and the
   *  §E.5 zakat offset. This is the figure the substituted formula lands on. */
  mtdNormalCalc: number;
  mtdAdditionalCalc: number;
  /** The same two legs AFTER the §E.3 RM10 rule (A and E in the spec's tables), and the zakat left over
   *  once the normal leg absorbed what it could. The last line of the working —
   *  `max(0, A − Z₁) + max(0, E − leftover)` — is not writable without them, and a line that skips them
   *  prints an expression that does not evaluate to the PCB beside it. */
  mtdNormalFloored: number;
  mtdAdditionalFloored: number;
  zakatLeftover: number;
};

/**
 * 2961a7ae × ADR-0024 × 45df860a — WHY THE WORKING AND THE DEDUCTION ARE DIFFERENT NUMBERS.
 *
 * Two mechanisms open this gap, and neither rewrites `pcbMeta`, so in both cases every member of the
 * trace describes one figure while `statutory.pcb` is another:
 *
 *   · `applyStatutoryAdjustment` overwrites `statutory.pcb` with an operator's figure and records the
 *     before/after under `statutory.adjustment`. There is no second calculation to record because none
 *     ran, so the working still describes what the ENGINE produced.
 *
 *   · `deltaStat` turns an additional run's `pcb` into the month's INCREMENT while carrying `pcbMeta`
 *     through as the CUMULATIVE month, and stamps `pcbMeta.delta` with the pair it differenced. The
 *     working therefore describes the whole month; the payslip deducted the increase.
 *
 * A screen that did not notice either would present a complete, correct-looking LHDN working as the
 * explanation of an amount nobody computed — the exact failure this whole item exists to remove, wearing
 * a respectable formula. So the basis is read out and reported, the working is labelled as explaining
 * `pcbSystem`, and the screen says in plain words which figure is which.
 */
export type PcbBasis = {
  /** WHY the two figures differ — the screen's banner, labels and extra rows all turn on this.
   *   · 'manual'              an operator replaced the PCB line; the working is the engine's figure.
   *   · 'additionalRun'       this run deducted the month's increase; the working is the whole month.
   *   · 'additionalRunManual' both — an increment run whose PCB was then also set by hand. */
  kind: 'manual' | 'additionalRun' | 'additionalRunManual';
  /** What the recorded working explains: the engine's figure, or — on an additional run — the figure for
   *  the WHOLE month, because the whole month is what `pcbMeta` describes. Always `pcbSystem`. */
  system: number;
  /** What was actually deducted on this payslip (`statutory.pcb`). Always `pcb`. */
  applied: number;
  /** additionalRun* — the month's PCB WITHOUT this run's additional remuneration: what the month's
   *  earlier runs already carried, and what the increment was taken against. NULL for a plain override. */
  prior: number | null;
  /** additionalRun* — the increment the ENGINE computed for this run. Equal to `applied` unless the
   *  figure was afterwards set by hand, which is the only case worth printing it in. NULL otherwise. */
  engineRun: number | null;
  /** The operator's mandatory reason. '' when nothing was set by hand. */
  reason: string;
};

/** 45df860a — the flat-rate working: the remuneration the flat percentage was applied to. */
export type PcbFlatTrace = {
  remuneration: number;
  additional: number;
  rate: number;
};

/** Present on EVERY shape, because both gaps above are orthogonal to how the figure was computed and a
 *  screen must never explain one figure while displaying the other.
 *   · `pcb`       — what was DEDUCTED (`statutory.pcb`), override included.
 *   · `pcbSystem` — what the recorded working EXPLAINS. Identical to `pcb` on a plain regular run.
 *   · `basis`     — NULL when they are the same number; otherwise why they are not. */
type PcbFigures = { pcb: number; pcbSystem: number; basis: PcbBasis | null };

export type PcbExplanation =
  | ({
      /** No PCB working was recorded on this payslip (imported history, or a run predating the stamp). */
      kind: 'unavailable';
    } & PcbFigures)
  | ({
      kind: 'flat';
      /** 0.30 non-resident, 0.15 REP / Knowledge Worker. */
      rate: number;
      nonResident: boolean;
      /** NULL for a run predating 45df860a — "not recorded", never zero. */
      trace: PcbFlatTrace | null;
    } & PcbFigures)
  | ({
      kind: 'mtd';
      /** 'snapshot' = this payslip's own relief working. 'current' = the employee's position TODAY. */
      reliefSource: 'snapshot' | 'current';
      /** Month of the tax year the calculation ran for, and the balance of months after it (LHDN `n`). */
      month: number;
      remainingMonths: number;
      /** Accumulators the month was computed against, all as stored. */
      ytdNetRemuneration: number;
      epfClaimedYtd: number;
      pcbPaidYtd: number;
      /** This month's employee EPF — the K₁ leg, capped inside pcbMonth against the annual relief cap. */
      epfThisMonth: number;
      /** Projected chargeable income: P₁ without additional remuneration, P₂ with it (null when none). */
      chargeableIncome: number;
      chargeableIncomeWithAdditional: number | null;
      reliefs: PcbReliefBreakdown;
      /** Zakat paid via salary this month. PCB is ALREADY net of it (LHDN §E.5) — never re-subtract. */
      zakat: number;
      /** The split the engine produced: normal-remuneration MTD and the additional-remuneration leg.
       *  Both are taken against `pcbSystem`, not against `pcb`: they belong to the calculation, and
       *  splitting a hand-set figure along the engine's proportions would invent a breakdown. On an
       *  additional run that means the CUMULATIVE month's legs, read from the same `delta` stamp
       *  `pcbSystem` comes from — pairing a cumulative total with an incremental leg would make the two
       *  disagree with each other as well as with the trace. */
      pcbNormal: number;
      pcbAdditional: number;
      /** NULL for a run predating 45df860a. The caller says "not recorded for this run"; it does NOT
       *  back-derive the bracket and it does NOT render the legs as zeroes. */
      trace: PcbTrace | null;
    } & PcbFigures);

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

type FlatMeta = { nonResident?: unknown; flatRate?: unknown; rate?: unknown; trace?: unknown; delta?: unknown };
type SnapshotMeta = {
  month?: unknown;
  n?: unknown;
  ytdNet?: unknown;
  epfClaimed?: unknown;
  pcbPaid?: unknown;
  P1?: unknown;
  P2?: unknown;
  reliefs?: Partial<PcbReliefBreakdown>;
  trace?: unknown;
  delta?: unknown;
};

/** `deltaStat`'s stamp: the cumulative month the working describes, and the pair it was differenced
 *  against. Shaped exactly as core/payroll.ts writes it. */
type PcbDelta = { cumulative: number; prior: number; cumulativeBonus: number };

/**
 * Read a stored MTD trace, or NULL.
 *
 * THE GATE IS PRESENCE, NOT TRUTHINESS, and that is the whole point of the function. `n()` above turns
 * `undefined` into 0, so a blob carrying `trace: {}` — or a trace half-written by some future change —
 * would otherwise coerce into a complete-looking table of zeroes and RM 0.00 brackets. Those are claims
 * about someone's tax, so the bar to return a trace at all is that the members no partial write could
 * plausibly supply are present: the bracket rate, its floor, the MTD the formula landed on, and the
 * post-RM10 leg the last line of the working is written from. That last one is on the gate rather than
 * merely read, because a trace missing it produces a printable `max(0, 0.00 − …)` beside a non-zero PCB —
 * a working that contradicts its own answer, which is worse than an honest "not recorded".
 */
function readTrace(raw: unknown): PcbTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.M === undefined || t.R === undefined || t.mtdNormalCalc === undefined) return null;
  if (t.mtdNormalFloored === undefined) return null;
  return {
    M: n(t.M),
    R: n(t.R),
    B: n(t.B),
    taxOnP1: n(t.taxOnP1),
    category: n(t.category),
    childCount: n(t.childCount),
    Y1: n(t.Y1),
    K1: n(t.K1),
    Y2: n(t.Y2),
    K2: n(t.K2),
    Yt: n(t.Yt),
    Kt: n(t.Kt),
    K2t: n(t.K2t),
    Z: n(t.Z),
    lpAccumulated: n(t.lpAccumulated),
    lpCurrent: n(t.lpCurrent),
    zakatCurrent: n(t.zakatCurrent),
    // Absent ⇒ null ⇒ "this month had no additional remuneration", NOT "the year total was zero".
    totalTaxYear: t.totalTaxYear === undefined ? null : n(t.totalTaxYear),
    totalMtdYear: t.totalMtdYear === undefined ? null : n(t.totalMtdYear),
    mtdNormalCalc: n(t.mtdNormalCalc),
    mtdAdditionalCalc: n(t.mtdAdditionalCalc),
    mtdNormalFloored: n(t.mtdNormalFloored),
    mtdAdditionalFloored: n(t.mtdAdditionalFloored),
    zakatLeftover: n(t.zakatLeftover),
  };
}

/**
 * The hand-set-PCB stamp, or NULL. Gated on the `pcb` LINE specifically: an override of EPF or SOCSO
 * leaves `statutory.pcb` exactly as the engine computed it (`applyStatutoryAdjustment` deliberately does
 * not cascade), so the tax working still explains the deducted figure and there is nothing to warn about.
 */
function readOverride(raw: unknown): { system: number; applied: number; reason: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = raw as { reason?: unknown; lines?: unknown };
  const lines = stamp.lines;
  if (!lines || typeof lines !== 'object' || Array.isArray(lines)) return null;
  const line = (lines as Record<string, unknown>).pcb;
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const l = line as { system?: unknown; applied?: unknown };
  if (l.system === undefined || l.applied === undefined) return null;
  return {
    system: n(l.system),
    applied: n(l.applied),
    reason: typeof stamp.reason === 'string' ? stamp.reason : '',
  };
}

/**
 * The additional-run stamp, or NULL — gated on PRESENCE for the same reason `readTrace` is. `n()` turns
 * `undefined` into 0, so a half-written stamp would otherwise claim the whole month's PCB was RM 0.00
 * and hand the screen a banner asserting that as fact. Both figures the difference was taken between
 * must be there, or this is not a delta stamp and the payslip is read as an ordinary one.
 */
function readDelta(raw: unknown): PcbDelta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.cumulative === undefined || d.prior === undefined) return null;
  return { cumulative: n(d.cumulative), prior: n(d.prior), cumulativeBonus: n(d.cumulativeBonus) };
}

/** The flat-rate twin of `readTrace`, gated the same way: the rate the percentage came from. */
function readFlatTrace(raw: unknown): PcbFlatTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.remuneration === undefined) return null;
  return { remuneration: n(t.remuneration), additional: n(t.additional), rate: n(t.rate) };
}

/**
 * @param statutory the payslip's stored statutory blob.
 * @param currentReliefs the employee's relief position TODAY, used ONLY when the payslip predates the
 *        stored relief working. Pass null when it cannot be resolved; the panel then reports the total
 *        it can still read (P already has the reliefs netted off) rather than inventing legs.
 */
export function explainPcb(
  statutory: unknown,
  currentReliefs: PcbReliefBreakdown | null,
): PcbExplanation {
  const st = (statutory ?? {}) as Record<string, unknown>;
  const pcb = n(st.pcb);
  const meta = st.pcbMeta;
  const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
  // The three figures every shape carries. `pcbSystem` is what the recorded working explains; `pcb` is
  // what left the employee's pay. They differ when the PCB line was set by hand, when this is an
  // additional run whose deduction is the month's increase — or, unhappily but legally, both.
  //
  // THE DELTA WINS THE `system` SEAT WHEN BOTH ARE PRESENT, and it has to: `pcbMeta` is the cumulative
  // month either way, so the cumulative figure is the only one the working on screen actually lands on.
  // The engine's own figure for this run is not lost — it is `engineRun`, printed as its own row.
  const manual = readOverride(st.adjustment);
  const delta = readDelta(metaObj?.delta);
  // A DELTA WITH A ZERO BASELINE HAS NOTHING TO DECLARE. `prior` is the month WITHOUT this run, so when
  // it is zero the increment IS the month and the working already explains the deduction. Raising the
  // banner anyway would train readers to ignore it on the payslips where it matters — the same reason an
  // adjustment to a NON-PCB line raises none. The stamp is still read for the normal/additional split
  // below, because that side is about which month the legs belong to, not about a gap.
  const gap = delta && r2(delta.prior) !== 0 ? delta : null;
  const pcbSystem = gap ? gap.cumulative : manual ? manual.system : pcb;
  const basis: PcbBasis | null =
    gap && manual
      ? { kind: 'additionalRunManual', system: pcbSystem, applied: pcb, prior: gap.prior, engineRun: manual.system, reason: manual.reason }
      : gap
        ? { kind: 'additionalRun', system: pcbSystem, applied: pcb, prior: gap.prior, engineRun: pcb, reason: '' }
        : manual
          ? { kind: 'manual', system: pcbSystem, applied: pcb, prior: null, engineRun: null, reason: manual.reason }
          : null;
  const figures = { pcb, pcbSystem, basis };
  if (!metaObj) return { kind: 'unavailable', ...figures };

  const flat = metaObj as FlatMeta;
  if (flat.flatRate != null || flat.rate != null) {
    const rate = n(flat.flatRate ?? flat.rate);
    return {
      kind: 'flat',
      rate,
      nonResident: flat.nonResident === true,
      trace: readFlatTrace(flat.trace),
      ...figures,
    };
  }

  const m = metaObj as SnapshotMeta;
  if (m.P1 === undefined) return { kind: 'unavailable', ...figures };

  const stored = m.reliefs;
  const reliefSource: 'snapshot' | 'current' = stored ? 'snapshot' : 'current';
  const zero: PcbReliefBreakdown = {
    individual: 0, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 0,
  };
  const reliefs: PcbReliefBreakdown = stored
    ? {
        individual: n(stored.individual),
        spouse: n(stored.spouse),
        children: n(stored.children),
        disabledIndividual: n(stored.disabledIndividual),
        disabledSpouse: n(stored.disabledSpouse),
        // `lp` was stamped separately on the blob long before the relief legs were; prefer the snapshot's
        // own copy and fall back to the blob's, so a slip carrying only the latter still shows it.
        lp: stored.lp !== undefined ? n(stored.lp) : n(st.lp),
        total: n(stored.total),
      }
    : (currentReliefs ?? { ...zero, lp: n(st.lp) });

  // `pcbBonus` is the additional-remuneration leg the engine reported. The normal leg is the remainder,
  // derived by subtraction rather than recomputed — the two must sum to the figure the ENGINE produced
  // (`pcbSystem`), which is the figure this working explains and is `pcb` itself on a plain regular run.
  //
  // ON AN ADDITIONAL RUN THE BLOB'S `pcbBonus` IS ALSO A DELTA (it is a DELTA_KEY), so pairing it with a
  // cumulative `pcbSystem` produced a normal leg of RM 0.00 sitting beside a trace that plainly showed
  // one. The cumulative leg comes out of the same stamp the cumulative total does, so both sides of the
  // split describe the same month.
  const pcbAdditional = Math.min(delta ? delta.cumulativeBonus : n(st.pcbBonus), figures.pcbSystem);
  return {
    kind: 'mtd',
    reliefSource,
    month: n(m.month),
    remainingMonths: n(m.n),
    ytdNetRemuneration: n(m.ytdNet),
    epfClaimedYtd: n(m.epfClaimed),
    pcbPaidYtd: n(m.pcbPaid),
    epfThisMonth: n(st.epfEmployee),
    chargeableIncome: n(m.P1),
    chargeableIncomeWithAdditional: m.P2 === undefined ? null : n(m.P2),
    reliefs,
    zakat: n(st.zakat),
    pcbNormal: r2(figures.pcbSystem - pcbAdditional),
    pcbAdditional: r2(pcbAdditional),
    trace: readTrace(m.trace),
    ...figures,
  };
}

// ═══════════════════════════════ 7f251381 — LHDN's own worksheet order ═══════════════════════════════

/**
 * Feedback 7f251381 — THE SAME RECORDED FIGURES, LAID OUT AS LHDN LAYS THEM OUT.
 *
 * WHY A SECOND LAYOUT IS NOT A SECOND ANSWER. `explainPcb` above already returns every figure the tax
 * working used, and `app/payroll/pcb-detail/pcb-detail-view.tsx` already explains them in an order that
 * reads well. The reporter's problem is not that the figures are wrong or missing — it is that they are in
 * OUR arrangement, so their sheet and ours cannot be laid side by side and read down. This function
 * re-orders what `explainPcb` returned into LHDN's worksheet sequence, under LHDN's symbols, so a
 * disagreement lands on a ROW rather than on a total.
 *
 * IT DERIVES NOTHING, AND THAT IS THE WHOLE DISCIPLINE. Every `amount` below is a member of the
 * explanation (or of the Form TP3 seed) read straight through — no sum, no difference, no re-rounding, no
 * fallback arithmetic. `test/7f251381-pcb-lhdn-worksheet.test.ts` asserts it field by field AND sweeps
 * every emitted amount against the set of numbers actually present in the inputs, so an arithmetic
 * expression introduced here fails even where a hand-written assertion has not been written for that row.
 *
 * THREE THINGS THE SHEET MUST SAY RATHER THAN DRAW:
 *
 *   1. LHDN's Y IS A GROSS ACCUMULATED FIGURE AND WE DO NOT STORE ONE. The engine keeps Σ(Y − K) — the
 *      accumulated remuneration ALREADY net of EPF — and K separately; the gross Y is never persisted.
 *      Y therefore gets a labelled row saying it is not recorded separately, with Σ(Y − K) and K beneath
 *      it, instead of Σ(Y − K) + K printed under Y's symbol. That addition would be correct arithmetic
 *      and still a number this system never wrote down, which is exactly the class of figure this whole
 *      screen exists to stop printing.
 *
 *   2. AN ABSENT TRACE IS "NOT RECORDED", NEVER ZERO. A run predating 45df860a has no `trace`, and every
 *      row fed from it carries `notRecorded`. A sheet of RM 0.00 in LHDN's shape is more convincing and
 *      more wrong than our own layout was — it looks like a completed worksheet.
 *
 *   3. A FLAT-RATE PAYEE HAS NO WORKSHEET AT ALL. See `flatWorksheet` below.
 */

/**
 * The previous-employment figures a Form TP3 declares for the payslip's tax year — item 1bb09a73's
 * output, read for display.
 *
 * WHY IT IS AN INPUT RATHER THAN PART OF THE SNAPSHOT. `pcbMonth` is handed the ALREADY-COMBINED
 * accumulators (Σ(Y − K), K, X, Z each include the seed), so the payslip's own stamp cannot separate the
 * previous employer's share from this employer's months — and this item may not change what a payslip
 * records. The four figures therefore come from the same columns `core/payroll.ts` seeds the replay from
 * (`employee_statutory_my.tp3_*`), read at display time by `previousEmploymentForPayslip`, and the screen
 * says so: they are the employee's CURRENT declaration, not a stamp taken at the moment of the run. Same
 * posture, and the same reason, as `reliefSource: 'current'`.
 */
export type PcbPreviousEmployment = {
  /** `employee_statutory_my.tp3_year`, or null when nothing is declared for this employee at all. */
  declaredYear: number | null;
  /** `declaredYear === the payslip's tax year` — the exact gate `core/payroll.ts` seeds on
   *  (`tp3Applies = e.tp3Year === pYear`). False ⇒ the run seeded all four accumulators with zero. */
  applies: boolean;
  /** LHDN C1 − ΣC2 − C3: previous-employment remuneration already net of its EPF, as declared. */
  netRemuneration: number;
  /** C3 — EPF claimed in the previous employment, as declared. NOT clamped to the annual relief cap
   *  here: the cap is applied by the engine and its effect is visible on the K row, and clamping a
   *  declared figure for display would print a number the form does not carry. */
  epfClaimed: number;
  /** C5 — MTD already paid by the previous employer. Part of LHDN's X. */
  pcbPaid: number;
  /** C4(i) — zakat paid through the previous employment. Part of LHDN's Z. C4(ii) is the religious-travel
   *  levy, which is a RELIEF and is deliberately not summed in (item 1bb09a73). */
  zakatPaid: number;
  /** ∑D1…D17 — the reliefs already claimed through the previous employment. Part of LHDN's ∑LP (item
   *  20837372). Until migration 0488 there was no column and this figure did not exist anywhere the run
   *  could read; a worksheet that showed the other four and not this one would be describing a
   *  calculation the reader cannot reconcile, which is the whole purpose of this section. */
  lp: number;
};

/** What a worksheet row prints. A missing figure is a KIND, never a zero and never a blank. */
export type PcbWorksheetValue =
  | { kind: 'money'; amount: number }
  | { kind: 'rate'; rate: number }
  | { kind: 'count'; count: number }
  | { kind: 'text'; text: string }
  /** A caption key instead of a figure — "none declared", "does not apply to this run". */
  | { kind: 'caption'; caption: string }
  /** The run predates 45df860a and never wrote this leg down. */
  | { kind: 'notRecorded' }
  /** Real, used, and never persisted apart from the figure it was netted into (LHDN's Y). */
  | { kind: 'notSeparatelyRecorded' }
  /** §D.2 in a month that paid no additional remuneration — the step did not run, which is a different
   *  statement from a result of zero. */
  | { kind: 'didNotRun' };

export type PcbWorksheetRow = {
  /** LHDN's own symbol. Language-neutral and NEVER translated — the symbol is the thing the two sheets
   *  are matched on. Empty for a line LHDN's sheet gives no symbol to. */
  symbol: string;
  /** Key under `payroll.pcbDetail`. Captions ARE translated; the symbol beside them is not. */
  caption: string;
  value: PcbWorksheetValue;
  /** The previous-employment lines. The reporter's case turns on exactly these four, so they are flagged
   *  rather than merely ordered — the screen marks them and the test can find them without an index. */
  previousEmployment?: true;
};

export type PcbWorksheetSection = {
  heading: string;
  rows: PcbWorksheetRow[];
  /** An optional sentence under the section — a key, resolved by the screen. */
  note?: string;
};

export type PcbWorksheet = {
  /** 'mtd' — the computerised-calculation worksheet. 'flat' — there is NO such worksheet for this payee
   *  and the sheet says so. 'unavailable' — nothing was recorded; the screen's own unavailable card
   *  already carries that sentence and this adds no empty sheet beside it. */
  shape: 'mtd' | 'flat' | 'unavailable';
  sections: PcbWorksheetSection[];
  /** The sentence stating what this sheet is, and what it is not. Always present for a rendered shape. */
  note: string;
};

const money = (amount: number): PcbWorksheetValue => ({ kind: 'money', amount });
/** A trace-fed row: the figure when the run recorded one, the honest absence when it did not. */
const fromTrace = (t: PcbTrace | null, pick: (t: PcbTrace) => number): PcbWorksheetValue =>
  t ? { kind: 'money', amount: pick(t) } : { kind: 'notRecorded' };

/**
 * THE FLAT-RATE DECISION, STATED RATHER THAN DRAWN AS EMPTY ROWS.
 *
 * A non-resident (30%) or REP / Knowledge-Worker (15%) payee is not computed through LHDN's computerised
 * calculation at all: `localization/my/payroll.ts` returns from the flat branch BEFORE `pcbMonth` is
 * called and never reads the accumulators, so there is no P, no M/R/B bracket row, no D/S/Q relief, no Z
 * and no X — and no previous-employment seed either, because the seed only ever reaches `pcbMonth`.
 *
 * Drawing those symbols with "not recorded" beside them would be a lie of a particular kind: it says the
 * figures exist for this employee and were merely not saved. They do not exist. The sheet therefore shows
 * the three lines that DO exist — the remuneration the percentage was applied to, the additional
 * remuneration, and the rate — and states in one sentence that LHDN publishes no worksheet to compare a
 * flat deduction against, so there is nothing to lay side by side. That is the answer, not a gap.
 */
function flatWorksheet(x: Extract<PcbExplanation, { kind: 'flat' }>): PcbWorksheet {
  const t = x.trace;
  const rows: PcbWorksheetRow[] = [
    { symbol: 'Y', caption: 'worksheetFlatY', value: t ? money(t.remuneration) : { kind: 'notRecorded' } },
    { symbol: 'Yt', caption: 'worksheetFlatYt', value: t ? money(t.additional) : { kind: 'notRecorded' } },
    // NO SYMBOL, AND DELIBERATELY NOT 'R'. R is the rate of the TAX-TABLE BRACKET P fell into, and a
    // flat-rate payee has no bracket and no P. Borrowing the symbol would invite a reader to match this
    // line against R on a computerised-calculation sheet that describes a different mechanism entirely.
    { symbol: '', caption: 'worksheetFlatRate', value: { kind: 'rate', rate: x.rate } },
  ];
  return {
    shape: 'flat',
    sections: [
      { heading: 'worksheetFlatHeading', rows },
      { heading: 'worksheetResultHeading', rows: resultRows(x) },
    ],
    note: 'worksheetFlatNote',
  };
}

/**
 * The last rows of every sheet: what the working lands on, and — only when they are different numbers —
 * what the payslip actually deducted.
 *
 * The caption on the first row turns on `basis` for the reason the whole screen turns on it: on an
 * additional run or a hand-set PCB the working explains a figure the payslip does not contain, and a
 * sheet whose final line is captioned "deducted" beside the month's total is the failure this item's
 * own screen was built to remove. The deduction gets its OWN labelled row, never the quiet answer.
 */
function resultRows(x: PcbExplanation): PcbWorksheetRow[] {
  const rows: PcbWorksheetRow[] = [
    { symbol: '', caption: x.basis ? 'worksheetMtdSystem' : 'worksheetMtd', value: money(x.pcbSystem) },
  ];
  if (x.basis) rows.push({ symbol: '', caption: 'worksheetMtdDeducted', value: money(x.pcb) });
  return rows;
}

/**
 * The previous-employment section. ALWAYS four money rows, and always a figure — RM 0.00 where nothing is
 * declared, never a blank. §8: an absent box asserts nothing, where 0.00 asserts the money does not
 * exist, and "does this employee have previous-employment income in this tax year" is precisely the
 * question the reporter's case turned on. A blank there is how it went unnoticed.
 *
 * NO SYMBOL ON THESE FOUR, ON PURPOSE. LHDN's sheet has no separate line for a previous employer: the
 * figures are folded into Y, K, X and Z, which is exactly why the reporter could not see them. The
 * captions name the line each one feeds; inventing a symbol LHDN does not use would defeat the matching
 * the rest of the sheet exists for.
 */
function previousSection(p: PcbPreviousEmployment | null): PcbWorksheetSection {
  const rows: PcbWorksheetRow[] = [
    {
      symbol: '',
      caption: 'worksheetPrevYear',
      value:
        p && p.declaredYear !== null ? { kind: 'text', text: String(p.declaredYear) } : { kind: 'caption', caption: 'worksheetPrevNone' },
    },
    {
      symbol: '',
      caption: 'worksheetPrevApplies',
      value: { kind: 'caption', caption: p?.applies ? 'worksheetPrevAppliesYes' : 'worksheetPrevAppliesNo' },
    },
    { symbol: '', caption: 'worksheetPrevNet', value: money(p?.netRemuneration ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevEpf', value: money(p?.epfClaimed ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevPcb', value: money(p?.pcbPaid ?? 0), previousEmployment: true },
    { symbol: '', caption: 'worksheetPrevZakat', value: money(p?.zakatPaid ?? 0), previousEmployment: true },
    // ∑LP from the previous employment (item 20837372). It sits under the ΣLP row further down, which
    // is the COMBINED figure the formula consumed; this row is the part of it that came in on the TP3,
    // which is what "System must show cumulative ... for the purpose of audit" (specification printed
    // page 28) needs a reader to be able to separate out.
    { symbol: '', caption: 'worksheetPrevLp', value: money(p?.lp ?? 0), previousEmployment: true },
  ];
  return { heading: 'worksheetPreviousHeading', rows, note: 'worksheetPreviousNote' };
}

/**
 * @param x  what `explainPcb` read off the payslip.
 * @param previous the employee's Form TP3 declaration for this payslip's tax year, or null when it could
 *        not be resolved (an unscoped or missing read). Null is NOT the same as "nothing declared": the
 *        section still renders, still shows 0.00, and `worksheetPrevAppliesNo` still says the run seeded
 *        nothing — which is what a null resolves to and what the reader needs to be told.
 */
export function pcbWorksheet(x: PcbExplanation, previous: PcbPreviousEmployment | null): PcbWorksheet {
  // Nothing was recorded at all. The screen's own "unavailable" card already says that in full sentences,
  // so an LHDN-shaped sheet with every line reading "not recorded" is added beside it — which would be a
  // worksheet asserting that this employee HAS a computerised calculation that merely went unsaved. The
  // note reuses that card's existing caption rather than minting a second wording of the same fact.
  if (x.kind === 'unavailable') return { shape: 'unavailable', sections: [], note: 'unavailable' };
  if (x.kind === 'flat') return flatWorksheet(x);

  const t = x.trace;
  const income: PcbWorksheetRow[] = [
    // LHDN's Y is the GROSS accumulated remuneration for the year. We store Σ(Y − K) and K; the gross is
    // never written down. Said as a row, not reconstructed. See the header.
    { symbol: 'Y', caption: 'worksheetY', value: { kind: 'notSeparatelyRecorded' } },
    { symbol: 'Σ(Y−K)', caption: 'worksheetSumYK', value: money(x.ytdNetRemuneration) },
    { symbol: 'K', caption: 'worksheetK', value: money(x.epfClaimedYtd) },
    { symbol: 'Y1', caption: 'worksheetY1', value: fromTrace(t, (v) => v.Y1) },
    { symbol: 'K1', caption: 'worksheetK1', value: fromTrace(t, (v) => v.K1) },
    { symbol: 'Y2', caption: 'worksheetY2', value: fromTrace(t, (v) => v.Y2) },
    { symbol: 'K2', caption: 'worksheetK2', value: fromTrace(t, (v) => v.K2) },
    { symbol: 'n', caption: 'worksheetN', value: { kind: 'count', count: x.remainingMonths } },
  ];
  const additional: PcbWorksheetRow[] = [
    { symbol: 'Yt', caption: 'worksheetYt', value: fromTrace(t, (v) => v.Yt) },
    { symbol: 'Kt', caption: 'worksheetKt', value: fromTrace(t, (v) => v.Kt) },
    { symbol: 'K2t', caption: 'worksheetK2t', value: fromTrace(t, (v) => v.K2t) },
  ];
  const reliefs: PcbWorksheetRow[] = [
    { symbol: 'D', caption: 'worksheetD', value: money(x.reliefs.individual) },
    { symbol: 'S', caption: 'worksheetS', value: money(x.reliefs.spouse) },
    { symbol: 'Du', caption: 'worksheetDu', value: money(x.reliefs.disabledIndividual) },
    { symbol: 'Su', caption: 'worksheetSu', value: money(x.reliefs.disabledSpouse) },
    { symbol: 'Q', caption: 'worksheetQ', value: money(x.reliefs.children) },
    { symbol: 'C', caption: 'worksheetC', value: t ? { kind: 'count', count: t.childCount } : { kind: 'notRecorded' } },
    { symbol: 'ΣLP', caption: 'worksheetLpAccumulated', value: fromTrace(t, (v) => v.lpAccumulated) },
    { symbol: 'LP1', caption: 'worksheetLpCurrent', value: fromTrace(t, (v) => v.lpCurrent) },
  ];
  const bracket: PcbWorksheetRow[] = [
    { symbol: 'P', caption: 'worksheetP', value: money(x.chargeableIncome) },
    {
      symbol: 'P2',
      caption: 'worksheetP2',
      // NULL means §D.2 never ran — this month paid no additional remuneration. Not "the answer was zero".
      value:
        x.chargeableIncomeWithAdditional === null ? { kind: 'didNotRun' } : money(x.chargeableIncomeWithAdditional),
    },
    { symbol: 'M', caption: 'worksheetM', value: fromTrace(t, (v) => v.M) },
    { symbol: 'R', caption: 'worksheetR', value: t ? { kind: 'rate', rate: t.R } : { kind: 'notRecorded' } },
    { symbol: 'B', caption: 'worksheetB', value: fromTrace(t, (v) => v.B) },
    { symbol: '', caption: 'worksheetTaxOnP', value: fromTrace(t, (v) => v.taxOnP1) },
  ];
  const result: PcbWorksheetRow[] = [
    { symbol: 'Z', caption: 'worksheetZ', value: fromTrace(t, (v) => v.Z) },
    { symbol: 'X', caption: 'worksheetX', value: money(x.pcbPaidYtd) },
    // Z₁ is stamped on the blob independently of the trace (`statutory.zakat`), so an old run still has
    // a real figure here rather than an absence — the same fallback the existing screen already makes.
    { symbol: 'Z1', caption: 'worksheetZ1', value: t ? money(t.zakatCurrent) : money(x.zakat) },
    { symbol: 'A', caption: 'worksheetA', value: fromTrace(t, (v) => v.mtdNormalFloored) },
    { symbol: 'E', caption: 'worksheetE', value: fromTrace(t, (v) => v.mtdAdditionalFloored) },
    ...resultRows(x),
  ];

  return {
    shape: 'mtd',
    sections: [
      previousSection(previous),
      { heading: 'worksheetIncomeHeading', rows: income, note: 'worksheetIncomeNote' },
      { heading: 'worksheetAdditionalHeading', rows: additional },
      { heading: 'worksheetReliefHeading', rows: reliefs },
      { heading: 'worksheetBracketHeading', rows: bracket },
      { heading: 'worksheetResultHeading', rows: result },
    ],
    note: 'worksheetNote',
  };
}
