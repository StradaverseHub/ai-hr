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
  /** Employer statutory contributions — the three components plus their sum (display total). */
  employerContributions: { epf: number; socso: number; eis: number; total: number };
  recordLines: RecordLine[];
};

const num = (v: unknown) => Number(v ?? 0);

export function deriveHistoryBreakdown(row: ProcessedPayslipViewRow): HistoryBreakdown {
  const st = (row.statutory ?? {}) as BreakdownStat;
  const otConvertAmount = num(st.otConvert?.amount);
  const epf = num(st.epfEmployer);
  const socso = num(st.socsoEmployer);
  const eis = num(st.eisEmployer);
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
    employerContributions: { epf, socso, eis, total: epf + socso + eis },
    recordLines: st.recordLines ?? [],
  };
}
