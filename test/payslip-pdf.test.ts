/**
 * ADR-0036 (#22) — payslip PDF renderer. A pure function over the payslipDetail read + localized labels;
 * here we assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null
 * fields + non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded).
 */
import { describe, expect, it } from 'vitest';
import { renderPayslipPdf, type PayslipPdfData, type PayslipPdfLabels } from '../lib/payslip-pdf';

const labels: PayslipPdfLabels = {
  title: 'Payslip',
  payPeriod: 'Pay period',
  employeeCode: 'Employee code',
  earnings: 'Earnings',
  basicSalary: 'Basic salary',
  allowances: 'Allowances',
  overtime: 'Overtime',
  bonus: 'Bonus',
  grossPay: 'Gross pay',
  deductions: 'Deductions',
  epf: 'EPF',
  socso: 'SOCSO',
  skbbk: 'SKBBK',
  eis: 'EIS',
  pcb: 'PCB',
  cp38: 'CP38',
  otherDeductions: 'Other deductions',
  totalDeductions: 'Total deductions',
  netPay: 'Net pay',
  employerContributions: 'Employer contributions',
  totalEmployerCost: 'Total employer cost',
  proratedNote: 'Prorated for 21 days worked',
  generatedNote: 'This is a system-generated payslip.',
  claim: 'Claim',
  employerBorne: 'Paid by your employer on your behalf',
  employerBorneTotal: 'Total borne by employer',
  employerBorneNote: 'Reported in full to the authorities; not deducted from your pay.',
};
const data: PayslipPdfData = {
  employee: 'Aisyah Rahman',
  employeeCode: 'EMP-001',
  company: 'Demo Sdn Bhd',
  companyReg: '202301000001 (1400001-A)',
  payPeriod: '2026-06',
  basic: 6500,
  allowance: 500,
  overtime: 120,
  bonus: 0,
  claim: 0,
  gross: 7120,
  epfEmployee: 715,
  socsoEmployee: 24.75,
  socsoSkbbk: 0,
  eisEmployee: 9.9,
  pcb: 350,
  cp38: 0,
  otherDeductions: 0,
  totalDeductions: 1099.65,
  net: 6020.35,
  epfEmployer: 925,
  socsoEmployer: 86.65,
  eisEmployer: 9.9,
  employerCost: 8141.55,
  daysWorked: 21,
  employerBorne: [],
  employerBorneTotal: 0,
};
const head = (b: Uint8Array) => Buffer.from(b.slice(0, 5)).toString('latin1');

describe('ADR-0036 — payslip PDF', () => {
  it('renders a real PDF document of non-trivial size', async () => {
    const bytes = await renderPayslipPdf(data, labels);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(head(bytes)).toBe('%PDF-');
  });

  it('renders a distinct CP38 deduction line when cp38 > 0 (web/PDF parity)', async () => {
    // pdf-lib FlateDecode-compresses the content stream, so the label is not greppable in raw bytes.
    // The deterministic, meaningful signal: the extra drawn CP38 row makes the document strictly larger
    // than the cp38-less render (a renderer that dropped the line would produce an identical-size PDF).
    const withCp38 = await renderPayslipPdf({ ...data, cp38: 200 }, labels);
    const without = await renderPayslipPdf({ ...data, cp38: 0 }, labels);
    expect(withCp38.length).toBeGreaterThan(without.length);
    // And a zero CP38 omits the row (no growth vs. the baseline, which is also cp38: 0).
    expect(without.length).toBe((await renderPayslipPdf(data, labels)).length);
  });

  // 3c473773 — the employer-borne disclosure block. Same size-delta signal the CP38 case above uses: the
  // named lines + total + note are drawn rows, so the document is strictly larger when there is something
  // to disclose, and byte-for-byte the baseline when there is not (every payslip issued before the
  // employer-bears settings existed).
  it('prints the employer-borne block only when the payslip carries one', async () => {
    const withBorne = await renderPayslipPdf(
      { ...data, employerBorne: [{ label: 'EPF', amount: 629 }, { label: 'SOCSO', amount: 28.25 }], employerBorneTotal: 657.25 },
      labels,
    );
    const without = await renderPayslipPdf(data, labels);
    expect(withBorne.length).toBeGreaterThan(without.length);
    expect(without.length).toBe((await renderPayslipPdf({ ...data, employerBorne: [], employerBorneTotal: 0 }, labels)).length);
  });

  it('degrades gracefully: null code/reg, no skbbk/other rows, no proration, non-Latin name', async () => {
    const bytes = await renderPayslipPdf(
      { ...data, employee: '陈大文', employeeCode: null, companyReg: null, socsoSkbbk: 0, otherDeductions: 0, daysWorked: null },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-'); // safe-encode guard → no crash on the CJK name
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
