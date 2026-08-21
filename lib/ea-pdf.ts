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
  partD: {
    mtd: number;
    cp38: number;
    zakat: number;
    /** da4fc817 — the official form's D4, D5(a), D5(b) and D6. `tp1Relief` is derived from the year's
     *  approved TP1 declarations; the other three are 0 until HR amends them, and print only when set. */
    tp1Relief: number;
    donations: number;
    zakatOther: number;
    childRelief: number;
  };
  partE: {
    epf: number;
    socso: number;
    eis: number;
    /** da4fc817 — E1's "Nama Kumpulan Wang": the fund, named before its amount, as the form asks. */
    fundName: string;
  };
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
  /** da4fc817 — Section D's four missing lines, Section E's fund name, and Section F's heading. */
  tp1Relief: string;
  donations: string;
  zakatOther: string;
  childRelief: string;
  fundName: string;
  sectionFExemptAllowances: string;
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
  /**
   * da4fc817 — a SECTION HEADING THAT CARRIES ITS OWN AMOUNT, for a section whose whole content is one
   * figure (F: total tax-exempt allowances). Two lines — a header then a row — is what the other sections
   * need because they have several lines each; spending two on a section with one figure is what pushed
   * this form onto a second page, which its own guard refuses. Reads as the official form does: a titled
   * line with an amount against it.
   */
  const sectionTotalLine = (label: string, value: string) => {
    ensure(20);
    y -= 6;
    text(label.toUpperCase(), M, 8.5, bold, muted);
    const w = bold.widthOfTextAtSize(value, 9);
    text(value, right - w, 9, bold, ink);
    y -= 14;
  };
  /**
   * ⚠️ ROW_H IS 12.5, NOT 14, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN A STYLE ONE. The official
   * C.P.8A is ONE page and test/ea-pdf.test.ts refuses a second one in every locale. da4fc817 added the
   * four Section D lines, Section E's fund name and Section F that the published form has and this
   * renderer did not, and at 14pt leading the fully-populated form no longer fitted. The form is dense
   * because the agency's own is dense; if a future round adds another box and the page guard goes red,
   * the answer is the same arithmetic, not a second page.
   */
  const ROW_H = 12.5;
  const row = (label: string, value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    ensure(ROW_H + 2);
    const f = opts.bold ? bold : font;
    const c = opts.color ?? ink;
    text(label, M, 9.5, f, c);
    textR(value, right, 9.5, f, c);
    y -= ROW_H;
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
  // ⚠️ A BOX THAT PRINTS 0.00 MAKES A CLAIM; AN ABSENT BOX MAKES NONE — and for these lines we are not
  // entitled to the claim. Nothing in payroll can derive them: `payslip` persists only basic_salary /
  // allowance / overtime_pay / bonus / gross_pay plus a `statutory` jsonb, there is no payslip-line
  // table anywhere in db/schema.ts, and core/payroll.ts folds EVERY earning component into
  // `payslip.allowance` before the row is written. `eaFormLine` on a component definition has no
  // consumer on this path. So the only source for these boxes is an `ea_override` HR has keyed.
  //
  // Printing them as a derived 0.00 was therefore an ASSERTION THAT MONEY DOES NOT EXIST while the same
  // money is printed two lines up under Allowances: a tenant paying a director RM 4,000/month of
  // commission got "Fees (incl. director's fees) / commission  RM 0.00" beside an Allowances figure
  // carrying the RM 48,000 — an affirmative false statement on a C.P.8A, and one that costs HR an
  // amendment per box to undo. Before this round these boxes did not exist at all, so printing them
  // unconditionally made the form actively wrong rather than merely incomplete.
  //
  // `optionalRow` prints the line when HR has entered a figure (an override, or a genuine non-zero) and
  // omits it otherwise. Un-folding the components properly needs a persisted per-component breakdown —
  // a new table, a migration, and a backfill that is impossible for slips already generated — which is
  // its own round with its own plan, alongside the CP8D / Form E reconciliation.
  const optionalRow = (label: string, v: number) => {
    if (Math.round((Number(v) || 0) * 100) !== 0) row(label, rm(v));
  };
  optionalRow(t.directorFee, d.partB.directorFee);
  row(t.allowancesPerquisites, rm(d.partB.allowances));
  optionalRow(t.tipsPerquisites, d.partB.tipsPerquisites);
  optionalRow(t.taxBorneByEmployer, d.partB.taxBorneByEmployer);
  optionalRow(t.esos, d.partB.esos);
  optionalRow(t.gratuity, d.partB.gratuity);
  optionalRow(t.arrears, d.partB.arrears);
  // da4fc817 — the exempt-allowance figure MOVED to its own Section F, where the official form keeps it.
  // It is deliberately NOT printed here any more: it is already inside the allowances figure above, so a
  // second appearance in Part B read as another component of the total.
  optionalRow(t.benefitsInKind, d.partB.benefitsInKind);
  optionalRow(t.livingAccommodation, d.partB.livingAccommodation);
  optionalRow(t.unapprovedFundRefund, d.partB.unapprovedFundRefund);
  optionalRow(t.compensation, d.partB.compensation);
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
  // da4fc817 — D4, D5(a), D5(b), D6. `optionalRow` for all four, and that is AGENTS 28 rather than a
  // style choice: an absent box asserts nothing, a box reading 0.00 asserts the money does not exist.
  // r209 shipped exactly that defect on this form — manual Part B boxes drawn at their derived value,
  // always zero, so a director paid RM48,000 in commission got "Fees … RM 0.00" beside an Allowances
  // figure carrying it. TP1 relief is derived and usually real; the other three appear only once HR
  // enters them.
  optionalRow(t.donations, d.partD.donations);
  optionalRow(t.tp1Relief, d.partD.tp1Relief);
  optionalRow(t.zakatOther, d.partD.zakatOther);
  optionalRow(t.childRelief, d.partD.childRelief);

  // E — Contributions (employee's share)
  sectionHeader(t.sectionEContributions);
  // da4fc817 — the official Section E asks WHICH fund before it asks how much, and carries exactly two
  // amounts: the approved fund and PERKESO. EIS is NOT one of its lines — it is kept (an employee's own
  // EIS deduction is a real figure they may need) but printed BELOW the section rather than inside it,
  // so the form's own Section E matches the published one line for line.
  row(t.fundName, d.partE.fundName);
  row(t.epfKwsp, rm(d.partE.epf));
  row(t.socso, rm(d.partE.socso));

  // ── F — Jumlah elaun / perkuisit / pemberian / manfaat yang dikecualikan cukai ─────────────────────
  // da4fc817 — ITS OWN SECTION AT LAST. This figure was computed and printed as a muted informational row
  // INSIDE Part B, with a comment admitting "LHDN's EA reports exempt allowances in their own section".
  // It does, and this is it. The figure is unchanged; only where it prints has moved.
  // ⚠️ ONE LINE, NOT A HEADER PLUS A ROW, AND THE PAGE BUDGET IS WHY. test/ea-pdf.test.ts asserts the whole
  // EA renders on ONE page in all six locales, which is a real property of the published form and not a
  // preference — and it is what caught this section when it was first drawn as a heading with a row under
  // it. Section F carries exactly one figure, so the heading carries it, which is also how the official
  // form reads: a titled line with an amount against it.
  sectionTotalLine(t.sectionFExemptAllowances, rm(d.partB.exemptAllowances ?? 0));
  // EIS sits outside Section E for the reason given above, on the line beneath it.
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
