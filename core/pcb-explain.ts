/**
 * Feedback 169e3c24 — explain a payslip's PCB (MTD) figure from what the payslip itself recorded.
 *
 * WHY THIS EXISTS. Every input to the LHDN computerised calculation was ALREADY being persisted:
 * `localization/my/payroll.ts` stamps `pcbMeta` — pcbMonth's own snapshot — onto every payslip's
 * statutory blob. Grepping `pcbMeta` across `app/` returned nothing but a comment. It was stored, and
 * displayed nowhere, so "why is my PCB this amount" could only be answered on a separate worksheet.
 *
 * PURE, AND DELIBERATELY INCAPABLE OF RECOMPUTING. This module reads; it does not calculate tax. A panel
 * that re-derived the figure could disagree with the figure it claims to explain, which is worse than no
 * panel. Everything here is either read straight out of the blob or added up from figures that came out
 * of it.
 *
 * TWO STORED SHAPES, PLUS ONE FALLBACK:
 *
 *   1. FLAT RATE. A non-resident (30%) or a REP / Knowledge-Worker employee (15%) is taxed at a flat rate
 *      with no reliefs at all, and the blob carries `{ nonResident, flatRate, rate }`. There is no relief
 *      working to show and that is CORRECT, not a gap — so this returns a distinct shape and the screen
 *      says which rate was applied instead of rendering an empty relief table.
 *
 *   2. THE MTD SNAPSHOT. `{ month, n, ytdNet, epfClaimed, pcbPaid, P1, P2? }`, plus — from 169e3c24
 *      onward — `reliefs`, the relief legs as pcbMonth actually applied them.
 *
 *   3. PRE-SNAPSHOT FALLBACK. A payslip calculated before the relief legs were recorded has the first six
 *      keys and no `reliefs`. Its reliefs are then taken from the employee's CURRENT position, and
 *      `reliefSource` says so, because an employee who has since married or had a child would otherwise
 *      have a closed payslip explained with a relief position that did not exist when it was computed.
 *      The screen MUST surface `reliefSource`; a silent fallback is the failure mode this names.
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
      pcb: number;
    };

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

type FlatMeta = { nonResident?: unknown; flatRate?: unknown; rate?: unknown };
type SnapshotMeta = {
  month?: unknown;
  n?: unknown;
  ytdNet?: unknown;
  epfClaimed?: unknown;
  pcbPaid?: unknown;
  P1?: unknown;
  P2?: unknown;
  reliefs?: Partial<PcbReliefBreakdown>;
};

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
    return { kind: 'flat', rate, nonResident: flat.nonResident === true, pcb };
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
    pcb,
  };
}
