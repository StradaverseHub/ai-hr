// ADR-0036 (#22 follow-up) — render an annual EA (C.P.8A) Statement of Remuneration as an A4 PDF with
// pdf-lib (pure JS, no WASM/native, so no Next bundler friction). A pure function over the
// employeeEaStatement read + localized labels, so it is unit-testable and reused identically by every
// surface that links the /me EA PDF route. Mirrors lib/payslip-pdf.ts; A4 portrait because the EA is
// denser than the A5 payslip.
//
// 587ee719 / 6036dab7 — ONE RENDERER, AND IT STAYS ONE. English and Bahasa Malaysia are a label bundle
// handed to this function, not a second implementation: two renderers can disagree about one employee's
// income on a tax document, and that is the single outcome this file exists to prevent. Every box the
// customer's field mapping names is drawn HERE, from the ONE eaStatement read, in both languages.
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
    /** 6036dab7 — Part A's three added particulars. REQUIRED, not optional-and-additive like
     *  `exemptAllowances` below: an optional Part A field is one a caller can forget to pass, and the
     *  form then prints a blank box that looks like "nothing on file" rather than "nobody wired it". */
    employeeNo: string | null;
    jobTitle: string | null;
    passport: string | null;
  };
  /** exemptAllowances (feedback 09b554e9): the year's tax-exempt PCB_* allowance portions — optional +
   *  additive (older callers omit it and the row renders as 0.00).
   *
   *  6036dab7 — the ten fields after it are the customer's mapped Part B boxes, and they are REQUIRED for
   *  the same reason the Part A trio is: a taxable box that silently prints 0.00 because a caller forgot
   *  it is indistinguishable from a taxable box that is genuinely nil. `gross` is their sum. */
  partB: {
    grossSalary: number;
    bonus: number;
    allowances: number;
    gross: number;
    exemptAllowances?: number;
    directorFee: number;
    tipsPerquisites: number;
    taxBorneByEmployer: number;
    esos: number;
    gratuity: number;
    arrears: number;
    benefitsInKind: number;
    livingAccommodation: number;
    unapprovedFundRefund: number;
    compensation: number;
  };
  /** 6036dab7 — Part C (Pencen dan Lain-lain), which this renderer did not draw at all. */
  partC: { pension: number; annuity: number; total: number };
  partD: { mtd: number; cp38: number; zakat: number };
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
  jobTitle: string;
  employeeNo: string;
  incomeTaxNo: string;
  icNo: string;
  passportNo: string;
  epfNo: string;
  socsoNo: string;
  mtdCategory: string;
  childrenTaxRelief: string;
  employmentPeriod: string;
  present: string;
  sectionBEmploymentIncome: string;
  grossSalary: string;
  bonus: string;
  directorFee: string;
  allowancesPerquisites: string;
  tipsPerquisites: string;
  taxBorneByEmployer: string;
  esos: string;
  gratuity: string;
  arrears: string;
  exemptAllowances: string;
  benefitsInKind: string;
  livingAccommodation: string;
  unapprovedFundRefund: string;
  compensation: string;
  totalGrossRemuneration: string;
  sectionCPensionOther: string;
  pension: string;
  annuity: string;
  totalPensionOther: string;
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

const A4: [number, number] = [595.28, 841.89];

export async function renderEaPdf(d: EaPdfData, t: EaPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.year}`);
  doc.setProducer('AI HR');
  let page = doc.addPage(A4); // A4 portrait — EA is denser than the A5 payslip
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
  /** Greedy word-wrap at `size`. Exists so the disclaimer band can be MEASURED before it is placed: a
   *  band whose height is only known once it has been drawn cannot be kept off a page of its own. */
  const wrapped = (s: string, size: number, maxW: number) => {
    const out: string[] = [];
    let line = '';
    for (const w of s.split(/\s+/)) {
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > maxW && line) {
        out.push(line);
        line = w;
      } else line = trial;
    }
    if (line) out.push(line);
    return out;
  };

  // ── 6036dab7 — PAGINATION, AND THE CORRECTION r209 MADE TO IT ───────────────────────────────────
  // This renderer used to draw ~20 rows onto ONE fixed page and never look at the cursor, which was safe
  // only because the form was short. The customer's field mapping takes it to ~35 rows (Part A grows by
  // three particulars, Part B by ten boxes, Part C is a whole new section), so every row now asks for its
  // space before it draws and takes a new page when the page is full.
  //
  // THE CORRECTION. The first version of this comment claimed the guard "is not load-bearing TODAY" and
  // that the form still fits on one A4 page. Both halves were FALSE: the guard fired on 100% of renders.
  // The two floors below were one floor. `BOTTOM` is where the CONTENT stops so that the footnote band
  // underneath it still has room — and the band was measured against `BOTTOM` too, so it asked for space
  // that BOTTOM had already reserved *for it*, found none, and took a page of its own. Every EA came out
  // two pages, page two holding nothing but the orphaned disclaimer. Hence the second floor: the band is
  // a footnote and may sit in the bottom margin the rows keep clear of; only the page edge stops it.
  //
  // The invariant the guard buys is real and unchanged: pdf-lib does NOT complain when you draw at a
  // negative y — it silently places the text outside the media box — so an overflowing form is a valid,
  // openable, larger-than-before PDF that has quietly lost its deduction and contribution sections, and
  // `%PDF-`, byte length and no-throw all pass it. test/ea-pdf.test.ts pins BOTH ends: one page for the
  // real message-bundle labels in every locale, and every drawn line inside its page when the disclaimer
  // is long enough to genuinely need a second one.
  const BOTTOM = M + 28; // CONTENT floor — rows stop here so the footnote band below them still fits
  const FOOT = 12; // PAGE floor — the footnote band may use the bottom margin, but never leaves the page
  const newPage = () => {
    page = doc.addPage(A4);
    y = page.getHeight() - M;
  };
  const ensure = (need: number) => {
    if (y - need < BOTTOM) newPage();
  };

  const sectionHeader = (label: string) => {
    // A header alone at the foot of a page is a section that looks empty; reserve the header plus one row.
    ensure(20 + 16);
    y -= 6;
    text(label.toUpperCase(), M, 8.5, bold, muted);
    y -= 14;
  };
  const row = (label: string, value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    ensure(16);
    const f = opts.bold ? bold : font;
    const c = opts.color ?? ink;
    text(label, M, 9.5, f, c);
    textR(value, right, 9.5, f, c);
    y -= 16;
  };
  /** A section total: the rule above it and the bold line must not be split across a page break. */
  const totalRow = (label: string, value: string) => {
    ensure(18);
    hr(y + 9);
    y -= 2;
    row(label, value, { bold: true });
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
  row(t.jobTitle, d.employee.jobTitle || '—');
  row(t.employeeNo, d.employee.employeeNo || '—');
  row(t.incomeTaxNo, d.employee.taxNo || '—');
  row(t.icNo, d.employee.ic || '—');
  row(t.passportNo, d.employee.passport || '—');
  row(t.epfNo, d.employee.epfNo || '—');
  row(t.socsoNo, d.employee.socsoNo || '—');
  row(t.mtdCategory, CATEGORY[d.employee.category] ?? String(d.employee.category));
  row(t.childrenTaxRelief, String(d.employee.children));
  const period =
    d.employee.hiredOn || d.employee.terminatedOn
      ? `${d.employee.hiredOn || '—'} → ${d.employee.terminatedOn || t.present}`
      : '—';
  row(t.employmentPeriod, period);

  // B — Employment income
  sectionHeader(t.sectionBEmploymentIncome);
  row(t.grossSalary, rm(d.partB.grossSalary));
  row(t.bonus, rm(d.partB.bonus));
  row(t.directorFee, rm(d.partB.directorFee));
  row(t.allowancesPerquisites, rm(d.partB.allowances));
  row(t.tipsPerquisites, rm(d.partB.tipsPerquisites));
  row(t.taxBorneByEmployer, rm(d.partB.taxBorneByEmployer));
  row(t.esos, rm(d.partB.esos));
  row(t.gratuity, rm(d.partB.gratuity));
  row(t.arrears, rm(d.partB.arrears));
  // Feedback 09b554e9 — the year's tax-exempt allowance portions (informational: already inside the
  // allowances figure above, so it is NOT one of the components that sum into the total; LHDN's EA
  // reports exempt allowances in their own section).
  row(t.exemptAllowances, rm(d.partB.exemptAllowances ?? 0), { color: muted });
  row(t.benefitsInKind, rm(d.partB.benefitsInKind));
  row(t.livingAccommodation, rm(d.partB.livingAccommodation));
  row(t.unapprovedFundRefund, rm(d.partB.unapprovedFundRefund));
  row(t.compensation, rm(d.partB.compensation));
  totalRow(t.totalGrossRemuneration, rm(d.partB.gross));

  // C — Pension and other payments. 6036dab7: the section the form did not have at all.
  sectionHeader(t.sectionCPensionOther);
  row(t.pension, rm(d.partC.pension));
  row(t.annuity, rm(d.partC.annuity));
  totalRow(t.totalPensionOther, rm(d.partC.total));

  // D — Total deductions. CP38 and zakat are real figures now (both are stamped on every payslip); the
  // two `notTracked` placeholders that stood here were stale, not unimplemented.
  sectionHeader(t.sectionDTotalDeductions);
  row(t.monthlyTaxDeduction, rm(d.partD.mtd));
  row(t.cp38Deductions, rm(d.partD.cp38));
  row(t.zakatViaSalary, rm(d.partD.zakat));

  // E — Contributions (employee's share)
  sectionHeader(t.sectionEContributions);
  row(t.epfKwsp, rm(d.partE.epf));
  row(t.socso, rm(d.partE.socso));
  row(t.eisSip, rm(d.partE.eis));

  // ── Footnote band: the 1.2.6 "Amended" marker + the disclaimer ─────────────────────────────────────
  // MEASURED AS A WHOLE AND PLACED AS A WHOLE, against FOOT (the page floor) and not BOTTOM (the content
  // floor BOTTOM already reserved for this band). The marker is part of the band, not a row above it —
  // measured separately it orphaned onto its own page for exactly the same reason the disclaimer did.
  //
  // `bandH` mirrors the drawing that follows, step for step: 6 down to the marker's baseline + 4 after
  // it, then 8 + 8 down to the first disclaimer baseline, then 10 per further line.
  const discLines = wrapped(safe(t.disclaimer), 7.5, right - M);
  const noteH = d.overrides && d.overrides.length > 0 ? 10 : 0;
  const bandH = noteH + 16 + Math.max(0, discLines.length - 1) * 10;
  if (y - bandH < FOOT) newPage();

  // 1.2.6 — "Amended" marker: print a footnote when ≥1 EA field was overwritten by HR (the merge already
  // overlaid the figures above). Disclosure of which figures were amended is a compliance decision flagged
  // in the plan; the default is this neutral marker.
  if (noteH) {
    y -= 6;
    text(t.amendedNote, M, 8, bold, accent);
    y -= 4;
  }

  y -= 8;
  hr(y + 6);
  y -= 8;
  for (const l of discLines) {
    // Only a disclaimer taller than a whole page reaches this — the measurement above has already placed
    // a band that fits. It stays so an absurd string spills onto a second page rather than off this one.
    if (y < FOOT) newPage();
    text(l, M, 7.5, font, muted);
    y -= 10;
  }

  return doc.save();
}
