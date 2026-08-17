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
import { absenceDaysLabel, payslipAbsenceLines, type PayslipAbsenceLines } from '../core/payslip-absence-lines';
import { payslipEmployerBorne, type EmployerBorneKey } from '../core/payslip-employer-borne';
// 6b134681 / 417d4937 — the ONE derivation of "which named pay items explain this figure, and how is a
// line labelled". Shared with the ESS payslip screen and Transaction View → History so the printed
// document cannot itemise a total differently from the screen it was printed from.
import {
  payItemLinesForBuckets,
  payItemLinesReconcile,
  storedComponentLines,
  type StoredComponentLine,
} from '../core/payslip-earning-lines';

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
  /** e2632276 — this payslip's OWN record of the two halves of `otherDeductions`, with their day counts.
   *  Absent (`any:false`) on every payslip issued before it shipped ⇒ the single lumped row is printed
   *  exactly as before. */
  absence: PayslipAbsenceLines;
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
  /**
   * The employee's bank account, IN FULL (f35f758a).
   *
   * It used to be `bankAccountMasked`, and both reads that feed this module masked it to the last four
   * digits before it ever got here. The approved plan overturned that: a pay statement that says the money
   * went to "••••8901" does not say which account was paid. The reads now return both forms
   * (core/payroll-view.ts `payslipForReview`, core/payroll.ts `payslipDetail`); the SCREENS keep the masked
   * one, this document takes the whole number, and the exposure that creates is written down at
   * `PayslipReviewRow.bankAccountFull` rather than left to be discovered.
   *
   * The field was RENAMED rather than repurposed on purpose: a `bankAccountMasked` holding an unmasked
   * number is a lie every future reader would believe.
   */
  bankAccount?: string | null;
  /** HRD Corp levy, employer-only. Stored on every payslip as `statutory.hrdf` (efece4ce) and left off
   *  the old document entirely. */
  hrdf?: number;
  /** The pay items behind the Allowances figure, by name. Empty for a run calculated before 862ed0ad
   *  stamped them — that detail was never written down and cannot be recovered. */
  earningLines?: PayslipEarningLine[];
  /**
   * 6b134681 — the pay items behind the BONUS and OVERTIME figures, by name.
   *
   * The reporter keyed a one-off "B0001 — ANGPOW RM500", and the document printed "Bonus RM500.00":
   * because ANGPOW is additional remuneration for EPF/PCB it lands in the bonus bucket, and the bonus
   * bucket was the one earnings figure that was never itemised. The amounts are unchanged — this is the
   * same stored stamp the allowance rows already come from, read for two more buckets.
   *
   * SEPARATE FIELDS, not a widened `earningLines`: each list reconciles against ITS OWN stored total
   * (`bonus`, `overtime`), and merging them would let a bonus line be printed under Allowances the
   * moment one of the three figures failed to reconcile.
   */
  bonusLines?: PayslipEarningLine[];
  overtimeLines?: PayslipEarningLine[];
  /** This run predates the per-item stamp, so the grouped rows are all there is. The document SAYS so —
   *  an itemless earnings box under a non-zero allowance reads as a defect. */
  detailNotRecorded?: boolean;
  /**
   * f35f758a — the pay items this run CALCULATED BUT DID NOT PAY (benefits in kind, ADR-0025 §5).
   *
   * Derived in `buildPayslipPdfData` from `statutory.recordLines`, and ONLY from lines the KERNEL stamped
   * `nonPayable: true` at run time (core/payroll.ts `PayslipRecordLine`). Never re-derived from today's
   * `pay_component` flags: that would answer with today's configuration about a month already paid.
   *
   * EMPTY ON EVERY PAYSLIP THAT EXISTS TODAY, for two independent reasons — no payslip written before this
   * shipped carries the stamp, and the production catalogue has zero non-payable rows (verified
   * 2026-08-10). Empty ⇒ the box is not drawn ⇒ the document is unchanged. The mixed, unstamped list that
   * historical payslips carry stays ONE list on the screens that print it; it cannot be split after the
   * fact, and this document never tries.
   */
  nonPayableLines?: PayslipEarningLine[];
  ytd?: PayslipYtdTotals | null;
  /** The four-digit year the YTD column covers (from the payslip's own pay period). */
  ytdYear?: string | null;
  logo?: PayslipPdfLogo | null;
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
  // e2632276 — the two NAMED absence lines. `daysUnit` is the bare word ("days" / "hari" / ...) appended
  // to the count as a `sub`; it is composed rather than an ICU plural so no locale can throw for a missing
  // argument on a document that is generated, not rendered.
  unpaidLeaveLine: string;
  absentLine: string;
  dayUnit: string;
  daysUnit: string;
  totalDeductions: string;
  netPay: string;
  employerContributions: string;
  totalEmployerCost: string;
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
  /**
   * f35f758a — the pay period as a MONTH NAME: "August 2026", not the stored "2026-08". Resolved by the
   * caller (lib/payslip-pdf-strings.ts) and REQUIRED, so tsc keeps both PDF routes printing the same
   * heading. Deliberately English on the document whatever the reader's locale: the embedded font is
   * Latin-1, and `safe()` below would fold a Chinese, Thai or Tamil month name to question marks. The
   * SCREENS show the month in the reader's own language; the file cannot yet.
   */
  periodLabel: string;
  // ─── f35f758a — the Non-payable box. REQUIRED for the same reason every 5c198931 label is: tsc is what
  // stops one of the two PDF routes quietly printing a block the other one does not. ───
  /** Heading of the box listing items that were calculated but never paid (benefits in kind). */
  nonPayable: string;
  /** Caption on that box's own total row. */
  nonPayableTotal: string;
  /** One line under it saying, in the employee's own words, that none of this reached their pay. */
  nonPayableNote: string;
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
  extra: Partial<
    Omit<PayslipPdfData, 'earningLines' | 'bonusLines' | 'overtimeLines' | 'detailNotRecorded' | 'hrdf'>
  > = {},
): PayslipPdfData {
  const st = (p.statutory ?? {}) as Record<string, unknown>;
  const disp = payslipDisplayEarnings(p);
  const eb = payslipEmployerBorne(p.statutory);
  const componentLines = storedComponentLines(p.statutory);
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
    absence: payslipAbsenceLines(p.statutory, p.otherDeductions),
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
    // 6b134681 — the same stamp, read for the two buckets that kept their own totals. `earningsRowsOf`
    // decides whether they may replace the grouped row; deriving them here keeps every "which lines
    // explain which figure" answer in one function.
    bonusLines: payItemLinesForBuckets(componentLines, ['bonus']),
    overtimeLines: payItemLinesForBuckets(componentLines, ['ot']),
    detailNotRecorded: componentLines.length === 0,
    nonPayableLines: nonPayableLinesOf(st.recordLines),
    ...extra,
  };
}

/** One stored `statutory.recordLines` entry, read structurally (core/payroll.ts `PayslipRecordLine`).
 *  Imported by SHAPE rather than by type, for the same reason `StoredComponentLine` is: `lib/` pulling in
 *  the payroll kernel to borrow a four-field record would drag the whole module into every PDF request. */
type StoredRecordLine = { code?: string | null; name?: string | null; amount?: unknown; nonPayable?: boolean };

/**
 * The record lines the RUN stamped as non-payable — and nothing else.
 *
 * `statutory.recordLines` is a MIXED array (f1564110 phase 3): record-only benefits in kind sit beside
 * named provenance for one-off transactions that were genuinely paid. The ONLY safe discriminator is the
 * one the kernel wrote at run time, so this filters on `nonPayable === true` and treats every other value —
 * false, and the `undefined` that every pre-f35f758a payslip carries — as "not a non-payable line".
 *
 * That means a historical payslip yields an EMPTY list and prints no Non-payable box, which is correct:
 * those slips were never told which of their items were non-payable, and matching the code back to today's
 * `pay_component` catalogue would print today's answer against last month's pay. Verified on production
 * 2026-08-10: payslip 945d16e9 carries COMMISSION 300, HANDPHONE ALLOWANCE 400 and SHORT NOTICE −500, all
 * PAID. Printing those three under "Non-payable" would tell that employee their commission never arrived.
 */
function nonPayableLinesOf(raw: unknown): PayslipEarningLine[] {
  if (!Array.isArray(raw)) return [];
  return (raw as StoredRecordLine[])
    .filter((l) => l?.nonPayable === true)
    .map((l) => ({ code: l.code ?? null, name: l.name ?? '', amount: round2(n(l.amount)) }));
}

/**
 * The named pay items behind the ALLOWANCES figure.
 *
 * The bucket→lines derivation now lives in `core/payslip-earning-lines.ts` rather than here, because
 * three surfaces answer the same question and were free to answer it differently (6b134681/417d4937).
 * `lib/` still must not depend on `app/`, and does not: the shared module is dependency-free core.
 * Nothing computes an amount — a bucket's stored contributions are copied across, nothing more.
 *
 * WHY `wage` + `reimburse` (and not `ot` / `bonus`): the kernel folds exactly those two buckets, plus a
 * converted OT excess, into the payslip's allowance column
 * (`allowance = allowanceApplied + reimburse + otConvert`, core/payroll.ts). Overtime and bonus keep
 * their own rows and their own stored totals — and, from 6b134681, their own named lines.
 *
 * 417d4937 — `reimburse` was ALREADY in this filter and stays: a PCB-exempt allowance (Meal Allowance,
 * exemption PCB_NON-TAXABLE) is paid, is inside the allowance column, and is itemised here. The
 * reporter's "missing" Meal Allowance was a NAMING fault, never an omission.
 */
function allowanceLinesOf(lines: StoredComponentLine[], otConvert: unknown): PayslipEarningLine[] {
  const out: PayslipEarningLine[] = payItemLinesForBuckets(lines, ['wage', 'reimburse']);
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
/** Leading between the wrapped lines of ONE row's label. A row whose label fits on a single line is
 *  exactly ROW_H tall, so a payslip with short descriptions is laid out exactly as it was before
 *  wrapping existed — only a description that used to be CUT changes anything. */
const LINE_H = 10.5;
const BOX_HEAD_H = 20;
const BOX_TOTAL_H = 21;
/** Height the YTD table needs (caption + column header + six rows). */
const YTD_H = 124;
/** Height reserved at the foot of EVERY page for the one "system-generated" line. f35f758a took the
 *  prorated and provenance sentences off the document, which is why this is 24 and not 46. */
const FOOTER_H = 24;

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
  /**
   * Break a string across a column, measured against the REAL font.
   *
   * f35f758a — THE DEFECT THIS DOCUMENT WAS RAISED FOR. There used to be a `fit()` beside this that
   * hard-clipped anything too wide and appended an ellipsis, and it was applied to pay item names, job
   * titles, departments, the employee's name and the company's. A payslip that names a pay item only
   * halfway ("HANDPHONE AND COMMUNICATION AL…") does not say what the employee was paid for, so `fit()`
   * is gone and every one of those call sites wraps through here instead. Nothing on this document ends
   * in dots.
   *
   * A SINGLE TOKEN wider than the column is broken by CHARACTER. Greedy word wrapping alone would emit it
   * as one over-wide line that overprints the amount beside it — visually the same failure as clipping,
   * only silent.
   */
  const wrap = (s: string, f: PDFFont, size: number, maxW: number): string[] => {
    const lines: string[] = [];
    /** Emit whole-column slices of an over-long word; returns the remainder that still fits. */
    const chop = (w: string) => {
      let rest = w;
      while (rest.length > 1 && f.widthOfTextAtSize(rest, size) > maxW) {
        let cut = rest.length;
        while (cut > 1 && f.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      return rest;
    };
    let line = '';
    for (const w of safe(s).split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${w}` : w;
      if (line && f.widthOfTextAtSize(trial, size) > maxW) {
        lines.push(line);
        line = chop(w);
      } else if (!line && f.widthOfTextAtSize(w, size) > maxW) {
        line = chop(w);
      } else line = trial;
    }
    if (line) lines.push(line);
    return lines;
  };

  /** One row of a box, already wrapped and MEASURED — the height it will occupy is known before anything
   *  is drawn, which is what lets the page flow below decide where a block breaks. */
  type BoxRowPlan = { lines: string[]; value: string; muted?: boolean; h: number };
  /** A whole box, measured. `paintBox` draws exactly what `planBox` measured. */
  type BoxPlan = {
    w: number;
    title: string;
    dot?: 'earn' | 'deduct';
    rows: BoxRowPlan[];
    total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
    noteLines: string[];
  };

  const planRow = (r: Row, w: number): BoxRowPlan => {
    const value = r.text ?? money(r.amount);
    const label = r.sub ? `${r.label} · ${r.sub}` : r.label;
    // The label gets whatever the amount leaves, measured per row. The floor keeps a pathologically wide
    // amount from collapsing the label column to nothing and wrapping it one letter per line.
    const labelW = Math.max(60, w - 28 - font.widthOfTextAtSize(safe(value), 8.5));
    const lines = wrap(label, font, 8.5, labelW);
    return { lines, value, muted: r.muted, h: Math.max(ROW_H, 4.5 + lines.length * LINE_H) };
  };

  const noteHeightOf = (noteLines: string[]) => (noteLines.length > 0 ? noteLines.length * 9 + 7 : 0);
  const boxHeight = (p: BoxPlan) =>
    BOX_HEAD_H +
    p.rows.reduce((s, r) => s + r.h, 0) +
    (p.total ? BOX_TOTAL_H : 0) +
    noteHeightOf(p.noteLines);

  const planBox = (o: {
    w: number; title: string; rows: Row[];
    dot?: 'earn' | 'deduct'; total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
    note?: string;
  }): BoxPlan => ({
    w: o.w,
    title: o.title,
    dot: o.dot,
    total: o.total,
    rows: o.rows.map((r) => planRow(r, o.w)),
    noteLines: o.note ? wrap(o.note, font, 7, o.w - 20) : [],
  });

  /**
   * One bordered block: a header band, a body of rows and an optional total row. The body is sized to WHAT
   * IT HOLDS. It used to be padded to a fixed row count (MIN_BOX_ROWS / MAX_BOX_ROWS) so Earnings and
   * Deductions lined up as a pair, which is what left half of the earnings box empty while a long name
   * beside it ran out of room. Earnings and Deductions are a pair again (f35f758a rev 2), but they are
   * aligned by `flowPair` drawing both at the same y — never by padding a box past its own contents.
   */
  const paintBox = (pg: PDFPage, x: number, top: number, p: BoxPlan): number => {
    const bodyH = p.rows.reduce((s, r) => s + r.h, 0);
    const h = boxHeight(p);
    pg.drawRectangle({ x, y: top - h, width: p.w, height: h, borderColor: RULE, borderWidth: 0.8 });
    // header band
    pg.drawRectangle({ x, y: top - BOX_HEAD_H, width: p.w, height: BOX_HEAD_H, color: BAND });
    pg.drawLine({
      start: { x, y: top - BOX_HEAD_H }, end: { x: x + p.w, y: top - BOX_HEAD_H },
      thickness: 0.8, color: RULE,
    });
    let tx = x + 10;
    if (p.dot) {
      pg.drawCircle({ x: tx + 3.5, y: top - BOX_HEAD_H / 2, size: 3.5, color: p.dot === 'earn' ? EARN : DEDUCT });
      tx += 12;
    }
    at(pg, p.title.toUpperCase(), tx, top - 13.5, 7.5, bold, INK);

    let ry = top - BOX_HEAD_H;
    for (const r of p.rows) {
      const color = r.muted ? MUTED : INK;
      // The amount sits on the row's FIRST baseline whatever the label does below it, so a column of
      // figures still reads as a column when one description above it took two lines.
      r.lines.forEach((line, i) => at(pg, line, x + 10, ry - 10.5 - i * LINE_H, 8.5, font, color));
      atR(pg, r.value, x + p.w - 10, ry - 10.5, 8.5, font, color);
      ry -= r.h;
      pg.drawLine({ start: { x: x + 6, y: ry }, end: { x: x + p.w - 6, y: ry }, thickness: 0.5, color: HAIR });
    }

    let by = top - BOX_HEAD_H - bodyH;
    if (p.total) {
      pg.drawRectangle({ x, y: by - BOX_TOTAL_H, width: p.w, height: BOX_TOTAL_H, color: BAND });
      pg.drawLine({ start: { x, y: by }, end: { x: x + p.w, y: by }, thickness: 0.8, color: RULE });
      at(pg, p.total.label.toUpperCase(), x + 10, by - 14, 8, bold, INK);
      atR(pg, p.total.value, x + p.w - 10, by - 14, 9.5, bold, p.total.color ?? INK);
      by -= BOX_TOTAL_H;
    }
    p.noteLines.forEach((line, i) => at(pg, line, x + 10, by - 10 - i * 9, 7, font, MUTED));
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
    // e2632276 — the unpaid-leave and absence halves, each named and carrying its day count in the row's
    // `sub` slot. They come OUT of "Other deductions" (d.absence.residual), they are not printed beside it,
    // so the box still adds up to the total it prints. No stamp ⇒ residual === otherDeductions ⇒ identical.
    ...(d.absence.unpaidLeave
      ? [{ label: t.unpaidLeaveLine, sub: absenceDaysLabel(d.absence.unpaidLeave.days, t.dayUnit, t.daysUnit), amount: d.absence.unpaidLeave.amount }]
      : []),
    ...(d.absence.absent
      ? [{ label: t.absentLine, sub: absenceDaysLabel(d.absence.absent.days, t.dayUnit, t.daysUnit), amount: d.absence.absent.amount }]
      : []),
    ...(d.absence.showResidual ? [{ label: t.otherDeductions, amount: d.absence.residual }] : []),
  ];

  const employerRows: Row[] = [
    { label: t.epf, amount: d.epfEmployer },
    { label: t.socso, amount: d.socsoEmployer },
    { label: t.eis, amount: d.eisEmployer },
    ...(d.hrdf != null ? [{ label: t.hrdf, amount: d.hrdf }] : []),
  ];
  const payRows: Row[] = [
    ...(d.paymentMethod ? [{ label: t.paymentMethod, text: d.paymentMethod }] : []),
    ...(d.bankName ? [{ label: t.bankName, text: d.bankName }] : []),
    // f35f758a — the WHOLE account number, not the last four. See PayslipPdfData.bankAccount.
    ...(d.bankAccount ? [{ label: t.bankAccount, text: d.bankAccount }] : []),
  ];
  const nonPayableRows: Row[] = (d.nonPayableLines ?? []).map((l) => ({
    label: l.name,
    sub: l.code,
    amount: l.amount,
  }));
  const nonPayableTotal = round2((d.nonPayableLines ?? []).reduce((s, l) => s + l.amount, 0));

  // ─── the page flow ───
  //
  // f35f758a replaced a one-shot "cap the earnings box at N rows and put the remainder on page 2" with a
  // MEASURED flow: every block knows its height before it is drawn, a block that does not clear the
  // footer starts a new sheet, and the earnings box may itself continue across sheets with its heading
  // repeated. That is what lets Earnings take the full width (so descriptions have room) while a typical
  // payslip still finishes on one page.
  const pages: PDFPage[] = [];
  let page = doc.addPage([A4_W, A4_H]);
  pages.push(page);
  let y = A4_H - M;

  /** Start a continuation sheet, headed so a loose second page still says which payslip it belongs to. */
  const newPage = () => {
    page = doc.addPage([A4_W, A4_H]);
    pages.push(page);
    y = A4_H - M;
    const nameLines = wrap(d.company, bold, 12, CONTENT_W - 200);
    nameLines.forEach((line, i) => at(page, line, M, y - 12 - i * 13, 12, bold));
    atR(page, `${t.title} · ${t.periodLabel}`, A4_W - M, y - 11, 9, font, MUTED);
    y -= 20 + (nameLines.length - 1) * 13;
    page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 1.2, color: RULE });
    y -= GAP;
  };
  /** Room for a block `h` tall on this sheet? If not, open the next one. */
  const ensure = (h: number) => {
    if (y - h < M + FOOTER_H) newPage();
  };

  /**
   * Draw a box that MIGHT NOT FIT, continuing it onto as many sheets as it needs.
   *
   * The heading is repeated at the top of every continuation (as `continuedTitle`), and the total row and
   * the note ride the LAST chunk so a reader never meets a total before the rows it totals. The old
   * behaviour — an inline "Earnings (continued) +16" row pointing at a second box — is gone: it printed
   * a row that was not a pay item on a document made of pay items.
   */
  type FlowSpec = {
    x: number; w: number; title: string; continuedTitle: string; rows: Row[];
    dot?: 'earn' | 'deduct'; total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
    note?: string;
  };

  /**
   * How much of `rows` fits in `avail`, and whether that chunk is the LAST one — i.e. the one that carries
   * the total and the note. Measurement only; nothing is drawn. Both `flowBox` and `flowPair` decide where
   * to break through this single function, so a one-column break and a two-column break cannot disagree.
   */
  const chunkFor = (plan: BoxPlan, rows: BoxRowPlan[], avail: number) => {
    const tailH = (plan.total ? BOX_TOTAL_H : 0) + noteHeightOf(plan.noteLines);
    let take = 0;
    let acc = 0;
    while (take < rows.length && BOX_HEAD_H + acc + rows[take].h <= avail) {
      acc += rows[take].h;
      take += 1;
    }
    if (take === rows.length && BOX_HEAD_H + acc + tailH <= avail) {
      return { take, final: true, h: BOX_HEAD_H + acc + tailH };
    }
    // Keep one row back so the total is never orphaned at the top of a sheet on its own.
    if (take === rows.length) take -= 1;
    return { take, final: false, h: BOX_HEAD_H + rows.slice(0, take).reduce((s, r) => s + r.h, 0) };
  };

  const flowBox = (o: FlowSpec) => {
    const planned = planBox({ w: o.w, title: o.title, rows: o.rows, dot: o.dot, total: o.total, note: o.note });
    let rows = planned.rows;
    let title = o.title;
    let freshPage = false;
    for (;;) {
      const c = chunkFor(planned, rows, y - (M + FOOTER_H));
      if (c.final) {
        y -= paintBox(page, o.x, y, { ...planned, title, rows }) + GAP;
        return;
      }
      let taken = c.take;
      if (taken === 0) {
        // Never emit an empty chunk, which on a sheet too short for one row would loop forever.
        if (!freshPage) {
          newPage();
          freshPage = true;
          continue;
        }
        taken = 1; // one row taller than a whole sheet: overflow it rather than spin
      }
      y -= paintBox(page, o.x, y, { ...planned, title, rows: rows.slice(0, taken), total: undefined, noteLines: [] }) + GAP;
      rows = rows.slice(taken);
      title = o.continuedTitle;
      newPage();
      freshPage = true;
    }
  };

  /**
   * TWO boxes side by side, EITHER of which may run onto further sheets.
   *
   * f35f758a rev 2 — the reporter wants Earnings and Deductions read against each other line for line, and
   * that is only possible with the two at the same y. `flowBox` assumes a block owns the whole flow, so it
   * cannot be called twice for a pair: the first call would advance `y` past the second's starting point,
   * and a break in either box would push the other one down a page. The existing short-block pair
   * (planBox + paintBox + `ensure`) cannot be reused either — it measures once and cannot continue at all,
   * and Earnings is exactly the box that continues.
   *
   * So: chunk BOTH sides against the same available height, paint both at the same y, advance by the
   * TALLER chunk, and carry on with whichever side still has rows. A side that finished simply stops being
   * painted, which is why a 70-item Earnings box continues down the left of sheet two with nothing beside
   * it rather than dragging a second copy of Deductions along.
   */
  const flowPair = (specs: readonly [FlowSpec, FlowSpec]) => {
    const sides = specs.map((spec) => ({
      spec,
      plan: planBox({ w: spec.w, title: spec.title, rows: spec.rows, dot: spec.dot, total: spec.total, note: spec.note }),
      rows: [] as BoxRowPlan[],
      title: spec.title,
      done: false,
    }));
    for (const s of sides) s.rows = s.plan.rows;
    let freshPage = false;
    for (;;) {
      const avail = y - (M + FOOTER_H);
      const chunks = sides.map((s) => (s.done ? null : chunkFor(s.plan, s.rows, avail)));
      // If EITHER side cannot take a single row, the sheet is spent — open the next one and re-measure
      // both, so the pair never starts split across a page boundary.
      if (chunks.some((c) => c != null && !c.final && c.take === 0) && !freshPage) {
        newPage();
        freshPage = true;
        continue;
      }
      let used = 0;
      chunks.forEach((c, i) => {
        if (!c) return;
        const s = sides[i];
        const take = !c.final && c.take === 0 ? 1 : c.take; // a row taller than a whole sheet: overflow, don't spin
        used = Math.max(
          used,
          paintBox(page, s.spec.x, y, {
            ...s.plan,
            title: s.title,
            rows: s.rows.slice(0, take),
            total: c.final ? s.plan.total : undefined,
            noteLines: c.final ? s.plan.noteLines : [],
          }),
        );
        s.rows = s.rows.slice(take);
        s.title = s.spec.continuedTitle;
        s.done = c.final;
      });
      y -= used + GAP;
      if (sides.every((s) => s.done)) return;
      newPage();
      freshPage = true;
    }
  };

  y = drawLetterhead(page, y);
  y = drawEmployeePanel(page, y);

  // ─── Earnings BESIDE Deductions ───
  //
  // f35f758a rev 2. r179 gave Earnings the full width so that a long pay item name had room to wrap instead
  // of being clipped — the defect the item was raised for. The reporter then read the result and made the
  // opposite point: what was earned and what was taken off are two halves of one sum, and stacked one above
  // the other they cannot be read against each other. Both are right, and both fit: the names still WRAP
  // (nothing clips at any width — see `wrap`), they simply take two lines in a half-width column, and the
  // pair now continues across sheets together rather than one of them shoving the other down a page.
  flowPair([
    {
      x: M, w: COL_W, title: t.earnings, continuedTitle: t.earningsContinued, rows: earnRows, dot: 'earn',
      total: { label: t.totalEarnings, value: money(d.gross), color: EARN },
      note: d.detailNotRecorded ? t.detailNotRecorded : undefined,
    },
    {
      x: COL2_X, w: COL_W, title: t.deductions, continuedTitle: t.deductions, rows: dedRows, dot: 'deduct',
      total: { label: t.totalDeductions, value: money(d.totalDeductions), color: DEDUCT },
    },
  ]);

  // ─── Employer contributions beside Payment information ───
  //
  // Both are SHORT and fixed (four statutory rows; three payment fields), so the simple measure-once pair
  // is still right for them — neither can grow to the length that made Earnings need a continuing flow.
  // Pairing them is also what buys the space for NET PAY to take the full width below.
  const empPlan = planBox({
    w: COL_W, title: t.employerContributions, rows: employerRows,
    total: { label: t.totalEmployerCost, value: money(d.employerCost) },
    note: t.employerContributionsNote,
  });
  // Payment information is printed only when there is something to print. A row of empty labels tells the
  // employee nothing and reads as a broken document; a missing block reads as "not recorded" — the truth.
  const payPlan = payRows.length > 0
    ? planBox({ w: COL_W, title: t.paymentInformation, rows: payRows })
    : null;
  const pairH = Math.max(boxHeight(empPlan), payPlan ? boxHeight(payPlan) : 0);
  ensure(pairH);
  paintBox(page, M, y, empPlan);
  if (payPlan) paintBox(page, COL2_X, y, payPlan);
  y -= pairH + GAP;

  // ─── NET PAY, FULL WIDTH ───
  // The one figure the employee looks for first, and now the only thing on its line — which is both what
  // the reporter asked for and what pays for itself: half a row of white space either side of a number is
  // worth less than the ~19pt the pair above just saved.
  const netH = 46;
  ensure(netH);
  page.drawRectangle({ x: M, y: y - netH, width: CONTENT_W, height: netH, color: PRIMARY });
  at(page, t.netPay.toUpperCase(), M + 14, y - 28, 9.5, bold, WHITE);
  atR(page, money(d.net), A4_W - M - 14, y - 30, 15, bold, WHITE);
  y -= netH + GAP;

  // ─── Non-payable (f35f758a) ───
  //
  // Items this run CALCULATED BUT DID NOT PAY. It is drawn only when the run stamped at least one line
  // non-payable, which is true of no payslip that exists today — so on every existing document this block
  // simply is not there. Full width and flowed, not paired, because a company that starts declaring
  // benefits in kind can declare a lot of them and the list must be able to continue.
  if (nonPayableRows.length > 0) {
    flowBox({
      x: M, w: CONTENT_W, title: t.nonPayable, continuedTitle: t.nonPayable, rows: nonPayableRows,
      total: { label: t.nonPayableTotal, value: money(nonPayableTotal) },
      note: t.nonPayableNote,
    });
  }

  // ─── employer-borne disclosure (3c473773) ───
  if (d.employerBorne.length > 0) {
    const bornePlan = planBox({
      w: CONTENT_W, title: t.employerBorne,
      rows: d.employerBorne.map((l) => ({ label: l.label, amount: l.amount })),
      total: { label: t.employerBorneTotal, value: money(d.employerBorneTotal) },
      note: t.employerBorneNote,
    });
    ensure(boxHeight(bornePlan));
    y -= paintBox(page, M, y, bornePlan) + GAP;
  }

  // ─── year to date ───
  if (d.ytd) {
    ensure(YTD_H);
    y -= drawYtd(page, y) + GAP;
  }

  for (const pg of pages) drawFooter(pg);

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
    // The legal name WRAPS rather than clipping: a company whose registered name is long is not a company
    // whose payslip may say half of it. 150pt is reserved on the right for the month and payment date.
    const nameLines = wrap(d.company, bold, 16, A4_W - M - textX - 150);
    nameLines.forEach((line, i) => at(pg, line, textX, top - 16 - i * 18, 16, bold));
    const below = top - 16 - (nameLines.length - 1) * 18;
    const sub = [t.documentSubtitle, d.cycleLabel].filter(Boolean).join(' · ');
    at(pg, sub, textX, below - 13, 9, font, MUTED);
    if (d.companyReg) at(pg, d.companyReg, textX, below - 25, 8, font, MUTED);
    // "August 2026", not "2026-08" (f35f758a). Resolved by the caller; English on the document because the
    // embedded font is Latin-1 — see PayslipPdfLabels.periodLabel.
    atR(pg, t.periodLabel, A4_W - M, top - 16, 13, bold);
    if (d.payDate) atR(pg, t.paymentDate, A4_W - M, top - 29, 8.5, font, MUTED);
    const textH = (nameLines.length - 1) * 18 + (d.companyReg ? 46 : 34);
    const h = Math.max(logo ? 58 : 0, textH);
    pg.drawLine({ start: { x: M, y: top - h }, end: { x: A4_W - M, y: top - h }, thickness: 1.6, color: RULE });
    return top - h - GAP;
  }

  function drawEmployeePanel(pg: PDFPage, top: number): number {
    const leftW = 218;
    const rightX = M + leftW + GAP;
    const rightW = CONTENT_W - leftW - GAP;

    // The employee's own name was clipped by the same `fit()` the pay items were. It wraps now.
    const nameLines = wrap(d.employee, bold, 14, leftW);
    nameLines.forEach((line, i) => at(pg, line, M, top - 14 - i * 16, 14, bold));
    const nameH = 27 + (nameLines.length - 1) * 16;
    if (d.employeeCode) at(pg, `${t.employeeCode}: ${d.employeeCode}`, M, top - nameH, 9, font, MUTED);
    const headH = nameH + 7;

    const idCells: [string, string][] = [
      ...(d.identityNumber ? ([[d.identityIsPassport ? t.passport : t.ic, d.identityNumber]] as [string, string][]) : []),
      ...(d.taxNumber ? ([[t.taxNumber, d.taxNumber]] as [string, string][]) : []),
      ...(d.epfNumber ? ([[t.epfNumber, d.epfNumber]] as [string, string][]) : []),
      ...(d.socsoNumber ? ([[t.socsoNumber, d.socsoNumber]] as [string, string][]) : []),
    ];
    const leftH = headH + drawGrid(pg, idCells, M, top - headH, leftW, 2);

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
      // TWO columns, not three: a position title ("Senior Business Analyst") does not fit a third of this
      // panel and would print truncated on an official document.
      rightH = 25 + drawGrid(pg, infoCells, rightX, top - 25, rightW, 2);
    }

    const h = Math.max(leftH, rightH, 40);
    pg.drawLine({ start: { x: M, y: top - h - 8 }, end: { x: A4_W - M, y: top - h - 8 }, thickness: 0.8, color: RULE });
    return top - h - 8 - GAP;
  }

  /**
   * A label-over-value grid. Returns the height consumed, so the caller can align the panel beside it.
   *
   * Both halves WRAP (f35f758a). This grid is where "Construction Project Managem…" was printed: a job
   * title, a department name or a long field label got one 25pt row and whatever did not fit was cut.
   * Rows are now as tall as their tallest cell.
   */
  function drawGrid(pg: PDFPage, cells: [string, string][], x: number, top: number, w: number, cols: number): number {
    if (cells.length === 0) return 0;
    const cw = w / cols;
    const planned = cells.map(([k, v]) => ({
      k: wrap(k.toUpperCase(), font, 6.5, cw - 6),
      v: wrap(v, bold, 8.5, cw - 6),
    }));
    let used = 0;
    for (let r = 0; r * cols < planned.length; r += 1) {
      const rowCells = planned.slice(r * cols, r * cols + cols);
      const rowH = Math.max(25, ...rowCells.map((c) => c.k.length * 8 + c.v.length * 10.5 + 6.5));
      rowCells.forEach((c, i) => {
        const cx = x + i * cw;
        const cy = top - used;
        c.k.forEach((line, j) => at(pg, line, cx, cy - 7 - j * 8, 6.5, font, MUTED));
        c.v.forEach((line, j) => at(pg, line, cx, cy - c.k.length * 8 - 10.5 - j * 10.5, 8.5, bold));
      });
      used += rowH;
    }
    return used;
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

  /**
   * ONE line, and it is the one that says a machine produced this.
   *
   * f35f758a took the other two off: "Prorated on N days worked in this period." and "Calculated under
   * statutory rules version X." Both were internal working notes on a document the employee files. The
   * day count survives as a FIELD in the employment panel above, where it reads as information rather
   * than as a note about the calculation, and the ruleset stays on the HR-facing review screen, which is
   * where "why did my tax change when my pay did not?" gets answered.
   */
  function drawFooter(pg: PDFPage) {
    const fy = M + 8;
    pg.drawLine({ start: { x: M, y: fy + 14 }, end: { x: A4_W - M, y: fy + 14 }, thickness: 0.8, color: RULE });
    const w = font.widthOfTextAtSize(safe(t.generatedNote), 7.5);
    at(pg, t.generatedNote, M + (CONTENT_W - w) / 2, fy, 7.5, font, MUTED);
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
 *
 * 6b134681 extends the SAME rule, unchanged, to Overtime and Bonus. Those two were the earnings figures
 * that still printed as bare category words: a one-off keyed as "B0001 — ANGPOW" is additional
 * remuneration, so it lands in the bonus bucket, and the document said "Bonus RM500.00" — the pay item's
 * own code and description were stored on the payslip and printed nowhere. Each figure reconciles against
 * its OWN total, so bonus itemising while overtime does not (an attendance-derived OT figure has no
 * component line to explain it) is a normal outcome, not a special case.
 */
function earningsRowsOf(d: PayslipPdfData, t: PayslipPdfLabels): Row[] {
  const rows: Row[] = [{ label: t.basicSalary, amount: d.basic }];
  /** Named rows for a figure when they add up to it, otherwise the one grouped row, exactly as before. */
  const push = (lines: PayslipEarningLine[] | undefined, total: number, grouped: string) => {
    const named = lines ?? [];
    if (payItemLinesReconcile(named, total)) {
      for (const l of named) rows.push({ label: l.name, sub: l.code, amount: l.amount });
    } else {
      rows.push({ label: grouped, amount: total });
    }
  };
  push(d.earningLines, d.allowance, t.allowances);
  push(d.overtimeLines, d.overtime, t.overtime);
  push(d.bonusLines, d.bonus, t.bonus);
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
