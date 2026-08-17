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
};

/** 45df860a — the flat-rate working: the remuneration the flat percentage was applied to. */
export type PcbFlatTrace = {
  remuneration: number;
  additional: number;
  rate: number;
};

export type PcbExplanation =
  | {
      /** No PCB working was recorded on this payslip (imported history, or a run predating the stamp). */
      kind: 'unavailable';
      pcb: number;
    }
  | {
      kind: 'flat';
      /** 0.30 non-resident, 0.15 REP / Knowledge Worker. */
      rate: number;
      nonResident: boolean;
      /** NULL for a run predating 45df860a — "not recorded", never zero. */
      trace: PcbFlatTrace | null;
      pcb: number;
    }
  | {
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
      /** The split the engine produced: normal-remuneration MTD and the additional-remuneration leg. */
      pcbNormal: number;
      pcbAdditional: number;
      /** NULL for a run predating 45df860a. The caller says "not recorded for this run"; it does NOT
       *  back-derive the bracket and it does NOT render the legs as zeroes. */
      trace: PcbTrace | null;
      pcb: number;
    };

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

type FlatMeta = { nonResident?: unknown; flatRate?: unknown; rate?: unknown; trace?: unknown };
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
};

/**
 * Read a stored MTD trace, or NULL.
 *
 * THE GATE IS PRESENCE, NOT TRUTHINESS, and that is the whole point of the function. `n()` above turns
 * `undefined` into 0, so a blob carrying `trace: {}` — or a trace half-written by some future change —
 * would otherwise coerce into a complete-looking table of zeroes and RM 0.00 brackets. Those are claims
 * about someone's tax, so the bar to return a trace at all is that the three members no partial write
 * could plausibly supply are present: the bracket rate, its floor, and the MTD the formula landed on.
 */
function readTrace(raw: unknown): PcbTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (t.M === undefined || t.R === undefined || t.mtdNormalCalc === undefined) return null;
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
  };
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
  if (!meta || typeof meta !== 'object') return { kind: 'unavailable', pcb };

  const flat = meta as FlatMeta;
  if (flat.flatRate != null || flat.rate != null) {
    const rate = n(flat.flatRate ?? flat.rate);
    return {
      kind: 'flat',
      rate,
      nonResident: flat.nonResident === true,
      trace: readFlatTrace(flat.trace),
      pcb,
    };
  }

  const m = meta as SnapshotMeta;
  if (m.P1 === undefined) return { kind: 'unavailable', pcb };

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
  // derived by subtraction rather than recomputed — the two must sum to the figure on the payslip.
  const pcbAdditional = Math.min(n(st.pcbBonus), pcb);
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
    pcbNormal: r2(pcb - pcbAdditional),
    pcbAdditional: r2(pcbAdditional),
    trace: readTrace(m.trace),
    pcb,
  };
}
