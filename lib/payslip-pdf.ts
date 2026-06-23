// ADR-0036 (#22) — render a payslip as an A5 PDF with pdf-lib (pure JS, no WASM/native, so no Next
// bundler friction). A pure function over the payslipDetail read + localized labels, so it is unit-
// testable and reused identically by every surface that links the PDF route.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type PayslipPdfData = {
  employee: string;
  employeeCode: string | null;
  company: string;
  companyReg: string | null;
  payPeriod: string;
  basic: number;
  allowance: number;
  overtime: number;
  bonus: number;
  gross: number;
  epfEmployee: number;
  socsoEmployee: number;
  socsoSkbbk: number;
  eisEmployee: number;
  pcb: number;
  otherDeductions: number;
  totalDeductions: number;
  net: number;
  epfEmployer: number;
  socsoEmployer: number;
  eisEmployer: number;
  employerCost: number;
  daysWorked: number | null;
};

/** Localized labels (resolved from the `me.payslip` namespace in the route). */
export type PayslipPdfLabels = {
  title: string;
  payPeriod: string;
  employeeCode: string;
  earnings: string;
  basicSalary: string;
  allowances: string;
  overtime: string;
  bonus: string;
  grossPay: string;
  deductions: string;
  epf: string;
  socso: string;
  skbbk: string;
  eis: string;
  pcb: string;
  otherDeductions: string;
  totalDeductions: string;
  netPay: string;
  employerContributions: string;
  totalEmployerCost: string;
  proratedNote: string; // already interpolated with the day count by the caller
  generatedNote: string;
};

export async function renderPayslipPdf(d: PayslipPdfData, t: PayslipPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.payPeriod}`);
  doc.setProducer('AI HR');
  const page = doc.addPage([419.53, 595.28]); // A5 portrait
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 36;
  const right = page.getWidth() - M;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const lineCol = rgb(0.85, 0.85, 0.88);
  const accent = rgb(0.21, 0.24, 0.55);
  // Helvetica is WinAnsi (Latin-1) — guard non-Latin codepoints so a CJK/Tamil name never crashes the
  // render (phase 1; embedding a Unicode font is the deferred follow-up per ADR-0036).
  const safe = (s: string) => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const rm = (n: number) =>
    'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let y = page.getHeight() - M;
  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textR = (s: string, xr: number, size: number, f = font, color = ink) => {
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: xr - w, y, size, font: f, color });
  };
  const hr = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: right, y: yy }, thickness: 0.7, color: lineCol });
  const sectionHeader = (label: string) => {
    text(label.toUpperCase(), M, 8, bold, muted);
    y -= 14;
  };
  const row = (label: string, value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const f = opts.bold ? bold : font;
    const c = opts.color ?? ink;
    text(label, M, 9.5, f, c);
    textR(value, right, 9.5, f, c);
    y -= 15;
  };

  // Letterhead
  text(d.company, M, 13, bold);
  textR(t.title.toUpperCase(), right, 13, bold, accent);
  y -= 15;
  if (d.companyReg) text(d.companyReg, M, 8, font, muted);
  textR(`${t.payPeriod}: ${d.payPeriod}`, right, 8, font, muted);
  y -= 12;
  hr(y);
  y -= 18;

  // Employee
  text(d.employee, M, 11, bold);
  if (d.employeeCode) textR(`${t.employeeCode}: ${d.employeeCode}`, right, 9, font, muted);
  y -= 22;

  // Earnings
  sectionHeader(t.earnings);
  row(t.basicSalary, rm(d.basic));
  row(t.allowances, rm(d.allowance));
  row(t.overtime, rm(d.overtime));
  row(t.bonus, rm(d.bonus));
  hr(y + 8);
  row(t.grossPay, rm(d.gross), { bold: true });
  y -= 8;

  // Deductions
  sectionHeader(t.deductions);
  row(t.epf, rm(d.epfEmployee));
  row(t.socso, rm(d.socsoEmployee));
  if (d.socsoSkbbk > 0) row(t.skbbk, rm(d.socsoSkbbk));
  row(t.eis, rm(d.eisEmployee));
  row(t.pcb, rm(d.pcb));
  if (d.otherDeductions > 0) row(t.otherDeductions, rm(d.otherDeductions));
  hr(y + 8);
  row(t.totalDeductions, '- ' + rm(d.totalDeductions), { bold: true });
  y -= 10;

  // Net pay — highlighted band
  const boxH = 28;
  page.drawRectangle({ x: M, y: y - boxH + 9, width: right - M, height: boxH, color: rgb(0.94, 0.95, 1) });
  text(t.netPay, M + 10, 11, bold);
  textR(rm(d.net), right - 10, 13, bold, accent);
  y -= boxH + 10;

  // Employer contributions (informational)
  sectionHeader(t.employerContributions);
  row(t.epf, rm(d.epfEmployer), { color: muted });
  row(t.socso, rm(d.socsoEmployer), { color: muted });
  row(t.eis, rm(d.eisEmployer), { color: muted });
  row(t.totalEmployerCost, rm(d.employerCost), { color: muted });

  // Footer
  y -= 8;
  if (d.daysWorked != null) {
    text(t.proratedNote, M, 7.5, font, muted);
    y -= 11;
  }
  text(t.generatedNote, M, 7.5, font, muted);

  return doc.save();
}
