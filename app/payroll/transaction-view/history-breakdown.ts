import type { ProcessedPayslipViewRow } from '@/core/payroll-view';
import { payslipDisplayEarnings } from '@/core/pay-display-category';
import { payslipEmployerBorne, type EmployerBorneView } from '@/core/payslip-employer-borne';
import { payslipStatutoryBases, type StatutoryBases } from '@/core/payslip-recompute';

/**
 * Pure derivation of the itemized History breakdown (feedback 5f8d8395) from a processed-payslip view row.
 * No React, no i18n — just the numbers the expandable detail panel renders, so the split logic is unit-testable
 * (see test/history-breakdown.test.ts). The client history-table.tsx maps this onto labelled sections.
 *
 * Presentation-only: reads the already-fetched row + its statutory blob; derives nothing that isn't already in
 * the payslip. Deliberately mirrors app/me/payslip/[payslipId]/page.tsx (which uses the ESS-gated payslipDetail)
 * WITHOUT the release gate, so admin History can itemize processed-but-unreleased batches too.
 */

export type RecordLine = { code: string; name: string; amount: number };

/** Which summarised figure a pay item's money landed in (feedback 862ed0ad). Mirrors the kernel's
 *  stamp in core/payroll.ts earningsOf — the names are a stored contract, not a display choice. */
export type ComponentBucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';

/** One pay item as it behaved in a run: the whole amount, and every figure it contributed to. A single
 *  item can appear in two buckets (an exempt portion paid untaxed, plus a taxable remainder). */
export type ComponentLine = {
  code: string;
  name: string;
  amount: number;
  buckets: { bucket: ComponentBucket; amount: number }[];
  // Feedback 2333b7fb/0253dc7c — the item's statutory ticks AS THIS RUN FOLDED THEM. Stamped by the
  // kernel from r193 onward; ABSENT on every earlier payslip, which is why every reader must treat
  // `undefined` as "this run did not record it" and fall back to the live catalogue rather than
  // reading it as false. There is no per-item SKBBK setting anywhere in the schema: `socso` is one
  // stored answer behind the SOCSO, EIS and SKBBK captions on screen.
  epf?: boolean;
  socso?: boolean;
  pcb?: boolean;
  hrdf?: boolean;
};


export type BreakdownStat = {
  epfEmployee?: number;
  epfEmployer?: number;
  socsoEmployee?: number;
  socsoEmployer?: number;
  socsoSkbbk?: number;
  eisEmployee?: number;
  eisEmployer?: number;
  pcb?: number;
  cp38?: number;
  /** HRD Corp levy, employer-only. Persisted on every payslip as `statutory.hrdf` (efece4ce). */
  hrdf?: number;
  zakat?: number;
  recordLines?: RecordLine[];
  /** Per-item detail behind the summarised figures. ABSENT on every run calculated before 862ed0ad —
   *  the detail was never written down, so it cannot be recovered; that is what `detailNotRecorded` says
   *  on screen instead of rendering an empty breakdown that reads as a bug. */
  componentLines?: ComponentLine[];
  otConvert?: { code: string; name: string; amount: number };
};

export type HistoryBreakdown = {
  st: BreakdownStat;
  basic: number;
  /** Base allowance with the OT-converted excess (f3148da1) taken out, so gross still reconciles. */
  allowanceNet: number;
  otConvertAmount: number;
  overtime: number;
  bonus: number;
  /** 3c473773 — a pay item declared into the Claim box. Zero (and unrendered) unless someone deliberately
   *  categorised one, which is why no existing payslip grows a line. */
  claim: number;
  gross: number;
  totalDeductions: number;
  net: number;
  /** Employer statutory contributions plus their sum (display total). HRDF joins the set in feedback
   *  efece4ce — it was computed and STORED on every payslip (`statutory.hrdf`) but shown nowhere, so an
   *  HR administrator had no way to verify the levy or reconcile the employer cost. */
  employerContributions: { epf: number; socso: number; eis: number; hrdf: number; total: number };
  /** 3c473773 issue 2 — the employer-borne DISCLOSURE, read from this payslip's OWN stored snapshot. The
   *  engine already moved these amounts onto the company; nothing on any screen said so, which is what made
   *  a correct payroll look broken. `employerBorne.employee` is what actually came off take-home;
   *  `employerBorne.reported` is the full share that still goes to KWSP / PERKESO / LHDN. */
  employerBorne: EmployerBorneView;
  recordLines: RecordLine[];
  /** The pay items behind the summarised figures, as stored. Empty for a pre-862ed0ad run. */
  componentLines: ComponentLine[];
  /** The same lines grouped by the figure they explain — what the expandable panel renders under each
   *  total. INVARIANT (pinned by test/history-breakdown.test.ts): the amounts under a bucket sum to that
   *  bucket's stored total, because both come from the same stamp rather than being recomputed here.
   *  Recomputing from today's pay setup is what would let a breakdown disagree with the figure beside it. */
  componentsByBucket: Record<ComponentBucket, RecordLine[]>;
  /** This run predates the per-item stamp (or had no pay items), so there is nothing to disclose. The
   *  screen must SAY this — an empty breakdown under a non-zero total reads as a defect. */
  detailNotRecorded: boolean;
  /**
   * Feedback 0253dc7c — the wage each agency was ACTUALLY charged on, as this run recorded it
   * (`statutory.bases`, stamped from r187 onward). NULL on a payslip written before that stamp
   * existed: 61 of the 121 production payslips are in that state, and the screen renders null as an
   * em dash with a caption. It is NEVER replaced by gross pay or by any other figure — a wrong wage
   * base on a reconciliation screen is worse than a blank one, and the whole point of the disclosure
   * is that the number can be trusted.
   *
   * On an ADDITIONAL run these describe the CUMULATIVE month, not that run's own money (A0006's
   * 2026-01 bonus payslip is all zeros yet stamps an EPF base of 5,100). Grid rows are keyed by run
   * type, so that lands on its own line rather than being added to anything.
   */
  bases: StatutoryBases | null;
};

const num = (v: unknown) => Number(v ?? 0);

const EMPTY_BUCKETS = (): Record<ComponentBucket, RecordLine[]> => ({
  wage: [], ot: [], bonus: [], reimburse: [], deduct: [],
});

/** Group stored lines under the figure each contributed to. Pure re-shaping of what is on the payslip —
 *  no arithmetic beyond copying the stored per-bucket amounts across. */
function groupByBucket(lines: ComponentLine[]): Record<ComponentBucket, RecordLine[]> {
  const out = EMPTY_BUCKETS();
  for (const l of lines) {
    for (const b of l.buckets ?? []) {
      if (out[b.bucket]) out[b.bucket].push({ code: l.code, name: l.name, amount: b.amount });
    }
  }
  return out;
}

export function deriveHistoryBreakdown(row: ProcessedPayslipViewRow): HistoryBreakdown {
  const st = (row.statutory ?? {}) as BreakdownStat;
  const otConvertAmount = num(st.otConvert?.amount);
  const epf = num(st.epfEmployer);
  const socso = num(st.socsoEmployer);
  const eis = num(st.eisEmployer);
  // `hrdf` — the HRD Corp levy, employer-only. Zero for a company whose HRDF Contribution Rate is unset
  // (the engine resolves an absent company statutory row to 'not_registered'), which is why it reads 0
  // on most payslips today rather than being absent.
  const hrdf = num(st.hrdf);
  const componentLines = st.componentLines ?? [];
  // 3c473773 — the boxes come from the payslip's OWN stamp when it carries one, and from the stored columns
  // when it does not. Never re-derived from today's pay-item setup: a category changed in March must not
  // rewrite what January's payslip said. `allowance` still carries otConvert inside it, so `allowanceNet`
  // below is the identical expression it always was.
  const disp = payslipDisplayEarnings(row);
  return {
    st,
    basic: disp.basic,
    allowanceNet: disp.allowance - otConvertAmount,
    otConvertAmount,
    overtime: disp.overtime,
    bonus: disp.bonus,
    claim: disp.claim,
    gross: num(row.gross),
    totalDeductions: num(row.totalDeductions),
    net: num(row.net),
    // HRDF is added to the TOTAL as well as shown as its own line. Adding the row without the total
    // would leave the section's own arithmetic wrong — the failure this kind of change invites.
    employerContributions: { epf, socso, eis, hrdf, total: epf + socso + eis + hrdf },
    employerBorne: payslipEmployerBorne(row.statutory),
    recordLines: st.recordLines ?? [],
    componentLines,
    componentsByBucket: groupByBucket(componentLines),
    detailNotRecorded: componentLines.length === 0,
    // 0253dc7c — read through the kernel's own accessor so "absent" means the same thing here as it
    // does in the payslip-version diff. It returns null (never zeroes) for a slip with no stamp.
    bases: payslipStatutoryBases(row.statutory),
  };
}
