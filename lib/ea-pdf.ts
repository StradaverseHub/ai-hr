// ADR-0036 (#22 follow-up) — render an annual EA (C.P.8A) Statement of Remuneration as an A4 PDF with
// pdf-lib (pure JS, no WASM/native, so no Next bundler friction). A pure function over the
// employeeEaStatement read + localized labels, so it is unit-testable and reused identically by every
// surface that links the /me EA PDF route. Mirrors lib/payslip-pdf.ts; A4 portrait because the EA is
// denser than the A5 payslip.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** Mirrors EaStatement (localization/my/reports.ts). year is a STRING end-to-end (the read filters
 *  payPeriod LIKE '<year>-%'). */
export type EaPdfData = {
  year: string;
  employer: { name: string; eNumber: string | null };
  employee: {
    name: string;
    ic: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    category: number;
    children: number;
    hiredOn: string;
    terminatedOn: string | null;
  };
  /** exemptAllowances (feedback 09b554e9): the year's tax-exempt PCB_* allowance portions — optional +
   *  additive (older callers omit it and the row renders as 0.00). */
  partB: { grossSalary: number; bonus: number; allowances: number; gross: number; exemptAllowances?: number };
  partD: { mtd: number };
  partE: { epf: number; socso: number; eis: number };
  statutoryVersion: string;
  /** 1.2.6 EA Data Overwrite — EA-only amendments overlaid by HR; drives the footnote marker. Optional +
   *  defaults to [] so existing callers keep compiling. */
  overrides?: { field: string; original: number; amended: number; reason: string }[];
};

/** Localized labels (resolved from the `payroll.ea` namespace in the route). Mirrors the HTML EA page. */
export type EaPdfLabels = {
  title: string;
  yearEnded: string; // already interpolated with {year} + {employer} by the caller
  category1: string;
  category2: string;
  category3: string;
  sectionAEmployeeParticulars: string;
  name: string;
  incomeTaxNo: string;
  icNo: string;
  epfNo: string;
  socsoNo: string;
  mtdCategory: string;
  childrenTaxRelief: string;
  employmentPeriod: string;
  present: string;
  sectionBEmploymentIncome: string;
  grossSalary: string;
  bonus: string;
  allowancesPerquisites: string;
  exemptAllowances: string;
  benefitsInKind: string;
  livingAccommodation: string;
  notTracked: string;
  totalGrossRemuneration: string;
  sectionDTotalDeductions: string;
  monthlyTaxDeduction: string;
  cp38Deductions: string;
  zakatViaSalary: string;
  sectionEContributions: string;
  epfKwsp: string;
  socso: string;
  eisSip: string;
  disclaimer: string; // already interpolated with {year} + {version} by the caller
  amendedNote: string; // 1.2.6 — printed only when ≥1 EA field was amended by HR
};

export async function renderEaPdf(d: EaPdfData, t: EaPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.year}`);
  doc.setProducer('AI HR');
  const page = doc.addPage([595.28, 841.89]); // A4 portrait — EA is denser than the A5 payslip
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 48;
  const right = page.getWidth() - M;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const lineCol = rgb(0.85, 0.85, 0.88);
  const accent = rgb(0.21, 0.24, 0.55);
  // Helvetica is WinAnsi (Latin-1). An LHDN-facing EA carries the employee's LEGAL name; a Tamil/Chinese
  // name degrades to '?' here. This is a documented, tracked limitation — embedding a Unicode font is the
  // deferred follow-up per ADR-0036 — not an accidental silent drop.
  const safe = (s: string) => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const rm = (n: number) =>
    'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // taxCategory is constrained to 1/2/3, but the renderer must NOT assume the map is total (mirror the
  // HTML page's `CATEGORY[c] ?? String(c)` fallback).
  const CATEGORY: Record<number, string> = { 1: t.category1, 2: t.category2, 3: t.category3 };

  let y = page.getHeight() - M;
  const text = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textR = (s: string, xr: number, size: number, f = font, color = ink) => {
    const w = f.widthOfTextAtSize(safe(s), size);
    page.drawText(safe(s), { x: xr - w, y, size, font: f, color });
  };
  const hr = (yy: number) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: right, y: yy }, thickness: 0.7, color: lineCol });
  const sectionHeader = (label: string) => {
    y -= 6;
    text(label.toUpperCase(), M, 8.5, bold, muted);
    y -= 14;
  };
  const row = (label: string, value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const f = opts.bold ? bold : font;
    const c = opts.color ?? ink;
    text(label, M, 9.5, f, c);
    textR(value, right, 9.5, f, c);
    y -= 16;
  };

  // Letterhead
  text(d.employer.name, M, 14, bold);
  textR(t.title.toUpperCase(), right, 11, bold, accent);
  y -= 16;
  text(t.yearEnded + (d.employer.eNumber ? ` · E ${d.employer.eNumber}` : ''), M, 8.5, font, muted);
  y -= 12;
  hr(y);
  y -= 20;

  // A — Employee particulars
  sectionHeader(t.sectionAEmployeeParticulars);
  row(t.name, d.employee.name);
  row(t.incomeTaxNo, d.employee.taxNo || '—');
  row(t.icNo, d.employee.ic || '—');
  row(t.epfNo, d.employee.epfNo || '—');
  row(t.socsoNo, d.employee.socsoNo || '—');
  row(t.mtdCategory, CATEGORY[d.employee.category] ?? String(d.employee.category));
  row(t.childrenTaxRelief, String(d.employee.children));
  const period =
    d.employee.hiredOn || d.employee.terminatedOn
      ? `${d.employee.hiredOn || '—'} → ${d.employee.terminatedOn || t.present}`
      : '—';
  row(t.employmentPeriod, period);

  // B — Employment income (cash)
  sectionHeader(t.sectionBEmploymentIncome);
  row(t.grossSalary, rm(d.partB.grossSalary));
  row(t.bonus, rm(d.partB.bonus));
  row(t.allowancesPerquisites, rm(d.partB.allowances));
  // Feedback 09b554e9 — the year's tax-exempt allowance portions (informational: already inside the
  // allowances figure above; LHDN's EA reports exempt allowances in their own section).
  row(t.exemptAllowances, rm(d.partB.exemptAllowances ?? 0), { color: muted });
  row(t.benefitsInKind, t.notTracked, { color: muted });
  row(t.livingAccommodation, t.notTracked, { color: muted });
  hr(y + 9);
  y -= 2;
  row(t.totalGrossRemuneration, rm(d.partB.gross), { bold: true });

  // D — Total deductions
  sectionHeader(t.sectionDTotalDeductions);
  row(t.monthlyTaxDeduction, rm(d.partD.mtd));
  row(t.cp38Deductions, t.notTracked, { color: muted });
  row(t.zakatViaSalary, t.notTracked, { color: muted });

  // E — Contributions (employee's share)
  sectionHeader(t.sectionEContributions);
  row(t.epfKwsp, rm(d.partE.epf));
  row(t.socso, rm(d.partE.socso));
  row(t.eisSip, rm(d.partE.eis));

  // 1.2.6 — "Amended" marker: print a footnote when ≥1 EA field was overwritten by HR (the merge already
  // overlaid the figures above). Disclosure of which figures were amended is a compliance decision flagged
  // in the plan; the default is this neutral marker.
  if (d.overrides && d.overrides.length > 0) {
    y -= 6;
    text(t.amendedNote, M, 8, bold, accent);
    y -= 4;
  }

  // Disclaimer band
  y -= 8;
  hr(y + 6);
  y -= 8;
  // Wrap the disclaimer across the content width so it never runs off the page edge.
  const words = safe(t.disclaimer).split(/\s+/);
  const maxW = right - M;
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(trial, 7.5) > maxW && line) {
      text(line, M, 7.5, font, muted);
      y -= 10;
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) text(line, M, 7.5, font, muted);

  return doc.save();
}
