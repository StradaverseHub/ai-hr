// ADR-0036 (#22) — render a payslip as an A5 PDF with pdf-lib (pure JS, no WASM/native, so no Next
// bundler friction). A pure function over the payslipDetail read + localized labels, so it is unit-
// testable and reused identically by every surface that links the PDF route.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { payslipDisplayEarnings } from '../core/pay-display-category';
import { payslipEmployerBorne, type EmployerBorneKey } from '../core/payslip-employer-borne';

const n = (v: unknown) => Number(v ?? 0);

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
  /** 3c473773 — a pay item declared into the Claim box. 0 (and unprinted) unless one was categorised. */
  claim: number;
  gross: number;
  epfEmployee: number;
  socsoEmployee: number;
  socsoSkbbk: number;
  eisEmployee: number;
  pcb: number;
  cp38: number;
  otherDeductions: number;
  totalDeductions: number;
  net: number;
  epfEmployer: number;
  socsoEmployer: number;
  eisEmployer: number;
  employerCost: number;
  daysWorked: number | null;
  /** 3c473773 issue 2 — statutory contributions the EMPLOYER funded on the employee's behalf, named and
   *  totalled. Empty ⇒ nothing to disclose ⇒ the block is not printed and the PDF is byte-identical.
   *  The five deduction figures above are already NET of these (the caller subtracts), so the printed
   *  deductions add up to the printed total — which they previously did not. */
  employerBorne: { label: string; amount: number }[];
  employerBorneTotal: number;
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
  cp38: string;
  otherDeductions: string;
  totalDeductions: string;
  netPay: string;
  employerContributions: string;
  totalEmployerCost: string;
  proratedNote: string; // already interpolated with the day count by the caller
  generatedNote: string;
  // 3c473773 — the Claim earnings box and the employer-borne disclosure block.
  claim: string;
  employerBorne: string;
  employerBorneTotal: string;
  employerBorneNote: string;
};

/**
 * 3c473773 — assemble PayslipPdfData from a payslip row + its statutory blob, ONCE.
 *
 * Both PDF routes (the employee's own, and the admin Individual Payslip review copy) print the same
 * document, so the two must not each decide for themselves which box an amount belongs in or whether a
 * deduction was employer-funded. They would drift; a payslip and its own PDF disagreeing about EPF is
 * exactly the class of defect this item exists to close.
 *
 * `borneLabels` is passed in because the label text is resolved from the caller's i18n namespace; the
 * SELECTION of which components to print, and their amounts, are decided here from the payslip's own
 * stored snapshot.
 */
export function buildPayslipPdfData(
  p: {
    employee: string; employeeCode: string | null; company: string; companyReg: string | null;
    payPeriod: string; basic: unknown; allowance: unknown; overtime: unknown; bonus: unknown;
    gross: unknown; statutory: unknown; otherDeductions: unknown; totalDeductions: unknown;
    net: unknown; employerCost: unknown; daysWorked: unknown;
  },
  borneLabels: Record<EmployerBorneKey, string>,
): PayslipPdfData {
  const st = (p.statutory ?? {}) as Record<string, unknown>;
  const disp = payslipDisplayEarnings(p);
  const eb = payslipEmployerBorne(p.statutory);
  return {
    employee: p.employee,
    employeeCode: p.employeeCode,
    company: p.company,
    companyReg: p.companyReg,
    payPeriod: p.payPeriod,
    basic: disp.basic,
    allowance: disp.allowance,
    overtime: disp.overtime,
    bonus: disp.bonus,
    claim: disp.claim,
    gross: n(p.gross),
    // NET of employer-borne, so the printed deductions sum to the printed total.
    epfEmployee: eb.employee.epf,
    socsoEmployee: eb.employee.socso,
    socsoSkbbk: eb.employee.skbbk,
    eisEmployee: eb.employee.eis,
    pcb: eb.employee.pcb,
    cp38: n(st.cp38),
    otherDeductions: n(p.otherDeductions),
    totalDeductions: n(p.totalDeductions),
    net: n(p.net),
    epfEmployer: n(st.epfEmployer),
    socsoEmployer: n(st.socsoEmployer),
    eisEmployer: n(st.eisEmployer),
    employerCost: n(p.employerCost),
    daysWorked: p.daysWorked != null ? n(p.daysWorked) : null,
    employerBorne: eb.keys.map((k) => ({ label: borneLabels[k], amount: eb.borne[k] })),
    employerBorneTotal: eb.total,
  };
}

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
  if (d.claim > 0) row(t.claim, rm(d.claim));
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
  if (d.cp38 > 0) row(t.cp38, rm(d.cp38));
  if (d.otherDeductions > 0) row(t.otherDeductions, rm(d.otherDeductions));
  hr(y + 8);
  row(t.totalDeductions, '- ' + rm(d.totalDeductions), { bold: true });
  y -= 10;

  // Employer-borne statutory contributions (3c473773 issue 2). Printed only when this payslip's own
  // snapshot records them; otherwise the page is unchanged. Without it the deduction lines above read
  // 0.00 with nothing on the page saying who paid them.
  if (d.employerBorne.length > 0) {
    sectionHeader(t.employerBorne);
    for (const l of d.employerBorne) row(l.label, rm(l.amount));
    hr(y + 8);
    row(t.employerBorneTotal, rm(d.employerBorneTotal), { bold: true });
    y -= 2;
    text(t.employerBorneNote, M, 7.5, font, muted);
    y -= 14;
  }

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
