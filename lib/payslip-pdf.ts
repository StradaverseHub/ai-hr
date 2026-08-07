// ADR-0036 (#22) — render a payslip as a PDF with pdf-lib (pure JS, no WASM/native, so no Next bundler
// friction). A pure function over the payslipDetail / payslipForReview read + localized labels, so it is
// unit-testable and reused identically by every surface that links a PDF route.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 5c198931 REBUILT THE DOCUMENT. It was a HALF-PAGE A5 carrying the company name, the employee's name and
// staff number, four lumped earnings rows, the statutory deductions, net pay and three employer figures —
// no logo, no payment date, no identity or statutory numbers, no year-to-date, no bank details, no HRD
// Corp levy, and every amount written "RM" even for a company that is not paid in ringgit. It is now a
// full A4 official document (docs/mockups/5c198931-payslip-document.html).
//
// STILL pdf-lib, deliberately. A headless HTML-to-PDF path would drag Playwright out of devDependencies
// into the RUNTIME and change the deploy surface, for a layout pdf-lib draws fine.
//
// NOTHING HERE MAY CHANGE A FIGURE. Every amount printed is a figure the payslip already stored; this
// module lays them out and never computes one. The one place that could have drifted — printing named pay
// items INSTEAD of the lumped Allowances row — is guarded: the named lines are printed only when they add
// up to the stored allowance figure (see `earningsRowsOf`), so the rows on the page always sum to the
// total beside them.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

import { formatMoney } from './money';
import { payslipDisplayEarnings } from '../core/pay-display-category';
import { payslipEmployerBorne, type EmployerBorneKey } from '../core/payslip-employer-borne';

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** One named pay item as the run recorded it. `code` is the operator's pay-code; absent on nothing today,
 *  but optional so a line without one still prints its name. */
export type PayslipEarningLine = { code: string | null; name: string; amount: number };

/** Year-to-date totals for the payslip's own year. Summed by the CALLER from the same read that lists the
 *  employee's months (core/payroll-view.ts `sumPayslipYtd`), never recomputed here. */
export type PayslipYtdTotals = {
  gross: number;
  epf: number;
  socso: number;
  eis: number;
  pcb: number;
  net: number;
};

/** The company's uploaded logo, straight from `company_logo` (PNG or JPEG — SVG is refused at upload). */
export type PayslipPdfLogo = { bytes: Uint8Array; mimeType: string };

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

  // ─── 5c198931 additions. EVERY ONE IS OPTIONAL: a caller that has not been widened still compiles and
  // still gets a valid document, just without the block it did not supply. ───

  /** ISO-4217 code from the company. Absent ⇒ amounts print unlabelled rather than defaulting to "RM",
   *  which would be a claim about a currency we were not told. */
  currency?: string | null;
  /** The batch's payment date, already formatted by the caller. */
  payDate?: string | null;
  /** "Payroll payslip · Regular cycle" — the cycle half resolved from i18n by the caller. */
  cycleLabel?: string | null;
  identityNumber?: string | null;
  /** True when `identityNumber` is a PASSPORT (a non-Malaysian employee), so the label says so rather
   *  than calling a passport an NRIC. */
  identityIsPassport?: boolean;
  department?: string | null;
  position?: string | null;
  jobGrade?: string | null;
  /** Already resolved to a display label by the caller (the stored value is an enum). */
  employmentType?: string | null;
  epfNumber?: string | null;
  socsoNumber?: string | null;
  taxNumber?: string | null;
  /** Already resolved to a display label by the caller (the stored value is an enum). */
  paymentMethod?: string | null;
  bankName?: string | null;
  /** MASKED to the last four digits BY THE READ — the full number never reaches this module. */
  bankAccountMasked?: string | null;
  /** HRD Corp levy, employer-only. Stored on every payslip as `statutory.hrdf` (efece4ce) and left off
   *  the old document entirely. */
  hrdf?: number;
  /** The pay items behind the Allowances figure, by name. Empty for a run calculated before 862ed0ad
   *  stamped them — that detail was never written down and cannot be recovered. */
  earningLines?: PayslipEarningLine[];
  /** This run predates the per-item stamp, so the grouped rows are all there is. The document SAYS so —
   *  an itemless earnings box under a non-zero allowance reads as a defect. */
  detailNotRecorded?: boolean;
  ytd?: PayslipYtdTotals | null;
  /** The four-digit year the YTD column covers (from the payslip's own pay period). */
  ytdYear?: string | null;
  logo?: PayslipPdfLogo | null;
  /** 97a9b0ab — the statutory ruleset this payslip was calculated under, for the provenance footer. */
  rulesetVersion?: string | null;
};

/** Localized labels (resolved from `me.payslip` + `payroll.individualPayslip` in the routes). */
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
  // ─── 5c198931 — the labels the full document needs. REQUIRED, not optional: tsc is what keeps the two
  // PDF routes printing the same document rather than one of them quietly losing a block. ───
  documentSubtitle: string;
  paymentDate: string; // already interpolated with the date by the caller
  employmentInfo: string;
  department: string;
  position: string;
  grade: string;
  employmentType: string;
  daysWorked: string;
  currency: string;
  ic: string;
  passport: string;
  epfNumber: string;
  socsoNumber: string;
  taxNumber: string;
  totalEarnings: string;
  hrdf: string;
  employerContributionsNote: string;
  paymentInformation: string;
  paymentMethod: string;
  bankName: string;
  bankAccount: string;
  ytdHeading: string; // already interpolated with the year by the caller
  ytdItem: string;
  ytdCurrent: string;
  ytdToDate: string;
  detailNotRecorded: string;
  earningsContinued: string;
  /** Already interpolated with the ruleset version; '' when the payslip does not record one. */
  provenanceNote: string;
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
 *
 * 5c198931 — `extra` carries the fields that are pure passthrough (identity, employment info, bank, logo,
 * YTD): the routes read them, this function does not compute them. Only `earningLines` is derived, from
 * the payslip's OWN `statutory.componentLines` stamp.
 */
export function buildPayslipPdfData(
  p: {
    employee: string; employeeCode: string | null; company: string; companyReg: string | null;
    payPeriod: string; basic: unknown; allowance: unknown; overtime: unknown; bonus: unknown;
    gross: unknown; statutory: unknown; otherDeductions: unknown; totalDeductions: unknown;
    net: unknown; employerCost: unknown; daysWorked: unknown;
  },
  borneLabels: Record<EmployerBorneKey, string>,
  extra: Partial<Omit<PayslipPdfData, 'earningLines' | 'detailNotRecorded' | 'hrdf'>> = {},
): PayslipPdfData {
  const st = (p.statutory ?? {}) as Record<string, unknown>;
  const disp = payslipDisplayEarnings(p);
  const eb = payslipEmployerBorne(p.statutory);
  const componentLines = Array.isArray(st.componentLines) ? (st.componentLines as StoredComponentLine[]) : [];
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
    // efece4ce stored the HRD Corp levy on every payslip and showed it nowhere in the download.
    hrdf: n(st.hrdf),
    earningLines: allowanceLinesOf(componentLines, st.otConvert),
    detailNotRecorded: componentLines.length === 0,
    ...extra,
  };
}

/** The shape `statutory.componentLines` is stored in (core/payroll.ts `earningsOf`). */
type StoredComponentLine = {
  code?: string | null;
  name?: string | null;
  buckets?: { bucket?: string; amount?: unknown }[];
};

/**
 * The named pay items behind the ALLOWANCES figure.
 *
 * Re-shaped here rather than imported from `app/payroll/transaction-view/history-breakdown.ts`: that
 * module is the SCREEN's derivation and lives in the app layer, and `lib/` must not depend on `app/`.
 * Both read the same stored stamp, and neither computes an amount — a bucket's stored contributions are
 * copied across, nothing more.
 *
 * WHY `wage` + `reimburse` (and not `ot` / `bonus`): the kernel folds exactly those two buckets, plus a
 * converted OT excess, into the payslip's allowance column
 * (`allowance = allowanceApplied + reimburse + otConvert`, core/payroll.ts). Overtime and bonus keep
 * their own rows and their own stored totals.
 */
function allowanceLinesOf(lines: StoredComponentLine[], otConvert: unknown): PayslipEarningLine[] {
  const out: PayslipEarningLine[] = [];
  for (const l of lines) {
    const amount = round2(
      (l.buckets ?? [])
        .filter((b) => b.bucket === 'wage' || b.bucket === 'reimburse')
        .reduce((s, b) => s + n(b.amount), 0),
    );
    if (amount === 0) continue; // a line that contributed nothing to this figure is not a row about it
    out.push({ code: l.code ?? null, name: l.name ?? '', amount });
  }
  // f3148da1 Step 4 — the OT excess redirected to a pay item is paid through the allowance column, so it
  // is one of the lines that figure is made of. Omitting it would make the named rows fall short of the
  // total and silently drop the itemisation (the reconciliation guard below would catch it, but the
  // employee would lose a line they are entitled to see).
  const oc = (otConvert ?? null) as { code?: string | null; name?: string | null; amount?: unknown } | null;
  if (oc && n(oc.amount) > 0) out.push({ code: oc.code ?? null, name: oc.name ?? '', amount: round2(n(oc.amount)) });
  return out;
}

// ───────────────────────────────── layout constants ─────────────────────────────────

const A4_W = 595.28;
const A4_H = 841.89;
const M = 40;
const GAP = 18;
const CONTENT_W = A4_W - 2 * M;
const COL_W = (CONTENT_W - GAP) / 2;
const COL2_X = M + COL_W + GAP;

const INK = rgb(0.102, 0.102, 0.133);
const MUTED = rgb(0.388, 0.388, 0.435);
const RULE = rgb(0.851, 0.855, 0.902);
const HAIR = rgb(0.937, 0.941, 0.969);
const PRIMARY = rgb(0.31, 0.275, 0.898);
const EARN = rgb(0.059, 0.608, 0.557);
const DEDUCT = rgb(0.886, 0.337, 0.302);
const BAND = rgb(0.98, 0.984, 1);
const WHITE = rgb(1, 1, 1);

const ROW_H = 15;
const BOX_HEAD_H = 20;
const BOX_TOTAL_H = 21;
/** Rows one earnings/deductions box prints before the rest spills to a second page. Sized so the whole
 *  document — letterhead, employee panel, boxes, employer/net band, YTD and footer — still fits one A4;
 *  a taller budget overprints the footer, which is the failure this cap exists to prevent. */
const MAX_BOX_ROWS = 14;
/** …and a floor, so a payslip with four earnings lines still reads as a ruled form rather than two small
 *  boxes stranded at the top of an otherwise empty A4. Matches the attached reference design, whose
 *  earnings box is deliberately taller than its contents. */
const MIN_BOX_ROWS = 9;
/** Height the YTD table needs (caption + header + six rows). Below this it moves to the overflow page. */
const YTD_H = 118;
/** Height reserved at the foot of page 1 for the prorated / provenance / generated notes. */
const FOOTER_H = 46;

type Row = { label: string; sub?: string | null; amount?: number; text?: string; muted?: boolean };

// ───────────────────────────────── the renderer ─────────────────────────────────

export async function renderPayslipPdf(d: PayslipPdfData, t: PayslipPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.payPeriod}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Helvetica is WinAnsi (Latin-1) — guard non-Latin codepoints so a CJK/Tamil name never crashes the
  // render (phase 1; embedding a Unicode font is the deferred follow-up per ADR-0036).
  //
  // FOLD FIRST, THEN STRIP. The punctuation this product deliberately emits sits just outside Latin-1:
  // the bullet the bank-account mask is built from (`••••8901`, core/payroll-view.ts) and the typographic
  // dashes and quotes in the translated strings. Stripping those to '?' printed "????8901" where an
  // account number belongs — a masked number that reads as a rendering fault. Folding them to their
  // Latin-1 equivalents keeps the mask a mask.
  const safe = (s: string) =>
    (s ?? '')
      .replace(/[•∙]/g, '·') // bullet / operator dot → middle dot
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―]/g, '-')
      .replace(/…/g, '...')
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  // 5c198931 — the ISO code is a PREFIX via lib/money.ts, so a company paid in SGD stops being told its
  // payroll is in ringgit. An absent currency prints the bare number: unlabelled is honest, "RM" is a claim.
  const money = (v: unknown) => formatMoney(v, d.currency ?? null);

  const logo = await embedLogo(doc, d.logo);

  // ─── page-scoped drawing primitives ───
  const at = (page: PDFPage, s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const atR = (page: PDFPage, s: string, xr: number, y: number, size: number, f: PDFFont = font, color = INK) =>
    page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });
  /** Shorten to fit a column. Truncation is visible ("...") rather than silent overprinting into the
   *  neighbouring column, which is what an unbounded pay-item name would otherwise do. */
  const fit = (s: string, f: PDFFont, size: number, maxW: number) => {
    const v = safe(s ?? '');
    if (f.widthOfTextAtSize(v, size) <= maxW) return v;
    let cut = v;
    while (cut.length > 1 && f.widthOfTextAtSize(`${cut}...`, size) > maxW) cut = cut.slice(0, -1);
    return `${cut}...`;
  };

  /**
   * One bordered block: a header band, a fixed-height body of rows, and an optional total row. Fixed
   * height is what makes Earnings and Deductions line up as a pair even when one has three rows and the
   * other has ten (the mockup's shape).
   */
  const drawBox = (
    page: PDFPage,
    o: {
      x: number; y: number; w: number; bodyRows: number; title: string; rows: Row[];
      dot?: 'earn' | 'deduct'; total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
      note?: string;
    },
  ) => {
    const bodyH = o.bodyRows * ROW_H;
    const totalH = o.total ? BOX_TOTAL_H : 0;
    const noteH = o.note ? 14 : 0;
    const h = BOX_HEAD_H + bodyH + totalH + noteH;
    const top = o.y;
    page.drawRectangle({ x: o.x, y: top - h, width: o.w, height: h, borderColor: RULE, borderWidth: 0.8 });
    // header band
    page.drawRectangle({ x: o.x, y: top - BOX_HEAD_H, width: o.w, height: BOX_HEAD_H, color: BAND });
    page.drawLine({
      start: { x: o.x, y: top - BOX_HEAD_H }, end: { x: o.x + o.w, y: top - BOX_HEAD_H },
      thickness: 0.8, color: RULE,
    });
    let tx = o.x + 10;
    if (o.dot) {
      page.drawCircle({ x: tx + 3.5, y: top - BOX_HEAD_H / 2, size: 3.5, color: o.dot === 'earn' ? EARN : DEDUCT });
      tx += 12;
    }
    at(page, o.title.toUpperCase(), tx, top - 13.5, 7.5, bold, INK);

    let ry = top - BOX_HEAD_H;
    for (const r of o.rows) {
      const baseline = ry - 10.5;
      const color = r.muted ? MUTED : INK;
      const label = r.sub ? `${r.label} · ${r.sub}` : r.label;
      const value = r.text ?? money(r.amount);
      // The label gets whatever the amount leaves. Measured per row rather than fixed, so a long pay-item
      // name is only shortened when the figure beside it genuinely needs the space.
      const labelW = o.w - 28 - font.widthOfTextAtSize(safe(value), 8.5);
      at(page, fit(label, font, 8.5, labelW), o.x + 10, baseline, 8.5, font, color);
      atR(page, value, o.x + o.w - 10, baseline, 8.5, font, color);
      ry -= ROW_H;
      page.drawLine({ start: { x: o.x + 6, y: ry }, end: { x: o.x + o.w - 6, y: ry }, thickness: 0.5, color: HAIR });
    }

    let by = top - BOX_HEAD_H - bodyH;
    if (o.total) {
      page.drawRectangle({ x: o.x, y: by - BOX_TOTAL_H, width: o.w, height: BOX_TOTAL_H, color: BAND });
      page.drawLine({ start: { x: o.x, y: by }, end: { x: o.x + o.w, y: by }, thickness: 0.8, color: RULE });
      at(page, o.total.label.toUpperCase(), o.x + 10, by - 14, 8, bold, INK);
      atR(page, o.total.value, o.x + o.w - 10, by - 14, 9.5, bold, o.total.color ?? INK);
      by -= BOX_TOTAL_H;
    }
    if (o.note) at(page, fit(o.note, font, 7, o.w - 20), o.x + 10, by - 10, 7, font, MUTED);
    return h;
  };

  // ─── the rows this payslip prints ───
  const earnRows = earningsRowsOf(d, t);
  const dedRows: Row[] = [
    { label: t.epf, amount: d.epfEmployee },
    { label: t.socso, amount: d.socsoEmployee },
    ...(d.socsoSkbbk > 0 ? [{ label: t.skbbk, amount: d.socsoSkbbk }] : []),
    { label: t.eis, amount: d.eisEmployee },
    { label: t.pcb, amount: d.pcb },
    ...(d.cp38 > 0 ? [{ label: t.cp38, amount: d.cp38 }] : []),
    ...(d.otherDeductions > 0 ? [{ label: t.otherDeductions, amount: d.otherDeductions }] : []),
  ];

  // The earnings box takes a VARIABLE number of named lines. Cap it and spill the rest onto a second page
  // rather than overprinting the footer — the one part of this layout that needs real care.
  const bodyRows = Math.min(MAX_BOX_ROWS, Math.max(MIN_BOX_ROWS, earnRows.length, dedRows.length));
  const spills = earnRows.length > bodyRows;
  const shownEarn = spills ? earnRows.slice(0, bodyRows - 1) : earnRows;
  const spilledEarn = spills ? earnRows.slice(bodyRows - 1) : [];
  if (spills) shownEarn.push({ label: t.earningsContinued, text: `+${spilledEarn.length}`, muted: true });

  // ─── page 1 ───
  const page = doc.addPage([A4_W, A4_H]);
  let y = A4_H - M;

  y = drawLetterhead(page, y);
  y = drawEmployeePanel(page, y);

  // Earnings / Deductions, side by side and equal height.
  const boxH = drawBox(page, {
    x: M, y, w: COL_W, bodyRows, title: t.earnings, rows: shownEarn, dot: 'earn',
    total: { label: t.totalEarnings, value: money(d.gross), color: EARN },
    note: d.detailNotRecorded ? t.detailNotRecorded : undefined,
  });
  drawBox(page, {
    x: COL2_X, y, w: COL_W, bodyRows, title: t.deductions, rows: dedRows, dot: 'deduct',
    total: { label: t.totalDeductions, value: money(d.totalDeductions), color: DEDUCT },
  });
  y -= boxH + GAP;

  // Employer contributions (left) beside the net-pay banner + payment information (right).
  const employerRows: Row[] = [
    { label: t.epf, amount: d.epfEmployer },
    { label: t.socso, amount: d.socsoEmployer },
    { label: t.eis, amount: d.eisEmployer },
    ...(d.hrdf != null ? [{ label: t.hrdf, amount: d.hrdf }] : []),
  ];
  const employerH = drawBox(page, {
    x: M, y, w: COL_W, bodyRows: employerRows.length, title: t.employerContributions, rows: employerRows,
    total: { label: t.totalEmployerCost, value: money(d.employerCost) },
    note: t.employerContributionsNote,
  });

  // Net pay — the one figure the employee looks for first, so it gets the strongest mark on the page.
  const netH = 46;
  page.drawRectangle({ x: COL2_X, y: y - netH, width: COL_W, height: netH, color: PRIMARY });
  at(page, t.netPay.toUpperCase(), COL2_X + 14, y - 28, 9.5, bold, WHITE);
  atR(page, money(d.net), COL2_X + COL_W - 14, y - 30, 15, bold, WHITE);
  let rightY = y - netH - 12;

  const payRows: Row[] = [
    ...(d.paymentMethod ? [{ label: t.paymentMethod, text: d.paymentMethod }] : []),
    ...(d.bankName ? [{ label: t.bankName, text: d.bankName }] : []),
    ...(d.bankAccountMasked ? [{ label: t.bankAccount, text: d.bankAccountMasked }] : []),
  ];
  // Printed only when there is something to print. A row of empty labels tells the employee nothing and
  // reads as a broken document; a missing block reads as "not recorded", which is the truth.
  if (payRows.length > 0) {
    rightY -= drawBox(page, {
      x: COL2_X, y: rightY, w: COL_W, bodyRows: payRows.length, title: t.paymentInformation, rows: payRows,
    });
  }

  // The section ends at whichever COLUMN reaches lower — the employer box on the left, or the net banner
  // plus payment information on the right.
  y = Math.min(y - employerH, rightY) - GAP;

  // ─── employer-borne disclosure (3c473773) ───
  if (d.employerBorne.length > 0) {
    const borneRows: Row[] = d.employerBorne.map((l) => ({ label: l.label, amount: l.amount }));
    y -= drawBox(page, {
      x: M, y, w: CONTENT_W, bodyRows: borneRows.length, title: t.employerBorne, rows: borneRows,
      total: { label: t.employerBorneTotal, value: money(d.employerBorneTotal) },
      note: t.employerBorneNote,
    }) + GAP;
  }

  // ─── year to date ───
  const ytdFitsOnPage1 = y - YTD_H > M + FOOTER_H;
  if (d.ytd && ytdFitsOnPage1) y -= drawYtd(page, y) + GAP;

  drawFooter(page);

  // ─── page 2, only when something did not fit ───
  if (spilledEarn.length > 0 || (d.ytd && !ytdFitsOnPage1)) {
    const p2 = doc.addPage([A4_W, A4_H]);
    let y2 = A4_H - M;
    at(p2, d.company, M, y2 - 12, 12, bold);
    atR(p2, `${t.title} · ${d.payPeriod}`, A4_W - M, y2 - 11, 9, font, MUTED);
    y2 -= 20;
    p2.drawLine({ start: { x: M, y: y2 }, end: { x: A4_W - M, y: y2 }, thickness: 1.2, color: RULE });
    y2 -= GAP;
    if (spilledEarn.length > 0) {
      y2 -= drawBox(p2, {
        x: M, y: y2, w: CONTENT_W, bodyRows: spilledEarn.length, title: t.earningsContinued, rows: spilledEarn,
        dot: 'earn',
      }) + GAP;
    }
    if (d.ytd && !ytdFitsOnPage1) y2 -= drawYtd(p2, y2) + GAP;
    drawFooter(p2);
  }

  return doc.save();

  // ─── section painters (closures over page/font/label state, kept out of the flow above) ───

  function drawLetterhead(pg: PDFPage, top: number): number {
    let textX = M;
    if (logo) {
      // Cap the drawn height and preserve the aspect ratio: an uploaded logo is any size at all, and a
      // stretched company mark on a payroll document is worse than none.
      const h = Math.min(54, logo.height);
      const w = (logo.width / logo.height) * h;
      const drawW = Math.min(w, 120);
      const drawH = (logo.height / logo.width) * drawW;
      pg.drawImage(logo, { x: M, y: top - drawH, width: drawW, height: drawH });
      textX = M + drawW + 14;
    }
    at(pg, fit(d.company, bold, 16, A4_W - M - textX - 150), textX, top - 16, 16, bold);
    const sub = [t.documentSubtitle, d.cycleLabel].filter(Boolean).join(' · ');
    at(pg, sub, textX, top - 29, 9, font, MUTED);
    if (d.companyReg) at(pg, d.companyReg, textX, top - 41, 8, font, MUTED);
    atR(pg, d.payPeriod, A4_W - M, top - 16, 13, bold);
    if (d.payDate) atR(pg, t.paymentDate, A4_W - M, top - 29, 8.5, font, MUTED);
    const h = Math.max(logo ? 58 : 0, d.companyReg ? 46 : 34);
    pg.drawLine({ start: { x: M, y: top - h }, end: { x: A4_W - M, y: top - h }, thickness: 1.6, color: RULE });
    return top - h - GAP;
  }

  function drawEmployeePanel(pg: PDFPage, top: number): number {
    const leftW = 218;
    const rightX = M + leftW + GAP;
    const rightW = CONTENT_W - leftW - GAP;

    at(pg, fit(d.employee, bold, 14, leftW), M, top - 14, 14, bold);
    if (d.employeeCode) at(pg, `${t.employeeCode}: ${d.employeeCode}`, M, top - 27, 9, font, MUTED);

    const idCells: [string, string][] = [
      ...(d.identityNumber ? ([[d.identityIsPassport ? t.passport : t.ic, d.identityNumber]] as [string, string][]) : []),
      ...(d.taxNumber ? ([[t.taxNumber, d.taxNumber]] as [string, string][]) : []),
      ...(d.epfNumber ? ([[t.epfNumber, d.epfNumber]] as [string, string][]) : []),
      ...(d.socsoNumber ? ([[t.socsoNumber, d.socsoNumber]] as [string, string][]) : []),
    ];
    const leftH = 34 + drawGrid(pg, idCells, M, top - 34, leftW, 2);

    const infoCells: [string, string][] = [
      ...(d.department ? ([[t.department, d.department]] as [string, string][]) : []),
      ...(d.position ? ([[t.position, d.position]] as [string, string][]) : []),
      ...(d.jobGrade ? ([[t.grade, d.jobGrade]] as [string, string][]) : []),
      ...(d.employmentType ? ([[t.employmentType, d.employmentType]] as [string, string][]) : []),
      ...(d.daysWorked != null ? ([[t.daysWorked, d.daysWorked.toFixed(2)]] as [string, string][]) : []),
      ...(d.currency ? ([[t.currency, d.currency]] as [string, string][]) : []),
    ];
    let rightH = 0;
    if (infoCells.length > 0) {
      const pillW = bold.widthOfTextAtSize(safe(t.employmentInfo.toUpperCase()), 7.5) + 20;
      pg.drawRectangle({ x: rightX, y: top - 17, width: pillW, height: 17, color: PRIMARY });
      at(pg, t.employmentInfo.toUpperCase(), rightX + 10, top - 12.5, 7.5, bold, WHITE);
      rightH = 25 + drawGrid(pg, infoCells, rightX, top - 25, rightW, 3);
    }

    const h = Math.max(leftH, rightH, 40);
    pg.drawLine({ start: { x: M, y: top - h - 8 }, end: { x: A4_W - M, y: top - h - 8 }, thickness: 0.8, color: RULE });
    return top - h - 8 - GAP;
  }

  /** A label-over-value grid. Returns the height consumed, so the caller can align the panel beside it. */
  function drawGrid(pg: PDFPage, cells: [string, string][], x: number, top: number, w: number, cols: number): number {
    if (cells.length === 0) return 0;
    const cw = w / cols;
    const rowH = 25;
    cells.forEach(([k, v], i) => {
      const cx = x + (i % cols) * cw;
      const cy = top - Math.floor(i / cols) * rowH;
      at(pg, fit(k.toUpperCase(), font, 6.5, cw - 6), cx, cy - 7, 6.5, font, MUTED);
      at(pg, fit(v, bold, 8.5, cw - 6), cx, cy - 18, 8.5, bold);
    });
    return Math.ceil(cells.length / cols) * rowH;
  }

  function drawYtd(pg: PDFPage, top: number): number {
    const rows: [string, number, number][] = [
      [t.grossPay, d.gross, d.ytd!.gross],
      [t.epf, d.epfEmployee, d.ytd!.epf],
      [t.socso, d.socsoEmployee, d.ytd!.socso],
      [t.eis, d.eisEmployee, d.ytd!.eis],
      [t.pcb, d.pcb, d.ytd!.pcb],
      [t.netPay, d.net, d.ytd!.net],
    ];
    const c2 = M + CONTENT_W * 0.62;
    const c3 = A4_W - M;
    at(pg, t.ytdHeading.toUpperCase(), M, top - 9, 7.5, bold, MUTED);
    let ry = top - 20;
    at(pg, t.ytdItem.toUpperCase(), M, ry - 8, 6.5, font, MUTED);
    atR(pg, t.ytdCurrent.toUpperCase(), c2, ry - 8, 6.5, font, MUTED);
    atR(pg, t.ytdToDate.toUpperCase(), c3, ry - 8, 6.5, font, MUTED);
    ry -= 14;
    pg.drawLine({ start: { x: M, y: ry }, end: { x: c3, y: ry }, thickness: 0.8, color: RULE });
    rows.forEach(([label, cur, tot], i) => {
      const last = i === rows.length - 1;
      const f = last ? bold : font;
      at(pg, label, M, ry - 11, 8.5, f);
      atR(pg, money(cur), c2, ry - 11, 8.5, f);
      atR(pg, money(tot), c3, ry - 11, 8.5, f);
      ry -= 15;
      if (!last) pg.drawLine({ start: { x: M, y: ry }, end: { x: c3, y: ry }, thickness: 0.5, color: HAIR });
    });
    return top - ry;
  }

  function drawFooter(pg: PDFPage) {
    const lines = [
      [d.daysWorked != null ? t.proratedNote : '', t.provenanceNote].filter(Boolean).join(' · '),
      t.generatedNote,
    ].filter(Boolean);
    let fy = M + 8 + (lines.length - 1) * 11;
    pg.drawLine({ start: { x: M, y: fy + 14 }, end: { x: A4_W - M, y: fy + 14 }, thickness: 0.8, color: RULE });
    for (const line of lines) {
      const w = font.widthOfTextAtSize(safe(line), 7.5);
      at(pg, line, M + (CONTENT_W - w) / 2, fy, 7.5, font, MUTED);
      fy -= 11;
    }
  }
}

/**
 * The earnings rows, and the ONE guard that keeps this document honest.
 *
 * The board item asked for each pay item by name instead of a single lumped "Allowances". The named lines
 * come from the payslip's own stamp, but a payslip whose display categories moved money between boxes
 * (3c473773 `displayEarnings`) has an allowance FIGURE that no longer equals the sum of its wage/reimburse
 * lines. Printing the lines there would put rows on the page that do not add up to the total beside them —
 * on a document that carries money. So the named lines replace the lumped row only when they reconcile to
 * the stored figure; otherwise the grouped row stands, exactly as it did before this redesign.
 */
function earningsRowsOf(d: PayslipPdfData, t: PayslipPdfLabels): Row[] {
  const rows: Row[] = [{ label: t.basicSalary, amount: d.basic }];
  const named = d.earningLines ?? [];
  const reconciles =
    named.length > 0 && Math.abs(round2(named.reduce((s, l) => s + l.amount, 0)) - round2(d.allowance)) < 0.005;
  if (reconciles) for (const l of named) rows.push({ label: l.name, sub: l.code, amount: l.amount });
  else rows.push({ label: t.allowances, amount: d.allowance });
  rows.push({ label: t.overtime, amount: d.overtime });
  rows.push({ label: t.bonus, amount: d.bonus });
  if (d.claim > 0) rows.push({ label: t.claim, amount: d.claim });
  return rows;
}

/**
 * Embed the company's uploaded logo. PNG and JPEG only — that is what the Organization upload accepts
 * (SVG is refused there), and pdf-lib embeds nothing else.
 *
 * A corrupt or truncated upload must NOT cost the employee their payslip, so a failed embed degrades to
 * the text letterhead rather than throwing out of the route.
 */
async function embedLogo(doc: PDFDocument, logo: PayslipPdfLogo | null | undefined): Promise<PDFImage | null> {
  if (!logo?.bytes || logo.bytes.length === 0) return null;
  try {
    if (/png/i.test(logo.mimeType)) {
      return pngIsWellFormed(logo.bytes) ? await doc.embedPng(logo.bytes) : null;
    }
    return await doc.embedJpg(logo.bytes); // embedJpg refuses a malformed file cleanly; embedPng does not
  } catch {
    return null;
  }
}

/**
 * Is this PNG structurally sound enough to hand to pdf-lib?
 *
 * WHY THIS EXISTS, AND WHY THE CHEAP TRY/CATCH ABOVE IS NOT ENOUGH. `embedPng` does not throw on a PNG
 * whose 8-byte signature is intact but whose chunk data is not — it SPINS, synchronously and forever.
 * Measured: a corrupt-body PNG never returned and never threw, so no catch and no timer can recover the
 * request. `embedJpg` on the same class of input throws "SOI not found" immediately, which is why only
 * the PNG path is gated.
 *
 * That input is REACHABLE. `core/admin.ts assertValidLogo` accepts an upload on its magic bytes and its
 * size, so a truncated or half-uploaded PNG is stored happily. On the Organization screen the cost is a
 * broken-image icon; here it would be every payslip download for that company hanging its request — a
 * regression this document's own change introduces, so it is closed here.
 *
 * The check is a chunk walk with CRC32 verification, which is exactly what detects truncation and
 * corruption. A file that fails it prints the text letterhead, like a company with no logo at all.
 */
function pngIsWellFormed(b: Uint8Array): boolean {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 + 12) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let off = 8;
  let sawIhdr = false;
  let sawIdat = false;
  while (off + 12 <= b.length) {
    const len = u32(off);
    const end = off + 12 + len;
    if (len > b.length || end > b.length) return false;
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (crc32(b.subarray(off + 4, off + 8 + len)) !== u32(off + 8 + len)) return false;
    if (!sawIhdr && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      // width/height must be non-zero and sane; a 0×0 or absurd header is what the decoder loops on.
      if (len !== 13) return false;
      const w = u32(off + 8);
      const h = u32(off + 12);
      if (w === 0 || h === 0 || w > 20000 || h > 20000) return false;
      sawIhdr = true;
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'IEND') {
      return sawIhdr && sawIdat; // a complete file: header, pixels, terminator, every CRC verified
    }
    off = end;
  }
  return false; // ran out of bytes before IEND ⇒ truncated
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
