import type { ProcessedPayslipViewRow } from '@/core/payroll-view';

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
  gross: number;
  totalDeductions: number;
  net: number;
  /** Employer statutory contributions plus their sum (display total). HRDF joins the set in feedback
   *  efece4ce — it was computed and STORED on every payslip (`statutory.hrdf`) but shown nowhere, so an
   *  HR administrator had no way to verify the levy or reconcile the employer cost. */
  employerContributions: { epf: number; socso: number; eis: number; hrdf: number; total: number };
  recordLines: RecordLine[];
};

const num = (v: unknown) => Number(v ?? 0);

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
  return {
    st,
    basic: num(row.basic),
    allowanceNet: num(row.allowance) - otConvertAmount,
    otConvertAmount,
    overtime: num(row.overtime),
    bonus: num(row.bonus),
    gross: num(row.gross),
    totalDeductions: num(row.totalDeductions),
    net: num(row.net),
    // HRDF is added to the TOTAL as well as shown as its own line. Adding the row without the total
    // would leave the section's own arithmetic wrong — the failure this kind of change invites.
    employerContributions: { epf, socso, eis, hrdf, total: epf + socso + eis + hrdf },
    recordLines: st.recordLines ?? [],
  };
}
